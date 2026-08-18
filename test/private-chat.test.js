import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import vm from "node:vm";

import { CHAT_HTML, CHAT_JS } from "../src/chat-assets.js";
import { renderBootstrapScript } from "../src/accounts.js";
import {
  hashChatPassword,
  startChatServer,
  verifyChatPassword,
} from "../src/chat-server.js";
import { renderCaddy } from "../src/caddy.js";
import { normalizeManifest } from "../src/config.js";
import { renderChatSystemd } from "../src/systemd.js";

function baseManifest(compatibilityPort = 18080) {
  return {
    apiVersion: "lazyedge.lazying.art/v1alpha1",
    kind: "EdgeProject",
    metadata: { name: "private-chat-test" },
    spec: {
      edge: {
        gatewayListen: "127.0.0.1:17600",
        compatibilityListen: `127.0.0.1:${compatibilityPort}`,
        compatibilityService: "local-llm",
        httpPort: 10080,
        httpsPort: 10443,
      },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
        sshPort: 22,
      },
      services: [{
        id: "local-llm",
        profile: "localllm-openai",
        domains: ["llm.example.test"],
        edge: { upstream: "http://127.0.0.1:18008" },
        worker: {
          listen: "127.0.0.1:17800",
          target: "http://127.0.0.1:8008",
          healthPath: "/healthz",
        },
        public: {
          tokenSet: "local-llm-users",
          maxBodyBytes: 1024 * 1024,
          maxConcurrentRequests: 4,
          idleTimeoutSeconds: 60,
          routes: [
            { path: "/v1/models", methods: ["GET"] },
            { path: "/v1/chat/completions", methods: ["POST"] },
          ],
        },
        chat: { username: "operator" },
      }],
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

function request(base, requestPath, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path: requestPath,
      method,
      headers,
      agent: false,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(lines.join("\r\n")));
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve(received));
  });
}

function browserHeaders(extra = {}) {
  return {
    host: "llm.example.test",
    origin: "https://llm.example.test",
    "x-lazyedge-client-address": "198.51.100.10",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra,
  };
}

function cookieHeader(setCookie) {
  return setCookie.map((value) => value.split(";", 1)[0]).join("; ");
}

function cookieValue(cookie, name) {
  const part = cookie.split("; ").find((entry) => entry.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

async function createCompatibilityMock() {
  const seen = [];
  let resolveAborted;
  const aborted = new Promise((resolve) => { resolveAborted = resolve; });
  const server = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      seen.push({
        method: incoming.method,
        path: incoming.url,
        authorization: incoming.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (incoming.method === "GET" && incoming.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [
            { id: "localllm-deep" },
            { id: "localllm-fast" },
            { id: "localllm-code" },
            { id: "private-raw-model-name" },
          ],
        }));
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/v1/chat/completions") {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const lastContent = payload.messages.at(-1)?.content;
        if (lastContent === "upstream-unauthorized") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"error":"upstream credential rejected"}\n');
          return;
        }
        if (lastContent === "wrong-content-type") {
          response.writeHead(200, { "content-type": "text/plain" });
          let sequence = 0;
          const timer = setInterval(() => {
            response.write(`untrusted-${sequence}\n`);
            sequence += 1;
          }, 5);
          response.on("close", () => {
            clearInterval(timer);
            resolveAborted();
          });
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const isAbortProbe = lastContent === "abort-test";
        if (isAbortProbe) {
          let sequence = 0;
          const timer = setInterval(() => {
            response.write(`data: ${JSON.stringify({
              model: "private-raw-model-name",
              choices: [{ delta: { content: `chunk-${sequence}` } }],
            })}\n\n`);
            sequence += 1;
          }, 5);
          response.on("close", () => {
            clearInterval(timer);
            resolveAborted();
          });
          return;
        }
        response.write(
          "data: {\"model\":\"private-raw-model-name\",\"usage\":{\"hidden\":true},\"choices\":[{\"delta\":{",
        );
        const timer = setTimeout(() => {
          response.write("\"content\":\"hello\"}}]}\n\n");
          response.end("data: [DONE]\n\n");
        }, 5);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}\n");
    });
  });
  const port = await listen(server);
  return { server, port, seen, aborted };
}

test("private chat manifest is optional, strict, and uses stable model aliases", () => {
  const withoutChat = baseManifest();
  delete withoutChat.spec.services[0].chat;
  assert.equal(normalizeManifest(withoutChat).spec.services[0].chat, undefined);

  const normalized = normalizeManifest(baseManifest());
  assert.deepEqual(normalized.spec.services[0].chat, {
    listen: "127.0.0.1:17610",
    username: "operator",
    maxBodyBytes: 256 * 1024,
    models: {
      deep: "localllm-deep",
      fast: "localllm-fast",
      code: "localllm-code",
    },
    defaultModel: "deep",
  });

  const generic = baseManifest();
  generic.spec.services[0].profile = "generic-http";
  assert.throws(() => normalizeManifest(generic), /chat requires profile/u);

  const noCompatibility = baseManifest();
  delete noCompatibility.spec.edge.compatibilityListen;
  delete noCompatibility.spec.edge.compatibilityService;
  assert.throws(() => normalizeManifest(noCompatibility), /chat requires.*compatibilityListen/iu);

  const missingRoute = baseManifest();
  missingRoute.spec.services[0].public.routes.pop();
  assert.throws(() => normalizeManifest(missingRoute), /chat requires GET.*POST/u);

  const taggedModel = baseManifest();
  taggedModel.spec.services[0].chat.models = { deep: "model:latest" };
  assert.throws(() => normalizeManifest(taggedModel), /chat.models.deep.*invalid/u);

  const listenerConflict = baseManifest();
  listenerConflict.spec.services[0].chat.listen = "127.0.0.1:17600";
  assert.throws(() => normalizeManifest(listenerConflict), /chat.listen.*conflicts/u);

  const multipleDomains = baseManifest();
  multipleDomains.spec.services[0].domains.push("other.example.test");
  assert.throws(() => normalizeManifest(multipleDomains), /chat requires exactly one/u);
});

test("Caddy publishes only exact chat routes while preserving the bearer API", () => {
  const caddy = renderCaddy(baseManifest(), { manualCertificates: true });
  assert.match(caddy, /reverse_proxy http:\/\/127\.0\.0\.1:17610/u);
  assert.match(caddy, /method GET HEAD\n\s+path \/ \/assets\/app\.css \/assets\/app\.js/u);
  assert.match(caddy, /method GET\n\s+path \/chat\/api\/session \/chat\/api\/models/u);
  assert.match(caddy, /method POST\n\s+path \/chat\/api\/login \/chat\/api\/logout \/chat\/api\/completions/u);
  assert.match(caddy, /reverse_proxy http:\/\/127\.0\.0\.1:17610 \{[\s\S]*header_up -Authorization/u);
  assert.match(caddy, /header_up X-LazyEdge-Client-Address \{remote_host\}/u);
  assert.match(caddy, /reverse_proxy http:\/\/127\.0\.0\.1:17600 \{[\s\S]*header_up -Cookie/u);
  assert.doesNotMatch(caddy, /OpenAI-compatible API/u);
  assert.doesNotMatch(caddy, /127\.0\.0\.1:8008/u);
  assert.doesNotMatch(caddy, /(?:handle|path) \/api(?:\s|\*)/u);
});

test("static chat assets avoid inline execution, unsafe DOM sinks, and external CDNs", () => {
  assert.doesNotMatch(CHAT_HTML, /<script(?![^>]*\ssrc=)/iu);
  assert.doesNotMatch(CHAT_HTML, /<style|https?:\/\//iu);
  assert.doesNotMatch(CHAT_JS, /\.innerHTML\s*=|\beval\s*\(|new\s+Function\b/iu);
  assert.match(CHAT_JS, /textContent/u);
  assert.match(CHAT_JS, /localStorage/u);
  assert.doesNotThrow(() => new vm.Script(CHAT_JS));
  assert.match(CHAT_JS, /replace\(\/\\s\+\/g/u);
  assert.match(CHAT_JS, /replace\(\/\\r\\n\/g, "\\n"\)/u);
  assert.match(CHAT_JS, /indexOf\("\\n\\n"\)/u);
  assert.match(CHAT_JS, /if \(state\.controller\) state\.controller\.abort\(\)/u);
  assert.match(CHAT_JS, /var controller = new AbortController\(\)/u);
  assert.match(CHAT_JS, /if \(state\.controller !== controller\) return/u);
  assert.match(CHAT_JS, /if \(response\.ok \|\| response\.status === 401\)/u);
  assert.match(CHAT_JS, /Sign out failed\. Your session is still active\./u);
  assert.match(CHAT_JS, /response\.status === 401[\s\S]*username or password is incorrect/u);
  assert.match(CHAT_JS, /response\.status === 429[\s\S]*Too many attempts/u);
  assert.match(CHAT_JS, /private chat service is unavailable/u);
  assert.doesNotMatch(CHAT_JS, /await api\("\/chat\/api\/logout"[\s\S]{0,250}\} finally \{/u);
  assert.match(
    CHAT_HTML,
    /<form id="login-form" method="post" action="\/chat\/api\/login"/u,
  );
});

test("password records use hardened salted scrypt without retaining plaintext", async () => {
  const password = randomBytes(32).toString("base64url");
  const other = randomBytes(32).toString("base64url");
  const salt = Buffer.alloc(32, 7);
  const record = await hashChatPassword(password, { salt });
  assert.match(record, /^scrypt\$v=1\$n=131072,r=8,p=1\$[A-Za-z0-9_-]{43}\$[A-Za-z0-9_-]{43}$/u);
  assert.equal(record.includes(password), false);
  assert.equal(await verifyChatPassword(password, record), true);
  assert.equal(await verifyChatPassword(other, record), false);
  await assert.rejects(() => hashChatPassword(`valid-prefix\n${password}`), /printable/u);
});

test("private chat enforces login, session, CSRF, strict text payloads, aliases, and logout", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const clientToken = randomBytes(48).toString("base64url");
  const passwordHash = await hashChatPassword(password);
  const manifest = baseManifest(compatibility.port);
  manifest.spec.services[0].chat.maxBodyBytes = 1024;
  const chat = await startChatServer({
    manifest,
    serviceId: "local-llm",
    passwordHash,
    clientToken,
    listen: "127.0.0.1:0",
  });
  try {
    const root = await request(chat.url, "/", { headers: { host: "llm.example.test" } });
    assert.equal(root.status, 200);
    assert.match(root.headers["content-security-policy"], /script-src 'self'/u);
    assert.match(root.headers["strict-transport-security"], /max-age=31536000/u);
    assert.match(root.body, /Your quiet place to think/u);

    const unsafe = await request(chat.url, "/api/tags", {
      headers: { host: "llm.example.test" },
    });
    assert.equal(unsafe.status, 404);
    assert.equal((await request(chat.url, "/?debug=1", {
      headers: { host: "llm.example.test" },
    })).status, 404);
    assert.equal((await request(chat.url, "/assets/app.js", {
      method: "POST",
      headers: { host: "llm.example.test" },
    })).status, 404);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test" },
    })).status, 401);
    assert.equal((await request(chat.url, "/", {
      headers: { host: "wrong.example.test" },
    })).status, 404);
    const duplicateHost = await rawRequest(chat.address.port, [
      "GET / HTTP/1.1",
      "Host: llm.example.test",
      "Host: llm.example.test",
      "Connection: close",
      "",
      "",
    ]);
    assert.match(duplicateHost, /^HTTP\/1\.1 400 Bad Request/mu);

    const crossSite = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({
        origin: "https://attacker.example",
        "content-type": "application/json",
      }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(crossSite.status, 403);
    const wrongFetchMetadata = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(wrongFetchMetadata.status, 403);

    const concurrentLogins = await Promise.all([0, 1].map(() => request(
      chat.url,
      "/chat/api/login",
      {
        method: "POST",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ username: "operator", password }),
      },
    )));
    assert.deepEqual(concurrentLogins.map((entry) => entry.status).sort(), [200, 429]);
    const login = concurrentLogins.find((entry) => entry.status === 200);
    assert.equal(login.status, 200, login.body);
    assert(Array.isArray(login.headers["set-cookie"]));
    assert.match(login.headers["set-cookie"][0], /__Host-lechat=.*Secure; HttpOnly; SameSite=Strict/u);
    assert.match(login.headers["set-cookie"][1], /__Host-lechat-csrf=.*Secure; SameSite=Strict/u);
    assert.equal(login.body.includes(password), false);
    const loginBody = JSON.parse(login.body);
    const cookies = cookieHeader(login.headers["set-cookie"]);

    const session = await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: cookies },
    });
    assert.equal(session.status, 200);
    assert.equal(JSON.parse(session.body).username, "operator");
    const duplicatedCookies = await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: `${cookies}; ${cookies}` },
    });
    assert.equal(duplicatedCookies.status, 401);
    const forgedSessionCsrf = cookies.replace(
      /__Host-lechat-csrf=[^; ]+/u,
      `__Host-lechat-csrf=${randomBytes(24).toString("base64url")}`,
    );
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: forgedSessionCsrf },
    })).status, 401);

    const models = await request(chat.url, "/chat/api/models", {
      headers: { host: "llm.example.test", cookie: cookies },
    });
    assert.equal(models.status, 200);
    assert.deepEqual(JSON.parse(models.body).models, [
      { id: "deep", label: "Deep", default: true },
      { id: "fast", label: "Fast", default: false },
      { id: "code", label: "Code", default: false },
    ]);
    assert.equal(models.body.includes("localllm-code"), false);
    assert.equal(models.body.includes("private-raw-model-name"), false);

    const forgedCsrf = randomBytes(24).toString("base64url");
    const forgedCookies = cookies.replace(
      /__Host-lechat-csrf=[^; ]+/u,
      `__Host-lechat-csrf=${forgedCsrf}`,
    );
    const forged = await request(chat.url, "/chat/api/completions", {
      method: "POST",
      headers: browserHeaders({
        cookie: forgedCookies,
        "content-type": "application/json",
        "x-lazyedge-csrf": forgedCsrf,
      }),
      body: JSON.stringify({ model: "code", messages: [{ role: "user", content: "test" }] }),
    });
    assert.equal(forged.status, 403);

    const beforeInvalid = compatibility.seen.filter((entry) => (
      entry.path === "/v1/chat/completions"
    )).length;
    for (const invalid of [
      {
        model: "code",
        messages: [{ role: "user", content: "test" }],
        tools: [{ type: "function" }],
      },
      { model: "code", messages: [{ role: "user", content: [{ type: "image_url" }] }] },
      { model: "max", messages: [{ role: "user", content: "test" }] },
    ]) {
      const rejected = await request(chat.url, "/chat/api/completions", {
        method: "POST",
        headers: browserHeaders({
          cookie: cookies,
          "content-type": "application/json",
          "x-lazyedge-csrf": loginBody.csrfToken,
        }),
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(compatibility.seen.filter((entry) => (
      entry.path === "/v1/chat/completions"
    )).length, beforeInvalid);

    const encoded = await request(chat.url, "/chat/api/completions", {
      method: "POST",
      headers: browserHeaders({
        cookie: cookies,
        "content-encoding": "gzip",
        "content-type": "application/json",
        "x-lazyedge-csrf": loginBody.csrfToken,
      }),
      body: JSON.stringify({ model: "code", messages: [{ role: "user", content: "test" }] }),
    });
    assert.equal(encoded.status, 415);
    const oversized = await request(chat.url, "/chat/api/completions", {
      method: "POST",
      headers: browserHeaders({
        cookie: cookies,
        "content-type": "application/json",
        "x-lazyedge-csrf": loginBody.csrfToken,
      }),
      body: JSON.stringify({
        model: "code",
        messages: [{ role: "user", content: "x".repeat(1400) }],
      }),
    });
    assert.equal(oversized.status, 413);

    const completion = await request(chat.url, "/chat/api/completions", {
      method: "POST",
      headers: browserHeaders({
        cookie: cookies,
        "content-type": "application/json",
        "x-lazyedge-csrf": loginBody.csrfToken,
      }),
      body: JSON.stringify({
        model: "code",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    assert.equal(completion.status, 200, completion.body);
    assert.match(completion.headers["content-type"], /^text\/event-stream/u);
    assert.match(completion.body, /"content":"hello"/u);
    assert.doesNotMatch(completion.body, /private-raw-model-name|usage|hidden/u);
    const upstream = compatibility.seen.filter((entry) => (
      entry.path === "/v1/chat/completions"
    )).at(-1);
    assert.equal(upstream.authorization, `Bearer ${clientToken}`);
    assert.deepEqual(JSON.parse(upstream.body), {
      model: "localllm-code",
      messages: [{ role: "user", content: "test" }],
      stream: true,
    });

    await new Promise((resolve, reject) => {
      const target = new URL(chat.url);
      const body = JSON.stringify({
        model: "code",
        messages: [{ role: "user", content: "abort-test" }],
      });
      const outgoing = http.request({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/chat/api/completions",
        headers: browserHeaders({
          cookie: cookies,
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          "x-lazyedge-csrf": loginBody.csrfToken,
        }),
        agent: false,
      }, (incoming) => {
        incoming.once("data", () => {
          incoming.destroy();
          resolve();
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    await Promise.race([
      compatibility.aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stayed open")), 1000)),
    ]);

    const logout = await request(chat.url, "/chat/api/logout", {
      method: "POST",
      headers: browserHeaders({
        host: "llm.example.test",
        cookie: cookies,
        "x-lazyedge-csrf": loginBody.csrfToken,
      }),
    });
    assert.equal(logout.status, 200);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: cookies },
    })).status, 401);
  } finally {
    await chat.close();
    await close(compatibility.server);
  }
});

test("failed logins are indistinguishable, leak no token, and become rate limited", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const clientToken = randomBytes(48).toString("base64url");
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken,
    listen: "127.0.0.1:0",
  });
  try {
    const failures = [];
    failures.push(await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "wrong-user", password }),
    }));
    for (let index = 0; index < 7; index += 1) {
      failures.push(await request(chat.url, "/chat/api/login", {
        method: "POST",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          username: "operator",
          password: randomBytes(32).toString("base64url"),
        }),
      }));
    }
    assert(failures.every((entry) => entry.status === 401));
    assert.equal(new Set(failures.map((entry) => entry.body)).size, 1);
    assert(failures.every((entry) => !entry.body.includes(clientToken)));
    const limited = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "60");

    const ownerFromAnotherClient = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/json",
        "x-lazyedge-client-address": "198.51.100.11",
      }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(ownerFromAnotherClient.status, 200, ownerFromAnotherClient.body);

    const missingIngressIdentity = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: {
        host: "llm.example.test",
        origin: "https://llm.example.test",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(missingIngressIdentity.status, 403);
  } finally {
    await chat.close();
    await close(compatibility.server);
  }
});

test("an incomplete login body cannot hold the password-verification gate", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const clientToken = randomBytes(48).toString("base64url");
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken,
    listen: "127.0.0.1:0",
  });
  const target = new URL(chat.url);
  const stalled = [0, 1].map(() => {
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: "/chat/api/login",
      headers: browserHeaders({
        "content-type": "application/json",
        "x-lazyedge-client-address": "198.51.100.20",
      }),
      agent: false,
    });
    outgoing.on("error", () => {});
    return outgoing;
  });
  try {
    for (const outgoing of stalled) outgoing.write('{"username":"operator",');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sameClient = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/json",
        "x-lazyedge-client-address": "198.51.100.20",
      }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(sameClient.status, 429, sameClient.body);
    assert.equal(sameClient.headers.connection, "close");
    const owner = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/json",
        "x-lazyedge-client-address": "198.51.100.21",
      }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(owner.status, 200, owner.body);
  } finally {
    for (const outgoing of stalled) outgoing.destroy();
    await chat.close();
    await close(compatibility.server);
  }
});

test("bodyless browser routes close incomplete request bodies", async () => {
  const compatibility = await createCompatibilityMock();
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(randomBytes(32).toString("base64url")),
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
  });
  const socket = net.createConnection({ host: "127.0.0.1", port: chat.address.port });
  let received = "";
  socket.setEncoding("utf8");
  try {
    const closed = new Promise((resolve, reject) => {
      socket.on("data", (chunk) => { received += chunk; });
      socket.once("error", reject);
      socket.once("close", resolve);
    });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write([
      "GET / HTTP/1.1",
      "Host: llm.example.test",
      "Content-Length: 4096",
      "Connection: keep-alive",
      "",
      "{",
    ].join("\r\n"));
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("bodyless route stayed open")), 500)),
    ]);
    assert.match(received, /^HTTP\/1\.1 400 Bad Request/mu);
    assert.match(received, /^Connection: close$/imu);
  } finally {
    socket.destroy();
    await chat.close();
    await close(compatibility.server);
  }
});

test("pre-opened login uploads share the current per-client failure bucket", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
  });
  const uploads = [];
  try {
    const target = new URL(chat.url);
    const invalidBody = JSON.stringify({
      username: "operator",
      password: randomBytes(32).toString("base64url"),
    });
    const openUpload = () => {
      let resolveResponse;
      let rejectResponse;
      const response = new Promise((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      const outgoing = http.request({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/chat/api/login",
        headers: browserHeaders({
          "content-length": Buffer.byteLength(invalidBody),
          "content-type": "application/json",
          "x-lazyedge-client-address": "198.51.100.30",
        }),
        agent: false,
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolveResponse({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      outgoing.on("error", rejectResponse);
      outgoing.write(invalidBody.slice(0, -1));
      const upload = { outgoing, response };
      uploads.push(upload);
      return upload;
    };
    for (let wave = 0; wave < 4; wave += 1) {
      const current = [openUpload(), openUpload()];
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const upload of current) {
        upload.outgoing.end(invalidBody.slice(-1));
        const result = await upload.response;
        assert.equal(result.status, 401, result.body);
      }
    }
    const limited = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/json",
        "x-lazyedge-client-address": "198.51.100.30",
      }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(limited.status, 429, limited.body);
  } finally {
    for (const upload of uploads) upload.outgoing.destroy();
    await chat.close();
    await close(compatibility.server);
  }
});

test("logout revokes the session and aborts its active model stream", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
  });
  let streaming;
  try {
    const login = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(login.status, 200, login.body);
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const csrf = JSON.parse(login.body).csrfToken;
    const target = new URL(chat.url);
    let firstChunkResolve;
    let streamClosedResolve;
    const firstChunk = new Promise((resolve) => { firstChunkResolve = resolve; });
    const streamClosed = new Promise((resolve) => { streamClosedResolve = resolve; });
    const body = JSON.stringify({
      model: "fast",
      messages: [{ role: "user", content: "abort-test" }],
    });
    streaming = http.request({
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: "/chat/api/completions",
      headers: browserHeaders({
        cookie: cookies,
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
        "x-lazyedge-csrf": csrf,
      }),
      agent: false,
    }, (incoming) => {
      incoming.once("data", firstChunkResolve);
      incoming.once("aborted", streamClosedResolve);
      incoming.once("close", streamClosedResolve);
      incoming.once("error", streamClosedResolve);
    });
    streaming.once("error", streamClosedResolve);
    streaming.end(body);
    await Promise.race([
      firstChunk,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream did not start")), 1000)),
    ]);

    const logout = await request(chat.url, "/chat/api/logout", {
      method: "POST",
      headers: browserHeaders({ cookie: cookies, "x-lazyedge-csrf": csrf }),
    });
    assert.equal(logout.status, 200, logout.body);
    await Promise.race([
      Promise.all([compatibility.aborted, streamClosed]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("logout left stream open")), 1000)),
    ]);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: cookies },
    })).status, 401);
  } finally {
    streaming?.destroy();
    await chat.close();
    await close(compatibility.server);
  }
});

test("logout during an authenticated body upload cannot start a stale stream", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
  });
  let uploading;
  try {
    const login = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "operator", password }),
    });
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const csrf = JSON.parse(login.body).csrfToken;
    const body = JSON.stringify({
      model: "fast",
      messages: [{ role: "user", content: "stale-upload" }],
    });
    const target = new URL(chat.url);
    const completion = new Promise((resolve) => {
      uploading = http.request({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/chat/api/completions",
        headers: browserHeaders({
          cookie: cookies,
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          "x-lazyedge-csrf": csrf,
        }),
        agent: false,
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      uploading.on("error", (error) => resolve({ error }));
      uploading.write(body.slice(0, -1));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const logout = await request(chat.url, "/chat/api/logout", {
      method: "POST",
      headers: browserHeaders({ cookie: cookies, "x-lazyedge-csrf": csrf }),
    });
    assert.equal(logout.status, 200, logout.body);
    uploading.end(body.slice(-1));
    const rejected = await completion;
    if (rejected.error) assert.match(rejected.error.message, /socket hang up|reset|aborted/iu);
    else assert.equal(rejected.status, 401, rejected.body);
    assert.equal(compatibility.seen.filter((entry) => (
      entry.path === "/v1/chat/completions"
    )).length, 0);
  } finally {
    uploading?.destroy();
    await chat.close();
    await close(compatibility.server);
  }
});

test("continuous upstream events cannot outlive the absolute completion deadline", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const manifest = baseManifest(compatibility.port);
  manifest.spec.services[0].public.idleTimeoutSeconds = 1;
  const chat = await startChatServer({
    manifest,
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
  });
  let streaming;
  try {
    const login = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "operator", password }),
    });
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const csrf = JSON.parse(login.body).csrfToken;
    const body = JSON.stringify({
      model: "fast",
      messages: [{ role: "user", content: "abort-test" }],
    });
    const target = new URL(chat.url);
    const startedAt = Date.now();
    const closed = new Promise((resolve, reject) => {
      streaming = http.request({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/chat/api/completions",
        headers: browserHeaders({
          cookie: cookies,
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          "x-lazyedge-csrf": csrf,
        }),
        agent: false,
      }, (incoming) => {
        let chunks = 0;
        incoming.on("data", () => { chunks += 1; });
        const finish = () => resolve({ chunks, elapsed: Date.now() - startedAt });
        incoming.once("aborted", finish);
        incoming.once("close", finish);
        incoming.once("error", finish);
      });
      streaming.once("error", reject);
      streaming.end(body);
    });
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadline did not fire")), 1800)),
    ]);
    assert(result.chunks > 0);
    assert(result.elapsed >= 800 && result.elapsed < 1800, `elapsed=${result.elapsed}`);
    await compatibility.aborted;
  } finally {
    streaming?.destroy();
    await chat.close();
    await close(compatibility.server);
  }
});

test("a wrong-content-type upstream is terminated immediately", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash: await hashChatPassword(password),
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
  });
  try {
    const login = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "operator", password }),
    });
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const csrf = JSON.parse(login.body).csrfToken;
    const startedAt = Date.now();
    const rejected = await request(chat.url, "/chat/api/completions", {
      method: "POST",
      headers: browserHeaders({
        cookie: cookies,
        "content-type": "application/json",
        "x-lazyedge-csrf": csrf,
      }),
      body: JSON.stringify({
        model: "fast",
        messages: [{ role: "user", content: "wrong-content-type" }],
      }),
    });
    assert.equal(rejected.status, 502, rejected.body);
    await Promise.race([
      compatibility.aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stayed open")), 500)),
    ]);
    assert(Date.now() - startedAt < 500);

    const upstreamUnauthorized = await request(chat.url, "/chat/api/completions", {
      method: "POST",
      headers: browserHeaders({
        cookie: cookies,
        "content-type": "application/json",
        "x-lazyedge-csrf": csrf,
      }),
      body: JSON.stringify({
        model: "fast",
        messages: [{ role: "user", content: "upstream-unauthorized" }],
      }),
    });
    assert.equal(upstreamUnauthorized.status, 503, upstreamUnauthorized.body);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: cookies },
    })).status, 200);
  } finally {
    await chat.close();
    await close(compatibility.server);
  }
});

test("chat sessions expire after idle time and the fifth login evicts the oldest", async () => {
  const compatibility = await createCompatibilityMock();
  const password = randomBytes(32).toString("base64url");
  const passwordHash = await hashChatPassword(password);
  let now = Date.now();
  const chat = await startChatServer({
    manifest: baseManifest(compatibility.port),
    serviceId: "local-llm",
    passwordHash,
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
    clock: () => now,
  });
  const logins = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const response = await request(chat.url, "/chat/api/login", {
        method: "POST",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ username: "operator", password }),
      });
      assert.equal(response.status, 200, response.body);
      logins.push(cookieHeader(response.headers["set-cookie"]));
      now += 1;
    }
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: logins[0] },
    })).status, 401);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: logins[4] },
    })).status, 200);
    now += (60 * 60 * 1000) + 1;
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: logins[4] },
    })).status, 401);
  } finally {
    await chat.close();
    await close(compatibility.server);
  }
});

test("chat systemd unit isolates credentials and the dedicated account", () => {
  const unit = renderChatSystemd(baseManifest());
  assert.match(unit, /^User=lazyedge-chat$/mu);
  assert.match(unit, /^Group=lazyedge-chat$/mu);
  assert.match(unit, /LoadCredential=chat-password-hash:\/etc\/lazyedge-chat\/secrets\/local-llm-chat-password-hash/u);
  assert.match(unit, /LoadCredential=chat-client-token:\/etc\/lazyedge-chat\/secrets\/local-llm-chat-client-token/u);
  assert.match(unit, /serve chat --config \/etc\/lazyedge-chat\/lazyedge.yaml/u);
  assert.match(unit, /--password-hash-file %d\/chat-password-hash/u);
  assert.match(unit, /^IPAddressDeny=any$/mu);
  assert.match(unit, /^IPAddressAllow=localhost$/mu);
  assert.match(unit, /^MemoryMax=512M$/mu);
  assert.match(unit, /^TasksMax=64$/mu);
  assert.match(unit, /^ProtectProc=invisible$/mu);
  assert.match(unit, /^ProcSubset=pid$/mu);
  assert.match(unit, /^InaccessiblePaths=-\/etc\/lazyedge /mu);
  assert.doesNotMatch(unit, /Environment=.*(?:token|password)/iu);

  const bootstrap = renderBootstrapScript(baseManifest(), {
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmVLZXlOb3RTZWNyZXQ test",
  });
  assert.match(bootstrap, /ensure_system_user 'lazyedge-chat' '\/var\/lib\/lazyedge-chat'/u);
  assert.match(bootstrap, /install -d -o root -g 'lazyedge-chat' -m 0750 \/etc\/lazyedge-chat/u);
  assert.match(bootstrap, /install -d -o root -g root -m 0700 \/etc\/lazyedge-chat\/secrets/u);
});
