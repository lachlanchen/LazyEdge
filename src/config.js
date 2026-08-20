import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { parseDocument } from "yaml";

import {
  normalizeDomain,
  normalizeLoopbackListener,
  normalizeLoopbackUrl,
  normalizeMethod,
  normalizePrivateHealthPath,
  normalizeRoutePath,
  SecurityError,
  sha256,
} from "./security.js";

export const API_VERSION = "lazyedge.lazying.art/v1alpha1";
export const MANIFEST_KIND = "EdgeProject";
export const LOCALLLM_OPENAI_PROFILE = "localllm-openai";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;
const LOCALLLM_ROUTE_METHODS = new Map([
  ["/v1/models", new Set(["GET"])],
  ["/v1/chat/completions", new Set(["POST"])],
  ["/v1/responses", new Set(["POST"])],
  ["/v1/embeddings", new Set(["POST"])],
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, label) {
  if (!isPlainObject(value)) throw new SecurityError(`${label} must be an object`);
  return value;
}

function keys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new SecurityError(`${label} contains unknown field: ${unknown.sort()[0]}`, {
      code: "INVALID_MANIFEST",
    });
  }
}

function requiredString(value, label, pattern, maxLength = 128) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || !pattern.test(value)
  ) {
    throw new SecurityError(`${label} is invalid`, { code: "INVALID_MANIFEST" });
  }
  return value;
}

function optionalPort(value, label, fallback, { minimum = 1 } = {}) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isInteger(actual) || actual < minimum || actual > 65535) {
    throw new SecurityError(`${label} must be an integer port`, { code: "INVALID_MANIFEST" });
  }
  return actual;
}

function optionalLimit(value, label, fallback, maximum) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) {
    throw new SecurityError(`${label} is outside its safe range`, {
      code: "INVALID_MANIFEST",
    });
  }
  return actual;
}

function normalizeSshHost(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value !== value.trim() || value.length > 253) {
    throw new SecurityError("spec.transport.sshHost is invalid");
  }
  const unwrapped = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  if (isIP(unwrapped)) return unwrapped.toLowerCase();
  if (/[*\s/@\\:%]/u.test(value) || value.endsWith(".")) {
    throw new SecurityError("spec.transport.sshHost is invalid");
  }
  const ascii = domainToASCII(value).toLowerCase();
  if (
    !ascii
    || ascii.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))
  ) {
    throw new SecurityError("spec.transport.sshHost is invalid");
  }
  return ascii;
}

function normalizeManifestListener(value, label) {
  const listener = normalizeLoopbackListener(value, label);
  if (listener.host !== "127.0.0.1") {
    throw new SecurityError(`${label} must use exact loopback 127.0.0.1`);
  }
  return listener.value;
}

function normalizeManifestTarget(value, label) {
  const target = normalizeLoopbackUrl(value, label);
  if (new URL(target).hostname !== "127.0.0.1") {
    throw new SecurityError(`${label} must use exact loopback 127.0.0.1`);
  }
  return target;
}

function normalizeExistingSiteUpstream(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecurityError(`${label} must be an absolute loopback HTTP URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.hostname !== "127.0.0.1"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/"
    || !parsed.port
  ) {
    throw new SecurityError(`${label} must be http(s)://127.0.0.1:<port>`);
  }
  normalizeLoopbackUrl(`http://${parsed.host}`, label);
  return `${parsed.protocol}//127.0.0.1:${Number(parsed.port)}`;
}

function normalizeRoute(route, serviceLabel, profile) {
  const source = object(route, `${serviceLabel}.public.routes[]`);
  keys(source, ["path", "methods"], `${serviceLabel}.public.routes[]`);
  const path = normalizeRoutePath(source.path);
  if (!Array.isArray(source.methods) || source.methods.length === 0) {
    throw new SecurityError(`${serviceLabel}.public.routes[].methods must not be empty`);
  }
  const methods = [...new Set(source.methods.map(normalizeMethod))].sort();
  if (methods.length !== source.methods.length) {
    throw new SecurityError(`${serviceLabel} has duplicate method claims`, {
      code: "DUPLICATE_CLAIM",
    });
  }
  if (profile === LOCALLLM_OPENAI_PROFILE) {
    const permitted = LOCALLLM_ROUTE_METHODS.get(path);
    if (!permitted || methods.some((method) => !permitted.has(method))) {
      throw new SecurityError(`${serviceLabel} route is not allowed by localllm-openai`, {
        code: "PROFILE_POLICY",
      });
    }
  }
  return { path, methods };
}

function normalizeService(service, index) {
  const label = `spec.services[${index}]`;
  const source = object(service, label);
  keys(
    source,
    ["id", "exposure", "profile", "domains", "edge", "worker", "public"],
    label,
  );
  const id = requiredString(source.id, `${label}.id`, /^[a-z][a-z0-9-]{0,62}$/u, 63);
  const exposure = source.exposure ?? "public";
  if (!new Set(["public", "private"]).has(exposure)) {
    throw new SecurityError(`${label}.exposure must be public or private`, {
      code: "INVALID_MANIFEST",
    });
  }
  const profile = source.profile === undefined
    ? undefined
    : requiredString(source.profile, `${label}.profile`, /^[a-z][a-z0-9-]{0,62}$/u, 63);
  if (profile !== undefined && !["generic-http", LOCALLLM_OPENAI_PROFILE].includes(profile)) {
    throw new SecurityError(`${label}.profile is not supported`, { code: "INVALID_MANIFEST" });
  }

  if (!Array.isArray(source.domains) || source.domains.length > 16) {
    throw new SecurityError(`${label}.domains must be an array of exact public hosts`);
  }
  if (exposure === "public" && source.domains.length === 0) {
    throw new SecurityError(`${label}.domains must contain exact public hosts`);
  }
  if (exposure === "private" && source.domains.length !== 0) {
    throw new SecurityError(`${label}.domains must be empty when exposure is private`, {
      code: "INVALID_MANIFEST",
    });
  }
  const domains = source.domains.map((domain) => normalizeDomain(domain, `${label}.domains[]`));
  if (new Set(domains).size !== domains.length) {
    throw new SecurityError(`${label}.domains contains a duplicate host`, {
      code: "DUPLICATE_CLAIM",
    });
  }

  const edgeSource = object(source.edge, `${label}.edge`);
  keys(edgeSource, ["upstream"], `${label}.edge`);
  const edge = {
    upstream: normalizeManifestTarget(edgeSource.upstream, `${label}.edge.upstream`),
  };

  const workerSource = object(source.worker, `${label}.worker`);
  keys(workerSource, ["listen", "target", "healthPath"], `${label}.worker`);
  const worker = {
    listen: normalizeManifestListener(workerSource.listen, `${label}.worker.listen`),
    target: normalizeManifestTarget(workerSource.target, `${label}.worker.target`),
  };
  const healthPath = normalizePrivateHealthPath(workerSource.healthPath);
  if (healthPath !== undefined) worker.healthPath = healthPath;

  const publicSource = object(source.public, `${label}.public`);
  keys(
    publicSource,
    ["tokenSet", "routes", "maxBodyBytes", "maxConcurrentRequests", "idleTimeoutSeconds"],
    `${label}.public`,
  );
  const tokenSet = requiredString(
    publicSource.tokenSet,
    `${label}.public.tokenSet`,
    /^[a-z][a-z0-9-]{0,62}$/u,
    63,
  );
  if (
    !Array.isArray(publicSource.routes)
    || publicSource.routes.length === 0
    || publicSource.routes.length > 128
  ) {
    throw new SecurityError(`${label}.public.routes must not be empty`);
  }
  const routes = publicSource.routes.map((route) => normalizeRoute(route, label, profile));
  const localClaims = new Set();
  for (const route of routes) {
    if (worker.healthPath === route.path) {
      throw new SecurityError(`${label}.worker.healthPath overlaps a public route`, {
        code: "DUPLICATE_CLAIM",
      });
    }
    for (const method of route.methods) {
      const claim = `${method}\u0000${route.path}`;
      if (localClaims.has(claim)) {
        throw new SecurityError(`${label} has a duplicate route claim`, {
          code: "DUPLICATE_CLAIM",
        });
      }
      localClaims.add(claim);
    }
  }
  routes.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.methods.join(",").localeCompare(right.methods.join(","))
  ));

  const normalized = {
    id,
    domains: [...domains].sort(),
    edge,
    worker,
    public: {
      tokenSet,
      routes,
      maxBodyBytes: optionalLimit(
        publicSource.maxBodyBytes,
        `${label}.public.maxBodyBytes`,
        DEFAULT_MAX_BODY_BYTES,
        1024 * 1024 * 1024,
      ),
      maxConcurrentRequests: optionalLimit(
        publicSource.maxConcurrentRequests,
        `${label}.public.maxConcurrentRequests`,
        DEFAULT_MAX_CONCURRENT_REQUESTS,
        1024,
      ),
      idleTimeoutSeconds: optionalLimit(
        publicSource.idleTimeoutSeconds,
        `${label}.public.idleTimeoutSeconds`,
        DEFAULT_IDLE_TIMEOUT_SECONDS,
        86_400,
      ),
    },
  };
  if (exposure === "private") normalized.exposure = exposure;
  if (profile !== undefined) normalized.profile = profile;
  return normalized;
}

function normalizeEdge(value) {
  const source = object(value, "spec.edge");
  keys(
    source,
    [
      "gatewayListen",
      "httpPort",
      "httpsPort",
      "compatibilityListen",
      "compatibilityService",
      "privateListeners",
      "existingSites",
    ],
    "spec.edge",
  );
  const normalized = {
    gatewayListen: normalizeManifestListener(
      source.gatewayListen,
      "spec.edge.gatewayListen",
    ),
    httpPort: optionalPort(source.httpPort, "spec.edge.httpPort", 10_080, { minimum: 1024 }),
    httpsPort: optionalPort(source.httpsPort, "spec.edge.httpsPort", 10_443, { minimum: 1024 }),
  };
  if (normalized.httpPort === normalized.httpsPort) {
    throw new SecurityError("spec.edge httpPort and httpsPort must differ");
  }
  if (source.compatibilityListen !== undefined) {
    normalized.compatibilityListen = normalizeManifestListener(
      source.compatibilityListen,
      "spec.edge.compatibilityListen",
    );
    if (normalized.compatibilityListen === normalized.gatewayListen) {
      throw new SecurityError("spec.edge listener claims must be unique", {
        code: "DUPLICATE_CLAIM",
      });
    }
  }
  if (source.compatibilityService !== undefined) {
    normalized.compatibilityService = requiredString(
      source.compatibilityService,
      "spec.edge.compatibilityService",
      /^[a-z][a-z0-9-]{0,62}$/u,
      63,
    );
  }
  if (source.privateListeners !== undefined) {
    if (!Array.isArray(source.privateListeners) || source.privateListeners.length > 128) {
      throw new SecurityError("spec.edge.privateListeners must be a bounded array", {
        code: "INVALID_MANIFEST",
      });
    }
    const services = new Set();
    const listeners = new Set();
    const privateListeners = source.privateListeners.map((entry, index) => {
      const label = `spec.edge.privateListeners[${index}]`;
      const privateListener = object(entry, label);
      keys(privateListener, ["service", "listen"], label);
      const service = requiredString(
        privateListener.service,
        `${label}.service`,
        /^[a-z][a-z0-9-]{0,62}$/u,
        63,
      );
      const listen = normalizeManifestListener(privateListener.listen, `${label}.listen`);
      if (listenerPort(listen) < 1024) {
        throw new SecurityError(`${label}.listen must use an unprivileged port (1024-65535)`, {
          code: "INVALID_MANIFEST",
        });
      }
      if (services.has(service)) {
        throw new SecurityError(`Duplicate private listener service: ${service}`, {
          code: "DUPLICATE_CLAIM",
        });
      }
      if (listeners.has(listen)) {
        throw new SecurityError(`Duplicate private listener: ${listen}`, {
          code: "DUPLICATE_CLAIM",
        });
      }
      services.add(service);
      listeners.add(listen);
      return { service, listen };
    }).sort((left, right) => (
      left.service.localeCompare(right.service)
      || left.listen.localeCompare(right.listen)
    ));
    if (privateListeners.length > 0) normalized.privateListeners = privateListeners;
  }
  if (source.existingSites !== undefined) {
    if (!Array.isArray(source.existingSites) || source.existingSites.length > 32) {
      throw new SecurityError("spec.edge.existingSites must be an array");
    }
    const sites = source.existingSites.map((site, index) => {
      const label = `spec.edge.existingSites[${index}]`;
      const existing = object(site, label);
      keys(existing, ["host", "upstream", "tlsServerName"], label);
      const normalizedSite = {
        host: normalizeDomain(existing.host, `${label}.host`),
        upstream: normalizeExistingSiteUpstream(existing.upstream, `${label}.upstream`),
      };
      if (existing.tlsServerName !== undefined) {
        normalizedSite.tlsServerName = normalizeDomain(
          existing.tlsServerName,
          `${label}.tlsServerName`,
        );
      }
      return normalizedSite;
    });
    if (new Set(sites.map((site) => site.host)).size !== sites.length) {
      throw new SecurityError("spec.edge.existingSites contains duplicates", {
        code: "DUPLICATE_CLAIM",
      });
    }
    normalized.existingSites = sites.sort((left, right) => left.host.localeCompare(right.host));
  }
  return normalized;
}

function normalizeTransport(value) {
  const source = object(value, "spec.transport");
  keys(source, ["provider", "sshHost", "sshUser", "sshPort", "hostKeyAlias"], "spec.transport");
  if (source.provider !== "openssh-reverse") {
    throw new SecurityError("Only the openssh-reverse transport is supported", {
      code: "INVALID_MANIFEST",
    });
  }
  const normalized = { provider: "openssh-reverse" };
  const sshHost = normalizeSshHost(source.sshHost);
  if (sshHost === undefined) throw new SecurityError("spec.transport.sshHost is required");
  normalized.sshHost = sshHost;
  normalized.sshUser = requiredString(
    source.sshUser,
    "spec.transport.sshUser",
    /^[a-z_][a-z0-9_-]{0,30}$/u,
    31,
  );
  if (source.sshPort !== undefined) {
    normalized.sshPort = optionalPort(source.sshPort, "spec.transport.sshPort");
  }
  if (source.hostKeyAlias !== undefined) {
    normalized.hostKeyAlias = requiredString(
      source.hostKeyAlias,
      "spec.transport.hostKeyAlias",
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u,
      253,
    );
  }
  return normalized;
}

function listenerPort(value) {
  return Number(value.slice(value.lastIndexOf(":") + 1));
}

function urlPort(value) {
  return Number(new URL(value).port);
}

export function normalizeManifest(input) {
  const source = object(input, "manifest");
  keys(source, ["apiVersion", "kind", "metadata", "spec"], "manifest");
  if (source.apiVersion !== API_VERSION) {
    throw new SecurityError(`apiVersion must be ${API_VERSION}`, { code: "INVALID_MANIFEST" });
  }
  if (source.kind !== MANIFEST_KIND) {
    throw new SecurityError(`kind must be ${MANIFEST_KIND}`, { code: "INVALID_MANIFEST" });
  }

  const metadataSource = object(source.metadata, "metadata");
  keys(metadataSource, ["name"], "metadata");
  const metadata = {
    name: requiredString(
      metadataSource.name,
      "metadata.name",
      /^[a-z][a-z0-9-]{0,62}$/u,
      63,
    ),
  };

  const specSource = object(source.spec, "spec");
  keys(specSource, ["edge", "transport", "services"], "spec");
  if (
    !Array.isArray(specSource.services)
    || specSource.services.length === 0
    || specSource.services.length > 128
  ) {
    throw new SecurityError("spec.services must not be empty", { code: "INVALID_MANIFEST" });
  }
  const services = specSource.services.map(normalizeService);
  services.sort((left, right) => left.id.localeCompare(right.id));

  const serviceIds = new Set();
  const workerListeners = new Set();
  const edgeUpstreams = new Set();
  const publicClaims = new Set();
  for (const service of services) {
    if (serviceIds.has(service.id)) {
      throw new SecurityError(`Duplicate service id: ${service.id}`, {
        code: "DUPLICATE_CLAIM",
      });
    }
    serviceIds.add(service.id);
    if (workerListeners.has(service.worker.listen)) {
      throw new SecurityError(`Duplicate worker listener: ${service.worker.listen}`, {
        code: "DUPLICATE_CLAIM",
      });
    }
    workerListeners.add(service.worker.listen);
    if (edgeUpstreams.has(service.edge.upstream)) {
      throw new SecurityError(`Duplicate edge upstream: ${service.edge.upstream}`, {
        code: "DUPLICATE_CLAIM",
      });
    }
    edgeUpstreams.add(service.edge.upstream);
    for (const domain of service.domains) {
      for (const route of service.public.routes) {
        for (const method of route.methods) {
          const claim = `${domain}\u0000${method}\u0000${route.path}`;
          if (publicClaims.has(claim)) {
            throw new SecurityError("Duplicate public host/method/path claim", {
              code: "DUPLICATE_CLAIM",
            });
          }
          publicClaims.add(claim);
        }
      }
    }
  }

  const edge = normalizeEdge(specSource.edge);
  const transport = normalizeTransport(specSource.transport);
  if (edge.compatibilityService !== undefined && edge.compatibilityListen === undefined) {
    throw new SecurityError(
      "spec.edge.compatibilityService requires compatibilityListen",
      { code: "INVALID_MANIFEST" },
    );
  }
  if (edge.compatibilityListen !== undefined) {
    const selected = edge.compatibilityService
      ?? (services.length === 1 ? services[0].id : undefined);
    if (selected === undefined) {
      throw new SecurityError(
        "spec.edge.compatibilityService is required when more than one service exists",
        { code: "INVALID_MANIFEST" },
      );
    }
    if (!serviceIds.has(selected)) {
      throw new SecurityError("spec.edge.compatibilityService must name a configured service", {
        code: "INVALID_MANIFEST",
      });
    }
    if (services.find((service) => service.id === selected)?.exposure === "private") {
      throw new SecurityError("spec.edge.compatibilityService must name a public service", {
        code: "INVALID_MANIFEST",
      });
    }
    edge.compatibilityService = selected;
  }
  const privateListenerServices = new Set();
  for (const privateListener of edge.privateListeners ?? []) {
    const service = services.find((candidate) => candidate.id === privateListener.service);
    if (service === undefined) {
      throw new SecurityError(
        `Private listener names unknown service: ${privateListener.service}`,
        { code: "INVALID_MANIFEST" },
      );
    }
    if (service.exposure !== "private") {
      throw new SecurityError(
        `Private listener service ${privateListener.service} must use exposure private`,
        { code: "INVALID_MANIFEST" },
      );
    }
    privateListenerServices.add(privateListener.service);
  }
  for (const service of services) {
    if (service.exposure === "private" && !privateListenerServices.has(service.id)) {
      throw new SecurityError(
        `Private service ${service.id} requires one spec.edge.privateListeners entry`,
        { code: "INVALID_MANIFEST" },
      );
    }
  }
  const serviceDomains = new Set(services.flatMap((service) => service.domains));
  for (const site of edge.existingSites ?? []) {
    if (serviceDomains.has(site.host)) {
      throw new SecurityError("An existing site host conflicts with a LazyEdge service domain", {
        code: "DUPLICATE_CLAIM",
      });
    }
  }


  const edgeBinders = new Map();
  const claimEdgePort = (port, label) => {
    const previous = edgeBinders.get(port);
    if (previous !== undefined) {
      throw new SecurityError(`${label} conflicts with ${previous} on edge port ${port}`, {
        code: "DUPLICATE_CLAIM",
      });
    }
    edgeBinders.set(port, label);
  };
  claimEdgePort(listenerPort(edge.gatewayListen), "spec.edge.gatewayListen");
  if (edge.compatibilityListen !== undefined) {
    claimEdgePort(listenerPort(edge.compatibilityListen), "spec.edge.compatibilityListen");
  }
  for (const privateListener of edge.privateListeners ?? []) {
    claimEdgePort(
      listenerPort(privateListener.listen),
      `spec.edge.privateListeners[${privateListener.service}]`,
    );
  }
  claimEdgePort(edge.httpPort, "spec.edge.httpPort");
  claimEdgePort(edge.httpsPort, "spec.edge.httpsPort");
  claimEdgePort(transport.sshPort ?? 22, "spec.transport.sshPort");
  for (const service of services) {
    claimEdgePort(urlPort(service.edge.upstream), `${service.id}.edge.upstream`);
  }
  for (const site of edge.existingSites ?? []) {
    const port = urlPort(site.upstream);
    if (edgeBinders.has(port)) {
      throw new SecurityError(
        `${site.host} existing upstream conflicts with ${edgeBinders.get(port)} on edge port ${port}`,
        { code: "DUPLICATE_CLAIM" },
      );
    }
  }

  const workerBinders = new Map(services.map((service) => [
    listenerPort(service.worker.listen),
    `${service.id}.worker.listen`,
  ]));
  for (const service of services) {
    const port = urlPort(service.worker.target);
    if (workerBinders.has(port)) {
      throw new SecurityError(
        `${service.id}.worker.target conflicts with ${workerBinders.get(port)} on worker port ${port}`,
        { code: "DUPLICATE_CLAIM" },
      );
    }
  }

  return deepFreeze({
    apiVersion: API_VERSION,
    kind: MANIFEST_KIND,
    metadata,
    spec: {
      edge,
      transport,
      services,
    },
  });
}

export function validateManifest(input) {
  return normalizeManifest(input);
}

export function parseManifest(text, { source = "manifest" } = {}) {
  if (typeof text !== "string" || text.length === 0 || text.length > 1024 * 1024) {
    throw new SecurityError(`${source} is empty or too large`, { code: "INVALID_MANIFEST" });
  }
  const document = parseDocument(text, {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new SecurityError(`${source} is not valid YAML: ${document.errors[0].message}`, {
      code: "INVALID_MANIFEST",
    });
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new SecurityError(`${source} uses unsupported YAML aliases: ${error.message}`, {
      code: "INVALID_MANIFEST",
    });
  }
  return normalizeManifest(value);
}

export async function loadManifest(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("loadManifest requires a file path");
  }
  const text = await readFile(filePath, "utf8");
  return parseManifest(text, { source: filePath });
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestDigest(input) {
  return sha256(stableStringify(normalizeManifest(input)));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
