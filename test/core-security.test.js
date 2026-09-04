import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  API_VERSION,
  LOCALLLM_OPENAI_PROFILE,
  manifestDigest,
  normalizeManifest,
  parseManifest,
} from "../src/config.js";
import {
  generateCapabilityToken,
  normalizeLoopbackListener,
  normalizeLoopbackUrl,
  normalizeRoutePath,
  parseRequestTarget,
} from "../src/security.js";
import { TokenStore } from "../src/token-store.js";

function manifest(overrides = {}) {
  return {
    apiVersion: API_VERSION,
    kind: "EdgeProject",
    metadata: { name: "test-edge" },
    spec: {
      edge: { gatewayListen: "127.0.0.1:18787" },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
      },
      services: [{
        id: "localllm",
        profile: LOCALLLM_OPENAI_PROFILE,
        domains: ["llm.example.test"],
        edge: { upstream: "http://127.0.0.1:19001" },
        worker: {
          listen: "127.0.0.1:19002",
          target: "http://127.0.0.1:18008",
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
          maxBodyBytes: 4096,
          maxConcurrentRequests: 2,
        },
        ...overrides,
      }],
    },
  };
}

test("manifest normalization is strict, canonical, and deterministic", () => {
  const first = normalizeManifest(manifest());
  const reordered = manifest();
  reordered.spec.services[0].domains = ["LLM.EXAMPLE.TEST"];
  reordered.spec.services[0].public.routes.reverse();
  assert.equal(manifestDigest(first), manifestDigest(reordered));
  assert.equal(first.spec.edge.httpPort, 10_080);
  assert.equal(first.spec.edge.httpsPort, 10_443);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.spec.services));

  const yaml = `
apiVersion: lazyedge.lazying.art/v1alpha1
kind: EdgeProject
metadata: {name: test-edge}
spec:
  edge: {gatewayListen: "127.0.0.1:18787"}
  transport:
    provider: openssh-reverse
    sshHost: edge.example.test
    sshUser: lazyedge-tunnel
  services:
    - id: general-api
      domains: [api.example.test]
      edge: {upstream: "http://127.0.0.1:19001"}
      worker:
        listen: "127.0.0.1:19002"
        target: "http://127.0.0.1:18008"
      public:
        tokenSet: personal
        routes: [{path: /api/whisper, methods: [POST]}]
`;
  assert.equal(parseManifest(yaml).spec.services[0].public.routes[0].path, "/api/whisper");
});

test("existing reverse-proxy sites remain strict loopback records", () => {
  const value = manifest();
  value.spec.edge.existingSites = [{
    host: "chat.example.test",
    upstream: "https://127.0.0.1:8443",
    tlsServerName: "chat.example.test",
  }];
  value.spec.transport.hostKeyAlias = "lazyedge-primary";
  value.spec.services[0].public.idleTimeoutSeconds = 900;
  value.spec.services[0].profile = "generic-http";
  value.spec.services[0].public.routes = [{ path: "/api/whisper", methods: ["POST"] }];
  const normalized = normalizeManifest(value);
  assert.deepEqual(normalized.spec.edge.existingSites, [{
    host: "chat.example.test",
    upstream: "https://127.0.0.1:8443",
    tlsServerName: "chat.example.test",
  }]);
  assert.equal(normalized.spec.transport.hostKeyAlias, "lazyedge-primary");
  assert.equal(normalized.spec.services[0].public.idleTimeoutSeconds, 900);

  const remote = manifest();
  remote.spec.edge.existingSites = [{
    host: "chat.example.test",
    upstream: "https://10.0.0.5:8443",
  }];
  assert.throws(() => normalizeManifest(remote));
});

test("compatibility listener selects one unambiguous service", () => {
  const single = manifest();
  single.spec.edge.compatibilityListen = "127.0.0.1:18789";
  assert.equal(normalizeManifest(single).spec.edge.compatibilityService, "localllm");

  const multiple = manifest();
  multiple.spec.edge.compatibilityListen = "127.0.0.1:18789";
  const second = structuredClone(multiple.spec.services[0]);
  second.id = "second-service";
  second.domains = ["second.example.test"];
  second.edge.upstream = "http://127.0.0.1:19003";
  second.worker.listen = "127.0.0.1:19004";
  second.worker.target = "http://127.0.0.1:18009";
  second.public.tokenSet = "second-users";
  multiple.spec.services.push(second);
  assert.throws(
    () => normalizeManifest(multiple),
    /compatibilityService is required/u,
  );
  multiple.spec.edge.compatibilityService = "second-service";
  assert.equal(
    normalizeManifest(multiple).spec.edge.compatibilityService,
    "second-service",
  );
});

test("manifest rejects ambiguous, wildcard, duplicate, and non-loopback claims", () => {
  const cases = [];
  const unknown = manifest();
  unknown.spec.services[0].public.surprise = true;
  cases.push(unknown);
  const wildcard = manifest();
  wildcard.spec.services[0].domains = ["*.example.test"];
  cases.push(wildcard);
  const target = manifest();
  target.spec.services[0].worker.target = "http://192.168.1.3:8008";
  cases.push(target);
  const listener = manifest();
  listener.spec.services[0].worker.listen = "0.0.0.0:9000";
  cases.push(listener);
  const alternateLoopback = manifest();
  alternateLoopback.spec.services[0].edge.upstream = "http://127.0.0.2:19001";
  cases.push(alternateLoopback);
  const ipv6Listener = manifest();
  ipv6Listener.spec.edge.gatewayListen = "[::1]:18787";
  cases.push(ipv6Listener);
  const traversal = manifest();
  traversal.spec.services[0].public.routes[0].path = "/v1/%2e%2e/models";
  cases.push(traversal);
  const encodedSlash = manifest();
  encodedSlash.spec.services[0].public.routes[0].path = "/v1%2fmodels";
  cases.push(encodedSlash);
  const routeWildcard = manifest();
  routeWildcard.spec.services[0].public.routes[0].path = "/v1/**";
  cases.push(routeWildcard);
  const profileEscape = manifest();
  profileEscape.spec.services[0].public.routes[0] = { path: "/api/admin", methods: ["GET"] };
  cases.push(profileEscape);
  const duplicate = manifest();
  duplicate.spec.services[0].public.routes.push({ path: "/v1/models", methods: ["GET"] });
  cases.push(duplicate);
  const gatewayLoop = manifest();
  gatewayLoop.spec.services[0].edge.upstream = "http://127.0.0.1:18787";
  cases.push(gatewayLoop);
  const compatibilityLoop = manifest();
  compatibilityLoop.spec.edge.compatibilityListen = "127.0.0.1:19001";
  cases.push(compatibilityLoop);
  const workerLoop = manifest();
  workerLoop.spec.services[0].worker.target = "http://127.0.0.1:19002";
  cases.push(workerLoop);
  const caddyGatewayCollision = manifest();
  caddyGatewayCollision.spec.edge.httpPort = 18_787;
  cases.push(caddyGatewayCollision);
  const caddyReverseCollision = manifest();
  caddyReverseCollision.spec.edge.httpsPort = 19_001;
  cases.push(caddyReverseCollision);

  for (const value of cases) assert.throws(() => normalizeManifest(value));
  assert.throws(() => parseManifest("a: 1\na: 2\n"));
});

test("path and loopback primitives reject parser-confusion inputs", () => {
  for (const value of [
    "/v1/%2Fmodels",
    "/v1/%5cmodels",
    "/v1/../models",
    "/v1/%2e%2e/models",
    "//v1/models",
    "/v1//models",
  ]) {
    assert.throws(() => parseRequestTarget(value));
  }
  assert.equal(normalizeRoutePath("/"), "/");
  assert.throws(() => normalizeRoutePath("/", { requireV1: true }));
  assert.throws(() => normalizeRoutePath("/v1/*"));
  assert.throws(() => normalizeLoopbackUrl("http://localhost:8008"));
  assert.throws(() => normalizeLoopbackUrl("http://10.0.0.2:8008"));
  assert.throws(() => normalizeLoopbackListener("0.0.0.0:8008"));
  assert.equal(normalizeLoopbackUrl("http://127.0.0.2:8008"), "http://127.0.0.2:8008");
});

test("generic HTTP manifests may expose only the exact root route", () => {
  const generic = manifest();
  generic.spec.services[0].profile = "generic-http";
  generic.spec.services[0].public.routes = [{ path: "/", methods: ["GET"] }];
  assert.deepEqual(normalizeManifest(generic).spec.services[0].public.routes, [
    { path: "/", methods: ["GET"] },
  ]);

  const managed = manifest();
  managed.spec.services[0].public.routes = [{ path: "/", methods: ["GET"] }];
  assert.throws(
    () => normalizeManifest(managed),
    (error) => error?.code === "PROFILE_POLICY",
  );
});

test("cookie forwarding is explicit and restricted to generic HTTP", () => {
  const generic = manifest();
  generic.spec.services[0].profile = "generic-http";
  generic.spec.services[0].public.forwardCookies = true;
  generic.spec.services[0].public.routes = [{ path: "/", methods: ["GET"] }];
  assert.equal(normalizeManifest(generic).spec.services[0].public.forwardCookies, true);

  const managed = manifest();
  managed.spec.services[0].public.forwardCookies = true;
  assert.throws(
    () => normalizeManifest(managed),
    (error) => error?.code === "PROFILE_POLICY",
  );

  const invalid = manifest();
  invalid.spec.services[0].profile = "generic-http";
  invalid.spec.services[0].public.forwardCookies = "yes";
  assert.throws(
    () => normalizeManifest(invalid),
    (error) => error?.code === "INVALID_MANIFEST",
  );
});

test("token store persists only SHA-256 digests and enforces expiry, scope, and revoke", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-test-"));
  const filePath = path.join(directory, "tokens.json");
  let now = Date.parse("2026-08-18T00:00:00.000Z");
  const store = await TokenStore.open({ filePath, clock: () => now });
  const issued = await store.issue({
    tokenSet: "personal",
    expiresInSeconds: 60,
    scope: {
      serviceIds: ["localllm"],
      hosts: ["llm.example.test"],
      methods: ["POST"],
      paths: ["/v1/chat/completions"],
    },
  });
  assert.match(issued.token, /^le1_/u);
  const stored = await readFile(filePath, "utf8");
  assert.ok(!stored.includes(issued.token));
  assert.match(stored, /"digest": "[a-f0-9]{64}"/u);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const context = {
    serviceId: "localllm",
    host: "llm.example.test",
    method: "POST",
    path: "/v1/chat/completions",
  };
  assert.ok(await store.verify(issued.token, { tokenSet: "personal", context }));
  assert.equal(await store.verify(`${issued.token}x`, { tokenSet: "personal", context }), null);
  assert.equal(await store.verify(issued.token, {
    tokenSet: "personal",
    context: { ...context, path: "/v1/responses" },
  }), null);
  assert.ok(!("digest" in store.list()[0]));

  assert.equal(await store.revoke(issued.id), true);
  assert.equal(await store.verify(issued.token, { tokenSet: "personal", context }), null);
  const expiring = await store.issue({ tokenSet: "personal", expiresInSeconds: 1 });
  now += 2_000;
  assert.equal(await store.verify(expiring.token, { tokenSet: "personal" }), null);
});

test("token scope authorization is canonical, cloned, and recursively frozen", async () => {
  const store = new TokenStore();
  const serviceIds = ["calculator"];
  const methods = ["POST", "GET"];
  const paths = ["/api/run", "/api/events"];
  const scope = { serviceIds, methods, paths };
  const issued = await store.issue({
    tokenSet: "private-users",
    expiresInSeconds: 60,
    scope,
  });

  assert.deepEqual(issued.scope, {
    serviceIds: ["calculator"],
    methods: ["GET", "POST"],
    paths: ["/api/events", "/api/run"],
  });
  assert.equal(Object.isFrozen(issued.scope), true);
  for (const claim of Object.values(issued.scope)) assert.equal(Object.isFrozen(claim), true);

  serviceIds[0] = "renderer";
  methods.splice(0, methods.length, "DELETE");
  paths.splice(0, paths.length, "/api/admin");
  scope.serviceIds = ["renderer"];
  assert.throws(() => issued.scope.methods.push("DELETE"), TypeError);
  assert.throws(() => issued.scope.paths.splice(0, 1, "/api/admin"), TypeError);
  assert.throws(() => { issued.scope.serviceIds = ["renderer"]; }, TypeError);

  const context = {
    serviceId: "calculator",
    method: "POST",
    path: "/api/run",
  };
  const verified = await store.verify(issued.token, {
    tokenSet: "private-users",
    context,
  });
  assert.ok(verified);
  assert.equal(Object.isFrozen(verified.scope), true);
  for (const claim of Object.values(verified.scope)) assert.equal(Object.isFrozen(claim), true);
  assert.throws(() => { verified.scope.methods[0] = "DELETE"; }, TypeError);

  const listed = store.list()[0];
  assert.equal(Object.isFrozen(listed.scope), true);
  for (const claim of Object.values(listed.scope)) assert.equal(Object.isFrozen(claim), true);
  assert.throws(() => listed.scope.paths.push("/api/admin"), TypeError);

  assert.ok(await store.verify(issued.token, { tokenSet: "private-users", context }));
  for (const deniedContext of [
    { ...context, serviceId: "renderer" },
    { ...context, method: "DELETE" },
    { ...context, path: "/api/admin" },
  ]) {
    assert.equal(await store.verify(issued.token, {
      tokenSet: "private-users",
      context: deniedContext,
    }), null);
  }
});

test("generated relay capabilities contain at least 256 random bits", () => {
  const token = generateCapabilityToken("relay");
  assert.match(token, /^relay_[A-Za-z0-9_-]{43}$/u);
});

test("token store rejects symlinks and group/world-accessible state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-mode-test-"));
  const filePath = path.join(directory, "tokens.json");
  const store = await TokenStore.open({ filePath });
  await store.issue({ tokenSet: "personal", expiresInSeconds: 60 });
  await chmod(filePath, 0o644);
  await assert.rejects(() => TokenStore.open({ filePath }), /owner-only/u);
  await chmod(filePath, 0o600);
  const linkPath = path.join(directory, "tokens-link.json");
  await symlink(filePath, linkPath);
  await assert.rejects(() => TokenStore.open({ filePath: linkPath }), /symlink/u);
});
