import http from "node:http";

import { normalizeManifest } from "./config.js";
import { compileWorkerPolicy } from "./http-policy.js";
import { proxyHttpRequest, sendJsonError } from "./proxy.js";
import {
  assertSecretToken,
  constantTimeEqual,
  getBearerFromRequest,
  normalizeLoopbackListener,
  RELAY_HEADER,
} from "./security.js";

function readMapValue(source, key) {
  if (source instanceof Map) return source.get(key);
  if (source && typeof source === "object") return source[key];
  return undefined;
}

function chooseService(manifest, serviceId) {
  if (serviceId === undefined && manifest.spec.services.length === 1) {
    return manifest.spec.services[0];
  }
  const service = manifest.spec.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new TypeError("startWorkerServer requires a valid serviceId");
  return service;
}

function runtimeListen(value, fallback) {
  if (value === undefined) return normalizeLoopbackListener(fallback, "worker listener");
  if (typeof value === "string" && value.endsWith(":0")) {
    const base = normalizeLoopbackListener(`${value.slice(0, -1)}1`, "worker listener");
    return { ...base, port: 0, value };
  }
  return normalizeLoopbackListener(value, "worker listener");
}

async function beginListening(server, listener) {
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

function handle(server, service, activeSockets, activeExchanges) {
  const address = server.address();
  const formattedHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closePromise;
  const closeOwnedConnections = () => {
    for (const { request, response } of activeExchanges) {
      if (!response.destroyed) response.destroy();
      if (!request.destroyed) request.destroy();
    }
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    for (const socket of activeSockets) {
      if (!socket.destroyed) socket.destroy();
    }
  };
  const close = () => {
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        closeOwnedConnections();
        resolve();
        return;
      }
      server.close((error) => {
        closeOwnedConnections();
        if (error) reject(error);
        else resolve();
      });
      closeOwnedConnections();
    });
    return closePromise;
  };
  return Object.freeze({
    server,
    service,
    address: Object.freeze({ host: address.address, port: address.port }),
    url: `http://${formattedHost}:${address.port}`,
    close,
  });
}

export async function startWorkerServer({
  manifest: manifestInput,
  serviceId,
  relayToken,
  relayTokens,
  upstreamToken,
  upstreamTokens,
  listen,
  timeoutMs,
  signal,
} = {}) {
  const manifest = normalizeManifest(manifestInput);
  const service = chooseService(manifest, serviceId);
  const policy = compileWorkerPolicy(service);
  const expectedRelay = assertSecretToken(
    readMapValue(relayTokens, service.id) ?? relayToken,
    `relay capability for ${service.id}`,
  );
  const localUpstream = assertSecretToken(
    readMapValue(upstreamTokens, service.id) ?? upstreamToken,
    `upstream capability for ${service.id}`,
  );
  let concurrent = 0;
  const activeSockets = new Set();
  const activeExchanges = new Set();

  const server = http.createServer(async (request, response) => {
    const exchange = { request, response };
    const releaseExchange = () => {
      activeExchanges.delete(exchange);
      response.off("finish", releaseExchange);
      response.off("close", releaseExchange);
    };
    activeExchanges.add(exchange);
    response.once("finish", releaseExchange);
    response.once("close", releaseExchange);
    response.setHeader("cache-control", "no-store");
    const suppliedRelay = getBearerFromRequest(request, RELAY_HEADER);
    if (suppliedRelay === null || !constantTimeEqual(suppliedRelay, expectedRelay)) {
      sendJsonError(response, 401, "unauthorized_relay");
      request.resume();
      return;
    }
    const decision = policy.decideRequest(request);
    if (!decision.allowed) {
      const malformed = decision.reason === "unsafe_path";
      sendJsonError(response, malformed ? 400 : 404, malformed ? "unsafe_request" : "not_found");
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
        target: service.worker.target,
        injectHeaders: {
          authorization: `Bearer ${localUpstream}`,
        },
        maxBodyBytes: decision.route?.maxBodyBytes ?? service.public.maxBodyBytes,
        timeoutMs: timeoutMs ?? (service.public.idleTimeoutSeconds * 1000),
        unavailableStatusCode: 502,
        forwardCookies: service.public.forwardCookies === true,
      });
    } catch {
      sendJsonError(response, 500, "worker_error");
      request.resume();
    } finally {
      concurrent = Math.max(0, concurrent - 1);
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const listener = runtimeListen(listen, service.worker.listen);
  await beginListening(server, listener);
  const workerHandle = handle(server, service, activeSockets, activeExchanges);
  if (signal) {
    if (signal.aborted) await workerHandle.close();
    else {
      const onAbort = () => {
        workerHandle.close().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      server.once("close", () => signal.removeEventListener("abort", onAbort));
    }
  }
  return workerHandle;
}
