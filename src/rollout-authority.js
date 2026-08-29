import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  constantTimeEqual,
  SecurityError,
  sha256,
} from "./security.js";

const STOP_PERMIT_SCHEMA_VERSION = 1;
const STOP_PERMIT_KIND = "lazyedge.stop-permit";
const STOP_AUTHORIZATION_KIND = "lazyedge.stop-authorization";
const MAX_PERMIT_LIFETIME_MS = 5 * 60 * 1000;
const MAX_STORE_RECORD_BYTES = 2048;
const STORE_DIRECTORY_MODE = 0o700;
const STORE_RECORD_MODE = 0o600;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const INVOCATION_ID_PATTERN = /^[a-f0-9]{32}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,126}\.service$/u;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,31}$/u;
const LISTENER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,255}$/u;
const CLAIM_FIELDS = Object.freeze([
  "planDigest",
  "operationId",
  "role",
  "unit",
  "invocationId",
  "pid",
  "procStartTicks",
  "unitDigest",
  "listenerSet",
  "admissionGeneration",
  "proofKind",
  "proofDigest",
]);
const PERMIT_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  ...CLAIM_FIELDS,
  "issuedAt",
  "expiresAt",
  "nonce",
]);
const STORE_RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "nonce",
  "permitDigest",
  "expiresAt",
]);
const ISSUE_OPTION_REQUIRED_FIELDS = Object.freeze([
  "claims",
  "issuedAt",
  "expiresAt",
  "store",
]);
const ISSUE_OPTION_OPTIONAL_FIELDS = Object.freeze([
  "nonce",
  "clock",
]);
const CONSUME_OPTION_REQUIRED_FIELDS = Object.freeze([
  "permit",
  "expected",
  "store",
]);
const CONSUME_OPTION_OPTIONAL_FIELDS = Object.freeze([
  "clock",
  "readProcessIdentity",
]);
const STORE_OPEN_OPTION_FIELDS = Object.freeze(["directory"]);
const FILE_STOP_PERMIT_STORE_CONSTRUCTOR_TOKEN = Symbol("FileStopPermitStore");

function authorityError(message, code) {
  return new SecurityError(message, { code });
}

function exactOptionEnvelope(
  value,
  label,
  requiredFields,
  optionalFields = [],
  code = "INVALID_STOP_PERMIT",
) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw authorityError(`${label} must be a plain object`, code);
  }
  const allowedFields = [...requiredFields, ...optionalFields];
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((field) => typeof field !== "string")
    || keys.some((field) => !allowedFields.includes(field))
    || requiredFields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw authorityError(`${label} fields are not exact`, code);
  }
  const normalized = Object.create(null);
  for (const field of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw authorityError(`${label}.${field} must be an enumerable data property`, code);
    }
    Object.defineProperty(normalized, field, {
      enumerable: true,
      value: descriptor.value,
    });
  }
  return Object.freeze(normalized);
}

function exactPlainObject(value, label, fields, code = "INVALID_STOP_PERMIT") {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw authorityError(`${label} must be a plain object`, code);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length
    || keys.some((field) => typeof field !== "string")
    || fields.some((field) => !Object.hasOwn(value, field))
    || keys.some((field) => !fields.includes(field))
  ) {
    throw authorityError(`${label} fields are not exact`, code);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw authorityError(`${label}.${field} must be an enumerable data property`,
        code);
    }
  }
  return value;
}

function exactString(value, label, pattern, code = "INVALID_STOP_PERMIT") {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw authorityError(`${label} is invalid`, code);
  }
  return value;
}

function exactTimestamp(value, label, code = "INVALID_STOP_PERMIT") {
  if (typeof value !== "string") {
    throw authorityError(`${label} must be a canonical ISO timestamp`, code);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw authorityError(`${label} must be a canonical ISO timestamp`, code);
  }
  return Object.freeze({ value, milliseconds });
}

function normalizeListenerSet(value, label = "listenerSet") {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > 64
    || Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw authorityError(`${label} must be an array with at most 64 entries`,
      "INVALID_STOP_PERMIT");
  }
  const listeners = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw authorityError(`${label}[${index}] must be an enumerable data property`,
        "INVALID_STOP_PERMIT");
    }
    return exactString(descriptor.value, `${label}[${index}]`, LISTENER_PATTERN);
  });
  const sorted = [...listeners].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  if (
    new Set(listeners).size !== listeners.length
    || listeners.some((listener, index) => listener !== sorted[index])
  ) {
    throw authorityError(`${label} must be sorted and contain no duplicates`,
      "INVALID_STOP_PERMIT");
  }
  return Object.freeze(listeners);
}

function exactNonce(value, label, code = "INVALID_STOP_PERMIT") {
  exactString(value, label, NONCE_PATTERN, code);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw authorityError(`${label} is not canonical`, code);
  }
  return value;
}

function normalizeClaims(value, label = "StopPermit claims") {
  const claims = exactPlainObject(value, label, CLAIM_FIELDS);
  if (!Number.isSafeInteger(claims.pid) || claims.pid < 1) {
    throw authorityError(`${label}.pid must be a positive safe integer`, "INVALID_STOP_PERMIT");
  }
  return Object.freeze({
    planDigest: exactString(
      claims.planDigest,
      `${label}.planDigest`,
      DIGEST_PATTERN,
    ),
    operationId: exactString(
      claims.operationId,
      `${label}.operationId`,
      OPERATION_ID_PATTERN,
    ),
    role: exactString(claims.role, `${label}.role`, ROLE_PATTERN),
    unit: exactString(claims.unit, `${label}.unit`, UNIT_PATTERN),
    invocationId: exactString(
      claims.invocationId,
      `${label}.invocationId`,
      INVOCATION_ID_PATTERN,
    ),
    pid: claims.pid,
    procStartTicks: exactString(
      claims.procStartTicks,
      `${label}.procStartTicks`,
      START_TICKS_PATTERN,
    ),
    unitDigest: exactString(claims.unitDigest, `${label}.unitDigest`, DIGEST_PATTERN),
    listenerSet: normalizeListenerSet(claims.listenerSet, `${label}.listenerSet`),
    admissionGeneration: exactString(
      claims.admissionGeneration,
      `${label}.admissionGeneration`,
      OPAQUE_ID_PATTERN,
    ),
    proofKind: exactString(claims.proofKind, `${label}.proofKind`, ROLE_PATTERN),
    proofDigest: exactString(claims.proofDigest, `${label}.proofDigest`, DIGEST_PATTERN),
  });
}

function normalizePermit(value) {
  const permit = exactPlainObject(value, "StopPermit", PERMIT_FIELDS);
  if (
    permit.schemaVersion !== STOP_PERMIT_SCHEMA_VERSION
    || permit.kind !== STOP_PERMIT_KIND
  ) {
    throw authorityError("StopPermit schema identity is invalid", "INVALID_STOP_PERMIT");
  }
  const claims = normalizeClaims(
    Object.fromEntries(CLAIM_FIELDS.map((field) => [field, permit[field]])),
  );
  const issuedAt = exactTimestamp(permit.issuedAt, "StopPermit.issuedAt");
  const expiresAt = exactTimestamp(permit.expiresAt, "StopPermit.expiresAt");
  if (
    expiresAt.milliseconds <= issuedAt.milliseconds
    || expiresAt.milliseconds - issuedAt.milliseconds > MAX_PERMIT_LIFETIME_MS
  ) {
    throw authorityError("StopPermit lifetime is invalid", "INVALID_STOP_PERMIT");
  }
  return Object.freeze({
    schemaVersion: STOP_PERMIT_SCHEMA_VERSION,
    kind: STOP_PERMIT_KIND,
    ...claims,
    issuedAt: issuedAt.value,
    expiresAt: expiresAt.value,
    nonce: exactNonce(permit.nonce, "StopPermit.nonce"),
  });
}

function canonicalPermitDigest(permit) {
  return sha256(`lazyedge-stop-permit-v1\u0000${JSON.stringify(permit)}`);
}

function storeRecord(permit) {
  return Object.freeze({
    schemaVersion: STOP_PERMIT_SCHEMA_VERSION,
    kind: STOP_PERMIT_KIND,
    nonce: permit.nonce,
    permitDigest: canonicalPermitDigest(permit),
    expiresAt: permit.expiresAt,
  });
}

function normalizeStoreRecord(value) {
  const errorCode = "INVALID_STOP_PERMIT_STORE";
  const record = exactPlainObject(
    value,
    "StopPermit store record",
    STORE_RECORD_FIELDS,
    errorCode,
  );
  if (
    record.schemaVersion !== STOP_PERMIT_SCHEMA_VERSION
    || record.kind !== STOP_PERMIT_KIND
  ) {
    throw authorityError("StopPermit store record schema is invalid", "INVALID_STOP_PERMIT_STORE");
  }
  return Object.freeze({
    schemaVersion: STOP_PERMIT_SCHEMA_VERSION,
    kind: STOP_PERMIT_KIND,
    nonce: exactNonce(record.nonce, "StopPermit store nonce", errorCode),
    permitDigest: exactString(
      record.permitDigest,
      "StopPermit store digest",
      DIGEST_PATTERN,
      errorCode,
    ),
    expiresAt: exactTimestamp(record.expiresAt, "StopPermit store expiry", errorCode).value,
  });
}

function requireStore(store) {
  if (
    store === null
    || typeof store !== "object"
    || typeof store.issue !== "function"
    || typeof store.consume !== "function"
  ) {
    throw new TypeError("StopPermit store must implement async issue(record) and consume(record)");
  }
  return store;
}

function nowMilliseconds(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("clock must return non-negative integer epoch milliseconds");
  }
  return now;
}

function assertPermitTime(permit, now) {
  const issuedAt = Date.parse(permit.issuedAt);
  const expiresAt = Date.parse(permit.expiresAt);
  if (issuedAt > now) {
    throw authorityError("StopPermit is not yet valid", "STOP_PERMIT_NOT_YET_VALID");
  }
  if (expiresAt <= now) {
    throw authorityError("StopPermit has expired", "STOP_PERMIT_EXPIRED");
  }
}

function sameClaims(left, right) {
  return CLAIM_FIELDS.every((field) => (
    field === "listenerSet"
      ? left.listenerSet.length === right.listenerSet.length
        && left.listenerSet.every((listener, index) => listener === right.listenerSet[index])
      : left[field] === right[field]
  ));
}

function normalizeProcessIdentity(value) {
  const identity = exactPlainObject(
    value,
    "process identity",
    ["pid", "procStartTicks"],
    "STOP_PERMIT_PROCESS_MISMATCH",
  );
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) {
    throw authorityError("process identity pid is invalid", "STOP_PERMIT_PROCESS_MISMATCH");
  }
  return Object.freeze({
    pid: identity.pid,
    procStartTicks: exactString(
      identity.procStartTicks,
      "process identity start ticks",
      START_TICKS_PATTERN,
      "STOP_PERMIT_PROCESS_MISMATCH",
    ),
  });
}

async function assertCurrentProcessIdentity(permit, readProcessIdentity) {
  const rawIdentity = await readProcessIdentity(permit.pid);
  if (rawIdentity === null) {
    throw authorityError("StopPermit process no longer exists", "STOP_PERMIT_PROCESS_MISMATCH");
  }
  let identity;
  try {
    identity = normalizeProcessIdentity(rawIdentity);
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw authorityError("StopPermit process identity is invalid", "STOP_PERMIT_PROCESS_MISMATCH");
  }
  if (identity.pid !== permit.pid || identity.procStartTicks !== permit.procStartTicks) {
    throw authorityError("StopPermit process identity changed", "STOP_PERMIT_PROCESS_MISMATCH");
  }
  return identity;
}

export async function readLinuxProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError("pid must be a positive safe integer");
  }
  if (process.platform !== "linux") {
    throw authorityError(
      "Exact StopPermit process identity requires Linux procfs",
      "STOP_PERMIT_PROCESS_UNAVAILABLE",
    );
  }
  let handle;
  try {
    handle = await open(
      `/proc/${pid}/stat`,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const statLine = await handle.readFile("utf8");
    const closeParenthesis = statLine.lastIndexOf(")");
    if (closeParenthesis < 2) throw new Error("missing process name terminator");
    const afterName = statLine.slice(closeParenthesis + 1).trim().split(/\s+/u);
    const procStartTicks = afterName[19];
    if (!START_TICKS_PATTERN.test(procStartTicks ?? "")) {
      throw new Error("missing canonical process start ticks");
    }
    return Object.freeze({ pid, procStartTicks });
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    if (error instanceof SecurityError) throw error;
    throw authorityError(
      `Cannot establish exact process identity for pid ${pid}`,
      "STOP_PERMIT_PROCESS_UNAVAILABLE",
    );
  } finally {
    await handle?.close();
  }
}

export async function issueStopPermit(rawOptions = {}) {
  const options = exactOptionEnvelope(
    rawOptions,
    "StopPermit issue options",
    ISSUE_OPTION_REQUIRED_FIELDS,
    ISSUE_OPTION_OPTIONAL_FIELDS,
  );
  const nonce = options.nonce === undefined
    ? randomBytes(32).toString("base64url")
    : options.nonce;
  const clock = options.clock === undefined ? () => Date.now() : options.clock;
  const permit = normalizePermit({
    schemaVersion: STOP_PERMIT_SCHEMA_VERSION,
    kind: STOP_PERMIT_KIND,
    ...normalizeClaims(options.claims),
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    nonce,
  });
  assertPermitTime(permit, nowMilliseconds(clock));
  const result = await requireStore(options.store).issue(storeRecord(permit));
  if (result !== true) {
    throw authorityError("StopPermit nonce has already been issued", "STOP_PERMIT_NONCE_REUSED");
  }
  assertPermitTime(permit, nowMilliseconds(clock));
  return permit;
}

export async function consumeStopPermit(rawOptions = {}) {
  const options = exactOptionEnvelope(
    rawOptions,
    "StopPermit consume options",
    CONSUME_OPTION_REQUIRED_FIELDS,
    CONSUME_OPTION_OPTIONAL_FIELDS,
  );
  const clock = options.clock === undefined ? () => Date.now() : options.clock;
  const readProcessIdentity = options.readProcessIdentity === undefined
    ? readLinuxProcessIdentity
    : options.readProcessIdentity;
  const permit = normalizePermit(options.permit);
  const expected = normalizeClaims(options.expected, "expected StopPermit claims");
  if (!sameClaims(permit, expected)) {
    throw authorityError("StopPermit does not match the requested stop", "STOP_PERMIT_MISMATCH");
  }
  assertPermitTime(permit, nowMilliseconds(clock));
  if (typeof readProcessIdentity !== "function") {
    throw new TypeError("readProcessIdentity must be a function");
  }
  await assertCurrentProcessIdentity(permit, readProcessIdentity);
  assertPermitTime(permit, nowMilliseconds(clock));
  const consumed = await requireStore(options.store).consume(storeRecord(permit));
  if (consumed !== true) {
    throw authorityError("StopPermit was already consumed or is unknown", "STOP_PERMIT_CONSUMED");
  }
  assertPermitTime(permit, nowMilliseconds(clock));
  await assertCurrentProcessIdentity(permit, readProcessIdentity);
  const verifiedAt = nowMilliseconds(clock);
  assertPermitTime(permit, verifiedAt);
  return Object.freeze({
    schemaVersion: STOP_PERMIT_SCHEMA_VERSION,
    kind: STOP_AUTHORIZATION_KIND,
    action: "stop",
    requiresImmediateProcessIdentityCoupling: true,
    requiresImmediateInvocationIdCoupling: true,
    planDigest: permit.planDigest,
    operationId: permit.operationId,
    role: permit.role,
    unit: permit.unit,
    invocationId: permit.invocationId,
    pid: permit.pid,
    procStartTicks: permit.procStartTicks,
    unitDigest: permit.unitDigest,
    listenerSet: permit.listenerSet,
    admissionGeneration: permit.admissionGeneration,
    proofKind: permit.proofKind,
    proofDigest: permit.proofDigest,
    permitIssuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
    verifiedAt: new Date(verifiedAt).toISOString(),
    nonce: permit.nonce,
  });
}

function absoluteDirectory(value) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value === "/"
    || value.includes("\u0000")
    || path.normalize(value) !== value
  ) {
    throw authorityError(
      "StopPermit store directory must be a normalized absolute path",
      "INVALID_STOP_PERMIT_STORE",
    );
  }
  return value;
}

function effectiveIdentity() {
  const uid = process.geteuid?.() ?? process.getuid?.();
  const gid = process.getegid?.() ?? process.getgid?.();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw authorityError(
      "StopPermit store requires an exact effective Unix identity",
      "STOP_PERMIT_STORE_UNSUPPORTED",
    );
  }
  return Object.freeze({ uid, gid });
}

function validateDirectoryMetadata(metadata) {
  const identity = effectiveIdentity();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== identity.uid
    || metadata.gid !== identity.gid
    || metadata.nlink < 2
    || (metadata.mode & 0o7777) !== STORE_DIRECTORY_MODE
  ) {
    throw authorityError(
      "StopPermit store must be an effective-owner 0700 directory",
      "INSECURE_STOP_PERMIT_STORE",
    );
  }
}

function validateRecordMetadata(metadata, expectedLinks = 1) {
  const identity = effectiveIdentity();
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== identity.uid
    || metadata.gid !== identity.gid
    || metadata.nlink !== expectedLinks
    || metadata.size < 1
    || metadata.size > MAX_STORE_RECORD_BYTES
    || (metadata.mode & 0o7777) !== STORE_RECORD_MODE
  ) {
    throw authorityError(
      `StopPermit record must be an effective-owner 0600 regular file with ${expectedLinks} link(s)`,
      "INSECURE_STOP_PERMIT_STORE",
    );
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(
      directory,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
    );
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function readRecordFile(filePath, { expectedLinks = 1 } = {}) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    validateRecordMetadata(metadata, expectedLinks);
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw authorityError("StopPermit store record is not JSON", "INVALID_STOP_PERMIT_STORE");
    }
    return Object.freeze({ metadata, record: normalizeStoreRecord(parsed) });
  } catch (error) {
    if (error.code === "ELOOP") {
      throw authorityError(
        "StopPermit record symlinks are forbidden",
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function validateStableAncestorChain(directory, label) {
  const identity = effectiveIdentity();
  const trustedOwners = new Set([0, identity.uid]);
  const paths = [];
  for (let current = directory; ; current = path.dirname(current)) {
    paths.push(current);
    if (current === path.parse(current).root) break;
  }
  paths.reverse();

  const entries = [];
  for (const pathname of paths) {
    const info = await lstat(pathname);
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || info.nlink < 2
      || !trustedOwners.has(info.uid)
    ) {
      throw authorityError(
        `${label} ancestor chain is not owned by root or the effective user`,
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
    entries.push(info);
  }
  for (let index = 0; index < entries.length - 1; index += 1) {
    if (
      (entries[index].mode & 0o022) !== 0
      && (entries[index].mode & 0o1000) === 0
    ) {
      throw authorityError(
        `${label} has a writable non-sticky ancestor`,
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
  }
}

async function inspectStoreDirectory(directory, label) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw authorityError(`${label} must already exist`, "INSECURE_STOP_PERMIT_STORE");
    }
    throw error;
  }
  validateDirectoryMetadata(metadata);
  if (await realpath(directory) !== directory) {
    throw authorityError(
      `${label} path must not traverse symlinks`,
      "INSECURE_STOP_PERMIT_STORE",
    );
  }
  await validateStableAncestorChain(directory, label);
  return metadata;
}

function sameStoreRecord(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.nonce === right.nonce
    && left.expiresAt === right.expiresAt
    && constantTimeEqual(left.permitDigest, right.permitDigest);
}

export class FileStopPermitStore {
  #directory;
  #directoryMetadata;
  #parent;
  #parentMetadata;

  constructor(directory, directoryMetadata, parent, parentMetadata, token) {
    if (token !== FILE_STOP_PERMIT_STORE_CONSTRUCTOR_TOKEN) {
      throw authorityError(
        "StopPermit stores must be opened through FileStopPermitStore.open",
        "INVALID_STOP_PERMIT_STORE",
      );
    }
    this.#directory = directory;
    this.#directoryMetadata = directoryMetadata;
    this.#parent = parent;
    this.#parentMetadata = parentMetadata;
    Object.freeze(this);
  }

  get directory() {
    return this.#directory;
  }

  static async open(rawOptions = {}) {
    const options = exactOptionEnvelope(
      rawOptions,
      "StopPermit store open options",
      STORE_OPEN_OPTION_FIELDS,
      [],
      "INVALID_STOP_PERMIT_STORE",
    );
    const normalized = absoluteDirectory(options.directory);
    const parent = path.dirname(normalized);
    const parentMetadata = await inspectStoreDirectory(parent, "StopPermit store parent");
    let created = false;
    try {
      await mkdir(normalized, { mode: STORE_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const directoryMetadata = await inspectStoreDirectory(normalized, "StopPermit store");
    const currentParent = await inspectStoreDirectory(parent, "StopPermit store parent");
    if (!sameFile(parentMetadata, currentParent)) {
      throw authorityError(
        "StopPermit store parent changed during creation",
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
    if (created) await fsyncDirectory(parent);
    return new FileStopPermitStore(
      normalized,
      directoryMetadata,
      parent,
      currentParent,
      FILE_STOP_PERMIT_STORE_CONSTRUCTOR_TOKEN,
    );
  }

  async #validateDirectory() {
    const parentBefore = await inspectStoreDirectory(
      this.#parent,
      "StopPermit store parent",
    );
    if (!sameFile(parentBefore, this.#parentMetadata)) {
      throw authorityError(
        "StopPermit store parent changed after opening",
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
    const directory = await inspectStoreDirectory(this.#directory, "StopPermit store");
    if (!sameFile(directory, this.#directoryMetadata)) {
      throw authorityError(
        "StopPermit store directory changed after opening",
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
    const parentAfter = await inspectStoreDirectory(
      this.#parent,
      "StopPermit store parent",
    );
    if (!sameFile(parentBefore, parentAfter)) {
      throw authorityError(
        "StopPermit store parent changed during validation",
        "INSECURE_STOP_PERMIT_STORE",
      );
    }
  }

  #recordPaths(nonce) {
    const name = sha256(`stop-permit\u0000${nonce}`);
    return Object.freeze({
      active: path.join(this.#directory, `${name}.permit`),
      spent: path.join(this.#directory, `${name}.spent`),
    });
  }

  async #spentRecord(spentPath) {
    try {
      return await readRecordFile(spentPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #consumptionExists(activePath, spentPath, expected) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let spentMetadata;
      try {
        spentMetadata = await lstat(spentPath);
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      try {
        if (spentMetadata.nlink === 1) {
          const spent = await readRecordFile(spentPath);
          if (!sameStoreRecord(spent.record, expected)) {
            throw authorityError(
              "Spent StopPermit does not match its durable authority record",
              "STOP_PERMIT_STORE_MISMATCH",
            );
          }
          return true;
        }
        if (spentMetadata.nlink === 2) {
          const spent = await readRecordFile(spentPath, { expectedLinks: 2 });
          const active = await readRecordFile(activePath, { expectedLinks: 2 });
          if (
            !sameFile(active.metadata, spent.metadata)
            || !sameStoreRecord(active.record, expected)
            || !sameStoreRecord(spent.record, expected)
          ) {
            throw authorityError(
              "StopPermit consumption link is not authoritative",
              "STOP_PERMIT_STORE_MISMATCH",
            );
          }
          return true;
        }
        validateRecordMetadata(spentMetadata);
      } catch (error) {
        if (
          error.code === "ENOENT"
          || (error instanceof SecurityError && error.code === "INSECURE_STOP_PERMIT_STORE")
        ) continue;
        throw error;
      }
    }
    throw authorityError(
      "Spent StopPermit link state is unstable or externally aliased",
      "INSECURE_STOP_PERMIT_STORE",
    );
  }

  async issue(rawRecord) {
    const record = normalizeStoreRecord(rawRecord);
    await this.#validateDirectory();
    const { active, spent } = this.#recordPaths(record.nonce);
    let handle;
    let created = false;
    let removeActive = false;
    let writtenMetadata;
    try {
      handle = await open(
        active,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        STORE_RECORD_MODE,
      );
      created = true;
      if (await this.#spentRecord(spent) !== null) {
        removeActive = true;
        return false;
      }
      await handle.chmod(STORE_RECORD_MODE);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      writtenMetadata = await handle.stat();
      validateRecordMetadata(writtenMetadata);
      await handle.close();
      handle = undefined;
      if (await this.#spentRecord(spent) !== null) {
        removeActive = true;
        return false;
      }
      const published = await readRecordFile(active);
      if (!sameFile(writtenMetadata, published.metadata) || !sameStoreRecord(record, published.record)) {
        throw authorityError(
          "StopPermit record changed during issuance",
          "STOP_PERMIT_STORE_MISMATCH",
        );
      }
      await fsyncDirectory(this.#directory);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      await handle?.close();
      if (created) await unlink(active).catch(() => {});
      throw error;
    } finally {
      await handle?.close();
      if (created && removeActive) {
        await unlink(active).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await fsyncDirectory(this.#directory);
      }
    }
  }

  async consume(rawRecord) {
    const expected = normalizeStoreRecord(rawRecord);
    await this.#validateDirectory();
    const { active, spent } = this.#recordPaths(expected.nonce);
    if (await this.#consumptionExists(active, spent, expected)) return false;
    let observed;
    try {
      observed = await readRecordFile(active);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      if (
        error instanceof SecurityError
        && error.code === "INSECURE_STOP_PERMIT_STORE"
        && await this.#consumptionExists(active, spent, expected)
      ) return false;
      throw error;
    }
    if (!sameStoreRecord(observed.record, expected)) {
      throw authorityError(
        "StopPermit does not match its durable authority record",
        "STOP_PERMIT_STORE_MISMATCH",
      );
    }

    let linked = false;
    let activeRemoved = false;
    try {
      try {
        await link(active, spent);
        linked = true;
      } catch (error) {
        if (["EEXIST", "ENOENT"].includes(error.code)) return false;
        throw error;
      }
      await fsyncDirectory(this.#directory);
      const consumed = await readRecordFile(spent, { expectedLinks: 2 });
      if (!sameFile(observed.metadata, consumed.metadata)) {
        throw authorityError(
          "StopPermit record changed during consumption",
          "STOP_PERMIT_STORE_MISMATCH",
        );
      }
      if (!sameStoreRecord(consumed.record, expected)) {
        throw authorityError(
          "StopPermit authority changed during consumption",
          "STOP_PERMIT_STORE_MISMATCH",
        );
      }
      await unlink(active);
      activeRemoved = true;
      await fsyncDirectory(this.#directory);
      const durableSpent = await readRecordFile(spent);
      if (
        !sameFile(observed.metadata, durableSpent.metadata)
        || !sameStoreRecord(durableSpent.record, expected)
      ) {
        throw authorityError(
          "Spent StopPermit authority changed after consumption",
          "STOP_PERMIT_STORE_MISMATCH",
        );
      }
      return true;
    } finally {
      if (linked && !activeRemoved) {
        await unlink(active).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await fsyncDirectory(this.#directory);
      }
    }
  }
}

export const STOP_PERMIT = Object.freeze({
  schemaVersion: STOP_PERMIT_SCHEMA_VERSION,
  kind: STOP_PERMIT_KIND,
  authorizationKind: STOP_AUTHORIZATION_KIND,
  maximumLifetimeMs: MAX_PERMIT_LIFETIME_MS,
});
