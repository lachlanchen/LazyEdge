import path from "node:path";

import { stableStringify } from "./config.js";
import { SecurityError, sha256 } from "./security.js";

export const EDGE_ROLLOUT_API_VERSION = "lazyedge.lazying.art/v1alpha1";
export const EDGE_ROLLOUT_KIND = "EdgeRollout";
export const EDGE_ROLLOUT_ARTIFACT_TYPE = "regular-file";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const ACCOUNT_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const MODE_PATTERN = /^0[0-7]{3}$/u;
const ARTIFACT_PATH_PATTERN = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u;
const MAXIMUM_ARTIFACT_COUNT = 256;
const NO_FIELDS = Object.freeze([]);
const ROLLOUT_FIELDS = Object.freeze(["apiVersion", "kind", "metadata", "spec"]);
const METADATA_FIELDS = Object.freeze(["name"]);
const SPEC_FIELDS = Object.freeze(["edgeProjectDigest", "deploymentId", "artifacts"]);
const ARTIFACT_FIELDS = Object.freeze([
  "id",
  "path",
  "sha256",
  "owner",
  "group",
  "mode",
  "type",
]);

function invalid(message, code = "INVALID_ROLLOUT") {
  throw new SecurityError(message, { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, label) {
  if (!isPlainObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactObjectFields(value, label, required, optional = NO_FIELDS) {
  const source = object(value, label);
  const actual = Reflect.ownKeys(source);
  const nonString = actual.find((key) => typeof key !== "string");
  if (nonString !== undefined) invalid(`${label} contains a non-string field`);
  const allowed = [...required, ...optional];
  const unknown = actual.filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) invalid(`${label} contains unknown field: ${unknown[0]}`);

  const fields = Object.create(null);
  for (const field of required) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      invalid(`${label}.${field} must be an own enumerable data property`);
    }
    fields[field] = descriptor.value;
  }
  for (const field of optional) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      invalid(`${label}.${field} must be an own enumerable data property`);
    }
    fields[field] = descriptor.value;
  }
  return fields;
}

function exactString(value, label, pattern, maximumLength) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || !pattern.test(value)
  ) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function canonicalArtifactPath(value, label) {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > 4096
    || value.includes("\u0000")
    || value.includes("\\")
    || !path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === "/"
    || value.endsWith("/")
    || !ARTIFACT_PATH_PATTERN.test(value)
  ) {
    invalid(`${label} must be a canonical absolute artifact path`);
  }
  const components = value.slice(1).split("/");
  if (
    components.some((component) => (
      component.length < 1
      || component.length > 255
      || component === "."
      || component === ".."
    ))
  ) {
    invalid(`${label} must be a canonical absolute artifact path`);
  }
  return value;
}

function artifactMode(value, label) {
  if (typeof value !== "string" || !MODE_PATTERN.test(value)) {
    invalid(`${label} must be an exact four-digit Unix mode`);
  }
  if ((Number.parseInt(value, 8) & 0o022) !== 0) {
    invalid(`${label} must not be group or world writable`);
  }
  return value;
}

function normalizeArtifact(value, index) {
  const label = `spec.artifacts[${index}]`;
  const source = exactObjectFields(value, label, ARTIFACT_FIELDS);
  const type = exactString(source.type, `${label}.type`, /^regular-file$/u, 32);
  if (type !== EDGE_ROLLOUT_ARTIFACT_TYPE) invalid(`${label}.type is unsupported`);
  return {
    id: exactString(source.id, `${label}.id`, NAME_PATTERN, 63),
    path: canonicalArtifactPath(source.path, `${label}.path`),
    sha256: exactString(source.sha256, `${label}.sha256`, DIGEST_PATTERN, 64),
    owner: exactString(source.owner, `${label}.owner`, ACCOUNT_PATTERN, 32),
    group: exactString(source.group, `${label}.group`, ACCOUNT_PATTERN, 32),
    mode: artifactMode(source.mode, `${label}.mode`),
    type,
  };
}

function compareArtifacts(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function normalizeArtifacts(value) {
  const label = "spec.artifacts";
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be an ordinary array with 1-${MAXIMUM_ARTIFACT_COUNT} artifacts`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    invalid(`${label} contains a non-string property`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false
  ) {
    invalid(`${label}.length must be an own non-enumerable data property`);
  }
  const count = lengthDescriptor.value;
  if (
    !Number.isSafeInteger(count)
    || count < 1
    || count > MAXIMUM_ARTIFACT_COUNT
  ) {
    invalid(`${label} must contain 1-${MAXIMUM_ARTIFACT_COUNT} artifacts`);
  }

  const expectedKeys = new Set(["length"]);
  for (let index = 0; index < count; index += 1) expectedKeys.add(String(index));
  const unexpected = ownKeys.find((key) => !expectedKeys.has(key));
  if (unexpected !== undefined) {
    invalid(`${label} contains an unexpected property: ${unexpected}`);
  }

  const artifacts = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      invalid(`${label}[${index}] must be an enumerable data property`);
    }
    Object.defineProperty(artifacts, String(index), {
      configurable: true,
      enumerable: true,
      value: normalizeArtifact(descriptor.value, index),
      writable: true,
    });
  }
  return artifacts.sort(compareArtifacts);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function normalizeEdgeRollout(input) {
  const source = exactObjectFields(input, "rollout", ROLLOUT_FIELDS);
  if (source.apiVersion !== EDGE_ROLLOUT_API_VERSION) invalid("rollout.apiVersion is invalid");
  if (source.kind !== EDGE_ROLLOUT_KIND) invalid("rollout.kind is invalid");

  const metadataSource = exactObjectFields(source.metadata, "metadata", METADATA_FIELDS);
  const metadata = {
    name: exactString(metadataSource.name, "metadata.name", NAME_PATTERN, 63),
  };

  const specSource = exactObjectFields(source.spec, "spec", SPEC_FIELDS);
  const artifacts = normalizeArtifacts(specSource.artifacts);
  const ids = new Set();
  const paths = new Set();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) {
      invalid(`Duplicate artifact id: ${artifact.id}`, "DUPLICATE_CLAIM");
    }
    if (paths.has(artifact.path)) {
      invalid(`Duplicate artifact path: ${artifact.path}`, "DUPLICATE_CLAIM");
    }
    ids.add(artifact.id);
    paths.add(artifact.path);
  }

  return deepFreeze({
    apiVersion: EDGE_ROLLOUT_API_VERSION,
    kind: EDGE_ROLLOUT_KIND,
    metadata,
    spec: {
      edgeProjectDigest: exactString(
        specSource.edgeProjectDigest,
        "spec.edgeProjectDigest",
        DIGEST_PATTERN,
        64,
      ),
      deploymentId: exactString(
        specSource.deploymentId,
        "spec.deploymentId",
        OPERATION_ID_PATTERN,
        128,
      ),
      artifacts,
    },
  });
}

export function edgeRolloutDigest(input) {
  return sha256(stableStringify(normalizeEdgeRollout(input)));
}
