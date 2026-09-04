import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  API_VERSION,
  LOCALLLM_NODE_ADMISSION_PROFILE,
  LOCALLLM_OPENAI_PROFILE,
} from "../src/config.js";
import { startCompatibilityServer, startEdgeServer } from "../src/edge-server.js";
import { generateCapabilityToken, RELAY_HEADER } from "../src/security.js";
import { TokenStore } from "../src/token-store.js";
import { startWorkerServer } from "../src/worker-server.js";

function createManifest({
  workerTarget,
  edgeUpstream,
  maxBodyBytes = 4096,
  maxConcurrent = 2,
  nodeAdmission = false,
  browserCookies = false,
}) {
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
        profile: browserCookies
          ? "generic-http"
          : nodeAdmission
          ? LOCALLLM_NODE_ADMISSION_PROFILE
          : LOCALLLM_OPENAI_PROFILE,
        domains: ["llm.example.test"],
        edge: { upstream: edgeUpstream },
        worker: {
          listen: "127.0.0.1:18788",
          target: workerTarget,
          healthPath: "/healthz",
        },
        public: {
          tokenSet: "personal",
          ...(browserCookies ? { forwardCookies: true } : {}),
          routes: [
            ...(browserCookies ? [
              { path: "/", methods: ["GET"] },
            ] : [
              { path: "/v1/models", methods: ["GET"] },
              { path: "/v1/chat/completions", methods: ["POST"] },
              { path: "/v1/responses", methods: ["POST"] },
              { path: "/v1/embeddings", methods: ["POST"] },
            ]),
            ...(nodeAdmission ? [
              { path: "/readyz", methods: ["GET"] },
              { path: "/api/node/capabilities", methods: ["GET"] },
            ] : []),
          ],
          maxBodyBytes,
          maxConcurrentRequests: maxConcurrent,
          idleTimeoutSeconds: 10,
        },
      }],
    },
  };
}

test("generic HTTP cookie forwarding is opt-in across both guards", async () => {
  const seen = [];
  const stack = await createStack((incoming, response) => {
    seen.push(incoming.headers);
    response.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "studio=authenticated; Path=/; HttpOnly; Secure",
    });
    response.end("browser-ok");
  }, { browserCookies: true });
  try {
    const allowed = await request(stack.edge.url, "/", {
      headers: externalHeaders(stack.externalToken, { cookie: "studio=request" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "browser-ok");
    assert.equal(allowed.headers["set-cookie"][0], "studio=authenticated; Path=/; HttpOnly; Secure");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cookie, "studio=request");
  } finally {
    await stack.close();
  }
});

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

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

test("node admission routes require the external capability and preserve credential separation", async () => {
  const seen = [];
  const stack = await createStack((incoming, response) => {
    seen.push({
      method: incoming.method,
      url: incoming.url,
      authorization: incoming.headers.authorization,
      relay: incoming.headers[RELAY_HEADER],
    });
    incoming.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end('{"ok":true}');
  }, { nodeAdmission: true });
  try {
    for (const route of ["/readyz", "/api/node/capabilities"]) {
      const allowed = await request(stack.edge.url, route, {
        headers: externalHeaders(stack.externalToken),
      });
      assert.equal(allowed.status, 200, route);

      const missing = await request(stack.edge.url, route, {
        headers: { host: "llm.example.test" },
      });
      assert.equal(missing.status, 401, route);

      const wrong = await request(stack.edge.url, route, {
        headers: externalHeaders(generateCapabilityToken("wrong")),
      });
      assert.equal(wrong.status, 401, route);

      const wrongMethod = await request(stack.edge.url, route, {
        method: "POST",
        headers: externalHeaders(stack.externalToken, { "content-length": "0" }),
        body: "",
      });
      assert.equal(wrongMethod.status, 404, route);
    }

    for (const deniedRoute of ["/healthz", "/livez", "/api/system/status"]) {
      const denied = await request(stack.edge.url, deniedRoute, {
        headers: externalHeaders(stack.externalToken),
      });
      assert.equal(denied.status, 404, deniedRoute);
    }

    assert.deepEqual(seen.map((entry) => [entry.method, entry.url]), [
      ["GET", "/readyz"],
      ["GET", "/api/node/capabilities"],
    ]);
    assert(seen.every((entry) => entry.authorization === `Bearer ${stack.upstreamToken}`));
    assert(seen.every((entry) => entry.relay === undefined));
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

test("worker close and abort are bounded, idempotent, and release the exact listener", async () => {
  let streamClosedResolve;
  const streamClosed = new Promise((resolve) => { streamClosedResolve = resolve; });
  let uploadStartedResolve;
  const uploadStarted = new Promise((resolve) => { uploadStartedResolve = resolve; });
  let uploadClosedResolve;
  const uploadClosed = new Promise((resolve) => { uploadClosedResolve = resolve; });
  const upstream = await startHttpServer((incoming, response) => {
    if (incoming.url === "/v1/chat/completions") {
      incoming.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      response.once("close", streamClosedResolve);
      return;
    }
    if (incoming.url === "/v1/embeddings") {
      uploadStartedResolve();
      incoming.once("close", uploadClosedResolve);
      incoming.resume();
      return;
    }
    incoming.resume();
    incoming.once("end", () => response.end("healthy"));
  });
  const unrelated = await startHttpServer((incoming, response) => {
    incoming.resume();
    response.end("unrelated-ok");
  });
  const relayToken = generateCapabilityToken("relay");
  const upstreamToken = generateCapabilityToken("upstream");
  const manifest = createManifest({
    workerTarget: upstream.url,
    edgeUpstream: "http://127.0.0.1:19999",
  });
  let first;
  let second;
  let third;
  let streamRequest;
  let uploadRequest;
  try {
    first = await startWorkerServer({
      manifest,
      relayToken,
      upstreamToken,
      listen: "127.0.0.1:0",
    });
    const workerPort = first.address.port;
    const streamTarget = new URL(first.url);
    await within(new Promise((resolve, reject) => {
      let started = false;
      streamRequest = http.request({
        hostname: streamTarget.hostname,
        port: streamTarget.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-length": "0",
          [RELAY_HEADER]: `Bearer ${relayToken}`,
        },
        agent: false,
      }, (incoming) => {
        incoming.on("error", (error) => {
          if (!started) reject(error);
        });
        incoming.once("data", (chunk) => {
          started = true;
          assert.match(chunk.toString("utf8"), /data: first/u);
          resolve();
        });
      });
      streamRequest.on("error", (error) => {
        if (!started) reject(error);
      });
      streamRequest.end();
    }), 1_000, "worker SSE did not start");

    const firstClose = first.close();
    assert.equal(first.close(), firstClose);
    await within(firstClose, 1_000, "worker close waited on active SSE");
    await within(streamClosed, 1_000, "worker close did not abort upstream SSE");

    const abortController = new AbortController();
    second = await startWorkerServer({
      manifest,
      relayToken,
      upstreamToken,
      listen: `127.0.0.1:${workerPort}`,
      signal: abortController.signal,
    });
    assert.equal(second.address.port, workerPort);

    const uploadTarget = new URL(second.url);
    let uploadClientClosedResolve;
    const uploadClientClosed = new Promise((resolve) => { uploadClientClosedResolve = resolve; });
    uploadRequest = http.request({
      hostname: uploadTarget.hostname,
      port: uploadTarget.port,
      path: "/v1/embeddings",
      method: "POST",
      headers: { [RELAY_HEADER]: `Bearer ${relayToken}` },
      agent: false,
    }, (incoming) => {
      incoming.resume();
      incoming.on("error", () => {});
    });
    uploadRequest.on("error", uploadClientClosedResolve);
    uploadRequest.on("close", uploadClientClosedResolve);
    uploadRequest.write("partial");
    await within(uploadStarted, 1_000, "incomplete upload did not reach the worker target");

    abortController.abort();
    const abortedClose = second.close();
    assert.equal(second.close(), abortedClose);
    await within(abortedClose, 1_000, "worker abort waited on incomplete upload");
    await within(uploadClosed, 1_000, "worker abort did not close upstream upload");
    await within(uploadClientClosed, 1_000, "worker abort did not close its client");

    third = await startWorkerServer({
      manifest,
      relayToken,
      upstreamToken,
      listen: `127.0.0.1:${workerPort}`,
    });
    assert.equal(third.address.port, workerPort);
    const recovered = await request(third.url, "/healthz", {
      headers: { [RELAY_HEADER]: `Bearer ${relayToken}` },
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body, "healthy");

    assert.equal(unrelated.server.listening, true);
    const unaffected = await request(unrelated.url, "/still-running");
    assert.equal(unaffected.status, 200);
    assert.equal(unaffected.body, "unrelated-ok");
  } finally {
    streamRequest?.destroy();
    uploadRequest?.destroy();
    await Promise.allSettled([
      third?.close(),
      second?.close(),
      first?.close(),
    ]);
    await upstream.close();
    await unrelated.close();
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

test("compatibility direct API is manifest-authoritative for service and listener", async () => {
  const configured = createManifest({
    workerTarget: "http://127.0.0.1:18008",
    edgeUpstream: "http://127.0.0.1:19001",
  });
  configured.spec.edge.compatibilityService = "localllm";

  for (const listen of ["127.0.0.1:0", "127.0.0.2:18789", undefined]) {
    await assert.rejects(
      startCompatibilityServer({
        manifest: configured,
        serviceId: "localllm",
        listen,
      }),
      /listen overrides are forbidden/u,
    );
  }

  const missingListener = structuredClone(configured);
  delete missingListener.spec.edge.compatibilityListen;
  delete missingListener.spec.edge.compatibilityService;
  await assert.rejects(
    startCompatibilityServer({ manifest: missingListener, serviceId: "localllm" }),
    /compatibilityListen is required/u,
  );

  const wrongService = structuredClone(configured);
  const second = structuredClone(wrongService.spec.services[0]);
  second.id = "other-service";
  second.domains = ["other.example.test"];
  second.edge.upstream = "http://127.0.0.1:19003";
  second.worker.listen = "127.0.0.1:19004";
  second.worker.target = "http://127.0.0.1:18009";
  second.public.tokenSet = "other-users";
  wrongService.spec.services.push(second);
  await assert.rejects(
    startCompatibilityServer({ manifest: wrongService, serviceId: "other-service" }),
    /must equal spec\.edge\.compatibilityService/u,
  );

  const privateService = structuredClone(configured);
  privateService.spec.services[0].exposure = "private";
  privateService.spec.services[0].domains = [];
  privateService.spec.edge.privateListeners = [{
    service: "localllm",
    listen: "127.0.0.1:18120",
  }];
  await assert.rejects(
    startCompatibilityServer({ manifest: privateService, serviceId: "localllm" }),
    /public service/u,
  );
});

test("loopback compatibility listener keeps transport health separate from admission auth", async () => {
  const paths = [];
  const stack = await createStack((incoming, response) => {
    paths.push(incoming.url);
    incoming.resume();
    if (incoming.url === "/healthz") response.end("healthy");
    else if (incoming.url === "/v1/models") response.end("model-list");
    else response.end("node-document");
  }, { nodeAdmission: true });
  const reservation = await startHttpServer((_incoming, response) => response.end());
  const compatibilityPort = reservation.server.address().port;
  await reservation.close();
  const compatibilityManifest = structuredClone(stack.manifest);
  compatibilityManifest.spec.edge.compatibilityListen = `127.0.0.1:${compatibilityPort}`;
  compatibilityManifest.spec.edge.compatibilityService = "localllm";
  const compatibility = await startCompatibilityServer({
    manifest: compatibilityManifest,
    serviceId: "localllm",
    tokenStore: stack.tokenStore,
    relayToken: stack.relayToken,
  });
  try {
    assert.equal(compatibility.address.port, compatibilityPort);
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
    for (const route of ["/readyz", "/api/node/capabilities"]) {
      assert.equal((await request(compatibility.url, route)).status, 401, route);
      const admission = await request(compatibility.url, route, {
        headers: { authorization: `Bearer ${stack.externalToken}` },
      });
      assert.equal(admission.status, 200, route);
      assert.equal(admission.body, "node-document", route);
    }
    const management = await request(compatibility.url, "/api");
    assert.equal(management.status, 404);
    assert.deepEqual(paths, [
      "/healthz",
      "/v1/models",
      "/readyz",
      "/api/node/capabilities",
    ]);
  } finally {
    await compatibility.close();
    await stack.close();
  }
});
