import {
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import {
  CHAT_CSS,
  CHAT_HTML,
  CHAT_ICON_192,
  CHAT_ICON_512,
  CHAT_JS,
  CHAT_MANIFEST,
  CHAT_MARKDOWN_JS,
  CHAT_SERVICE_WORKER,
} from "./chat-assets.js";
import {
  ChatSessionStore,
  REMEMBER_SESSION_ABSOLUTE_MS,
  REMEMBER_SESSION_IDLE_MS,
} from "./chat-session-store.js";
import { normalizeManifest } from "./config.js";
import {
  assertSecretToken,
  constantTimeEqual,
  getRequestHost,
  getSingleHeader,
  normalizeLoopbackListener,
  parseRequestTarget,
  sha256,
} from "./security.js";

const scrypt = promisify(scryptCallback);
const PASSWORD_RECORD_PATTERN = /^scrypt\$v=1\$n=131072,r=8,p=1\$([A-Za-z0-9_-]{43})\$([A-Za-z0-9_-]{43})$/u;
const PASSWORD_SCRYPT_OPTIONS = Object.freeze({
  N: 131_072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
});
const PASSWORD_KEY_BYTES = 32;
const SESSION_COOKIE = "__Host-lechat";
const CSRF_COOKIE = "__Host-lechat-csrf";
const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 24;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 4;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const MAX_LOGIN_CLIENTS = 2048;
const MAX_LOGIN_UPLOADS_PER_CLIENT = 2;
const MAX_LOGIN_UPLOADS_TOTAL = 32;
const MAX_COMPLETION_UPLOADS_PER_SESSION = 2;
const MAX_COMPLETION_UPLOADS_TOTAL = 8;
const MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETION_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COMPLETION_EVENT_BYTES = 256 * 1024;
const MAX_COMPLETION_TEXT_CHARACTERS = 32_000;
const MAX_COMPLETION_WALL_MS = 15 * 60 * 1000;
const MAX_SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const require = createRequire(import.meta.url);
const KATEX_MODULE = await readFile(require.resolve("katex/dist/katex.mjs"));
const STATIC_ASSETS = new Map([
  ["/", [CHAT_HTML, "text/html; charset=utf-8"]],
  ["/manifest.webmanifest", [CHAT_MANIFEST, "application/manifest+json; charset=utf-8"]],
  ["/sw.js", [CHAT_SERVICE_WORKER, "text/javascript; charset=utf-8"]],
  ["/assets/app.css", [CHAT_CSS, "text/css; charset=utf-8"]],
  ["/assets/app.js", [CHAT_JS, "text/javascript; charset=utf-8"]],
  ["/assets/markdown.js", [CHAT_MARKDOWN_JS, "text/javascript; charset=utf-8"]],
  ["/assets/katex.mjs", [KATEX_MODULE, "text/javascript; charset=utf-8"]],
  ["/assets/icon-192.png", [CHAT_ICON_192, "image/png"]],
  ["/assets/icon-512.png", [CHAT_ICON_512, "image/png"]],
]);

function assertPassword(value) {
  if (
    typeof value !== "string"
    || value.length < 12
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Chat password must contain 12–256 printable characters");
  }
  return value;
}

export async function hashChatPassword(password, { salt = randomBytes(32) } = {}) {
  const normalized = assertPassword(password);
  if (!Buffer.isBuffer(salt) || salt.length !== 32) {
    throw new TypeError("Chat password salt must be a 32-byte Buffer");
  }
  const derived = await scrypt(normalized, salt, PASSWORD_KEY_BYTES, PASSWORD_SCRYPT_OPTIONS);
  return `scrypt$v=1$n=131072,r=8,p=1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyChatPassword(password, record) {
  const match = typeof record === "string" ? PASSWORD_RECORD_PATTERN.exec(record) : null;
  if (match === null) throw new Error("Chat password record is invalid");
  const candidate = typeof password === "string" && password.length <= 256 ? password : "";
  const salt = Buffer.from(match[1], "base64url");
  const expected = Buffer.from(match[2], "base64url");
  const actual = await scrypt(candidate, salt, PASSWORD_KEY_BYTES, PASSWORD_SCRYPT_OPTIONS);
  return constantTimeEqual(actual, expected) && (() => {
    try {
      assertPassword(password);
      return true;
    } catch {
      return false;
    }
  })();
}

export async function readChatPasswordFile(filePath) {
  if (filePath === "-") {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024) throw new Error("Chat password input is too large");
      chunks.push(chunk);
    }
    return assertPassword(Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/u, ""));
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Chat password input must be a regular non-symlink file");
  }
  if ((metadata.mode & 0o077) !== 0 || metadata.size < 12 || metadata.size > 1024) {
    throw new Error("Chat password input must be owner-only and no larger than 1 KiB");
  }
  return assertPassword((await readFile(filePath, "utf8")).replace(/[\r\n]+$/u, ""));
}

function runtimeListen(value) {
  if (typeof value === "string" && value.endsWith(":0")) {
    const base = normalizeLoopbackListener(`${value.slice(0, -1)}1`, "chat listener");
    return { ...base, port: 0, value };
  }
  const listener = normalizeLoopbackListener(value, "chat listener");
  if (listener.host !== "127.0.0.1") throw new Error("Chat must use exact loopback 127.0.0.1");
  return listener;
}

async function listen(server, listener) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: listener.host, port: listener.port, exclusive: true });
  });
}

function secureHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function send(response, statusCode, body, contentType = "application/json; charset=utf-8", method = "GET") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(statusCode, {
    ...secureHeaders(contentType),
    "content-length": payload.length,
  });
  if (method === "HEAD") response.end();
  else response.end(payload);
}

function sendJson(response, statusCode, value, method) {
  send(response, statusCode, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8", method);
}

function sendError(response, statusCode, code, method) {
  sendJson(response, statusCode, { error: { code } }, method);
}

function parseCookies(request) {
  const header = getSingleHeader(request, "cookie");
  if (header === null) return new Map();
  if (header.length > 4096) return null;
  const result = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || result.has(name)) return null;
    result.set(name, value);
  }
  return result;
}

function setSessionCookies(response, sessionToken, csrfToken, { remembered = false } = {}) {
  const maximumAge = remembered ? REMEMBER_SESSION_ABSOLUTE_MS : SESSION_ABSOLUTE_MS;
  response.setHeader("set-cookie", [
    `${SESSION_COOKIE}=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maximumAge / 1000}; Priority=High`,
    `${CSRF_COOKIE}=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=${maximumAge / 1000}; Priority=High`,
  ]);
}

function clearSessionCookies(response) {
  response.setHeader("set-cookie", [
    `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; Priority=High`,
    `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0; Priority=High`,
  ]);
}

function exactBrowserOrigin(request, allowedHosts) {
  let host;
  try {
    host = getRequestHost(request);
  } catch {
    return false;
  }
  if (!allowedHosts.has(host)) return false;
  const origin = getSingleHeader(request, "origin");
  if (origin !== `https://${host}`) return false;
  return getSingleHeader(request, "sec-fetch-site") === "same-origin"
    && getSingleHeader(request, "sec-fetch-mode") === "cors"
    && getSingleHeader(request, "sec-fetch-dest") === "empty";
}

function loginClientAddress(request) {
  // The service listens only on 127.0.0.1. Caddy overwrites this header with
  // its socket peer before proxying, so an Internet client cannot choose the
  // limiter key. Direct callers without the ingress assertion fail closed.
  if (request.socket.remoteAddress !== "127.0.0.1") return null;
  const value = getSingleHeader(request, "x-lazyedge-client-address");
  if (typeof value !== "string" || value.length > 64 || isIP(value) === 0) return null;
  return value.toLowerCase();
}

function csrfMatches(request, authenticated) {
  const cookies = authenticated?.cookies;
  const cookie = cookies?.get(CSRF_COOKIE);
  const header = getSingleHeader(request, "x-lazyedge-csrf");
  return typeof cookie === "string"
    && typeof header === "string"
    && /^[A-Za-z0-9_-]{32}$/u.test(cookie)
    && constantTimeEqual(cookie, header)
    && constantTimeEqual(sha256(header), authenticated.session.csrfDigest);
}

async function readJson(request, maximumBytes) {
  const contentType = getSingleHeader(request, "content-type");
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType ?? "")) {
    const error = new Error("unsupported_media_type");
    error.statusCode = 415;
    throw error;
  }
  if (getSingleHeader(request, "content-encoding") !== null) {
    const error = new Error("unsupported_content_encoding");
    error.statusCode = 415;
    throw error;
  }
  const declared = getSingleHeader(request, "content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximumBytes)) {
    const error = new Error("body_too_large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("body_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}

function exactObject(value, allowed) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function declaresRequestBody(request) {
  const transferEncoding = getSingleHeader(request, "transfer-encoding");
  const contentLength = getSingleHeader(request, "content-length");
  if (transferEncoding !== null) return true;
  if (contentLength === null) return false;
  return !/^0+$/u.test(contentLength);
}

function normalizeCompletion(value, chat) {
  if (!exactObject(value, new Set(["model", "messages"]))) {
    throw new Error("invalid_completion");
  }
  if (!Object.hasOwn(chat.models, value.model)) throw new Error("invalid_model_alias");
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 64) {
    throw new Error("invalid_messages");
  }
  let totalCharacters = 0;
  const messages = value.messages.map((entry) => {
    if (
      !exactObject(entry, new Set(["role", "content"]))
      || !["user", "assistant"].includes(entry.role)
      || typeof entry.content !== "string"
      || entry.content.length < 1
      || entry.content.length > 32_000
    ) {
      throw new Error("invalid_messages");
    }
    totalCharacters += entry.content.length;
    return { role: entry.role, content: entry.content };
  });
  if (totalCharacters > 128_000 || messages.at(-1).role !== "user") {
    throw new Error("invalid_messages");
  }
  return {
    model: chat.models[value.model],
    messages,
    stream: true,
  };
}

function gatewayRequest({ listener, token, method, path, body, timeoutMs }) {
  const target = normalizeLoopbackListener(listener, "compatibility listener");
  return http.request({
    hostname: target.host,
    port: target.port,
    method,
    path,
    agent: false,
    headers: {
      accept: path === "/v1/chat/completions" ? "text/event-stream" : "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8",
      }),
    },
  }).setTimeout(timeoutMs);
}

async function availableModelAliases(service, clientToken) {
  return new Promise((resolve, reject) => {
    const outgoing = gatewayRequest({
      listener: service.compatibilityListen,
      token: clientToken,
      method: "GET",
      path: "/v1/models",
      timeoutMs: 15_000,
    });
    let size = 0;
    const chunks = [];
    outgoing.on("timeout", () => outgoing.destroy(new Error("models timeout")));
    outgoing.on("error", reject);
    outgoing.on("response", (incoming) => {
      incoming.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_MODELS_RESPONSE_BYTES) incoming.destroy(new Error("models response too large"));
        else chunks.push(chunk);
      });
      incoming.on("error", reject);
      incoming.on("end", () => {
        if (incoming.statusCode !== 200) return reject(new Error("models unavailable"));
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const ids = new Set(
            Array.isArray(parsed.data)
              ? parsed.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
              : [],
          );
          const aliases = [
            { id: "deep", label: "Deep", target: service.chat.models.deep },
            { id: "fast", label: "Fast", target: service.chat.models.fast },
            { id: "code", label: "Code", target: service.chat.models.code },
          ].filter((entry) => ids.has(entry.target)).map((entry) => ({
            id: entry.id,
            label: entry.label,
            default: entry.id === service.chat.defaultModel,
          }));
          resolve(aliases);
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.end();
  });
}

function nextEventBoundary(buffer) {
  const match = /(?:\r\n|[\r\n])(?:\r\n|[\r\n])/u.exec(buffer);
  return match === null ? null : { index: match.index, length: match[0].length };
}

function sanitizeCompletionEvent(block, state) {
  const data = block
    .split(/\r\n|[\r\n]/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (data === "" || state.done) return "";
  if (data === "[DONE]") {
    state.done = true;
    return "data: [DONE]\n\n";
  }
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return "";
  }
  const content = parsed?.choices?.[0]?.delta?.content;
  if (typeof content !== "string" || content.length === 0) return "";
  const remaining = MAX_COMPLETION_TEXT_CHARACTERS - state.characters;
  if (remaining <= 0) return "";
  const safeContent = content.slice(0, remaining);
  state.characters += safeContent.length;
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: safeContent } }] })}\n\n`;
  if (state.characters >= MAX_COMPLETION_TEXT_CHARACTERS) {
    state.done = true;
    return `${event}data: [DONE]\n\n`;
  }
  return event;
}

async function streamCompletion(
  request,
  response,
  service,
  clientToken,
  payload,
  activeStreams,
) {
  const body = JSON.stringify(payload);
  await new Promise((resolve) => {
    const outgoing = gatewayRequest({
      listener: service.compatibilityListen,
      token: clientToken,
      method: "POST",
      path: "/v1/chat/completions",
      body,
      timeoutMs: service.idleTimeoutSeconds * 1000,
    });
    activeStreams.add(outgoing);
    let finished = false;
    const absoluteTimer = setTimeout(
      () => outgoing.destroy(new Error("completion deadline exceeded")),
      Math.min(service.idleTimeoutSeconds * 1000, MAX_COMPLETION_WALL_MS),
    );
    absoluteTimer.unref?.();
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(absoluteTimer);
      activeStreams.delete(outgoing);
      resolve();
    };
    outgoing.on("timeout", () => outgoing.destroy(new Error("completion timeout")));
    outgoing.on("error", (error) => {
      if (!response.headersSent) {
        sendError(response, error.message.includes("timeout") ? 504 : 503, "model_unavailable");
      } else if (!response.destroyed) response.destroy();
      done();
    });
    outgoing.on("response", (incoming) => {
      const incomingFailed = () => {
        if (!response.headersSent) sendError(response, 502, "model_request_failed");
        else if (!response.writableEnded && !response.destroyed) response.destroy();
        done();
      };
      incoming.once("error", incomingFailed);
      incoming.once("aborted", incomingFailed);
      const contentType = String(incoming.headers["content-type"] ?? "");
      if (incoming.statusCode !== 200 || !contentType.startsWith("text/event-stream")) {
        if (!response.headersSent) {
          // Upstream authorization is an internal BFF capability boundary.
          // Browser-facing 401 is reserved for the browser session itself.
          const status = incoming.statusCode === 401
            ? 503
            : ([429, 503, 504].includes(incoming.statusCode) ? incoming.statusCode : 502);
          sendError(response, status, "model_request_failed");
        }
        done();
        incoming.destroy();
        outgoing.destroy();
        return;
      }
      response.writeHead(200, {
        ...secureHeaders("text/event-stream; charset=utf-8"),
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const decoder = new StringDecoder("utf8");
      const state = { characters: 0, done: false };
      let buffer = "";
      let upstreamBytes = 0;
      const emitBufferedEvents = () => {
        let boundary;
        while ((boundary = nextEventBoundary(buffer)) !== null) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const safeEvent = sanitizeCompletionEvent(block, state);
          if (safeEvent && !response.write(safeEvent)) incoming.pause();
        }
      };
      incoming.on("data", (chunk) => {
        upstreamBytes += chunk.length;
        if (upstreamBytes > MAX_COMPLETION_RESPONSE_BYTES) {
          outgoing.destroy(new Error("completion response too large"));
          return;
        }
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_COMPLETION_EVENT_BYTES) {
          outgoing.destroy(new Error("completion event too large"));
          return;
        }
        emitBufferedEvents();
        if (state.done) {
          if (!response.destroyed && !response.writableEnded) response.end();
          done();
          incoming.destroy();
        }
      });
      response.on("drain", () => incoming.resume());
      incoming.on("end", () => {
        buffer += decoder.end();
        emitBufferedEvents();
        if (!response.destroyed) {
          if (!state.done) response.write("data: [DONE]\n\n");
          response.end();
        }
        done();
      });
    });
    request.on("aborted", () => outgoing.destroy(new Error("client aborted")));
    response.on("close", () => {
      if (!response.writableFinished) {
        outgoing.destroy();
      }
      done();
    });
    outgoing.end(body);
  });
}

function asset(path) {
  return STATIC_ASSETS.get(path) ?? null;
}

function sessionHandle(server, listener, serviceId, beforeClose = () => {}) {
  const address = server.address();
  return Object.freeze({
    server,
    serviceId,
    address: Object.freeze({ host: address.address, port: address.port }),
    url: `http://${address.address}:${address.port}`,
    async close() {
      if (!server.listening) return;
      beforeClose();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
    },
    configuredHost: listener.host,
  });
}

export async function startChatServer({
  manifest: manifestInput,
  serviceId,
  passwordHash,
  clientToken,
  listen: listenOverride,
  rememberSessionStorePath,
  rememberSessionSecret,
  clock = () => Date.now(),
  signal,
} = {}) {
  const manifest = normalizeManifest(manifestInput);
  const service = manifest.spec.services.find((candidate) => candidate.id === serviceId);
  if (!service?.chat) throw new TypeError("startChatServer requires a configured chat serviceId");
  if (manifest.spec.edge.compatibilityService !== service.id) {
    throw new TypeError("Chat service must own the compatibility listener");
  }
  if (!PASSWORD_RECORD_PATTERN.test(passwordHash)) throw new Error("Chat password record is invalid");
  const token = assertSecretToken(clientToken, "chat client token");
  if ((rememberSessionStorePath === undefined) !== (rememberSessionSecret === undefined)) {
    throw new TypeError(
      "Remembered chat sessions require both rememberSessionStorePath and rememberSessionSecret",
    );
  }
  const rememberStoreConfigured = rememberSessionStorePath !== undefined;
  let rememberStore = null;
  if (rememberStoreConfigured) {
    try {
      rememberStore = await ChatSessionStore.open({
        filePath: rememberSessionStorePath,
        secret: rememberSessionSecret,
        passwordHash,
        clock,
        maxSessions: MAX_SESSIONS,
      });
    } catch {
      // A corrupt, symlinked, or insecure durable store must not authenticate
      // any remembered cookie. Keep ordinary in-memory login available so the
      // owner is not locked out while repairing the optional persistence file.
      rememberStore = null;
    }
  }
  const allowedHosts = new Set(service.domains);
  const completionUploadLimit = Math.min(
    MAX_COMPLETION_UPLOADS_TOTAL,
    service.public.maxConcurrentRequests,
  );
  const sessions = new Map();
  const failedLogins = new Map();
  const loginUploads = new Map();
  let totalLoginUploads = 0;
  let totalCompletionUploads = 0;
  let passwordVerificationActive = false;

  const endSessionRuntime = (digest) => {
    const session = sessions.get(digest);
    if (!session) return;
    sessions.delete(digest);
    for (const outgoing of session.activeStreams) {
      outgoing.destroy(new Error("chat session ended"));
    }
    session.activeStreams.clear();
    for (const pending of session.pendingBodies) {
      pending.destroy(new Error("chat session ended"));
    }
  };

  const deleteSession = async (digest, { durable = true } = {}) => {
    const session = sessions.get(digest);
    if (!session) return false;
    if (durable && session.remembered) {
      if (rememberStore === null) return false;
      await rememberStore.revokeDigest(digest);
    }
    endSessionRuntime(digest);
    return true;
  };

  const enforceCombinedSessionLimit = async (protectedDigest) => {
    let remembered = [];
    if (rememberStore !== null) {
      try {
        remembered = await rememberStore.listActive();
      } catch (error) {
        if (sessions.get(protectedDigest)?.remembered) throw error;
      }
    }
    const combined = [
      ...remembered.map((record) => ({
        digest: record.digest,
        createdAt: record.createdAt,
        remembered: true,
      })),
      ...[...sessions.entries()]
        .filter(([, session]) => !session.remembered)
        .map(([digest, session]) => ({
          digest,
          createdAt: session.createdAt,
          remembered: false,
        })),
    ].sort((left, right) => (
      left.createdAt - right.createdAt || left.digest.localeCompare(right.digest)
    ));
    while (combined.length > MAX_SESSIONS) {
      const victimIndex = combined.findIndex((entry) => entry.digest !== protectedDigest);
      if (victimIndex === -1) throw new Error("chat_session_limit_unavailable");
      const [victim] = combined.splice(victimIndex, 1);
      if (victim.remembered) {
        if (rememberStore === null) throw new Error("remembered_sessions_unavailable");
        await rememberStore.revokeDigest(victim.digest);
        endSessionRuntime(victim.digest);
      } else {
        endSessionRuntime(victim.digest);
      }
    }
  };

  const beginLoginUpload = (client) => {
    const clientCount = loginUploads.get(client) ?? 0;
    if (
      clientCount >= MAX_LOGIN_UPLOADS_PER_CLIENT
      || totalLoginUploads >= MAX_LOGIN_UPLOADS_TOTAL
    ) return false;
    loginUploads.set(client, clientCount + 1);
    totalLoginUploads += 1;
    return true;
  };
  const endLoginUpload = (client) => {
    const clientCount = loginUploads.get(client) ?? 0;
    if (clientCount <= 1) loginUploads.delete(client);
    else loginUploads.set(client, clientCount - 1);
    if (clientCount > 0) totalLoginUploads -= 1;
  };
  const beginCompletionUpload = (session, request) => {
    if (
      session.pendingBodies.size >= MAX_COMPLETION_UPLOADS_PER_SESSION
      || totalCompletionUploads >= completionUploadLimit
    ) return false;
    session.pendingBodies.add(request);
    totalCompletionUploads += 1;
    return true;
  };
  const endCompletionUpload = (session, request) => {
    if (session.pendingBodies.delete(request)) totalCompletionUploads -= 1;
  };
  const rejectUpload = (request, response, code = "too_many_uploads") => {
    response.setHeader("connection", "close");
    response.setHeader("retry-after", "1");
    response.once("finish", () => request.destroy());
    sendError(response, 429, code);
    request.resume();
  };
  const rejectUnexpectedBody = (request, response) => {
    response.setHeader("connection", "close");
    response.once("finish", () => request.destroy());
    sendError(response, 400, "request_body_not_allowed");
    request.resume();
  };

  const pruneLoginFailures = (now) => {
    for (const [client, timestamps] of failedLogins) {
      const active = timestamps.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
      if (active.length === 0) failedLogins.delete(client);
      else if (active.length !== timestamps.length) failedLogins.set(client, active);
    }
  };
  const loginFailuresFor = (client, now) => {
    pruneLoginFailures(now);
    if (!failedLogins.has(client) && failedLogins.size >= MAX_LOGIN_CLIENTS) {
      failedLogins.delete(failedLogins.keys().next().value);
    }
    return failedLogins.get(client) ?? [];
  };

  const sessionExpired = (session, now) => {
    const idleMs = session.remembered ? REMEMBER_SESSION_IDLE_MS : SESSION_IDLE_MS;
    const absoluteMs = session.remembered ? REMEMBER_SESSION_ABSOLUTE_MS : SESSION_ABSOLUTE_MS;
    if (
      session.createdAt > now + MAX_SESSION_CLOCK_SKEW_MS
      || session.lastSeen > now + MAX_SESSION_CLOCK_SKEW_MS
    ) return true;
    const effectiveNow = Math.max(now, session.lastSeen);
    return effectiveNow - session.lastSeen > idleMs
      || effectiveNow - session.createdAt > absoluteMs;
  };
  const pruneSessions = async () => {
    const now = clock();
    for (const [digest, session] of sessions) {
      if (!sessionExpired(session, now)) continue;
      try {
        await deleteSession(digest);
      } catch {
        // Removing the local runtime state fails closed. The authenticated
        // store path will report a bounded service error until persistence is
        // healthy again, rather than reviving this cached session.
        endSessionRuntime(digest);
      }
    }
  };
  const authenticate = async (request) => {
    await pruneSessions();
    const cookies = parseCookies(request);
    const raw = cookies?.get(SESSION_COOKIE);
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(raw)) return null;
    const shortDigest = sha256(raw);
    const shortSession = sessions.get(shortDigest);
    if (shortSession && !shortSession.remembered) {
      shortSession.lastSeen = Math.max(shortSession.lastSeen, clock());
      return { cookies, digest: shortDigest, raw, session: shortSession };
    }
    if (rememberStore === null) {
      if (rememberStoreConfigured) throw new Error("session_store_unavailable");
      return null;
    }
    const record = await rememberStore.verify(raw);
    if (record === null) return null;
    let session = sessions.get(record.digest);
    if (session === undefined) {
      session = {
        remembered: true,
        createdAt: record.createdAt,
        lastSeen: record.lastSeen,
        csrfDigest: record.csrfDigest,
        activeStreams: new Set(),
        pendingBodies: new Set(),
      };
      sessions.set(record.digest, session);
      try {
        await enforceCombinedSessionLimit(record.digest);
      } catch (error) {
        endSessionRuntime(record.digest);
        throw error;
      }
    } else {
      session.createdAt = record.createdAt;
      session.lastSeen = record.lastSeen;
      session.csrfDigest = record.csrfDigest;
    }
    return { cookies, digest: record.digest, raw, session };
  };
  const createSession = async (response, remembered) => {
    await pruneSessions();
    const raw = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const csrf = randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
    const now = clock();
    let sessionRaw = raw;
    let digest = sha256(raw);
    let createdAt = now;
    let lastSeen = now;
    if (remembered) {
      if (rememberStore === null) throw new Error("remembered_sessions_unavailable");
      const stored = await rememberStore.create(sha256(csrf));
      sessionRaw = stored.raw;
      digest = stored.record.digest;
      createdAt = stored.record.createdAt;
      lastSeen = stored.record.lastSeen;
      for (const evicted of stored.evicted) endSessionRuntime(evicted);
    }
    sessions.set(digest, {
      remembered,
      createdAt,
      lastSeen,
      csrfDigest: sha256(csrf),
      activeStreams: new Set(),
      pendingBodies: new Set(),
    });
    try {
      await enforceCombinedSessionLimit(digest);
    } catch (error) {
      try {
        await deleteSession(digest);
      } catch {
        endSessionRuntime(digest);
      }
      throw error;
    }
    setSessionCookies(response, sessionRaw, csrf, { remembered });
    return csrf;
  };

  const chatService = {
    ...service,
    compatibilityListen: manifest.spec.edge.compatibilityListen,
    idleTimeoutSeconds: service.public.idleTimeoutSeconds,
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    let target;
    try {
      target = parseRequestTarget(request.url);
    } catch {
      sendError(response, 400, "unsafe_request", request.method);
      request.resume();
      return;
    }
    let requestHost;
    try {
      requestHost = getRequestHost(request);
    } catch {
      sendError(response, 400, "unsafe_request", request.method);
      request.resume();
      return;
    }
    if (target.query || !allowedHosts.has(requestHost)) {
      sendError(response, 404, "not_found", request.method);
      request.resume();
      return;
    }
    const acceptsBody = request.method === "POST" && (
      target.path === "/chat/api/login"
      || target.path === "/chat/api/completions"
    );
    try {
      if (!acceptsBody && declaresRequestBody(request)) {
        rejectUnexpectedBody(request, response);
        return;
      }
    } catch {
      rejectUnexpectedBody(request, response);
      return;
    }
    const staticAsset = asset(target.path);
    if (staticAsset && ["GET", "HEAD"].includes(request.method)) {
      send(response, 200, staticAsset[0], staticAsset[1], request.method);
      return;
    }

    if (request.method === "POST" && target.path === "/chat/api/login") {
      if (!exactBrowserOrigin(request, allowedHosts)) {
        sendError(response, 403, "cross_site_request");
        request.resume();
        return;
      }
      const loginClient = loginClientAddress(request);
      if (loginClient === null) {
        sendError(response, 403, "untrusted_ingress");
        request.resume();
        return;
      }
      const now = clock();
      let clientFailures = loginFailuresFor(loginClient, now);
      if (clientFailures.length >= MAX_FAILED_LOGINS) {
        response.setHeader("retry-after", "60");
        sendError(response, 429, "too_many_attempts");
        request.resume();
        return;
      }
      if (!beginLoginUpload(loginClient)) {
        rejectUpload(request, response);
        return;
      }
      let body;
      try {
        // Read and bound the anonymous body before taking the expensive scrypt
        // single-flight gate. A slow chunked client must not block another
        // address from authenticating while it is still uploading JSON.
        body = await readJson(request, 4096);
      } catch (error) {
        sendError(response, error.statusCode ?? 400, error.message || "invalid_request");
        return;
      } finally {
        endLoginUpload(loginClient);
      }
      // The body read yielded. Re-read the shared limiter state so a set of
      // pre-opened slow uploads cannot each retain and later overwrite a stale
      // empty failure bucket.
      clientFailures = loginFailuresFor(loginClient, clock());
      if (clientFailures.length >= MAX_FAILED_LOGINS) {
        response.setHeader("retry-after", "60");
        sendError(response, 429, "too_many_attempts");
        return;
      }
      if (passwordVerificationActive) {
        response.setHeader("retry-after", "1");
        sendError(response, 429, "authentication_busy");
        request.resume();
        return;
      }
      passwordVerificationActive = true;
      try {
        const loginKeys = body !== null && typeof body === "object" && !Array.isArray(body)
          ? Object.keys(body)
          : [];
        const shape = exactObject(body, new Set(["username", "password", "remember"]))
          && Object.hasOwn(body, "username")
          && Object.hasOwn(body, "password")
          && (loginKeys.length === 2 || loginKeys.length === 3)
          && (loginKeys.length === 2
            ? !Object.hasOwn(body, "remember")
            : typeof body.remember === "boolean");
        const usernameMatches = shape
          && typeof body.username === "string"
          && constantTimeEqual(body.username, service.chat.username);
        const passwordMatches = await verifyChatPassword(
          shape ? body.password : "",
          passwordHash,
        );
        if (!usernameMatches || !passwordMatches) {
          clientFailures.push(clock());
          failedLogins.delete(loginClient);
          failedLogins.set(loginClient, clientFailures);
          sendError(response, 401, "invalid_credentials");
          return;
        }
        failedLogins.delete(loginClient);
        const remembered = body.remember === true;
        try {
          const csrfToken = await createSession(response, remembered);
          sendJson(response, 200, {
            username: service.chat.username,
            csrfToken,
            remembered,
          });
        } catch {
          sendError(response, 503, "session_store_unavailable");
        }
      } finally {
        passwordVerificationActive = false;
      }
      return;
    }

    let authenticated;
    try {
      authenticated = await authenticate(request);
    } catch {
      sendError(response, 503, "session_store_unavailable");
      request.resume();
      return;
    }
    if (request.method === "GET" && target.path === "/chat/api/session") {
      if (!authenticated) {
        sendError(response, 401, "unauthorized");
        return;
      }
      const csrfToken = authenticated.cookies.get(CSRF_COOKIE);
      if (
        typeof csrfToken !== "string"
        || !/^[A-Za-z0-9_-]{32}$/u.test(csrfToken)
        || !constantTimeEqual(sha256(csrfToken), authenticated.session.csrfDigest)
      ) {
        sendError(response, 401, "unauthorized");
        return;
      }
      sendJson(response, 200, {
        authenticated: true,
        username: service.chat.username,
        csrfToken,
        remembered: authenticated.session.remembered,
      });
      return;
    }
    if (request.method === "GET" && target.path === "/chat/api/models") {
      if (!authenticated) {
        sendError(response, 401, "unauthorized");
        return;
      }
      try {
        const models = await availableModelAliases(chatService, token);
        sendJson(response, 200, { models });
      } catch {
        sendError(response, 503, "models_unavailable");
      }
      return;
    }
    if (request.method === "POST" && target.path === "/chat/api/logout") {
      if (
        !authenticated
        || !exactBrowserOrigin(request, allowedHosts)
        || !csrfMatches(request, authenticated)
      ) {
        sendError(response, authenticated ? 403 : 401, authenticated ? "csrf_rejected" : "unauthorized");
        request.resume();
        return;
      }
      try {
        await deleteSession(authenticated.digest);
      } catch {
        sendError(response, 503, "session_store_unavailable");
        request.resume();
        return;
      }
      clearSessionCookies(response);
      sendJson(response, 200, { signedOut: true });
      request.resume();
      return;
    }
    if (request.method === "POST" && target.path === "/chat/api/completions") {
      if (
        !authenticated
        || !exactBrowserOrigin(request, allowedHosts)
        || !csrfMatches(request, authenticated)
      ) {
        sendError(response, authenticated ? 403 : 401, authenticated ? "csrf_rejected" : "unauthorized");
        request.resume();
        return;
      }
      if (!beginCompletionUpload(authenticated.session, request)) {
        rejectUpload(request, response);
        return;
      }
      try {
        let input;
        try {
          input = await readJson(request, service.chat.maxBodyBytes);
        } finally {
          endCompletionUpload(authenticated.session, request);
        }
        const payload = normalizeCompletion(input, service.chat);
        // Body reads yield to the event loop. Logout or expiry may revoke this
        // session while a slow authenticated upload is still incomplete.
        await pruneSessions();
        const rememberedIsCurrent = !authenticated.session.remembered
          || (rememberStore !== null && await rememberStore.hasDigest(authenticated.digest));
        if (
          sessions.get(authenticated.digest) !== authenticated.session
          || !rememberedIsCurrent
          || !csrfMatches(request, authenticated)
        ) {
          sendError(response, 401, "unauthorized");
          return;
        }
        await streamCompletion(
          request,
          response,
          chatService,
          token,
          payload,
          authenticated.session.activeStreams,
        );
      } catch (error) {
        if (!response.headersSent && !response.destroyed && !response.writableEnded) {
          sendError(response, error.statusCode ?? 400, error.message || "invalid_request");
        }
      }
      return;
    }

    sendError(response, 404, "not_found", request.method);
    request.resume();
  });
  server.maxHeadersCount = 48;
  server.maxConnections = 128;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const listener = runtimeListen(listenOverride ?? service.chat.listen);
  await listen(server, listener);
  const closeSessions = () => {
    for (const digest of [...sessions.keys()]) endSessionRuntime(digest);
  };
  if (signal) {
    if (signal.aborted) {
      closeSessions();
      await new Promise((resolve) => server.close(resolve));
    } else {
      signal.addEventListener("abort", () => {
        closeSessions();
        server.close();
      }, { once: true });
    }
  }
  return sessionHandle(server, listener, service.id, closeSessions);
}
