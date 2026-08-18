import { randomBytes } from "node:crypto";
import { lstat, mkdir, open as openFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest, manifestDigest } from "./config.js";
import { startCompatibilityServer, startEdgeServer } from "./edge-server.js";
import { loadBindings, readPrivateText } from "./runtime-config.js";
import { generateCapabilityToken } from "./security.js";
import { normalizeTokenScope, TokenStore } from "./token-store.js";
import { startWorkerServer } from "./worker-server.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(
  await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
).version;

const HELP = `LazyEdge ${VERSION}

Usage:
  lazyedge init [--output lazyedge.yaml]
  lazyedge validate [--config lazyedge.yaml] [--json]
  lazyedge plan [--config lazyedge.yaml] [--json]
  lazyedge render caddy [--config lazyedge.yaml] [--manual-certificates]
  lazyedge render openssh [--config lazyedge.yaml] [--identity-file FILE] [--known-hosts-file FILE]
  lazyedge render accounts [--config lazyedge.yaml] --public-key-file FILE
  lazyedge render systemd [--config lazyedge.yaml]
  lazyedge render systemd --config FILE --component edge|worker [--executable FILE] [--manifest-path FILE] [--bindings-path FILE] [--environment-file FILE] [--runtime-path PATH] [--after-unit UNIT]
  lazyedge render systemd --config FILE --component tunnel [--ssh-config-path FILE] [--ssh-alias NAME] [--worker-unit UNIT]
  lazyedge render redirect-helper [--config lazyedge.yaml]
  lazyedge render nat [--config lazyedge.yaml] --direction apply|rollback
  lazyedge token issue --store FILE --set NAME --out FILE [--service ID] [--days N]
                       [--hosts HOST,...] [--methods METHOD,...] [--paths PATH,...]
  lazyedge token list --store FILE [--set NAME] [--json]
  lazyedge token revoke --store FILE --id ID
  lazyedge secret generate --out FILE [--prefix NAME]
  lazyedge secret import-env --env-file FILE --name NAME --out FILE
  lazyedge secret sync-env --env-file FILE --name NAME --value-file FILE
  lazyedge chat hash-password --password-file FILE|- --out FILE
  lazyedge chat create-credentials --username NAME --credentials-out FILE --hash-out FILE
  lazyedge chat issue-client-token --config FILE --service ID --store FILE --out FILE [--days N]
  lazyedge serve edge --config FILE --bindings FILE [--service COMPATIBILITY_ID]
  lazyedge serve worker --config FILE --bindings FILE [--service ID]
  lazyedge serve chat --config FILE --service ID --password-hash-file FILE --client-token-file FILE
  lazyedge doctor [--config lazyedge.yaml] [--role edge|worker|all] [--json]
  lazyedge --version

Security:
  Secrets are read from owner-protected files. They are never accepted as CLI
  arguments. Public routes are exact and default deny.
`;

function parseOptions(argv) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    if (separator !== -1) {
      const key = value.slice(2, separator);
      const optionValue = value.slice(separator + 1);
      if (!key || !optionValue || options.has(key)) throw new Error(`Invalid option ${value}`);
      options.set(key, optionValue);
      continue;
    }
    const key = value.slice(2);
    if (!key || options.has(key)) throw new Error(`Invalid option ${value}`);
    if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      options.set(key, argv[index + 1]);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positionals, options };
}

function option(options, name, fallback) {
  return options.has(name) ? options.get(name) : fallback;
}

function flag(options, name) {
  const value = option(options, name, false);
  if (value !== true && value !== false) {
    throw new Error(`--${name} does not accept a value`);
  }
  return value;
}

function stringOption(options, name) {
  const value = option(options, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${name} requires a value`);
  return value;
}

function assertOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}`);
  }
}

function commaListOption(options, name) {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  const entries = value.split(",");
  if (
    entries.length < 1
    || entries.length > 256
    || entries.some((entry) => entry.length === 0 || entry !== entry.trim())
    || new Set(entries).size !== entries.length
  ) {
    throw new Error(`--${name} must be a comma-separated list without blanks or duplicates`);
  }
  return entries;
}

function output(stream, value, json = false) {
  stream.write(`${json ? JSON.stringify(value, null, 2) : value}\n`);
}

async function load(options) {
  const filePath = path.resolve(String(option(options, "config", "lazyedge.yaml")));
  return { filePath, manifest: await loadManifest(filePath) };
}

async function initCommand(options, stdout) {
  assertOptions(options, ["output"]);
  const target = path.resolve(String(option(options, "output", "lazyedge.yaml")));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const example = await readFile(path.join(PACKAGE_ROOT, "examples/local-llm/lazyedge.yaml"));
  await writeFile(target, example, { flag: "wx", mode: 0o644 });
  output(stdout, `Created ${target}`);
}

async function validateCommand(options, stdout) {
  assertOptions(options, ["config", "json"]);
  const { filePath, manifest } = await load(options);
  const result = {
    valid: true,
    file: filePath,
    project: manifest.metadata.name,
    services: manifest.spec.services.map((service) => service.id),
    digest: manifestDigest(manifest),
  };
  output(stdout, option(options, "json", false) ? result : `valid ${result.digest}`, Boolean(option(options, "json", false)));
}

function planFor(manifest) {
  return {
    project: manifest.metadata.name,
    digest: manifestDigest(manifest),
    edge: manifest.spec.edge,
    transport: {
      provider: manifest.spec.transport.provider,
      sshHost: manifest.spec.transport.sshHost,
      sshUser: manifest.spec.transport.sshUser,
      sshPort: manifest.spec.transport.sshPort ?? 22,
    },
    services: manifest.spec.services.map((service) => ({
      id: service.id,
      profile: service.profile ?? "generic-http",
      domains: service.domains,
      reverseListener: new URL(service.edge.upstream).host,
      workerListener: service.worker.listen,
      routes: service.public.routes,
    })),
  };
}

async function planCommand(options, stdout) {
  assertOptions(options, ["config", "json"]);
  const { manifest } = await load(options);
  const plan = planFor(manifest);
  if (option(options, "json", false)) output(stdout, plan, true);
  else {
    output(stdout, `Project: ${plan.project}`);
    output(stdout, `Digest: ${plan.digest}`);
    for (const service of plan.services) {
      output(stdout, `${service.id}: ${service.domains.join(", ")} -> ${service.reverseListener} -> ${service.workerListener}`);
      for (const route of service.routes) output(stdout, `  ${route.methods.join(",")} ${route.path}`);
    }
  }
}

async function renderCommand(kind, options, stdout) {
  const { manifest } = await load(options);
  if (kind === "caddy") {
    assertOptions(options, ["config", "manual-certificates", "acme-webroot"]);
    const { renderCaddy } = await import("./caddy.js");
    output(stdout, renderCaddy(manifest, {
      manualCertificates: flag(options, "manual-certificates"),
      acmeWebroot: String(option(options, "acme-webroot", "/var/www/letsencrypt")),
    }));
    return;
  }
  if (kind === "openssh") {
    assertOptions(options, ["config", "identity-file", "known-hosts-file", "alias"]);
    const { renderOpenSshConfig } = await import("./openssh.js");
    output(stdout, renderOpenSshConfig(manifest, {
      alias: String(option(options, "alias", "lazyedge-edge")),
      identityFile: String(option(
        options,
        "identity-file",
        "/home/lazyedge/.config/lazyedge/ssh/id_ed25519",
      )),
      knownHostsFile: String(option(
        options,
        "known-hosts-file",
        "/home/lazyedge/.config/lazyedge/ssh/known_hosts",
      )),
    }));
    return;
  }
  if (kind === "accounts") {
    assertOptions(options, ["config", "public-key-file"]);
    const publicKeyFile = option(options, "public-key-file");
    if (typeof publicKeyFile !== "string") {
      throw new Error("render accounts requires --public-key-file");
    }
    const publicKeyPath = path.resolve(publicKeyFile);
    const publicKeyInfo = await lstat(publicKeyPath);
    if (!publicKeyInfo.isFile() || publicKeyInfo.isSymbolicLink()) {
      throw new Error("OpenSSH public key path must be a regular non-symlink file");
    }
    if ((publicKeyInfo.mode & 0o022) !== 0) {
      throw new Error("OpenSSH public key file must not be group/world writable");
    }
    if (publicKeyInfo.size > 4096) throw new Error("OpenSSH public key file is too large");
    const publicKey = await readFile(publicKeyPath, "utf8");
    if (publicKey.length > 4096) throw new Error("OpenSSH public key file is too large");
    const { renderBootstrapScript } = await import("./accounts.js");
    output(stdout, renderBootstrapScript(manifest, { publicKey }));
    return;
  }
  if (kind === "systemd") {
    const pathOptions = [
      "executable",
      "manifest-path",
      "bindings-path",
      "environment-file",
      "runtime-path",
      "after-unit",
      "ssh-config-path",
      "ssh-alias",
      "worker-unit",
      "password-hash-file",
      "client-token-file",
    ];
    assertOptions(options, ["config", "component", ...pathOptions]);
    const module = await import("./systemd.js");
    const components = {
      edge: ["lazyedge-edge.service", module.renderEdgeSystemd],
      worker: ["lazyedge-worker.service", module.renderWorkerSystemd],
      tunnel: ["lazyedge-tunnel.service", module.renderTunnelSystemd],
      caddy: ["lazyedge-caddy.service", module.renderCaddySystemd],
      redirect: ["lazyedge-port-redirect.service", module.renderPortRedirectSystemd],
      certbot: ["lazyedge-certbot-deploy-hook", module.renderCertbotDeployHook],
      ...(manifest.spec.services.some((service) => service.chat !== undefined)
        ? { chat: ["lazyedge-chat.service", module.renderChatSystemd] }
        : {}),
    };
    const selected = option(options, "component");
    if (selected !== undefined && !Object.hasOwn(components, selected)) {
      throw new Error(
        "--component must be edge, worker, tunnel, caddy, redirect, certbot, or chat",
      );
    }
    if (selected === undefined && pathOptions.some((name) => options.has(name))) {
      throw new Error("systemd path options require one explicit --component");
    }
    const permittedOptions = {
      edge: new Set([
        "executable", "manifest-path", "bindings-path", "environment-file", "runtime-path",
      ]),
      worker: new Set([
        "executable", "manifest-path", "bindings-path", "environment-file", "runtime-path",
        "after-unit",
      ]),
      tunnel: new Set(["ssh-config-path", "ssh-alias", "worker-unit"]),
      caddy: new Set(),
      redirect: new Set(),
      certbot: new Set(),
      chat: new Set([
        "executable", "manifest-path", "runtime-path", "password-hash-file", "client-token-file",
      ]),
    };
    if (selected !== undefined) {
      const unsupported = pathOptions.find(
        (name) => options.has(name) && !permittedOptions[selected].has(name),
      );
      if (unsupported !== undefined) {
        throw new Error(`--${unsupported} is not valid for systemd component ${selected}`);
      }
    }
    const entries = selected === undefined
      ? Object.entries(components)
      : [[selected, components[selected]]];
    const rendererOptions = selected === "edge" || selected === "worker"
      ? {
          ...(stringOption(options, "executable") === undefined
            ? {} : { executable: stringOption(options, "executable") }),
          ...(stringOption(options, "manifest-path") === undefined
            ? {} : { manifestPath: stringOption(options, "manifest-path") }),
          ...(stringOption(options, "bindings-path") === undefined
            ? {} : { bindingsPath: stringOption(options, "bindings-path") }),
          ...(stringOption(options, "environment-file") === undefined
            ? {} : { environmentFile: stringOption(options, "environment-file") }),
          ...(stringOption(options, "runtime-path") === undefined
            ? {} : { pathEnvironment: stringOption(options, "runtime-path") }),
          ...(selected !== "worker" || stringOption(options, "after-unit") === undefined
            ? {} : { afterUnits: [stringOption(options, "after-unit")] }),
        }
      : selected === "tunnel"
        ? {
            ...(stringOption(options, "ssh-config-path") === undefined
              ? {} : { sshConfigPath: stringOption(options, "ssh-config-path") }),
            ...(stringOption(options, "ssh-alias") === undefined
              ? {} : { sshAlias: stringOption(options, "ssh-alias") }),
            ...(stringOption(options, "worker-unit") === undefined
              ? {} : { workerUnit: stringOption(options, "worker-unit") }),
          }
        : selected === "chat"
          ? {
              ...(stringOption(options, "executable") === undefined
                ? {} : { executable: stringOption(options, "executable") }),
              ...(stringOption(options, "manifest-path") === undefined
                ? {} : { manifestPath: stringOption(options, "manifest-path") }),
              ...(stringOption(options, "runtime-path") === undefined
                ? {} : { pathEnvironment: stringOption(options, "runtime-path") }),
              ...(stringOption(options, "password-hash-file") === undefined
                ? {} : { passwordHashPath: stringOption(options, "password-hash-file") }),
              ...(stringOption(options, "client-token-file") === undefined
                ? {} : { clientTokenPath: stringOption(options, "client-token-file") }),
            }
        : {};
    // An executable Certbot hook must begin with its shebang. The labeled
    // wrapper is useful for systemd review bundles, but would make a directly
    // installed hook fail with ENOEXEC.
    const rendered = selected === "certbot"
      ? entries[0][1][1](manifest, rendererOptions).trimEnd()
      : entries.map(([, [fileName, renderer]]) => (
          `# --- ${fileName} ---\n${renderer(manifest, rendererOptions).trimEnd()}\n`
        )).join("\n");
    output(stdout, rendered.trimEnd());
    return;
  }
  if (kind === "redirect-helper") {
    assertOptions(options, ["config"]);
    const { renderPortRedirectHelper } = await import("./systemd.js");
    output(stdout, renderPortRedirectHelper(manifest));
    return;
  }
  if (kind === "nat") {
    assertOptions(options, [
      "config",
      "direction",
      "previous-http-port",
      "previous-https-port",
    ]);
    const direction = option(options, "direction");
    if (!new Set(["apply", "rollback"]).has(direction)) {
      throw new Error("render nat requires --direction apply or rollback");
    }
    const previousHttpPort = Number(option(options, "previous-http-port", "8080"));
    const previousHttpsPort = Number(option(options, "previous-https-port", "8443"));
    const { renderNftRedirectTransaction } = await import("./caddy.js");
    const transaction = renderNftRedirectTransaction(manifest, {
      previousHttpPort,
      previousHttpsPort,
    });
    output(stdout, transaction[direction]);
    return;
  }
  throw new Error(
    "render requires caddy, openssh, accounts, systemd, redirect-helper, or nat",
  );
}

async function tokenCommand(action, options, stdout) {
  if (!action) throw new Error("token requires issue, list, or revoke");
  const storePath = option(options, "store");
  if (typeof storePath !== "string") throw new Error("--store is required");
  const store = await TokenStore.open({ filePath: path.resolve(storePath) });
  if (action === "issue") {
    assertOptions(options, [
      "store", "set", "out", "service", "days", "hosts", "methods", "paths",
    ]);
    const tokenSet = option(options, "set");
    const destination = option(options, "out");
    if (typeof tokenSet !== "string" || typeof destination !== "string") {
      throw new Error("token issue requires --set and --out");
    }
    const days = Number(option(options, "days", "30"));
    if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
      throw new Error("--days must be an integer from 1 to 366");
    }
    const serviceId = option(options, "service");
    if (serviceId !== undefined && typeof serviceId !== "string") {
      throw new Error("--service requires a value");
    }
    const hosts = commaListOption(options, "hosts");
    const methods = commaListOption(options, "methods");
    const paths = commaListOption(options, "paths");
    const scope = {
      ...(serviceId ? { serviceIds: [serviceId] } : {}),
      ...(hosts ? { hosts } : {}),
      ...(methods ? { methods } : {}),
      ...(paths ? { paths } : {}),
    };
    const { issued, tokenFile } = await issueTokenToFile(store, {
      tokenSet,
      expiresInSeconds: days * 86400,
      scope: Object.keys(scope).length > 0 ? scope : undefined,
    }, destination);
    output(stdout, JSON.stringify({
      id: issued.id,
      tokenSet,
      tokenFile,
      expiresAt: issued.expiresAt,
      scope: issued.scope,
    }));
    return;
  }
  if (action === "list") {
    assertOptions(options, ["store", "set", "json"]);
    const records = store.list({ tokenSet: option(options, "set") });
    if (option(options, "json", false)) output(stdout, records, true);
    else for (const record of records) {
      output(
        stdout,
        `${record.id} ${record.tokenSet} ${record.expiresAt} ${record.revokedAt ? "revoked" : "active"} scope=${JSON.stringify(record.scope)}`,
      );
    }
    return;
  }
  if (action === "revoke") {
    assertOptions(options, ["store", "id"]);
    const id = option(options, "id");
    if (typeof id !== "string") throw new Error("token revoke requires --id");
    const changed = await store.revoke(id);
    if (!changed) throw new Error("No active token matched that id");
    output(stdout, `Revoked ${id}`);
    return;
  }
  throw new Error("token requires issue, list, or revoke");
}

async function issueTokenToFile(store, issueOptions, destination, validate = () => {}) {
  const tokenFile = path.resolve(destination);
  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  let handle = await openFile(tokenFile, "wx", 0o600);
  let issued;
  let complete = false;
  try {
    issued = await store.issue(issueOptions);
    validate(issued);
    await handle.writeFile(`${issued.token}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    complete = true;
    return { issued, tokenFile };
  } catch (error) {
    if (issued !== undefined) {
      try {
        await store.revoke(issued.id);
      } catch (revokeError) {
        throw new AggregateError(
          [error, revokeError],
          "Token output failed and the issued record could not be revoked",
        );
      }
    }
    throw error;
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    if (!complete) await unlink(tokenFile).catch(() => {});
  }
}

async function chatCommand(action, options, stdout) {
  if (!new Set(["hash-password", "create-credentials", "issue-client-token"]).has(action)) {
    throw new Error("chat requires hash-password, create-credentials, or issue-client-token");
  }
  if (action === "issue-client-token") {
    assertOptions(options, ["config", "service", "store", "out", "days"]);
    const serviceId = option(options, "service");
    const storePath = option(options, "store");
    const destination = option(options, "out");
    const days = Number(option(options, "days", "30"));
    if (
      typeof serviceId !== "string"
      || typeof storePath !== "string"
      || typeof destination !== "string"
      || !Number.isSafeInteger(days)
      || days < 1
      || days > 366
    ) {
      throw new Error(
        "chat issue-client-token requires --config, --service, --store, --out, and optional --days 1–366",
      );
    }
    const { manifest } = await load(options);
    const service = manifest.spec.services.find((candidate) => candidate.id === serviceId);
    if (!service?.chat) throw new Error("--service must name the configured private chat service");
    const scope = normalizeTokenScope({
      serviceIds: [service.id],
      hosts: service.domains,
      methods: ["GET", "POST"],
      paths: ["/v1/models", "/v1/chat/completions"],
    });
    const store = await TokenStore.open({ filePath: path.resolve(storePath) });
    const { issued, tokenFile } = await issueTokenToFile(store, {
      tokenSet: service.public.tokenSet,
      expiresInSeconds: days * 86400,
      scope,
    }, destination, (candidate) => {
      if (
        candidate.tokenSet !== service.public.tokenSet
        || JSON.stringify(candidate.scope) !== JSON.stringify(scope)
      ) throw new Error("Issued chat token scope did not match the manifest-derived contract");
    });
    output(stdout, JSON.stringify({
      id: issued.id,
      tokenSet: issued.tokenSet,
      serviceId: service.id,
      tokenFile,
      expiresAt: issued.expiresAt,
      scope: issued.scope,
    }));
    return;
  }
  if (action === "create-credentials") {
    assertOptions(options, ["username", "credentials-out", "hash-out"]);
    const username = option(options, "username");
    const credentialsDestination = option(options, "credentials-out");
    const hashDestination = option(options, "hash-out");
    if (
      typeof username !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/u.test(username)
      || typeof credentialsDestination !== "string"
      || typeof hashDestination !== "string"
    ) {
      throw new Error(
        "chat create-credentials requires a safe --username, --credentials-out, and --hash-out",
      );
    }
    const credentialsPath = path.resolve(credentialsDestination);
    const passwordHashPath = path.resolve(hashDestination);
    if (credentialsPath === passwordHashPath) {
      throw new Error("Credential and password-hash outputs must differ");
    }
    const { hashChatPassword } = await import("./chat-server.js");
    const password = randomBytes(32).toString("base64url");
    const record = await hashChatPassword(password);
    await mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(passwordHashPath), { recursive: true, mode: 0o700 });
    let credentialsWritten = false;
    try {
      await writeFile(
        credentialsPath,
        `${JSON.stringify({ version: 1, username, password }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      credentialsWritten = true;
      await writeFile(passwordHashPath, `${record}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (credentialsWritten) await unlink(credentialsPath).catch(() => {});
      throw error;
    }
    output(stdout, JSON.stringify({
      credentialsFile: credentialsPath,
      passwordHashFile: passwordHashPath,
      algorithm: "scrypt-v1",
    }));
    return;
  }
  assertOptions(options, ["password-file", "out"]);
  const passwordFile = option(options, "password-file");
  const destination = option(options, "out");
  if (typeof passwordFile !== "string" || typeof destination !== "string") {
    throw new Error("chat hash-password requires --password-file and --out");
  }
  const { hashChatPassword, readChatPasswordFile } = await import("./chat-server.js");
  const password = await readChatPasswordFile(
    passwordFile === "-" ? "-" : path.resolve(passwordFile),
  );
  const record = await hashChatPassword(password);
  const outputPath = path.resolve(destination);
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${record}\n`, { flag: "wx", mode: 0o600 });
  output(stdout, JSON.stringify({ passwordHashFile: outputPath, algorithm: "scrypt-v1" }));
}

async function secretCommand(action, options, stdout) {
  if (!action || !["generate", "import-env", "sync-env"].includes(action)) {
    throw new Error("secret requires generate, import-env, or sync-env");
  }
  if (action === "sync-env") {
    assertOptions(options, ["env-file", "name", "value-file"]);
    const envFile = option(options, "env-file");
    const name = option(options, "name");
    const valueFile = option(options, "value-file");
    if (
      typeof envFile !== "string"
      || typeof name !== "string"
      || typeof valueFile !== "string"
    ) {
      throw new Error("secret sync-env requires --env-file, --name, and --value-file");
    }
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) throw new Error("--name is invalid");
    const envPath = path.resolve(envFile);
    const envInfo = await lstat(envPath);
    if (!envInfo.isFile() || envInfo.isSymbolicLink()) {
      throw new Error("environment file must be a regular non-symlink file");
    }
    if ((envInfo.mode & 0o007) !== 0 || envInfo.size < 1 || envInfo.size > 64 * 1024) {
      throw new Error("environment file must be private and no larger than 64 KiB");
    }
    const value = await readPrivateText(path.resolve(valueFile), "secret value file");
    if (!/^[A-Za-z0-9._~-]{32,4096}$/u.test(value)) {
      throw new Error("secret value is not safe for an unquoted environment assignment");
    }
    const source = await readFile(envPath, "utf8");
    const matcher = new RegExp(
      `^(?:[ \\t]*export[ \\t]+)?${name}[ \\t]*=.*$`,
      "gmu",
    );
    const definitions = source.match(matcher) ?? [];
    if (definitions.length > 1) throw new Error(`environment file defines ${name} more than once`);
    const assignment = `${name}=${value}`;
    const next = definitions.length === 1
      ? source.replace(matcher, assignment)
      : `${source.replace(/[\r\n]*$/u, "")}\n${assignment}\n`;
    const { atomicWriteFile } = await import("./state.js");
    await atomicWriteFile(envPath, next, { mode: envInfo.mode & 0o777 });
    output(stdout, JSON.stringify({ envFile: envPath, name }));
    return;
  }
  assertOptions(
    options,
    action === "generate" ? ["out", "prefix"] : ["env-file", "name", "out"],
  );
  const destination = option(options, "out");
  if (typeof destination !== "string") throw new Error(`secret ${action} requires --out`);
  const secretFile = path.resolve(destination);
  await mkdir(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  let secret;
  if (action === "generate") {
    const prefix = String(option(options, "prefix", "le"));
    if (!/^[a-z][a-z0-9-]{0,15}$/u.test(prefix)) throw new Error("--prefix is invalid");
    secret = generateCapabilityToken(prefix);
  } else {
    const envFile = option(options, "env-file");
    const name = option(options, "name");
    if (typeof envFile !== "string" || typeof name !== "string") {
      throw new Error("secret import-env requires --env-file and --name");
    }
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) throw new Error("--name is invalid");
    const envPath = path.resolve(envFile);
    const envInfo = await lstat(envPath);
    if (!envInfo.isFile() || envInfo.isSymbolicLink()) {
      throw new Error("environment file must be a regular non-symlink file");
    }
    if ((envInfo.mode & 0o007) !== 0) {
      throw new Error("environment file must not be accessible to other users");
    }
    if (envInfo.size < 1 || envInfo.size > 64 * 1024) {
      throw new Error("environment file has an unsafe size");
    }
    const source = await readFile(envPath, "utf8");
    const matches = [];
    for (const line of source.split(/\r?\n/u)) {
      const parsed = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
      if (parsed?.[1] !== name) continue;
      let value = parsed[2].trim();
      if (
        value.length >= 2
        && ((value.startsWith("\"") && value.endsWith("\""))
          || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      matches.push(value);
    }
    if (
      matches.length !== 1
      || matches[0].length < 32
      || matches[0].length > 4096
      || /[\s\u0000-\u001f\u007f]/u.test(matches[0])
    ) {
      throw new Error(`environment file must define one valid 32–4096 character ${name}`);
    }
    secret = matches[0];
  }
  await writeFile(secretFile, `${secret}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  output(stdout, JSON.stringify({ secretFile, source: action }));
}

async function runtimeMaps(manifest, bindingsPath, role, selectedServiceId) {
  const bindings = await loadBindings(bindingsPath);
  const relayTokens = new Map();
  const upstreamTokens = new Map();
  const tokenStores = new Map();
  for (const service of manifest.spec.services) {
    if (selectedServiceId !== undefined && service.id !== selectedServiceId) continue;
    const binding = bindings.get(service.id);
    if (!binding) throw new Error(`Missing binding for ${service.id}`);
    if (!binding.relaySecretFile) throw new Error(`Missing relaySecretFile for ${service.id}`);
    relayTokens.set(service.id, await readPrivateText(binding.relaySecretFile, `${service.id} relay secret`));
    if (role === "worker" && binding.upstreamAuthorizationFile) {
      upstreamTokens.set(
        service.id,
        await readPrivateText(binding.upstreamAuthorizationFile, `${service.id} upstream key`),
      );
    }
    if (role === "edge" && binding.clientTokenStore) {
      const existing = tokenStores.get(service.public.tokenSet);
      if (existing && existing.filePath !== binding.clientTokenStore) {
        throw new Error(`Token set ${service.public.tokenSet} maps to multiple stores`);
      }
      tokenStores.set(
        service.public.tokenSet,
        existing ?? await TokenStore.open({ filePath: binding.clientTokenStore }),
      );
    }
  }
  return { relayTokens, upstreamTokens, tokenStores };
}

async function waitForShutdown(handles, stdout) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  await Promise.all(handles.map((handle) => handle.close()));
  output(stdout, "LazyEdge stopped.");
}

async function serveCommand(role, options, stdout) {
  if (role === "chat") {
    assertOptions(options, [
      "config", "service", "password-hash-file", "client-token-file",
    ]);
    const { manifest } = await load(options);
    const serviceId = option(options, "service");
    const passwordHashFile = option(options, "password-hash-file");
    const clientTokenFile = option(options, "client-token-file");
    if (
      typeof serviceId !== "string"
      || typeof passwordHashFile !== "string"
      || typeof clientTokenFile !== "string"
    ) {
      throw new Error(
        "serve chat requires --service, --password-hash-file, and --client-token-file",
      );
    }
    const { startChatServer } = await import("./chat-server.js");
    const handle = await startChatServer({
      manifest,
      serviceId,
      passwordHash: await readPrivateText(
        path.resolve(passwordHashFile),
        `${serviceId} chat password hash`,
      ),
      clientToken: await readPrivateText(
        path.resolve(clientTokenFile),
        `${serviceId} chat client token`,
      ),
    });
    try {
      output(stdout, `LazyEdge private chat ${serviceId} listening on ${handle.url}`);
      await waitForShutdown([handle], stdout);
    } catch (error) {
      await handle.close();
      throw error;
    }
    return;
  }
  assertOptions(options, ["config", "bindings", "service"]);
  if (!new Set(["edge", "worker"]).has(role)) {
    throw new Error("serve requires edge, worker, or chat");
  }
  const bindingsPath = option(options, "bindings");
  if (typeof bindingsPath !== "string") throw new Error("serve requires --bindings");
  const { manifest } = await load(options);
  const requestedService = option(options, "service");
  if (
    requestedService !== undefined
    && !manifest.spec.services.some((service) => service.id === requestedService)
  ) {
    throw new Error("Unknown --service");
  }
  if (role === "edge" && requestedService !== undefined) {
    if (manifest.spec.edge.compatibilityListen === undefined) {
      throw new Error("edge --service is valid only with spec.edge.compatibilityListen");
    }
    if (requestedService !== manifest.spec.edge.compatibilityService) {
      throw new Error("--service cannot override spec.edge.compatibilityService");
    }
  }
  const runtime = await runtimeMaps(
    manifest,
    bindingsPath,
    role,
    role === "worker" ? requestedService : undefined,
  );
  if (role === "edge") {
    if (runtime.tokenStores.size === 0) throw new Error("Edge bindings require clientTokenStore");
    const handles = [await startEdgeServer({
      manifest,
      tokenStores: runtime.tokenStores,
      relayTokens: runtime.relayTokens,
    })];
    try {
      output(stdout, `LazyEdge edge listening on ${handles[0].url}`);
      if (manifest.spec.edge.compatibilityListen) {
        const selected = manifest.spec.edge.compatibilityService;
        if (!selected) throw new Error("Edge compatibility listener requires a selected service");
        const compatibility = await startCompatibilityServer({
          manifest,
          serviceId: selected,
          tokenStores: runtime.tokenStores,
          relayTokens: runtime.relayTokens,
        });
        handles.push(compatibility);
        output(stdout, `LazyEdge compatibility listener on ${compatibility.url}`);
      }
      await waitForShutdown(handles, stdout);
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close()));
      throw error;
    }
    return;
  }
  if (role === "worker") {
    const selected = requestedService;
    const services = selected
      ? manifest.spec.services.filter((service) => service.id === selected)
      : manifest.spec.services;
    const handles = [];
    try {
      for (const service of services) {
        if (!runtime.upstreamTokens.has(service.id)) {
          throw new Error(`Worker binding lacks upstreamAuthorizationFile for ${service.id}`);
        }
        handles.push(await startWorkerServer({
          manifest,
          serviceId: service.id,
          relayTokens: runtime.relayTokens,
          upstreamTokens: runtime.upstreamTokens,
        }));
      }
      for (const handle of handles) output(stdout, `LazyEdge worker ${handle.service.id} listening on ${handle.url}`);
      await waitForShutdown(handles, stdout);
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close()));
      throw error;
    }
    return;
  }
}

async function doctorCommand(options, stdout) {
  assertOptions(options, ["config", "json", "role"]);
  const { manifest } = await load(options);
  const module = await import("./doctor.js");
  const doctor = module.runDoctor ?? module.doctor;
  if (typeof doctor !== "function") throw new Error("doctor implementation is unavailable");
  const role = String(option(options, "role", "all"));
  if (!new Set(["edge", "worker", "all"]).has(role)) {
    throw new Error("--role must be edge, worker, or all");
  }
  const result = await doctor(manifest, { role });
  output(stdout, option(options, "json", false) ? result : JSON.stringify(result, null, 2), Boolean(option(options, "json", false)));
  if (result.ok === false) return 1;
  return 0;
}

export async function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  try {
    if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
      out.write(HELP);
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "version") {
      output(out, VERSION);
      return 0;
    }
    const command = argv[0];
    if (
      command === "render"
      || command === "token"
      || command === "secret"
      || command === "chat"
      || command === "serve"
    ) {
      const action = argv[1];
      const { options, positionals } = parseOptions(argv.slice(2));
      if (positionals.length > 0) throw new Error(`Unexpected argument ${positionals[0]}`);
      if (command === "render") await renderCommand(action, options, out);
      if (command === "token") await tokenCommand(action, options, out);
      if (command === "secret") await secretCommand(action, options, out);
      if (command === "chat") await chatCommand(action, options, out);
      if (command === "serve") await serveCommand(action, options, out);
      return 0;
    }
    const { options, positionals } = parseOptions(argv.slice(1));
    if (positionals.length > 0) throw new Error(`Unexpected argument ${positionals[0]}`);
    if (command === "init") await initCommand(options, out);
    else if (command === "validate") await validateCommand(options, out);
    else if (command === "plan") await planCommand(options, out);
    else if (command === "doctor") return await doctorCommand(options, out);
    else throw new Error(`Unknown command ${command}`);
    return 0;
  } catch (error) {
    err.write(`lazyedge: ${error.message}\n`);
    return 1;
  }
}
