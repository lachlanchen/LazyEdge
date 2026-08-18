import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  renderBootstrapScript,
  renderTunnelAuthorizedKey,
  renderTunnelSshdConfig,
} from "../src/accounts.js";
import {
  renderCaddy,
  renderNftRedirectTransaction,
} from "../src/caddy.js";
import {
  openSshCommand,
  renderOpenSshConfig,
  renderPinnedKnownHosts,
} from "../src/openssh.js";
import {
  renderCaddySystemd,
  renderCertbotDeployHook,
  renderEdgeSystemd,
  renderPortRedirectHelper,
  renderPortRedirectSystemd,
  renderSystemdBundle,
  renderTunnelSystemd,
  renderWorkerSystemd,
} from "../src/systemd.js";

const fixtureUrl = new URL("./fixtures/ops-sshem-sanitized.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmVLZXlOb3RTZWNyZXQ lazyedge-fixture";
const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmVIb3N0S2V5";
const execFile = promisify(execFileCallback);

test("Caddy renderer preserves an existing TLS upstream and isolates managed hosts", () => {
  const caddy = renderCaddy(fixture, { manualCertificates: true });
  assert.match(caddy, /http_port 10080/u);
  assert.match(caddy, /https_port 10443/u);
  assert.match(caddy, /https:\/\/chat\.example\.net/u);
  assert.match(caddy, /reverse_proxy https:\/\/127\.0\.0\.1:8443/u);
  assert.match(caddy, /tls_server_name chat\.example\.net/u);
  assert.match(caddy, /https:\/\/llm\.example\.net/u);
  assert.match(caddy, /reverse_proxy http:\/\/127\.0\.0\.1:17600/u);
  assert.match(caddy, /root \* \/var\/www\/letsencrypt/u);
  assert.match(caddy, /tls \/etc\/letsencrypt\/live\/llm\.example\.net\/fullchain\.pem/u);
  assert.doesNotMatch(caddy, /0\.0\.0\.0|\*\.|:\*/u);
});

test("Caddy renderer refuses privileged ports and unsafe certificate paths", () => {
  const lowPort = structuredClone(fixture);
  lowPort.spec.edge.httpPort = 80;
  assert.throws(() => renderCaddy(lowPort), /(?:integer port|high port)/u);
  assert.throws(() => renderCaddy(fixture, {
    manualCertificates: {
      "chat.example.net": {
        certificateFile: "/etc/letsencrypt/live/chat.example.net/fullchain.pem",
        keyFile: "/etc/letsencrypt/live/chat.example.net/privkey.pem",
      },
      "llm.example.net": {
        certificateFile: "/tmp/../escape.pem",
        keyFile: "/tmp/key.pem",
      },
    },
  }), /simple absolute path/u);
});

test("NAT cutover renderer supplies exact apply and rollback transactions", () => {
  const transaction = renderNftRedirectTransaction(fixture, {
    previousHttpPort: 8080,
    previousHttpsPort: 8443,
  });
  assert.deepEqual(transaction.before, { http: 8080, https: 8443 });
  assert.deepEqual(transaction.after, { http: 10080, https: 10443 });
  assert.match(transaction.apply, /redirect to :10080/u);
  assert.match(transaction.apply, /redirect to :10443/u);
  assert.match(transaction.apply, /comment "lazyedge-[a-f0-9]{16}"/u);
  assert.match(transaction.rollback, /redirect to :8080/u);
  assert.match(transaction.rollback, /redirect to :8443/u);
  assert.doesNotMatch(transaction.rollback, /comment "lazyedge-/u);
  assert.match(
    transaction.rollback,
    /find_handle PREROUTING 80 10080 'lazyedge-[a-f0-9]{16}'/u,
  );
  assert.match(transaction.apply, /find_handle PREROUTING 80 8080 ''/u);
  assert.match(transaction.ownershipTag, /^lazyedge-[a-f0-9]{16}$/u);
  assert.match(transaction.apply, /nft --check --file/u);
});

test("rendered NAT transactions execute only against exact rule shapes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-nat-render-"));
  try {
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    const transaction = renderNftRedirectTransaction(fixture, {
      previousHttpPort: 8080,
      previousHttpsPort: 8443,
    });
    const applyPath = path.join(directory, "apply.sh");
    const rollbackPath = path.join(directory, "rollback.sh");
    const batchPath = path.join(directory, "batch.nft");
    const capturePath = path.join(directory, "capture.nft");
    const preroutingPath = path.join(directory, "prerouting.nft");
    const outputPath = path.join(directory, "output.nft");
    await writeFile(applyPath, transaction.apply, { mode: 0o700 });
    await writeFile(rollbackPath, transaction.rollback, { mode: 0o700 });
    await writeFile(path.join(bin, "id"), `#!/bin/sh
test "$1" = "-u" && { echo 0; exit 0; }
exec /usr/bin/id "$@"
`, { mode: 0o700 });
    await writeFile(path.join(bin, "mktemp"), `#!/bin/sh
: >"$FAKE_BATCH"
printf '%s\\n' "$FAKE_BATCH"
`, { mode: 0o700 });
    await writeFile(path.join(bin, "nft"), `#!/bin/sh
if test "$1" = "-a"; then
  test "$6" = "PREROUTING" && cat "$FAKE_PREROUTING"
  test "$6" = "OUTPUT" && cat "$FAKE_OUTPUT"
  exit 0
fi
test "$1" = "--file" -o "$1" = "--check" || exit 9
last=''
for arg in "$@"; do last=$arg; done
cp "$last" "$FAKE_CAPTURE"
`, { mode: 0o700 });

    const baseEnvironment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_BATCH: batchPath,
      FAKE_CAPTURE: capturePath,
      FAKE_PREROUTING: preroutingPath,
      FAKE_OUTPUT: outputPath,
    };
    await writeFile(preroutingPath, [
      "tcp dport 80 counter packets 17 bytes 1234 redirect to :8080 # handle 11",
      "tcp dport 443 redirect to :8443 # handle 12",
      "",
    ].join("\n"));
    await writeFile(outputPath, [
      "ip daddr 127.0.0.1 tcp dport 80 counter packets 9 bytes 700 redirect to :8080 # handle 13",
      "ip daddr 127.0.0.1 tcp dport 443 redirect to :8443 # handle 14",
      "",
    ].join("\n"));
    const applied = spawnSync("/bin/bash", [applyPath], {
      env: baseEnvironment,
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr);
    const applyBatch = await readFile(capturePath, "utf8");
    assert.match(
      applyBatch,
      /PREROUTING handle 11 tcp dport 80 counter redirect to :10080 comment "lazyedge-[a-f0-9]{16}"/u,
    );
    assert.match(
      applyBatch,
      /OUTPUT handle 13 ip daddr 127\.0\.0\.1 tcp dport 80 counter redirect to :10080/u,
    );
    assert.match(applyBatch, /PREROUTING handle 12 tcp dport 443 redirect to :10443/u);
    assert.doesNotMatch(applyBatch, /counter packets|counter bytes/u);

    await writeFile(preroutingPath, [
      `tcp dport 80 counter packets 2 bytes 90 redirect to :10080 comment "${transaction.ownershipTag}" # handle 21`,
      `tcp dport 443 redirect to :10443 comment "${transaction.ownershipTag}" # handle 22`,
      "",
    ].join("\n"));
    await writeFile(outputPath, [
      `ip daddr 127.0.0.1 tcp dport 80 counter packets 3 bytes 110 redirect to :10080 comment "${transaction.ownershipTag}" # handle 23`,
      `ip daddr 127.0.0.1 tcp dport 443 redirect to :10443 comment "${transaction.ownershipTag}" # handle 24`,
      "",
    ].join("\n"));
    const rolledBack = spawnSync("/bin/bash", [rollbackPath], {
      env: baseEnvironment,
      encoding: "utf8",
    });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    const rollbackBatch = await readFile(capturePath, "utf8");
    assert.match(
      rollbackBatch,
      /PREROUTING handle 21 tcp dport 80 counter redirect to :8080/u,
    );
    assert.match(
      rollbackBatch,
      /OUTPUT handle 23 ip daddr 127\.0\.0\.1 tcp dport 80 counter redirect to :8080/u,
    );
    assert.match(rollbackBatch, /PREROUTING handle 22 tcp dport 443 redirect to :8443/u);
    assert.doesNotMatch(rollbackBatch, /comment "lazyedge-/u);
    assert.doesNotMatch(rollbackBatch, /counter packets|counter bytes/u);

    const refusedCases = [
      {
        name: "extra PREROUTING predicate",
        script: applyPath,
        prerouting: [
          "ip saddr 10.0.0.0/8 tcp dport 80 redirect to :8080 # handle 31",
          "tcp dport 443 redirect to :8443 # handle 32",
        ],
        output: [
          "ip daddr 127.0.0.1 tcp dport 80 redirect to :8080 # handle 33",
          "ip daddr 127.0.0.1 tcp dport 443 redirect to :8443 # handle 34",
        ],
      },
      {
        name: "extra prior comment",
        script: applyPath,
        prerouting: [
          "tcp dport 80 redirect to :8080 comment \"not-lazyedge\" # handle 41",
          "tcp dport 443 redirect to :8443 # handle 42",
        ],
        output: [
          "ip daddr 127.0.0.1 tcp dport 80 redirect to :8080 # handle 43",
          "ip daddr 127.0.0.1 tcp dport 443 redirect to :8443 # handle 44",
        ],
      },
      {
        name: "non-loopback OUTPUT destination",
        script: applyPath,
        prerouting: [
          "tcp dport 80 redirect to :8080 # handle 51",
          "tcp dport 443 redirect to :8443 # handle 52",
        ],
        output: [
          "ip daddr 127.0.0.2 tcp dport 80 redirect to :8080 # handle 53",
          "ip daddr 127.0.0.1 tcp dport 443 redirect to :8443 # handle 54",
        ],
      },
      {
        name: "ownership substring",
        script: rollbackPath,
        prerouting: [
          `tcp dport 80 redirect to :10080 comment "prefix-${transaction.ownershipTag}-suffix" # handle 61`,
          `tcp dport 443 redirect to :10443 comment "${transaction.ownershipTag}" # handle 62`,
        ],
        output: [
          `ip daddr 127.0.0.1 tcp dport 80 redirect to :10080 comment "${transaction.ownershipTag}" # handle 63`,
          `ip daddr 127.0.0.1 tcp dport 443 redirect to :10443 comment "${transaction.ownershipTag}" # handle 64`,
        ],
      },
    ];
    for (const refusedCase of refusedCases) {
      await writeFile(preroutingPath, `${refusedCase.prerouting.join("\n")}\n`);
      await writeFile(outputPath, `${refusedCase.output.join("\n")}\n`);
      const refused = spawnSync("/bin/bash", [refusedCase.script], {
        env: baseEnvironment,
        encoding: "utf8",
      });
      assert.notEqual(refused.status, 0, refusedCase.name);
      assert.match(refused.stderr, /Expected one exact NAT redirect rule/u, refusedCase.name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("OpenSSH renderer uses one pinned noninteractive connection", () => {
  const config = renderOpenSshConfig(fixture, {
    identityFile: "/home/example/.config/lazyedge/ssh/id_ed25519",
    knownHostsFile: "/home/example/.config/lazyedge/ssh/known_hosts",
  });
  assert.equal((config.match(/^Host /gmu) ?? []).length, 1);
  assert.match(config, /Host lazyedge-edge/u);
  assert.match(config, /StrictHostKeyChecking yes/u);
  assert.match(config, /BatchMode yes/u);
  assert.match(config, /ExitOnForwardFailure yes/u);
  assert.match(config, /ServerAliveInterval 15/u);
  assert.match(config, /SessionType none/u);
  assert.match(config, /ClearAllForwardings no/u);
  assert.match(config, /RemoteForward 127\.0\.0\.1:18008 127\.0\.0\.1:17800/u);
  assert.doesNotMatch(config, /0\.0\.0\.0|\[::\]/u);
  assert.deepEqual(openSshCommand(fixture), {
    file: "/usr/bin/ssh",
    args: ["-NT", "-F", "/home/lazyedge/.config/lazyedge/ssh/config", "lazyedge-edge"],
  });
  assert.equal(renderPinnedKnownHosts(fixture, hostKey), `edge.example.net ${hostKey}\n`);

  const alternatePort = structuredClone(fixture);
  alternatePort.spec.transport.sshPort = 2222;
  alternatePort.spec.transport.hostKeyAlias = "lazyedge-pinned";
  assert.equal(
    renderPinnedKnownHosts(alternatePort, hostKey),
    `lazyedge-pinned ${hostKey}\n`,
  );
});

test("OpenSSH effective config retains every rendered reverse forward", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-ssh-render-"));
  try {
    const configPath = path.join(directory, "config");
    const identityPath = path.join(directory, "id_ed25519");
    const knownHostsPath = path.join(directory, "known_hosts");
    await writeFile(identityPath, "test fixture only\n", { mode: 0o600 });
    await writeFile(knownHostsPath, "", { mode: 0o600 });
    await writeFile(configPath, renderOpenSshConfig(fixture, {
      identityFile: identityPath,
      knownHostsFile: knownHostsPath,
    }), { mode: 0o600 });
    const { stdout } = await execFile("/usr/bin/ssh", [
      "-G", "-F", configPath, "lazyedge-edge",
    ]);
    assert.match(stdout, /^clearallforwardings no$/mu);
    assert.match(
      stdout,
      /^remoteforward \[127\.0\.0\.1\]:18008 \[127\.0\.0\.1\]:17800$/mu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dedicated tunnel identity permits only exact remote listeners", () => {
  const authorized = renderTunnelAuthorizedKey(fixture, publicKey);
  assert.match(authorized, /^restrict,port-forwarding,permitlisten="127\.0\.0\.1:18008"/u);
  assert.doesNotMatch(authorized, /0\.0\.0\.0|\*|command=/u);

  const sshd = renderTunnelSshdConfig(fixture);
  for (const line of [
    "AuthenticationMethods publickey",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AllowTcpForwarding remote",
    "GatewayPorts no",
    "PermitListen 127.0.0.1:18008",
    "MaxSessions 0",
    "PermitTTY no",
    "X11Forwarding no",
    "AllowAgentForwarding no",
    "Match all",
  ]) assert.match(sshd, new RegExp(line, "u"));

  const bootstrap = renderBootstrapScript(fixture, { publicKey });
  assert.match(bootstrap, /useradd --system --user-group/u);
  assert.match(bootstrap, /sshd -t/u);
  assert.match(bootstrap, /systemctl reload ssh\.service/u);
  assert.match(bootstrap, /had_previous/u);
  assert.match(bootstrap, /sshd-restore/u);
  assert.match(bootstrap, /authorized_keys\.previous/u);
  assert.match(bootstrap, /authorized_keys-restore/u);
  assert.match(bootstrap, /\/etc\/ssh\/sshd_config\.d\/60-lazyedge-tunnel\.conf/u);
  assert.doesNotMatch(bootstrap, /0\.0\.0\.0/u);
});

test("rendered sshd include restores global parsing after its Match block", async (context) => {
  try {
    await execFile("/usr/sbin/sshd", ["-V"]);
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("OpenSSH server is unavailable");
      return;
    }
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-sshd-render-"));
  try {
    const keyPath = path.join(directory, "host_key");
    const includePath = path.join(directory, "lazyedge.conf");
    const configPath = path.join(directory, "sshd_config");
    await execFile("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
    await chmod(keyPath, 0o600);
    await writeFile(includePath, renderTunnelSshdConfig(fixture), { mode: 0o600 });
    await writeFile(configPath, [
      `HostKey ${keyPath}`,
      `Include ${includePath}`,
      "UsePAM yes",
      "",
    ].join("\n"), { mode: 0o600 });
    await execFile("/usr/sbin/sshd", ["-T", "-f", configPath]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("systemd renderers use exact CLI contracts and defense in depth", () => {
  const edge = renderEdgeSystemd(fixture);
  assert.match(edge, /ExecStart=\/usr\/local\/bin\/lazyedge serve edge --config \/etc\/lazyedge\/lazyedge\.yaml --bindings \/etc\/lazyedge\/bindings\.edge\.yaml/u);
  assert.match(edge, /--service local-llm/u);
  assert.match(edge, /User=lazyedge/u);
  assert.match(edge, /ProtectSystem=strict/u);
  assert.match(edge, /CapabilityBoundingSet=\n/u);

  const worker = renderWorkerSystemd(fixture);
  assert.match(worker, /serve worker --config %h\/\.config\/lazyedge\/lazyedge\.yaml --bindings %h\/\.config\/lazyedge\/bindings\.worker\.yaml/u);
  assert.match(worker, /ProtectHome=read-only/u);
  assert.doesNotMatch(worker, /CapabilityBoundingSet=/u);
  assert.doesNotMatch(worker, /AmbientCapabilities=/u);
  assert.doesNotMatch(worker, /PrivateDevices=/u);
  assert.doesNotMatch(worker, /ProtectKernelModules=/u);
  assert.doesNotMatch(worker, /ProtectKernelLogs=/u);
  assert.doesNotMatch(worker, /ProtectClock=/u);
  assert.doesNotMatch(worker, /ProtectHostname=/u);

  const tunnel = renderTunnelSystemd(fixture);
  assert.match(tunnel, /ExecStart=\/usr\/bin\/ssh -NT -F %h\/\.config\/lazyedge\/ssh\/config lazyedge-edge/u);
  assert.equal((tunnel.match(/ExecStart=/gu) ?? []).length, 1);
  assert.match(tunnel, /Wants=network-online\.target lazyedge-worker\.service/u);
  assert.doesNotMatch(tunnel, /BindsTo=/u);
  assert.doesNotMatch(tunnel, /CapabilityBoundingSet=/u);
  assert.doesNotMatch(tunnel, /AmbientCapabilities=/u);
  assert.doesNotMatch(tunnel, /PrivateDevices=/u);
  assert.doesNotMatch(tunnel, /ProtectHostname=/u);

  const caddy = renderCaddySystemd(fixture);
  assert.match(caddy, /SupplementaryGroups=certread/u);
  assert.match(caddy, /XDG_CONFIG_HOME=\/var\/lib\/lazyedge-caddy/u);
  assert.match(caddy, /caddy validate/u);
  assert.match(caddy, /unix\/\/run\/lazyedge-caddy\/admin\.sock/u);
  assert.doesNotMatch(caddy, /--environ/u);

  const hook = renderCertbotDeployHook(fixture);
  assert.match(hook, /caddy validate/u);
  assert.match(hook, /systemctl reload lazyedge-caddy\.service/u);

  const redirectHelper = renderPortRedirectHelper(fixture);
  assert.match(redirectHelper, /tcp dport 80 counter redirect to :10080/u);
  assert.match(redirectHelper, /tcp dport 443 counter redirect to :10443/u);
  assert.match(redirectHelper, /overlapping or unprovable NAT rule/u);
  assert.match(redirectHelper, /comment \\"\$ownership_tag\\"/u);
  assert.match(redirectHelper, /\$nft" --check --file/u);
  assert.doesNotMatch(redirectHelper, /iptables-save/u);
  const redirectUnit = renderPortRedirectSystemd(fixture);
  assert.match(redirectUnit, /Wants=network-online\.target lazyedge-caddy\.service/u);
  assert.doesNotMatch(redirectUnit, /Requires=lazyedge-caddy/u);
  assert.match(redirectUnit, /^After=network-online\.target$/mu);
  assert.match(redirectUnit, /^After=lazyedge-caddy\.service$/mu);
  assert.match(redirectUnit, /--noproxy '\*'/u);
  assert.doesNotMatch(redirectUnit, /^ExecStop=/mu);
  assert.match(redirectUnit, /--resolve chat\.example\.net:10443:127\.0\.0\.1/u);
  assert.match(redirectUnit, /ExecStartPre=.*--fail/u);
  assert.match(redirectUnit, /^RuntimeDirectory=lazyedge-port-redirect$/mu);
  assert.match(redirectUnit, /^RuntimeDirectoryMode=0700$/mu);
  assert.match(redirectUnit, /^ReadWritePaths=\/run\/lazyedge-port-redirect$/mu);

  assert.deepEqual(Object.keys(renderSystemdBundle(fixture, { mode: "user" })), [
    "lazyedge-worker.service",
    "lazyedge-tunnel.service",
  ]);

  const freshEdge = structuredClone(fixture);
  freshEdge.spec.edge.existingSites = [];
  const freshRedirect = renderPortRedirectSystemd(freshEdge);
  assert.match(freshRedirect, /--resolve llm\.example\.net:10080:127\.0\.0\.1/u);
  assert.match(freshRedirect, /http:\/\/llm\.example\.net:10080\//u);
  assert.match(freshRedirect, /--noproxy '\*'/u);
  assert.match(freshRedirect, /--retry-connrefused --retry-all-errors/u);
  assert.doesNotMatch(freshRedirect, /ExecStartPre=.*--fail/u);
});
