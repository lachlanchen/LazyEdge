import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TokenStore } from "../src/token-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "bin", "lazyedge.mjs");
const tokenStoreUrl = new URL("../src/token-store.js", import.meta.url).href;
const raceChildSource = `
  import process from "node:process";
  import { TokenStore } from ${JSON.stringify(tokenStoreUrl)};
  try {
    const store = await TokenStore.open({ filePath: process.env.LAZYEDGE_RACE_STORE });
    process.send?.({ type: "ready" });
    await new Promise((resolve) => process.once("message", resolve));
    if (process.env.LAZYEDGE_RACE_ROLE === "issue") {
      await store.issue({ tokenSet: "personal", expiresInSeconds: 300 });
    } else if (process.env.LAZYEDGE_RACE_ROLE === "revoke") {
      if (!await store.revoke(process.env.LAZYEDGE_RACE_TOKEN_ID)) {
        throw new Error("revoke did not change a token");
      }
    } else {
      throw new Error("unknown race role");
    }
    process.send?.({ type: "done" });
  } catch (error) {
    process.send?.({ type: "error", name: error.name, message: error.message });
    process.exitCode = 1;
  }
`;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function startRaceChild(role, storePath, tokenId) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", raceChildSource], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      LAZYEDGE_RACE_ROLE: role,
      LAZYEDGE_RACE_STORE: storePath,
      LAZYEDGE_RACE_TOKEN_ID: tokenId ?? "",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.on("message", (message) => {
      if (message?.type === "ready") resolve();
      if (message?.type === "error") {
        reject(new Error(`${message.name}: ${message.message}`));
      }
    });
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`race child failed (${code ?? signal}): ${stderr}`));
    });
  });
  return {
    ready,
    done,
    release: () => child.send({ type: "go" }),
  };
}

async function waitFor(check, { timeoutMs = 1_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error("condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("twenty concurrent CLI token issues retain every digest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-cli-race-"));
  const storePath = path.join(directory, "tokens.json");
  const tokenPaths = Array.from(
    { length: 20 },
    (_, index) => path.join(directory, `client-${index}.token`),
  );

  const results = await Promise.all(tokenPaths.map((tokenPath) => runCli([
    "token",
    "issue",
    "--store",
    storePath,
    "--set",
    "personal",
    "--days",
    "1",
    "--out",
    tokenPath,
  ])));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
  }

  const store = await TokenStore.open({ filePath: storePath });
  assert.equal(store.list().length, 20);
  const serialized = await readFile(storePath, "utf8");
  for (const tokenPath of tokenPaths) {
    const token = (await readFile(tokenPath, "utf8")).trim();
    assert.match(token, /^le1_/u);
    assert.equal(serialized.includes(token), false);
  }
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  await assert.rejects(lstat(`${storePath}.lock`), { code: "ENOENT" });
}, { timeout: 20_000 });

test("an issue and revoke from pre-opened child processes merge under one lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-op-race-"));
  const storePath = path.join(directory, "tokens.json");
  const initialStore = await TokenStore.open({ filePath: storePath });
  const initial = await initialStore.issue({
    tokenSet: "personal",
    expiresInSeconds: 300,
  });

  const issuer = startRaceChild("issue", storePath);
  const revoker = startRaceChild("revoke", storePath, initial.id);
  await Promise.all([issuer.ready, revoker.ready]);
  issuer.release();
  revoker.release();
  await Promise.all([issuer.done, revoker.done]);

  const finalStore = await TokenStore.open({ filePath: storePath });
  const records = finalStore.list();
  assert.equal(records.length, 2);
  assert.notEqual(records.find((record) => record.id === initial.id)?.revokedAt, null);
  assert.equal(records.filter((record) => record.revokedAt === null).length, 1);
});

test("long-lived stores observe externally issued and revoked tokens", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-refresh-"));
  const storePath = path.join(directory, "tokens.json");
  const liveStore = await TokenStore.open({ filePath: storePath });
  const first = await liveStore.issue({ tokenSet: "personal", expiresInSeconds: 300 });

  const writer = await TokenStore.open({ filePath: storePath });
  assert.equal(await writer.revoke(first.id), true);
  await waitFor(async () => (
    await liveStore.verify(first.token, { tokenSet: "personal" }) === null
  ));

  const second = await writer.issue({ tokenSet: "personal", expiresInSeconds: 300 });
  await waitFor(async () => (
    (await liveStore.verify(second.token, { tokenSet: "personal" }))?.id === second.id
  ));
  assert.equal(liveStore.list().length, 2);
});

test("malformed floods do no store I/O and valid-shaped floods coalesce refresh", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-auth-flood-"));
  const storePath = path.join(directory, "tokens.json");
  const store = await TokenStore.open({ filePath: storePath });
  const issued = await store.issue({ tokenSet: "personal", expiresInSeconds: 300 });
  await chmod(storePath, 0o644);

  const malformed = await Promise.all(Array.from(
    { length: 2_000 },
    () => store.verify("malformed-bearer", { tokenSet: "personal" }),
  ));
  assert.ok(malformed.every((result) => result === null));

  await new Promise((resolve) => setTimeout(resolve, 120));
  const coalesced = await Promise.allSettled(Array.from(
    { length: 2_000 },
    () => store.verify(issued.token, { tokenSet: "personal" }),
  ));
  const rejected = coalesced.filter((result) => result.status === "rejected");
  assert.ok(rejected.length >= 1 && rejected.length <= 33);
  assert.ok(coalesced
    .filter((result) => result.status === "fulfilled")
    .every((result) => result.value === null));
});

test("a concurrent verification burst cannot bypass an external revoke", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-revoke-burst-"));
  const storePath = path.join(directory, "tokens.json");
  const liveStore = await TokenStore.open({ filePath: storePath });
  const issued = await liveStore.issue({ tokenSet: "personal", expiresInSeconds: 300 });
  const writer = await TokenStore.open({ filePath: storePath });
  assert.equal(await writer.revoke(issued.id), true);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const results = await Promise.all(Array.from(
    { length: 2_000 },
    () => liveStore.verify(issued.token, { tokenSet: "personal" }),
  ));
  assert.ok(results.every((result) => result === null));
});

test("orphaned stale and dead-owner locks recover without weakening file mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-token-lock-recovery-"));
  const storePath = path.join(directory, "tokens.json");
  const store = await TokenStore.open({ filePath: storePath });
  const lockPath = `${storePath}.lock`;

  await mkdir(lockPath, { mode: 0o700 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await store.issue({ tokenSet: "personal", expiresInSeconds: 300 });

  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    version: 1,
    ownerId: "d".repeat(32),
    pid: 2_147_483_647,
    hostname: hostname(),
    processIdentity: null,
    acquiredAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  await store.issue({ tokenSet: "personal", expiresInSeconds: 300 });

  await mkdir(lockPath, { mode: 0o700 });
  const deadReaper = {
    version: 1,
    ownerId: "e".repeat(32),
    pid: 2_147_483_647,
    hostname: hostname(),
    processIdentity: null,
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  };
  await writeFile(
    path.join(lockPath, ".reap"),
    `${JSON.stringify(deadReaper)}\n`,
    { mode: 0o600 },
  );
  await utimes(path.join(lockPath, ".reap"), old, old);
  await utimes(lockPath, old, old);
  await store.issue({ tokenSet: "personal", expiresInSeconds: 300 });

  assert.equal(store.list().length, 3);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
}, { timeout: 4_000 });
