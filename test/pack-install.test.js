import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
).version;

function run(command, args, { cwd = projectRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...env,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return result.stdout.trim();
}

test(
  "packed install retains CLI, checks, tests, and the user-unit path contract",
  { skip: process.env.LAZYEDGE_PACKED_SELFTEST === "1" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-pack-install-"));
    context.after(() => rm(directory, { recursive: true, force: true }));

    const packed = JSON.parse(run("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ]));
    assert.equal(packed.length, 1);
    const rolloutPackagePaths = [
      "docs/rollout-safety.md",
      "src/rollout-authority.js",
      "src/rollout-cli.js",
      "src/rollout-contract.js",
      "src/rollout-journal.js",
      "schemas/edge-rollout.schema.json",
      "test/rollout-authority.test.js",
      "test/rollout-cli.test.js",
      "test/rollout-contract.test.js",
      "test/rollout-journal.test.js",
    ];
    for (const relativePath of rolloutPackagePaths) {
      const entry = packed[0].files.find((file) => file.path === relativePath);
      assert.equal(entry?.mode, 0o644, relativePath);
    }
    const tarball = path.join(directory, packed[0].filename);
    const prefix = path.join(directory, "prefix");
    run("npm", [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      tarball,
    ]);

    const executable = path.join(prefix, "bin", "lazyedge");
    assert.equal(run(executable, ["--version"]), packageVersion);
    const installedRoot = path.join(
      run("npm", ["root", "--global", "--prefix", prefix]),
      "@lazyingart",
      "lazyedge",
    );
    for (const relativePath of rolloutPackagePaths) {
      const info = await lstat(path.join(installedRoot, relativePath));
      assert.equal(info.mode & 0o400, 0o400, relativePath);
    }
    assert.equal(run(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        const authority = await import("@lazyingart/lazyedge/rollout/authority");
        const contract = await import("@lazyingart/lazyedge/rollout/contract");
        const journal = await import("@lazyingart/lazyedge/rollout/journal");
        if (typeof authority.consumeStopPermit !== "function") process.exit(1);
        if (typeof contract.normalizeEdgeRollout !== "function") process.exit(1);
        if (typeof journal.inspectRolloutJournal !== "function") process.exit(1);
        import.meta.resolve("@lazyingart/lazyedge/schemas/edge-rollout.schema.json");
        process.stdout.write("rollout-exports-ok");
      `,
    ], { cwd: installedRoot }), "rollout-exports-ok");
    run("npm", ["run", "check", "--silent"], { cwd: installedRoot });
    run("npm", ["run", "pack:dry-run", "--silent"], { cwd: installedRoot });
    run("npm", ["test", "--silent"], {
      cwd: installedRoot,
      env: { ...process.env, LAZYEDGE_PACKED_SELFTEST: "1" },
    });

    const nodeDirectory = path.dirname(process.execPath);
    const runtimePath = `${nodeDirectory}:${path.join(prefix, "bin")}:/usr/bin`;
    const unit = run(executable, [
      "render",
      "systemd",
      "--config",
      path.join(installedRoot, "examples", "local-llm", "lazyedge.yaml"),
      "--component",
      "worker",
      "--executable",
      executable,
      "--manifest-path",
      "/home/example/.config/lazyedge/lazyedge.yaml",
      "--bindings-path",
      "/home/example/.config/lazyedge/bindings.worker.yaml",
      "--environment-file",
      "/home/example/.config/lazyedge/worker.env",
      "--runtime-path",
      runtimePath,
      "--after-unit",
      "localllm-api.service",
    ]);
    assert.match(unit, new RegExp(`ExecStart=${executable.replaceAll("/", "\\/")}`, "u"));
    assert.match(unit, /--bindings \/home\/example\/\.config\/lazyedge\/bindings\.worker\.yaml/u);
    assert.match(unit, /Environment=PATH=.*\/bin:/u);
    assert.match(unit, /Wants=network-online\.target localllm-api\.service/u);
    assert.match(unit, /After=network-online\.target localllm-api\.service/u);
  },
);
