import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import vm from "node:vm";

import {
  CHAT_CSS,
  CHAT_HTML,
  CHAT_JS,
  CHAT_ASSET_VERSION,
  CHAT_ICON_192,
  CHAT_ICON_512,
  CHAT_MANIFEST,
  CHAT_SERVICE_WORKER,
} from "../src/chat-assets.js";
import { startChatServer } from "../src/chat-server.js";

function pwaManifest() {
  return {
    apiVersion: "lazyedge.lazying.art/v1alpha1",
    kind: "EdgeProject",
    metadata: { name: "pwa-assets-test" },
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

function requestAsset(base, path, method = "GET") {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      method,
      headers: { host: "llm.example.test" },
      agent: false,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

class ClassList {
  constructor(owner) {
    this.owner = owner;
  }

  values() {
    return new Set(this.owner.className.split(/\s+/u).filter(Boolean));
  }

  add(...names) {
    const values = this.values();
    names.forEach((name) => values.add(name));
    this.owner.className = [...values].join(" ");
  }

  remove(...names) {
    const values = this.values();
    names.forEach((name) => values.delete(name));
    this.owner.className = [...values].join(" ");
  }

  contains(name) {
    return this.values().has(name);
  }
}

class BrowserNode {
  constructor(tagName, text = "") {
    this.tagName = tagName;
    this.nodeValue = text;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.classList = new ClassList(this);
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.content = "";
    this.scrollHeight = 400;
    this.scrollTop = 0;
    this.clientHeight = 300;
  }

  appendChild(child) {
    if (child.tagName === "#fragment") {
      for (const entry of [...child.children]) this.appendChild(entry);
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, listener) {
    const current = this.listeners.get(name) ?? [];
    current.push(listener);
    this.listeners.set(name, current);
  }

  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  querySelector(selector) {
    if (selector === "button[type=submit]") {
      return this.walk().find((entry) => entry.tagName === "BUTTON" && entry.type === "submit") ?? null;
    }
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.walk().find((entry) => entry.classList.contains(className)) ?? null;
    }
    return null;
  }

  walk() {
    const result = [];
    const visit = (current) => {
      result.push(current);
      current.children.forEach(visit);
    };
    this.children.forEach(visit);
    return result;
  }

  focus() {}

  select() {}

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((entry) => entry !== this);
  }

  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }

  get textContent() {
    if (this.tagName === "#text") return this.nodeValue;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.children = [new BrowserNode("#text", String(value))];
  }
}

class BrowserDocument {
  constructor() {
    this.readyState = "complete";
    this.visibilityState = "visible";
    this.documentElement = new BrowserNode("HTML");
    this.body = new BrowserNode("BODY");
    this.listeners = new Map();
    this.ids = new Map();
    this.themePickers = [new BrowserNode("SELECT"), new BrowserNode("SELECT")];
    this.installButtons = [new BrowserNode("BUTTON"), new BrowserNode("BUTTON")];
    for (const id of [
      "login-view", "app-view", "login-form", "login-error", "username", "password",
      "remember-session", "model-select", "connection-state", "signed-in-user",
      "conversation-list", "welcome", "messages", "chat-scroll", "composer",
      "message-input", "send-message", "stop-generation", "new-chat", "logout",
      "sidebar", "sidebar-scrim", "open-sidebar", "close-sidebar", "toast",
      "theme-color", "update-banner", "apply-update",
    ]) this.ids.set(id, new BrowserNode("DIV"));
    this.ids.get("app-view").hidden = true;
    this.ids.get("remember-session").checked = true;
    this.ids.get("message-input").scrollHeight = 36;
    const submit = new BrowserNode("BUTTON");
    submit.type = "submit";
    this.ids.get("login-form").appendChild(submit);
  }

  getElementById(id) {
    return this.ids.get(id) ?? null;
  }

  createElement(name) {
    return new BrowserNode(name.toUpperCase());
  }

  createTextNode(value) {
    return new BrowserNode("#text", value);
  }

  createDocumentFragment() {
    return new BrowserNode("#fragment");
  }

  querySelectorAll(selector) {
    if (selector === ".theme-select") return this.themePickers;
    if (selector === ".install-app") return this.installButtons;
    return [];
  }

  addEventListener(name, listener) {
    const current = this.listeners.get(name) ?? [];
    current.push(listener);
    this.listeners.set(name, current);
  }

  execCommand() {
    return true;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function streamingBrowser({ markdownReady = true } = {}) {
  const document = new BrowserDocument();
  const localValues = new Map();
  const paintCalls = [];
  const frames = new Map();
  let frameId = 0;
  const secondChunk = deferred();
  let readIndex = 0;
  const encoder = new TextEncoder();
  const reader = {
    read() {
      readIndex += 1;
      if (readIndex === 1) {
        return Promise.resolve({
          done: false,
          value: encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
        });
      }
      if (readIndex === 2) return secondChunk.promise;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const fetchCalls = [];
  const fetch = async (path) => {
    fetchCalls.push(path);
    if (path === "/chat/api/session") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { authenticated: true, username: "operator", csrfToken: "csrf" };
        },
      };
    }
    if (path === "/chat/api/models") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [{ id: "fast", label: "Fast", default: true }] };
        },
      };
    }
    if (path === "/chat/api/completions") {
      return { ok: true, status: 200, body: { getReader: () => reader } };
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  const navigator = {
    onLine: true,
    clipboard: { writeText: async () => {} },
  };
  const windowListeners = new Map();
  const location = {
    host: "llm.example.test",
    href: "https://llm.example.test/",
    origin: "https://llm.example.test",
    protocol: "https:",
    reload() {},
  };
  const markdown = {
    render(target, content) {
      paintCalls.push(content);
      target.textContent = content;
    },
  };
  const window = {
    location,
    crypto: { randomUUID: () => "conversation-id" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame(callback) {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener(name, listener) {
      const current = windowListeners.get(name) ?? [];
      current.push(listener);
      windowListeners.set(name, current);
    },
  };
  if (markdownReady) window.LazyEdgeMarkdown = markdown;
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    URL,
    document,
    fetch,
    localStorage: {
      getItem(key) { return localValues.get(key) ?? null; },
      setItem(key, value) { localValues.set(key, value); },
    },
    navigator,
    window,
  });
  new vm.Script(CHAT_JS).runInContext(context);
  return {
    document,
    fetchCalls,
    paintCalls,
    markMarkdownReady() {
      window.LazyEdgeMarkdown = markdown;
      for (const listener of windowListeners.get("lazyedge-markdown-ready") ?? []) listener();
    },
    resolveSecond() {
      secondChunk.resolve({
        done: false,
        value: encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
      });
    },
    flushFrames() {
      while (frames.size > 0) {
        const pending = [...frames.entries()];
        frames.clear();
        pending.forEach(([, callback]) => callback());
      }
    },
  };
}

test("PWA manifest, generated icons, and safe versioned service worker are complete", () => {
  const manifest = JSON.parse(CHAT_MANIFEST);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.theme_color, "#f7faf9");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert(manifest.icons.every((icon) => icon.purpose.includes("maskable")));
  for (const [icon, size] of [[CHAT_ICON_192, 192], [CHAT_ICON_512, 512]]) {
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
  assert.match(CHAT_SERVICE_WORKER, /CACHE_PREFIX = "lazyedge-private-chat-"/u);
  assert.match(CHAT_SERVICE_WORKER, new RegExp(`VERSION = "${CHAT_ASSET_VERSION}"`, "u"));
  assert.match(CHAT_SERVICE_WORKER, /url\.pathname\.startsWith\("\/chat\/api\/"\)/u);
  assert.match(CHAT_SERVICE_WORKER, /url\.pathname\.startsWith\("\/v1\/"\)/u);
  assert.match(CHAT_SERVICE_WORKER, /event\.data\.type === "SKIP_WAITING"/u);
  assert.match(CHAT_SERVICE_WORKER, /request\.mode === "navigate"[\s\S]*fetch\(request\)[\s\S]*caches\.match\("\/"\)/u);
  assert.doesNotMatch(CHAT_SERVICE_WORKER, /https?:\/\//iu);
  assert.doesNotMatch(CHAT_SERVICE_WORKER.match(/var SHELL = \[[\s\S]*?\];/u)[0], /chat\/api|\/v1\//u);
  assert.doesNotThrow(() => new vm.Script(CHAT_SERVICE_WORKER));
});

test("chat BFF serves only the exact same-origin PWA asset contract", async () => {
  const chat = await startChatServer({
    manifest: pwaManifest(),
    serviceId: "local-llm",
    passwordHash: `scrypt$v=1$n=131072,r=8,p=1$${"A".repeat(43)}$${"B".repeat(43)}`,
    clientToken: "C".repeat(43),
    listen: "127.0.0.1:0",
  });
  try {
    const expected = new Map([
      ["/manifest.webmanifest", /^application\/manifest\+json/u],
      ["/sw.js", /^text\/javascript/u],
      ["/assets/app.css", /^text\/css/u],
      ["/assets/app.js", /^text\/javascript/u],
      ["/assets/markdown.js", /^text\/javascript/u],
      ["/assets/katex.mjs", /^text\/javascript/u],
      ["/assets/icon-192.png", /^image\/png/u],
      ["/assets/icon-512.png", /^image\/png/u],
    ]);
    for (const [path, contentType] of expected) {
      const response = await requestAsset(chat.url, path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers["content-type"], contentType, path);
      assert.equal(response.headers["cache-control"], "no-store", path);
      assert(Number(response.headers["content-length"]) > 0, path);
      assert.equal(response.body.length, Number(response.headers["content-length"]), path);
    }
    const katex = await requestAsset(chat.url, "/assets/katex.mjs");
    assert.match(katex.body.toString("utf8"), /var version = "0\.16\.47";/u);
    const head = await requestAsset(chat.url, "/assets/icon-192.png", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers["content-length"]), CHAT_ICON_192.length);
    for (const unsafe of ["/sw.js?debug=1", "/assets/unknown.js", "/chat/api/session.js"]) {
      assert.equal((await requestAsset(chat.url, unsafe)).status, 404, unsafe);
    }
  } finally {
    await chat.close();
  }
});

test("bright is the default and dark/system choices persist without credential storage", () => {
  assert.match(CHAT_HTML, /<html lang="en" data-theme="bright">/u);
  assert.match(CHAT_HTML, /rel="manifest" href="\/manifest\.webmanifest"/u);
  assert.match(CHAT_HTML, /autocomplete="username"/u);
  assert.match(CHAT_HTML, /autocomplete="current-password"/u);
  assert.match(CHAT_HTML, /id="remember-session"[\s\S]*checked/u);
  assert.match(CHAT_HTML, />Bright<\/option>[\s\S]*>Dark<\/option>[\s\S]*>System<\/option>/u);
  assert.match(CHAT_CSS, /^:root \{[\s\S]*--bg: #f4f7f6/u);
  assert.match(CHAT_CSS, /:root\[data-theme="dark"\]/u);
  assert.match(CHAT_CSS, /:root\[data-theme="system"\]/u);
  assert.match(CHAT_JS, /new window\.PasswordCredential\(elements\.loginForm\)/u);
  assert.match(CHAT_JS, /navigator\.credentials\.store\(credential\)/u);
  assert.match(CHAT_JS, /body: JSON\.stringify\(\{ username: username, password: password, remember: state\.rememberSession \}\)/u);
  assert.match(CHAT_JS, /window\.addEventListener\("lazyedge-markdown-ready", initialize/u);
  assert.match(CHAT_JS, /window\.setTimeout\(initialize, 5000\)/u);
  assert.doesNotMatch(CHAT_JS, /indexedDB|caches\.|localStorage\.(?:password|username)|setItem\([^\n]*(?:password|username)/iu);
  assert.doesNotThrow(() => new vm.Script(CHAT_JS));
});

test("streamed deltas paint incrementally before completion and retain the final response", async () => {
  const browser = streamingBrowser();
  await settle();
  assert.deepEqual(browser.fetchCalls.slice(0, 2), ["/chat/api/session", "/chat/api/models"]);
  const input = browser.document.getElementById("message-input");
  input.value = "Say hello";
  browser.document.getElementById("composer").dispatch("submit", { preventDefault() {} });
  await settle();
  browser.flushFrames();
  assert(browser.paintCalls.includes("Hello"), "first SSE delta was not rendered before stream end");
  const firstArticle = browser.document.getElementById("messages").children.at(-1);
  assert.equal(firstArticle.querySelector(".message-content").textContent, "Hello");

  browser.resolveSecond();
  await settle();
  browser.flushFrames();
  await settle();
  const finalArticle = browser.document.getElementById("messages").children.at(-1);
  assert.equal(finalArticle.querySelector(".message-content").textContent, "Hello world");
  assert(browser.paintCalls.includes("Hello world"));
});

test("app initialization explicitly waits for the Markdown module readiness signal", async () => {
  const browser = streamingBrowser({ markdownReady: false });
  await settle();
  assert.deepEqual(browser.fetchCalls, []);
  browser.markMarkdownReady();
  await settle();
  assert.deepEqual(browser.fetchCalls.slice(0, 2), ["/chat/api/session", "/chat/api/models"]);
});
