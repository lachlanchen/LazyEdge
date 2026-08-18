import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { API_VERSION, LOCALLLM_OPENAI_PROFILE } from "../src/config.js";
import { startCompatibilityServer, startEdgeServer } from "../src/edge-server.js";
import { generateCapabilityToken, RELAY_HEADER } from "../src/security.js";
import { TokenStore } from "../src/token-store.js";
import { startWorkerServer } from "../src/worker-server.js";

function createManifest({ workerTarget, edgeUpstream, maxBodyBytes = 4096, maxConcurrent = 2 }) {
  return {
    apiVersion: API_VERSION,
    kind: "EdgeProject",
    metadata: { name: "gateway-test" },
    spec: {
      edge: {
        gatewayListen: "127.0.0.1:18787",
        compatibilityListen: "127.0.0.1:18789",
      },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
      },
      services: [{
        id: "localllm",
        profile: LOCALLLM_OPENAI_PROFILE,
        domains: ["llm.example.test"],
        edge: { upstream: edgeUpstream },
        worker: {
          listen: "127.0.0.1:18788",
          target: workerTarget,
          healthPath: "/healthz",
        },
        public: {
          tokenSet: "personal",
          routes: [
            { path: "/v1/models", methods: ["GET"] },
            { path: "/v1/chat/completions", methods: ["POST"] },
            { path: "/v1/responses", methods: ["POST"] },
            { path: "/v1/embeddings", methods: ["POST"] },
          ],
          maxBodyBytes,
          maxConcurrentRequests: maxConcurrent,
          idleTimeoutSeconds: 10,
        },
      }],
    },
  };
}

async function startHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function request(url, requestPath, {
  method = "GET",
  headers = {},
  body,
  onResponse,
} = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: requestPath,
      method,
      headers,
      agent: false,
    }, (incoming) => {
      onResponse?.(incoming, outgoing);
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

async function createStack(handler, limits = {}) {
  const upstream = await startHttpServer(handler);
  const relayToken = generateCapabilityToken("relay");
  const upstreamToken = generateCapabilityToken("upstream");
  const initial = createManifest({
    workerTarget: upstream.url,
    edgeUpstream: "http://127.0.0.1:19999",
    ...limits,
  });
  const worker = await startWorkerServer({
    manifest: initial,
    relayToken,
    upstreamToken,
    listen: "127.0.0.1:0",
  });
  const edgeManifest = createManifest({
    workerTarget: upstream.url,
    edgeUpstream: worker.url,
    ...limits,
  });
  const tokenStore = new TokenStore();
  const issued = await tokenStore.issue({ tokenSet: "personal", expiresInSeconds: 300 });
  const edge = await startEdgeServer({
    manifest: edgeManifest,
    tokenStore,
    relayToken,
    listen: "127.0.0.1:0",
  });
  return {
    upstream,
    worker,
    edge,
    relayToken,
    upstreamToken,
    externalToken: issued.token,
    tokenStore,
    manifest: edgeManifest,
    async close() {
      await edge.close();
      await worker.close();
      await upstream.close();
    },
  };
}

function externalHeaders(token, extra = {}) {
  return {
    host: "llm.example.test",
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

test("edge and worker enforce the LocalLLM allowlist and credential separation", async () => {
  const seen = [];
  const stack = await createStack((incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      seen.push({ headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "private=1" });
      response.end('{"ok":true}');
    });
  });
  try {
    const payload = '{"hello":"world"}';
    const allowed = await request(stack.edge.url, "/v1/chat/completions?stream=false", {
      method: "POST",
      headers: externalHeaders(stack.externalToken, {
        "content-length": Buffer.byteLength(payload),
        cookie: "external=1",
        connection: "x-sensitive",
        "x-sensitive": "strip-me",
        "x-forwarded-for": "203.0.113.4",
        "x-http-method-override": "DELETE",
        "x-original-url": "/api/admin",
        "x-rewrite-url": "/api/admin",
        [RELAY_HEADER]: `Bearer ${generateCapabilityToken("attacker")}`,
      }),
      body: payload,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, '{"ok":true}');
    assert.equal(allowed.headers["set-cookie"], undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.authorization, `Bearer ${stack.upstreamToken}`);
    assert.equal(seen[0].headers[RELAY_HEADER], undefined);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers["x-forwarded-for"], undefined);
    assert.equal(seen[0].headers["x-http-method-override"], undefined);
    assert.equal(seen[0].headers["x-original-url"], undefined);
    assert.equal(seen[0].headers["x-rewrite-url"], undefined);
    assert.equal(seen[0].headers["x-sensitive"], undefined);
    assert.equal(seen[0].body, payload);

    for (const deniedPath of ["/", "/api", "/references", "/ollama"]) {
      const denied = await request(stack.edge.url, deniedPath, {
        headers: externalHeaders(stack.externalToken),
      });
      assert.equal(denied.status, 404, deniedPath);
    }
    const missing = await request(stack.edge.url, "/v1/models", {
      headers: { host: "llm.example.test" },
    });
    assert.equal(missing.status, 401);
    const wrong = await request(stack.edge.url, "/v1/models", {
      headers: externalHeaders(generateCapabilityToken("wrong")),
    });
    assert.equal(wrong.status, 401);
    const wrongHost = await request(stack.edge.url, "/v1/models", {
      headers: { ...externalHeaders(stack.externalToken), host: "llm.example.test.evil.test" },
    });
    assert.equal(wrongHost.status, 404);
  } finally {
    await stack.close();
  }
});

test("host and path parser tricks fail closed before reaching private compute", async () => {
  let calls = 0;
  const stack = await createStack((_incoming, response) => {
    calls += 1;
    response.end("unexpected");
  });
  try {
    for (const unsafe of [
      "/v1%2fmodels",
      "/v1/%2e%2e/models",
      "/v1//models",
      "/v1/%5cmodels",
    ]) {
      const result = await request(stack.edge.url, unsafe, {
        headers: externalHeaders(stack.externalToken),
      });
      assert.equal(result.status, 400, unsafe);
    }
    assert.equal(calls, 0);
  } finally {
    await stack.close();
  }
});

test("body and concurrency limits are enforced at the edge", async () => {
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const stack = await createStack((incoming, response) => {
    incoming.resume();
    if (incoming.url.startsWith("/v1/responses")) {
      markStarted();
      releaseFirst = () => response.end("done");
      return;
    }
    incoming.on("end", () => response.end("ok"));
  }, { maxBodyBytes: 16, maxConcurrent: 1 });
  try {
    const tooLarge = await request(stack.edge.url, "/v1/embeddings", {
      method: "POST",
      headers: externalHeaders(stack.externalToken, { "content-length": "32" }),
      body: "x".repeat(32),
    });
    assert.equal(tooLarge.status, 413);

    const parsed = new URL(stack.edge.url);
    const chunkedTooLarge = await new Promise((resolve, reject) => {
      const outgoing = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/v1/embeddings",
        method: "POST",
        headers: externalHeaders(stack.externalToken),
        agent: false,
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      outgoing.on("error", reject);
      outgoing.write("x".repeat(10));
      outgoing.write("y".repeat(10));
      outgoing.end();
    });
    assert.equal(chunkedTooLarge.status, 413);

    const first = request(stack.edge.url, "/v1/responses", {
      method: "POST",
      headers: externalHeaders(stack.externalToken, { "content-length": "0" }),
      body: "",
    });
    await started;
    const second = await request(stack.edge.url, "/v1/models", {
      headers: externalHeaders(stack.externalToken),
    });
    assert.equal(second.status, 429);
    releaseFirst();
    assert.equal((await first).status, 200);
  } finally {
    await stack.close();
  }
});

test("an early upstream response closes an unfinished chunked client body", async () => {
  const stack = await createStack((_incoming, response) => {
    response.end("early");
  }, { maxConcurrent: 1 });
  try {
    const parsed = new URL(stack.edge.url);
    const closed = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: parsed.hostname, port: parsed.port });
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("unfinished request socket was not closed"));
      }, 2_000);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write([
          "POST /v1/responses HTTP/1.1",
          "Host: llm.example.test",
          `Authorization: Bearer ${stack.externalToken}`,
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          "1",
          "x",
          "",
        ].join("\r\n"));
      });
      socket.on("data", (chunk) => { received += chunk; });
      socket.on("error", (error) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(received);
      });
    });
    assert.match(closed, /^HTTP\/1\.1 200/mu);
    const next = await request(stack.edge.url, "/v1/models", {
      headers: externalHeaders(stack.externalToken),
    });
    assert.equal(next.status, 200);
  } finally {
    await stack.close();
  }
});

test("SSE is streamed immediately and client cancellation reaches local compute", async () => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  let secondSent = false;
  const stack = await createStack((incoming, response) => {
    incoming.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    const timer = setTimeout(() => {
      secondSent = true;
      response.write("data: second\n\n");
    }, 500);
    response.on("close", () => {
      clearTimeout(timer);
      upstreamClosedResolve();
    });
  });
  try {
    const parsed = new URL(stack.edge.url);
    await new Promise((resolve, reject) => {
      const outgoing = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: externalHeaders(stack.externalToken, { "content-length": "0" }),
        agent: false,
      }, (incoming) => {
        assert.equal(incoming.statusCode, 200);
        assert.equal(incoming.headers["x-accel-buffering"], "no");
        incoming.once("data", (chunk) => {
          assert.match(chunk.toString("utf8"), /data: first/u);
          assert.equal(secondSent, false);
          incoming.destroy();
          resolve();
        });
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation did not propagate")), 2_000)),
    ]);
  } finally {
    await stack.close();
  }
});

test("worker requires the relay capability and keeps health private", async () => {
  let observedAuthorization;
  const stack = await createStack((incoming, response) => {
    observedAuthorization = incoming.headers.authorization;
    incoming.resume();
    response.end("healthy");
  });
  try {
    const publicHealth = await request(stack.edge.url, "/healthz", {
      headers: externalHeaders(stack.externalToken),
    });
    assert.equal(publicHealth.status, 404);
    const directMissing = await request(stack.worker.url, "/healthz");
    assert.equal(directMissing.status, 401);
    const directHealth = await request(stack.worker.url, "/healthz", {
      headers: { [RELAY_HEADER]: `Bearer ${stack.relayToken}` },
    });
    assert.equal(directHealth.status, 200);
    assert.equal(directHealth.body, "healthy");
    assert.equal(observedAuthorization, `Bearer ${stack.upstreamToken}`);
  } finally {
    await stack.close();
  }
});

test("an unavailable reverse tunnel returns 503 without exposing details", async () => {
  const reservation = await startHttpServer((_request, response) => response.end());
  const unavailablePort = reservation.server.address().port;
  await reservation.close();
  const tokenStore = new TokenStore();
  const issued = await tokenStore.issue({ tokenSet: "personal", expiresInSeconds: 60 });
  const manifest = createManifest({
    workerTarget: "http://127.0.0.1:18008",
    edgeUpstream: `http://127.0.0.1:${unavailablePort}`,
  });
  const edge = await startEdgeServer({
    manifest,
    tokenStore,
    relayToken: generateCapabilityToken("relay"),
    listen: "127.0.0.1:0",
    timeoutMs: 1_000,
  });
  try {
    const result = await request(edge.url, "/v1/models", {
      headers: externalHeaders(issued.token),
    });
    assert.equal(result.status, 503);
    assert.match(result.body, /upstream_unavailable/u);
    assert.ok(!result.body.includes("127.0.0.1"));
  } finally {
    await edge.close();
  }
});

test("loopback compatibility listener ignores Host without weakening route auth", async () => {
  const paths = [];
  const stack = await createStack((incoming, response) => {
    paths.push(incoming.url);
    incoming.resume();
    response.end(incoming.url === "/healthz" ? "healthy" : "model-list");
  });
  const compatibility = await startCompatibilityServer({
    manifest: stack.manifest,
    serviceId: "localllm",
    tokenStore: stack.tokenStore,
    relayToken: stack.relayToken,
    listen: "127.0.0.1:0",
  });
  try {
    const health = await request(compatibility.url, "/healthz", {
      headers: { host: "localhost-only.invalid" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.body, "healthy");
    const missing = await request(compatibility.url, "/v1/models");
    assert.equal(missing.status, 401);
    const allowed = await request(compatibility.url, "/v1/models", {
      headers: { authorization: `Bearer ${stack.externalToken}` },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "model-list");
    const management = await request(compatibility.url, "/api");
    assert.equal(management.status, 404);
    assert.deepEqual(paths, ["/healthz", "/v1/models"]);
  } finally {
    await compatibility.close();
    await stack.close();
  }
});
