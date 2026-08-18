import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planDoctorChecks, runDoctor } from "../src/doctor.js";
import {
  atomicWriteFile,
  planRevision,
  rollbackPlan,
} from "../src/state.js";

const fixtureUrl = new URL("./fixtures/ops-sshem-sanitized.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

test("atomicWriteFile uses the requested mode and rejects symlink destinations", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-state-test-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const target = path.join(directory, "state.json");
  const result = await atomicWriteFile(target, "first\n", { mode: 0o600 });
  assert.equal(result.mode, 0o600);
  assert.equal(await readFile(target, "utf8"), "first\n");
  assert.equal((await lstat(target)).mode & 0o777, 0o600);

  await chmod(target, 0o644);
  await atomicWriteFile(target, "second\n", { mode: 0o640 });
  assert.equal((await lstat(target)).mode & 0o777, 0o640);

  const link = path.join(directory, "linked");
  await symlink(target, link);
  await assert.rejects(() => atomicWriteFile(link, "unsafe"), /non-regular file/u);
});

test("revision planning is deterministic and carries exact rollback metadata", () => {
  const target = "/etc/lazyedge/Caddyfile";
  const args = {
    manifest: fixture,
    files: [{ path: target, content: "rendered\n", mode: 0o640 }],
    current: {
      [target]: {
        exists: true,
        digest: "a".repeat(64),
        mode: 0o600,
      },
    },
    createdAt: "2026-08-18T10:20:30.000Z",
  };
  const first = planRevision(args);
  const second = planRevision(args);
  assert.deepEqual(first, second);
  assert.match(first.revisionId, /^r-20260818t102030z-[a-f0-9]{12}$/u);
  assert.equal(first.operations[0].target, target);
  assert.equal(first.operations[0].previous.digest, "a".repeat(64));
  assert.equal(first.rollback.operations[0].action, "atomic-restore");
  assert.equal(rollbackPlan(first).sourceRevisionId, first.revisionId);
  assert.equal(JSON.stringify(first).includes("rendered"), false);
});

test("new files receive remove-only rollback metadata", () => {
  const revision = planRevision({
    manifest: fixture,
    files: [{ path: "/etc/lazyedge/new.conf", content: "new\n", mode: 0o640 }],
    createdAt: "2026-08-18T10:20:30.000Z",
  });
  assert.deepEqual(revision.rollback.operations, [{
    action: "remove-created-file",
    target: "/etc/lazyedge/new.conf",
  }]);
});

test("doctor plans only loopback probes and runs with injectable probes", async () => {
  const checks = planDoctorChecks(fixture);
  assert(checks.length >= 5);
  for (const item of checks.filter((candidate) => candidate.listener)) {
    assert.match(item.listener, /^(?:127\.0\.0\.1|\[::1\]):[0-9]+$/u);
  }
  const connected = [];
  const result = await runDoctor(fixture, {
    tcpProbeImpl: async (listener) => connected.push(listener),
    fetchImpl: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
    commandProbeImpl: async () => {},
  });
  assert.equal(result.ok, true);
  assert(connected.includes("127.0.0.1:17600"));
  assert(connected.includes("127.0.0.1:18008"));
  assert(connected.includes("127.0.0.1:17800"));
});

test("doctor reports a probe failure without leaking multiline diagnostics", async () => {
  const result = await runDoctor(fixture, {
    role: "edge",
    tcpProbeImpl: async () => {
      throw new Error("connection failed\nprivate detail");
    },
  });
  assert.equal(result.ok, false);
  assert(result.checks.some((item) => item.status === "fail"));
  assert(result.checks.filter((item) => item.message).every((item) => !item.message.includes("\n")));
});

test("doctor uses a bare HostKeyAlias pin on a nonstandard SSH port", async () => {
  const manifest = structuredClone(fixture);
  manifest.spec.transport.sshPort = 2222;
  manifest.spec.transport.hostKeyAlias = "lazyedge-pinned";
  const result = await runDoctor(manifest, {
    role: "worker",
    paths: { knownHosts: "/private/known_hosts" },
    tcpProbeImpl: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
    statImpl: async () => ({ isFile: () => true, mode: 0o100600 }),
    readFileImpl: async () => (
      "lazyedge-pinned ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmVIb3N0S2V5\n"
    ),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});
