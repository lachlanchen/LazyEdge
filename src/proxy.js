import http from "node:http";

import {
  normalizeLoopbackUrl,
  parseRequestTarget,
  RELAY_HEADER,
} from "./security.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REQUEST_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  RELAY_HEADER,
  "cookie",
  "expect",
  "forwarded",
  "host",
  "proxy-connection",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-path",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-forwarded-proto",
  "x-forwarded-uri",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
  "x-middleware-rewrite",
  "x-original-url",
  "x-original-uri",
  "x-reproxy-url",
  "x-real-ip",
  "x-rewrite-url",
  "x-envoy-original-path",
]);

const RESPONSE_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  RELAY_HEADER,
  "proxy-connection",
  "set-cookie",
]);

function copyHeaders(source, blocked) {
  const effectiveBlocked = new Set(blocked);
  const connection = source?.connection;
  const connectionValues = Array.isArray(connection) ? connection : [connection];
  for (const value of connectionValues) {
    if (typeof value !== "string") continue;
    for (const token of value.split(",")) {
      const name = token.trim().toLowerCase();
      if (/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) effectiveBlocked.add(name);
    }
  }
  const target = Object.create(null);
  for (const [rawName, value] of Object.entries(source ?? {})) {
    const name = rawName.toLowerCase();
    if (effectiveBlocked.has(name) || name.startsWith("x-lazyedge-") || value === undefined) continue;
    target[name] = value;
  }
  return target;
}

function contentLength(request) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === "content-length") {
      values.push(String(request.rawHeaders[index + 1] ?? ""));
    }
  }
  if (values.length === 0 && request.headers["content-length"] !== undefined) {
    values.push(String(request.headers["content-length"]));
  }
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/u.test(values[0])) return Number.NaN;
  const length = Number(values[0]);
  return Number.isSafeInteger(length) ? length : Number.NaN;
}

export function sendJsonError(response, statusCode, code) {
  if (response.headersSent || response.destroyed) {
    if (!response.destroyed) response.destroy();
    return;
  }
  const payload = Buffer.from(`${JSON.stringify({ error: { code } })}\n`);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": payload.length,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

export function sanitizeRequestHeaders(headers, injectHeaders = {}) {
  const sanitized = copyHeaders(headers, REQUEST_BLOCKED_HEADERS);
  for (const [rawName, rawValue] of Object.entries(injectHeaders)) {
    const name = rawName.toLowerCase();
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)
      || rawValue === undefined
      || /[\r\n]/u.test(String(rawValue))
    ) {
      throw new TypeError("Injected proxy header is invalid");
    }
    sanitized[name] = String(rawValue);
  }
  return sanitized;
}

export function sanitizeResponseHeaders(headers) {
  return copyHeaders(headers, RESPONSE_BLOCKED_HEADERS);
}

export function proxyHttpRequest(request, response, {
  target,
  injectHeaders = {},
  maxBodyBytes = 1024 * 1024,
  timeoutMs = 120_000,
  unavailableStatusCode = 503,
  pathOverride,
} = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError("maxBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  const base = new URL(normalizeLoopbackUrl(target, "proxy target"));
  const requestTarget = parseRequestTarget(pathOverride ?? request.url);
  const declaredLength = contentLength(request);
  if (Number.isNaN(declaredLength)) {
    sendJsonError(response, 400, "invalid_content_length");
    request.resume();
    return Promise.resolve({ ok: false, code: "invalid_content_length" });
  }
  if (declaredLength !== null && declaredLength > maxBodyBytes) {
    sendJsonError(response, 413, "body_too_large");
    request.resume();
    return Promise.resolve({ ok: false, code: "body_too_large" });
  }

  const headers = sanitizeRequestHeaders(request.headers, injectHeaders);
  if (declaredLength !== null) headers["content-length"] = String(declaredLength);

  return new Promise((resolve) => {
    let settled = false;
    let upstreamResponse;
    let bodyBytes = 0;
    let bodyRejected = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const upstreamRequest = http.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: request.method,
      path: requestTarget.raw,
      headers,
      agent: false,
    });

    upstreamRequest.setTimeout(timeoutMs, () => {
      const error = new Error("upstream timeout");
      error.code = "ETIMEDOUT";
      upstreamRequest.destroy(error);
    });

    upstreamRequest.on("response", (incoming) => {
      upstreamResponse = incoming;
      if (bodyRejected || response.destroyed) {
        incoming.destroy();
        return;
      }
      const responseHeaders = sanitizeResponseHeaders(incoming.headers);
      if (String(incoming.headers["content-type"] ?? "").startsWith("text/event-stream")) {
        responseHeaders["cache-control"] = "no-cache, no-transform";
        responseHeaders["x-accel-buffering"] = "no";
      }
      response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, responseHeaders);
      incoming.on("data", (chunk) => {
        if (!response.write(chunk)) incoming.pause();
      });
      response.on("drain", () => incoming.resume());
      incoming.on("end", () => {
        if (!response.destroyed) response.end();
      });
      incoming.on("aborted", () => {
        if (!response.destroyed) response.destroy();
      });
      incoming.on("error", () => {
        if (!response.destroyed) response.destroy();
      });
    });

    upstreamRequest.on("drain", () => request.resume());
    upstreamRequest.on("error", (error) => {
      if (bodyRejected) return;
      if (!response.headersSent) {
        sendJsonError(
          response,
          unavailableStatusCode,
          error.code === "ETIMEDOUT" ? "upstream_timeout" : "upstream_unavailable",
        );
      } else if (!response.destroyed) {
        response.destroy();
      }
    });

    request.on("data", (chunk) => {
      if (bodyRejected) return;
      bodyBytes += chunk.length;
      if (bodyBytes > maxBodyBytes) {
        bodyRejected = true;
        upstreamRequest.destroy();
        if (upstreamResponse) upstreamResponse.destroy();
        sendJsonError(response, 413, "body_too_large");
        request.resume();
        return;
      }
      if (!upstreamRequest.write(chunk)) request.pause();
    });
    request.on("end", () => {
      if (!bodyRejected && !upstreamRequest.destroyed) upstreamRequest.end();
    });
    request.on("aborted", () => {
      upstreamRequest.destroy();
      if (upstreamResponse) upstreamResponse.destroy();
      settle({ ok: false, code: "client_aborted" });
    });
    request.on("error", () => {
      upstreamRequest.destroy();
      if (upstreamResponse) upstreamResponse.destroy();
    });

    const terminateIncompleteClientBody = () => {
      if (!request.complete && !request.destroyed) request.destroy();
    };
    response.on("finish", () => {
      terminateIncompleteClientBody();
      settle({ ok: !bodyRejected, code: bodyRejected ? "body_too_large" : "ok" });
    });
    response.on("close", () => {
      terminateIncompleteClientBody();
      if (!response.writableFinished) {
        upstreamRequest.destroy();
        if (upstreamResponse) upstreamResponse.destroy();
      }
      settle({ ok: response.writableFinished && !bodyRejected, code: "closed" });
    });
  });
}
