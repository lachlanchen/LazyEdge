import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import { hashChatPassword, startChatServer } from "../src/chat-server.js";
import { ChatSessionStore } from "../src/chat-session-store.js";
import { sha256 } from "../src/security.js";

function baseManifest() {
  return {
    apiVersion: "lazyedge.lazying.art/v1alpha1",
    kind: "EdgeProject",
    metadata: { name: "remembered-chat-test" },
    spec: {
      edge: {
        gatewayListen: "127.0.0.1:17600",
        compatibilityListen: "127.0.0.1:18080",
        compatibilityService: "local-llm",
        httpPort: 10080,
        httpsPort: 10443,
      },
      transport: {
        provider: "openssh-reverse",
        sshHost: "edge.example.test",
        sshUser: "lazyedge-tunnel",
        sshPort: 22,
      },
      services: [{
        id: "local-llm",
        profile: "localllm-openai",
        domains: ["llm.example.test"],
        edge: { upstream: "http://127.0.0.1:18008" },
        worker: {
          listen: "127.0.0.1:17800",
          target: "http://127.0.0.1:8008",
          healthPath: "/healthz",
        },
        public: {
          tokenSet: "local-llm-users",
          maxBodyBytes: 1024 * 1024,
          maxConcurrentRequests: 4,
          idleTimeoutSeconds: 60,
          routes: [
            { path: "/v1/models", methods: ["GET"] },
            { path: "/v1/chat/completions", methods: ["POST"] },
          ],
        },
        chat: { username: "operator" },
      }],
    },
  };
}

async function privateDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-chat-session-"));
  await chmod(directory, 0o700);
  return directory;
}

function browserHeaders(extra = {}) {
  return {
    host: "llm.example.test",
    origin: "https://llm.example.test",
    "x-lazyedge-client-address": "198.51.100.90",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra,
  };
}

function request(base, requestPath, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path: requestPath,
      method,
      headers,
      agent: false,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function cookieHeader(setCookie) {
  return setCookie.map((value) => value.split(";", 1)[0]).join("; ");
}

async function login(chat, password, remember) {
  return request(chat.url, "/chat/api/login", {
    method: "POST",
    headers: browserHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: "operator", password, remember }),
  });
}

function serverOptions({ passwordHash, secret, storePath }) {
  return {
    manifest: baseManifest(),
    serviceId: "local-llm",
    passwordHash,
    clientToken: randomBytes(48).toString("base64url"),
    listen: "127.0.0.1:0",
    rememberSessionStorePath: storePath,
    rememberSessionSecret: secret,
  };
}

test("remembered login survives a BFF restart while an ordinary login stays memory-only", async () => {
  const directory = await privateDirectory();
  const storePath = path.join(directory, "sessions.json");
  const password = randomBytes(32).toString("base64url");
  const passwordHash = await hashChatPassword(password);
  const secret = randomBytes(32).toString("base64url");
  const options = serverOptions({ passwordHash, secret, storePath });
  let first;
  let second;
  try {
    first = await startChatServer(options);
    const ordinary = await login(first, password, false);
    assert.equal(ordinary.status, 200, ordinary.body);
    assert.equal(JSON.parse(ordinary.body).remembered, false);
    await assert.rejects(() => lstat(storePath), { code: "ENOENT" });

    const remembered = await login(first, password, true);
    assert.equal(remembered.status, 200, remembered.body);
    assert.equal(JSON.parse(remembered.body).remembered, true);
    assert.match(
      remembered.headers["set-cookie"][0],
      /Max-Age=7776000/u,
    );
    const ordinaryCookies = cookieHeader(ordinary.headers["set-cookie"]);
    const rememberedCookies = cookieHeader(remembered.headers["set-cookie"]);
    const csrf = JSON.parse(remembered.body).csrfToken;
    await first.close();
    first = null;

    second = await startChatServer(options);
    assert.equal((await request(second.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: ordinaryCookies },
    })).status, 401);
    const resumed = await request(second.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: rememberedCookies },
    });
    assert.equal(resumed.status, 200, resumed.body);
    assert.equal(JSON.parse(resumed.body).remembered, true);

    const contents = await readFile(storePath, "utf8");
    assert.equal(contents.includes(password), false);
    assert.equal(contents.includes(passwordHash), false);
    assert.equal(contents.includes(secret), false);
    for (const value of rememberedCookies.split("; ").map((entry) => entry.split("=")[1])) {
      assert.equal(contents.includes(value), false);
    }
    assert.equal((await lstat(storePath)).mode & 0o777, 0o600);

    const logout = await request(second.url, "/chat/api/logout", {
      method: "POST",
      headers: browserHeaders({
        cookie: rememberedCookies,
        "x-lazyedge-csrf": csrf,
      }),
    });
    assert.equal(logout.status, 200, logout.body);
    await second.close();
    second = await startChatServer(options);
    assert.equal((await request(second.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: rememberedCookies },
    })).status, 401);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remembered-session secret and password-verifier rotation both invalidate old cookies", async () => {
  const directory = await privateDirectory();
  const filePath = path.join(directory, "sessions.json");
  const secret = randomBytes(32).toString("base64url");
  const passwordHash = `binding-${randomBytes(32).toString("base64url")}`;
  try {
    const original = await ChatSessionStore.open({ filePath, secret, passwordHash });
    const session = await original.create("a".repeat(64));
    assert(await original.verify(session.raw));

    const secretRotated = await ChatSessionStore.open({
      filePath,
      secret: randomBytes(32).toString("base64url"),
      passwordHash,
    });
    assert.equal(await secretRotated.verify(session.raw), null);

    const passwordRotated = await ChatSessionStore.open({
      filePath,
      secret,
      passwordHash: `binding-${randomBytes(32).toString("base64url")}`,
    });
    assert.equal(await passwordRotated.verify(session.raw), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the session store refreshes across instances and concurrent mutations do not resurrect sessions", async () => {
  const directory = await privateDirectory();
  const filePath = path.join(directory, "sessions.json");
  const options = {
    filePath,
    secret: randomBytes(32).toString("base64url"),
    passwordHash: `binding-${randomBytes(32).toString("base64url")}`,
    maxSessions: 4,
  };
  try {
    const left = await ChatSessionStore.open(options);
    const right = await ChatSessionStore.open(options);
    const first = await left.create("a".repeat(64));
    assert(await right.verify(first.raw));
    assert.equal(await right.revokeDigest(first.record.digest), true);
    assert.equal(await left.verify(first.raw), null);

    const issued = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      (index % 2 === 0 ? left : right).create(index.toString(16).padStart(64, "0"))
    )));
    const active = await left.listActive();
    assert.equal(active.length, 4);
    assert.equal(new Set(active.map((record) => record.digest)).size, 4);
    assert.equal(issued.some((entry) => active.some((record) => (
      record.digest === entry.record.digest
    ))), true);
    assert.deepEqual(
      (await Promise.all(issued.map((entry) => left.verify(entry.raw))))
        .filter(Boolean)
        .map((record) => record.digest)
        .sort(),
      active.map((record) => record.digest).sort(),
    );
    assert.deepEqual((await readdir(directory)).sort(), ["sessions.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a crashed store lock is quarantined once and cannot consume a delayed successor", async () => {
  const directory = await privateDirectory();
  const filePath = path.join(directory, "sessions.json");
  const lockPath = `${filePath}.lock`;
  const options = {
    filePath,
    secret: randomBytes(32).toString("base64url"),
    passwordHash: `binding-${randomBytes(32).toString("base64url")}`,
    maxSessions: 4,
  };
  try {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1,
      ownerId: "f".repeat(32),
      pid: 2_147_483_647,
      hostname: hostname(),
      processIdentity: null,
    })}\n`, { mode: 0o600 });
    const stores = await Promise.all(Array.from({ length: 8 }, () => (
      ChatSessionStore.open(options)
    )));
    await Promise.all(stores.map((store, index) => (
      store.create(index.toString(16).padStart(64, "0"))
    )));
    const entries = await readdir(directory);
    assert.equal(entries.includes("sessions.json.lock"), false);
    assert.equal(entries.filter((entry) => entry.startsWith("sessions.json.lock.stale.")).length, 1);
    assert.equal((await stores[0].listActive()).length, 4);
    const successor = await stores[1].create("e".repeat(64));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert(await stores[2].verify(successor.raw));
    assert.equal((await readdir(directory)).includes("sessions.json.lock"), false);

    const old = new Date(Date.now() - 60_000);
    await mkdir(lockPath, { mode: 0o700 });
    await utimes(lockPath, old, old);
    await stores[3].create("d".repeat(64));

    await mkdir(lockPath, { mode: 0o700 });
    const deadReaper = {
      version: 1,
      ownerId: "c".repeat(32),
      pid: 2_147_483_647,
      hostname: hostname(),
      processIdentity: null,
    };
    await writeFile(
      path.join(lockPath, ".reap"),
      `${JSON.stringify(deadReaper)}\n`,
      { mode: 0o600 },
    );
    await utimes(path.join(lockPath, ".reap"), old, old);
    await utimes(lockPath, old, old);
    await stores[4].create("b".repeat(64));

    const recovered = await readdir(directory);
    assert.equal(recovered.includes("sessions.json.lock"), false);
    assert.equal(
      recovered.filter((entry) => entry.startsWith("sessions.json.lock.stale.")).length,
      3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable hydration enforces one four-session cap across remembered and short sessions", async () => {
  const directory = await privateDirectory();
  const storePath = path.join(directory, "sessions.json");
  const password = randomBytes(32).toString("base64url");
  const passwordHash = await hashChatPassword(password);
  const secret = randomBytes(32).toString("base64url");
  const options = serverOptions({ passwordHash, secret, storePath });
  const chat = await startChatServer(options);
  try {
    const shortCookies = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await request(chat.url, "/chat/api/login", {
        method: "POST",
        headers: browserHeaders({
          "content-type": "application/json",
          "x-lazyedge-client-address": `198.51.100.${100 + index}`,
        }),
        body: JSON.stringify({ username: "operator", password, remember: false }),
      });
      assert.equal(response.status, 200, response.body);
      shortCookies.push(cookieHeader(response.headers["set-cookie"]));
    }

    const external = await ChatSessionStore.open({
      filePath: storePath,
      secret,
      passwordHash,
      maxSessions: 4,
    });
    const durable = [];
    for (let index = 0; index < 4; index += 1) {
      const csrf = randomBytes(24).toString("base64url");
      const stored = await external.create(sha256(csrf));
      durable.push({
        cookie: `__Host-lechat=${stored.raw}; __Host-lechat-csrf=${csrf}`,
        csrf,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    const hydrated = await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: durable[0].cookie },
    });
    assert.equal(hydrated.status, 200, hydrated.body);
    assert.equal(JSON.parse(hydrated.body).remembered, true);
    for (const cookie of shortCookies) {
      assert.equal((await request(chat.url, "/chat/api/session", {
        headers: { host: "llm.example.test", cookie },
      })).status, 401);
    }
    for (const session of durable) {
      assert.equal((await request(chat.url, "/chat/api/session", {
        headers: { host: "llm.example.test", cookie: session.cookie },
      })).status, 200);
    }
    assert.equal((await external.listActive()).length, 4);
  } finally {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle, absolute, backward-clock, and future-timestamp cases fail closed", async (t) => {
  const scenarios = [
    { name: "idle", idleMs: 100, absoluteMs: 1000, advance: 101 },
    { name: "absolute", idleMs: 1000, absoluteMs: 1200, advance: 1201 },
    {
      name: "backward",
      idleMs: 1000,
      absoluteMs: 2000,
      advance: -(5 * 60 * 1000) - 1,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const directory = await privateDirectory();
      const filePath = path.join(directory, "sessions.json");
      let now = 1_000_000;
      const options = {
        filePath,
        secret: randomBytes(32).toString("base64url"),
        passwordHash: `binding-${randomBytes(32).toString("base64url")}`,
        clock: () => now,
        idleMs: scenario.idleMs,
        absoluteMs: scenario.absoluteMs,
      };
      try {
        const store = await ChatSessionStore.open(options);
        const session = await store.create("b".repeat(64));
        now += scenario.advance;
        assert.equal(await store.verify(session.raw), null);
        assert.equal((await store.listActive()).length, 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  await t.test("future timestamp after a clock reset", async () => {
    const directory = await privateDirectory();
    const filePath = path.join(directory, "sessions.json");
    let now = 2_000_000;
    const common = {
      filePath,
      secret: randomBytes(32).toString("base64url"),
      passwordHash: `binding-${randomBytes(32).toString("base64url")}`,
      clock: () => now,
    };
    try {
      const store = await ChatSessionStore.open(common);
      const session = await store.create("c".repeat(64));
      now -= (5 * 60 * 1000) + 1;
      const restarted = await ChatSessionStore.open(common);
      assert.equal(await restarted.verify(session.raw), null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("corruption, unsafe modes, and symlinks prevent the store from opening", async () => {
  const secret = randomBytes(32).toString("base64url");
  const passwordHash = `binding-${randomBytes(32).toString("base64url")}`;

  const corruptDirectory = await privateDirectory();
  try {
    const filePath = path.join(corruptDirectory, "sessions.json");
    const store = await ChatSessionStore.open({ filePath, secret, passwordHash });
    await store.create("d".repeat(64));
    const source = await readFile(filePath, "utf8");
    await writeFile(filePath, source.replace(/"revision": 1/u, '"revision": 2'), { mode: 0o600 });
    await assert.rejects(
      () => ChatSessionStore.open({ filePath, secret, passwordHash }),
      /authentication failed/u,
    );
  } finally {
    await rm(corruptDirectory, { recursive: true, force: true });
  }

  const modeDirectory = await privateDirectory();
  try {
    const filePath = path.join(modeDirectory, "sessions.json");
    await writeFile(filePath, "{}\n", { mode: 0o600 });
    await chmod(filePath, 0o644);
    await assert.rejects(
      () => ChatSessionStore.open({ filePath, secret, passwordHash }),
      /owner-only regular file/u,
    );
  } finally {
    await rm(modeDirectory, { recursive: true, force: true });
  }

  const targetDirectory = await privateDirectory();
  const linkDirectory = await privateDirectory();
  try {
    const target = path.join(targetDirectory, "target.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const link = path.join(linkDirectory, "sessions.json");
    await symlink(target, link);
    await assert.rejects(
      () => ChatSessionStore.open({ filePath: link, secret, passwordHash }),
      /symlinks are forbidden|owner-only regular file/iu,
    );
  } finally {
    await rm(targetDirectory, { recursive: true, force: true });
    await rm(linkDirectory, { recursive: true, force: true });
  }

  const unsafeParent = await privateDirectory();
  try {
    await chmod(unsafeParent, 0o755);
    await assert.rejects(
      () => ChatSessionStore.open({
        filePath: path.join(unsafeParent, "sessions.json"),
        secret,
        passwordHash,
      }),
      /owner-only directory/u,
    );
  } finally {
    await chmod(unsafeParent, 0o700);
    await rm(unsafeParent, { recursive: true, force: true });
  }
});

test("an unsafe durable store disables remembered operations without locking out short login", async () => {
  const directory = await privateDirectory();
  const storePath = path.join(directory, "sessions.json");
  const password = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const corrupt = "{not-json}\n";
  await writeFile(storePath, corrupt, { mode: 0o600 });
  const chat = await startChatServer(serverOptions({
    passwordHash: await hashChatPassword(password),
    secret,
    storePath,
  }));
  try {
    const ordinary = await login(chat, password, false);
    assert.equal(ordinary.status, 200, ordinary.body);
    const ordinaryCookies = cookieHeader(ordinary.headers["set-cookie"]);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: ordinaryCookies },
    })).status, 200);

    const remembered = await login(chat, password, true);
    assert.equal(remembered.status, 503, remembered.body);
    assert.match(remembered.body, /session_store_unavailable/u);
    assert.equal(remembered.body.includes(password), false);
    assert.equal(remembered.body.includes(secret), false);
    assert.equal(await readFile(storePath, "utf8"), corrupt);

    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: {
        host: "llm.example.test",
        cookie: `__Host-lechat=${randomBytes(32).toString("base64url")}; __Host-lechat-csrf=${randomBytes(24).toString("base64url")}`,
      },
    })).status, 503);
    assert.equal((await request(chat.url, "/chat/api/session", {
      headers: { host: "llm.example.test", cookie: ordinaryCookies },
    })).status, 200);
  } finally {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("random valid-looking session cookies perform no lock or store mutation", async () => {
  const directory = await privateDirectory();
  const storePath = path.join(directory, "sessions.json");
  const password = randomBytes(32).toString("base64url");
  const passwordHash = await hashChatPassword(password);
  const secret = randomBytes(32).toString("base64url");
  const seed = await ChatSessionStore.open({
    filePath: storePath,
    secret,
    passwordHash,
  });
  await seed.create("a".repeat(64));
  const chat = await startChatServer(serverOptions({ passwordHash, secret, storePath }));
  try {
    const beforeContents = await readFile(storePath, "utf8");
    const beforeDirectory = await lstat(directory, { bigint: true });
    for (let index = 0; index < 128; index += 1) {
      const response = await request(chat.url, "/chat/api/session", {
        headers: {
          host: "llm.example.test",
          cookie: `__Host-lechat=${randomBytes(32).toString("base64url")}; __Host-lechat-csrf=${randomBytes(24).toString("base64url")}`,
        },
      });
      assert.equal(response.status, 401);
    }
    const afterDirectory = await lstat(directory, { bigint: true });
    assert.equal(afterDirectory.mtimeNs, beforeDirectory.mtimeNs);
    assert.equal(await readFile(storePath, "utf8"), beforeContents);
    assert.deepEqual(await readdir(directory), ["sessions.json"]);
  } finally {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed remember input is rejected without persistence or secret reflection", async () => {
  const directory = await privateDirectory();
  const storePath = path.join(directory, "sessions.json");
  const password = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const chat = await startChatServer(serverOptions({
    passwordHash: await hashChatPassword(password),
    secret,
    storePath,
  }));
  try {
    const rejected = await request(chat.url, "/chat/api/login", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "operator", password, remember: "yes" }),
    });
    assert.equal(rejected.status, 401, rejected.body);
    assert.equal(rejected.body.includes(password), false);
    assert.equal(rejected.body.includes(secret), false);
    await assert.rejects(() => lstat(storePath), { code: "ENOENT" });
  } finally {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  }
});
