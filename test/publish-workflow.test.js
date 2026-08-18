import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { verifyReleaseMetadata } from "../scripts/verify-release-metadata.mjs";

async function metadataFixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "package.json"),
    '{"name":"@lazyingart/lazyedge","version":"1.2.3"}\n',
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    '{"name":"@lazyingart/lazyedge","version":"1.2.3","packages":{"":{"name":"@lazyingart/lazyedge","version":"1.2.3"}}}\n',
  );
  await writeFile(
    path.join(directory, "CITATION.cff"),
    "cff-version: 1.2.0\nversion: 1.2.3\ndate-released: 2026-08-19\n",
  );
  return directory;
}

test("publish workflow keeps manual dispatch validation-only", async () => {
  const source = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["release", "workflow_dispatch"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["id-token"], undefined);

  const verify = workflow.jobs.verify;
  const publish = workflow.jobs.publish;
  assert.equal(verify.permissions["id-token"], undefined);
  assert.equal(publish.permissions["id-token"], "write");
  assert.match(publish.if, /github\.event_name == 'release'/u);
  assert.match(publish.if, /prerelease == false/u);
  assert.equal(publish.needs, "verify");

  const publishCommands = publish.steps
    .map((step) => step.run ?? "")
    .join("\n");
  assert.match(publishCommands, /verify-release-metadata\.mjs --tag/u);
  assert.match(publishCommands, /--require-unpublished/u);
  assert.match(publishCommands, /npm publish --access public --provenance/u);

  const verifyCommands = verify.steps
    .map((step) => step.run ?? "")
    .join("\n");
  assert.doesNotMatch(verifyCommands, /npm publish/u);
  assert.match(verifyCommands, /npm test/u);
  assert.match(verifyCommands, /npm run check/u);
  assert.match(verifyCommands, /npm pack --dry-run/u);
});

test("release metadata verifier binds package, lock, citation, tag, and HEAD", async (context) => {
  const directory = await metadataFixture(context);
  const execute = (command, args) => {
    assert.equal(command, "git");
    if (args.join(" ") === "rev-parse --verify HEAD") return "release-commit";
    if (args.join(" ") === "rev-parse --verify v1.2.3^{commit}") return "release-commit";
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const result = await verifyReleaseMetadata({
    cwd: directory,
    releaseTag: "v1.2.3",
    execute,
  });
  assert.deepEqual(result, {
    packageName: "@lazyingart/lazyedge",
    version: "1.2.3",
    releaseTag: "v1.2.3",
    unpublished: false,
  });

  await assert.rejects(
    verifyReleaseMetadata({ cwd: directory, releaseTag: "v1.2.4", execute }),
    /does not match v1\.2\.3/u,
  );
  await assert.rejects(
    verifyReleaseMetadata({
      cwd: directory,
      releaseTag: "v1.2.3",
      execute: (_command, args) => args.at(-1) === "HEAD"
        ? "release-commit"
        : "different-commit",
    }),
    /does not identify the checked-out commit/u,
  );
});

test("release metadata verifier fails closed for published or unknown registry state", async (context) => {
  const directory = await metadataFixture(context);
  const git = () => "release-commit";
  const options = {
    cwd: directory,
    releaseTag: "v1.2.3",
    requireUnpublished: true,
    execute: git,
  };

  const result = await verifyReleaseMetadata({
    ...options,
    queryRegistry: (packageSpec) => {
      assert.equal(packageSpec, "@lazyingart/lazyedge@1.2.3");
      return { status: 1, stdout: "", stderr: "npm error code E404" };
    },
  });
  assert.equal(result.unpublished, true);

  await assert.rejects(
    verifyReleaseMetadata({
      ...options,
      queryRegistry: () => ({ status: 0, stdout: '"1.2.3"', stderr: "" }),
    }),
    /is already published/u,
  );
  await assert.rejects(
    verifyReleaseMetadata({
      ...options,
      queryRegistry: () => ({ status: 1, stdout: "", stderr: "npm error code E500" }),
    }),
    /Could not safely confirm/u,
  );
});

test("release metadata verifier rejects stale citation and package lock versions", async (context) => {
  const directory = await metadataFixture(context);
  const citationPath = path.join(directory, "CITATION.cff");
  await writeFile(
    citationPath,
    "cff-version: 1.2.0\nversion: 1.2.2\ndate-released: 2026-08-19\n",
  );
  await assert.rejects(
    verifyReleaseMetadata({ cwd: directory }),
    /does not match 1\.2\.3/u,
  );

  await writeFile(
    citationPath,
    "cff-version: 1.2.0\nversion: 1.2.3\ndate-released: 2026-08-19\n",
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    '{"name":"@lazyingart/lazyedge","version":"1.2.2","packages":{"":{"name":"@lazyingart/lazyedge","version":"1.2.2"}}}\n',
  );
  await assert.rejects(
    verifyReleaseMetadata({ cwd: directory }),
    /package-lock\.json does not match/u,
  );
});
