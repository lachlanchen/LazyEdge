import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, watch, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
  EDGE_ROLLOUT_ACTIVATION_PHASES,
  EDGE_ROLLOUT_JOURNAL_SCHEMA,
  EDGE_ROLLOUT_RECEIPT_SCHEMA,
  EDGE_ROLLOUT_ROLLBACK_PHASES,
  createRolloutJournal,
  inspectRolloutJournal,
  openRolloutJournal,
} from "../src/rollout-journal.js";

const PLAN_DIGEST = "a".repeat(64);
const OPERATION_ID = "example-operation-0001";

async function privateDirectory(context, prefix = "lazyedge-rollout-journal-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function journalOptions(statePath, overrides = {}) {
  return {
    statePath,
    planDigest: PLAN_DIGEST,
    operationId: OPERATION_ID,
    ...overrides,
  };
}

function storedState({
  activationPhase = "prepared",
  rollbackPhase = null,
  sequence = 0,
  outcome = null,
} = {}) {
  const updatedAt = "2026-08-29T00:00:00.000Z";
  return {
    schema: EDGE_ROLLOUT_JOURNAL_SCHEMA,
    version: 1,
    planDigest: PLAN_DIGEST,
    operationId: OPERATION_ID,
    activationPhase,
    rollbackPhase,
    sequence,
    terminalReceipt: outcome === null ? null : {
      schema: EDGE_ROLLOUT_RECEIPT_SCHEMA,
      version: 1,
      planDigest: PLAN_DIGEST,
      operationId: OPERATION_ID,
      outcome,
      sequence,
      createdAt: updatedAt,
    },
    updatedAt,
  };
}

async function writeStoredState(statePath, state) {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
}

async function advanceActivationToAccepted(journal) {
  let sequence = (await journal.inspect()).sequence;
  for (let index = 0; index < EDGE_ROLLOUT_ACTIVATION_PHASES.length - 1; index += 1) {
    await journal.advanceActivation({
      expectedSequence: sequence,
      expectedPhase: EDGE_ROLLOUT_ACTIVATION_PHASES[index],
      nextPhase: EDGE_ROLLOUT_ACTIVATION_PHASES[index + 1],
    });
    sequence += 1;
  }
  return sequence;
}

async function advanceRollbackToAccepted(journal, activationPhase = "fenced") {
  let state = await journal.inspect();
  state = await journal.beginRollback({
    expectedSequence: state.sequence,
    expectedActivationPhase: activationPhase,
  });
  for (let index = 0; index < EDGE_ROLLOUT_ROLLBACK_PHASES.length - 1; index += 1) {
    state = await journal.advanceRollback({
      expectedSequence: state.sequence,
      expectedPhase: EDGE_ROLLOUT_ROLLBACK_PHASES[index],
      nextPhase: EDGE_ROLLOUT_ROLLBACK_PHASES[index + 1],
    });
  }
  return state.sequence;
}

function childLeaseScript(moduleUrl) {
  return `
    import { openRolloutJournal } from ${JSON.stringify(moduleUrl)};
    const journal = await openRolloutJournal({
      statePath: process.argv[1],
      planDigest: process.argv[2],
      operationId: process.argv[3]
    });
    process.stdout.write('held\\n');
    process.stdin.once('data', async () => {
      await journal.release();
      process.exit(0);
    });
    process.stdin.resume();
  `;
}

async function waitForHeld(child) {
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    if (output.includes("held\n")) return;
  }
  throw new Error(`child exited before holding lease: ${errors}`);
}

test("journal creation is owner-private, durable, and inspection is read-only", async (context) => {
  const directory = await privateDirectory(context);
  const statePath = path.join(directory, "phase.json");
  const journal = await createRolloutJournal(journalOptions(statePath, {
    clock: () => new Date("2026-08-29T00:00:00.000Z"),
  }));
  await journal.release();

  const info = await lstat(statePath);
  assert.equal(info.mode & 0o7777, 0o600);
  assert.equal(info.nlink, 1);
  assert.equal(info.uid, process.geteuid());
  assert.equal(info.gid, process.getegid());
  const before = await readFile(statePath, "utf8");
  const state = await inspectRolloutJournal(journalOptions(statePath));
  const after = await readFile(statePath, "utf8");
  assert.equal(before, after);
  assert.equal(state.schema, EDGE_ROLLOUT_JOURNAL_SCHEMA);
  assert.equal(state.version, 1);
  assert.equal(state.planDigest, PLAN_DIGEST);
  assert.equal(state.operationId, OPERATION_ID);
  assert.equal(state.activationPhase, "prepared");
  assert.equal(state.sequence, 0);
  await assert.rejects(lstat(`${statePath}.lease`), { code: "ENOENT" });
  await assert.rejects(
    inspectRolloutJournal({ ...journalOptions(statePath), planDigest: "b".repeat(64) }),
    (error) => error.code === "ROLLOUT_JOURNAL_MISMATCH",
  );
  await assert.rejects(
    openRolloutJournal({ ...journalOptions(statePath), operationId: "different-operation-0001" }),
    (error) => error.code === "ROLLOUT_JOURNAL_MISMATCH",
  );
});

test("journal rejects unsafe parents, symlinks, and hardlinked records", async (context) => {
  await assert.rejects(
    createRolloutJournal(journalOptions("/tmp/phase.json", {
      operationId: "example:operation-0001",
    })),
    /portable 16-128 character identifier/u,
  );

  const unsafeParent = await privateDirectory(context, "lazyedge-rollout-unsafe-");
  await chmod(unsafeParent, 0o755);
  await assert.rejects(
    createRolloutJournal(journalOptions(path.join(unsafeParent, "phase.json"))),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_PARENT",
  );

  const symlinkDirectory = await privateDirectory(context, "lazyedge-rollout-symlink-");
  const symlinkTarget = path.join(symlinkDirectory, "target.json");
  const symlinkState = path.join(symlinkDirectory, "phase.json");
  await writeFile(symlinkTarget, "{}\n", { mode: 0o600 });
  await symlink(symlinkTarget, symlinkState);
  await assert.rejects(
    inspectRolloutJournal({ statePath: symlinkState }),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_RECORD",
  );

  const hardlinkDirectory = await privateDirectory(context, "lazyedge-rollout-hardlink-");
  const hardlinkState = path.join(hardlinkDirectory, "phase.json");
  const journal = await createRolloutJournal(journalOptions(hardlinkState));
  await journal.release();
  await link(hardlinkState, path.join(hardlinkDirectory, "second-link.json"));
  await assert.rejects(
    inspectRolloutJournal({ statePath: hardlinkState }),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_RECORD",
  );

  const modeDirectory = await privateDirectory(context, "lazyedge-rollout-mode-");
  const modeState = path.join(modeDirectory, "phase.json");
  const modeJournal = await createRolloutJournal(journalOptions(modeState));
  await modeJournal.release();
  await chmod(modeState, 0o400);
  await assert.rejects(
    inspectRolloutJournal({ statePath: modeState }),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_RECORD",
  );
});

test("journal rejects a private parent beneath a writable non-sticky ancestor", async (context) => {
  const root = await privateDirectory(context, "lazyedge-rollout-ancestor-");
  const unsafe = path.join(root, "unsafe");
  const parent = path.join(unsafe, "private");
  const statePath = path.join(parent, "phase.json");
  await mkdir(unsafe, { mode: 0o777 });
  await chmod(unsafe, 0o777);
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);

  await assert.rejects(
    createRolloutJournal(journalOptions(statePath)),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_PARENT",
  );
  await assert.rejects(lstat(statePath), { code: "ENOENT" });

  await chmod(unsafe, 0o1777);
  const journal = await createRolloutJournal(journalOptions(statePath));
  await journal.release();
  assert.equal((await inspectRolloutJournal(journalOptions(statePath))).sequence, 0);
});

test("create-only publication cannot replace a creator that wins after preflight", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-create-race-");
  const statePath = path.join(directory, "phase.json");
  const competing = {
    schema: EDGE_ROLLOUT_JOURNAL_SCHEMA,
    version: 1,
    planDigest: "b".repeat(64),
    operationId: "competing-operation-0002",
    activationPhase: "prepared",
    rollbackPhase: null,
    sequence: 0,
    terminalReceipt: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  let injected = false;
  const watcher = watch(directory, (_event, fileName) => {
    if (
      injected
      || typeof fileName !== "string"
      || !fileName.startsWith(".phase.json.pending-")
    ) return;
    injected = true;
    writeFileSync(statePath, `${JSON.stringify(competing)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(statePath, 0o600);
  });
  context.after(() => watcher.close());

  await assert.rejects(
    createRolloutJournal(journalOptions(statePath)),
    (error) => error.code === "ROLLOUT_JOURNAL_EXISTS",
  );
  watcher.close();
  assert.equal(injected, true);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), competing);
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.includes(".pending-")), false);
});

test("one cross-process lease excludes a concurrent journal owner", async (context) => {
  const directory = await privateDirectory(context);
  const statePath = path.join(directory, "phase.json");
  const created = await createRolloutJournal(journalOptions(statePath));
  await created.release();
  const moduleUrl = new URL("../src/rollout-journal.js", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    childLeaseScript(moduleUrl),
    statePath,
    PLAN_DIGEST,
    OPERATION_ID,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitForHeld(child);

  await assert.rejects(
    openRolloutJournal(journalOptions(statePath)),
    (error) => error.code === "ROLLOUT_LEASE_HELD",
  );
  child.stdin.end("release\n");
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);

  const reopened = await openRolloutJournal(journalOptions(statePath));
  await reopened.release();
});

test("a live exact process instance cannot be reclaimed even when a callback permits it", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-live-owner-");
  const statePath = path.join(directory, "phase.json");
  const created = await createRolloutJournal(journalOptions(statePath));
  await created.release();
  const held = await openRolloutJournal(journalOptions(statePath));
  const leasePath = `${statePath}.lease`;
  const ownerPath = path.join(leasePath, "owner.json");
  const leaseInfo = await lstat(leasePath);
  const ownerInfo = await lstat(ownerPath);
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  assert.equal(leaseInfo.mode & 0o7777, 0o700);
  assert.equal(leaseInfo.nlink, 2);
  assert.equal(leaseInfo.uid, process.geteuid());
  assert.equal(leaseInfo.gid, process.getegid());
  assert.equal(ownerInfo.mode & 0o7777, 0o600);
  assert.equal(ownerInfo.nlink, 1);
  assert.equal(ownerInfo.uid, process.geteuid());
  assert.equal(ownerInfo.gid, process.getegid());
  assert.equal(owner.pid, process.pid);
  assert.match(owner.processStartTicks, /^[1-9][0-9]*$/u);

  let verifierCalled = false;
  await assert.rejects(
    openRolloutJournal(journalOptions(statePath, {
      verifyOwnerDead() {
        verifierCalled = true;
        return true;
      },
    })),
    (error) => error.code === "ROLLOUT_LEASE_HELD",
  );
  assert.equal(verifierCalled, false);
  assert.equal((await held.inspect()).sequence, 0);
  await held.release();
});

test("stale lease reclamation requires an explicit verified owner-dead callback", async (context) => {
  const directory = await privateDirectory(context);
  const statePath = path.join(directory, "phase.json");
  const created = await createRolloutJournal(journalOptions(statePath));
  await created.release();
  const moduleUrl = new URL("../src/rollout-journal.js", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    childLeaseScript(moduleUrl),
    statePath,
    PLAN_DIGEST,
    OPERATION_ID,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  await waitForHeld(child);
  const stalePid = child.pid;
  const staleOwner = JSON.parse(
    await readFile(path.join(`${statePath}.lease`, "owner.json"), "utf8"),
  );
  assert.equal(staleOwner.pid, stalePid);
  assert.match(staleOwner.processStartTicks, /^[1-9][0-9]*$/u);
  child.kill("SIGKILL");
  await once(child, "exit");

  await assert.rejects(
    openRolloutJournal(journalOptions(statePath)),
    (error) => error.code === "ROLLOUT_LEASE_HELD",
  );
  let refusalCalled = false;
  await assert.rejects(
    openRolloutJournal(journalOptions(statePath, {
      verifyOwnerDead(owner) {
        refusalCalled = true;
        assert.equal(owner.pid, stalePid);
        return false;
      },
    })),
    (error) => error.code === "ROLLOUT_LEASE_HELD",
  );
  assert.equal(refusalCalled, true);

  const reclaimed = await openRolloutJournal(journalOptions(statePath, {
    verifyOwnerDead(owner, contextValue) {
      assert.equal(owner.pid, stalePid);
      assert.equal(contextValue.kind, "rollout-lease");
      assert.equal(contextValue.leasePath, `${statePath}.lease`);
      assert.notEqual(contextValue.observedProcessStartTicks, owner.processStartTicks);
      return true;
    },
  }));
  await reclaimed.release();
});

test("PID reuse evidence permits reclaim and fences the superseded journal handle", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-pid-reuse-");
  const statePath = path.join(directory, "phase.json");
  const journal = await createRolloutJournal(journalOptions(statePath));
  const ownerPath = path.join(`${statePath}.lease`, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  const recordedTicks = owner.processStartTicks === "1" ? "2" : "1";
  await writeFile(
    ownerPath,
    `${JSON.stringify({ ...owner, processStartTicks: recordedTicks })}\n`,
    { mode: 0o600 },
  );
  await chmod(ownerPath, 0o600);

  await assert.rejects(
    journal.inspect(),
    (error) => error.code === "ROLLOUT_LEASE_NOT_HELD",
  );
  let verified = false;
  const reclaimed = await openRolloutJournal(journalOptions(statePath, {
    verifyOwnerDead(staleOwner, contextValue) {
      verified = true;
      assert.equal(staleOwner.pid, process.pid);
      assert.equal(staleOwner.processStartTicks, recordedTicks);
      assert.match(contextValue.observedProcessStartTicks, /^[1-9][0-9]*$/u);
      assert.notEqual(contextValue.observedProcessStartTicks, recordedTicks);
      return true;
    },
  }));
  assert.equal(verified, true);
  await assert.rejects(
    journal.advanceActivation({
      expectedSequence: 0,
      expectedPhase: "prepared",
      nextPhase: "fenced",
    }),
    (error) => error.code === "ROLLOUT_LEASE_NOT_HELD",
  );
  const advanced = await reclaimed.advanceActivation({
    expectedSequence: 0,
    expectedPhase: "prepared",
    nextPhase: "fenced",
  });
  assert.equal(advanced.sequence, 1);
  await journal.release();
  assert.equal((await reclaimed.inspect()).sequence, 1);
  await reclaimed.release();
});

test("lease owner records reject symlink and hardlink substitution", async (context) => {
  const directory = await privateDirectory(context);
  const statePath = path.join(directory, "phase.json");
  const created = await createRolloutJournal(journalOptions(statePath));
  await created.release();

  const held = await openRolloutJournal(journalOptions(statePath));
  const ownerPath = path.join(`${statePath}.lease`, "owner.json");
  const secondLink = path.join(directory, "owner-second-link.json");
  await link(ownerPath, secondLink);
  await assert.rejects(
    openRolloutJournal(journalOptions(statePath)),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_RECORD",
  );
  await rm(secondLink);
  await held.release();

  const target = path.join(directory, "lease-owner-target.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await chmod(target, 0o600);
  const leasePath = `${statePath}.lease`;
  await mkdir(leasePath, { mode: 0o700 });
  await symlink(target, path.join(leasePath, "owner.json"));
  await assert.rejects(
    openRolloutJournal(journalOptions(statePath)),
    (error) => error.code === "UNSAFE_ROLLOUT_JOURNAL_RECORD",
  );
});

test("activation and rollback transitions require exact sequence, phase, and adjacency", async (context) => {
  const directory = await privateDirectory(context);
  const statePath = path.join(directory, "phase.json");
  const journal = await createRolloutJournal(journalOptions(statePath));

  await assert.rejects(
    journal.advanceActivation({
      expectedSequence: 1,
      expectedPhase: "prepared",
      nextPhase: "fenced",
    }),
    (error) => error.code === "ROLLOUT_JOURNAL_CAS_MISMATCH",
  );
  await assert.rejects(
    journal.advanceActivation({
      expectedSequence: 0,
      expectedPhase: "prepared",
      nextPhase: "predecessor-quiesced",
    }),
    /strictly adjacent/u,
  );
  const firstTransition = journal.advanceActivation({
    expectedSequence: 0,
    expectedPhase: "prepared",
    nextPhase: "fenced",
  });
  await assert.rejects(
    journal.advanceActivation({
      expectedSequence: 0,
      expectedPhase: "prepared",
      nextPhase: "fenced",
    }),
    (error) => error.code === "ROLLOUT_JOURNAL_CAS_MISMATCH",
  );
  let state = await firstTransition;
  assert.equal(state.sequence, 1);

  await assert.rejects(
    journal.beginRollback({ expectedSequence: 1, expectedActivationPhase: "prepared" }),
    (error) => error.code === "ROLLOUT_JOURNAL_PHASE_MISMATCH",
  );
  state = await journal.beginRollback({
    expectedSequence: 1,
    expectedActivationPhase: "fenced",
  });
  assert.equal(state.rollbackPhase, "started");
  assert.equal(state.sequence, 2);

  await assert.rejects(
    journal.advanceActivation({
      expectedSequence: 2,
      expectedPhase: "fenced",
      nextPhase: "predecessor-quiesced",
    }),
    /cannot advance after rollback/u,
  );
  await assert.rejects(
    journal.advanceRollback({
      expectedSequence: 2,
      expectedPhase: "started",
      nextPhase: "service-reconciled",
    }),
    /strictly adjacent/u,
  );
  state = await journal.advanceRollback({
    expectedSequence: 2,
    expectedPhase: "started",
    nextPhase: "fenced",
  });
  assert.equal(state.sequence, 3);
  await journal.release();
});

test("committed, rolled-back, and failed receipts are terminal and immutable", async (context) => {
  const committedDirectory = await privateDirectory(context, "lazyedge-rollout-committed-");
  const committedPath = path.join(committedDirectory, "phase.json");
  const committedJournal = await createRolloutJournal(journalOptions(committedPath));
  const commitSequence = await advanceActivationToAccepted(committedJournal);
  const committed = await committedJournal.finalize({
    expectedSequence: commitSequence,
    outcome: "committed",
  });
  assert.equal(committed.terminalReceipt.schema, EDGE_ROLLOUT_RECEIPT_SCHEMA);
  assert.equal(committed.terminalReceipt.outcome, "committed");
  await assert.rejects(
    committedJournal.finalize({ expectedSequence: committed.sequence, outcome: "failed" }),
    (error) => error.code === "ROLLOUT_JOURNAL_TERMINAL",
  );
  await committedJournal.release();

  const rolledBackDirectory = await privateDirectory(context, "lazyedge-rollout-rolled-back-");
  const rolledBackPath = path.join(rolledBackDirectory, "phase.json");
  const rolledBackJournal = await createRolloutJournal(journalOptions(rolledBackPath));
  await rolledBackJournal.advanceActivation({
    expectedSequence: 0,
    expectedPhase: "prepared",
    nextPhase: "fenced",
  });
  const rollbackSequence = await advanceRollbackToAccepted(rolledBackJournal);
  const rolledBack = await rolledBackJournal.finalize({
    expectedSequence: rollbackSequence,
    outcome: "rolled-back",
  });
  assert.equal(rolledBack.terminalReceipt.outcome, "rolled-back");
  await assert.rejects(
    rolledBackJournal.advanceRollback({
      expectedSequence: rolledBack.sequence,
      expectedPhase: "accepted",
      nextPhase: "accepted",
    }),
    (error) => error.code === "ROLLOUT_JOURNAL_TERMINAL",
  );
  await rolledBackJournal.release();

  const failedDirectory = await privateDirectory(context, "lazyedge-rollout-failed-");
  const failedPath = path.join(failedDirectory, "phase.json");
  const failedJournal = await createRolloutJournal(journalOptions(failedPath));
  const failed = await failedJournal.finalize({ expectedSequence: 0, outcome: "failed" });
  assert.equal(failed.terminalReceipt.outcome, "failed");
  await assert.rejects(
    failedJournal.beginRollback({
      expectedSequence: failed.sequence,
      expectedActivationPhase: "prepared",
    }),
    (error) => error.code === "ROLLOUT_JOURNAL_TERMINAL",
  );
  await failedJournal.release();

  const inspected = await inspectRolloutJournal(journalOptions(failedPath));
  assert.equal(inspected.terminalReceipt.outcome, "failed");
});

test("public option envelopes reject inherited, accessor, symbol, and unknown authority", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-envelope-");
  const statePath = path.join(directory, "phase.json");
  const options = journalOptions(statePath);
  let getterCalls = 0;

  const inherited = Object.create({
    get statePath() {
      getterCalls += 1;
      return statePath;
    },
    planDigest: PLAN_DIGEST,
    operationId: OPERATION_ID,
  });
  await assert.rejects(
    createRolloutJournal(inherited),
    /must be an object/u,
  );
  assert.equal(getterCalls, 0);

  const accessorOpen = { ...options };
  Object.defineProperty(accessorOpen, "verifyOwnerDead", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return () => true;
    },
  });
  await assert.rejects(
    openRolloutJournal(accessorOpen),
    /enumerable data property/u,
  );
  assert.equal(getterCalls, 0);

  const accessorInspect = {
    planDigest: PLAN_DIGEST,
    operationId: OPERATION_ID,
  };
  Object.defineProperty(accessorInspect, "statePath", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return statePath;
    },
  });
  await assert.rejects(
    inspectRolloutJournal(accessorInspect),
    /enumerable data property/u,
  );
  assert.equal(getterCalls, 0);

  const nonEnumerable = { ...options };
  Object.defineProperty(nonEnumerable, "operationId", {
    value: OPERATION_ID,
    enumerable: false,
  });
  await assert.rejects(
    createRolloutJournal(nonEnumerable),
    /enumerable data property/u,
  );
  await assert.rejects(
    createRolloutJournal({ ...options, unexpected: true }),
    /fields changed/u,
  );
  await assert.rejects(
    openRolloutJournal({ ...options, [Symbol("authority")]: true }),
    /non-string field/u,
  );

  const pollutedDescriptors = new Map();
  for (const [key, value] of Object.entries(options)) {
    pollutedDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() {
        getterCalls += 1;
        return value;
      },
    });
  }
  try {
    await assert.rejects(createRolloutJournal({}), /fields changed/u);
    await assert.rejects(inspectRolloutJournal({}), /fields changed/u);
    assert.equal(getterCalls, 0);
  } finally {
    for (const [key, descriptor] of pollutedDescriptors) {
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }

  const journal = await createRolloutJournal(options);
  const transitionCases = [
    ["advanceActivation", {
      expectedPhase: "prepared",
      nextPhase: "fenced",
    }, "expectedSequence", 0],
    ["beginRollback", {
      expectedSequence: 0,
    }, "expectedActivationPhase", "prepared"],
    ["advanceRollback", {
      expectedSequence: 0,
      expectedPhase: "started",
    }, "nextPhase", "fenced"],
    ["finalize", {
      expectedSequence: 0,
    }, "outcome", "failed"],
  ];
  for (const [method, envelope, accessorKey, accessorValue] of transitionCases) {
    Object.defineProperty(envelope, accessorKey, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return accessorValue;
      },
    });
    await assert.rejects(
      journal[method](envelope),
      /enumerable data property/u,
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal((await journal.inspect()).sequence, 0);
  await journal.release();
});

test("stored journal validation accepts every reachable phase-sequence shape", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-reachable-");
  const statePath = path.join(directory, "phase.json");

  for (let activationIndex = 0;
    activationIndex < EDGE_ROLLOUT_ACTIVATION_PHASES.length;
    activationIndex += 1) {
    const activationPhase = EDGE_ROLLOUT_ACTIVATION_PHASES[activationIndex];
    await writeStoredState(statePath, storedState({ activationPhase, sequence: activationIndex }));
    assert.equal((await inspectRolloutJournal({ statePath })).sequence, activationIndex);

    const failedSequence = activationIndex + 1;
    await writeStoredState(statePath, storedState({
      activationPhase,
      sequence: failedSequence,
      outcome: "failed",
    }));
    assert.equal(
      (await inspectRolloutJournal({ statePath })).terminalReceipt.outcome,
      "failed",
    );
  }

  const activationPhase = "candidate-routed-guarded";
  const activationIndex = EDGE_ROLLOUT_ACTIVATION_PHASES.indexOf(activationPhase);
  for (let rollbackIndex = 0;
    rollbackIndex < EDGE_ROLLOUT_ROLLBACK_PHASES.length;
    rollbackIndex += 1) {
    const rollbackPhase = EDGE_ROLLOUT_ROLLBACK_PHASES[rollbackIndex];
    const sequence = activationIndex + rollbackIndex + 1;
    await writeStoredState(statePath, storedState({
      activationPhase,
      rollbackPhase,
      sequence,
    }));
    assert.equal((await inspectRolloutJournal({ statePath })).sequence, sequence);

    await writeStoredState(statePath, storedState({
      activationPhase,
      rollbackPhase,
      sequence: sequence + 1,
      outcome: "failed",
    }));
    assert.equal(
      (await inspectRolloutJournal({ statePath })).terminalReceipt.outcome,
      "failed",
    );
  }

  await writeStoredState(statePath, storedState({
    activationPhase: "accepted",
    sequence: EDGE_ROLLOUT_ACTIVATION_PHASES.length,
    outcome: "committed",
  }));
  assert.equal(
    (await inspectRolloutJournal({ statePath })).terminalReceipt.outcome,
    "committed",
  );

  const rollbackActivationIndex = EDGE_ROLLOUT_ACTIVATION_PHASES.indexOf(activationPhase);
  const rollbackAcceptedIndex = EDGE_ROLLOUT_ROLLBACK_PHASES.indexOf("accepted");
  await writeStoredState(statePath, storedState({
    activationPhase,
    rollbackPhase: "accepted",
    sequence: rollbackActivationIndex + rollbackAcceptedIndex + 2,
    outcome: "rolled-back",
  }));
  assert.equal(
    (await inspectRolloutJournal({ statePath })).terminalReceipt.outcome,
    "rolled-back",
  );
});

test("stored journal validation rejects unreachable phase history", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-corrupt-");
  const statePath = path.join(directory, "phase.json");
  const corruptStates = [
    storedState({ activationPhase: "accepted", sequence: 0 }),
    storedState({ activationPhase: "fenced", sequence: 0 }),
    storedState({ activationPhase: "prepared", sequence: 1 }),
    storedState({
      activationPhase: "candidate-opened",
      rollbackPhase: "started",
      sequence: 7,
    }),
    storedState({
      activationPhase: "fenced",
      rollbackPhase: "accepted",
      sequence: 7,
    }),
    storedState({
      activationPhase: "fenced",
      sequence: 3,
      outcome: "failed",
    }),
  ];

  for (const corrupt of corruptStates) {
    await writeStoredState(statePath, corrupt);
    await assert.rejects(
      inspectRolloutJournal({ statePath }),
      (error) => (
        error.code === "INVALID_ROLLOUT_JOURNAL"
        && /phase history is unreachable/u.test(error.message)
      ),
    );
  }
});
