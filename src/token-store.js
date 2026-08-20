import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
  constantTimeEqual,
  normalizeDomain,
  normalizeMethod,
  normalizeRoutePath,
  SecurityError,
  sha256,
  TOKEN_ENTROPY_BYTES,
} from "./security.js";

const STORE_VERSION = 1;
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^le1_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/u;
const DUMMY_DIGEST = Buffer.alloc(32);
const LOCK_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MIN_MS = 8;
const LOCK_RETRY_SPREAD_MS = 24;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_REAP_FILE = ".reap";
const STORE_REFRESH_INTERVAL_MS = 100;
const STORE_REFRESH_MAX_WAITERS = 32;

function tokenSetName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value)) {
    throw new SecurityError("tokenSet is invalid", { code: "INVALID_TOKEN_SET" });
  }
  return value;
}

function normalizeStringSet(value, label, mapper) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new SecurityError(`${label} must be a non-empty array`);
  }
  const mapped = value.map(mapper);
  if (new Set(mapped).size !== mapped.length) {
    throw new SecurityError(`${label} contains duplicates`, { code: "DUPLICATE_CLAIM" });
  }
  return Object.freeze(mapped.sort());
}

export function normalizeTokenScope(scope) {
  if (scope === undefined || scope === null) return Object.freeze({});
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw new SecurityError("token scope must be an object");
  }
  const allowed = new Set(["serviceIds", "hosts", "methods", "paths"]);
  const unknown = Object.keys(scope).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new SecurityError(`Unknown token scope field: ${unknown[0]}`);

  const normalized = {};
  const serviceIds = normalizeStringSet(
    scope.serviceIds,
    "scope.serviceIds",
    (value) => {
      if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value)) {
        throw new SecurityError("scope.serviceIds contains an invalid service id");
      }
      return value;
    },
  );
  const hosts = normalizeStringSet(
    scope.hosts,
    "scope.hosts",
    (value) => normalizeDomain(value, "scope host"),
  );
  const methods = normalizeStringSet(scope.methods, "scope.methods", normalizeMethod);
  const paths = normalizeStringSet(
    scope.paths,
    "scope.paths",
    (value) => normalizeRoutePath(value),
  );
  if (serviceIds) normalized.serviceIds = serviceIds;
  if (hosts) normalized.hosts = hosts;
  if (methods) normalized.methods = methods;
  if (paths) normalized.paths = paths;
  return Object.freeze(normalized);
}

function normalizeTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new SecurityError(`${label} is invalid`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new SecurityError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function publicRecord(record) {
  return Object.freeze({
    id: record.id,
    tokenSet: record.tokenSet,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    scope: record.scope,
  });
}

function normalizeStoredRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new SecurityError("Token store contains an invalid record");
  }
  const allowed = new Set([
    "id",
    "tokenSet",
    "digest",
    "createdAt",
    "expiresAt",
    "revokedAt",
    "scope",
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0 || "token" in record || "secret" in record) {
    throw new SecurityError("Token store must never contain raw credentials");
  }
  if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(record.id)) {
    throw new SecurityError("Token store contains an invalid id");
  }
  if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) {
    throw new SecurityError("Token store contains an invalid SHA-256 digest");
  }
  return {
    id: record.id,
    tokenSet: tokenSetName(record.tokenSet),
    digest: record.digest,
    createdAt: normalizeTimestamp(record.createdAt, "createdAt"),
    expiresAt: normalizeTimestamp(record.expiresAt, "expiresAt"),
    revokedAt: normalizeTimestamp(record.revokedAt, "revokedAt", { nullable: true }),
    scope: normalizeTokenScope(record.scope),
  };
}

function recordsFromSource(source) {
  if (
    source === null
    || typeof source !== "object"
    || Array.isArray(source)
    || source.version !== STORE_VERSION
    || !Array.isArray(source.tokens)
    || Object.keys(source).some((key) => !["version", "tokens"].includes(key))
  ) {
    throw new SecurityError("Token store format is invalid", {
      code: "INVALID_TOKEN_STORE",
    });
  }
  const records = new Map();
  for (const value of source.tokens) {
    const record = normalizeStoredRecord(value);
    if (records.has(record.id)) {
      throw new SecurityError("Token store contains duplicate ids", {
        code: "DUPLICATE_CLAIM",
      });
    }
    records.set(record.id, record);
  }
  return records;
}

function validateStoreMetadata(metadata) {
  if (
    !metadata.isFile()
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new SecurityError("Token store must be an owner-only regular file", {
      code: "INSECURE_TOKEN_STORE",
    });
  }
}

function parseStoreContents(contents) {
  try {
    return recordsFromSource(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SecurityError("Token store is not valid JSON", {
        code: "INVALID_TOKEN_STORE",
      });
    }
    throw error;
  }
}

function storeFingerprint(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

function sameFingerprint(left, right) {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function inspectStoreFingerprint(filePath) {
  try {
    const metadata = await lstat(filePath);
    validateStoreMetadata(metadata);
    return storeFingerprint(metadata);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readStoreSnapshot(filePath) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    validateStoreMetadata(metadata);
    return {
      records: parseStoreContents(await handle.readFile("utf8")),
      fingerprint: storeFingerprint(metadata),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { records: new Map(), fingerprint: null };
    if (error.code === "ELOOP") {
      throw new SecurityError("Token store symlinks are forbidden", {
        code: "INSECURE_TOKEN_STORE",
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function readStoreRecordsSync(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    validateStoreMetadata(fstatSync(descriptor));
    return parseStoreContents(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    if (error.code === "ELOOP") {
      throw new SecurityError("Token store symlinks are forbidden", {
        code: "INSECURE_TOKEN_STORE",
      });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function processIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const afterName = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/u);
    const startTicks = afterName[19];
    return startTicks ? `linux-start-ticks:${startTicks}` : null;
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
}

function normalizeLockOwner(value) {
  let acquiredAtIsValid = false;
  if (typeof value?.acquiredAt === "string") {
    const timestamp = Date.parse(value.acquiredAt);
    acquiredAtIsValid = Number.isFinite(timestamp)
      && new Date(timestamp).toISOString() === value.acquiredAt;
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== LOCK_VERSION
    || typeof value.ownerId !== "string"
    || !/^[a-f0-9]{32}$/u.test(value.ownerId)
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.hostname !== "string"
    || value.hostname.length < 1
    || value.hostname.length > 255
    || (value.processIdentity !== null && typeof value.processIdentity !== "string")
    || !acquiredAtIsValid
    || Object.keys(value).some((key) => ![
      "version",
      "ownerId",
      "pid",
      "hostname",
      "processIdentity",
      "acquiredAt",
    ].includes(key))
  ) {
    return null;
  }
  return value;
}

async function readLockOwner(lockPath) {
  let handle;
  try {
    handle = await open(
      path.join(lockPath, LOCK_OWNER_FILE),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    validateStoreMetadata(await handle.stat());
    return normalizeLockOwner(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    if (error.code === "ELOOP") {
      throw new SecurityError("Token store lock symlinks are forbidden", {
        code: "INSECURE_TOKEN_STORE_LOCK",
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readReapOwner(reapPath) {
  let handle;
  try {
    handle = await open(
      reapPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    validateStoreMetadata(metadata);
    let owner = null;
    try {
      owner = normalizeLockOwner(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { metadata, owner };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      throw new SecurityError("Token store reaper symlinks are forbidden", {
        code: "INSECURE_TOKEN_STORE_LOCK",
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function lockOwnerIsAlive(owner) {
  if (!owner || owner.hostname !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
  if (owner.processIdentity === null) return true;
  const currentIdentity = await processIdentity(owner.pid);
  return currentIdentity === null || currentIdentity === owner.processIdentity;
}

function lockIsOwnerOnlyDirectory(metadata) {
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && (metadata.mode & 0o077) === 0
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid());
}

async function inspectLock(lockPath) {
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!lockIsOwnerOnlyDirectory(metadata)) {
    throw new SecurityError("Token store lock must be an owner-only directory", {
      code: "INSECURE_TOKEN_STORE_LOCK",
    });
  }
  return { metadata, owner: await readLockOwner(lockPath) };
}

function ownerRecord(ownerId) {
  return processIdentity(process.pid).then((identity) => ({
    version: LOCK_VERSION,
    ownerId,
    pid: process.pid,
    hostname: hostname(),
    processIdentity: identity,
    acquiredAt: new Date().toISOString(),
  }));
}

async function quarantineStaleLock(lockPath, inspection) {
  const currentMetadata = await lstat(lockPath);
  if (!sameFile(inspection.metadata, currentMetadata)) return false;
  const currentOwner = await readLockOwner(lockPath);
  if (
    inspection.owner !== null
    && currentOwner?.ownerId !== inspection.owner.ownerId
  ) return false;
  if (inspection.owner === null && currentOwner !== null) return false;

  // The inode-derived destination is deliberately retained. It prevents a
  // delayed competing reaper from moving a newly created successor lock by
  // pathname after this stale directory has been quarantined.
  const tombstonePath = `${lockPath}.reaped.${inspection.metadata.dev}.${inspection.metadata.ino}`;
  try {
    await rename(lockPath, tombstonePath);
  } catch (error) {
    if (["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
  const movedMetadata = await lstat(tombstonePath);
  if (!sameFile(inspection.metadata, movedMetadata)) {
    throw new SecurityError("Token store lock changed during stale-lock quarantine", {
      code: "TOKEN_STORE_LOCK_REPLACED",
    });
  }
  return true;
}

async function reapLock(lockPath, inspection) {
  const age = Date.now() - inspection.metadata.mtimeMs;
  const alive = await lockOwnerIsAlive(inspection.owner);
  if (alive === true || (alive === null && age < LOCK_STALE_MS)) return false;

  let reapHandle;
  let reapMetadata;
  let ownsMarker = false;
  const reapPath = path.join(lockPath, LOCK_REAP_FILE);
  try {
    try {
      reapHandle = await open(
        reapPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const markerOwner = await ownerRecord(randomBytes(16).toString("hex"));
      await reapHandle.writeFile(`${JSON.stringify(markerOwner)}\n`, "utf8");
      await reapHandle.sync();
      reapMetadata = await reapHandle.stat();
      ownsMarker = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const marker = await readReapOwner(reapPath);
      if (marker === null) return false;
      const markerAge = Date.now() - marker.metadata.mtimeMs;
      const markerAlive = await lockOwnerIsAlive(marker.owner);
      if (
        markerAlive === true
        || (markerAlive === null && markerAge < LOCK_STALE_MS)
      ) return false;
    }

    await reapHandle?.close();
    reapHandle = undefined;
    return await quarantineStaleLock(lockPath, inspection);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  } finally {
    await reapHandle?.close();
    if (ownsMarker && reapMetadata !== undefined) {
      try {
        const currentMarker = await lstat(reapPath);
        if (sameFile(reapMetadata, currentMarker)) await unlink(reapPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

async function releaseLock(lockPath, ownerId, directoryMetadata) {
  try {
    const currentMetadata = await lstat(lockPath);
    if (!sameFile(directoryMetadata, currentMetadata)) return;
    const currentOwner = await readLockOwner(lockPath);
    if (currentOwner?.ownerId !== ownerId) return;
    await unlink(path.join(lockPath, LOCK_OWNER_FILE));
    await rmdir(lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
  }
}

async function cleanupCreatedLock(lockPath, ownerId, directoryMetadata, ownerWritten) {
  try {
    const currentMetadata = await lstat(lockPath);
    if (!sameFile(directoryMetadata, currentMetadata)) return;
    const currentOwner = await readLockOwner(lockPath);
    if (ownerWritten && currentOwner?.ownerId !== ownerId) return;
    if (!ownerWritten && currentOwner !== null) return;
    if (ownerWritten) await unlink(path.join(lockPath, LOCK_OWNER_FILE));
    await rmdir(lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
  }
}

function retryDelay() {
  return LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_SPREAD_MS);
}

async function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const directoryMetadata = await lstat(lockPath);
      const ownerId = randomBytes(16).toString("hex");
      const owner = await ownerRecord(ownerId);
      let ownerWritten = false;
      try {
        const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
        const handle = await open(
          ownerPath,
          fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        ownerWritten = true;
        const currentMetadata = await lstat(lockPath);
        const currentOwner = await readLockOwner(lockPath);
        if (
          !sameFile(directoryMetadata, currentMetadata)
          || currentOwner?.ownerId !== ownerId
        ) {
          throw new SecurityError("Token store lock ownership changed during acquisition", {
            code: "TOKEN_STORE_LOCK_REPLACED",
          });
        }
        return () => releaseLock(lockPath, ownerId, directoryMetadata);
      } catch (error) {
        await cleanupCreatedLock(
          lockPath,
          ownerId,
          directoryMetadata,
          ownerWritten,
        ).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const inspection = await inspectLock(lockPath);
    if (inspection !== null && await reapLock(lockPath, inspection)) continue;
    if (Date.now() >= deadline) {
      throw new SecurityError("Timed out waiting for the token store lock", {
        code: "TOKEN_STORE_LOCK_TIMEOUT",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay()));
  }
}

function expirationFromOptions({ expiresAt, expiresInSeconds }, now) {
  if (expiresAt !== undefined && expiresInSeconds !== undefined) {
    throw new SecurityError("Use expiresAt or expiresInSeconds, not both");
  }
  if (expiresAt !== undefined) {
    const normalized = normalizeTimestamp(
      typeof expiresAt === "string" ? expiresAt : new Date(expiresAt).toISOString(),
      "expiresAt",
    );
    if (Date.parse(normalized) <= now) throw new SecurityError("expiresAt must be in the future");
    return normalized;
  }
  const ttl = expiresInSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 366 * 24 * 60 * 60) {
    throw new SecurityError("expiresInSeconds is outside its safe range");
  }
  return new Date(now + (ttl * 1000)).toISOString();
}

function scopeAllows(scope, context) {
  if (!context) return Object.keys(scope).length === 0;
  if (scope.serviceIds && !scope.serviceIds.includes(context.serviceId)) return false;
  if (scope.hosts && !scope.hosts.includes(context.host)) return false;
  if (scope.methods && !scope.methods.includes(context.method)) return false;
  if (scope.paths && !scope.paths.includes(context.path)) return false;
  return true;
}

export class TokenStore {
  constructor({
    filePath = null,
    clock = () => Date.now(),
    records = [],
    fingerprint = null,
  } = {}) {
    if (filePath !== null && (typeof filePath !== "string" || filePath.length === 0)) {
      throw new TypeError("filePath must be a non-empty string or null");
    }
    this.filePath = filePath;
    this.clock = clock;
    this.records = new Map();
    this.mutation = Promise.resolve();
    this.fingerprint = fingerprint;
    this.refreshPromise = null;
    this.refreshWaiters = 0;
    this.nextRefreshAt = Date.now() + STORE_REFRESH_INTERVAL_MS;
    this.mutating = false;
    for (const value of records) {
      const record = normalizeStoredRecord(value);
      if (this.records.has(record.id)) {
        throw new SecurityError("Token store contains duplicate ids", {
          code: "DUPLICATE_CLAIM",
        });
      }
      this.records.set(record.id, record);
    }
  }

  static async open({ filePath, clock } = {}) {
    if (!filePath) return new TokenStore({ clock });
    const snapshot = await readStoreSnapshot(filePath);
    return new TokenStore({
      filePath,
      clock,
      records: snapshot.records.values(),
      fingerprint: snapshot.fingerprint,
    });
  }

  async issue({ tokenSet, expiresAt, expiresInSeconds, scope } = {}) {
    const normalizedSet = tokenSetName(tokenSet);
    const normalizedScope = normalizeTokenScope(scope);
    let result;
    await this.#mutate(async () => {
      const now = this.clock();
      let id;
      do id = randomBytes(9).toString("base64url");
      while (this.records.has(id));
      const secret = randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
      const token = `le1_${id}_${secret}`;
      const record = {
        id,
        tokenSet: normalizedSet,
        digest: sha256(token),
        createdAt: new Date(now).toISOString(),
        expiresAt: expirationFromOptions({ expiresAt, expiresInSeconds }, now),
        revokedAt: null,
        scope: normalizedScope,
      };
      this.records.set(id, record);
      try {
        await this.#persist();
        result = Object.freeze({ token, ...publicRecord(record) });
      } catch (error) {
        this.records.delete(id);
        throw error;
      }
    });
    return result;
  }

  async verify(token, { tokenSet, context } = {}) {
    const match = typeof token === "string" ? TOKEN_PATTERN.exec(token) : null;
    if (match === null) return null;
    if (!await this.#refreshIfDue()) return null;
    const record = this.records.get(match[1]);
    const actual = Buffer.from(sha256(token, "hex"), "hex");
    const expected = record ? Buffer.from(record.digest, "hex") : DUMMY_DIGEST;
    if (!constantTimeEqual(actual, expected) || !record) return null;
    if (tokenSet !== undefined && record.tokenSet !== tokenSetName(tokenSet)) return null;
    const now = this.clock();
    if (record.revokedAt !== null || Date.parse(record.expiresAt) <= now) return null;
    if (!scopeAllows(record.scope, context)) return null;
    return publicRecord(record);
  }

  async revoke(idOrToken) {
    const match = typeof idOrToken === "string" ? TOKEN_PATTERN.exec(idOrToken) : null;
    const id = match ? match[1] : idOrToken;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(id)) return false;
    let changed = false;
    await this.#mutate(async () => {
      const record = this.records.get(id);
      if (!record || record.revokedAt !== null) return;
      const revokedAt = new Date(this.clock()).toISOString();
      record.revokedAt = revokedAt;
      try {
        await this.#persist();
        changed = true;
      } catch (error) {
        record.revokedAt = null;
        throw error;
      }
    });
    return changed;
  }

  list({ tokenSet, includeRevoked = true } = {}) {
    const normalizedSet = tokenSet === undefined ? undefined : tokenSetName(tokenSet);
    const records = this.filePath === null
      ? this.records
      : readStoreRecordsSync(this.filePath);
    return [...records.values()]
      .filter((record) => normalizedSet === undefined || record.tokenSet === normalizedSet)
      .filter((record) => includeRevoked || record.revokedAt === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicRecord);
  }

  async #serialize(operation) {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => {});
    return next;
  }

  async #mutate(operation) {
    return this.#serialize(async () => {
      this.mutating = true;
      try {
        await this.refreshPromise?.catch(() => {});
        if (this.filePath === null) return await operation();
        const release = await acquireLock(this.filePath);
        try {
          await this.#reload();
          return await operation();
        } finally {
          await release();
        }
      } finally {
        this.nextRefreshAt = Date.now() + STORE_REFRESH_INTERVAL_MS;
        this.mutating = false;
      }
    });
  }

  async #reload() {
    if (this.filePath === null) return;
    const snapshot = await readStoreSnapshot(this.filePath);
    this.records = snapshot.records;
    this.fingerprint = snapshot.fingerprint;
  }

  async #refreshIfDue() {
    if (this.filePath === null) return true;
    if (this.mutating) return false;
    if (this.refreshPromise !== null) {
      if (this.refreshWaiters >= STORE_REFRESH_MAX_WAITERS) return false;
      this.refreshWaiters += 1;
      try {
        await this.refreshPromise;
        return true;
      } finally {
        this.refreshWaiters -= 1;
      }
    }
    if (Date.now() < this.nextRefreshAt) return true;

    this.nextRefreshAt = Date.now() + STORE_REFRESH_INTERVAL_MS;
    const refresh = (async () => {
      const fingerprint = await inspectStoreFingerprint(this.filePath);
      if (!sameFingerprint(fingerprint, this.fingerprint)) await this.#reload();
    })();
    this.refreshPromise = refresh;
    try {
      await refresh;
      return true;
    } catch (error) {
      this.records = new Map();
      this.fingerprint = null;
      throw error;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    }
  }

  async #persist() {
    if (this.filePath === null) return;
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const contents = `${JSON.stringify({
      version: STORE_VERSION,
      tokens: [...this.records.values()],
    }, null, 2)}\n`;
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(contents, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      const directoryHandle = await open(
        directory,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      this.fingerprint = await inspectStoreFingerprint(this.filePath);
    } catch (error) {
      await handle?.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

export async function issueToken(store, options) {
  if (!(store instanceof TokenStore)) throw new TypeError("issueToken requires a TokenStore");
  return store.issue(options);
}

export async function revokeToken(store, idOrToken) {
  if (!(store instanceof TokenStore)) throw new TypeError("revokeToken requires a TokenStore");
  return store.revoke(idOrToken);
}

export function listTokens(store, options) {
  if (!(store instanceof TokenStore)) throw new TypeError("listTokens requires a TokenStore");
  return store.list(options);
}

export async function verifyToken(store, token, options) {
  if (!(store instanceof TokenStore)) throw new TypeError("verifyToken requires a TokenStore");
  return store.verify(token, options);
}
