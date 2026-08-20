import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderCaddy, renderNftRedirectTransaction } from "../src/caddy.js";
import {
  API_VERSION,
  manifestDigest,
  normalizeManifest,
} from "../src/config.js";
import { planDoctorChecks } from "../src/doctor.js";
import { startPrivateServiceServer } from "../src/edge-server.js";
import { renderOpenSshConfig } from "../src/openssh.js";
import { generateCapabilityToken, RELAY_HEADER } from "../src/security.js";
import {
  renderCertbotDeployHook,
  renderCaddySystemd,
  renderEdgeSystemd,
  renderPortRedirectHelper,
  renderPortRedirectSystemd,
  renderSystemdBundle,
} from "../src/systemd.js";
import { TokenStore } from "../src/token-store.js";
import { startWorkerServer } from "../src/worker-server.js";

function service({
  id,
  exposure,
  domains,
  edgePort,
  workerPort,
  targetPort,
  routes,
  maxBodyBytes = 32,
  maxConcurrentRequests = 1,
} = {}) {
  return {
    id,
    ...(exposure === undefined ? {} : { exposure }),
    domains,
    edge: { upstream: `http://127.0.0.1:${edgePort}` },
    worker: {
      listen: `127.0.0.1:${workerPort}`,
      target: `http://127.0.0.1:${targetPort}`,
    },
    public: {
      tokenSet: "private-users",
      routes,
      maxBodyBytes,
      maxConcurrentRequests,
      idleTimeoutSeconds: 10,
    },
  };
}

function mixedManifest() {
  return {
    apiVersion: API_VERSION,
    kind: "EdgeProject",
    metadata: { name: "private-listeners" },
    spec: {
      edge: {
        gatewayListen: "127.0.0.1:18787",
        privateListeners: [
          { service: "renderer", listen: "127.0.0.1:18122" },
          { service: "calculator", listen: "127.0.0.1:18121" },
        ],
      },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
      },
      services: [
        service({
          id: "public-api",
          domains: ["api.example.test"],
          edgePort: 19001,
          workerPort: 19101,
          targetPort: 19201,
          routes: [{ path: "/api/status", methods: ["GET"] }],
        }),
        service({
          id: "calculator",
          exposure: "private",
          domains: [],
          edgePort: 19002,
          workerPort: 19102,
          targetPort: 19202,
          routes: [{ path: "/api/calculate", methods: ["POST"] }],
        }),
        service({
          id: "renderer",
          exposure: "private",
          domains: [],
          edgePort: 19003,
          workerPort: 19103,
          targetPort: 19203,
          routes: [{ path: "/api/render", methods: ["POST"] }],
        }),
      ],
    },
  };
}

async function startHttpServer(handler) {
  const serverInstance = http.createServer(handler);
  await new Promise((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(0, "127.0.0.1", resolve);
  });
  const { port } = serverInstance.address();
  return {
    server: serverInstance,
    url: `http://127.0.0.1:${port}`,
    async close() {
      if (!serverInstance.listening) return;
      serverInstance.closeAllConnections?.();
      await new Promise((resolve) => serverInstance.close(resolve));
    },
  };
}

async function reserveLoopbackPorts(count) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const serverInstance = http.createServer();
      await new Promise((resolve, reject) => {
        serverInstance.once("error", reject);
        serverInstance.listen(0, "127.0.0.1", resolve);
      });
      const { port } = serverInstance.address();
      let released = false;
      reservations.push({
        port,
        async release() {
          if (released) return;
          released = true;
          await new Promise((resolve) => serverInstance.close(resolve));
        },
      });
    }
    return reservations;
  } catch (error) {
    await Promise.all(reservations.map((reservation) => reservation.release()));
    throw error;
  }
}

function request(url, requestPath, {
  method = "GET",
  headers = {},
  body,
} = {}) {
  const target = new URL(url);
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
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function bearer(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
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

test("private-only systemd lifecycle starts all listeners without public components or overrides", () => {
  const executable = fileURLToPath(new URL("../bin/lazyedge.mjs", import.meta.url));
  const manifestPath = fileURLToPath(
    new URL("../examples/private-service/lazyedge.yaml", import.meta.url),
  );
  const result = spawnSync(process.execPath, [
    executable,
    "render",
    "systemd",
    "--config",
    manifestPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# --- lazyedge-edge\.service ---/u);
  assert.match(result.stdout, /# --- lazyedge-worker\.service ---/u);
  assert.match(result.stdout, /# --- lazyedge-tunnel\.service ---/u);
  assert.doesNotMatch(result.stdout, /lazyedge-caddy|port-redirect|certbot/u);
  const edgeStart = result.stdout.match(/^ExecStart=.*serve edge.*$/mu)?.[0];
  assert.equal(
    edgeStart,
    "ExecStart=/usr/local/bin/lazyedge serve edge --config /etc/lazyedge/lazyedge.yaml --bindings /etc/lazyedge/bindings.edge.yaml",
  );
});

test("private listener normalization is deterministic and excluded from public renderers", () => {
  const source = mixedManifest();
  const normalized = normalizeManifest(source);
  assert.equal(normalized.spec.services[0].exposure, "private");
  assert.equal(
    normalized.spec.services.find((entry) => entry.id === "public-api").exposure ?? "public",
    "public",
  );
  assert.deepEqual(normalized.spec.edge.privateListeners, [
    { service: "calculator", listen: "127.0.0.1:18121" },
    { service: "renderer", listen: "127.0.0.1:18122" },
  ]);

  const reordered = structuredClone(source);
  reordered.spec.edge.privateListeners.reverse();
  assert.equal(manifestDigest(source), manifestDigest(reordered));
  const moved = structuredClone(source);
  moved.spec.edge.privateListeners[0].listen = "127.0.0.1:18123";
  assert.notEqual(manifestDigest(source), manifestDigest(moved));

  const legacyPublic = structuredClone(source);
  legacyPublic.spec.services = legacyPublic.spec.services
    .filter((entry) => entry.id === "public-api");
  delete legacyPublic.spec.edge.privateListeners;
  const explicitPublic = structuredClone(legacyPublic);
  explicitPublic.spec.services[0].exposure = "public";
  assert.equal(manifestDigest(legacyPublic), manifestDigest(explicitPublic));
  const explicitEmptyListeners = structuredClone(legacyPublic);
  explicitEmptyListeners.spec.edge.privateListeners = [];
  assert.equal(manifestDigest(legacyPublic), manifestDigest(explicitEmptyListeners));
  assert.deepEqual(
    normalizeManifest(legacyPublic).spec.edge,
    normalizeManifest(explicitEmptyListeners).spec.edge,
  );

  const caddy = renderCaddy(source, { manualCertificates: true });
  assert.match(caddy, /api\.example\.test/u);
  assert.doesNotMatch(caddy, /18121|18122|calculator|renderer/u);
  assert.equal((caddy.match(/\/etc\/letsencrypt\/live\//gu) ?? []).length, 2);

  const certificateHook = renderCertbotDeployHook(source);
  assert.match(certificateHook, /\/etc\/letsencrypt\/live\/api\.example\.test/u);
  assert.doesNotMatch(certificateHook, /calculator|renderer|18121|18122/u);
  assert.doesNotThrow(() => renderPortRedirectSystemd(source));

  const ssh = renderOpenSshConfig(source);
  assert.equal((ssh.match(/^\s*RemoteForward /gmu) ?? []).length, 3);
  const doctor = planDoctorChecks(source, { role: "edge" });
  assert(doctor.some((entry) => entry.id === "edge-private-listener-calculator"));
  assert(doctor.some((entry) => entry.id === "edge-private-listener-renderer"));

  const systemd = renderEdgeSystemd(source);
  assert.equal((systemd.match(/^ExecStart=/gmu) ?? []).length, 1);
  assert.doesNotMatch(systemd, /--private-listener|--listen/u);

  const privateOnly = structuredClone(source);
  privateOnly.spec.services = privateOnly.spec.services
    .filter((entry) => entry.exposure === "private");
  assert.doesNotThrow(() => normalizeManifest(privateOnly));
  assert.doesNotThrow(() => renderEdgeSystemd(privateOnly));
  assert.deepEqual(Object.keys(renderSystemdBundle(privateOnly, { mode: "root" })), [
    "lazyedge-edge.service",
  ]);
  assert.deepEqual(
    Object.keys(renderSystemdBundle(privateOnly, { mode: "all" }).root),
    ["lazyedge-edge.service"],
  );
  for (const renderer of [
    renderCaddy,
    renderNftRedirectTransaction,
    renderCaddySystemd,
    renderCertbotDeployHook,
    renderPortRedirectHelper,
    renderPortRedirectSystemd,
  ]) {
    assert.throws(() => renderer(privateOnly), /requires at least one configured public site/u);
  }
});

test("private listener manifests reject exposure, selection, wildcard, and port ambiguity", async () => {
  const publicWithoutDomain = mixedManifest();
  publicWithoutDomain.spec.services[0].domains = [];
  assert.throws(() => normalizeManifest(publicWithoutDomain), /domains must contain/u);

  const privateWithDomain = mixedManifest();
  privateWithDomain.spec.services[1].domains = ["private.example.test"];
  assert.throws(() => normalizeManifest(privateWithDomain), /must be empty/u);

  const privateWithoutListener = mixedManifest();
  privateWithoutListener.spec.edge.privateListeners = privateWithoutListener.spec.edge.privateListeners
    .filter((entry) => entry.service !== "calculator");
  assert.throws(() => normalizeManifest(privateWithoutListener), /requires one/u);

  const unknownService = mixedManifest();
  unknownService.spec.edge.privateListeners[0].service = "unknown-service";
  assert.throws(() => normalizeManifest(unknownService), /unknown service/u);

  const publicPrivateListener = mixedManifest();
  publicPrivateListener.spec.edge.privateListeners.push({
    service: "public-api",
    listen: "127.0.0.1:18124",
  });
  assert.throws(
    () => normalizeManifest(publicPrivateListener),
    /must use exposure private/u,
  );
  assert.throws(
    () => manifestDigest(publicPrivateListener),
    /must use exposure private/u,
  );

  const duplicateService = mixedManifest();
  duplicateService.spec.edge.privateListeners[1].service = "renderer";
  assert.throws(() => normalizeManifest(duplicateService), /Duplicate private listener service/u);

  const duplicateListener = mixedManifest();
  duplicateListener.spec.edge.privateListeners[1].listen = "127.0.0.1:18122";
  assert.throws(() => normalizeManifest(duplicateListener), /Duplicate private listener/u);

  for (const listen of [
    "0.0.0.0:18121",
    "127.0.0.1:0",
    "127.0.0.1:80",
    "127.0.0.1:443",
    "127.0.0.1:1023",
    "127.0.0.1:08120",
    "127.0.0.1:*",
    "localhost:18121",
  ]) {
    const invalid = mixedManifest();
    invalid.spec.edge.privateListeners[1].listen = listen;
    assert.throws(
      () => normalizeManifest(invalid),
      /loopback|port|host:port|unprivileged/u,
      listen,
    );
  }
  const lowestUnprivileged = mixedManifest();
  lowestUnprivileged.spec.edge.privateListeners[1].listen = "127.0.0.1:1024";
  assert.doesNotThrow(() => normalizeManifest(lowestUnprivileged));

  const schema = JSON.parse(await readFile(
    new URL("../schemas/lazyedge.schema.json", import.meta.url),
    "utf8",
  ));
  const privateListenPattern = new RegExp(schema.$defs.privateListen.pattern, "u");
  assert.equal(privateListenPattern.test("127.0.0.1:1024"), true);
  assert.equal(privateListenPattern.test("127.0.0.1:65535"), true);
  for (const listen of [
    "127.0.0.1:80",
    "127.0.0.1:443",
    "127.0.0.1:1023",
    "127.0.0.1:08120",
    "127.0.0.1:65536",
  ]) {
    assert.equal(privateListenPattern.test(listen), false, listen);
  }

  for (const listen of [
    "127.0.0.1:18787",
    "127.0.0.1:10080",
    "127.0.0.1:10443",
    "127.0.0.1:19002",
  ]) {
    const collision = mixedManifest();
    collision.spec.edge.privateListeners[1].listen = listen;
    assert.throws(() => normalizeManifest(collision), /conflicts with/u, listen);
  }

  const compatibilityCollision = mixedManifest();
  compatibilityCollision.spec.edge.compatibilityListen = "127.0.0.1:18121";
  compatibilityCollision.spec.edge.compatibilityService = "public-api";
  assert.throws(() => normalizeManifest(compatibilityCollision), /conflicts with/u);

  const privateCompatibilityService = mixedManifest();
  privateCompatibilityService.spec.edge.compatibilityListen = "127.0.0.1:18123";
  privateCompatibilityService.spec.edge.compatibilityService = "calculator";
  assert.throws(
    () => normalizeManifest(privateCompatibilityService),
    /compatibilityService must name a public service/u,
  );

  const sshReverseCollision = mixedManifest();
  sshReverseCollision.spec.transport.sshPort = 18121;
  assert.throws(() => normalizeManifest(sshReverseCollision), /conflicts with/u);

  const existingReverseCollision = mixedManifest();
  existingReverseCollision.spec.edge.existingSites = [{
    host: "existing.example.test",
    upstream: "http://127.0.0.1:18121",
  }];
  assert.throws(() => normalizeManifest(existingReverseCollision), /conflicts with/u);
});

test("direct private-listener API rejects hostless-token crossing onto public ingress", async () => {
  const tokenStore = new TokenStore();
  const issued = await tokenStore.issue({
    tokenSet: "private-users",
    expiresInSeconds: 300,
    scope: {
      serviceIds: ["public-api"],
      methods: ["GET"],
      paths: ["/api/status"],
    },
  });
  assert.ok(await tokenStore.verify(issued.token, {
    tokenSet: "private-users",
    context: {
      serviceId: "public-api",
      host: "api.example.test",
      method: "GET",
      path: "/api/status",
    },
  }));

  const [reservation] = await reserveLoopbackPorts(1);
  const crossingManifest = mixedManifest();
  crossingManifest.spec.edge.privateListeners.push({
    service: "public-api",
    listen: `127.0.0.1:${reservation.port}`,
  });
  try {
    await assert.rejects(
      startPrivateServiceServer({
        manifest: crossingManifest,
        serviceId: "public-api",
        tokenStore,
        relayTokens: new Map([
          ["public-api", generateCapabilityToken("relay")],
        ]),
      }),
      /must use exposure private/u,
    );
  } finally {
    await reservation.release();
  }
});

async function createPrivateStack() {
  let releaseSlow;
  let slowStartedResolve;
  const slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
  let streamClosedResolve;
  const streamClosed = new Promise((resolve) => { streamClosedResolve = resolve; });
  let hangClosedResolve;
  const hangClosed = new Promise((resolve) => { hangClosedResolve = resolve; });
  let uploadStartedResolve;
  const uploadStarted = new Promise((resolve) => { uploadStartedResolve = resolve; });
  let uploadClosedResolve;
  const uploadClosed = new Promise((resolve) => { uploadClosedResolve = resolve; });
  const seen = [];
  const firstApp = await startHttpServer((incoming, response) => {
    const chunks = [];
    if (incoming.url === "/api/upload") {
      uploadStartedResolve();
      incoming.on("close", uploadClosedResolve);
    }
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      seen.push({
        service: "calculator",
        path: incoming.url,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (incoming.url === "/api/slow") {
        slowStartedResolve();
        releaseSlow = () => response.end("slow-finished");
        return;
      }
      if (incoming.url === "/api/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        response.on("close", streamClosedResolve);
        return;
      }
      if (incoming.url === "/api/hang") {
        response.on("close", hangClosedResolve);
        return;
      }
      response.writeHead(200, {
        "cache-control": "public, max-age=60",
        "set-cookie": "private=1",
        "x-application-header": "preserved",
      });
      response.end("calculator-ok");
    });
  });
  const secondApp = await startHttpServer((incoming, response) => {
    incoming.resume();
    incoming.on("end", () => {
      seen.push({ service: "renderer", path: incoming.url, headers: incoming.headers });
      response.end("renderer-ok");
    });
  });

  const relayTokens = new Map([
    ["calculator", generateCapabilityToken("relay")],
    ["renderer", generateCapabilityToken("relay")],
  ]);
  const upstreamTokens = new Map([
    ["calculator", generateCapabilityToken("upstream")],
    ["renderer", generateCapabilityToken("upstream")],
  ]);
  const draft = {
    apiVersion: API_VERSION,
    kind: "EdgeProject",
    metadata: { name: "private-runtime" },
    spec: {
      edge: {
        gatewayListen: "127.0.0.1:18787",
        privateListeners: [
          { service: "calculator", listen: "127.0.0.1:18121" },
          { service: "renderer", listen: "127.0.0.1:18122" },
        ],
      },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
      },
      services: [
        service({
          id: "calculator",
          exposure: "private",
          domains: [],
          edgePort: 19011,
          workerPort: 19111,
          targetPort: new URL(firstApp.url).port,
          routes: [
            { path: "/api/events", methods: ["POST"] },
            { path: "/api/hang", methods: ["POST"] },
            { path: "/api/run", methods: ["POST"] },
            { path: "/api/slow", methods: ["POST"] },
            { path: "/api/upload", methods: ["POST"] },
          ],
          maxBodyBytes: 16,
        }),
        service({
          id: "renderer",
          exposure: "private",
          domains: [],
          edgePort: 19012,
          workerPort: 19112,
          targetPort: new URL(secondApp.url).port,
          routes: [{ path: "/api/render", methods: ["GET"] }],
        }),
      ],
    },
  };
  let firstWorker = await startWorkerServer({
    manifest: draft,
    serviceId: "calculator",
    relayTokens,
    upstreamTokens,
    listen: "127.0.0.1:0",
  });
  const secondWorker = await startWorkerServer({
    manifest: draft,
    serviceId: "renderer",
    relayTokens,
    upstreamTokens,
    listen: "127.0.0.1:0",
  });
  const manifest = structuredClone(draft);
  manifest.spec.services.find((entry) => entry.id === "calculator").edge.upstream = firstWorker.url;
  manifest.spec.services.find((entry) => entry.id === "renderer").edge.upstream = secondWorker.url;

  const tokenStore = new TokenStore();
  const calculatorToken = await tokenStore.issue({
    tokenSet: "private-users",
    expiresInSeconds: 300,
    scope: {
      serviceIds: ["calculator"],
      methods: ["POST"],
      paths: ["/api/events", "/api/hang", "/api/run", "/api/slow", "/api/upload"],
    },
  });
  const rendererToken = await tokenStore.issue({
    tokenSet: "private-users",
    expiresInSeconds: 300,
    scope: {
      serviceIds: ["renderer"],
      methods: ["GET"],
      paths: ["/api/render"],
    },
  });
  const reservations = await reserveLoopbackPorts(2);
  manifest.spec.edge.privateListeners = [
    { service: "calculator", listen: `127.0.0.1:${reservations[0].port}` },
    { service: "renderer", listen: `127.0.0.1:${reservations[1].port}` },
  ];
  let calculator;
  let renderer;
  try {
    await reservations[0].release();
    calculator = await startPrivateServiceServer({
      manifest,
      serviceId: "calculator",
      tokenStore,
      relayTokens,
      timeoutMs: 500,
    });
    await reservations[1].release();
    renderer = await startPrivateServiceServer({
      manifest,
      serviceId: "renderer",
      tokenStore,
      relayTokens,
      timeoutMs: 500,
    });
  } catch (error) {
    await calculator?.close();
    throw error;
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.release()));
  }

  assert.equal(
    calculator.address.port,
    Number(manifest.spec.edge.privateListeners[0].listen.split(":").at(-1)),
  );
  assert.equal(
    renderer.address.port,
    Number(manifest.spec.edge.privateListeners[1].listen.split(":").at(-1)),
  );

  return {
    firstApp,
    secondApp,
    manifest,
    relayTokens,
    upstreamTokens,
    tokenStore,
    calculatorToken: calculatorToken.token,
    rendererToken: rendererToken.token,
    get calculator() { return calculator; },
    set calculator(value) { calculator = value; },
    renderer,
    secondWorker,
    get firstWorker() { return firstWorker; },
    set firstWorker(value) { firstWorker = value; },
    slowStarted,
    streamClosed,
    hangClosed,
    uploadStarted,
    uploadClosed,
    seen,
    releaseSlow: () => releaseSlow?.(),
    async close() {
      releaseSlow?.();
      await calculator.close();
      await renderer.close();
      await firstWorker.close();
      await secondWorker.close();
      await firstApp.close();
      await secondApp.close();
    },
  };
}

test("multiple private listeners enforce exact service, token, route, and relay boundaries", async () => {
  const stack = await createPrivateStack();
  try {
    const payload = "work";
    const allowed = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, {
        host: "renderer.invalid.test",
        "content-length": String(Buffer.byteLength(payload)),
        cookie: "external=1",
        "idempotency-key": "calculation-42",
        "x-aginti-browser-session": "browser-session-42",
        "x-aginti-principal-id": "principal-42",
        "x-forwarded-for": "203.0.113.7",
        "x-lazyedge-browser-session": "attacker-browser",
        "x-lazyedge-idempotency-key": "attacker-operation",
        "x-lazyedge-principal-id": "attacker-principal",
        [RELAY_HEADER]: `Bearer ${generateCapabilityToken("attacker")}`,
      }),
      body: payload,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "calculator-ok");
    assert.equal(allowed.headers["cache-control"], "public, max-age=60");
    assert.equal(allowed.headers["x-application-header"], "preserved");
    assert.equal(allowed.headers["set-cookie"], undefined);
    assert.equal(stack.seen.length, 1);
    assert.equal(
      stack.seen[0].headers.authorization,
      `Bearer ${stack.upstreamTokens.get("calculator")}`,
    );
    assert.equal(stack.seen[0].headers[RELAY_HEADER], undefined);
    assert.equal(stack.seen[0].headers.cookie, undefined);
    assert.equal(stack.seen[0].headers["idempotency-key"], "calculation-42");
    assert.equal(stack.seen[0].headers["x-aginti-browser-session"], "browser-session-42");
    assert.equal(stack.seen[0].headers["x-aginti-principal-id"], "principal-42");
    assert.equal(stack.seen[0].headers["x-forwarded-for"], undefined);
    assert.equal(stack.seen[0].headers["x-lazyedge-browser-session"], undefined);
    assert.equal(stack.seen[0].headers["x-lazyedge-idempotency-key"], undefined);
    assert.equal(stack.seen[0].headers["x-lazyedge-principal-id"], undefined);

    const insufficientTokens = [
      await stack.tokenStore.issue({
        tokenSet: "private-users",
        expiresInSeconds: 300,
      }),
      await stack.tokenStore.issue({
        tokenSet: "private-users",
        expiresInSeconds: 300,
        scope: { serviceIds: ["calculator"] },
      }),
      await stack.tokenStore.issue({
        tokenSet: "private-users",
        expiresInSeconds: 300,
        scope: {
          serviceIds: ["calculator", "renderer"],
          methods: ["POST"],
          paths: ["/api/run"],
        },
      }),
    ];
    for (const insufficient of insufficientTokens) {
      const denied = await request(stack.calculator.url, "/api/run", {
        method: "POST",
        headers: bearer(insufficient.token, { "content-length": "0" }),
        body: "",
      });
      assert.equal(denied.status, 401);
    }
    assert.equal(stack.seen.length, 1);

    const rendered = await request(stack.renderer.url, "/api/render", {
      headers: bearer(stack.rendererToken),
    });
    assert.equal(rendered.status, 200);
    assert.equal(rendered.body, "renderer-ok");
    // The existing worker guard supplies this fallback on every current data
    // path. The new private listener neither adds nor rewrites it.
    assert.equal(rendered.headers["cache-control"], "no-store");

    for (const [url, requestPath, options, status] of [
      [stack.calculator.url, "/api/run", { method: "POST" }, 401],
      [stack.calculator.url, "/api/run", {
        method: "POST", headers: bearer(stack.rendererToken),
      }, 401],
      [stack.renderer.url, "/api/render", { headers: bearer(stack.calculatorToken) }, 401],
      [stack.calculator.url, "/api/render", {
        method: "POST", headers: bearer(stack.calculatorToken),
      }, 404],
      [stack.calculator.url, "/api/run", { headers: bearer(stack.calculatorToken) }, 404],
      [stack.calculator.url, "/api/run?service=renderer", {
        method: "POST", headers: bearer(stack.calculatorToken),
      }, 404],
      [stack.calculator.url, "/api%2frun", {
        method: "POST", headers: bearer(stack.calculatorToken),
      }, 400],
      [stack.calculator.url, "/api/%2e%2e/run", {
        method: "POST", headers: bearer(stack.calculatorToken),
      }, 400],
    ]) {
      const denied = await request(url, requestPath, options);
      assert.equal(denied.status, status, requestPath);
    }
    assert.equal(stack.seen.length, 2);

    const oversized = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "32" }),
      body: "x".repeat(32),
    });
    assert.equal(oversized.status, 413);
    assert.equal(stack.seen.length, 2);

    await assert.rejects(
      startPrivateServiceServer({
        manifest: stack.manifest,
        serviceId: "missing",
        tokenStore: stack.tokenStore,
        relayTokens: stack.relayTokens,
      }),
      /configured private listener/u,
    );
    for (const listen of [
      "127.0.0.1:0",
      "127.0.0.2:18121",
      undefined,
    ]) {
      await assert.rejects(
        startPrivateServiceServer({
          manifest: stack.manifest,
          serviceId: "calculator",
          tokenStore: stack.tokenStore,
          relayTokens: stack.relayTokens,
          listen,
        }),
        /listen overrides are forbidden/u,
      );
    }
  } finally {
    await stack.close();
  }
});

test("private listeners bound outages and release concurrency and streams on detach", async () => {
  const stack = await createPrivateStack();
  try {
    const first = request(stack.calculator.url, "/api/slow", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    await stack.slowStarted;
    const busy = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(busy.status, 429);
    stack.releaseSlow();
    assert.equal((await first).status, 200);

    const streamTarget = new URL(stack.calculator.url);
    await new Promise((resolve, reject) => {
      const outgoing = http.request({
        hostname: streamTarget.hostname,
        port: streamTarget.port,
        path: "/api/events",
        method: "POST",
        headers: bearer(stack.calculatorToken, { "content-length": "0" }),
        agent: false,
      }, (incoming) => {
        assert.equal(incoming.statusCode, 200);
        assert.equal(incoming.headers["x-accel-buffering"], "no");
        incoming.once("data", () => {
          incoming.destroy();
          resolve();
        });
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    await within(
      stack.streamClosed,
      2_000,
      "private stream cancellation did not reach the application",
    );
    const afterDetach = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(afterDetach.status, 200);

    const timeoutStartedAt = Date.now();
    const timedOut = await request(stack.calculator.url, "/api/hang", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(timedOut.status, 503);
    assert.match(timedOut.body, /upstream_timeout/u);
    assert(Date.now() - timeoutStartedAt < 2_000);
    await within(stack.hangClosed, 2_000, "timed-out private request was not aborted");
    const afterTimeout = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(afterTimeout.status, 200);

    const oldPort = stack.firstWorker.address.port;
    await stack.firstWorker.close();
    const startedAt = Date.now();
    const unavailable = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(unavailable.status, 503);
    assert(Date.now() - startedAt < 2_000);
    assert.doesNotMatch(unavailable.body, /127\.0\.0\.1|ECONNREFUSED/u);

    stack.firstWorker = await startWorkerServer({
      manifest: stack.manifest,
      serviceId: "calculator",
      relayTokens: stack.relayTokens,
      upstreamTokens: stack.upstreamTokens,
      listen: `127.0.0.1:${oldPort}`,
    });
    const recovered = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(recovered.status, 200);
  } finally {
    await stack.close();
  }
});

test("private listener close is bounded and aborts active SSE and request bodies", async () => {
  const stack = await createPrivateStack();
  try {
    const streamTarget = new URL(stack.calculator.url);
    await new Promise((resolve, reject) => {
      const outgoing = http.request({
        hostname: streamTarget.hostname,
        port: streamTarget.port,
        path: "/api/events",
        method: "POST",
        headers: bearer(stack.calculatorToken, { "content-length": "0" }),
        agent: false,
      }, (incoming) => {
        assert.equal(incoming.statusCode, 200);
        incoming.on("error", () => {});
        incoming.once("data", resolve);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    await within(
      stack.calculator.close(),
      1_000,
      "private listener close waited on an active SSE response",
    );
    await within(
      stack.streamClosed,
      1_000,
      "private listener close did not abort its upstream SSE response",
    );

    stack.calculator = await startPrivateServiceServer({
      manifest: stack.manifest,
      serviceId: "calculator",
      tokenStore: stack.tokenStore,
      relayTokens: stack.relayTokens,
      timeoutMs: 500,
    });

    const uploadTarget = new URL(stack.calculator.url);
    let clientClosedResolve;
    const clientClosed = new Promise((resolve) => { clientClosedResolve = resolve; });
    const upload = http.request({
      hostname: uploadTarget.hostname,
      port: uploadTarget.port,
      path: "/api/upload",
      method: "POST",
      headers: bearer(stack.calculatorToken),
      agent: false,
    }, (incoming) => {
      incoming.resume();
      incoming.on("error", () => {});
    });
    upload.on("error", clientClosedResolve);
    upload.on("close", clientClosedResolve);
    upload.write("partial");
    await within(stack.uploadStarted, 1_000, "partial upload did not reach the application");

    await within(
      stack.calculator.close(),
      1_000,
      "private listener close waited on an incomplete request body",
    );
    await within(
      stack.uploadClosed,
      1_000,
      "private listener close did not abort its upstream request body",
    );
    await within(clientClosed, 1_000, "private listener did not close its external client");

    stack.calculator = await startPrivateServiceServer({
      manifest: stack.manifest,
      serviceId: "calculator",
      tokenStore: stack.tokenStore,
      relayTokens: stack.relayTokens,
      timeoutMs: 500,
    });
    const recovered = await request(stack.calculator.url, "/api/run", {
      method: "POST",
      headers: bearer(stack.calculatorToken, { "content-length": "0" }),
      body: "",
    });
    assert.equal(recovered.status, 200);
  } finally {
    await stack.close();
  }
});
