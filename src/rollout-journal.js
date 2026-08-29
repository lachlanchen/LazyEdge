import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { SecurityError } from "./security.js";

export const EDGE_ROLLOUT_JOURNAL_SCHEMA = "lazyedge/edge-rollout-journal/v1";
export const EDGE_ROLLOUT_RECEIPT_SCHEMA = "lazyedge/edge-rollout-receipt/v1";
export const EDGE_ROLLOUT_LEASE_SCHEMA = "lazyedge/edge-rollout-lease/v1";
export const EDGE_ROLLOUT_JOURNAL_VERSION = 1;

export const EDGE_ROLLOUT_ACTIVATION_PHASES = Object.freeze([
  "prepared",
  "fenced",
  "predecessor-quiesced",
  "predecessor-stopped",
  "candidate-started-guarded",
  "candidate-routed-guarded",
  "candidate-quiesced",
  "candidate-opened",
  "accepted",
]);

export const EDGE_ROLLOUT_ROLLBACK_PHASES = Object.freeze([
  "started",
  "fenced",
  "service-reconciled",
  "admission-recovered",
  "baseline-active",
  "baseline-routed",
  "accepted",
]);

export const EDGE_ROLLOUT_TERMINAL_OUTCOMES = Object.freeze([
  "committed",
  "rolled-back",
  "failed",
]);

const STATE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAXIMUM_RECORD_BYTES = 16 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u;
const OWNER_ID_PATTERN = /^[a-f0-9]{32}$/u;
const PROCESS_START_TICKS_PATTERN = /^[1-9][0-9]{0,31}$/u;
const SAFE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u;
const STATE_KEYS = Object.freeze([
  "activationPhase",
  "operationId",
  "planDigest",
  "rollbackPhase",
  "schema",
  "sequence",
  "terminalReceipt",
  "updatedAt",
  "version",
]);
const RECEIPT_KEYS = Object.freeze([
  "createdAt",
  "operationId",
  "outcome",
  "planDigest",
  "schema",
  "sequence",
  "version",
]);
const LEASE_KEYS = Object.freeze([
  "acquiredAt",
  "ownerId",
  "pid",
  "processStartTicks",
  "schema",
  "version",
]);
const JOURNAL_CONSTRUCTOR_TOKEN = Symbol("EdgeRolloutJournal");

function fail(message, code = "INVALID_ROLLOUT_JOURNAL") {
  throw new SecurityError(message, { code });
}

function effectiveIdentity() {
  const uid = process.geteuid?.() ?? process.getuid?.();
  const gid = process.getegid?.() ?? process.getgid?.();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    fail("effective Unix identity is unavailable", "ROLLOUT_JOURNAL_UNSUPPORTED");
  }
  return Object.freeze({ uid, gid });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value, required, optional, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) fail(`${label} has a non-string field`);
  const allowed = [...required, ...optional];
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || actual.some((key) => !allowed.includes(key))
  ) {
    fail(`${label} fields changed`);
  }
  const descriptors = new Map();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      fail(`${label}.${key} must be an enumerable data property`);
    }
    descriptors.set(key, descriptor);
  }
  const result = Object.create(null);
  for (const [key, descriptor] of descriptors) result[key] = descriptor.value;
  return Object.freeze(result);
}

function exactKeys(value, expected, label) {
  return exactDataObject(value, expected, [], label);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") fail(`${label} must be a canonical UTC timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) fail("clock returned an invalid timestamp");
  return date.toISOString();
}

function planDigest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("planDigest must be a lowercase SHA-256 digest");
  }
  return value;
}

function operationId(value) {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    fail("operationId must be a portable 16-128 character identifier");
  }
  return value;
}

function canonicalStatePath(value) {
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
    || !SAFE_PATH_PATTERN.test(value)
  ) {
    fail("statePath must be a canonical absolute path");
  }
  const components = value.slice(1).split("/");
  if (components.some((component) => (
    component.length < 1
    || component.length > 255
    || component === "."
    || component === ".."
  ))) {
    fail("statePath must be a canonical absolute path");
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateReceipt(value, state) {
  const source = exactKeys(value, RECEIPT_KEYS, "terminal receipt");
  if (
    source.schema !== EDGE_ROLLOUT_RECEIPT_SCHEMA
    || source.version !== EDGE_ROLLOUT_JOURNAL_VERSION
    || !EDGE_ROLLOUT_TERMINAL_OUTCOMES.includes(source.outcome)
    || source.planDigest !== state.planDigest
    || source.operationId !== state.operationId
    || !Number.isSafeInteger(source.sequence)
    || source.sequence < 1
    || source.sequence !== state.sequence
    || canonicalTimestamp(source.createdAt, "terminal receipt createdAt") !== state.updatedAt
  ) {
    fail("terminal receipt authority is invalid");
  }
  if (
    source.outcome === "committed"
    && (state.activationPhase !== "accepted" || state.rollbackPhase !== null)
  ) {
    fail("committed receipt requires accepted activation");
  }
  if (source.outcome === "rolled-back" && state.rollbackPhase !== "accepted") {
    fail("rolled-back receipt requires accepted rollback");
  }
  return source;
}

function validateState(value) {
  const source = exactKeys(value, STATE_KEYS, "rollout journal");
  if (
    source.schema !== EDGE_ROLLOUT_JOURNAL_SCHEMA
    || source.version !== EDGE_ROLLOUT_JOURNAL_VERSION
    || !EDGE_ROLLOUT_ACTIVATION_PHASES.includes(source.activationPhase)
    || (
      source.rollbackPhase !== null
      && !EDGE_ROLLOUT_ROLLBACK_PHASES.includes(source.rollbackPhase)
    )
    || !Number.isSafeInteger(source.sequence)
    || source.sequence < 0
  ) {
    fail("rollout journal authority is invalid");
  }
  planDigest(source.planDigest);
  operationId(source.operationId);
  canonicalTimestamp(source.updatedAt, "rollout journal updatedAt");

  const activationIndex = EDGE_ROLLOUT_ACTIVATION_PHASES.indexOf(source.activationPhase);
  const rollbackIndex = source.rollbackPhase === null
    ? null
    : EDGE_ROLLOUT_ROLLBACK_PHASES.indexOf(source.rollbackPhase);
  const expectedSequence = activationIndex
    + (rollbackIndex === null ? 0 : rollbackIndex + 1)
    + (source.terminalReceipt === null ? 0 : 1);
  if (source.sequence !== expectedSequence) {
    fail("rollout journal phase history is unreachable");
  }

  if (source.terminalReceipt === null) return deepFreeze({ ...source });
  const receipt = validateReceipt(source.terminalReceipt, source);
  return deepFreeze({
    ...source,
    terminalReceipt: { ...receipt },
  });
}

function validateLeaseOwner(value) {
  let source;
  try {
    source = exactKeys(value, LEASE_KEYS, "rollout lease owner");
    if (
      source.schema !== EDGE_ROLLOUT_LEASE_SCHEMA
      || source.version !== EDGE_ROLLOUT_JOURNAL_VERSION
      || typeof source.ownerId !== "string"
      || !OWNER_ID_PATTERN.test(source.ownerId)
      || !Number.isSafeInteger(source.pid)
      || source.pid < 1
      || typeof source.processStartTicks !== "string"
      || !PROCESS_START_TICKS_PATTERN.test(source.processStartTicks)
    ) {
      return null;
    }
    canonicalTimestamp(source.acquiredAt, "lease acquiredAt");
  } catch {
    return null;
  }
  return deepFreeze({ ...source });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRecord(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function assertStableAncestorChain(directory, label, code) {
  const identity = effectiveIdentity();
  const trustedOwners = new Set([0, identity.uid]);
  const paths = [];
  for (let current = directory; ; current = path.posix.dirname(current)) {
    paths.push(current);
    if (current === "/") break;
  }
  paths.reverse();

  const entries = [];
  for (const pathname of paths) {
    let info;
    try {
      info = await lstat(pathname);
    } catch (error) {
      if (error.code === "ENOENT") fail(`${label} ancestor disappeared`, code);
      throw error;
    }
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || info.nlink < 2
      || !trustedOwners.has(info.uid)
    ) {
      fail(`${label} ancestor chain is not owned by root or the effective user`, code);
    }
    entries.push(info);
  }
  for (let index = 0; index < entries.length - 1; index += 1) {
    if (
      (entries[index].mode & 0o022) !== 0
      && (entries[index].mode & 0o1000) === 0
    ) {
      fail(`${label} has a writable non-sticky ancestor`, code);
    }
  }
}

async function assertPrivateDirectory(
  directory,
  label,
  code = "UNSAFE_ROLLOUT_JOURNAL_PARENT",
) {
  const identity = effectiveIdentity();
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label} does not exist`, code);
    throw error;
  }
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.uid !== identity.uid
    || info.gid !== identity.gid
    || info.nlink < 2
    || (info.mode & 0o7777) !== DIRECTORY_MODE
    || await realpath(directory) !== directory
  ) {
    fail(`${label} must be a canonical owner-private 0700 directory`,
      code);
  }
  await assertStableAncestorChain(directory, label, code);
  return info;
}

async function assertStateParent(statePath) {
  const pathname = canonicalStatePath(statePath);
  const directory = path.posix.dirname(pathname);
  await assertPrivateDirectory(directory, "rollout journal parent");
  return Object.freeze({ pathname, directory });
}

async function assertRecordMetadata(info, pathname, label) {
  const identity = effectiveIdentity();
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.uid !== identity.uid
    || info.gid !== identity.gid
    || info.nlink !== 1
    || (info.mode & 0o7777) !== STATE_MODE
    || info.size < 1
    || info.size > MAXIMUM_RECORD_BYTES
    || await realpath(pathname) !== pathname
  ) {
    fail(`${label} must be an owner-private 0600 regular file with one link`,
      "UNSAFE_ROLLOUT_JOURNAL_RECORD");
  }
}

async function readProtectedText(pathname, label) {
  let before;
  try {
    before = await lstat(pathname);
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw error;
  }
  await assertRecordMetadata(before, pathname, label);
  let handle;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!sameRecord(before, opened)) {
      fail(`${label} changed while opening`, "ROLLOUT_JOURNAL_RECORD_REPLACED");
    }
    const text = await handle.readFile("utf8");
    const after = await lstat(pathname);
    await assertRecordMetadata(after, pathname, label);
    if (!sameRecord(opened, after)) {
      fail(`${label} changed while reading`, "ROLLOUT_JOURNAL_RECORD_REPLACED");
    }
    return Object.freeze({ text, metadata: after });
  } catch (error) {
    if (error.code === "ELOOP") {
      fail(`${label} symlinks are forbidden`, "UNSAFE_ROLLOUT_JOURNAL_RECORD");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readState(statePath) {
  const { pathname } = await assertStateParent(statePath);
  let record;
  try {
    record = await readProtectedText(pathname, "rollout journal record");
  } catch (error) {
    if (error.code === "ENOENT") fail("rollout journal does not exist", "ROLLOUT_JOURNAL_MISSING");
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(record.text);
  } catch {
    fail("rollout journal JSON is invalid");
  }
  return validateState(parsed);
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(
  statePath,
  value,
  { createOnly = false, assertAuthority = async () => {} } = {},
) {
  if (typeof assertAuthority !== "function") {
    fail("state publication authority must be a function");
  }
  const state = validateState(value);
  const { pathname, directory } = await assertStateParent(statePath);
  const existing = await pathExists(pathname);
  if (existing !== null) {
    await assertRecordMetadata(existing, pathname, "rollout journal record");
    if (createOnly) fail("rollout journal already exists", "ROLLOUT_JOURNAL_EXISTS");
  } else if (!createOnly) {
    fail("rollout journal disappeared", "ROLLOUT_JOURNAL_MISSING");
  }

  const temporary = path.posix.join(
    directory,
    `.${path.posix.basename(pathname)}.pending-${process.pid}-${randomBytes(16).toString("hex")}`,
  );
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      STATE_MODE,
    );
    temporaryExists = true;
    await handle.chmod(STATE_MODE);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    const openedTemporaryInfo = await handle.stat();
    await assertRecordMetadata(
      openedTemporaryInfo,
      temporary,
      "temporary rollout journal record",
    );
    await handle.close();
    handle = undefined;
    const temporaryInfo = await lstat(temporary);
    await assertRecordMetadata(temporaryInfo, temporary, "temporary rollout journal record");
    if (!sameRecord(openedTemporaryInfo, temporaryInfo)) {
      fail(
        "temporary rollout journal record changed after writing",
        "ROLLOUT_JOURNAL_RECORD_REPLACED",
      );
    }
    await assertAuthority();
    if (createOnly) {
      try {
        await link(temporary, pathname);
      } catch (error) {
        if (error.code === "EEXIST") {
          fail("rollout journal appeared during creation", "ROLLOUT_JOURNAL_EXISTS");
        }
        throw error;
      }
      await fsyncDirectory(directory);
      await unlink(temporary);
      temporaryExists = false;
    } else {
      await rename(temporary, pathname);
      temporaryExists = false;
    }
    await fsyncDirectory(directory);
    return await readState(pathname);
  } finally {
    await handle?.close();
    if (temporaryExists) {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

async function readLinuxProcessStartTicks(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    fail("rollout lease pid is invalid");
  }
  if (process.platform !== "linux") {
    fail(
      "exact rollout lease process identity requires Linux procfs",
      "ROLLOUT_JOURNAL_UNSUPPORTED",
    );
  }
  let handle;
  try {
    handle = await open(
      `/proc/${pid}/stat`,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const source = await handle.readFile("utf8");
    const close = source.lastIndexOf(")");
    if (close < 2) {
      fail("rollout lease process identity is malformed", "ROLLOUT_LEASE_IDENTITY_UNAVAILABLE");
    }
    const fields = source.slice(close + 2).trim().split(/\s+/u);
    const value = fields[19];
    if (typeof value !== "string" || !PROCESS_START_TICKS_PATTERN.test(value)) {
      fail("rollout lease process identity is malformed", "ROLLOUT_LEASE_IDENTITY_UNAVAILABLE");
    }
    return value;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    if (error instanceof SecurityError) throw error;
    fail("rollout lease process identity is unavailable", "ROLLOUT_LEASE_IDENTITY_UNAVAILABLE");
  } finally {
    await handle?.close();
  }
}

async function leaseOwner(clock) {
  const startTicks = await readLinuxProcessStartTicks(process.pid);
  if (startTicks === null) {
    fail("current rollout lease process disappeared", "ROLLOUT_LEASE_IDENTITY_UNAVAILABLE");
  }
  return deepFreeze({
    schema: EDGE_ROLLOUT_LEASE_SCHEMA,
    version: EDGE_ROLLOUT_JOURNAL_VERSION,
    ownerId: randomBytes(16).toString("hex"),
    pid: process.pid,
    processStartTicks: startTicks,
    acquiredAt: timestamp(clock),
  });
}

async function writeLeaseRecord(pathname, value) {
  let handle;
  let openedInfo;
  try {
    handle = await open(
      pathname,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      STATE_MODE,
    );
    await handle.chmod(STATE_MODE);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    openedInfo = await handle.stat();
    await assertRecordMetadata(openedInfo, pathname, "rollout lease record");
  } finally {
    await handle?.close();
  }
  const info = await lstat(pathname);
  await assertRecordMetadata(info, pathname, "rollout lease record");
  if (!sameRecord(openedInfo, info)) {
    fail("rollout lease record changed after writing", "ROLLOUT_JOURNAL_RECORD_REPLACED");
  }
  return info;
}

async function readLeaseOwner(leasePath) {
  const ownerPath = path.posix.join(leasePath, "owner.json");
  try {
    const record = await readProtectedText(ownerPath, "rollout lease owner record");
    let parsed;
    try {
      parsed = JSON.parse(record.text);
    } catch {
      return null;
    }
    return validateLeaseOwner(parsed);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectLease(leasePath) {
  try {
    await lstat(leasePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const metadata = await assertPrivateDirectory(
    leasePath,
    "rollout lease",
    "UNSAFE_ROLLOUT_LEASE",
  );
  if (metadata.nlink !== 2) {
    fail("rollout lease must not contain subdirectories", "UNSAFE_ROLLOUT_LEASE");
  }
  const entries = Object.freeze((await readdir(leasePath)).sort());
  return Object.freeze({ metadata, owner: await readLeaseOwner(leasePath), entries });
}

function sameOwner(left, right) {
  if (left === null || right === null) return left === right;
  return left.schema === right.schema
    && left.version === right.version
    && left.ownerId === right.ownerId
    && left.pid === right.pid
    && left.processStartTicks === right.processStartTicks
    && left.acquiredAt === right.acquiredAt;
}

function sameEntries(actual, expected) {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function isExactHeldLease(inspection) {
  return inspection.owner !== null && sameEntries(inspection.entries, ["owner.json"]);
}

async function removeOwnedFile(pathname, expectedMetadata) {
  try {
    const current = await lstat(pathname);
    if (!sameRecord(current, expectedMetadata)) return false;
    await unlink(pathname);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function quarantineStaleLease(leasePath, inspection, verifyOwnerDead, clock) {
  if (!isExactHeldLease(inspection)) {
    if (inspection.entries.includes("reaper.json")) {
      fail("rollout lease reclamation is already in progress", "ROLLOUT_LEASE_HELD");
    }
    fail("rollout lease owner authority is incomplete", "UNSAFE_ROLLOUT_LEASE");
  }
  const observedProcessStartTicks = await readLinuxProcessStartTicks(inspection.owner.pid);
  if (observedProcessStartTicks === inspection.owner.processStartTicks) {
    fail("rollout lease is held by the recorded process instance", "ROLLOUT_LEASE_HELD");
  }
  if (typeof verifyOwnerDead !== "function") {
    fail("rollout lease is held", "ROLLOUT_LEASE_HELD");
  }
  const verified = await verifyOwnerDead(
    inspection.owner,
    deepFreeze({
      kind: "rollout-lease",
      leasePath,
      observedProcessStartTicks,
    }),
  );
  if (verified !== true) fail("rollout lease owner is not verified dead", "ROLLOUT_LEASE_HELD");

  const beforeReaper = await inspectLease(leasePath);
  if (
    beforeReaper === null
    || !sameFile(inspection.metadata, beforeReaper.metadata)
    || !sameOwner(inspection.owner, beforeReaper.owner)
    || !isExactHeldLease(beforeReaper)
  ) return false;

  const reaperPath = path.posix.join(leasePath, "reaper.json");
  let reaperMetadata;
  let reaperOwner;
  let moved = false;
  try {
    try {
      reaperOwner = await leaseOwner(clock);
      reaperMetadata = await writeLeaseRecord(reaperPath, reaperOwner);
      await fsyncDirectory(leasePath);
    } catch (error) {
      if (["EEXIST", "ENOENT"].includes(error.code)) {
        fail("rollout lease reclamation is already in progress", "ROLLOUT_LEASE_HELD");
      }
      throw error;
    }

    const currentMetadata = await lstat(leasePath);
    if (!sameFile(inspection.metadata, currentMetadata)) return false;
    const current = await inspectLease(leasePath);
    if (
      current === null
      || !sameFile(inspection.metadata, current.metadata)
      || !sameOwner(inspection.owner, current.owner)
      || !sameEntries(current.entries, ["owner.json", "reaper.json"])
    ) {
      fail("rollout lease contains an unexpected entry", "UNSAFE_ROLLOUT_LEASE");
    }

    const tombstone = `${leasePath}.reaped.${reaperOwner.ownerId}`;
    try {
      await rename(leasePath, tombstone);
    } catch (error) {
      if (["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error.code)) return false;
      throw error;
    }
    moved = true;
    const movedMetadata = await assertPrivateDirectory(
      tombstone,
      "quarantined rollout lease",
      "UNSAFE_ROLLOUT_LEASE",
    );
    if (!sameFile(inspection.metadata, movedMetadata)) {
      fail("rollout lease changed during quarantine", "ROLLOUT_LEASE_REPLACED");
    }
    await fsyncDirectory(path.posix.dirname(leasePath));
    await unlink(path.posix.join(tombstone, "owner.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(path.posix.join(tombstone, "reaper.json"));
    await rmdir(tombstone);
    await fsyncDirectory(path.posix.dirname(leasePath));
    return true;
  } finally {
    if (!moved && reaperMetadata !== undefined) {
      await removeOwnedFile(reaperPath, reaperMetadata);
      await fsyncDirectory(leasePath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

class RolloutLease {
  #leasePath;
  #metadata;
  #owner;
  #released = false;

  constructor(leasePath, metadata, owner) {
    this.#leasePath = leasePath;
    this.#metadata = metadata;
    this.#owner = owner;
  }

  async assertOwned() {
    if (this.#released) fail("rollout lease has been released", "ROLLOUT_LEASE_NOT_HELD");
    const current = await inspectLease(this.#leasePath);
    if (
      current === null
      || !sameFile(current.metadata, this.#metadata)
      || !sameOwner(current.owner, this.#owner)
      || !isExactHeldLease(current)
    ) {
      fail("rollout lease ownership changed", "ROLLOUT_LEASE_NOT_HELD");
    }
  }

  async release() {
    if (this.#released) return;
    this.#released = true;
    try {
      const current = await inspectLease(this.#leasePath);
      if (
        current === null
        || !sameFile(current.metadata, this.#metadata)
        || !sameOwner(current.owner, this.#owner)
        || !isExactHeldLease(current)
      ) return;
      await unlink(path.posix.join(this.#leasePath, "owner.json"));
      await rmdir(this.#leasePath);
      await fsyncDirectory(path.posix.dirname(this.#leasePath));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    }
  }
}

async function acquireLease(statePath, { verifyOwnerDead, clock }) {
  const { pathname, directory } = await assertStateParent(statePath);
  const leasePath = `${pathname}.lease`;
  const owner = await leaseOwner(clock);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await mkdir(leasePath, { mode: DIRECTORY_MODE });
      await chmod(leasePath, DIRECTORY_MODE);
      const metadata = await assertPrivateDirectory(
        leasePath,
        "rollout lease",
        "UNSAFE_ROLLOUT_LEASE",
      );
      let ownerMetadata;
      try {
        ownerMetadata = await writeLeaseRecord(path.posix.join(leasePath, "owner.json"), owner);
        await fsyncDirectory(leasePath);
        await fsyncDirectory(directory);
        const current = await inspectLease(leasePath);
        if (
          current === null
          || !sameFile(current.metadata, metadata)
          || !sameOwner(current.owner, owner)
          || !isExactHeldLease(current)
        ) {
          fail("rollout lease changed during acquisition", "ROLLOUT_LEASE_REPLACED");
        }
        return new RolloutLease(leasePath, metadata, owner);
      } catch (error) {
        if (ownerMetadata !== undefined) {
          await removeOwnedFile(path.posix.join(leasePath, "owner.json"), ownerMetadata);
        }
        const currentDirectory = await pathExists(leasePath);
        if (currentDirectory !== null && sameFile(currentDirectory, metadata)) {
          await rmdir(leasePath).catch(() => {});
        }
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const inspection = await inspectLease(leasePath);
    if (inspection === null) continue;
    if (await quarantineStaleLease(leasePath, inspection, verifyOwnerDead, clock)) continue;
  }
  fail("rollout lease changed too often during acquisition", "ROLLOUT_LEASE_HELD");
}

function assertBinding(state, expectedPlanDigest, expectedOperationId) {
  if (state.planDigest !== expectedPlanDigest || state.operationId !== expectedOperationId) {
    fail("rollout journal does not match the requested authority", "ROLLOUT_JOURNAL_MISMATCH");
  }
}

function assertMutable(state) {
  if (state.terminalReceipt !== null) {
    fail("terminal rollout journal is immutable", "ROLLOUT_JOURNAL_TERMINAL");
  }
}

function assertSequence(state, expectedSequence) {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
    fail("expectedSequence must be a non-negative safe integer");
  }
  if (state.sequence !== expectedSequence) {
    fail("rollout journal sequence CAS mismatch", "ROLLOUT_JOURNAL_CAS_MISMATCH");
  }
}

function nextTimestamp(clock) {
  return timestamp(clock);
}

class EdgeRolloutJournal {
  #clock;
  #lease;
  #operationId;
  #planDigest;
  #statePath;
  #mutating = false;

  constructor(
    { statePath, planDigest: expectedPlanDigest, operationId: expectedOperationId, lease, clock },
    token,
  ) {
    if (token !== JOURNAL_CONSTRUCTOR_TOKEN) {
      fail("rollout journal handles must be opened by the journal API",
        "ROLLOUT_LEASE_NOT_HELD");
    }
    this.#statePath = statePath;
    this.#planDigest = expectedPlanDigest;
    this.#operationId = expectedOperationId;
    this.#lease = lease;
    this.#clock = clock;
    Object.freeze(this);
  }

  async #readOwned() {
    await this.#lease.assertOwned();
    const state = await readState(this.#statePath);
    assertBinding(state, this.#planDigest, this.#operationId);
    return state;
  }

  async #publish(state) {
    await this.#lease.assertOwned();
    const published = await writeState(this.#statePath, state, {
      assertAuthority: () => this.#lease.assertOwned(),
    });
    await this.#lease.assertOwned();
    return published;
  }

  async #withMutation(action) {
    if (this.#mutating) {
      fail("another journal mutation is already in progress", "ROLLOUT_JOURNAL_CAS_MISMATCH");
    }
    this.#mutating = true;
    try {
      return await action();
    } finally {
      this.#mutating = false;
    }
  }

  async inspect() {
    return this.#readOwned();
  }

  async advanceActivation(options = {}) {
    return this.#withMutation(() => this.#advanceActivation(options));
  }

  async #advanceActivation(options) {
    const {
      expectedSequence,
      expectedPhase,
      nextPhase,
    } = exactDataObject(
      options,
      ["expectedSequence", "expectedPhase", "nextPhase"],
      [],
      "activation transition options",
    );
    const state = await this.#readOwned();
    assertMutable(state);
    assertSequence(state, expectedSequence);
    if (state.rollbackPhase !== null) {
      fail("activation cannot advance after rollback begins", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    if (state.activationPhase !== expectedPhase) {
      fail("activation phase CAS mismatch", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    const expectedIndex = EDGE_ROLLOUT_ACTIVATION_PHASES.indexOf(expectedPhase);
    const nextIndex = EDGE_ROLLOUT_ACTIVATION_PHASES.indexOf(nextPhase);
    if (expectedIndex < 0 || nextIndex !== expectedIndex + 1) {
      fail("activation transition must be strictly adjacent", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    return this.#publish({
      ...state,
      activationPhase: nextPhase,
      sequence: state.sequence + 1,
      updatedAt: nextTimestamp(this.#clock),
    });
  }

  async beginRollback(options = {}) {
    return this.#withMutation(() => this.#beginRollback(options));
  }

  async #beginRollback(options) {
    const {
      expectedSequence,
      expectedActivationPhase,
    } = exactDataObject(
      options,
      ["expectedSequence", "expectedActivationPhase"],
      [],
      "begin rollback options",
    );
    const state = await this.#readOwned();
    assertMutable(state);
    assertSequence(state, expectedSequence);
    if (state.rollbackPhase !== null) {
      fail("rollback has already begun", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    if (state.activationPhase !== expectedActivationPhase) {
      fail("rollback activation phase CAS mismatch", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    return this.#publish({
      ...state,
      rollbackPhase: EDGE_ROLLOUT_ROLLBACK_PHASES[0],
      sequence: state.sequence + 1,
      updatedAt: nextTimestamp(this.#clock),
    });
  }

  async advanceRollback(options = {}) {
    return this.#withMutation(() => this.#advanceRollback(options));
  }

  async #advanceRollback(options) {
    const {
      expectedSequence,
      expectedPhase,
      nextPhase,
    } = exactDataObject(
      options,
      ["expectedSequence", "expectedPhase", "nextPhase"],
      [],
      "rollback transition options",
    );
    const state = await this.#readOwned();
    assertMutable(state);
    assertSequence(state, expectedSequence);
    if (state.rollbackPhase !== expectedPhase) {
      fail("rollback phase CAS mismatch", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    const expectedIndex = EDGE_ROLLOUT_ROLLBACK_PHASES.indexOf(expectedPhase);
    const nextIndex = EDGE_ROLLOUT_ROLLBACK_PHASES.indexOf(nextPhase);
    if (expectedIndex < 0 || nextIndex !== expectedIndex + 1) {
      fail("rollback transition must be strictly adjacent", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    return this.#publish({
      ...state,
      rollbackPhase: nextPhase,
      sequence: state.sequence + 1,
      updatedAt: nextTimestamp(this.#clock),
    });
  }

  async finalize(options = {}) {
    return this.#withMutation(() => this.#finalize(options));
  }

  async #finalize(options) {
    const { expectedSequence, outcome } = exactDataObject(
      options,
      ["expectedSequence", "outcome"],
      [],
      "finalize options",
    );
    const state = await this.#readOwned();
    assertMutable(state);
    assertSequence(state, expectedSequence);
    if (!EDGE_ROLLOUT_TERMINAL_OUTCOMES.includes(outcome)) {
      fail("terminal outcome is invalid");
    }
    if (outcome === "committed" && (
      state.activationPhase !== "accepted" || state.rollbackPhase !== null
    )) {
      fail("commit requires accepted activation", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    if (outcome === "rolled-back" && state.rollbackPhase !== "accepted") {
      fail("rolled-back requires accepted rollback", "ROLLOUT_JOURNAL_PHASE_MISMATCH");
    }
    const createdAt = nextTimestamp(this.#clock);
    const sequence = state.sequence + 1;
    return this.#publish({
      ...state,
      sequence,
      updatedAt: createdAt,
      terminalReceipt: {
        schema: EDGE_ROLLOUT_RECEIPT_SCHEMA,
        version: EDGE_ROLLOUT_JOURNAL_VERSION,
        planDigest: state.planDigest,
        operationId: state.operationId,
        outcome,
        sequence,
        createdAt,
      },
    });
  }

  async release() {
    if (this.#mutating) {
      fail("journal mutation is still in progress", "ROLLOUT_JOURNAL_CAS_MISMATCH");
    }
    await this.#lease.release();
  }
}

function normalizeOpenOptions(options) {
  const source = exactDataObject(
    options,
    ["statePath", "planDigest", "operationId"],
    ["clock", "verifyOwnerDead"],
    "rollout journal options",
  );
  const statePath = canonicalStatePath(source.statePath);
  const expectedPlanDigest = planDigest(source.planDigest);
  const expectedOperationId = operationId(source.operationId);
  const clock = source.clock ?? (() => new Date());
  if (typeof clock !== "function") fail("clock must be a function");
  if (source.verifyOwnerDead !== undefined && typeof source.verifyOwnerDead !== "function") {
    fail("verifyOwnerDead must be a function");
  }
  return Object.freeze({
    statePath,
    planDigest: expectedPlanDigest,
    operationId: expectedOperationId,
    clock,
    verifyOwnerDead: source.verifyOwnerDead,
  });
}

export async function createRolloutJournal(options) {
  const normalized = normalizeOpenOptions(options);
  const lease = await acquireLease(normalized.statePath, normalized);
  try {
    const initial = await writeState(normalized.statePath, {
      schema: EDGE_ROLLOUT_JOURNAL_SCHEMA,
      version: EDGE_ROLLOUT_JOURNAL_VERSION,
      planDigest: normalized.planDigest,
      operationId: normalized.operationId,
      activationPhase: EDGE_ROLLOUT_ACTIVATION_PHASES[0],
      rollbackPhase: null,
      sequence: 0,
      terminalReceipt: null,
      updatedAt: timestamp(normalized.clock),
    }, {
      createOnly: true,
      assertAuthority: () => lease.assertOwned(),
    });
    assertBinding(initial, normalized.planDigest, normalized.operationId);
    return new EdgeRolloutJournal({ ...normalized, lease }, JOURNAL_CONSTRUCTOR_TOKEN);
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export async function openRolloutJournal(options) {
  const normalized = normalizeOpenOptions(options);
  const lease = await acquireLease(normalized.statePath, normalized);
  try {
    const state = await readState(normalized.statePath);
    assertBinding(state, normalized.planDigest, normalized.operationId);
    return new EdgeRolloutJournal({ ...normalized, lease }, JOURNAL_CONSTRUCTOR_TOKEN);
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export async function inspectRolloutJournal(options = {}) {
  const {
    statePath,
    planDigest: expectedDigest,
    operationId: expectedOperation,
  } = exactDataObject(
    options,
    ["statePath"],
    ["planDigest", "operationId"],
    "rollout journal inspection options",
  );
  const pathname = canonicalStatePath(statePath);
  const state = await readState(pathname);
  if (expectedDigest !== undefined && state.planDigest !== planDigest(expectedDigest)) {
    fail("rollout journal plan digest mismatch", "ROLLOUT_JOURNAL_MISMATCH");
  }
  if (expectedOperation !== undefined && state.operationId !== operationId(expectedOperation)) {
    fail("rollout journal operation ID mismatch", "ROLLOUT_JOURNAL_MISMATCH");
  }
  return state;
}
