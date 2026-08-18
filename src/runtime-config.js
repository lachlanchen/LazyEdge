import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseDocument } from "yaml";

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

export async function loadBindings(filePath) {
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
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(serviceId)) {
      throw new Error(`Invalid binding service id ${serviceId}`);
    }
    const binding = plainObject(rawBinding, `bindings.${serviceId}`);
    knownKeys(
      binding,
      new Set(["relaySecretFile", "upstreamAuthorizationFile", "clientTokenStore"]),
      `bindings.${serviceId}`,
    );
    const normalized = {};
    for (const key of ["relaySecretFile", "upstreamAuthorizationFile", "clientTokenStore"]) {
      if (binding[key] !== undefined) normalized[key] = privatePath(binding[key], key);
    }
    bindings.set(serviceId, Object.freeze(normalized));
  }
  return bindings;
}
