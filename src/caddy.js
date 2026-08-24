import {
  LOCALLLM_NODE_ADMISSION_PROFILE,
  LOCALLLM_OPENAI_PROFILE,
  manifestDigest,
  normalizeManifest,
} from "./config.js";
import {
  normalizeDomain,
  normalizeLoopbackListener,
  SecurityError,
} from "./security.js";

function assertHighPort(value, label) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new SecurityError(`${label} must be an unprivileged high port (1024-65535)`);
  }
  return value;
}

function assertPublicIngress(manifest, label) {
  const hasPublicIngress = (manifest.spec.edge.existingSites?.length ?? 0) > 0
    || manifest.spec.services.some((service) => (service.exposure ?? "public") === "public");
  if (!hasPublicIngress) {
    throw new SecurityError(`${label} requires at least one configured public site`);
  }
}

function exactLoopback(value, label) {
  const listener = normalizeLoopbackListener(value, label);
  if (listener.host !== "127.0.0.1") {
    throw new SecurityError(`${label} must use exact loopback 127.0.0.1`);
  }
  return listener.value;
}

function existingUpstream(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecurityError(`${label} must be an absolute loopback URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new SecurityError(`${label} must be http(s)://127.0.0.1:<port>`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SecurityError(`${label} has an invalid port`);
  }
  return { url: `${parsed.protocol}//127.0.0.1:${port}`, secure: parsed.protocol === "https:" };
}

function safeAbsolutePath(value, label) {
  if (
    typeof value !== "string"
    || !/^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u.test(value)
    || value.includes("..")
  ) {
    throw new SecurityError(`${label} must be a simple absolute path`);
  }
  return value;
}

function normalizeExistingSites(manifest) {
  const sites = manifest.spec.edge.existingSites ?? [];
  return sites.map((site, index) => {
    if (typeof site !== "object" || site === null || Array.isArray(site)) {
      throw new SecurityError(`spec.edge.existingSites[${index}] must be an object`);
    }
    const host = normalizeDomain(site.host, `spec.edge.existingSites[${index}].host`);
    const upstream = existingUpstream(
      site.upstream,
      `spec.edge.existingSites[${index}].upstream`,
    );
    const tlsServerName = site.tlsServerName === undefined
      ? host
      : normalizeDomain(
        site.tlsServerName,
        `spec.edge.existingSites[${index}].tlsServerName`,
      );
    return { host, upstream, tlsServerName };
  }).sort((left, right) => left.host.localeCompare(right.host));
}

function certificateFor(host, manualCertificates) {
  if (manualCertificates === false || manualCertificates === undefined) return undefined;
  if (manualCertificates === true) {
    return {
      certificateFile: `/etc/letsencrypt/live/${host}/fullchain.pem`,
      keyFile: `/etc/letsencrypt/live/${host}/privkey.pem`,
    };
  }
  if (typeof manualCertificates !== "object" || manualCertificates === null) {
    throw new SecurityError("manualCertificates must be true, false, or an exact host map");
  }
  const entry = manualCertificates[host];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new SecurityError(`Missing manual certificate mapping for ${host}`);
  }
  return {
    certificateFile: safeAbsolutePath(entry.certificateFile, `${host} certificateFile`),
    keyFile: safeAbsolutePath(entry.keyFile, `${host} keyFile`),
  };
}

function renderReverseProxy(upstream, {
  tlsServerName,
  dropHeaders = [],
} = {}, indent = "    ") {
  const lines = [
    `${indent}reverse_proxy ${upstream} {`,
    `${indent}    header_up Host {host}`,
  ];
  for (const header of dropHeaders) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/u.test(header)) {
      throw new SecurityError("Dropped proxy header name is invalid");
    }
    lines.push(`${indent}    header_up -${header}`);
  }
  if (tlsServerName !== undefined) {
    lines.push(
      `${indent}    transport http {`,
      `${indent}        tls_server_name ${tlsServerName}`,
      `${indent}    }`,
    );
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

const LOCALLLM_LANDING_HTML = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
  "<title>LazyEdge API</title></head>",
  "<body style=\"margin:0;min-height:100vh;display:grid;place-items:center;background:#07111f;color:#e5eefb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\">",
  "<main style=\"box-sizing:border-box;width:min(92vw,720px);padding:48px;border:1px solid #263b57;border-radius:24px;background:#0d1b2e;box-shadow:0 24px 80px #0008\">",
  "<div style=\"display:inline-block;padding:6px 10px;border-radius:999px;background:#12395a;color:#8fd3ff;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase\">LazyEdge</div>",
  "<h1 style=\"margin:22px 0 12px;font-size:clamp(34px,7vw,58px);line-height:1.05;letter-spacing:-.04em\">OpenAI-compatible API</h1>",
  "<p style=\"margin:0;color:#a9bad1;font-size:18px;line-height:1.65\">This host provides an authenticated private-compute API through a default-deny gateway.</p>",
  "<div style=\"margin:30px 0;padding:18px 20px;border-radius:14px;background:#081424;border:1px solid #1d3550\"><span style=\"color:#7f96b2\">Client base path</span><code style=\"float:right;color:#b9ecff;font-size:16px\">/v1</code></div>",
  "<p style=\"margin:0;color:#8fa3bc;line-height:1.6\">Use an authorized client and only the routes configured by the operator. LocalLLM Studio and management routes are not published here.</p>",
  "<footer style=\"margin-top:34px;padding-top:20px;border-top:1px solid #21344c;color:#647b96;font-size:13px\">API endpoint · No browser console is exposed</footer>",
  "</main></body></html>",
].join("");

function renderLandingRoute(indent = "    ") {
  return [
    `${indent}@lazyedge_landing {`,
    `${indent}    method GET HEAD`,
    `${indent}    path /`,
    `${indent}}`,
    `${indent}handle @lazyedge_landing {`,
    `${indent}    header {`,
    `${indent}        Cache-Control \"no-store\"`,
    `${indent}        Content-Security-Policy \"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"`,
    `${indent}        Content-Type \"text/html; charset=utf-8\"`,
    `${indent}        Referrer-Policy \"no-referrer\"`,
    `${indent}        X-Content-Type-Options \"nosniff\"`,
    `${indent}    }`,
    `${indent}    respond ${JSON.stringify(LOCALLLM_LANDING_HTML)} 200`,
    `${indent}}`,
  ].join("\n");
}

function renderSite(host, upstream, {
  tlsServerName,
  certificate,
  acmeWebroot,
  landing = false,
  managed = false,
} = {}) {
  if (certificate === undefined) {
    if (landing) {
      return [
        `${host} {`,
        "    import lazyedge_common",
        renderLandingRoute(),
        "    handle {",
        renderReverseProxy(
          upstream,
          { tlsServerName, dropHeaders: managed ? ["Cookie"] : [] },
          "        ",
        ),
        "    }",
        "}",
        "",
      ].join("\n");
    }
    return [
      `${host} {`,
      "    import lazyedge_common",
      renderReverseProxy(upstream, {
        tlsServerName,
        dropHeaders: managed ? ["Cookie"] : [],
      }),
      "}",
      "",
    ].join("\n");
  }
  const webroot = safeAbsolutePath(acmeWebroot, "acmeWebroot");
  return [
    `http://${host} {`,
    "    handle /.well-known/acme-challenge/* {",
    `        root * ${webroot}`,
    "        file_server",
    "    }",
    "    handle {",
    "        redir https://{host}{uri} 308",
    "    }",
    "}",
    "",
    `https://${host} {`,
    "    import lazyedge_common",
    `    tls ${certificate.certificateFile} ${certificate.keyFile}`,
    "    handle /.well-known/acme-challenge/* {",
    `        root * ${webroot}`,
    "        file_server",
    "    }",
    ...(landing ? [renderLandingRoute()] : []),
    "    handle {",
    renderReverseProxy(
      upstream,
      { tlsServerName, dropHeaders: managed ? ["Cookie"] : [] },
      "        ",
    ),
    "    }",
    "}",
    "",
  ].join("\n");
}

export function renderCaddy(input, {
  manualCertificates = false,
  acmeWebroot = "/var/www/letsencrypt",
} = {}) {
  const manifest = normalizeManifest(input);
  assertPublicIngress(manifest, "Caddy rendering");
  const httpPort = assertHighPort(manifest.spec.edge.httpPort, "spec.edge.httpPort");
  const httpsPort = assertHighPort(manifest.spec.edge.httpsPort, "spec.edge.httpsPort");
  if (httpPort === httpsPort) {
    throw new SecurityError("Caddy HTTP and HTTPS ports must differ");
  }
  const gateway = exactLoopback(manifest.spec.edge.gatewayListen, "spec.edge.gatewayListen");
  const existingSites = normalizeExistingSites(manifest);
  const existingHosts = new Set(existingSites.map((site) => site.host));
  const managedSites = new Map();
  for (const service of manifest.spec.services) {
    if ((service.exposure ?? "public") !== "public") continue;
    for (const host of service.domains) {
      const current = managedSites.get(host) ?? { landing: false };
      if (
        service.profile === LOCALLLM_OPENAI_PROFILE
        || service.profile === LOCALLLM_NODE_ADMISSION_PROFILE
      ) current.landing = true;
      managedSites.set(host, current);
    }
  }
  const managedHosts = [...managedSites.keys()].sort();
  for (const host of managedHosts) {
    if (existingHosts.has(host)) {
      throw new SecurityError(`Host cannot be both preserved and managed: ${host}`);
    }
  }

  const header = [
    "# Generated by LazyEdge. Validate before an atomic reload.",
    "# Public 80/443 should be redirected to these high ports by the host firewall.",
    "{",
    "    admin unix//run/lazyedge-caddy/admin.sock",
    `    http_port ${httpPort}`,
    `    https_port ${httpsPort}`,
    "}",
    "",
    "(lazyedge_common) {",
    "    encode zstd gzip",
    "    header -Server",
    "    # Access logging is intentionally off by default to avoid credential and disk risk.",
    "}",
    "",
  ].join("\n");

  const preserved = existingSites.map((site) => renderSite(
    site.host,
    site.upstream.url,
    {
      ...(site.upstream.secure ? { tlsServerName: site.tlsServerName } : {}),
      certificate: certificateFor(site.host, manualCertificates),
      acmeWebroot,
    },
  )).join("");
  const managed = managedHosts.map((host) => renderSite(
    normalizeDomain(host),
    `http://${gateway}`,
    {
      certificate: certificateFor(host, manualCertificates),
      acmeWebroot,
      landing: managedSites.get(host).landing,
      managed: true,
    },
  )).join("");
  const rendered = `${header}${preserved}${managed}`;
  if (/0\.0\.0\.0|\*\.|:\*|\[::\](?=:)/u.test(rendered)) {
    throw new SecurityError("Rendered Caddy config contains a wildcard network target");
  }
  return rendered;
}

function natScript(
  httpFrom,
  httpsFrom,
  httpTo,
  httpsTo,
  { expectedOwnershipTag, ownershipTag } = {},
) {
  for (const [label, port] of Object.entries({ httpFrom, httpsFrom, httpTo, httpsTo })) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SecurityError(`${label} is not a valid port`);
    }
  }
  for (const [label, tag] of Object.entries({ expectedOwnershipTag, ownershipTag })) {
    if (tag !== undefined && !/^lazyedge-[a-f0-9]{16}$/u.test(tag)) {
      throw new SecurityError(`${label} is invalid`);
    }
  }
  const ownership = ownershipTag === undefined ? "" : ` comment "${ownershipTag}"`;
  const expectedOwnership = expectedOwnershipTag ?? "";
  const expectedOwnershipArgument = `'${expectedOwnership}'`;
  return `#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -eq 0 || { echo "NAT cutover must run as root" >&2; exit 2; }

find_handle() {
  local chain=$1 public_port=$2 current_port=$3 expected_ownership=$4
  nft -a list chain ip nat "$chain" | awk -v chain="$chain" -v public_port="$public_port" -v current_port="$current_port" -v expected_ownership="$expected_ownership" '
    BEGIN {
      prefix = chain == "OUTPUT" ? "ip daddr 127[.]0[.]0[.]1 " : ""
      counter = "( counter packets [0-9]+ bytes [0-9]+)?"
      ownership = expected_ownership == "" ? "" : " comment \\\"" expected_ownership "\\\""
      exact = "^[[:space:]]*" prefix "tcp dport " public_port counter \
        " redirect to :" current_port ownership \
        "[[:space:]]+# handle [0-9]+[[:space:]]*$"
    }
    $0 ~ exact {
      has_counter = $0 ~ / counter packets [0-9]+ bytes [0-9]+ /
      for (i = 1; i < NF; i++) {
        if ($i == "handle" && $(i + 1) ~ /^[0-9]+$/ && i + 1 == NF) {
          print $(i + 1) ":" (has_counter ? "1" : "0")
        }
      }
    }
  '
}

pre_http_match=$(find_handle PREROUTING 80 ${httpFrom} ${expectedOwnershipArgument})
pre_https_match=$(find_handle PREROUTING 443 ${httpsFrom} ${expectedOwnershipArgument})
out_http_match=$(find_handle OUTPUT 80 ${httpFrom} ${expectedOwnershipArgument})
out_https_match=$(find_handle OUTPUT 443 ${httpsFrom} ${expectedOwnershipArgument})
for value in "$pre_http_match" "$pre_https_match" "$out_http_match" "$out_https_match"; do
  [[ "$value" =~ ^[0-9]+:[01]$ ]] || {
    echo "Expected one exact NAT redirect rule" >&2
    exit 3
  }
done
pre_http=\${pre_http_match%%:*}
pre_https=\${pre_https_match%%:*}
out_http=\${out_http_match%%:*}
out_https=\${out_https_match%%:*}
pre_http_counter=\${pre_http_match##*:}
pre_https_counter=\${pre_https_match##*:}
out_http_counter=\${out_http_match##*:}
out_https_counter=\${out_https_match##*:}

counter_clause() {
  test "$1" = 1 && printf ' counter'
}

batch=$(mktemp /run/lazyedge-nft.XXXXXX)
cleanup() { rm -f "$batch"; }
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
# Preserve whether each accepted rule had an anonymous counter expression. nft
# replacement resets its packet and byte values; rollback cannot reconstruct
# packets observed after this artifact was rendered.
cat >"$batch" <<NFT
replace rule ip nat PREROUTING handle $pre_http tcp dport 80$(counter_clause "$pre_http_counter") redirect to :${httpTo}${ownership}
replace rule ip nat PREROUTING handle $pre_https tcp dport 443$(counter_clause "$pre_https_counter") redirect to :${httpsTo}${ownership}
replace rule ip nat OUTPUT handle $out_http ip daddr 127.0.0.1 tcp dport 80$(counter_clause "$out_http_counter") redirect to :${httpTo}${ownership}
replace rule ip nat OUTPUT handle $out_https ip daddr 127.0.0.1 tcp dport 443$(counter_clause "$out_https_counter") redirect to :${httpsTo}${ownership}
NFT
nft --check --file "$batch"
nft --file "$batch"
`;
}

export function renderNftRedirectTransaction(input, {
  previousHttpPort = 8080,
  previousHttpsPort = 8443,
} = {}) {
  const manifest = normalizeManifest(input);
  assertPublicIngress(manifest, "NAT redirect rendering");
  const { http, https } = caddyPorts(input);
  const ownershipTag = `lazyedge-${manifestDigest(manifest).slice(0, 16)}`;
  return Object.freeze({
    apply: natScript(
      previousHttpPort,
      previousHttpsPort,
      http,
      https,
      { ownershipTag },
    ),
    rollback: natScript(
      http,
      https,
      previousHttpPort,
      previousHttpsPort,
      { expectedOwnershipTag: ownershipTag },
    ),
    before: Object.freeze({ http: previousHttpPort, https: previousHttpsPort }),
    after: Object.freeze({ http, https }),
    ownershipTag,
  });
}

export function caddyPorts(input) {
  const manifest = normalizeManifest(input);
  return Object.freeze({
    http: assertHighPort(manifest.spec.edge.httpPort, "spec.edge.httpPort"),
    https: assertHighPort(manifest.spec.edge.httpsPort, "spec.edge.httpsPort"),
  });
}
