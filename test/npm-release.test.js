import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nextVersion, releaseNpm } from "../scripts/npm-release.mjs";

async function fixture(context, version = "1.2.3") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-release-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packageJson = {
    name: "@lazyingart/lazyedge",
    version,
    type: "module",
    bin: { lazyedge: "bin/lazyedge.mjs" },
  };
  const packageLock = {
    name: packageJson.name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageJson.name,
        version,
      },
    },
  };
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    `${JSON.stringify(packageLock, null, 2)}\n`,
  );
  return directory;
}

function failure(message, details = {}) {
  return Object.assign(new Error(message), details);
}

function fakeCommands(directory, {
  currentVersion = "1.2.3",
  publishedVersion = null,
  publishFailures = 0,
  releaseCheckpoint = false,
  tagTarget,
  installedVersion,
} = {}) {
  const state = {
    branch: "main",
    calls: [],
    commitCount: 0,
    head: releaseCheckpoint ? `head-release-${currentVersion}` : "head-before-release",
    installCount: 0,
    publishCount: 0,
    publishFailures,
    publishedVersion,
    pushCount: 0,
    subject: releaseCheckpoint ? `Release v${currentVersion}` : "Development snapshot",
    tags: new Map(
      releaseCheckpoint
        ? [[`v${currentVersion}`, tagTarget ?? `head-release-${currentVersion}`]]
        : [],
    ),
  };

  const execute = (command, args) => {
    state.calls.push({ command, args: [...args] });
    if (command.endsWith("/bin/lazyedge") || command.endsWith("\\bin\\lazyedge.cmd")) {
      assert.deepEqual(args, ["--version"]);
      return installedVersion ?? state.publishedVersion ?? "";
    }
    if (command === "git" && args.join(" ") === "status --porcelain") return "";
    if (command === "git" && args.join(" ") === "branch --show-current") return state.branch;
    if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") return state.head;
    if (command === "git" && args[0] === "rev-list") {
      const target = state.tags.get(args.at(-1));
      if (!target) throw failure("git rev-list failed", { stderr: "unknown revision" });
      return target;
    }
    if (command === "git" && args.join(" ") === "log -1 --format=%s") return state.subject;
    if (command === "git" && args[0] === "add") return "";
    if (command === "git" && args[0] === "commit") {
      const message = args[args.indexOf("-m") + 1];
      state.commitCount += 1;
      state.subject = message;
      state.head = `head-${message.replaceAll(" ", "-")}`;
      return "";
    }
    if (command === "git" && args[0] === "tag") {
      const name = args[1];
      if (state.tags.has(name)) throw failure("git tag failed", { stderr: "tag already exists" });
      state.tags.set(name, state.head);
      return "";
    }
    if (command === "git" && args[0] === "push") {
      state.pushCount += 1;
      return "";
    }
    if (command === "npm" && args[0] === "view") {
      const requested = args[1].slice(args[1].lastIndexOf("@") + 1);
      if (state.publishedVersion === requested) return JSON.stringify(requested);
      throw failure("npm view failed E404", { stderr: "npm error code E404" });
    }
    if (command === "npm" && args[0] === "whoami") return "release-tester";
    if (command === "npm" && args.join(" ") === "test") return "";
    if (command === "npm" && args.join(" ") === "run check") return "";
    if (command === "npm" && args.join(" ") === "run pack:dry-run") return "";
    if (command === "npm" && args[0] === "install" && args.includes("--package-lock-only")) {
      const packageJson = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      const lockPath = path.join(directory, "package-lock.json");
      const packageLock = JSON.parse(readFileSync(lockPath, "utf8"));
      packageLock.version = packageJson.version;
      packageLock.packages[""].version = packageJson.version;
      writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
      return "";
    }
    if (command === "npm" && args[0] === "publish") {
      state.publishCount += 1;
      if (state.publishFailures > 0) {
        state.publishFailures -= 1;
        throw failure("npm publish failed E401", { stderr: "npm error code E401" });
      }
      state.publishedVersion = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      ).version;
      return "";
    }
    if (command === "npm" && args[0] === "install" && args.includes("--global")) {
      state.installCount += 1;
      return "";
    }
    throw new Error(`Unexpected fake command: ${command} ${args.join(" ")}`);
  };

  return { execute, state };
}

function outputSink() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += String(chunk); } },
    text: () => value,
  };
}

test("version selection is strict and deterministic", () => {
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.3", "2.4.6"), "2.4.6");
  assert.equal(nextVersion("1.2.3", "current"), "1.2.3");
  assert.throws(() => nextVersion("01.2.3", "patch"), /Unsupported/u);
  assert.throws(() => nextVersion("9007199254740991.0.0", "major"), /Unsupported/u);
  assert.throws(() => nextVersion("1.2.3", "prerelease"), /Version must/u);
});

test("current recovers a failed publish without another commit or tag", async (context) => {
  const directory = await fixture(context);
  const fake = fakeCommands(directory, { publishFailures: 1 });
  const firstOutput = outputSink();
  await assert.rejects(
    releaseNpm({ argv: ["patch"], cwd: directory, execute: fake.execute, stdout: firstOutput.stream }),
    /Retry with npm run publish:npm:current/u,
  );
  assert.equal(fake.state.commitCount, 1);
  assert.equal(fake.state.tags.size, 1);
  assert.equal(fake.state.publishCount, 1);
  assert.equal(fake.state.pushCount, 0);
  assert(fake.state.calls.some(({ command, args }) => command === "npm" && args.join(" ") === "run check"));
  assert.equal(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).version, "1.2.4");

  const recoveryCallsStart = fake.state.calls.length;
  const recoveryOutput = outputSink();
  const recovered = await releaseNpm({
    argv: ["current"],
    cwd: directory,
    execute: fake.execute,
    stdout: recoveryOutput.stream,
  });
  assert.equal(recovered.version, "1.2.4");
  assert.equal(fake.state.commitCount, 1);
  assert.equal(fake.state.tags.size, 1);
  assert.equal(fake.state.publishCount, 2);
  assert.equal(fake.state.installCount, 1);
  assert.equal(fake.state.pushCount, 1);
  assert.match(recoveryOutput.text(), /Published and verified/u);
  assert(
    fake.state.calls.some(
      ({ command, args }) => command === "git" && args.join(" ") === "push --atomic origin main v1.2.4",
    ),
  );
  const recoveryCalls = fake.state.calls.slice(recoveryCallsStart);
  assert.equal(recoveryCalls.some(({ command, args }) => command === "git" && args[0] === "commit"), false);
  assert.equal(recoveryCalls.some(({ command, args }) => command === "git" && args[0] === "tag"), false);
});

test("current refuses a tag that does not identify the release HEAD", async (context) => {
  const directory = await fixture(context);
  const fake = fakeCommands(directory, {
    releaseCheckpoint: true,
    tagTarget: "different-commit",
  });
  await assert.rejects(
    releaseNpm({ argv: ["current"], cwd: directory, execute: fake.execute }),
    /tag v1\.2\.3 to point at HEAD/u,
  );
  assert.equal(fake.state.calls.some(({ command }) => command === "npm"), false);
});

test("current resumes post-publish verification and push without republishing", async (context) => {
  const directory = await fixture(context);
  const fake = fakeCommands(directory, {
    publishedVersion: "1.2.3",
    releaseCheckpoint: true,
  });
  const result = await releaseNpm({
    argv: ["current"],
    cwd: directory,
    execute: fake.execute,
    stdout: outputSink().stream,
  });
  assert.equal(result.version, "1.2.3");
  assert.equal(fake.state.publishCount, 0);
  assert.equal(fake.state.installCount, 1);
  assert.equal(fake.state.pushCount, 1);
  assert.equal(
    fake.state.calls.some(({ command, args }) => command === "npm" && args[0] === "whoami"),
    false,
  );
});

test("dry-run performs checks without changing release state", async (context) => {
  const directory = await fixture(context);
  const fake = fakeCommands(directory);
  const beforePackage = await readFile(path.join(directory, "package.json"), "utf8");
  const beforeLock = await readFile(path.join(directory, "package-lock.json"), "utf8");
  const output = outputSink();
  const result = await releaseNpm({
    argv: ["minor", "--dry-run"],
    cwd: directory,
    execute: fake.execute,
    stdout: output.stream,
  });
  assert.equal(result.version, "1.3.0");
  assert.equal(result.dryRun, true);
  assert.equal(fake.state.commitCount, 0);
  assert.equal(fake.state.publishCount, 0);
  assert.equal(fake.state.pushCount, 0);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), beforePackage);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), beforeLock);
  assert.match(output.text(), /Dry run passed/u);
});

test("an explicit version must move forward", async (context) => {
  const directory = await fixture(context);
  const fake = fakeCommands(directory);
  await assert.rejects(
    releaseNpm({ argv: ["1.2.2"], cwd: directory, execute: fake.execute }),
    /must be newer/u,
  );
  assert.equal(fake.state.calls.some(({ command }) => command === "npm"), false);
});

test("a failed installed-version check never pushes the checkpoint", async (context) => {
  const directory = await fixture(context);
  const fake = fakeCommands(directory, {
    installedVersion: "9.9.9",
    publishedVersion: "1.2.3",
    releaseCheckpoint: true,
  });
  await assert.rejects(
    releaseNpm({ argv: ["current"], cwd: directory, execute: fake.execute }),
    /reported "9\.9\.9"/u,
  );
  assert.equal(fake.state.pushCount, 0);
  assert.equal(fake.state.publishCount, 0);
});
