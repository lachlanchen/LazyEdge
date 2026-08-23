import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseDocument } from "yaml";

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const BINDING_FIELDS = new Set([
  "relaySecretFile",
  "upstreamAuthorizationFile",
  "clientTokenStore",
]);

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function knownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`);
}

function privatePath(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new Error(`${label} must be a file path`);
  }
  if (value.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  return expandHome(value);
}

export async function readPrivateText(filePath, label = "secret file") {
  const resolved = privatePath(filePath, label);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if ((metadata.mode & 0o007) !== 0) {
    throw new Error(`${label} must not be accessible to other users`);
  }
  if (metadata.size < 16 || metadata.size > 4096) {
    throw new Error(`${label} has an unsafe size`);
  }
  const value = (await readFile(resolved, "utf8")).replace(/[\r\n]+$/u, "");
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must contain exactly one line`);
  }
  return value;
}

function runtimeBindingPolicy(options) {
  if (options === undefined) return undefined;
  const policy = plainObject(options, "bindings policy");
  knownKeys(policy, new Set(["role", "declaredServiceIds"]), "bindings policy");
  if (policy.role !== "edge" && policy.role !== "worker") {
    throw new Error("bindings policy role must be edge or worker");
  }
  if (
    !Array.isArray(policy.declaredServiceIds)
    || policy.declaredServiceIds.length === 0
    || policy.declaredServiceIds.length > 128
  ) {
    throw new Error("bindings policy declaredServiceIds must be a bounded non-empty array");
  }
  const declaredServiceIds = new Set();
  for (const serviceId of policy.declaredServiceIds) {
    if (typeof serviceId !== "string" || !SERVICE_ID_PATTERN.test(serviceId)) {
      throw new Error("bindings policy contains an invalid declared service id");
    }
    if (declaredServiceIds.has(serviceId)) {
      throw new Error(`bindings policy contains duplicate service id ${serviceId}`);
    }
    declaredServiceIds.add(serviceId);
  }
  return Object.freeze({ role: policy.role, declaredServiceIds });
}

export async function loadBindings(filePath, options) {
  const policy = runtimeBindingPolicy(options);
  const resolved = privatePath(filePath, "bindings path");
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Bindings must be a regular non-symlink file");
  }
  if ((metadata.mode & 0o007) !== 0) {
    throw new Error("Bindings must not be accessible to other users");
  }
  const document = parseDocument(await readFile(resolved, "utf8"), {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw new Error("Bindings file is not valid YAML");
  const root = plainObject(document.toJS({ maxAliasCount: 0 }), "bindings document");
  knownKeys(root, new Set(["bindings"]), "bindings document");
  const source = plainObject(root.bindings, "bindings");
  const bindings = new Map();
  for (const [serviceId, rawBinding] of Object.entries(source)) {
    if (!SERVICE_ID_PATTERN.test(serviceId)) {
      throw new Error(`Invalid binding service id ${serviceId}`);
    }
    if (policy && !policy.declaredServiceIds.has(serviceId)) {
      throw new Error(`bindings.${serviceId} is not declared by the manifest`);
    }
    const binding = plainObject(rawBinding, `bindings.${serviceId}`);
    if (policy?.role === "edge" && Object.hasOwn(binding, "upstreamAuthorizationFile")) {
      throw new Error(
        `bindings.${serviceId}.upstreamAuthorizationFile is worker-only and cannot be used by edge`,
      );
    }
    if (policy?.role === "worker" && Object.hasOwn(binding, "clientTokenStore")) {
      throw new Error(
        `bindings.${serviceId}.clientTokenStore is edge-only and cannot be used by worker`,
      );
    }
    knownKeys(binding, BINDING_FIELDS, `bindings.${serviceId}`);
    const normalized = {};
    for (const key of ["relaySecretFile", "upstreamAuthorizationFile", "clientTokenStore"]) {
      if (binding[key] !== undefined) normalized[key] = privatePath(binding[key], key);
    }
    bindings.set(serviceId, Object.freeze(normalized));
  }
  return bindings;
}
