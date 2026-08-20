import { manifestDigest, normalizeManifest } from "./config.js";
import { SecurityError } from "./security.js";

const ACCOUNT_PATTERN = /^[a-z_][a-z0-9_-]{0,30}$/u;
const UNIT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}\.service$/u;
const ABSOLUTE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u;
const USER_PATH_PATTERN = /^%h\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u;

function account(value, label) {
  if (typeof value !== "string" || !ACCOUNT_PATTERN.test(value)) {
    throw new SecurityError(`${label} is not a safe account name`);
  }
  return value;
}

function unit(value, label) {
  if (typeof value !== "string" || !UNIT_PATTERN.test(value)) {
    throw new SecurityError(`${label} is not a safe systemd unit name`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !ABSOLUTE_PATH_PATTERN.test(value) || value.includes("..")) {
    throw new SecurityError(`${label} must be a simple absolute path`);
  }
  return value;
}

function userPath(value, label) {
  if (
    typeof value !== "string"
    || !(ABSOLUTE_PATH_PATTERN.test(value) || USER_PATH_PATTERN.test(value))
    || value.includes("..")
  ) {
    throw new SecurityError(`${label} must be an absolute path or a path below %h`);
  }
  return value;
}

function runtimePath(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new SecurityError("runtimePath must be a colon-separated absolute PATH");
  }
  const entries = value.split(":");
  if (
    entries.length > 32
    || new Set(entries).size !== entries.length
    || entries.some((entry) => {
      try {
        absolutePath(entry, "runtimePath entry");
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new SecurityError("runtimePath must contain unique simple absolute directories");
  }
  return entries.join(":");
}

function assertDescription(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9 ._@()+,:/-]{1,160}$/u.test(value)) {
    throw new SecurityError("systemd description is invalid");
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

function commonHardening({ protectHome, systemManager = true }) {
  return [
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    ...(systemManager ? ["PrivateDevices=true"] : []),
    "ProtectSystem=strict",
    `ProtectHome=${protectHome}`,
    "ProtectKernelTunables=true",
    ...(systemManager ? ["ProtectKernelModules=true", "ProtectKernelLogs=true"] : []),
    "ProtectControlGroups=true",
    ...(systemManager ? ["ProtectClock=true", "ProtectHostname=true"] : []),
    "RestrictNamespaces=true",
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "LockPersonality=true",
    "RemoveIPC=true",
    "SystemCallArchitectures=native",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    ...(systemManager
      ? ["CapabilityBoundingSet=", "AmbientCapabilities="]
      : []),
    "UMask=0077",
  ];
}

export function renderEdgeSystemd(input, {
  serviceUser = "lazyedge",
  executable = "/usr/local/bin/lazyedge",
  manifestPath = "/etc/lazyedge/lazyedge.yaml",
  bindingsPath = "/etc/lazyedge/bindings.edge.yaml",
  environmentFile = "/etc/lazyedge/lazyedge.env",
  pathEnvironment,
  description = "LazyEdge authenticated edge gateway",
} = {}) {
  const normalized = normalizeManifest(input);
  const user = account(serviceUser, "serviceUser");
  const binary = absolutePath(executable, "executable");
  const manifest = absolutePath(manifestPath, "manifestPath");
  const bindings = absolutePath(bindingsPath, "bindingsPath");
  const environment = absolutePath(environmentFile, "environmentFile");
  const executablePath = runtimePath(pathEnvironment);
  return [
    "[Unit]",
    `Description=${assertDescription(description)}`,
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `Group=${user}`,
    `EnvironmentFile=-${environment}`,
    ...(executablePath === undefined ? [] : [`Environment=PATH=${executablePath}`]),
    `ExecStart=${binary} serve edge --config ${manifest} --bindings ${bindings}${
      normalized.spec.edge.compatibilityService === undefined
        ? ""
        : ` --service ${normalized.spec.edge.compatibilityService}`
    }`,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStartSec=30s",
    "TimeoutStopSec=30s",
    "StateDirectory=lazyedge",
    "StateDirectoryMode=0750",
    "RuntimeDirectory=lazyedge",
    "RuntimeDirectoryMode=0750",
    "LogsDirectory=lazyedge",
    "LogsDirectoryMode=0750",
    "ReadWritePaths=/var/lib/lazyedge /var/log/lazyedge /run/lazyedge",
    ...commonHardening({ protectHome: "true" }),
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderWorkerSystemd(input, {
  executable = "/usr/local/bin/lazyedge",
  manifestPath = "%h/.config/lazyedge/lazyedge.yaml",
  bindingsPath = "%h/.config/lazyedge/bindings.worker.yaml",
  environmentFile = "%h/.config/lazyedge/worker.env",
  pathEnvironment,
  afterUnits = [],
  description = "LazyEdge private worker guards",
} = {}) {
  normalizeManifest(input);
  const binary = absolutePath(executable, "executable");
  const manifest = userPath(manifestPath, "manifestPath");
  const bindings = userPath(bindingsPath, "bindingsPath");
  const environment = userPath(environmentFile, "environmentFile");
  const executablePath = runtimePath(pathEnvironment);
  if (!Array.isArray(afterUnits) || afterUnits.length > 16) {
    throw new SecurityError("afterUnits must be a small array of systemd service names");
  }
  const dependencies = [...new Set(afterUnits.map((entry) => unit(entry, "afterUnits[]")))];
  if (dependencies.length !== afterUnits.length) {
    throw new SecurityError("afterUnits contains duplicates");
  }
  const dependencySuffix = dependencies.length === 0 ? "" : ` ${dependencies.join(" ")}`;
  return [
    "[Unit]",
    `Description=${assertDescription(description)}`,
    `Wants=network-online.target${dependencySuffix}`,
    `After=network-online.target${dependencySuffix}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `EnvironmentFile=-${environment}`,
    ...(executablePath === undefined ? [] : [`Environment=PATH=${executablePath}`]),
    `ExecStart=${binary} serve worker --config ${manifest} --bindings ${bindings}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStartSec=30s",
    "TimeoutStopSec=30s",
    "ReadWritePaths=-%h/.local/state/lazyedge -%t/lazyedge",
    // User managers cannot change process capability sets on every supported
    // host. The unprivileged service starts without capabilities already.
    ...commonHardening({ protectHome: "read-only", systemManager: false }),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderTunnelSystemd(input, {
  sshConfigPath = "%h/.config/lazyedge/ssh/config",
  sshAlias = "lazyedge-edge",
  workerUnit = "lazyedge-worker.service",
  description = "LazyEdge pinned outbound OpenSSH reverse tunnel",
} = {}) {
  normalizeManifest(input);
  const config = userPath(sshConfigPath, "sshConfigPath");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(sshAlias)) {
    throw new SecurityError("sshAlias is invalid");
  }
  const dependency = unit(workerUnit, "workerUnit");
  return [
    "[Unit]",
    `Description=${assertDescription(description)}`,
    `Wants=network-online.target ${dependency}`,
    "After=network-online.target",
    `After=${dependency}`,
    // The worker can remain behind an unavailable network or a stale remote
    // listener for longer than systemd's default start-limit window.  The
    // tunnel must keep retrying indefinitely instead of becoming permanently
    // failed while the private worker is otherwise healthy.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=/usr/bin/ssh -NT -F ${config} ${sshAlias}`,
    "Restart=always",
    "RestartSec=15s",
    "TimeoutStartSec=30s",
    "TimeoutStopSec=15s",
    ...commonHardening({ protectHome: "read-only", systemManager: false }),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderCaddySystemd(input, {
  caddyUser = "caddy",
  certificateGroup = "certread",
  executable = "/usr/bin/caddy",
  configPath = "/etc/lazyedge/Caddyfile",
  description = "LazyEdge shared-SNI Caddy gateway",
} = {}) {
  const manifest = normalizeManifest(input);
  assertPublicIngress(manifest, "Caddy systemd rendering");
  const user = account(caddyUser, "caddyUser");
  const certGroup = account(certificateGroup, "certificateGroup");
  const binary = absolutePath(executable, "executable");
  const config = absolutePath(configPath, "configPath");
  return [
    "[Unit]",
    `Description=${assertDescription(description)}`,
    "Wants=network-online.target lazyedge-edge.service",
    "After=network-online.target lazyedge-edge.service",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `Group=${user}`,
    `SupplementaryGroups=${certGroup}`,
    "Environment=XDG_DATA_HOME=/var/lib/lazyedge-caddy",
    "Environment=XDG_CONFIG_HOME=/var/lib/lazyedge-caddy",
    `ExecStartPre=${binary} validate --config ${config} --adapter caddyfile`,
    `ExecStart=${binary} run --config ${config} --adapter caddyfile`,
    `ExecReload=${binary} reload --address unix//run/lazyedge-caddy/admin.sock --config ${config} --adapter caddyfile --force`,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStartSec=60s",
    "TimeoutStopSec=30s",
    "RuntimeDirectory=lazyedge-caddy",
    "RuntimeDirectoryMode=0750",
    "StateDirectory=lazyedge-caddy",
    "StateDirectoryMode=0750",
    "ReadOnlyPaths=/etc/lazyedge -/etc/letsencrypt -/var/www/letsencrypt",
    "ReadWritePaths=/run/lazyedge-caddy /var/lib/lazyedge-caddy",
    "LimitNOFILE=1048576",
    ...commonHardening({ protectHome: "true" }),
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderCertbotDeployHook(input, {
  executable = "/usr/bin/caddy",
  configPath = "/etc/lazyedge/Caddyfile",
  caddyUnit = "lazyedge-caddy.service",
  certificateGroup = "certread",
} = {}) {
  const manifest = normalizeManifest(input);
  assertPublicIngress(manifest, "Certbot hook rendering");
  const binary = absolutePath(executable, "executable");
  const config = absolutePath(configPath, "configPath");
  const service = unit(caddyUnit, "caddyUnit");
  const certGroup = account(certificateGroup, "certificateGroup");
  const hosts = [...new Set([
    ...(manifest.spec.edge.existingSites ?? []).map((site) => site.host),
    ...manifest.spec.services
      .filter((item) => (item.exposure ?? "public") === "public")
      .flatMap((item) => item.domains),
  ])].sort();
  const lineageCases = hosts.map((host) => `/etc/letsencrypt/live/${host}`).join("|");
  return `#!/usr/bin/env bash
set -euo pipefail
lineage=\${RENEWED_LINEAGE:-}
case "$lineage" in
  ${lineageCases}) ;;
  *) exit 0 ;;
esac
test -L "$lineage/privkey.pem"
private_key=$(readlink -f "$lineage/privkey.pem")
case "$private_key" in /etc/letsencrypt/archive/*/privkey*.pem) ;; *) exit 2;; esac
/bin/chgrp ${certGroup} "$lineage" "$(dirname "$private_key")" "$private_key"
/bin/chmod 0750 "$lineage" "$(dirname "$private_key")"
/bin/chmod 0640 "$private_key"
${binary} validate --config ${config} --adapter caddyfile
/bin/systemctl reload ${service}
`;
}

export function renderPortRedirectHelper(input, {
  nftPath = "/usr/sbin/nft",
  runtimeDirectory = "/run/lazyedge-port-redirect",
} = {}) {
  // The cutover uses native nft replace operations, which can make an
  // xtables-created table opaque to iptables-save. Keep persistence on the
  // same native interface as the transaction instead of inferring an empty
  // ruleset from that compatibility failure.
  const manifest = normalizeManifest(input);
  assertPublicIngress(manifest, "Port redirect helper rendering");
  const httpPort = manifest.spec.edge.httpPort;
  const httpsPort = manifest.spec.edge.httpsPort;
  const ownershipTag = `lazyedge-${manifestDigest(manifest).slice(0, 16)}`;
  const nft = absolutePath(nftPath, "nftPath");
  const runtime = absolutePath(runtimeDirectory, "runtimeDirectory");
  return `#!/usr/bin/env bash
set -euo pipefail
action=\${1:-}
nft=${nft}
runtime_directory=${runtime}
ownership_tag=${ownershipTag}

chains=(PREROUTING PREROUTING OUTPUT OUTPUT)
public_ports=(80 443 80 443)
target_ports=(${httpPort} ${httpsPort} ${httpPort} ${httpsPort})
prefix_patterns=(
  ""
  ""
  "ip[[:space:]]+daddr[[:space:]]+127[.]0[.]0[.]1[[:space:]]+"
  "ip[[:space:]]+daddr[[:space:]]+127[.]0[.]0[.]1[[:space:]]+"
)
specifications=(
  "tcp dport 80 counter redirect to :${httpPort} comment \\"$ownership_tag\\""
  "tcp dport 443 counter redirect to :${httpsPort} comment \\"$ownership_tag\\""
  "ip daddr 127.0.0.1 tcp dport 80 counter redirect to :${httpPort} comment \\"$ownership_tag\\""
  "ip daddr 127.0.0.1 tcp dport 443 counter redirect to :${httpsPort} comment \\"$ownership_tag\\""
)

case "$action" in
  start|stop|status) ;;
  *)
    echo "usage: lazyedge-port-redirect {start|stop|status}" >&2
    exit 2
    ;;
esac

test -d "$runtime_directory" && test ! -L "$runtime_directory" || {
  echo "secure redirect runtime directory is unavailable" >&2
  exit 2
}
/usr/bin/stat -c '%U %a' "$runtime_directory" | /usr/bin/awk -v current_user=$(/usr/bin/id -un) '
  $1 == current_user && $2 ~ /^[0-7]+$/ && substr($2, length($2) - 1) !~ /[2367]/ { valid = 1 }
  END { exit valid ? 0 : 1 }
' || {
  echo "redirect runtime directory has unsafe ownership or mode" >&2
  exit 2
}
exec 9>"$runtime_directory/operation.lock"
/usr/bin/flock -x 9

batch_path=
cleanup() {
  test -z "$batch_path" || /bin/rm -f "$batch_path"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

run_batch() {
  local commands=$1
  batch_path=$(/usr/bin/mktemp "$runtime_directory/lazyedge-nft.XXXXXX")
  /bin/chmod 0600 "$batch_path"
  /usr/bin/printf '%s\\n' "$commands" >"$batch_path"
  "$nft" --check --file "$batch_path"
  "$nft" --file "$batch_path"
  /bin/rm -f "$batch_path"
  batch_path=
}

load_snapshots() {
  table_exists=0
  prerouting_exists=0
  output_exists=0
  prerouting_snapshot=
  output_snapshot=
  ruleset_snapshot=$("$nft" --stateless --handle --numeric list ruleset)
  if "$nft" --stateless --handle --numeric list table ip nat >/dev/null 2>&1; then
    table_exists=1
    if prerouting_snapshot=$("$nft" --stateless --handle --numeric list chain ip nat PREROUTING 2>/dev/null); then
      prerouting_exists=1
    fi
    if output_snapshot=$("$nft" --stateless --handle --numeric list chain ip nat OUTPUT 2>/dev/null); then
      output_exists=1
    fi
  fi
}

validate_ruleset_topology() {
  local line family= table= chain= hook=
  local -a words
  local expected_prerouting=0 expected_output=0
  while IFS= read -r line; do
    read -r -a words <<<"$line"
    if test "\${words[0]:-}" = table; then
      family=unknown
      table=unknown
      chain=
      if test "\${#words[@]}" -ge 4 && test "\${words[3]}" = "{"; then
        family=\${words[1]}
        table=\${words[2]}
      fi
      continue
    fi
    if test "\${words[0]:-}" = chain; then
      chain=unknown
      if test "\${#words[@]}" -ge 3 && test "\${words[2]}" = "{"; then
        chain=\${words[1]}
      fi
      continue
    fi
    [[ "$line" =~ ^[[:space:]]*type[[:space:]]+nat[[:space:]]+hook[[:space:]]+(prerouting|output)[[:space:]] ]] || continue
    hook=\${BASH_REMATCH[1]}
    test "$family" = ip || test "$family" = inet || continue
    if test "$family" = ip && test "$table" = nat \
      && test "$chain" = PREROUTING && test "$hook" = prerouting; then
      ((expected_prerouting += 1))
    elif test "$family" = ip && test "$table" = nat \
      && test "$chain" = OUTPUT && test "$hook" = output; then
      ((expected_output += 1))
    else
      echo "competing nft NAT base chain for IPv4 $hook" >&2
      return 3
    fi
  done <<<"$ruleset_snapshot"
  test "$expected_prerouting" -le 1 && test "$expected_output" -le 1 || {
    echo "duplicate expected nft NAT base chain" >&2
    return 3
  }
}

snapshot_for_index() {
  case "\${chains[$1]}" in
    PREROUTING) /usr/bin/printf '%s\\n' "$prerouting_snapshot" ;;
    OUTPUT) /usr/bin/printf '%s\\n' "$output_snapshot" ;;
    *) return 2 ;;
  esac
}

validate_base_chain() {
  local snapshot=$1 chain=$2 hook=$3 line count=0
  local exact="^[[:space:]]*type[[:space:]]+nat[[:space:]]+hook[[:space:]]+$hook[[:space:]]+priority[[:space:]]+-100;[[:space:]]+policy[[:space:]]+accept;[[:space:]]*$"
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*type[[:space:]] ]] || continue
    [[ "$line" =~ $exact ]] || {
      echo "incompatible nft base chain $chain" >&2
      return 3
    }
    ((count += 1))
  done <<<"$snapshot"
  test "$count" -eq 1 || {
    echo "incompatible nft base chain $chain" >&2
    return 3
  }
}

inspect_snapshot() {
  local snapshot=$1 index=$2 mode=\${3:-strict} line other other_exact
  local count=0 handle=
  local exact="^[[:space:]]*\${prefix_patterns[$index]}tcp[[:space:]]+dport[[:space:]]+\${public_ports[$index]}([[:space:]]+counter)?[[:space:]]+redirect[[:space:]]+to[[:space:]]+:\${target_ports[$index]}[[:space:]]+comment[[:space:]]+\\\"$ownership_tag\\\"[[:space:]]+#[[:space:]]+handle[[:space:]]+([0-9]+)[[:space:]]*$"
  while IFS= read -r line; do
    if [[ "$line" =~ $exact ]]; then
      ((count += 1))
      handle=\${BASH_REMATCH[2]}
      continue
    fi
    for other in "\${!specifications[@]}"; do
      test "$other" = "$index" && continue
      test "\${chains[$other]}" = "\${chains[$index]}" || continue
      other_exact="^[[:space:]]*\${prefix_patterns[$other]}tcp[[:space:]]+dport[[:space:]]+\${public_ports[$other]}([[:space:]]+counter)?[[:space:]]+redirect[[:space:]]+to[[:space:]]+:\${target_ports[$other]}[[:space:]]+comment[[:space:]]+\\\"$ownership_tag\\\"[[:space:]]+#[[:space:]]+handle[[:space:]]+[0-9]+[[:space:]]*$"
      [[ "$line" =~ $other_exact ]] && continue 2
    done
    [[ "$line" =~ ^[[:space:]]*$ \
      || "$line" =~ ^[[:space:]]*(table|chain|type)[[:space:]] \
      || "$line" =~ ^[[:space:]]*\}[[:space:]]*$ ]] && continue
    if test "$mode" = strict && ! is_proven_disjoint_rule "$line"; then
      echo "overlapping or unprovable NAT rule in \${chains[$index]}" >&2
      return 3
    fi
  done <<<"$snapshot"
  test "$count" -le 1 || {
    echo "duplicate owned NAT rule for \${chains[$index]} TCP \${public_ports[$index]}" >&2
    return 3
  }
  /usr/bin/printf '%s\\n' "$handle"
}

term_is_disjoint() {
  local term=\${1%,} first last
  if [[ "$term" =~ ^[0-9]+$ ]]; then
    test "$term" -ne 80 && test "$term" -ne 443
    return
  fi
  if [[ "$term" =~ ^([0-9]+)-([0-9]+)$ ]]; then
    first=\${BASH_REMATCH[1]}
    last=\${BASH_REMATCH[2]}
    test "$first" -le "$last" || return 1
    { test 80 -lt "$first" || test 80 -gt "$last"; } \
      && { test 443 -lt "$first" || test 443 -gt "$last"; }
    return
  fi
  return 1
}

is_proven_disjoint_rule() {
  local line=$1 position end_found=0
  local -a words
  read -r -a words <<<"$line"
  for ((position = 0; position + 2 < \${#words[@]}; position++)); do
    if test "\${words[$position]}" = udp && test "\${words[$((position + 1))]}" = dport; then
      return 0
    fi
    test "\${words[$position]}" = tcp \
      && test "\${words[$((position + 1))]}" = dport || continue
    ((position += 2))
    if test "\${words[$position]}" = "{"; then
      ((position += 1))
      for ((; position < \${#words[@]}; position++)); do
        if test "\${words[$position]}" = "}"; then
          end_found=1
          break
        fi
        term_is_disjoint "\${words[$position]}" || return 1
      done
      test "$end_found" = 1
      return
    fi
    term_is_disjoint "\${words[$position]}"
    return
  done
  return 1
}

append_command() {
  local command=$1
  if test -z "$commands"; then
    commands=$command
  else
    commands+=$'\\n'$command
  fi
}

case "$action" in
  start)
    load_snapshots
    validate_ruleset_topology
    commands=
    if test "$table_exists" = 0; then
      append_command "add table ip nat"
    fi
    if test "$prerouting_exists" = 0; then
      append_command "add chain ip nat PREROUTING { type nat hook prerouting priority -100; policy accept; }"
    else
      validate_base_chain "$prerouting_snapshot" PREROUTING prerouting
    fi
    if test "$output_exists" = 0; then
      append_command "add chain ip nat OUTPUT { type nat hook output priority -100; policy accept; }"
    else
      validate_base_chain "$output_snapshot" OUTPUT output
    fi
    for index in "\${!specifications[@]}"; do
      snapshot=$(snapshot_for_index "$index")
      handle=$(inspect_snapshot "$snapshot" "$index") || exit $?
      test -n "$handle" || append_command "add rule ip nat \${chains[$index]} \${specifications[$index]}"
    done
    test -z "$commands" || run_batch "$commands"
    load_snapshots
    validate_ruleset_topology
    test "$table_exists" = 1 \
      && test "$prerouting_exists" = 1 \
      && test "$output_exists" = 1 || {
      echo "persistent redirect verification failed" >&2
      exit 4
    }
    validate_base_chain "$prerouting_snapshot" PREROUTING prerouting
    validate_base_chain "$output_snapshot" OUTPUT output
    for index in "\${!specifications[@]}"; do
      snapshot=$(snapshot_for_index "$index")
      if ! handle=$(inspect_snapshot "$snapshot" "$index") || test -z "$handle"; then
        echo "persistent redirect verification failed" >&2
        exit 4
      fi
    done
    ;;
  stop)
    load_snapshots
    commands=
    for index in "\${!specifications[@]}"; do
      if test "\${chains[$index]}" = PREROUTING; then
        test "$prerouting_exists" = 1 || continue
      else
        test "$output_exists" = 1 || continue
      fi
      snapshot=$(snapshot_for_index "$index")
      handle=$(inspect_snapshot "$snapshot" "$index" owned-only) || exit $?
      test -z "$handle" || append_command "delete rule ip nat \${chains[$index]} handle $handle"
    done
    if test -n "$commands"; then
      echo "removing exact LazyEdge-owned redirects; previous mappings are not restored" >&2
      run_batch "$commands"
    fi
    ;;
  status)
    load_snapshots
    validate_ruleset_topology
    test "$table_exists" = 1 \
      && test "$prerouting_exists" = 1 \
      && test "$output_exists" = 1 || exit 1
    validate_base_chain "$prerouting_snapshot" PREROUTING prerouting
    validate_base_chain "$output_snapshot" OUTPUT output
    for index in "\${!specifications[@]}"; do
      snapshot=$(snapshot_for_index "$index")
      handle=$(inspect_snapshot "$snapshot" "$index") || exit $?
      test -n "$handle" || exit 1
    done
    ;;
esac
`;
}

export function renderPortRedirectSystemd(input, {
  helperPath = "/usr/local/libexec/lazyedge-port-redirect",
  caddyUnit = "lazyedge-caddy.service",
  preservedProbeHost,
} = {}) {
  const manifest = normalizeManifest(input);
  assertPublicIngress(manifest, "Port redirect systemd rendering");
  const helper = absolutePath(helperPath, "helperPath");
  const caddy = unit(caddyUnit, "caddyUnit");
  const preservedHosts = (manifest.spec.edge.existingSites ?? []).map((site) => site.host);
  const managedHosts = manifest.spec.services
    .filter((service) => (service.exposure ?? "public") === "public")
    .flatMap((service) => service.domains);
  const probeHosts = [...new Set([...preservedHosts, ...managedHosts])];
  const probeHost = preservedProbeHost ?? probeHosts[0];
  if (typeof probeHost !== "string" || !probeHosts.includes(probeHost)) {
    throw new SecurityError("preservedProbeHost must name a configured public site");
  }
  const requireSuccessfulStatus = preservedHosts.includes(probeHost);
  const probePort = requireSuccessfulStatus
    ? manifest.spec.edge.httpsPort
    : manifest.spec.edge.httpPort;
  const probeProtocol = requireSuccessfulStatus ? "https" : "http";
  return [
    "[Unit]",
    "Description=LazyEdge public 80/443 high-port redirects",
    `Wants=network-online.target ${caddy}`,
    "After=network-online.target",
    `After=${caddy}`,
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStartPre=/usr/bin/curl ${requireSuccessfulStatus ? "--fail " : ""}--silent --show-error --noproxy '*' --retry 5 --retry-delay 1 --retry-max-time 15 --retry-connrefused --retry-all-errors --connect-timeout 2 --max-time 10 --resolve ${probeHost}:${probePort}:127.0.0.1 ${probeProtocol}://${probeHost}:${probePort}/ --output /dev/null`,
    `ExecStart=${helper} start`,
    "RuntimeDirectory=lazyedge-port-redirect",
    "RuntimeDirectoryMode=0700",
    "ReadWritePaths=/run/lazyedge-port-redirect",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "ProtectKernelTunables=false",
    "ProtectKernelModules=true",
    "ProtectKernelLogs=true",
    "ProtectControlGroups=true",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "CapabilityBoundingSet=CAP_NET_ADMIN",
    "AmbientCapabilities=CAP_NET_ADMIN",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderSystemdBundle(input, { mode = "root" } = {}) {
  const manifest = normalizeManifest(input);
  if (!new Set(["root", "user", "all"]).has(mode)) {
    throw new SecurityError("systemd render mode must be root, user, or all");
  }
  const hasPublicIngress = (manifest.spec.edge.existingSites?.length ?? 0) > 0
    || manifest.spec.services.some(
      (service) => (service.exposure ?? "public") === "public",
    );
  const root = Object.freeze({
    "lazyedge-edge.service": renderEdgeSystemd(manifest),
    ...(hasPublicIngress
      ? {
        "lazyedge-caddy.service": renderCaddySystemd(manifest),
        "lazyedge-port-redirect.service": renderPortRedirectSystemd(manifest),
      }
      : {}),
  });
  const user = Object.freeze({
    "lazyedge-worker.service": renderWorkerSystemd(manifest),
    "lazyedge-tunnel.service": renderTunnelSystemd(manifest),
  });
  if (mode === "root") return root;
  if (mode === "user") return user;
  return Object.freeze({ root, user });
}

export const renderSystemd = renderSystemdBundle;
