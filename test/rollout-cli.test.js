import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { createRolloutJournal } from "../src/rollout-journal.js";

const PLAN_DIGEST = "a".repeat(64);
const OPERATION_ID = "rollout-cli-operation-0001";

function rolloutFixture() {
  return {
    apiVersion: "lazyedge.lazying.art/v1alpha1",
    kind: "EdgeRollout",
    metadata: { name: "example-rollout" },
    spec: {
      edgeProjectDigest: "1".repeat(64),
      deploymentId: "deployment-20260829-0001",
      artifacts: [
        {
          id: "zeta-unit",
          path: "/etc/systemd/system/example.service",
          sha256: "3".repeat(64),
          owner: "root",
          group: "root",
          mode: "0644",
          type: "regular-file",
        },
        {
          id: "alpha-config",
          path: "/etc/example/config.json",
          sha256: "2".repeat(64),
          owner: "root",
          group: "root",
          mode: "0640",
          type: "regular-file",
        },
      ],
    },
  };
}

function yamlRollout() {
  const fixture = rolloutFixture();
  return `apiVersion: ${fixture.apiVersion}
kind: ${fixture.kind}
metadata:
  name: ${fixture.metadata.name}
spec:
  edgeProjectDigest: "${fixture.spec.edgeProjectDigest}"
  deploymentId: ${fixture.spec.deploymentId}
  artifacts:
    - id: zeta-unit
      path: /etc/systemd/system/example.service
      sha256: "${"3".repeat(64)}"
      owner: root
      group: root
      mode: "0644"
      type: regular-file
    - id: alpha-config
      path: /etc/example/config.json
      sha256: "${"2".repeat(64)}"
      owner: root
      group: root
      mode: "0640"
      type: regular-file
`;
}

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}

async function invoke(argv) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(argv, { stdout: stdout.stream, stderr: stderr.stream });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function privateDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("rollout validate and plan are deterministic read-only summaries", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-cli-");
  const rolloutPath = path.join(directory, "rollout.yaml");
  await writeFile(rolloutPath, yamlRollout(), { mode: 0o600 });
  const before = await readFile(rolloutPath, "utf8");
  const contract = await import("@lazyingart/lazyedge/rollout/contract");
  const expectedDigest = contract.edgeRolloutDigest(rolloutFixture());

  const validated = await invoke([
    "rollout", "validate", "--rollout", rolloutPath, "--json",
  ]);
  assert.equal(validated.code, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), {
    valid: true,
    summaryOnly: true,
    file: rolloutPath,
    name: "example-rollout",
    deploymentId: "deployment-20260829-0001",
    edgeProjectDigest: "1".repeat(64),
    planDigest: expectedDigest,
    artifactCount: 2,
  });

  const planned = await invoke([
    "rollout", "plan", "--rollout", rolloutPath, "--json",
  ]);
  assert.equal(planned.code, 0, planned.stderr);
  const summary = JSON.parse(planned.stdout);
  assert.equal(summary.summaryOnly, true);
  assert.equal(summary.planDigest, expectedDigest);
  assert.deepEqual(summary.artifacts.map((artifact) => artifact.id), [
    "alpha-config",
    "zeta-unit",
  ]);
  assert.equal(await readFile(rolloutPath, "utf8"), before);

  const textPlan = await invoke(["rollout", "plan", "--rollout", rolloutPath]);
  assert.equal(textPlan.code, 0, textPlan.stderr);
  assert.match(textPlan.stdout, /Read-only rollout plan summary \(not execution authority\)/u);
  assert.match(textPlan.stdout, new RegExp(`Plan digest: ${expectedDigest}`, "u"));
  assert.doesNotMatch(textPlan.stdout, /execut(?:e|ing)|systemctl|install /iu);
});

test("rollout parsing rejects duplicate keys, aliases, unknown fields, and unsafe flags", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-cli-invalid-");
  const duplicatePath = path.join(directory, "duplicate.yaml");
  await writeFile(
    duplicatePath,
    yamlRollout().replace(
      "kind: EdgeRollout\n",
      "kind: EdgeRollout\nkind: EdgeRollout\n",
    ),
    { mode: 0o600 },
  );
  const duplicate = await invoke(["rollout", "validate", "--rollout", duplicatePath]);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /not valid YAML or JSON|Map keys must be unique/u);

  const aliasPath = path.join(directory, "alias.yaml");
  await writeFile(
    aliasPath,
    yamlRollout()
      .replace("metadata:\n", "metadata: &metadata\n")
      .replace("spec:\n", "copy: *metadata\nspec:\n"),
    { mode: 0o600 },
  );
  const alias = await invoke(["rollout", "validate", "--rollout", aliasPath]);
  assert.equal(alias.code, 1);
  assert.match(alias.stderr, /unsupported YAML aliases|unknown field/u);

  const customTagPath = path.join(directory, "custom-tag.yaml");
  await writeFile(
    customTagPath,
    yamlRollout().replace(
      "name: example-rollout",
      "name: !surprise example-rollout",
    ),
    { mode: 0o600 },
  );
  const customTag = await invoke([
    "rollout", "validate", "--rollout", customTagPath,
  ]);
  assert.equal(customTag.code, 1);
  assert.match(customTag.stderr, /unsupported YAML features|tag/u);

  const jsonPath = path.join(directory, "unknown.json");
  await writeFile(
    jsonPath,
    `${JSON.stringify({ ...rolloutFixture(), unexpected: true })}\n`,
    { mode: 0o600 },
  );
  const unknown = await invoke(["rollout", "plan", "--rollout", jsonPath]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown field/u);

  const oversizedPath = path.join(directory, "oversized.yaml");
  await writeFile(oversizedPath, "x".repeat((1024 * 1024) + 1), { mode: 0o600 });
  const oversized = await invoke([
    "rollout", "validate", "--rollout", oversizedPath,
  ]);
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /no larger than 1 MiB/u);

  const invalidUtf8Path = path.join(directory, "invalid-utf8.yaml");
  await writeFile(invalidUtf8Path, Buffer.from([0xff]), { mode: 0o600 });
  const invalidUtf8 = await invoke([
    "rollout", "validate", "--rollout", invalidUtf8Path,
  ]);
  assert.equal(invalidUtf8.code, 1);
  assert.match(invalidUtf8.stderr, /valid UTF-8/u);

  const symlinkPath = path.join(directory, "rollout-link.yaml");
  await symlink(jsonPath, symlinkPath);
  const symlinked = await invoke([
    "rollout", "validate", "--rollout", symlinkPath,
  ]);
  assert.equal(symlinked.code, 1);
  assert.match(symlinked.stderr, /symbolic link/u);

  const directoryInput = await invoke([
    "rollout", "validate", "--rollout", directory,
  ]);
  assert.equal(directoryInput.code, 1);
  assert.match(directoryInput.stderr, /non-empty regular file/u);

  const valuedFlag = await invoke([
    "rollout", "plan", "--rollout", jsonPath, "--json=true",
  ]);
  assert.equal(valuedFlag.code, 1);
  assert.match(valuedFlag.stderr, /--json does not accept a value/u);
});

test("rollout inspect reads an exact journal without creating a lease or changing state", async (context) => {
  const directory = await privateDirectory(context, "lazyedge-rollout-inspect-");
  const statePath = path.join(directory, "phase.json");
  const journal = await createRolloutJournal({
    statePath,
    planDigest: PLAN_DIGEST,
    operationId: OPERATION_ID,
  });
  await journal.release();
  const beforeText = await readFile(statePath, "utf8");
  const beforeInfo = await lstat(statePath);

  const inspected = await invoke([
    "rollout", "inspect",
    "--state", statePath,
    "--plan-digest", PLAN_DIGEST,
    "--operation-id", OPERATION_ID,
    "--json",
  ]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const state = JSON.parse(inspected.stdout);
  assert.equal(state.planDigest, PLAN_DIGEST);
  assert.equal(state.operationId, OPERATION_ID);
  assert.equal(state.activationPhase, "prepared");
  assert.equal(state.sequence, 0);
  const afterInfo = await lstat(statePath);
  assert.equal(await readFile(statePath, "utf8"), beforeText);
  assert.equal(afterInfo.ino, beforeInfo.ino);
  assert.equal(afterInfo.mtimeMs, beforeInfo.mtimeMs);
  await assert.rejects(lstat(`${statePath}.lease`), { code: "ENOENT" });

  const text = await invoke(["rollout", "inspect", "--state", statePath]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Read-only rollout journal inspection/u);
  assert.match(text.stdout, /Terminal outcome: none/u);

  const mismatch = await invoke([
    "rollout", "inspect", "--state", statePath, "--plan-digest", "b".repeat(64),
  ]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /plan digest mismatch/u);
});

test("package exports only the bounded rollout libraries and schema", async () => {
  const help = await invoke(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /rollout validate --rollout FILE/u);
  assert.match(help.stdout, /rollout plan --rollout FILE/u);
  assert.match(help.stdout, /rollout inspect --state FILE/u);
  assert.doesNotMatch(help.stdout, /rollout verify|rollout-systemd/u);
  const unsupported = await invoke(["rollout", "verify"]);
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /requires validate, plan, or inspect/u);

  const authority = await import("@lazyingart/lazyedge/rollout/authority");
  const contract = await import("@lazyingart/lazyedge/rollout/contract");
  const journal = await import("@lazyingart/lazyedge/rollout/journal");
  assert.equal(typeof authority.consumeStopPermit, "function");
  assert.equal(typeof contract.normalizeEdgeRollout, "function");
  assert.equal(typeof journal.inspectRolloutJournal, "function");
  const schemaUrl = import.meta.resolve(
    "@lazyingart/lazyedge/schemas/edge-rollout.schema.json",
  );
  const schema = JSON.parse(await readFile(fileURLToPath(schemaUrl), "utf8"));
  assert.equal(schema.title, "LazyEdge EdgeRollout");
  for (const relativePath of [
    "../docs/rollout-safety.md",
    "../src/rollout-authority.js",
    "../src/rollout-cli.js",
    "../src/rollout-contract.js",
    "../src/rollout-journal.js",
    "../schemas/edge-rollout.schema.json",
    "./rollout-authority.test.js",
    "./rollout-cli.test.js",
    "./rollout-contract.test.js",
    "./rollout-journal.test.js",
  ]) {
    const info = await lstat(new URL(relativePath, import.meta.url));
    assert.equal(info.mode & 0o7777, 0o644, relativePath);
  }
});
