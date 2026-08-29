import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { parseDocument } from "yaml";

import { edgeRolloutDigest, normalizeEdgeRollout } from "./rollout-contract.js";
import { SecurityError } from "./security.js";

const MAXIMUM_ROLLOUT_BYTES = 1024 * 1024;

function invalid(message) {
  throw new SecurityError(message, { code: "INVALID_ROLLOUT" });
}

export function parseEdgeRolloutDocument(text, { source = "rollout" } = {}) {
  if (
    typeof text !== "string"
    || text.length < 1
    || Buffer.byteLength(text, "utf8") > MAXIMUM_ROLLOUT_BYTES
  ) {
    invalid(`${source} is empty or too large`);
  }
  const document = parseDocument(text, {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    invalid(`${source} is not valid YAML or JSON: ${document.errors[0].message}`);
  }
  if (document.warnings.length > 0) {
    invalid(`${source} uses unsupported YAML features: ${document.warnings[0].message}`);
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    invalid(`${source} uses unsupported YAML aliases: ${error.message}`);
  }
  return normalizeEdgeRollout(value);
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function assertPathSnapshot(filePath, expected) {
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") invalid(`${filePath} changed while it was being read`);
    throw error;
  }
  if (!sameFileSnapshot(expected, current)) {
    invalid(`${filePath} changed while it was being read`);
  }
}

async function readBoundedRolloutFile(filePath) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error.code === "ELOOP") invalid(`${filePath} must not be a symbolic link`);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAXIMUM_ROLLOUT_BYTES)) {
      invalid(`${filePath} must be a non-empty regular file no larger than 1 MiB`);
    }
    await assertPathSnapshot(filePath, before);

    const bytes = Buffer.allocUnsafe(MAXIMUM_ROLLOUT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length < 1 || length > MAXIMUM_ROLLOUT_BYTES) {
      invalid(`${filePath} must be a non-empty regular file no larger than 1 MiB`);
    }

    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after) || after.size !== BigInt(length)) {
      invalid(`${filePath} changed while it was being read`);
    }
    await assertPathSnapshot(filePath, after);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      invalid(`${filePath} must contain valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

export async function loadEdgeRolloutDocument(filePath) {
  if (typeof filePath !== "string" || filePath.length < 1) {
    throw new TypeError("loadEdgeRolloutDocument requires a file path");
  }
  return parseEdgeRolloutDocument(await readBoundedRolloutFile(filePath), { source: filePath });
}

export function summarizeEdgeRollout(input) {
  const rollout = normalizeEdgeRollout(input);
  return Object.freeze({
    summaryOnly: true,
    name: rollout.metadata.name,
    deploymentId: rollout.spec.deploymentId,
    edgeProjectDigest: rollout.spec.edgeProjectDigest,
    planDigest: edgeRolloutDigest(rollout),
    artifactCount: rollout.spec.artifacts.length,
    artifacts: rollout.spec.artifacts,
  });
}
