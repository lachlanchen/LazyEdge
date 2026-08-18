import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export const TOKEN_ENTROPY_BYTES = 32;
export const RELAY_HEADER = "x-lazyedge-relay-authorization";

export class SecurityError extends Error {
  constructor(message, { code = "SECURITY_POLICY", statusCode = 400 } = {}) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function sha256(value, encoding = "hex") {
  return createHash("sha256").update(value).digest(encoding);
}

export function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

export function generateCapabilityToken(prefix = "le") {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(prefix)) {
    throw new TypeError("Capability token prefix is invalid");
  }
  return `${prefix}_${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

export function assertSecretToken(token, label = "capability token") {
  if (
    typeof token !== "string"
    || token.length < 32
    || token.length > 4096
    || /[\s\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new SecurityError(`${label} is invalid`, {
      code: "INVALID_CAPABILITY",
      statusCode: 500,
    });
  }
  return token;
}

export function parseBearer(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(value);
  if (!match) return null;
  return match[1];
}

export function getSingleHeader(request, headerName) {
  const wanted = headerName.toLowerCase();
  const values = [];
  const rawHeaders = Array.isArray(request?.rawHeaders) ? request.rawHeaders : [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === wanted) {
      values.push(String(rawHeaders[index + 1] ?? ""));
    }
  }

  if (values.length === 0 && request?.headers) {
    const fallback = request.headers[wanted];
    if (Array.isArray(fallback)) values.push(...fallback.map(String));
    else if (fallback !== undefined) values.push(String(fallback));
  }

  if (values.length !== 1 || values[0].includes("\n") || values[0].includes("\r")) {
    return null;
  }
  return values[0];
}

export function getBearerFromRequest(request, headerName = "authorization") {
  const header = getSingleHeader(request, headerName);
  return header === null ? null : parseBearer(header);
}

export function normalizeDomain(value, label = "domain") {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) {
    throw new SecurityError(`${label} must be an exact DNS name`);
  }
  if (
    value !== value.trim()
    || value.endsWith(".")
    || /[*\s/@\\:%]/u.test(value)
  ) {
    throw new SecurityError(`${label} must be an exact DNS name`);
  }
  const ascii = domainToASCII(value).toLowerCase();
  if (!ascii || ascii.length > 253 || isIP(ascii)) {
    throw new SecurityError(`${label} must be a DNS name, not an IP address`);
  }
  const labels = ascii.split(".");
  if (
    labels.length < 2
    || labels.some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))
  ) {
    throw new SecurityError(`${label} must be an exact DNS name`);
  }
  return ascii;
}

export function normalizeRequestHost(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 512) {
    throw new SecurityError("Invalid Host header", { code: "INVALID_HOST" });
  }
  if (/[\s,@/\\%]/u.test(value) || value.startsWith("[")) {
    throw new SecurityError("Invalid Host header", { code: "INVALID_HOST" });
  }
  let hostname = value;
  const colon = value.lastIndexOf(":");
  if (colon !== -1) {
    if (value.indexOf(":") !== colon || !/^\d{1,5}$/u.test(value.slice(colon + 1))) {
      throw new SecurityError("Invalid Host header", { code: "INVALID_HOST" });
    }
    const port = Number(value.slice(colon + 1));
    if (port < 1 || port > 65535) {
      throw new SecurityError("Invalid Host header", { code: "INVALID_HOST" });
    }
    hostname = value.slice(0, colon);
  }
  return normalizeDomain(hostname, "Host header");
}

export function getRequestHost(request) {
  const host = getSingleHeader(request, "host");
  if (host === null) {
    throw new SecurityError("Exactly one Host header is required", {
      code: "INVALID_HOST",
    });
  }
  return normalizeRequestHost(host);
}

export function normalizeMethod(value) {
  if (typeof value !== "string" || !/^[A-Z]+$/u.test(value)) {
    throw new SecurityError("HTTP method must be uppercase ASCII");
  }
  const allowed = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  if (!allowed.has(value)) throw new SecurityError(`HTTP method ${value} is not supported`);
  return value;
}

function assertNoTraversal(pathname) {
  if (/\\|%2f|%5c/iu.test(pathname)) {
    throw new SecurityError("Encoded or backslash path separators are forbidden", {
      code: "UNSAFE_PATH",
    });
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new SecurityError("Malformed percent encoding in request path", {
      code: "UNSAFE_PATH",
    });
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(decoded)) {
    throw new SecurityError("Control characters and backslashes are forbidden in paths", {
      code: "UNSAFE_PATH",
    });
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new SecurityError("Path traversal is forbidden", { code: "UNSAFE_PATH" });
  }
  return decoded;
}

export function normalizeRoutePath(value, { requireV1 = false } = {}) {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > 2048
    || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(value)
  ) {
    throw new SecurityError("Route path must be one exact absolute path");
  }
  const decoded = assertNoTraversal(value);
  if (decoded !== value) {
    throw new SecurityError("Configured route paths must already be canonical", {
      code: "UNSAFE_PATH",
    });
  }
  if (requireV1 && !value.startsWith("/v1/")) {
    throw new SecurityError("Public routes must be explicit /v1/* API paths", {
      code: "UNSAFE_PATH",
    });
  }
  return value;
}

export function parseRequestTarget(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 16384
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("#")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SecurityError("Unsafe HTTP request target", { code: "UNSAFE_PATH" });
  }
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  if (pathname.includes("//")) {
    throw new SecurityError("Repeated path separators are forbidden", {
      code: "UNSAFE_PATH",
    });
  }
  assertNoTraversal(pathname);
  return Object.freeze({
    path: pathname,
    query: queryIndex === -1 ? "" : value.slice(queryIndex),
    raw: value,
  });
}

export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string") return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

export function normalizeLoopbackListener(value, label = "listener") {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new SecurityError(`${label} must be a loopback host:port`);
  }
  let host;
  let portText;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(value);
    if (!match) throw new SecurityError(`${label} must be a loopback host:port`);
    [, host, portText] = match;
  } else {
    const match = /^([^:]+):(\d{1,5})$/u.exec(value);
    if (!match) throw new SecurityError(`${label} must be a loopback host:port`);
    [, host, portText] = match;
  }
  if (!isLoopbackHost(host)) {
    throw new SecurityError(`${label} must bind to a numeric loopback address`);
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SecurityError(`${label} port is invalid`);
  }
  const normalizedHost = host.toLowerCase() === "::1" ? "::1" : host;
  return Object.freeze({
    host: normalizedHost,
    port,
    value: normalizedHost === "::1" ? `[::1]:${port}` : `${normalizedHost}:${port}`,
  });
}

export function normalizeLoopbackUrl(value, label = "target") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecurityError(`${label} must be an absolute loopback HTTP URL`);
  }
  if (
    parsed.protocol !== "http:"
    || !isLoopbackHost(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/"
    || !parsed.port
  ) {
    throw new SecurityError(`${label} must be http://<numeric-loopback>:<port>`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SecurityError(`${label} port is invalid`);
  }
  const host = parsed.hostname === "[::1]" || parsed.hostname === "::1"
    ? "[::1]"
    : parsed.hostname;
  return `http://${host}:${port}`;
}

export function normalizePrivateHealthPath(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) {
    throw new SecurityError("Private healthPath is too long");
  }
  const path = normalizeRoutePath(value, { requireV1: false });
  if (path.startsWith("/v1/")) {
    throw new SecurityError("Private healthPath must not overlap the public /v1 API");
  }
  return path;
}
