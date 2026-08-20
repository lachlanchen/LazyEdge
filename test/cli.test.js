import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { loadBindings, readPrivateText } from "../src/runtime-config.js";

const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

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

test("help and version are deterministic", async () => {
  const help = await invoke(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /lazyedge serve edge .*COMPATIBILITY_ID/u);
  assert.match(help.stdout, /lazyedge serve worker .*--service ID/u);
  assert.match(help.stdout, /doctor .*--role edge\|worker\|all/u);
  assert.equal(help.stderr, "");

  const version = await invoke(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `${packageVersion}\n`);
});

test("init, validate, and plan form a safe first-run path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-cli-"));
  const manifestPath = path.join(directory, "lazyedge.yaml");
  const initialized = await invoke(["init", "--output", manifestPath]);
  assert.equal(initialized.code, 0, initialized.stderr);

  const validated = await invoke(["validate", "--config", manifestPath, "--json"]);
  assert.equal(validated.code, 0, validated.stderr);
  const result = JSON.parse(validated.stdout);
  assert.equal(result.valid, true);
  assert.deepEqual(result.services, ["local-llm"]);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);

  const planned = await invoke(["plan", "--config", manifestPath]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /GET \/v1\/models/u);
  assert.doesNotMatch(planned.stdout, /\/api/u);
});

test("render commands require explicit deployment inputs and emit usable artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-render-"));
  const manifestPath = path.join(directory, "lazyedge.yaml");
  await invoke(["init", "--output", manifestPath]);
  const publicKeyPath = path.join(directory, "id_ed25519.pub");
  await writeFile(
    publicKeyPath,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmVLZXlOb3RTZWNyZXQ test\n",
    { mode: 0o600 },
  );

  const missingKey = await invoke(["render", "accounts", "--config", manifestPath]);
  assert.equal(missingKey.code, 1);
  assert.match(missingKey.stderr, /--public-key-file/u);

  const accounts = await invoke([
    "render", "accounts", "--config", manifestPath, "--public-key-file", publicKeyPath,
  ]);
  assert.equal(accounts.code, 0, accounts.stderr);
  assert.match(accounts.stdout, /PasswordAuthentication no/u);
  assert.match(accounts.stdout, /permitlisten="127\.0\.0\.1:18008"/u);

  await chmod(publicKeyPath, 0o666);
  const writableKey = await invoke([
    "render", "accounts", "--config", manifestPath, "--public-key-file", publicKeyPath,
  ]);
  assert.equal(writableKey.code, 1);
  assert.match(writableKey.stderr, /must not be group\/world writable/u);
  await chmod(publicKeyPath, 0o644);

  const caddy = await invoke([
    "render", "caddy", "--config", manifestPath, "--manual-certificates",
  ]);
  assert.equal(caddy.code, 0, caddy.stderr);
  assert.match(caddy.stdout, /\/etc\/letsencrypt\/live\/llm\.example\.com\/fullchain\.pem/u);

  const systemd = await invoke([
    "render", "systemd", "--config", manifestPath, "--component", "edge",
  ]);
  assert.equal(systemd.code, 0, systemd.stderr);
  assert.match(systemd.stdout, /# --- lazyedge-edge\.service ---/u);
  assert.match(systemd.stdout, /lazyedge serve edge --config/u);

  const worker = await invoke([
    "render", "systemd", "--config", manifestPath, "--component", "worker",
    "--executable", "/home/example/.local/bin/lazyedge",
    "--manifest-path", "/home/example/.config/lazyedge/lazyedge.yaml",
    "--bindings-path", "/home/example/.config/lazyedge/bindings.worker.yaml",
    "--environment-file", "/home/example/.config/lazyedge/worker.env",
    "--runtime-path", "/home/example/.nvm/bin:/home/example/.local/bin:/usr/bin",
    "--after-unit", "localllm-api.service",
  ]);
  assert.equal(worker.code, 0, worker.stderr);
  assert.match(worker.stdout, /ExecStart=\/home\/example\/\.local\/bin\/lazyedge/u);
  assert.match(worker.stdout, /Environment=PATH=\/home\/example\/\.nvm\/bin:/u);
  assert.match(worker.stdout, /Wants=network-online\.target localllm-api\.service/u);

  const missingComponent = await invoke([
    "render", "systemd", "--config", manifestPath,
    "--executable", "/home/example/.local/bin/lazyedge",
  ]);
  assert.equal(missingComponent.code, 1);
  assert.match(missingComponent.stderr, /require one explicit --component/u);

  const redirect = await invoke([
    "render", "systemd", "--config", manifestPath, "--component", "redirect",
  ]);
  assert.equal(redirect.code, 0, redirect.stderr);
  assert.match(redirect.stdout, /# --- lazyedge-port-redirect\.service ---/u);

  const certbot = await invoke([
    "render", "systemd",
    "--config", manifestPath,
    "--component", "certbot",
  ]);
  assert.equal(certbot.code, 0, certbot.stderr);
  assert.match(certbot.stdout, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(certbot.stdout, /^# ---/u);
  assert.match(redirect.stdout, /CapabilityBoundingSet=CAP_NET_ADMIN/u);

  const helper = await invoke([
    "render", "redirect-helper", "--config", manifestPath,
  ]);
  assert.equal(helper.code, 0, helper.stderr);
  assert.match(helper.stdout, /lazyedge-port-redirect \{start\|stop\|status\}/u);

  const nat = await invoke([
    "render", "nat", "--config", manifestPath, "--direction", "apply",
  ]);
  assert.equal(nat.code, 0, nat.stderr);
  assert.match(nat.stdout, /comment "lazyedge-[a-f0-9]{16}"/u);
});

test("doctor exposes split edge and worker roles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-doctor-"));
  const manifestPath = path.join(directory, "lazyedge.yaml");
  await invoke(["init", "--output", manifestPath]);
  const result = await invoke([
    "doctor", "--config", manifestPath, "--role", "worker", "--json",
  ]);
  // The default loopback listeners may belong to a live LazyEdge deployment
  // on a release workstation. This test is about role scoping, not ambient
  // service availability.
  assert([0, 1].includes(result.code));
  const report = JSON.parse(result.stdout);
  assert.equal(report.role, "worker");
  assert(report.checks.every((entry) => !entry.id.startsWith("edge-")));
});

test("edge service selection cannot imply undeclared gateway isolation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-edge-service-"));
  const manifestPath = path.join(directory, "lazyedge.yaml");
  await invoke(["init", "--output", manifestPath]);
  const source = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    source.replace(/^\s*compatibilityListen:.*\n/mu, ""),
    { mode: 0o600 },
  );
  const result = await invoke([
    "serve", "edge",
    "--config", manifestPath,
    "--bindings", path.join(directory, "missing-bindings.yaml"),
    "--service", "local-llm",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /only with spec\.edge\.compatibilityListen/u);
  assert.doesNotMatch(result.stderr, /missing-bindings/u);
});

test("token lifecycle writes raw token only to the requested private file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-"));
  const storePath = path.join(directory, "tokens.json");
  const tokenPath = path.join(directory, "client.token");
  const issued = await invoke([
    "token", "issue",
    "--store", storePath,
    "--set", "local-llm-users",
    "--service", "local-llm",
    "--days", "7",
    "--out", tokenPath,
  ]);
  assert.equal(issued.code, 0, issued.stderr);
  const metadata = JSON.parse(issued.stdout);
  const rawToken = (await readFile(tokenPath, "utf8")).trim();
  const store = await readFile(storePath, "utf8");
  assert.match(rawToken, /^le1_/u);
  assert.equal(store.includes(rawToken), false);
  assert.equal(issued.stdout.includes(rawToken), false);

  const listed = await invoke(["token", "list", "--store", storePath, "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout)[0].id, metadata.id);

  const revoked = await invoke(["token", "revoke", "--store", storePath, "--id", metadata.id]);
  assert.equal(revoked.code, 0, revoked.stderr);
});

test("token issue accepts only normalized exact multi-axis scopes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-scope-"));
  const storePath = path.join(directory, "tokens.json");
  const tokenPath = path.join(directory, "client.token");
  const issued = await invoke([
    "token", "issue",
    "--store", storePath,
    "--set", "local-llm-users",
    "--service", "local-llm",
    "--hosts", "llm.example.com",
    "--methods", "GET,POST",
    "--paths", "/v1/models,/v1/chat/completions",
    "--out", tokenPath,
  ]);
  assert.equal(issued.code, 0, issued.stderr);
  const stored = JSON.parse(await readFile(storePath, "utf8"));
  assert.deepEqual(stored.tokens[0].scope, {
    serviceIds: ["local-llm"],
    hosts: ["llm.example.com"],
    methods: ["GET", "POST"],
    paths: ["/v1/chat/completions", "/v1/models"],
  });

  for (const [name, value, pattern] of [
    ["methods", "GET,GET", /duplicates/u],
    ["hosts", "*.example.com", /exact DNS name/u],
    ["paths", "/v1/models,", /without blanks/u],
  ]) {
    const rejected = await invoke([
      "token", "issue",
      "--store", storePath,
      "--set", "local-llm-users",
      `--${name}`, value,
      "--out", path.join(directory, `rejected-${name}.token`),
    ]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, pattern);
  }
  assert.equal(JSON.parse(await readFile(storePath, "utf8")).tokens.length, 1);

  const occupied = path.join(directory, "occupied.token");
  await writeFile(occupied, "owner-data\n", { mode: 0o600 });
  const refusedOutput = await invoke([
    "token", "issue",
    "--store", storePath,
    "--set", "local-llm-users",
    "--out", occupied,
  ]);
  assert.equal(refusedOutput.code, 1);
  assert.equal(JSON.parse(await readFile(storePath, "utf8")).tokens.length, 1);
});

test("secret generation writes only to a private file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-secret-"));
  const secretPath = path.join(directory, "relay");
  const generated = await invoke([
    "secret", "generate", "--out", secretPath, "--prefix", "relay",
  ]);
  assert.equal(generated.code, 0, generated.stderr);
  const value = (await readFile(secretPath, "utf8")).trim();
  assert.match(value, /^relay_/u);
  assert.equal(generated.stdout.includes(value), false);
});

test("secret import-env copies one private value without printing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-import-env-"));
  const envPath = path.join(directory, ".env");
  const secretPath = path.join(directory, "upstream-key");
  const value = "private-upstream-capability-0123456789";
  await writeFile(envPath, `IGNORED=value\nLOCALLLM_API_KEY=${value}\n`, { mode: 0o600 });
  const imported = await invoke([
    "secret", "import-env",
    "--env-file", envPath,
    "--name", "LOCALLLM_API_KEY",
    "--out", secretPath,
  ]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal((await readFile(secretPath, "utf8")).trim(), value);
  assert.equal(imported.stdout.includes(value), false);
  assert.equal(JSON.parse(imported.stdout).source, "import-env");
});

test("secret sync-env atomically replaces a private value without printing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-sync-env-"));
  const envPath = path.join(directory, ".env");
  const valuePath = path.join(directory, "next-key");
  const nextValue = "llm_0123456789abcdefghijklmnopqrstuvwxyz";
  await writeFile(envPath, "OTHER=kept\nLOCALLLM_API_KEY=old-value\n", { mode: 0o600 });
  await writeFile(valuePath, `${nextValue}\n`, { mode: 0o600 });
  const synced = await invoke([
    "secret", "sync-env",
    "--env-file", envPath,
    "--name", "LOCALLLM_API_KEY",
    "--value-file", valuePath,
  ]);
  assert.equal(synced.code, 0, synced.stderr);
  const updated = await readFile(envPath, "utf8");
  assert.match(updated, /^OTHER=kept$/mu);
  assert.match(updated, /^LOCALLLM_API_KEY=llm_0123456789abcdefghijklmnopqrstuvwxyz$/mu);
  assert.equal(synced.stdout.includes(nextValue), false);
});

test("private runtime inputs reject world-readable files and symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-private-"));
  const secret = path.join(directory, "secret");
  await writeFile(secret, "a-secure-relay-capability\n", { mode: 0o600 });
  assert.equal(await readPrivateText(secret), "a-secure-relay-capability");

  await chmod(secret, 0o604);
  await assert.rejects(readPrivateText(secret), /other users/u);
  await chmod(secret, 0o600);
  const linked = path.join(directory, "linked");
  await symlink(secret, linked);
  await assert.rejects(readPrivateText(linked), /non-symlink/u);

  const bindingsPath = path.join(directory, "bindings.yaml");
  await writeFile(bindingsPath, "bindings: {}\n", { mode: 0o600 });
  assert.equal((await loadBindings(bindingsPath)).size, 0);
  await chmod(bindingsPath, 0o644);
  await assert.rejects(loadBindings(bindingsPath), /other users/u);
});
