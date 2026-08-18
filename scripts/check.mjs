import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roots = ["bin", "src", "scripts", "test"];
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
}

for (const root of roots) {
  try {
    await collect(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

for (const file of files.sort()) {
  const text = await readFile(file, "utf8");
  if (text.includes("\r\n")) throw new Error(`${file}: CRLF is not allowed`);
  if (/[ \t]+$/m.test(text)) throw new Error(`${file}: trailing whitespace`);
  const checked = spawnSync(process.execPath, ["--check", path.resolve(file)], {
    encoding: "utf8",
  });
  if (checked.status !== 0) {
    throw new Error(`${file}: syntax check failed\n${checked.stderr}`);
  }
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const schema = JSON.parse(await readFile("schemas/lazyedge.schema.json", "utf8"));
const sshHostPattern = new RegExp(schema.$defs.transport.properties.sshHost.pattern, "u");
const hostKeyAliasPattern = new RegExp(
  schema.$defs.transport.properties.hostKeyAlias.pattern,
  "u",
);
for (const unsafe of ["bad host", "bad/host", "bad@host", "bad:host"]) {
  if (sshHostPattern.test(unsafe)) throw new Error(`Schema accepts unsafe sshHost ${unsafe}`);
}
for (const unsafe of ["bad alias", "bad/alias", "bad@alias", "bad:alias"]) {
  if (hostKeyAliasPattern.test(unsafe)) {
    throw new Error(`Schema accepts unsafe hostKeyAlias ${unsafe}`);
  }
}

for (const required of [
  "README.md",
  "LICENSE",
  "bin/lazyedge.mjs",
  "examples/local-llm/lazyedge.yaml",
]) {
  await access(required);
}

const sshdTemplate = await readFile(
  "templates/ssh/sshd_config.d/60-lazyedge-tunnel.conf.tmpl",
  "utf8",
);
if (!sshdTemplate.trimEnd().endsWith("Match all")) {
  throw new Error("Packaged sshd template must close its Match block");
}
const packagedTemplates = await Promise.all([
  "templates/systemd/lazyedge-caddy.service.tmpl",
  "templates/systemd/lazyedge-edge.service.tmpl",
  "templates/systemd/lazyedge-worker.service.tmpl",
].map((file) => readFile(file, "utf8")));
if (packagedTemplates.some((text) => text.includes("--environ"))) {
  throw new Error("Packaged service templates must not dump process environments");
}
if (packagedTemplates.some((text) => /--bindings .*\/bindings\.yaml(?:\s|$)/u.test(text))) {
  throw new Error("Packaged service templates must use role-specific bindings");
}

const packedRoots = new Set(packageJson.files ?? []);
if ([...packedRoots].some((entry) => entry.includes("private"))) {
  throw new Error("package.json files allowlist must not include private paths");
}
for (const requiredRoot of ["scripts/", "test/"]) {
  if (!packedRoots.has(requiredRoot)) {
    throw new Error(`package.json files allowlist must include ${requiredRoot}`);
  }
}
const expectedReleaseScripts = {
  "release:npm": "node scripts/npm-release.mjs",
  "release:npm:dry-run": "node scripts/npm-release.mjs patch --dry-run",
  "publish:npm:current": "node scripts/npm-release.mjs current",
};
for (const [name, value] of Object.entries(expectedReleaseScripts)) {
  if (packageJson.scripts?.[name] !== value) {
    throw new Error(`package.json must retain the reviewed ${name} command`);
  }
}
for (const required of [
  "scripts/npm-release.mjs",
  "test/npm-release.test.js",
  "test/pack-install.test.js",
]) {
  await access(required);
}

process.stdout.write(`Checked ${files.length} JavaScript files and release metadata.\n`);
