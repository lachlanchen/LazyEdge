import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { API_VERSION, manifestDigest, normalizeManifest } from "../src/config.js";
import { compileHttpPolicy, compileWorkerPolicy } from "../src/http-policy.js";
import { startCompatibilityServer, startEdgeServer, startPrivateServiceServer } from "../src/edge-server.js";
import { startWorkerServer } from "../src/worker-server.js";
import { generateCapabilityToken, RELAY_HEADER } from "../src/security.js";
import { TokenStore } from "../src/token-store.js";

const IMAGE_LIMIT = 24 * 1024 * 1024;
const ORDINARY_LIMIT = 65536;

function manifest() {
  return {
    apiVersion: API_VERSION, kind: "EdgeProject", metadata: { name: "route-limits" },
    spec: {
      edge: { gatewayListen: "127.0.0.1:18701" },
      transport: { provider: "openssh-reverse", sshHost: "edge.example.test", sshUser: "test-tunnel" },
      services: [{ id: "bounded-api", domains: ["api.example.test"],
        edge: { upstream: "http://127.0.0.1:18702" },
        worker: { listen: "127.0.0.1:18702", target: "http://127.0.0.1:18703", healthPath: "/healthz" },
        public: { tokenSet: "bounded-clients", maxBodyBytes: ORDINARY_LIMIT,
          maxConcurrentRequests: 1, idleTimeoutSeconds: 10,
          routes: [
            { path: "/v1/start", methods: ["POST"], maxBodyBytes: IMAGE_LIMIT },
            { path: "/v1/status", methods: ["POST"] },
            { path: "/v1/start", methods: ["GET"], maxBodyBytes: 16 },
          ],
        },
      }],
    },
  };
}

test("route body bounds are explicit, exact, canonical and independently validated", () => {
  const value = manifest();
  const normalized = normalizeManifest(value);
  const service = normalized.spec.services[0];
  const publicPolicy = compileHttpPolicy(normalized);
  const workerPolicy = compileWorkerPolicy(service);
  for (const [method, path, expected] of [["POST", "/v1/start", IMAGE_LIMIT],
    ["GET", "/v1/start", 16], ["POST", "/v1/status", undefined]]) {
    assert.equal(publicPolicy.decide({ host: "api.example.test", method, path }).route.maxBodyBytes, expected);
    assert.equal(workerPolicy.decide({ method, path }).route.maxBodyBytes, expected);
  }
  assert.equal(workerPolicy.decide({ method: "GET", path: "/healthz" }).route, null);
  assert.equal(service.public.maxBodyBytes, ORDINARY_LIMIT);
  assert.equal(manifestDigest(normalized), manifestDigest(value));
  for (const invalid of [null, false, 0, -1, 1.5, "1024", 1073741825, Infinity, {}, []]) {
    const changed = manifest();
    changed.spec.services[0].public.routes[0].maxBodyBytes = invalid;
    assert.throws(() => normalizeManifest(changed));
  }
  const changed = manifest();
  changed.spec.services[0].public.routes[0].maxBodyBytes = 1;
  assert.notEqual(manifestDigest(value), manifestDigest(changed));
  delete changed.spec.services[0].public.routes[0].maxBodyBytes;
  const ordinary = normalizeManifest(changed);
  assert.equal(Object.hasOwn(ordinary.spec.services[0].public.routes[1], "maxBodyBytes"), false);
});

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  return { server: instance, port: instance.address().port,
    url: `http://127.0.0.1:${instance.address().port}`,
    close: async () => {
      instance.closeAllConnections();
      await new Promise(resolve => instance.close(resolve));
    },
  };
}

function request(url, pathname, { headers, method = "POST", bytes = 0, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(pathname, url), {
      method, agent: false, headers: { ...headers, ...(chunked ? {} : { "content-length": String(bytes) }) },
    }, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("fixture request deadline")));
    // One reusable chunk exercises proxy backpressure instead of making a full body copy.
    const chunk = Buffer.alloc(16384, 120);
    let remaining = bytes;
    function write() {
      while (remaining > 0 && !outgoing.destroyed) {
        const count = Math.min(remaining, chunk.length);
        remaining -= count;
        if (!outgoing.write(chunk.subarray(0, count))) {
          outgoing.once("drain", write);
          return;
        }
      }
      if (!outgoing.destroyed) outgoing.end();
    }
    write();
  });
}

async function fixture(t, kind, { onRequest, timeoutMs } = {}) {
  const seen = [];
  const upstream = await server((incoming, response) => {
    let bytes = 0;
    incoming.on("data", chunk => { bytes += chunk.length; });
    incoming.on("end", () => {
      seen.push({ path: incoming.url, bytes, headers: incoming.headers });
      if (onRequest?.(incoming, response, bytes)) return;
      response.end(String(bytes));
    });
  });
  t.after(() => upstream.close());
  const config = manifest();
  const service = config.spec.services[0];
  service.worker.target = upstream.url;
  const relayToken = generateCapabilityToken("relay");
  const upstreamToken = generateCapabilityToken("upstream");
  const worker = await startWorkerServer({ manifest: config, relayToken, upstreamToken,
    listen: "127.0.0.1:0", timeoutMs });
  t.after(() => worker.close());
  service.edge.upstream = worker.url;
  const tokenStore = new TokenStore();
  const issued = await tokenStore.issue({ tokenSet: service.public.tokenSet, expiresInSeconds: 300,
    scope: { serviceIds: [service.id], methods: ["GET", "POST"], paths: ["/v1/start", "/v1/status"] },
  });
  const options = { manifest: config, serviceId: service.id, relayToken, tokenStore, timeoutMs };
  let edge;
  if (kind === "public") edge = await startEdgeServer({ ...options, listen: "127.0.0.1:0" });
  else {
    const reservation = await server((_req, res) => res.end());
    const port = reservation.port;
    await reservation.close();
    if (kind === "private") {
      service.exposure = "private";
      service.domains = [];
      config.spec.edge.privateListeners = [{ service: service.id, listen: `127.0.0.1:${port}` }];
      edge = await startPrivateServiceServer(options);
    } else {
      config.spec.edge.compatibilityService = service.id;
      config.spec.edge.compatibilityListen = `127.0.0.1:${port}`;
      edge = await startCompatibilityServer(options);
    }
  }
  t.after(() => edge.close());
  return { seen, upstreamToken, worker, edge,
    external: { host: "api.example.test", authorization: `Bearer ${issued.token}` },
    relay: { [RELAY_HEADER]: `Bearer ${relayToken}` },
  };
}

for (const kind of ["public", "private", "compatibility"]) {
  test(`${kind} and worker guards apply the selected route limit without widening other claims`, async t => {
    const stack = await fixture(t, kind);
    for (const [url, headers] of [[stack.edge.url, stack.external], [stack.worker.url, stack.relay]]) {
      const exact = await request(url, "/v1/start", { headers, bytes: IMAGE_LIMIT });
      assert.deepEqual(exact, { status: 200, body: String(IMAGE_LIMIT) });
      for (const [pathname, method, bytes] of [["/v1/start", "POST", IMAGE_LIMIT + 1],
        ["/v1/status", "POST", ORDINARY_LIMIT + 1], ["/v1/start", "GET", 17]]) {
        const count = stack.seen.length;
        assert.equal((await request(url, pathname, { headers, method, bytes })).status, 413);
        assert.equal(stack.seen.length, count, "declared oversized body never reaches the upstream");
      }
      assert.equal((await request(url, "/v1/status", { headers, bytes: ORDINARY_LIMIT })).status, 200);
      assert.equal((await request(url, "/v1/status", { headers, bytes: ORDINARY_LIMIT + 1, chunked: true })).status, 413);
      assert.equal((await request(url, "/v1/start", { headers, bytes: 100000, chunked: true })).status, 200);
      assert.equal((await request(url, "/v1/start-extra", { headers, bytes: 16 })).status, 404);
      assert.equal((await request(url, "/v1/%73tart", { headers, bytes: 16 })).status, 404);
      assert.equal((await request(url, "/v1%2Fstart", { headers, bytes: 16 })).status, 400);
    }
    for (const item of stack.seen) {
      assert.equal(item.headers.authorization, `Bearer ${stack.upstreamToken}`);
      assert.equal(item.headers[RELAY_HEADER], undefined);
    }
  });

  test(`${kind} route overrides retain the service concurrency limit and release slots`, async t => {
    let holdingResponse;
    let observe;
    const observed = new Promise(resolve => { observe = resolve; });
    const stack = await fixture(t, kind, { onRequest: (incoming, response) => {
      if (incoming.url !== "/v1/start") return false;
      holdingResponse = response;
      observe();
      return true;
    } });
    const pending = request(stack.edge.url, "/v1/start", { headers: stack.external, bytes: 100000 });
    await observed;
    try {
      assert.equal((await request(stack.edge.url, "/v1/status", { headers: stack.external })).status, 429);
      assert.equal((await request(stack.worker.url, "/v1/status", { headers: stack.relay })).status, 429);
    } finally { holdingResponse.end("completed"); }
    assert.equal((await pending).status, 200);
    assert.equal((await request(stack.edge.url, "/v1/status", { headers: stack.external })).status, 200);
  });

  test(`${kind} route overrides retain bounded upstream idle failure and recovery`, async t => {
    const stack = await fixture(t, kind, { timeoutMs: 80,
      onRequest: incoming => incoming.url === "/v1/start" });
    const started = Date.now();
    const timedOut = await request(stack.edge.url, "/v1/start", { headers: stack.external, bytes: 100000 });
    assert.ok([502, 503].includes(timedOut.status));
    assert.ok(Date.now() - started < 2000);
    assert.equal((await request(stack.edge.url, "/v1/status", { headers: stack.external })).status, 200);
  });
}
