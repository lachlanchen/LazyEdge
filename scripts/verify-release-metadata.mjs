import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SAFE_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function citationField(source, name, pattern) {
  const expression = new RegExp(`^${name}:\\s*([^\\r\\n]+)$`, "gmu");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1 || !pattern.test(matches[0][1].trim())) {
    throw new Error(`CITATION.cff must contain exactly one valid ${name} field`);
  }
  return matches[0][1].trim();
}

function defaultExecute(command, args, directory) {
  return execFileSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultRegistryQuery(packageSpec, directory) {
  return spawnSync("npm", ["view", packageSpec, "version", "--json"], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function verifyReleaseMetadata({
  cwd = process.cwd(),
  releaseTag,
  requireUnpublished = false,
  execute = defaultExecute,
  queryRegistry = defaultRegistryQuery,
} = {}) {
  const directory = path.resolve(cwd);
  const packageJson = parseJson(
    await readFile(path.join(directory, "package.json"), "utf8"),
    "package.json",
  );
  const packageLock = parseJson(
    await readFile(path.join(directory, "package-lock.json"), "utf8"),
    "package-lock.json",
  );
  const citation = await readFile(path.join(directory, "CITATION.cff"), "utf8");

  if (
    typeof packageJson.name !== "string"
    || !SAFE_PACKAGE_PATTERN.test(packageJson.name)
    || typeof packageJson.version !== "string"
    || !VERSION_PATTERN.test(packageJson.version)
  ) {
    throw new Error("package.json must contain a safe npm name and stable x.y.z version");
  }
  if (
    packageLock.name !== packageJson.name
    || packageLock.version !== packageJson.version
    || packageLock.packages?.[""]?.name !== packageJson.name
    || packageLock.packages?.[""]?.version !== packageJson.version
  ) {
    throw new Error("package-lock.json does not match package.json");
  }

  const citationVersion = citationField(citation, "version", VERSION_PATTERN);
  if (citationVersion !== packageJson.version) {
    throw new Error(`CITATION.cff version ${citationVersion} does not match ${packageJson.version}`);
  }
  const citationDate = citationField(citation, "date-released", /^\d{4}-\d{2}-\d{2}$/u);
  const releasedAt = new Date(`${citationDate}T00:00:00.000Z`);
  if (
    Number.isNaN(releasedAt.getTime())
    || releasedAt.toISOString().slice(0, 10) !== citationDate
  ) {
    throw new Error("CITATION.cff has an invalid date-released field");
  }

  if (releaseTag !== undefined) {
    const expectedTag = `v${packageJson.version}`;
    if (releaseTag !== expectedTag) {
      throw new Error(`Release tag ${releaseTag} does not match ${expectedTag}`);
    }
    const head = execute("git", ["rev-parse", "--verify", "HEAD"], directory);
    const taggedCommit = execute(
      "git",
      ["rev-parse", "--verify", `${releaseTag}^{commit}`],
      directory,
    );
    if (!head || head !== taggedCommit) {
      throw new Error(`Release tag ${releaseTag} does not identify the checked-out commit`);
    }
  }

  if (requireUnpublished) {
    const packageSpec = `${packageJson.name}@${packageJson.version}`;
    const result = queryRegistry(packageSpec, directory);
    if (result?.status === 0) {
      throw new Error(`${packageSpec} is already published`);
    }
    const detail = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
    if (result?.error || !/(?:E404|404 Not Found)/iu.test(detail)) {
      throw new Error("Could not safely confirm that the npm version is unpublished");
    }
  }

  return Object.freeze({
    packageName: packageJson.name,
    version: packageJson.version,
    releaseTag: releaseTag ?? null,
    unpublished: requireUnpublished,
  });
}

function parseArguments(argv) {
  const result = { requireUnpublished: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--require-unpublished") {
      if (result.requireUnpublished) {
        throw new Error("--require-unpublished may be specified only once");
      }
      result.requireUnpublished = true;
      continue;
    }
    if (argv[index] === "--tag" && argv[index + 1] && result.releaseTag === undefined) {
      result.releaseTag = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: verify-release-metadata.mjs [--tag vX.Y.Z] [--require-unpublished]",
    );
  }
  return result;
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyReleaseMetadata(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `Verified ${result.packageName}@${result.version}${result.releaseTag ? ` at ${result.releaseTag}` : ""}${result.unpublished ? " is unpublished" : ""}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `verify-release-metadata: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
