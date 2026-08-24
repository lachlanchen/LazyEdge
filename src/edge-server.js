import http from "node:http";

import {
  LOCALLLM_NODE_ADMISSION_PROFILE,
  normalizeManifest,
} from "./config.js";
import { compileHttpPolicy } from "./http-policy.js";
import { proxyHttpRequest, sendJsonError } from "./proxy.js";
import {
  assertSecretToken,
  getBearerFromRequest,
  getRequestHost,
  normalizeLoopbackListener,
  normalizeMethod,
  parseRequestTarget,
  RELAY_HEADER,
} from "./security.js";

function readMapValue(source, key) {
  if (source instanceof Map) return source.get(key);
  if (source && typeof source === "object") return source[key];
  return undefined;
}

function ownDataProperty(value, key) {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function hasPrivateListenerScope(verified, { service, method, path }) {
  try {
    if (ownDataProperty(verified, "tokenSet") !== service.public.tokenSet) return false;
    const scope = ownDataProperty(verified, "scope");
    const serviceIds = ownDataProperty(scope, "serviceIds");
    const methods = ownDataProperty(scope, "methods");
    const paths = ownDataProperty(scope, "paths");
    if (
      !Array.isArray(serviceIds)
      || serviceIds.length !== 1
      || serviceIds[0] !== service.id
      || !Array.isArray(methods)
      || methods.length < 1
      || methods.length > 256
      || !Array.prototype.includes.call(methods, method)
      || !Array.isArray(paths)
      || paths.length < 1
      || paths.length > 256
      || !Array.prototype.includes.call(paths, path)
    ) return false;
    return Object.getOwnPropertyDescriptor(scope, "hosts") === undefined;
  } catch {
    return false;
  }
}

function runtimeListen(value, fallback) {
  if (value === undefined) return normalizeLoopbackListener(fallback, "edge listener");
  if (typeof value === "string" && value.endsWith(":0")) {
    const base = normalizeLoopbackListener(`${value.slice(0, -1)}1`, "edge listener");
    return { ...base, port: 0, value };
  }
  return normalizeLoopbackListener(value, "edge listener");
}

function createExternalVerifier({ tokenStore, tokenStores, verifyExternalToken }, tokenSets) {
  if (verifyExternalToken !== undefined) {
    if (typeof verifyExternalToken !== "function") {
      throw new TypeError("verifyExternalToken must be a function");
    }
    return verifyExternalToken;
  }
  for (const tokenSet of tokenSets) {
    const store = readMapValue(tokenStores, tokenSet) ?? tokenStore;
    if (!store || typeof store.verify !== "function") {
      throw new TypeError(`No TokenStore/verifier configured for tokenSet ${tokenSet}`);
    }
  }
  return ({ token, tokenSet, context }) => {
    const store = readMapValue(tokenStores, tokenSet) ?? tokenStore;
    return store.verify(token, { tokenSet, context });
  };
}

function resolveRelayTokens(manifest, relayTokens, relayToken) {
  const result = new Map();
  if (relayToken !== undefined && manifest.spec.services.length > 1) {
    throw new TypeError("relayToken shorthand is only valid for one service");
  }
  for (const service of manifest.spec.services) {
    const token = readMapValue(relayTokens, service.id) ?? relayToken;
    result.set(service.id, assertSecretToken(token, `relay capability for ${service.id}`));
  }
  return result;
}

async function listen(server, { host, port }) {
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
    server.listen({ host, port, exclusive: true });
  });
}

function runtimeHandle(server, host) {
  const address = server.address();
  const formattedHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closePromise;
  const close = () => {
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        server.closeAllConnections?.();
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    return closePromise;
  };
  return Object.freeze({
    server,
    address: Object.freeze({ host: address.address, port: address.port }),
    url: `http://${formattedHost}:${address.port}`,
    close,
    configuredHost: host,
  });
}

async function runtimeHandleWithSignal(server, listener, signal) {
  const handle = runtimeHandle(server, listener.host);
  if (signal) {
    if (signal.aborted) await handle.close();
    else {
      signal.addEventListener("abort", () => {
        handle.close().catch(() => {});
      }, { once: true });
    }
  }
  return handle;
}

export async function startEdgeServer({
  manifest: manifestInput,
  tokenStore,
  tokenStores,
  verifyExternalToken,
  relayToken,
  relayTokens,
  listen: listenOverride,
  timeoutMs,
  signal,
} = {}) {
  const manifest = normalizeManifest(manifestInput);
  const policy = compileHttpPolicy(manifest);
  const publicServices = manifest.spec.services.filter(
    (service) => (service.exposure ?? "public") === "public",
  );
  const tokenSets = new Set(publicServices.map((service) => service.public.tokenSet));
  const verify = createExternalVerifier(
    { tokenStore, tokenStores, verifyExternalToken },
    tokenSets,
  );
  const relayByService = resolveRelayTokens(
    { spec: { services: publicServices } },
    relayTokens,
    relayToken,
  );
  const concurrent = new Map(publicServices.map((service) => [service.id, 0]));

  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    let decision;
    try {
      decision = policy.decideRequest(request);
    } catch {
      sendJsonError(response, 400, "unsafe_request");
      request.resume();
      return;
    }
    if (!decision.allowed) {
      const malformed = decision.reason === "invalid_host" || decision.reason === "unsafe_path";
      sendJsonError(response, malformed ? 400 : 404, malformed ? "unsafe_request" : "not_found");
      request.resume();
      return;
    }

    const externalToken = getBearerFromRequest(request, "authorization");
    if (externalToken === null) {
      sendJsonError(response, 401, "unauthorized");
      request.resume();
      return;
    }
    const target = parseRequestTarget(request.url);
    const host = getRequestHost(request);
    let verified;
    try {
      verified = await verify({
        token: externalToken,
        tokenSet: decision.service.public.tokenSet,
        context: {
          serviceId: decision.service.id,
          host,
          method: request.method,
          path: target.path,
        },
      });
    } catch {
      sendJsonError(response, 503, "authentication_unavailable");
      request.resume();
      return;
    }
    if (!verified) {
      sendJsonError(response, 401, "unauthorized");
      request.resume();
      return;
    }

    const current = concurrent.get(decision.service.id) ?? 0;
    if (current >= decision.service.public.maxConcurrentRequests) {
      response.setHeader("retry-after", "1");
      sendJsonError(response, 429, "too_many_requests");
      request.resume();
      return;
    }
    concurrent.set(decision.service.id, current + 1);
    try {
      await proxyHttpRequest(request, response, {
        target: decision.service.edge.upstream,
        injectHeaders: {
          [RELAY_HEADER]: `Bearer ${relayByService.get(decision.service.id)}`,
        },
        maxBodyBytes: decision.service.public.maxBodyBytes,
        timeoutMs: timeoutMs ?? (decision.service.public.idleTimeoutSeconds * 1000),
        unavailableStatusCode: 503,
      });
    } catch {
      sendJsonError(response, 500, "gateway_error");
      request.resume();
    } finally {
      concurrent.set(decision.service.id, Math.max(0, (concurrent.get(decision.service.id) ?? 1) - 1));
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const listener = runtimeListen(listenOverride, manifest.spec.edge.gatewayListen);
  await listen(server, listener);
  return runtimeHandleWithSignal(server, listener, signal);
}

export async function startPrivateServiceServer(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("startPrivateServiceServer options must be an object");
  }
  if (Object.hasOwn(options, "listen")) {
    throw new TypeError("Private listener binding is manifest-authoritative; listen overrides are forbidden");
  }
  const {
    manifest: manifestInput,
    serviceId,
    tokenStore,
    tokenStores,
    verifyExternalToken,
    relayToken,
    relayTokens,
    timeoutMs,
    signal,
  } = options;
  const manifest = normalizeManifest(manifestInput);
  if (typeof serviceId !== "string") {
    throw new TypeError("startPrivateServiceServer requires an explicit configured serviceId");
  }
  const configuredListener = (manifest.spec.edge.privateListeners ?? [])
    .find((candidate) => candidate.service === serviceId);
  if (!configuredListener) {
    throw new TypeError("serviceId does not own a configured private listener");
  }
  const service = manifest.spec.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new TypeError("Private listener names an unknown serviceId");

  const claims = new Set();
  for (const route of service.public.routes) {
    for (const method of route.methods) claims.add(`${method}\u0000${route.path}`);
  }
  const verify = createExternalVerifier(
    { tokenStore, tokenStores, verifyExternalToken },
    new Set([service.public.tokenSet]),
  );
  const relay = resolveRelayTokens(
    { spec: { services: [service] } },
    relayTokens,
    relayToken,
  ).get(service.id);
  let concurrent = 0;

  const server = http.createServer(async (request, response) => {
    let requestTarget;
    let method;
    try {
      requestTarget = parseRequestTarget(request.url);
      method = normalizeMethod(request.method);
    } catch {
      sendJsonError(response, 400, "unsafe_request");
      request.resume();
      return;
    }
    if (requestTarget.query !== "" || !claims.has(`${method}\u0000${requestTarget.path}`)) {
      sendJsonError(response, 404, "not_found");
      request.resume();
      return;
    }

    const token = getBearerFromRequest(request, "authorization");
    if (token === null) {
      sendJsonError(response, 401, "unauthorized");
      request.resume();
      return;
    }
    let verified;
    try {
      verified = await verify({
        token,
        tokenSet: service.public.tokenSet,
        context: {
          serviceId: service.id,
          method,
          path: requestTarget.path,
        },
      });
    } catch {
      sendJsonError(response, 503, "authentication_unavailable");
      request.resume();
      return;
    }
    if (!hasPrivateListenerScope(verified, {
      service,
      method,
      path: requestTarget.path,
    })) {
      sendJsonError(response, 401, "unauthorized");
      request.resume();
      return;
    }

    if (concurrent >= service.public.maxConcurrentRequests) {
      response.setHeader("retry-after", "1");
      sendJsonError(response, 429, "too_many_requests");
      request.resume();
      return;
    }
    concurrent += 1;
    try {
      await proxyHttpRequest(request, response, {
        target: service.edge.upstream,
        injectHeaders: { [RELAY_HEADER]: `Bearer ${relay}` },
        maxBodyBytes: service.public.maxBodyBytes,
        timeoutMs: timeoutMs ?? (service.public.idleTimeoutSeconds * 1000),
        unavailableStatusCode: 503,
      });
    } catch {
      sendJsonError(response, 500, "gateway_error");
      request.resume();
    } finally {
      concurrent = Math.max(0, concurrent - 1);
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const listener = normalizeLoopbackListener(
    configuredListener.listen,
    "configured private service listener",
  );
  await listen(server, listener);
  return runtimeHandleWithSignal(server, listener, signal);
}

export async function startCompatibilityServer(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("startCompatibilityServer options must be an object");
  }
  if (Object.hasOwn(options, "listen")) {
    throw new TypeError(
      "Compatibility listener binding is manifest-authoritative; listen overrides are forbidden",
    );
  }
  const {
    manifest: manifestInput,
    serviceId,
    tokenStore,
    tokenStores,
    verifyExternalToken,
    relayToken,
    relayTokens,
    timeoutMs,
    signal,
  } = options;
  const manifest = normalizeManifest(manifestInput);
  if (typeof serviceId !== "string") {
    throw new TypeError("startCompatibilityServer requires an explicit serviceId");
  }
  if (manifest.spec.edge.compatibilityListen === undefined) {
    throw new TypeError("spec.edge.compatibilityListen is required");
  }
  if (serviceId !== manifest.spec.edge.compatibilityService) {
    throw new TypeError("serviceId must equal spec.edge.compatibilityService");
  }
  const service = manifest.spec.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new TypeError("Unknown compatibility serviceId");
  if ((service.exposure ?? "public") !== "public") {
    throw new TypeError("Compatibility listeners require public service exposure");
  }
  if (service.public.routes.some((route) => route.path === "/healthz")) {
    throw new TypeError("/healthz is reserved for the private compatibility health probe");
  }
  if (
    service.profile !== LOCALLLM_NODE_ADMISSION_PROFILE
    && service.public.routes.some((route) => !route.path.startsWith("/v1/"))
  ) {
    throw new TypeError("Compatibility listeners only support explicit /v1 API routes");
  }
  const publicClaims = new Set();
  for (const route of service.public.routes) {
    for (const method of route.methods) publicClaims.add(`${method}\u0000${route.path}`);
  }
  const verify = createExternalVerifier(
    { tokenStore, tokenStores, verifyExternalToken },
    new Set([service.public.tokenSet]),
  );
  const relay = resolveRelayTokens(
    { spec: { services: [service] } },
    relayTokens,
    relayToken,
  ).get(service.id);
  let concurrent = 0;

  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    let requestTarget;
    let method;
    try {
      requestTarget = parseRequestTarget(request.url);
      method = normalizeMethod(request.method);
    } catch {
      sendJsonError(response, 400, "unsafe_request");
      request.resume();
      return;
    }

    const isHealth = method === "GET"
      && requestTarget.path === "/healthz"
      && service.worker.healthPath !== undefined;
    if (!isHealth && !publicClaims.has(`${method}\u0000${requestTarget.path}`)) {
      sendJsonError(response, 404, "not_found");
      request.resume();
      return;
    }
    if (!isHealth) {
      const token = getBearerFromRequest(request, "authorization");
      if (token === null) {
        sendJsonError(response, 401, "unauthorized");
        request.resume();
        return;
      }
      let verified;
      try {
        verified = await verify({
          token,
          tokenSet: service.public.tokenSet,
          context: {
            serviceId: service.id,
            host: service.domains[0],
            method,
            path: requestTarget.path,
          },
        });
      } catch {
        sendJsonError(response, 503, "authentication_unavailable");
        request.resume();
        return;
      }
      if (!verified) {
        sendJsonError(response, 401, "unauthorized");
        request.resume();
        return;
      }
    }

    if (concurrent >= service.public.maxConcurrentRequests) {
      response.setHeader("retry-after", "1");
      sendJsonError(response, 429, "too_many_requests");
      request.resume();
      return;
    }
    concurrent += 1;
    try {
      await proxyHttpRequest(request, response, {
        target: service.edge.upstream,
        injectHeaders: { [RELAY_HEADER]: `Bearer ${relay}` },
        maxBodyBytes: service.public.maxBodyBytes,
        timeoutMs: timeoutMs ?? (service.public.idleTimeoutSeconds * 1000),
        unavailableStatusCode: 503,
        pathOverride: isHealth ? service.worker.healthPath : undefined,
      });
    } catch {
      sendJsonError(response, 500, "compatibility_gateway_error");
      request.resume();
    } finally {
      concurrent = Math.max(0, concurrent - 1);
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const listener = normalizeLoopbackListener(
    manifest.spec.edge.compatibilityListen,
    "configured compatibility listener",
  );
  await listen(server, listener);
  return runtimeHandleWithSignal(server, listener, signal);
}
