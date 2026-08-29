import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  consumeStopPermit,
  FileStopPermitStore,
  issueStopPermit,
  readLinuxProcessIdentity,
  STOP_PERMIT,
} from "../src/rollout-authority.js";

const NOW = Date.parse("2026-08-29T00:00:00.000Z");
const NONCE = Buffer.alloc(32, 0x42).toString("base64url");
const TEMPORARY_ROOTS = new Set();
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

function claims(overrides = {}) {
  return {
    planDigest: "1".repeat(64),
    operationId: "rollout-20260829-001",
    role: "edge",
    unit: "lazyedge-edge.service",
    invocationId: "2".repeat(32),
    pid: 4219,
    procStartTicks: "12345678901234567890",
    unitDigest: "3".repeat(64),
    listenerSet: [
      "tcp:127.0.0.1:7443",
      "tcp:127.0.0.1:7444",
    ],
    admissionGeneration: "generation-19",
    proofKind: "admission-drained",
    proofDigest: "4".repeat(64),
    ...overrides,
  };
}

function issueOptions(store, overrides = {}) {
  return {
    claims: claims(),
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    nonce: NONCE,
    store,
    clock: () => NOW,
    ...overrides,
  };
}

function expectedFromPermit(permit, overrides = {}) {
  return {
    ...Object.fromEntries(CLAIM_FIELDS.map((field) => [field, permit[field]])),
    ...overrides,
  };
}

function exactIdentity(permit) {
  return async () => ({ pid: permit.pid, procStartTicks: permit.procStartTicks });
}

async function temporaryStore(prefix = "lazyedge-stop-permit-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMPORARY_ROOTS.add(root);
  const directory = path.join(root, "authority");
  return {
    root,
    directory,
    store: await FileStopPermitStore.open({ directory }),
  };
}

test.after(async () => {
  await Promise.all([...TEMPORARY_ROOTS].map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function hasCode(code) {
  return (error) => error?.code === code;
}

async function withObjectPrototypeProperty(name, descriptor, action) {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  Object.defineProperty(Object.prototype, name, {
    ...descriptor,
    configurable: true,
  });
  try {
    return await action();
  } finally {
    if (previous === undefined) delete Object.prototype[name];
    else Object.defineProperty(Object.prototype, name, previous);
  }
}

test("StopPermit issue options reject accessors, inheritance, symbols, and prototype pollution", async () => {
  let issueCalls = 0;
  const store = {
    issue: async () => {
      issueCalls += 1;
      return true;
    },
    consume: async () => false,
  };
  const valid = issueOptions(store);

  let accessorCalls = 0;
  const accessorOptions = { ...valid };
  Object.defineProperty(accessorOptions, "claims", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return claims();
    },
  });
  await assert.rejects(issueStopPermit(accessorOptions), hasCode("INVALID_STOP_PERMIT"));
  assert.equal(accessorCalls, 0);

  const inheritedOptions = Object.create(valid);
  await assert.rejects(issueStopPermit(inheritedOptions), hasCode("INVALID_STOP_PERMIT"));

  const symbolOptions = { ...valid, [Symbol("extra")]: true };
  await assert.rejects(issueStopPermit(symbolOptions), hasCode("INVALID_STOP_PERMIT"));

  const hiddenOptions = { ...valid };
  Object.defineProperty(hiddenOptions, "clock", {
    enumerable: false,
    value: valid.clock,
  });
  await assert.rejects(issueStopPermit(hiddenOptions), hasCode("INVALID_STOP_PERMIT"));

  let pollutionGetterCalls = 0;
  await withObjectPrototypeProperty("claims", {
    get() {
      pollutionGetterCalls += 1;
      return claims();
    },
  }, async () => {
    const missingOwnClaims = { ...valid };
    delete missingOwnClaims.claims;
    await assert.rejects(
      issueStopPermit(missingOwnClaims),
      hasCode("INVALID_STOP_PERMIT"),
    );
  });
  assert.equal(pollutionGetterCalls, 0);
  assert.equal(issueCalls, 0);

  const nullPrototypeOptions = Object.assign(Object.create(null), valid);
  const permit = await issueStopPermit(nullPrototypeOptions);
  assert.equal(permit.operationId, valid.claims.operationId);
  assert.equal(issueCalls, 1);
});

test("StopPermit consume options reject accessors, inheritance, symbols, and prototype pollution", async () => {
  let consumeCalls = 0;
  const store = {
    issue: async () => true,
    consume: async () => {
      consumeCalls += 1;
      return true;
    },
  };
  const permit = await issueStopPermit(issueOptions(store));
  const valid = {
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  };

  let accessorCalls = 0;
  const accessorOptions = { ...valid };
  Object.defineProperty(accessorOptions, "permit", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return permit;
    },
  });
  await assert.rejects(consumeStopPermit(accessorOptions), hasCode("INVALID_STOP_PERMIT"));
  assert.equal(accessorCalls, 0);

  await assert.rejects(
    consumeStopPermit(Object.create(valid)),
    hasCode("INVALID_STOP_PERMIT"),
  );
  await assert.rejects(
    consumeStopPermit({ ...valid, [Symbol("extra")]: true }),
    hasCode("INVALID_STOP_PERMIT"),
  );

  let pollutionGetterCalls = 0;
  await withObjectPrototypeProperty("expected", {
    get() {
      pollutionGetterCalls += 1;
      return expectedFromPermit(permit);
    },
  }, async () => {
    const missingOwnExpected = { ...valid };
    delete missingOwnExpected.expected;
    await assert.rejects(
      consumeStopPermit(missingOwnExpected),
      hasCode("INVALID_STOP_PERMIT"),
    );
  });
  assert.equal(pollutionGetterCalls, 0);
  assert.equal(consumeCalls, 0);

  const result = await consumeStopPermit(Object.assign(Object.create(null), valid));
  assert.equal(result.kind, STOP_PERMIT.authorizationKind);
  assert.equal(consumeCalls, 1);
});

test("StopPermit store open options reject accessors, inheritance, symbols, and prototype pollution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazyedge-stop-permit-open-options-"));
  TEMPORARY_ROOTS.add(root);
  const directory = path.join(root, "authority");

  let accessorCalls = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "directory", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return directory;
    },
  });
  await assert.rejects(
    FileStopPermitStore.open(accessorOptions),
    hasCode("INVALID_STOP_PERMIT_STORE"),
  );
  assert.equal(accessorCalls, 0);

  await assert.rejects(
    FileStopPermitStore.open(Object.create({ directory })),
    hasCode("INVALID_STOP_PERMIT_STORE"),
  );
  await assert.rejects(
    FileStopPermitStore.open({ directory, [Symbol("extra")]: true }),
    hasCode("INVALID_STOP_PERMIT_STORE"),
  );

  let pollutionGetterCalls = 0;
  await withObjectPrototypeProperty("directory", {
    get() {
      pollutionGetterCalls += 1;
      return directory;
    },
  }, async () => {
    await assert.rejects(
      FileStopPermitStore.open({}),
      hasCode("INVALID_STOP_PERMIT_STORE"),
    );
  });
  assert.equal(pollutionGetterCalls, 0);
  await assert.rejects(lstat(directory), { code: "ENOENT" });

  const store = await FileStopPermitStore.open(Object.assign(
    Object.create(null),
    { directory },
  ));
  assert.equal(store.directory, directory);
});

test("StopPermit stores cannot bypass validated construction or forge an instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazyedge-stop-permit-constructor-"));
  TEMPORARY_ROOTS.add(root);
  await chmod(root, 0o777);
  const directory = path.join(root, "authority");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);

  assert.throws(
    () => new FileStopPermitStore(directory),
    hasCode("INVALID_STOP_PERMIT_STORE"),
  );
  assert.deepEqual(await readdir(directory), []);

  const forged = Object.create(FileStopPermitStore.prototype);
  Object.defineProperty(forged, "directory", {
    enumerable: true,
    value: directory,
  });
  await assert.rejects(
    issueStopPermit(issueOptions(forged)),
    (error) => error instanceof TypeError,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("an opened StopPermit store pins its private parent and directory identity", async () => {
  const { root, directory, store } = await temporaryStore(
    "lazyedge-stop-permit-pinned-store-",
  );

  await chmod(root, 0o755);
  await assert.rejects(
    issueStopPermit(issueOptions(store)),
    hasCode("INSECURE_STOP_PERMIT_STORE"),
  );
  assert.deepEqual(await readdir(directory), []);

  await chmod(root, 0o700);
  const replaced = path.join(root, "authority-replaced");
  await rename(directory, replaced);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await assert.rejects(
    issueStopPermit(issueOptions(store)),
    hasCode("INSECURE_STOP_PERMIT_STORE"),
  );
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(await readdir(replaced), []);
});

test("a durable StopPermit binds every claim and is consumed exactly once", async () => {
  const { directory, store } = await temporaryStore();
  const permit = await issueStopPermit(issueOptions(store));

  assert.deepEqual(Object.keys(permit), [
    "schemaVersion",
    "kind",
    ...CLAIM_FIELDS,
    "issuedAt",
    "expiresAt",
    "nonce",
  ]);
  assert.equal(permit.schemaVersion, STOP_PERMIT.schemaVersion);
  assert.equal(permit.kind, STOP_PERMIT.kind);
  assert.equal(Object.isFrozen(permit), true);
  assert.equal(Object.isFrozen(permit.listenerSet), true);
  const directoryInfo = await stat(directory);
  assert.equal(directoryInfo.mode & 0o7777, 0o700);
  assert.equal(directoryInfo.uid, process.geteuid());
  assert.equal(directoryInfo.gid, process.getegid());

  const records = await readdir(directory);
  assert.equal(records.length, 1);
  assert.match(records[0], /^[a-f0-9]{64}\.permit$/u);
  const recordPath = path.join(directory, records[0]);
  const recordInfo = await stat(recordPath);
  assert.equal(recordInfo.mode & 0o7777, 0o600);
  assert.equal(recordInfo.uid, process.geteuid());
  assert.equal(recordInfo.gid, process.getegid());
  assert.equal(recordInfo.nlink, 1);
  const serialized = await readFile(recordPath, "utf8");
  assert.equal(serialized.includes(permit.operationId), false);
  assert.equal(serialized.includes(permit.unit), false);
  assert.equal(serialized.includes(permit.procStartTicks), false);

  const reopened = await FileStopPermitStore.open({ directory });
  const result = await consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store: reopened,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: STOP_PERMIT.authorizationKind,
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
    verifiedAt: new Date(NOW + 1).toISOString(),
    nonce: permit.nonce,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "authorized"), false);
  const spentRecords = await readdir(directory);
  assert.equal(spentRecords.length, 1);
  assert.match(spentRecords[0], /^[a-f0-9]{64}\.spent$/u);
  const spentInfo = await stat(path.join(directory, spentRecords[0]));
  assert.equal(spentInfo.mode & 0o7777, 0o600);
  assert.equal(spentInfo.uid, process.geteuid());
  assert.equal(spentInfo.gid, process.getegid());
  assert.equal(spentInfo.nlink, 1);

  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 2,
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("STOP_PERMIT_CONSUMED"));
  await assert.rejects(issueStopPermit(issueOptions(reopened)),
    hasCode("STOP_PERMIT_NONCE_REUSED"));
  assert.deepEqual(await readdir(directory), spentRecords);
});

test("concurrent consumers across store instances have one durable winner", async () => {
  const { directory, store } = await temporaryStore("lazyedge-stop-permit-race-");
  const permit = await issueStopPermit(issueOptions(store));
  const secondStore = await FileStopPermitStore.open({ directory });
  const options = (authorityStore) => ({
    permit,
    expected: expectedFromPermit(permit),
    store: authorityStore,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  });

  const outcomes = await Promise.allSettled([
    consumeStopPermit(options(store)),
    consumeStopPermit(options(secondStore)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected.reason.code, "STOP_PERMIT_CONSUMED");
  const records = await readdir(directory);
  assert.equal(records.length, 1);
  assert.match(records[0], /^[a-f0-9]{64}\.spent$/u);
});

test("concurrent issuance cannot reuse a nonce", async () => {
  const { directory, store } = await temporaryStore("lazyedge-stop-permit-issue-race-");
  const secondStore = await FileStopPermitStore.open({ directory });
  const outcomes = await Promise.allSettled([
    issueStopPermit(issueOptions(store)),
    issueStopPermit(issueOptions(secondStore)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected.reason.code, "STOP_PERMIT_NONCE_REUSED");
  assert.equal((await readdir(directory)).length, 1);
});

test("every authority claim is compared exactly before store consumption", async () => {
  const issued = [];
  const store = {
    issue: async (record) => {
      issued.push(record);
      return true;
    },
    consume: async () => {
      assert.fail("a mismatched claim reached the authority store");
    },
  };
  const permit = await issueStopPermit(issueOptions(store));
  const alternatives = {
    planDigest: "a".repeat(64),
    operationId: "rollout-20260829-002",
    role: "worker",
    unit: "lazyedge-worker.service",
    invocationId: "b".repeat(32),
    pid: permit.pid + 1,
    procStartTicks: "12345678901234567891",
    unitDigest: "c".repeat(64),
    listenerSet: ["tcp:127.0.0.1:7445"],
    admissionGeneration: "generation-20",
    proofKind: "listener-drained",
    proofDigest: "d".repeat(64),
  };

  for (const field of CLAIM_FIELDS) {
    await assert.rejects(consumeStopPermit({
      permit,
      expected: expectedFromPermit(permit, { [field]: alternatives[field] }),
      store,
      clock: () => NOW + 1,
      readProcessIdentity: exactIdentity(permit),
    }), hasCode("STOP_PERMIT_MISMATCH"), field);
  }
  assert.equal(issued.length, 1);
});

test("tampering cannot be authorized by changing both permit and expected claims", async () => {
  const { store } = await temporaryStore("lazyedge-stop-permit-tamper-");
  const permit = await issueStopPermit(issueOptions(store));
  const tampered = { ...permit, unitDigest: "e".repeat(64) };

  await assert.rejects(consumeStopPermit({
    permit: tampered,
    expected: expectedFromPermit(tampered),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(tampered),
  }), hasCode("STOP_PERMIT_STORE_MISMATCH"));

  await consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 2,
    readProcessIdentity: exactIdentity(permit),
  });
});

test("PID reuse and unavailable processes do not consume authority", async () => {
  const { store } = await temporaryStore("lazyedge-stop-permit-process-");
  const permit = await issueStopPermit(issueOptions(store));
  for (const readProcessIdentity of [
    async () => null,
    async () => ({ pid: permit.pid + 1, procStartTicks: permit.procStartTicks }),
    async () => ({ pid: permit.pid, procStartTicks: "12345678901234567891" }),
  ]) {
    await assert.rejects(consumeStopPermit({
      permit,
      expected: expectedFromPermit(permit),
      store,
      clock: () => NOW + 1,
      readProcessIdentity,
    }), hasCode("STOP_PERMIT_PROCESS_MISMATCH"));
  }

  await consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 2,
    readProcessIdentity: exactIdentity(permit),
  });
});

test("expiry is checked both before and after process identity assertion", async () => {
  const { store } = await temporaryStore("lazyedge-stop-permit-expiry-");
  const permit = await issueStopPermit(issueOptions(store, {
    expiresAt: new Date(NOW + 1_000).toISOString(),
  }));
  const times = [NOW + 999, NOW + 1_000];
  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => times.shift(),
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("STOP_PERMIT_EXPIRED"));

  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1_000,
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("STOP_PERMIT_EXPIRED"));
});

test("expiry reached during durable consumption cannot produce a stop authorization", async () => {
  let now = NOW;
  let consumeCalls = 0;
  let identityReads = 0;
  const store = {
    issue: async () => true,
    consume: async () => {
      consumeCalls += 1;
      now = NOW + 1_000;
      return true;
    },
  };
  const permit = await issueStopPermit(issueOptions(store, {
    expiresAt: new Date(NOW + 1_000).toISOString(),
    clock: () => NOW,
  }));
  now = NOW + 999;

  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => now,
    readProcessIdentity: async () => {
      identityReads += 1;
      return { pid: permit.pid, procStartTicks: permit.procStartTicks };
    },
  }), hasCode("STOP_PERMIT_EXPIRED"));
  assert.equal(consumeCalls, 1);
  assert.equal(identityReads, 1);
});

test("process replacement during durable consumption cannot produce a stop authorization", async () => {
  let procStartTicks = "12345678901234567890";
  let consumeCalls = 0;
  let identityReads = 0;
  const store = {
    issue: async () => true,
    consume: async () => {
      consumeCalls += 1;
      procStartTicks = "12345678901234567891";
      return true;
    },
  };
  const permit = await issueStopPermit(issueOptions(store));

  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: async () => {
      identityReads += 1;
      return { pid: permit.pid, procStartTicks };
    },
  }), hasCode("STOP_PERMIT_PROCESS_MISMATCH"));
  assert.equal(consumeCalls, 1);
  assert.equal(identityReads, 2);
});

test("issuance rejects future, expired, noncanonical, and overlong lifetimes", async () => {
  const store = {
    issue: async () => assert.fail("invalid time reached the authority store"),
    consume: async () => false,
  };
  const invalidOptions = [
    {
      issuedAt: new Date(NOW + 1).toISOString(),
      expiresAt: new Date(NOW + 1_000).toISOString(),
      expectedCode: "STOP_PERMIT_NOT_YET_VALID",
    },
    {
      issuedAt: new Date(NOW - 1_000).toISOString(),
      expiresAt: new Date(NOW).toISOString(),
      expectedCode: "STOP_PERMIT_EXPIRED",
    },
    {
      issuedAt: "2026-08-29T00:00:00Z",
      expiresAt: new Date(NOW + 1_000).toISOString(),
      expectedCode: "INVALID_STOP_PERMIT",
    },
    {
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + STOP_PERMIT.maximumLifetimeMs + 1).toISOString(),
      expectedCode: "INVALID_STOP_PERMIT",
    },
  ];
  for (const { expectedCode, ...options } of invalidOptions) {
    await assert.rejects(issueStopPermit(issueOptions(store, options)),
      hasCode(expectedCode));
  }
});

test("expiry reached during durable issuance cannot return a permit", async () => {
  let now = NOW;
  let issueCalls = 0;
  const store = {
    issue: async () => {
      issueCalls += 1;
      now = NOW + 1_000;
      return true;
    },
    consume: async () => false,
  };
  await assert.rejects(issueStopPermit(issueOptions(store, {
    expiresAt: new Date(NOW + 1_000).toISOString(),
    clock: () => now,
  })), hasCode("STOP_PERMIT_EXPIRED"));
  assert.equal(issueCalls, 1);
});

test("claim, permit, and process identity inputs are strict exact objects", async () => {
  let issueCalls = 0;
  const store = {
    issue: async () => {
      issueCalls += 1;
      return true;
    },
    consume: async () => true,
  };
  const malformedClaims = [
    { ...claims(), extra: true },
    claims({ planDigest: "A".repeat(64) }),
    claims({ operationId: "too-short" }),
    claims({ operationId: "rollout:operation:0001" }),
    claims({ invocationId: "2".repeat(31) }),
    claims({ pid: 0 }),
    claims({ procStartTicks: 123 }),
    claims({ procStartTicks: "0" }),
    claims({ unit: "lazyedge-edge.timer" }),
    claims({ listenerSet: ["tcp:127.0.0.1:7444", "tcp:127.0.0.1:7443"] }),
    claims({ listenerSet: ["tcp:127.0.0.1:7443", "tcp:127.0.0.1:7443"] }),
    claims({ admissionGeneration: "generation with spaces" }),
  ];
  const legacyDigestName = claims();
  legacyDigestName.rolloutPlanDigest = legacyDigestName.planDigest;
  delete legacyDigestName.planDigest;
  malformedClaims.push(legacyDigestName);
  const sparseListeners = [];
  sparseListeners.length = 1;
  malformedClaims.push(claims({ listenerSet: sparseListeners }));
  const accessorListeners = ["tcp:127.0.0.1:7443"];
  Object.defineProperty(accessorListeners, "0", {
    enumerable: true,
    get: () => "tcp:127.0.0.1:7443",
  });
  malformedClaims.push(claims({ listenerSet: accessorListeners }));
  const extraListenerProperty = ["tcp:127.0.0.1:7443"];
  Object.defineProperty(extraListenerProperty, "hidden", { value: true });
  malformedClaims.push(claims({ listenerSet: extraListenerProperty }));
  const accessorClaims = claims();
  Object.defineProperty(accessorClaims, "operationId", {
    enumerable: true,
    get: () => "rollout-20260829-accessor",
  });
  malformedClaims.push(accessorClaims);
  const hiddenExtraClaims = claims();
  Object.defineProperty(hiddenExtraClaims, "hidden", { value: true });
  malformedClaims.push(hiddenExtraClaims);
  const symbolExtraClaims = claims();
  symbolExtraClaims[Symbol("extra")] = true;
  malformedClaims.push(symbolExtraClaims);
  for (const candidate of malformedClaims) {
    await assert.rejects(issueStopPermit(issueOptions(store, { claims: candidate })),
      hasCode("INVALID_STOP_PERMIT"));
  }
  assert.equal(issueCalls, 0);

  await assert.rejects(issueStopPermit(issueOptions(store, {
    nonce: `${"A".repeat(42)}B`,
  })), hasCode("INVALID_STOP_PERMIT"));
  assert.equal(issueCalls, 0);

  const permit = await issueStopPermit(issueOptions(store, {
    nonce: Buffer.alloc(32, 0x43).toString("base64url"),
  }));
  await assert.rejects(consumeStopPermit({
    permit: { ...permit, unknown: true },
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("INVALID_STOP_PERMIT"));
  const hiddenExtraPermit = { ...permit };
  Object.defineProperty(hiddenExtraPermit, "hidden", { value: true });
  await assert.rejects(consumeStopPermit({
    permit: hiddenExtraPermit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("INVALID_STOP_PERMIT"));
  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: async () => ({
      pid: permit.pid,
      procStartTicks: permit.procStartTicks,
      extra: true,
    }),
  }), hasCode("STOP_PERMIT_PROCESS_MISMATCH"));
});

test("the default Linux procfs reader authorizes only the current process instance", {
  skip: process.platform !== "linux",
}, async () => {
  const identity = await readLinuxProcessIdentity(process.pid);
  assert.equal(identity.pid, process.pid);
  assert.match(identity.procStartTicks, /^[1-9][0-9]*$/u);
  const { store } = await temporaryStore("lazyedge-stop-permit-procfs-");
  const permit = await issueStopPermit(issueOptions(store, {
    claims: claims(identity),
  }));
  await consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
  });
});

test("file stores reject broad permissions and symlink destinations", async () => {
  const { root, directory, store } = await temporaryStore("lazyedge-stop-permit-mode-");
  await chmod(directory, 0o755);
  await assert.rejects(issueStopPermit(issueOptions(store)),
    hasCode("INSECURE_STOP_PERMIT_STORE"));

  const target = path.join(root, "real-authority");
  await FileStopPermitStore.open({ directory: target });
  const link = path.join(root, "linked-authority");
  await symlink(target, link);
  await assert.rejects(FileStopPermitStore.open({ directory: link }),
    hasCode("INSECURE_STOP_PERMIT_STORE"));
  assert.equal((await lstat(link)).isSymbolicLink(), true);

  const protectedAuthority = await temporaryStore("lazyedge-stop-permit-record-mode-");
  const permit = await issueStopPermit(issueOptions(protectedAuthority.store));
  const [recordName] = await readdir(protectedAuthority.directory);
  await chmod(path.join(protectedAuthority.directory, recordName), 0o644);
  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store: protectedAuthority.store,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("INSECURE_STOP_PERMIT_STORE"));
});

test("store creation rejects symlinked or missing parents before creating a directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazyedge-stop-permit-parent-"));
  TEMPORARY_ROOTS.add(root);
  const realParent = path.join(root, "real-parent");
  await mkdir(realParent, { mode: 0o700 });
  const linkedParent = path.join(root, "linked-parent");
  await symlink(realParent, linkedParent);
  const redirectedStore = path.join(linkedParent, "must-not-exist");

  await assert.rejects(FileStopPermitStore.open({ directory: redirectedStore }),
    hasCode("INSECURE_STOP_PERMIT_STORE"));
  await assert.rejects(lstat(path.join(realParent, "must-not-exist")), { code: "ENOENT" });

  const missingParentStore = path.join(root, "missing-parent", "authority");
  await assert.rejects(FileStopPermitStore.open({ directory: missingParentStore }),
    hasCode("INSECURE_STOP_PERMIT_STORE"));
  await assert.rejects(lstat(path.join(root, "missing-parent")), { code: "ENOENT" });
});

test("store creation rejects a private directory beneath a writable non-sticky ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazyedge-stop-permit-ancestor-"));
  TEMPORARY_ROOTS.add(root);
  const unsafe = path.join(root, "unsafe");
  const parent = path.join(unsafe, "private");
  const directory = path.join(parent, "authority");
  await mkdir(unsafe, { mode: 0o777 });
  await chmod(unsafe, 0o777);
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);

  await assert.rejects(
    FileStopPermitStore.open({ directory }),
    hasCode("INSECURE_STOP_PERMIT_STORE"),
  );
  await assert.rejects(lstat(directory), { code: "ENOENT" });

  await chmod(unsafe, 0o1777);
  const store = await FileStopPermitStore.open({ directory });
  assert.equal(store.directory, directory);
});

test("active and spent authority records reject external hardlinks", async () => {
  const { root, directory, store } = await temporaryStore("lazyedge-stop-permit-hardlink-");
  const permit = await issueStopPermit(issueOptions(store));
  const [activeName] = await readdir(directory);
  const activePath = path.join(directory, activeName);
  const activeAlias = path.join(root, "active-alias");
  await link(activePath, activeAlias);
  assert.equal((await stat(activePath)).nlink, 2);

  await assert.rejects(consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 1,
    readProcessIdentity: exactIdentity(permit),
  }), hasCode("INSECURE_STOP_PERMIT_STORE"));
  assert.deepEqual(await readdir(directory), [activeName]);

  await unlink(activeAlias);
  await consumeStopPermit({
    permit,
    expected: expectedFromPermit(permit),
    store,
    clock: () => NOW + 2,
    readProcessIdentity: exactIdentity(permit),
  });
  const [spentName] = await readdir(directory);
  const spentPath = path.join(directory, spentName);
  assert.match(spentName, /^[a-f0-9]{64}\.spent$/u);
  assert.equal((await stat(spentPath)).nlink, 1);

  const spentAlias = path.join(root, "spent-alias");
  await link(spentPath, spentAlias);
  await assert.rejects(issueStopPermit(issueOptions(store)),
    hasCode("INSECURE_STOP_PERMIT_STORE"));
  assert.equal((await stat(spentPath)).nlink, 2);
  await unlink(spentAlias);
  await assert.rejects(issueStopPermit(issueOptions(store)),
    hasCode("STOP_PERMIT_NONCE_REUSED"));
});
