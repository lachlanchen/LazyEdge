const MAX_ADMISSION_DOCUMENT_BYTES = 256 * 1024;
const IMMUTABLE_RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{8}$/u;
const MODEL_DIGEST = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const ROLE_ALIASES = Object.freeze({
  text: "localllm-fast",
  code: "localllm-code",
  vision: "localllm-vision",
  embedding: "localllm-embed",
});
const REQUIRED_PROTOCOLS = Object.freeze([
  ["openai.models.list.v1", "GET", "/v1/models", false],
  ["openai.models.retrieve.v1", "GET", "/v1/models/{model}", false],
  ["openai.chat-completions.v1", "POST", "/v1/chat/completions", true],
  ["openai.responses.v1", "POST", "/v1/responses", true],
  ["openai.embeddings.v1", "POST", "/v1/embeddings", false],
]);

function plainObject(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    throw new Error(`${label} is not a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new Error(`${label} is not a valid timestamp`);
  }
  return milliseconds;
}

function requireNoStore(response, label) {
  const cacheControl = response.headers?.get?.("cache-control") ?? "";
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(cacheControl)) {
    throw new Error(`${label} is missing Cache-Control: no-store`);
  }
}

async function boundedJson(response, label) {
  requireNoStore(response, label);
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new Error(`${label} is not JSON`);
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared)) {
      throw new Error(`${label} has an invalid Content-Length`);
    }
    if (Number(declared) > MAX_ADMISSION_DOCUMENT_BYTES) {
      throw new Error(`${label} is too large`);
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`${label} has no readable body`);
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > MAX_ADMISSION_DOCUMENT_BYTES) {
        throw new Error(`${label} is too large`);
      }
      chunks.push(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateReadyz(value) {
  const document = plainObject(value, "LocalLLM readiness document");
  const service = plainObject(document.service, "LocalLLM readiness service");
  const checks = plainObject(document.checks, "LocalLLM readiness checks");
  const process = plainObject(checks.process, "LocalLLM process readiness");
  const ollama = plainObject(checks.ollama, "LocalLLM runtime readiness");
  const models = plainObject(checks.required_models, "LocalLLM model readiness");
  if (
    document.schema_version !== 1
    || document.ok !== true
    || document.status !== "ready"
    || service.name !== "localllm-api"
    || typeof service.version !== "string"
    || service.version.length < 1
    || service.version.length > 64
    || process.ok !== true
    || ollama.ok !== true
    || ollama.code !== "ready"
    || models.ok !== true
    || !Array.isArray(models.missing)
    || models.missing.length !== 0
  ) {
    throw new Error("LocalLLM catalog readiness did not pass");
  }
  return document;
}

function validateProtocols(value) {
  if (!Array.isArray(value)) throw new Error("LocalLLM protocols are missing");
  const actual = new Map();
  for (const item of value) {
    const protocol = plainObject(item, "LocalLLM protocol");
    if (typeof protocol.id !== "string" || actual.has(protocol.id)) {
      throw new Error("LocalLLM protocols are ambiguous");
    }
    actual.set(protocol.id, protocol);
  }
  for (const [id, method, path, streaming] of REQUIRED_PROTOCOLS) {
    const protocol = actual.get(id);
    if (
      protocol?.method !== method
      || protocol?.path !== path
      || protocol?.authentication !== "bearer"
      || protocol?.streaming !== streaming
    ) {
      throw new Error(`LocalLLM protocol ${id} is unavailable`);
    }
  }
}

function validateRequiredModels(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} are missing`);
  const models = new Map();
  for (const item of value) {
    const model = plainObject(item, `${label} entry`);
    if (
      typeof model.id !== "string"
      || model.id.length < 1
      || model.id.length > 200
      || typeof model.resolved_id !== "string"
      || model.resolved_id.length < 1
      || model.resolved_id.length > 200
      || model.available !== true
      || models.has(model.id)
    ) {
      throw new Error(`${label} are invalid`);
    }
    models.set(model.id, model.resolved_id);
  }
  return [...models.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function validateCapabilities(value, readyz, nowMilliseconds) {
  const document = plainObject(value, "LocalLLM capabilities document");
  const service = plainObject(document.service, "LocalLLM capabilities service");
  const runtime = plainObject(document.runtime, "LocalLLM capabilities runtime");
  const functional = plainObject(
    document.functional_readiness,
    "LocalLLM functional readiness",
  );
  if (
    document.schema_version !== 2
    || document.ready !== true
    || service.name !== "localllm-api"
    || service.version !== readyz.service.version
    || service.node_kind !== "local-inference"
    || typeof service.release_id !== "string"
    || !IMMUTABLE_RELEASE_ID.test(service.release_id)
    || runtime.provider !== "ollama"
    || runtime.ready !== true
    || runtime.error_code !== null
  ) {
    throw new Error("LocalLLM capability identity is not admissible");
  }
  const readyModels = validateRequiredModels(
    readyz.checks.required_models.models,
    "LocalLLM readiness required models",
  );
  const capabilityModels = validateRequiredModels(
    document.required_models,
    "LocalLLM capability required models",
  );
  if (JSON.stringify(readyModels) !== JSON.stringify(capabilityModels)) {
    throw new Error("LocalLLM required model contracts do not match");
  }
  validateProtocols(document.protocols);
  if (
    functional.required_for_catalog_readiness !== false
    || functional.ready !== true
    || functional.status !== "passed"
    || functional.fresh !== true
    || functional.release_id !== service.release_id
    || !Number.isInteger(functional.max_age_seconds)
    || functional.max_age_seconds < 60
    || functional.max_age_seconds > 604_800
    || !Number.isInteger(functional.age_seconds)
    || functional.age_seconds < 0
    || functional.age_seconds > functional.max_age_seconds
  ) {
    throw new Error("LocalLLM functional canary is not admissible");
  }
  const receiptTimestamp = exactTimestamp(
    functional.timestamp,
    "LocalLLM functional receipt timestamp",
  );
  if (receiptTimestamp > nowMilliseconds + 5_000) {
    throw new Error("LocalLLM functional receipt is from the future");
  }
  const requiredRoles = functional.required_roles;
  const roles = functional.roles;
  if (
    !Array.isArray(requiredRoles)
    || requiredRoles.length < 1
    || requiredRoles.length > Object.keys(ROLE_ALIASES).length
    || new Set(requiredRoles).size !== requiredRoles.length
    || requiredRoles.some((role) => !Object.hasOwn(ROLE_ALIASES, role))
    || !Array.isArray(roles)
    || roles.length < requiredRoles.length
    || roles.length > Object.keys(ROLE_ALIASES).length
  ) {
    throw new Error("LocalLLM functional roles are invalid");
  }
  const roleByName = new Map();
  const roleTimestampByName = new Map();
  for (const item of roles) {
    const role = plainObject(item, "LocalLLM functional role");
    if (!Object.hasOwn(ROLE_ALIASES, role.role) || roleByName.has(role.role)) {
      throw new Error("LocalLLM functional roles are ambiguous");
    }
    if (
      role.status !== "passed"
      || role.alias !== ROLE_ALIASES[role.role]
      || typeof role.resolved_model !== "string"
      || role.resolved_model.length < 1
      || role.resolved_model.length > 200
      || typeof role.digest !== "string"
      || !MODEL_DIGEST.test(role.digest)
      || !Number.isInteger(role.latency_ms)
      || role.latency_ms < 0
      || role.latency_ms > 600_000
    ) {
      throw new Error(`LocalLLM ${role.role} canary did not pass`);
    }
    const roleTimestamp = exactTimestamp(
      role.timestamp,
      `LocalLLM ${role.role} canary timestamp`,
    );
    roleByName.set(role.role, role);
    roleTimestampByName.set(role.role, roleTimestamp);
  }
  const requiredEvidence = requiredRoles.map((role) => roleByName.get(role));
  if (requiredEvidence.some((item) => item === undefined)) {
    throw new Error("LocalLLM functional canary is incomplete");
  }
  const requiredTimestamps = requiredRoles.map((role) => roleTimestampByName.get(role));
  if (requiredTimestamps.some((timestamp) => timestamp > nowMilliseconds + 5_000)) {
    throw new Error("LocalLLM functional role timestamp is from the future");
  }
  if (requiredTimestamps.some((timestamp) => timestamp > receiptTimestamp)) {
    throw new Error("LocalLLM functional role timestamp follows its receipt");
  }
  const oldestRequiredTimestamp = Math.min(...requiredTimestamps);
  const observedAge = Math.max(0, Math.floor((nowMilliseconds - oldestRequiredTimestamp) / 1000));
  if (
    observedAge > functional.max_age_seconds
    || Math.abs(observedAge - functional.age_seconds) > 5
  ) {
    throw new Error("LocalLLM functional canary is stale");
  }
  if (!Array.isArray(document.models)) {
    throw new Error("LocalLLM model provenance is missing");
  }
  for (const evidence of requiredEvidence) {
    const matches = document.models.filter((candidate) => {
      const model = plainObject(candidate, "LocalLLM model provenance");
      return model.id === evidence.resolved_model
        && model.digest === evidence.digest
        && Array.isArray(model.aliases)
        && model.aliases.includes(evidence.alias);
    });
    if (matches.length !== 1) {
      throw new Error(`LocalLLM ${evidence.role} model provenance does not match`);
    }
  }
  return document;
}

async function fetchAdmissionDocument(fetchImpl, url, label, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (response.status !== 200) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  try {
    return await boundedJson(response, label);
  } catch (error) {
    await response.body?.cancel?.().catch(() => {});
    throw error;
  }
}

export async function probeLocalLlmAdmission({
  readyUrl,
  capabilitiesUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
  now = Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("admission timeout must be between 100 and 30000 ms");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("admission clock is invalid");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const readyz = validateReadyz(await fetchAdmissionDocument(
    fetchImpl,
    readyUrl,
    "LocalLLM /readyz",
    signal,
  ));
  validateCapabilities(await fetchAdmissionDocument(
    fetchImpl,
    capabilitiesUrl,
    "LocalLLM node capabilities",
    signal,
  ), readyz, now);
}

export { MAX_ADMISSION_DOCUMENT_BYTES };
