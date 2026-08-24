import assert from "node:assert/strict";
import test from "node:test";

import {
  API_VERSION,
  LOCALLLM_NODE_ADMISSION_PROFILE,
  LOCALLLM_OPENAI_PROFILE,
  normalizeManifest,
} from "../src/config.js";
import { planDoctorChecks, runDoctor } from "../src/doctor.js";
import {
  MAX_ADMISSION_DOCUMENT_BYTES,
  probeLocalLlmAdmission,
} from "../src/node-admission.js";

const RELEASE_ID = "01234567-89abcdef";
const SERVICE_VERSION = "0.1.21";
const ROLE_MODELS = Object.freeze({
  text: Object.freeze({ alias: "localllm-fast", id: "text-model:latest", digest: "a".repeat(64) }),
  code: Object.freeze({ alias: "localllm-code", id: "code-model:latest", digest: "b".repeat(64) }),
  vision: Object.freeze({ alias: "localllm-vision", id: "vision-model:latest", digest: "c".repeat(64) }),
  embedding: Object.freeze({ alias: "localllm-embed", id: "embed-model:latest", digest: "d".repeat(64) }),
});

function admissionManifest() {
  return {
    apiVersion: API_VERSION,
    kind: "EdgeProject",
    metadata: { name: "node-admission-test" },
    spec: {
      edge: { gatewayListen: "127.0.0.1:17600" },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
      },
      services: [{
        id: "localllm",
        profile: LOCALLLM_NODE_ADMISSION_PROFILE,
        domains: ["llm.example.test"],
        edge: { upstream: "http://127.0.0.1:18008" },
        worker: {
          listen: "127.0.0.1:17800",
          target: "http://127.0.0.1:8008",
          healthPath: "/healthz",
        },
        public: {
          tokenSet: "localllm-users",
          routes: [
            { path: "/v1/models", methods: ["GET"] },
            { path: "/v1/chat/completions", methods: ["POST"] },
            { path: "/v1/responses", methods: ["POST"] },
            { path: "/v1/embeddings", methods: ["POST"] },
            { path: "/readyz", methods: ["GET"] },
            { path: "/api/node/capabilities", methods: ["GET"] },
          ],
        },
      }],
    },
  };
}

function canonicalTimestamp(milliseconds = Date.now()) {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function admissionDocuments({ timestamp = canonicalTimestamp() } = {}) {
  const roles = Object.entries(ROLE_MODELS).map(([role, model]) => ({
    role,
    status: "passed",
    alias: model.alias,
    resolved_model: model.id,
    digest: model.digest,
    latency_ms: 25,
    timestamp,
  }));
  const requiredModels = Object.values(ROLE_MODELS).map((model) => ({
    id: model.alias,
    resolved_id: model.id,
    available: true,
  }));
  return {
    readyz: {
      schema_version: 1,
      ok: true,
      status: "ready",
      service: { name: "localllm-api", version: SERVICE_VERSION },
      checks: {
        process: { ok: true },
        ollama: { ok: true, code: "ready" },
        required_models: { ok: true, models: requiredModels, missing: [] },
      },
    },
    capabilities: {
      schema_version: 2,
      service: {
        name: "localllm-api",
        version: SERVICE_VERSION,
        release_id: RELEASE_ID,
        node_kind: "local-inference",
      },
      ready: true,
      runtime: { provider: "ollama", ready: true, error_code: null },
      required_models: requiredModels,
      functional_readiness: {
        required_for_catalog_readiness: false,
        ready: true,
        status: "passed",
        fresh: true,
        max_age_seconds: 60,
        timestamp,
        release_id: RELEASE_ID,
        age_seconds: 0,
        required_roles: Object.keys(ROLE_MODELS),
        roles,
      },
      protocols: [
        {
          id: "openai.models.list.v1",
          method: "GET",
          path: "/v1/models",
          authentication: "bearer",
          streaming: false,
        },
        {
          id: "openai.models.retrieve.v1",
          method: "GET",
          path: "/v1/models/{model}",
          authentication: "bearer",
          streaming: false,
        },
        {
          id: "openai.chat-completions.v1",
          method: "POST",
          path: "/v1/chat/completions",
          authentication: "bearer",
          streaming: true,
        },
        {
          id: "openai.responses.v1",
          method: "POST",
          path: "/v1/responses",
          authentication: "bearer",
          streaming: true,
        },
        {
          id: "openai.embeddings.v1",
          method: "POST",
          path: "/v1/embeddings",
          authentication: "bearer",
          streaming: false,
        },
      ],
      models: Object.values(ROLE_MODELS).map((model) => ({
        id: model.id,
        aliases: [model.alias],
        digest: model.digest,
      })),
    },
  };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function admissionFetch(documents, overrides = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (Object.hasOwn(overrides, path)) {
      const replacement = overrides[path];
      return typeof replacement === "function" ? replacement() : replacement;
    }
    if (path === "/healthz") return new Response("compatibility-only", { status: 200 });
    if (path === "/readyz") return jsonResponse(documents.readyz);
    if (path === "/api/node/capabilities") return jsonResponse(documents.capabilities);
    throw new Error(`unexpected probe path ${path}`);
  };
}

test("admission profile requires both exact GET claims and never treats healthz as admission", () => {
  assert.equal(
    normalizeManifest(admissionManifest()).spec.services[0].profile,
    LOCALLLM_NODE_ADMISSION_PROFILE,
  );

  const invalid = [];
  for (const missingPath of ["/readyz", "/api/node/capabilities"]) {
    const value = admissionManifest();
    value.spec.services[0].public.routes = value.spec.services[0].public.routes
      .filter((route) => route.path !== missingPath);
    invalid.push(value);
  }

  const wrongMethod = admissionManifest();
  wrongMethod.spec.services[0].public.routes
    .find((route) => route.path === "/readyz").methods = ["HEAD"];
  invalid.push(wrongMethod);

  const healthOverlap = admissionManifest();
  healthOverlap.spec.services[0].worker.healthPath = "/readyz";
  invalid.push(healthOverlap);

  const legacyProfile = admissionManifest();
  legacyProfile.spec.services[0].profile = LOCALLLM_OPENAI_PROFILE;
  invalid.push(legacyProfile);

  const legacyHealthClaim = admissionManifest();
  legacyHealthClaim.spec.services[0].public.routes
    .find((route) => route.path === "/readyz").path = "/healthz";
  invalid.push(legacyHealthClaim);

  for (const value of invalid) {
    assert.throws(() => normalizeManifest(value), { name: "SecurityError" });
  }
});

test("doctor reports transport health separately from release-bound application admission", async () => {
  const manifest = admissionManifest();
  const planned = planDoctorChecks(manifest, { role: "worker" });
  assert.deepEqual(
    planned.filter((item) => item.kind === "http").map((item) => [item.boundary, item.url]),
    [["transport", "http://127.0.0.1:8008/healthz"]],
  );
  assert.deepEqual(
    planned.filter((item) => item.kind === "localllm-admission").map((item) => [
      item.boundary,
      item.readyUrl,
      item.capabilitiesUrl,
    ]),
    [[
      "application-admission",
      "http://127.0.0.1:8008/readyz",
      "http://127.0.0.1:8008/api/node/capabilities",
    ]],
  );

  const documents = admissionDocuments();
  const result = await runDoctor(manifest, {
    role: "worker",
    tcpProbeImpl: async () => {},
    fetchImpl: admissionFetch(documents),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.boundaries, {
    transport: { checked: 2, ok: true },
    applicationAdmission: { checked: 1, ok: true },
    operations: { checked: 0, ok: null },
  });
});

test("application admission fails closed on stale, mismatched, failed, reusable, and legacy evidence", async (context) => {
  const cases = {
    stale() {
      const documents = admissionDocuments({ timestamp: canonicalTimestamp(Date.now() - 120_000) });
      documents.capabilities.functional_readiness.age_seconds = 0;
      return { documents };
    },
    release_mismatch() {
      const documents = admissionDocuments();
      documents.capabilities.functional_readiness.release_id = "fedcba98-76543210";
      return { documents };
    },
    failed_canary() {
      const documents = admissionDocuments();
      documents.capabilities.functional_readiness.roles[1].status = "failed";
      return { documents };
    },
    model_mismatch() {
      const documents = admissionDocuments();
      documents.capabilities.models[0].digest = "e".repeat(64);
      return { documents };
    },
    reusable_release_id() {
      const documents = admissionDocuments();
      documents.capabilities.service.release_id = "dev";
      documents.capabilities.functional_readiness.release_id = "dev";
      return { documents };
    },
    legacy_health_document() {
      const documents = admissionDocuments();
      return {
        documents,
        overrides: {
          "/readyz": () => jsonResponse({
            ok: true,
            service: "localllm-api",
            ollama: { ok: false },
          }),
        },
      };
    },
  };

  for (const [name, build] of Object.entries(cases)) {
    await context.test(name, async () => {
      const { documents, overrides } = build();
      const result = await runDoctor(admissionManifest(), {
        role: "worker",
        tcpProbeImpl: async () => {},
        fetchImpl: admissionFetch(documents, overrides),
      });
      assert.equal(result.ok, false);
      assert.equal(result.boundaries.transport.ok, true);
      assert.equal(result.boundaries.applicationAdmission.ok, false);
      const failure = result.checks.find((item) => item.boundary === "application-admission");
      assert.equal(failure?.status, "fail");
      assert.doesNotMatch(failure?.message ?? "", /[\r\n]/u);
    });
  }
});

test("required role temporal and latency evidence mirrors the producer bounds", async (context) => {
  const now = Date.parse("2026-08-25T00:30:00Z");
  const rejectDocuments = async (documents, pattern) => {
    await assert.rejects(() => probeLocalLlmAdmission({
      readyUrl: "http://127.0.0.1:8008/readyz",
      capabilitiesUrl: "http://127.0.0.1:8008/api/node/capabilities",
      fetchImpl: admissionFetch(documents),
      now,
    }), pattern);
  };

  await context.test("future role timestamp cannot hide behind an older role", async () => {
    const documents = admissionDocuments({ timestamp: "2026-08-25T00:30:05Z" });
    documents.capabilities.functional_readiness.roles[0].timestamp = "2026-08-25T00:29:59Z";
    documents.capabilities.functional_readiness.roles[1].timestamp = "2026-08-25T00:30:06Z";
    documents.capabilities.functional_readiness.age_seconds = 1;
    await rejectDocuments(documents, /role timestamp is from the future/u);
  });

  await context.test("role timestamp cannot follow its receipt timestamp", async () => {
    const documents = admissionDocuments({ timestamp: "2026-08-25T00:29:58Z" });
    documents.capabilities.functional_readiness.roles[1].timestamp = "2026-08-25T00:29:59Z";
    documents.capabilities.functional_readiness.age_seconds = 2;
    await rejectDocuments(documents, /role timestamp follows its receipt/u);
  });

  await context.test("role latency cannot exceed ten minutes", async () => {
    const documents = admissionDocuments({ timestamp: "2026-08-25T00:30:00Z" });
    documents.capabilities.functional_readiness.roles[1].latency_ms = 600_001;
    await rejectDocuments(documents, /code canary did not pass/u);
  });
});

test("admission document fetches require exact HTTP/JSON/no-store and bounded bodies", async (context) => {
  const cases = {
    non_200: () => jsonResponse(admissionDocuments().readyz, { status: 201 }),
    missing_no_store: () => new Response(JSON.stringify(admissionDocuments().readyz), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    non_json: () => new Response("ready", {
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    }),
    oversized: () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": String(MAX_ADMISSION_DOCUMENT_BYTES + 1),
      },
    }),
  };

  for (const [name, readyResponse] of Object.entries(cases)) {
    await context.test(name, async () => {
      const documents = admissionDocuments();
      await assert.rejects(() => probeLocalLlmAdmission({
        readyUrl: "http://127.0.0.1:8008/readyz",
        capabilitiesUrl: "http://127.0.0.1:8008/api/node/capabilities",
        fetchImpl: admissionFetch(documents, { "/readyz": readyResponse }),
      }));
    });
  }

  await context.test("decoded body is bounded without Content-Length", async () => {
    const documents = admissionDocuments();
    const oversizedBody = () => new Response(" ".repeat(MAX_ADMISSION_DOCUMENT_BYTES + 1), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
    assert.equal(oversizedBody().headers.get("content-length"), null);
    await assert.rejects(() => probeLocalLlmAdmission({
      readyUrl: "http://127.0.0.1:8008/readyz",
      capabilitiesUrl: "http://127.0.0.1:8008/api/node/capabilities",
      fetchImpl: admissionFetch(documents, { "/readyz": oversizedBody }),
    }), /too large/u);
  });
});
