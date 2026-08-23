import { normalizeManifest } from "./config.js";
import {
  getRequestHost,
  normalizeMethod,
  parseRequestTarget,
  SecurityError,
} from "./security.js";

export class PolicyDecision {
  constructor({ allowed, reason, service = null, route = null, target = null }) {
    this.allowed = allowed;
    this.reason = reason;
    this.service = service;
    this.route = route;
    this.target = target;
    Object.freeze(this);
  }
}

function deny(reason) {
  return new PolicyDecision({ allowed: false, reason });
}

export function compileHttpPolicy(manifestInput) {
  const manifest = normalizeManifest(manifestInput);
  const claims = new Map();
  const hosts = new Set();
  for (const service of manifest.spec.services) {
    if ((service.exposure ?? "public") !== "public") continue;
    for (const host of service.domains) {
      hosts.add(host);
      for (const route of service.public.routes) {
        for (const method of route.methods) {
          claims.set(`${host}\u0000${method}\u0000${route.path}`, { service, route });
        }
      }
    }
  }

  return Object.freeze({
    manifest,
    decide({ host, method, path }) {
      const claim = claims.get(`${host}\u0000${method}\u0000${path}`);
      if (!claim) return deny(hosts.has(host) ? "route-not-allowed" : "host-not-allowed");
      return new PolicyDecision({
        allowed: true,
        reason: "exact-claim",
        service: claim.service,
        route: claim.route,
        target: claim.service.edge.upstream,
      });
    },
    decideRequest(request) {
      let host;
      let target;
      let method;
      try {
        host = getRequestHost(request);
        target = parseRequestTarget(request.url);
        method = normalizeMethod(request.method);
      } catch (error) {
        if (error instanceof SecurityError) return deny(error.code.toLowerCase());
        throw error;
      }
      return this.decide({ host, method, path: target.path });
    },
  });
}

export function compileWorkerPolicy(service) {
  if (service === null || typeof service !== "object") {
    throw new TypeError("compileWorkerPolicy requires a normalized service");
  }
  const claims = new Set();
  for (const route of service.public.routes) {
    for (const method of route.methods) claims.add(`${method}\u0000${route.path}`);
  }
  const health = service.worker.healthPath;
  return Object.freeze({
    service,
    decide({ method, path }) {
      if (claims.has(`${method}\u0000${path}`)) {
        return new PolicyDecision({
          allowed: true,
          reason: "exact-claim",
          service,
          target: service.worker.target,
        });
      }
      if (health !== undefined && method === "GET" && path === health) {
        return new PolicyDecision({
          allowed: true,
          reason: "private-health",
          service,
          target: service.worker.target,
        });
      }
      return deny("route-not-allowed");
    },
    decideRequest(request) {
      let target;
      let method;
      try {
        target = parseRequestTarget(request.url);
        method = normalizeMethod(request.method);
      } catch (error) {
        if (error instanceof SecurityError) return deny(error.code.toLowerCase());
        throw error;
      }
      return this.decide({ method, path: target.path });
    },
  });
}

export const createHttpPolicy = compileHttpPolicy;
