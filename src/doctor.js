import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";

import {
  LOCALLLM_NODE_ADMISSION_PROFILE,
  normalizeManifest,
} from "./config.js";
import { probeLocalLlmAdmission } from "./node-admission.js";
import { openSshForwards } from "./openssh.js";
import { normalizeLoopbackListener, SecurityError } from "./security.js";

const ROLES = new Set(["edge", "worker", "all"]);

function check(id, kind, details) {
  return Object.freeze({ id, kind, ...details });
}

function boundarySummary(results, boundary) {
  const selected = results.filter((result) => result.boundary === boundary);
  return Object.freeze({
    checked: selected.length,
    ok: selected.length === 0 ? null : selected.every((result) => result.status === "pass"),
  });
}

function listenerFromUrl(value) {
  const parsed = new URL(value);
  return `${parsed.hostname}:${parsed.port}`;
}

export function planDoctorChecks(input, {
  role = "all",
  paths = {},
} = {}) {
  const manifest = normalizeManifest(input);
  if (!ROLES.has(role)) throw new SecurityError("Doctor role must be edge, worker, or all");
  const checks = [];
  checks.push(check("manifest-policy", "policy", {
    boundary: "policy",
    description: "Manifest passed default-deny validation",
  }));

  if (role === "edge" || role === "all") {
    checks.push(check("edge-gateway-listener", "tcp", {
      boundary: "transport",
      listener: manifest.spec.edge.gatewayListen,
      description: "Authenticated edge gateway accepts loopback traffic",
    }));
    for (const service of manifest.spec.services) {
      checks.push(check(`edge-tunnel-${service.id}`, "tcp", {
        boundary: "transport",
        listener: listenerFromUrl(service.edge.upstream),
        description: `Reverse tunnel listener for ${service.id} is connected`,
      }));
    }
    for (const privateListener of manifest.spec.edge.privateListeners ?? []) {
      checks.push(check(`edge-private-listener-${privateListener.service}`, "tcp", {
        boundary: "transport",
        listener: privateListener.listen,
        description: `Authenticated private listener for ${privateListener.service} is accepting loopback traffic`,
      }));
    }
    if (paths.edgeManifest) checks.push(check("edge-manifest-mode", "file-mode", {
      boundary: "operations",
      path: paths.edgeManifest,
      allowedModes: [0o600, 0o640],
    }));
    if (paths.edgeBindings) checks.push(check("edge-bindings-mode", "file-mode", {
      boundary: "operations",
      path: paths.edgeBindings,
      allowedModes: [0o600, 0o640],
    }));
    if (paths.caddyConfig) {
      checks.push(check("caddy-config-mode", "file-mode", {
        boundary: "operations",
        path: paths.caddyConfig,
        allowedModes: [0o600, 0o640, 0o644],
      }));
      checks.push(check("caddy-config-policy", "caddy-policy", {
        boundary: "operations",
        path: paths.caddyConfig,
        httpPort: manifest.spec.edge.httpPort,
        httpsPort: manifest.spec.edge.httpsPort,
        gatewayListen: manifest.spec.edge.gatewayListen,
      }));
      checks.push(check("caddy-validate", "command", {
        boundary: "operations",
        file: paths.caddyExecutable ?? "/usr/bin/caddy",
        args: ["validate", "--config", paths.caddyConfig, "--adapter", "caddyfile"],
      }));
    }
  }

  if (role === "worker" || role === "all") {
    for (const service of manifest.spec.services) {
      checks.push(check(`worker-guard-${service.id}`, "tcp", {
        boundary: "transport",
        listener: service.worker.listen,
        description: `Default-deny worker guard for ${service.id} is listening`,
      }));
      if (service.worker.healthPath !== undefined) {
        checks.push(check(`worker-target-${service.id}`, "http", {
          boundary: "transport",
          url: new URL(service.worker.healthPath, service.worker.target).href,
          description: `Private upstream transport health for ${service.id} succeeds`,
        }));
      }
      if (service.profile === LOCALLLM_NODE_ADMISSION_PROFILE) {
        checks.push(check(`worker-application-admission-${service.id}`, "localllm-admission", {
          boundary: "application-admission",
          readyUrl: new URL("/readyz", service.worker.target).href,
          capabilitiesUrl: new URL("/api/node/capabilities", service.worker.target).href,
          description: `Release-bound LocalLLM application admission for ${service.id} passes`,
        }));
      }
    }
    if (paths.workerManifest) checks.push(check("worker-manifest-mode", "file-mode", {
      boundary: "operations",
      path: paths.workerManifest,
      allowedModes: [0o600],
    }));
    if (paths.workerBindings) checks.push(check("worker-bindings-mode", "file-mode", {
      boundary: "operations",
      path: paths.workerBindings,
      allowedModes: [0o600],
    }));
    if (paths.sshConfig) {
      checks.push(check("ssh-config-mode", "file-mode", {
        boundary: "operations",
        path: paths.sshConfig,
        allowedModes: [0o600],
      }));
      checks.push(check("ssh-config-policy", "ssh-policy", {
        boundary: "operations",
        path: paths.sshConfig,
        forwards: openSshForwards(manifest),
      }));
      checks.push(check("ssh-config-parse", "command", {
        boundary: "operations",
        file: paths.sshExecutable ?? "/usr/bin/ssh",
        args: ["-G", "-F", paths.sshConfig, paths.sshAlias ?? "lazyedge-edge"],
      }));
    }
    if (paths.sshPrivateKey) checks.push(check("ssh-private-key-mode", "file-mode", {
      boundary: "operations",
      path: paths.sshPrivateKey,
      allowedModes: [0o600],
    }));
    if (paths.knownHosts) {
      checks.push(check("known-hosts-mode", "file-mode", {
        boundary: "operations",
        path: paths.knownHosts,
        allowedModes: [0o600, 0o644],
      }));
      checks.push(check("known-hosts-pin", "known-hosts", {
        boundary: "operations",
        path: paths.knownHosts,
        host: manifest.spec.transport.sshHost,
        hostKeyAlias: manifest.spec.transport.hostKeyAlias,
        port: manifest.spec.transport.sshPort ?? 22,
      }));
    }
  }
  return Object.freeze(checks);
}

function tcpProbe(listener, timeoutMs) {
  const normalized = normalizeLoopbackListener(listener, "doctor TCP listener");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: normalized.host, port: normalized.port });
    const timer = setTimeout(() => socket.destroy(new Error("connection timed out")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function commandProbe(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
    });
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (diagnostic.length < 512) diagnostic += chunk.slice(0, 512 - diagnostic.length);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(
        signal === null
          ? `command exited ${code}: ${diagnostic.trim()}`
          : `command ended by ${signal}`,
      ));
    });
  });
}

async function fileModeProbe(item, statImpl) {
  const info = await statImpl(item.path);
  if (!info.isFile()) throw new Error("not a regular file");
  const actual = info.mode & 0o777;
  if (!item.allowedModes.includes(actual)) {
    throw new Error(`mode ${actual.toString(8).padStart(4, "0")} is not permitted`);
  }
}

async function sshPolicyProbe(item, readFileImpl) {
  const text = await readFileImpl(item.path, "utf8");
  const required = [
    "StrictHostKeyChecking yes",
    "BatchMode yes",
    "ExitOnForwardFailure yes",
    "ServerAliveInterval ",
    "ServerAliveCountMax ",
    "SessionType none",
    "ForwardAgent no",
    "ForwardX11 no",
  ];
  for (const directive of required) {
    if (!text.includes(directive)) throw new Error(`missing ${directive.trim()}`);
  }
  if (/0\.0\.0\.0|\[::\]|RemoteForward\s+[^\n]*\*:/u.test(text)) {
    throw new Error("wildcard forwarding is forbidden");
  }
  const remoteLines = text.match(/^\s*RemoteForward\s+.+$/gmu) ?? [];
  if (remoteLines.length !== item.forwards.length) {
    throw new Error("RemoteForward count does not match the manifest");
  }
  for (const forward of item.forwards) {
    if (!remoteLines.some((line) => line.trim() === `RemoteForward ${forward.remote} ${forward.local}`)) {
      throw new Error(`missing exact RemoteForward for ${forward.service}`);
    }
  }
}

async function caddyPolicyProbe(item, readFileImpl) {
  const text = await readFileImpl(item.path, "utf8");
  if (/0\.0\.0\.0|\*\.|:\*|\[::\](?=:)/u.test(text)) {
    throw new Error("wildcard target found in Caddy config");
  }
  for (const expected of [
    `http_port ${item.httpPort}`,
    `https_port ${item.httpsPort}`,
    `reverse_proxy http://${item.gatewayListen}`,
  ]) {
    if (!text.includes(expected)) throw new Error(`missing ${expected}`);
  }
}

async function knownHostsProbe(item, readFileImpl) {
  if (typeof item.host !== "string") throw new Error("SSH host is not configured");
  const text = await readFileImpl(item.path, "utf8");
  const lines = text.split("\n").map((line) => line.trim()).filter(
    (line) => line.length > 0 && !line.startsWith("#"),
  );
  const marker = item.hostKeyAlias
    ?? (item.port === 22 ? item.host : `[${item.host}]:${item.port}`);
  const matches = lines.filter((line) => line.split(/[ \t]/u)[0] === marker);
  if (matches.length !== 1 || !/(?:^| )ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: |$)/u.test(matches[0])) {
    throw new Error("expected one exact pinned Ed25519 host key");
  }
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").slice(0, 300);
}

export async function runDoctor(input, {
  role = "all",
  paths = {},
  timeoutMs = 3000,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  statImpl = stat,
  tcpProbeImpl = tcpProbe,
  commandProbeImpl = commandProbe,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new SecurityError("Doctor timeout must be between 100 and 30000 ms");
  }
  const planned = planDoctorChecks(input, { role, paths });
  const results = [];
  for (const item of planned) {
    try {
      if (item.kind === "tcp") await tcpProbeImpl(item.listener, timeoutMs);
      if (item.kind === "http") {
        if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");
        const response = await fetchImpl(item.url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          throw new Error(`health endpoint returned HTTP ${response.status}`);
        }
        await response.body?.cancel();
      }
      if (item.kind === "localllm-admission") {
        await probeLocalLlmAdmission({
          readyUrl: item.readyUrl,
          capabilitiesUrl: item.capabilitiesUrl,
          fetchImpl,
          timeoutMs,
        });
      }
      if (item.kind === "file-mode") await fileModeProbe(item, statImpl);
      if (item.kind === "ssh-policy") await sshPolicyProbe(item, readFileImpl);
      if (item.kind === "caddy-policy") await caddyPolicyProbe(item, readFileImpl);
      if (item.kind === "known-hosts") await knownHostsProbe(item, readFileImpl);
      if (item.kind === "command") {
        await commandProbeImpl(item.file, [...item.args], timeoutMs);
      }
      results.push(Object.freeze({
        id: item.id,
        boundary: item.boundary,
        status: "pass",
        description: item.description,
      }));
    } catch (error) {
      results.push(Object.freeze({
        id: item.id,
        boundary: item.boundary,
        status: "fail",
        description: item.description,
        message: safeMessage(error),
      }));
    }
  }
  const frozenResults = Object.freeze(results);
  return Object.freeze({
    ok: results.every((result) => result.status === "pass"),
    role,
    boundaries: Object.freeze({
      transport: boundarySummary(results, "transport"),
      applicationAdmission: boundarySummary(results, "application-admission"),
      operations: boundarySummary(results, "operations"),
    }),
    checks: frozenResults,
  });
}
