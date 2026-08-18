import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  manifestDigest,
  normalizeManifest,
  stableStringify,
} from "./config.js";
import { SecurityError, sha256 } from "./security.js";

const REVISION_ID_PATTERN = /^r-[0-9]{8}t[0-9]{6}z-[a-f0-9]{12}$/u;

function fileMode(value, label = "mode") {
  if (!Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new SecurityError(`${label} must be a Unix permission mode`);
  }
  return value;
}

function absolutePath(value, label) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\u0000")
    || path.normalize(value) !== value
    || value === "/"
  ) {
    throw new SecurityError(`${label} must be a normalized absolute file path`);
  }
  return value;
}

function buffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" || ArrayBuffer.isView(value)) return Buffer.from(value);
  throw new TypeError("Atomic file content must be a string, Buffer, or typed array");
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteFile(targetPath, content, {
  mode = 0o600,
  createParent = false,
  parentMode = 0o700,
} = {}) {
  if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.includes("\u0000")) {
    throw new TypeError("atomicWriteFile requires a file path");
  }
  const destination = path.resolve(targetPath);
  const directory = path.dirname(destination);
  const basename = path.basename(destination);
  const wantedMode = fileMode(mode);
  if (createParent) await mkdir(directory, { recursive: true, mode: fileMode(parentMode, "parentMode") });

  try {
    const current = await lstat(destination);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new SecurityError(`Refusing to replace non-regular file: ${destination}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporary = path.join(
    directory,
    `.${basename}.lazyedge-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", wantedMode);
    await handle.chmod(wantedMode);
    await handle.writeFile(buffer(content));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return Object.freeze({ path: destination, mode: wantedMode, bytes: buffer(content).byteLength });
}

export async function atomicWriteJson(targetPath, value, options = {}) {
  return atomicWriteFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function normalizeCreatedAt(value) {
  if (typeof value !== "string") {
    throw new SecurityError("createdAt must be supplied as an ISO-8601 UTC timestamp");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new SecurityError("createdAt must be a canonical ISO-8601 UTC timestamp");
  }
  return value;
}

function modeText(mode) {
  return fileMode(mode).toString(8).padStart(4, "0");
}

function normalizeCurrent(current, target) {
  const value = current?.[target];
  if (value === undefined || value === null || value.exists === false) {
    return Object.freeze({ exists: false });
  }
  if (typeof value !== "object" || value.exists !== true) {
    throw new SecurityError(`Current file metadata is invalid for ${target}`);
  }
  if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)) {
    throw new SecurityError(`Current digest is invalid for ${target}`);
  }
  return Object.freeze({
    exists: true,
    digest: value.digest,
    mode: modeText(value.mode),
  });
}

function revisionId(createdAt, digest) {
  const compact = createdAt
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "")
    .replace("000Z", "Z")
    .toLowerCase();
  const normalizedTime = compact.replace(/t([0-9]{6})z$/u, "t$1z");
  const id = `r-${normalizedTime}-${digest.slice(0, 12)}`;
  if (!REVISION_ID_PATTERN.test(id)) {
    throw new SecurityError("createdAt cannot be represented as a revision id");
  }
  return id;
}

export function planRevision({
  manifest,
  files,
  current = {},
  createdAt,
  previousRevisionId = null,
  stateRoot = "/var/lib/lazyedge/revisions",
}) {
  const normalizedManifest = normalizeManifest(manifest);
  const timestamp = normalizeCreatedAt(createdAt);
  const root = absolutePath(stateRoot, "stateRoot");
  if (!Array.isArray(files) || files.length === 0) {
    throw new SecurityError("Revision files must not be empty");
  }
  if (
    previousRevisionId !== null
    && (typeof previousRevisionId !== "string" || !REVISION_ID_PATTERN.test(previousRevisionId))
  ) {
    throw new SecurityError("previousRevisionId is invalid");
  }

  const manifestHash = manifestDigest(normalizedManifest);
  const normalizedFiles = files.map((file, index) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw new SecurityError(`files[${index}] must be an object`);
    }
    const target = absolutePath(file.path, `files[${index}].path`);
    const payload = buffer(file.content);
    return {
      path: target,
      mode: modeText(file.mode ?? 0o640),
      bytes: payload.byteLength,
      digest: sha256(payload),
      previous: normalizeCurrent(current, target),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalizedFiles.map((file) => file.path)).size !== normalizedFiles.length) {
    throw new SecurityError("Revision contains duplicate target paths");
  }

  const contentSetDigest = sha256(stableStringify(normalizedFiles.map((file) => ({
    path: file.path,
    mode: file.mode,
    digest: file.digest,
  }))));
  const id = revisionId(timestamp, sha256(`${manifestHash}\u0000${contentSetDigest}`));
  const revisionRoot = `${root}/${id}`;
  const operations = normalizedFiles.map((file) => Object.freeze({
    action: "atomic-write",
    target: file.path,
    staged: `${revisionRoot}/staged${file.path}`,
    backup: file.previous.exists ? `${revisionRoot}/backup${file.path}` : null,
    mode: file.mode,
    bytes: file.bytes,
    digest: file.digest,
    previous: file.previous,
  }));
  const rollbackOperations = [...operations].reverse().map((operation) => Object.freeze(
    operation.previous.exists
      ? {
        action: "atomic-restore",
        target: operation.target,
        backup: operation.backup,
        mode: operation.previous.mode,
        digest: operation.previous.digest,
      }
      : { action: "remove-created-file", target: operation.target },
  ));

  return Object.freeze({
    schemaVersion: 1,
    revisionId: id,
    status: "planned",
    createdAt: timestamp,
    project: normalizedManifest.metadata.name,
    manifestDigest: manifestHash,
    contentSetDigest,
    previousRevisionId,
    revisionRoot,
    operations: Object.freeze(operations),
    rollback: Object.freeze({
      targetRevisionId: previousRevisionId,
      operations: Object.freeze(rollbackOperations),
    }),
  });
}

export function rollbackPlan(revision) {
  if (
    typeof revision !== "object"
    || revision === null
    || !REVISION_ID_PATTERN.test(revision.revisionId ?? "")
    || !Array.isArray(revision.rollback?.operations)
  ) {
    throw new SecurityError("Revision metadata is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceRevisionId: revision.revisionId,
    targetRevisionId: revision.rollback.targetRevisionId ?? null,
    operations: Object.freeze(revision.rollback.operations.map((operation) => Object.freeze({
      ...operation,
    }))),
  });
}

export async function writeRevisionMetadata(targetPath, revision) {
  rollbackPlan(revision);
  return atomicWriteJson(targetPath, revision, { mode: 0o600, createParent: true });
}
