import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SAFE_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_BIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class CommandFailure extends Error {
  constructor(command, args, result) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    super(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
    this.name = "CommandFailure";
    this.command = command;
    this.args = Object.freeze([...args]);
    this.status = result.status;
    this.stdout = result.stdout ?? "";
    this.stderr = result.stderr ?? "";
  }
}

export function createCommandRunner({ cwd, spawnSyncImpl = spawnSync } = {}) {
  const workingDirectory = path.resolve(cwd ?? process.cwd());
  return (command, args, options = {}) => {
    const result = spawnSyncImpl(command, args, {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : "pipe",
    });
    if (result.status !== 0) throw new CommandFailure(command, args, result);
    return result.stdout?.trim() ?? "";
  };
}

function versionParts(value, label) {
  if (!VERSION_PATTERN.test(value)) throw new Error(`Unsupported ${label} version: ${value}`);
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Unsupported ${label} version: ${value}`);
  }
  return parts;
}

export function nextVersion(current, requested) {
  const parts = versionParts(current, "current");
  if (VERSION_PATTERN.test(requested)) {
    versionParts(requested, "requested");
    return requested;
  }
  let result;
  if (requested === "major") result = `${parts[0] + 1}.0.0`;
  if (requested === "minor") result = `${parts[0]}.${parts[1] + 1}.0`;
  if (requested === "patch") result = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  if (requested === "current") return current;
  if (result !== undefined) {
    versionParts(result, "next");
    return result;
  }
  throw new Error("Version must be patch, minor, major, current, or x.y.z");
}

function compareVersions(left, right) {
  const leftParts = versionParts(left, "left");
  const rightParts = versionParts(right, "right");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function parseArguments(argv) {
  const unknownOptions = argv.filter((value) => value.startsWith("--") && value !== "--dry-run");
  if (unknownOptions.length > 0) throw new Error(`Unknown option ${unknownOptions[0]}`);
  const requested = argv.filter((value) => !value.startsWith("--"));
  if (requested.length > 1) throw new Error("Specify at most one version request");
  return {
    dryRun: argv.includes("--dry-run"),
    requested: requested[0] ?? "patch",
  };
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validatePackage(packageJson) {
  if (
    packageJson === null
    || typeof packageJson !== "object"
    || Array.isArray(packageJson)
    || typeof packageJson.name !== "string"
    || !SAFE_PACKAGE_PATTERN.test(packageJson.name)
    || typeof packageJson.version !== "string"
    || !VERSION_PATTERN.test(packageJson.version)
  ) {
    throw new Error("package.json must contain a safe npm name and x.y.z version");
  }
  const bins = typeof packageJson.bin === "string"
    ? [packageJson.name.slice(packageJson.name.lastIndexOf("/") + 1)]
    : Object.keys(packageJson.bin ?? {});
  if (bins.length !== 1 || !SAFE_BIN_PATTERN.test(bins[0])) {
    throw new Error("Release verification requires exactly one safe CLI bin name");
  }
  return bins[0];
}

function validatePackageLock(packageLock, packageJson, version = packageJson.version) {
  if (
    packageLock === null
    || typeof packageLock !== "object"
    || Array.isArray(packageLock)
    || packageLock.name !== packageJson.name
    || packageLock.version !== version
    || packageLock.packages?.[""]?.name !== packageJson.name
    || packageLock.packages?.[""]?.version !== version
  ) {
    throw new Error(`package-lock.json does not match ${packageJson.name}@${version}`);
  }
}

function isRegistryNotFound(error) {
  if (!(error instanceof Error)) return false;
  return [error.message, error.stdout, error.stderr].some(
    (value) => typeof value === "string" && /(?:^|\s)E404(?:\s|$)/u.test(value),
  );
}

function registryVersion(execute, packageName, version) {
  try {
    const result = parseJson(
      execute("npm", ["view", `${packageName}@${version}`, "version", "--json"]),
      "npm view response",
    );
    if (result !== version) {
      throw new Error(`Registry returned an unexpected version for ${packageName}@${version}`);
    }
    return result;
  } catch (error) {
    if (isRegistryNotFound(error)) return null;
    throw error;
  }
}

function assertRecoveryCheckpoint(execute, version) {
  const expectedMessage = `Release v${version}`;
  const head = execute("git", ["rev-parse", "--verify", "HEAD"]);
  const taggedCommit = execute("git", ["rev-list", "-n", "1", `v${version}`]);
  if (!head || taggedCommit !== head) {
    throw new Error(`Recovery requires tag v${version} to point at HEAD`);
  }
  const subject = execute("git", ["log", "-1", "--format=%s"]);
  if (subject !== expectedMessage) {
    throw new Error(`Recovery requires HEAD subject ${JSON.stringify(expectedMessage)}`);
  }
}

async function verifyPublishedPackage({
  execute,
  packageJson,
  target,
  binName,
  mkdtempImpl,
  rmImpl,
}) {
  const found = registryVersion(execute, packageJson.name, target);
  if (found !== target) throw new Error(`${packageJson.name}@${target} is not visible on npm`);

  const prefix = await mkdtempImpl(path.join(os.tmpdir(), "lazyedge-npm-verify-"));
  try {
    execute("npm", [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      `${packageJson.name}@${target}`,
    ]);
    const executable = path.join(prefix, "bin", process.platform === "win32" ? `${binName}.cmd` : binName);
    const installedVersion = execute(executable, ["--version"]);
    if (installedVersion !== target) {
      throw new Error(`Installed ${binName} reported ${JSON.stringify(installedVersion)}, expected ${target}`);
    }
  } finally {
    await rmImpl(prefix, { recursive: true, force: true });
  }
}

function checkpointError(error, version) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}\nRelease v${version} remains committed and tagged. Retry with npm run publish:npm:current.`,
    { cause: error },
  );
}

export async function releaseNpm({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  execute,
  stdout = process.stdout,
  mkdtempImpl = mkdtemp,
  rmImpl = rm,
} = {}) {
  const directory = path.resolve(cwd);
  const command = execute ?? createCommandRunner({ cwd: directory });
  const { dryRun, requested } = parseArguments(argv);

  const status = command("git", ["status", "--porcelain"]);
  if (status) throw new Error("Release requires a clean Git worktree");
  const branch = command("git", ["branch", "--show-current"]);
  if (branch !== "main") throw new Error("Release requires the checked-out main branch");

  const packagePath = path.join(directory, "package.json");
  const lockPath = path.join(directory, "package-lock.json");
  const originalPackage = await readFile(packagePath, "utf8");
  const originalLock = await readFile(lockPath, "utf8");
  const packageJson = parseJson(originalPackage, "package.json");
  const packageLock = parseJson(originalLock, "package-lock.json");
  const binName = validatePackage(packageJson);
  validatePackageLock(packageLock, packageJson);

  const target = nextVersion(packageJson.version, requested);
  const recovery = requested === "current";
  if (!recovery && compareVersions(target, packageJson.version) <= 0) {
    throw new Error("Requested version must be newer; use current only to recover a committed release");
  }
  if (recovery) assertRecoveryCheckpoint(command, target);

  const existing = registryVersion(command, packageJson.name, target);
  if (existing !== null && !recovery) {
    throw new Error(`${packageJson.name}@${target} is already published`);
  }
  if (existing === null) command("npm", ["whoami"]);

  if (dryRun || recovery) {
    command("npm", ["test"], { inherit: true });
    command("npm", ["run", "check"], { inherit: true });
    command("npm", ["run", "pack:dry-run"], { inherit: true });
  }
  if (dryRun) {
    stdout.write(`Dry run passed for ${packageJson.name}@${target}.\n`);
    return Object.freeze({ packageName: packageJson.name, version: target, dryRun: true });
  }

  let checkpointReady = recovery;
  if (!recovery) {
    packageJson.version = target;
    try {
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });
      command("npm", ["install", "--package-lock-only", "--ignore-scripts"], { inherit: true });
      const updatedLock = parseJson(await readFile(lockPath, "utf8"), "package-lock.json");
      validatePackageLock(updatedLock, packageJson, target);
      command("npm", ["test"], { inherit: true });
      command("npm", ["run", "check"], { inherit: true });
      command("npm", ["run", "pack:dry-run"], { inherit: true });
    } catch (error) {
      await writeFile(packagePath, originalPackage, { mode: 0o644 });
      await writeFile(lockPath, originalLock, { mode: 0o644 });
      throw error;
    }
    command("git", ["add", "package.json", "package-lock.json"]);
    command("git", ["commit", "-m", `Release v${target}`], { inherit: true });
    command("git", ["tag", `v${target}`]);
    checkpointReady = true;
  }

  try {
    if (existing === null) command("npm", ["publish", "--access", "public"], { inherit: true });
    await verifyPublishedPackage({
      execute: command,
      packageJson,
      target,
      binName,
      mkdtempImpl,
      rmImpl,
    });
    command("git", ["push", "--atomic", "origin", "main", `v${target}`], { inherit: true });
  } catch (error) {
    if (checkpointReady) throw checkpointError(error, target);
    throw error;
  }

  stdout.write(`Published and verified ${packageJson.name}@${target}.\n`);
  return Object.freeze({ packageName: packageJson.name, version: target, dryRun: false });
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await releaseNpm();
  } catch (error) {
    process.stderr.write(`npm-release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
