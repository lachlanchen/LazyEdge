import {
  createHmac,
  randomBytes,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { constantTimeEqual, SecurityError } from "./security.js";

const STORE_VERSION = 1;
const LOCK_VERSION = 1;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CSRF_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_STORE_BYTES = 128 * 1024;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MIN_MS = 8;
const LOCK_RETRY_SPREAD_MS = 24;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;
const STORE_REFRESH_INTERVAL_MS = 100;
const LOCK_REAP_FILE = ".reap";

export const REMEMBER_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const REMEMBER_SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;

function fail(message, code = "INVALID_CHAT_SESSION_STORE") {
  return new SecurityError(message, { code });
}

function exactObject(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function safeTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fail(`Chat session store ${label} is invalid`);
  }
  return value;
}

function normalizeRecord(value) {
  const keys = new Set(["digest", "csrfDigest", "createdAt", "lastSeen"]);
  if (!exactObject(value, keys)) {
    throw fail("Chat session store contains an invalid session record");
  }
  if (!DIGEST_PATTERN.test(value.digest)) {
    throw fail("Chat session store contains an invalid session digest");
  }
  if (!CSRF_DIGEST_PATTERN.test(value.csrfDigest)) {
    throw fail("Chat session store contains an invalid CSRF digest");
  }
  const createdAt = safeTimestamp(value.createdAt, "createdAt");
  const lastSeen = safeTimestamp(value.lastSeen, "lastSeen");
  if (lastSeen < createdAt) {
    throw fail("Chat session store timestamps are inconsistent");
  }
  return {
    digest: value.digest,
    csrfDigest: value.csrfDigest,
    createdAt,
    lastSeen,
  };
}

function canonicalPayload(generation, revision, records) {
  return {
    version: STORE_VERSION,
    generation,
    revision,
    sessions: [...records.values()]
      .map((record) => ({ ...record }))
      .sort((left, right) => left.digest.localeCompare(right.digest)),
  };
}

function serializePayload(payload, mac) {
  return `${JSON.stringify({ ...payload, mac }, null, 2)}\n`;
}

function hmac(key, label, value = "") {
  return createHmac("sha256", key)
    .update(label, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest();
}

function deriveKeys(secret, passwordHash) {
  const secretBuffer = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret ?? "");
  if (secretBuffer.length < 32 || secretBuffer.length > 4096) {
    throw new TypeError("Remember-session secret must contain 32–4096 bytes");
  }
  if (
    typeof passwordHash !== "string"
    || passwordHash.length < 32
    || passwordHash.length > 1024
    || /[\r\n\0]/u.test(passwordHash)
  ) {
    throw new TypeError("Remember-session password binding is invalid");
  }
  const root = hmac(secretBuffer, "lazyedge-chat-remember-v1", passwordHash);
  return Object.freeze({
    token: hmac(root, "token-digest-key"),
    store: hmac(root, "store-authentication-key"),
    generation: hmac(root, "generation").toString("base64url"),
  });
}

function tokenDigest(key, token) {
  return hmac(key, "session-token", token).toString("base64url");
}

function storeMac(key, payload) {
  return hmac(key, "session-store", JSON.stringify(payload)).toString("base64url");
}

function storePath(value) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\0")
    || path.normalize(value) !== value
    || value === "/"
  ) {
    throw new TypeError("Remember-session store path must be a normalized absolute file path");
  }
  return value;
}

function ownedByCurrentUser(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

function validatePrivateDirectory(metadata, label) {
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || !ownedByCurrentUser(metadata)
  ) {
    throw fail(`${label} must be an owner-only directory`, "INSECURE_CHAT_SESSION_STORE");
  }
}

function validatePrivateFile(metadata, label) {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || !ownedByCurrentUser(metadata)
  ) {
    throw fail(`${label} must be an owner-only regular file`, "INSECURE_CHAT_SESSION_STORE");
  }
  if (metadata.size < 1 || metadata.size > MAX_STORE_BYTES) {
    throw fail(`${label} has an unsafe size`, "INSECURE_CHAT_SESSION_STORE");
  }
}

async function validateParent(filePath) {
  const parent = path.dirname(filePath);
  let metadata;
  try {
    metadata = await lstat(parent);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw fail("Chat session store parent does not exist", "INSECURE_CHAT_SESSION_STORE");
    }
    throw error;
  }
  validatePrivateDirectory(metadata, "Chat session store parent");
  if (await realpath(parent) !== parent) {
    throw fail("Chat session store parent may not traverse a symlink", "INSECURE_CHAT_SESSION_STORE");
  }
  return parent;
}

function parseStore(contents, keys) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw fail("Chat session store is not valid JSON");
  }
  const expected = new Set(["version", "generation", "revision", "sessions", "mac"]);
  if (
    !exactObject(value, expected)
    || value.version !== STORE_VERSION
    || !DIGEST_PATTERN.test(value.generation)
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.sessions)
    || value.sessions.length > 64
    || !DIGEST_PATTERN.test(value.mac)
  ) {
    throw fail("Chat session store format is invalid");
  }
  if (value.generation !== keys.generation) {
    return { generationMatches: false, revision: value.revision, records: new Map() };
  }
  const records = new Map();
  for (const candidate of value.sessions) {
    const record = normalizeRecord(candidate);
    if (records.has(record.digest)) {
      throw fail("Chat session store contains duplicate session digests");
    }
    records.set(record.digest, record);
  }
  const payload = canonicalPayload(value.generation, value.revision, records);
  const expectedMac = storeMac(keys.store, payload);
  if (!constantTimeEqual(expectedMac, value.mac)) {
    throw fail("Chat session store authentication failed");
  }
  return { generationMatches: true, revision: value.revision, records };
}

function fingerprint(metadata) {
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

async function inspectFingerprint(filePath) {
  try {
    const metadata = await lstat(filePath);
    validatePrivateFile(metadata, "Chat session store");
    return fingerprint(metadata);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readSnapshot(filePath, keys) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    validatePrivateFile(metadata, "Chat session store");
    return {
      ...parseStore(await handle.readFile("utf8"), keys),
      fingerprint: fingerprint(metadata),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        generationMatches: true,
        revision: 0,
        records: new Map(),
        fingerprint: null,
      };
    }
    if (error.code === "ELOOP") {
      throw fail("Chat session store symlinks are forbidden", "INSECURE_CHAT_SESSION_STORE");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeSnapshot(filePath, keys, revision, records) {
  const parent = await validateParent(filePath);
  try {
    const existing = await lstat(filePath);
    validatePrivateFile(existing, "Chat session store");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const payload = canonicalPayload(keys.generation, revision, records);
  const contents = serializePayload(payload, storeMac(keys.store, payload));
  if (Buffer.byteLength(contents) > MAX_STORE_BYTES) {
    throw fail("Chat session store exceeded its size limit");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  let renamed = false;
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
    await rename(temporary, filePath);
    renamed = true;
    await fsyncDirectory(parent);
    return await inspectFingerprint(filePath);
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function processIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/u);
    return fields[19] ? `linux-start-ticks:${fields[19]}` : null;
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
}

function lockOwner(value) {
  const keys = new Set(["version", "ownerId", "pid", "hostname", "processIdentity"]);
  if (
    !exactObject(value, keys)
    || value.version !== LOCK_VERSION
    || typeof value.ownerId !== "string"
    || !/^[a-f0-9]{32}$/u.test(value.ownerId)
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.hostname !== "string"
    || value.hostname.length < 1
    || value.hostname.length > 255
    || (value.processIdentity !== null && typeof value.processIdentity !== "string")
  ) return null;
  return value;
}

async function readLockOwner(lockPath) {
  let handle;
  try {
    handle = await open(
      path.join(lockPath, "owner.json"),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    validatePrivateFile(metadata, "Chat session store lock owner");
    return lockOwner(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    if (error.code === "ELOOP") {
      throw fail("Chat session store lock symlinks are forbidden", "INSECURE_CHAT_SESSION_STORE");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readReapOwner(reapPath) {
  let handle;
  try {
    handle = await open(reapPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || (metadata.mode & 0o077) !== 0
      || !ownedByCurrentUser(metadata)
      || metadata.size > MAX_STORE_BYTES
    ) {
      throw fail(
        "Chat session store reaper owner must be an owner-only regular file",
        "INSECURE_CHAT_SESSION_STORE",
      );
    }
    // Another reaper can observe the O_EXCL marker between creation and the
    // owner's first write. Treat that bounded state as a live unknown owner;
    // its fresh mtime prevents quarantine until acquisition completes.
    if (metadata.size === 0) return { metadata, owner: null };
    let owner = null;
    try {
      owner = lockOwner(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { metadata, owner };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      throw fail("Chat session store reaper symlinks are forbidden", "INSECURE_CHAT_SESSION_STORE");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function lockOwnerAlive(owner) {
  if (owner === null || owner.hostname !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
  if (owner.processIdentity === null) return true;
  const identity = await processIdentity(owner.pid);
  return identity === null || identity === owner.processIdentity;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectLock(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    validatePrivateDirectory(metadata, "Chat session store lock");
    return { metadata, owner: await readLockOwner(lockPath) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function quarantineStaleLock(lockPath, inspection) {
  const current = await lstat(lockPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current === null || !sameFile(current, inspection.metadata)) return false;
  const currentOwner = await readLockOwner(lockPath);
  if (currentOwner?.ownerId !== inspection.owner?.ownerId) return false;
  const quarantine = `${lockPath}.stale.${inspection.metadata.dev}.${inspection.metadata.ino}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
  const moved = await lstat(quarantine);
  if (!sameFile(moved, inspection.metadata)) {
    throw fail("Chat session store lock changed during recovery");
  }
  // Retain the inode-derived quarantine directory. A delayed competing reaper
  // will receive EEXIST instead of moving a newly-created successor lock into
  // the old lock's destination. It contains ownership metadata, never session
  // tokens or application secrets, and may be inspected/removed during an
  // explicit maintenance window after the service is stopped.
  return true;
}

function ownerRecord(ownerId) {
  return processIdentity(process.pid).then((identity) => ({
    version: LOCK_VERSION,
    ownerId,
    pid: process.pid,
    hostname: hostname(),
    processIdentity: identity,
  }));
}

async function reapLock(lockPath, inspection) {
  const age = Date.now() - inspection.metadata.mtimeMs;
  const alive = await lockOwnerAlive(inspection.owner);
  if (alive === true || (alive === null && age < LOCK_STALE_MS)) return false;

  const reapPath = path.join(lockPath, LOCK_REAP_FILE);
  let reapHandle;
  let reapMetadata;
  let ownsMarker = false;
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
      await reapHandle.writeFile(
        `${JSON.stringify(await ownerRecord(randomBytes(16).toString("hex")))}\n`,
        "utf8",
      );
      await reapHandle.sync();
      reapMetadata = await reapHandle.stat();
      ownsMarker = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const marker = await readReapOwner(reapPath);
      if (marker === null) return false;
      const markerAge = Date.now() - marker.metadata.mtimeMs;
      const markerAlive = await lockOwnerAlive(marker.owner);
      if (markerAlive === true || (markerAlive === null && markerAge < LOCK_STALE_MS)) {
        return false;
      }
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
        const current = await lstat(reapPath);
        if (sameFile(current, reapMetadata)) await unlink(reapPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

function retryDelay() {
  return LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_SPREAD_MS);
}

async function acquireLock(filePath) {
  const parent = await validateParent(filePath);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const directoryMetadata = await lstat(lockPath);
      validatePrivateDirectory(directoryMetadata, "Chat session store lock");
      const ownerId = randomBytes(16).toString("hex");
      const owner = await ownerRecord(ownerId);
      let ownerHandle;
      try {
        ownerHandle = await open(
          path.join(lockPath, "owner.json"),
          fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await ownerHandle.sync();
        await ownerHandle.close();
        ownerHandle = undefined;
        await fsyncDirectory(parent);
        return async () => {
          try {
            const current = await lstat(lockPath);
            if (!sameFile(current, directoryMetadata)) return;
            if ((await readLockOwner(lockPath))?.ownerId !== ownerId) return;
            await unlink(path.join(lockPath, "owner.json"));
            await rmdir(lockPath);
            await fsyncDirectory(parent);
          } catch (error) {
            if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
          }
        };
      } catch (error) {
        await ownerHandle?.close();
        await unlink(path.join(lockPath, "owner.json")).catch(() => {});
        await rmdir(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const inspection = await inspectLock(lockPath);
    if (inspection !== null && await reapLock(lockPath, inspection)) continue;
    if (Date.now() >= deadline) throw fail("Timed out waiting for the chat session store lock");
    await new Promise((resolve) => setTimeout(resolve, retryDelay()));
  }
}

function recordExpired(record, now, idleMs, absoluteMs) {
  if (
    record.createdAt > now + MAX_CLOCK_SKEW_MS
    || record.lastSeen > now + MAX_CLOCK_SKEW_MS
  ) return true;
  const effectiveNow = Math.max(now, record.lastSeen);
  return effectiveNow - record.lastSeen > idleMs
    || effectiveNow - record.createdAt > absoluteMs;
}

function publicRecord(record) {
  return Object.freeze({ ...record });
}

export class ChatSessionStore {
  constructor({
    filePath,
    secret,
    passwordHash,
    clock = () => Date.now(),
    idleMs = REMEMBER_SESSION_IDLE_MS,
    absoluteMs = REMEMBER_SESSION_ABSOLUTE_MS,
    maxSessions = 4,
  } = {}) {
    this.filePath = storePath(filePath);
    this.keys = deriveKeys(secret, passwordHash);
    if (typeof clock !== "function") throw new TypeError("Chat session store clock must be a function");
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new TypeError("idleMs is invalid");
    if (!Number.isSafeInteger(absoluteMs) || absoluteMs < idleMs) {
      throw new TypeError("absoluteMs is invalid");
    }
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) {
      throw new TypeError("maxSessions is invalid");
    }
    this.clock = clock;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.maxSessions = maxSessions;
    this.queue = Promise.resolve();
    this.snapshot = {
      generationMatches: true,
      revision: 0,
      records: new Map(),
      fingerprint: null,
    };
    this.nextRefreshAt = 0;
  }

  static async open(options = {}) {
    const store = new ChatSessionStore(options);
    await validateParent(store.filePath);
    store.snapshot = await readSnapshot(store.filePath, store.keys);
    return store;
  }

  digest(token) {
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) return null;
    return tokenDigest(this.keys.token, token);
  }

  async create(csrfDigest) {
    if (typeof csrfDigest !== "string" || !CSRF_DIGEST_PATTERN.test(csrfDigest)) {
      throw new TypeError("Remembered session CSRF digest is invalid");
    }
    return this.#mutate(async (snapshot) => {
      if (!snapshot.generationMatches) {
        snapshot.records.clear();
        snapshot.generationMatches = true;
      }
      const now = this.#now();
      this.#prune(snapshot.records, now);
      let raw;
      let digest;
      do {
        raw = randomBytes(32).toString("base64url");
        digest = this.digest(raw);
      } while (snapshot.records.has(digest));
      const record = { digest, csrfDigest, createdAt: now, lastSeen: now };
      snapshot.records.set(digest, record);
      const evicted = [];
      while (snapshot.records.size > this.maxSessions) {
        const oldest = [...snapshot.records.values()].sort((left, right) => (
          left.createdAt - right.createdAt || left.digest.localeCompare(right.digest)
        ))[0];
        snapshot.records.delete(oldest.digest);
        evicted.push(oldest.digest);
      }
      return { value: Object.freeze({ raw, record: publicRecord(record), evicted }), changed: true };
    });
  }

  async verify(token, { touch = true } = {}) {
    const digest = this.digest(token);
    if (digest === null) return null;
    const peek = await this.#serialize(async () => {
      await this.#refreshIfDue();
      if (!this.snapshot.generationMatches || !this.snapshot.records.has(digest)) return null;
      // A cookie that matches a known keyed digest is rare and authorized
      // enough to justify one metadata refresh. Random syntactically valid
      // cookies never acquire a lock or create/remove filesystem entries.
      await this.#refreshIfDue({ force: true });
      return this.snapshot.records.get(digest) ?? null;
    });
    if (peek === null) return null;
    const now = this.#now();
    if (!recordExpired(peek, now, this.idleMs, this.absoluteMs)
      && (!touch || now <= peek.lastSeen || now - peek.lastSeen < TOUCH_INTERVAL_MS)) {
      return publicRecord(peek);
    }
    return this.#mutate(async (snapshot) => {
      if (!snapshot.generationMatches) return { value: null, changed: false };
      const currentNow = this.#now();
      const changedByPrune = this.#prune(snapshot.records, currentNow);
      const record = snapshot.records.get(digest);
      if (record === undefined) return { value: null, changed: changedByPrune };
      let changed = changedByPrune;
      if (
        touch
        && currentNow > record.lastSeen
        && currentNow - record.lastSeen >= TOUCH_INTERVAL_MS
      ) {
        record.lastSeen = currentNow;
        changed = true;
      }
      return { value: publicRecord(record), changed };
    });
  }

  async hasDigest(digest) {
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) return false;
    const peek = await this.#serialize(async () => {
      await this.#refreshIfDue({ force: true });
      return this.snapshot.generationMatches
        ? this.snapshot.records.get(digest) ?? null
        : null;
    });
    if (peek === null) return false;
    if (!recordExpired(peek, this.#now(), this.idleMs, this.absoluteMs)) return true;
    return this.#mutate(async (snapshot) => {
      if (!snapshot.generationMatches) return { value: false, changed: false };
      const changed = this.#prune(snapshot.records, this.#now());
      return { value: snapshot.records.has(digest), changed };
    });
  }

  async revokeDigest(digest) {
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) return false;
    return this.#mutate(async (snapshot) => {
      if (!snapshot.generationMatches) return { value: false, changed: false };
      const changed = snapshot.records.delete(digest);
      return { value: changed, changed };
    });
  }

  async listActive() {
    return this.#mutate(async (snapshot) => {
      if (!snapshot.generationMatches) return { value: [], changed: false };
      const changed = this.#prune(snapshot.records, this.#now());
      return {
        value: [...snapshot.records.values()]
          .sort((left, right) => left.createdAt - right.createdAt)
          .map(publicRecord),
        changed,
      };
    });
  }

  async rotate() {
    return this.#mutate(async (snapshot) => {
      const removed = snapshot.records.size;
      snapshot.records.clear();
      snapshot.generationMatches = true;
      return { value: removed, changed: true };
    });
  }

  #now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw fail("Chat session clock is invalid");
    return now;
  }

  #prune(records, now) {
    let changed = false;
    for (const [digest, record] of records) {
      if (recordExpired(record, now, this.idleMs, this.absoluteMs)) {
        records.delete(digest);
        changed = true;
      }
    }
    return changed;
  }

  async #serialize(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async #refreshIfDue({ force = false } = {}) {
    if (!force && Date.now() < this.nextRefreshAt) return;
    this.nextRefreshAt = Date.now() + STORE_REFRESH_INTERVAL_MS;
    try {
      const current = await inspectFingerprint(this.filePath);
      if (!sameFingerprint(current, this.snapshot.fingerprint)) {
        this.snapshot = await readSnapshot(this.filePath, this.keys);
      }
    } catch (error) {
      this.snapshot = {
        generationMatches: false,
        revision: 0,
        records: new Map(),
        fingerprint: null,
      };
      throw error;
    }
  }

  async #mutate(operation) {
    return this.#serialize(async () => {
      const release = await acquireLock(this.filePath);
      try {
        const snapshot = await readSnapshot(this.filePath, this.keys);
        this.snapshot = snapshot;
        const result = await operation(snapshot);
        if (result.changed) {
          if (!snapshot.generationMatches) {
            snapshot.records.clear();
            snapshot.generationMatches = true;
          }
          snapshot.revision += 1;
          snapshot.fingerprint = await writeSnapshot(
            this.filePath,
            this.keys,
            snapshot.revision,
            snapshot.records,
          );
          this.snapshot = snapshot;
        }
        this.nextRefreshAt = Date.now() + STORE_REFRESH_INTERVAL_MS;
        return result.value;
      } finally {
        await release();
      }
    });
  }
}
