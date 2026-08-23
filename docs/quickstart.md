# Quickstart

This walkthrough creates and reviews a project. It does not assume that a production edge, DNS record, npm release, or private service is already live.

## Prerequisites

- Node.js 20 or newer on the machine running the CLI;
- a public Linux edge reachable by SSH from the private worker;
- Caddy or an existing HTTPS ingress on the edge;
- a private HTTP service bound to exact IPv4 loopback `127.0.0.1`;
- a dedicated unprivileged SSH forwarding account and key;
- one approved hostname whose DNS you control.

Do not paste a password or token into a command, manifest, support channel, or repository.

## 1. Inspect and initialize

```bash
npx @lazyingart/lazyedge --help
mkdir my-edge
cd my-edge
npx @lazyingart/lazyedge init --output lazyedge.yaml
```

`init` creates one secret-free `lazyedge.yaml`. Open the manifest and replace example hosts and ports. The v0.3 preview requires exact IPv4 loopback listeners such as `127.0.0.1:18008`; never use `0.0.0.0`, `::1`, a LAN address, or a raw public target.

For a LocalLLM/OpenAI-compatible service, use `profile: localllm-openai`. That profile admits only a chosen subset of this reviewed four-route set:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

Its health path is private and must not overlap `/v1/`. Use `generic-http` for another HTTP API and enumerate every allowed path and method exactly; wildcards remain forbidden.

On a managed `localllm-openai` hostname, Caddy serves a small static information page for exact `GET /` and `HEAD /` requests. The `/v1` prefix remains the authenticated default-deny API path; LocalLLM Studio, `/api`, Ollama, and other management routes are not published.

## 2. Create role-specific secret stores outside the project

The manifest names a token set but contains no token value. The public edge and private worker must not share one catch-all bindings file. Copy the [edge template](../examples/local-llm/bindings.edge.example.yaml) only to the gateway and the [worker template](../examples/local-llm/bindings.worker.example.yaml) only to private compute. A typical split is:

```text
Public edge only
/etc/lazyedge/
├── bindings.edge.yaml                         mode 0600
└── secrets/
    └── local-llm-relay                        mode 0600
/var/lib/lazyedge/
└── tokens/
    └── local-llm-users.json                   mode 0600

Private worker only
~/.config/lazyedge/
├── bindings.worker.yaml                       mode 0600
└── secrets/                                   mode 0700
    ├── local-llm-relay                        mode 0600
    └── local-llm-upstream-key                 mode 0600

Authorized client only
└── external LazyEdge token in its secret manager
```

The two relay files contain the same capability and must be transferred once through a protected channel. The upstream key stays only on the worker; the client-token store stays only on the edge. At runtime, each role opens only its relay file and its own role-specific store.

On the private worker, generate separate relay and upstream secrets. On the public edge, issue an external client capability into the edge-only token store. These commands create mode-`0600` output files, refuse to overwrite an existing path, and never print the secret values:

```bash
# Private worker
npx @lazyingart/lazyedge secret generate \
  --out "$HOME/.config/lazyedge/secrets/local-llm-relay" \
  --prefix relay
npx @lazyingart/lazyedge secret generate \
  --out "$HOME/.config/lazyedge/secrets/local-llm-upstream-key" \
  --prefix upstream

# Public edge, run as the account that owns these protected paths
npx @lazyingart/lazyedge token issue \
  --store /var/lib/lazyedge/tokens/local-llm-users.json \
  --set local-llm-users \
  --service local-llm \
  --days 30 \
  --out /etc/lazyedge/secrets/local-llm-client-token.pending
```

If LocalLLM already has an API key in a private `.env`, replace the second `secret generate` command above with an import. The source must be a regular non-symlink file with no permissions for the Unix `other` class (mode `0600` is recommended), the variable must occur exactly once, and the destination must not exist:

```bash
npx @lazyingart/lazyedge secret import-env \
  --env-file /absolute/path/to/LocalLLM/.env \
  --name LOCALLLM_API_KEY \
  --out ~/.config/lazyedge/secrets/local-llm-upstream-key
```

The command prints only destination metadata, never the imported value. It does not modify the source project.

`secret sync-env` is for a later, coordinated upstream-key rotation—not ordinary import. It can atomically write a proposed value file into one variable in the private service's `.env`, but it does not create a backup, restart the owning service, verify new/old credentials, or roll back. Follow the complete [upstream-key rotation procedure](operations.md#upstream-key-rotation).

Move or import the pending client-token file into the intended client's secret manager through a private channel, verify the client, then remove the edge-side plaintext export according to your retention policy. The edge store retains a digest and metadata, not reusable plaintext. `token list` shows IDs/metadata; `token revoke` accepts an ID:

```bash
npx @lazyingart/lazyedge token list \
  --store /var/lib/lazyedge/tokens/local-llm-users.json \
  --set local-llm-users
```

Configure the private service to require the bare token in `local-llm-upstream-key` as an HTTP Bearer credential. The worker will inject it; external clients never receive it.

## 3. Validate and review

```bash
npx @lazyingart/lazyedge validate --config ./lazyedge.yaml
npx @lazyingart/lazyedge plan --config ./lazyedge.yaml
```

`validate` checks the versioned manifest contract and its security invariants. The shipped JSON Schema is a machine-readable editor/tooling companion; the CLI's normalizer is authoritative for cross-field invariants such as unique listeners and compatibility-service selection. `plan` describes intended artifacts/actions. Run `doctor` only after the relevant role is started; a split edge cannot satisfy worker-local probes, and a private worker cannot satisfy edge-local probes.

Review generated artifacts before any installation step:

```bash
npx @lazyingart/lazyedge render caddy --config ./lazyedge.yaml
npx @lazyingart/lazyedge render openssh --config ./lazyedge.yaml \
  --identity-file "$HOME/.config/lazyedge/ssh/id_ed25519" \
  --known-hosts-file "$HOME/.config/lazyedge/ssh/known_hosts"
npx @lazyingart/lazyedge render accounts --config ./lazyedge.yaml \
  --public-key-file "$HOME/.config/lazyedge/ssh/id_ed25519.pub"
npx @lazyingart/lazyedge render systemd --config ./lazyedge.yaml
```

The default Caddy rendering uses Automatic HTTPS. If—and only if—the edge already has Certbot-managed files at the expected `/etc/letsencrypt/live/<host>/` locations, render that alternative with:

```bash
npx @lazyingart/lazyedge render caddy \
  --config ./lazyedge.yaml \
  --manual-certificates
```

The public-key file must contain the dedicated worker tunnel's Ed25519 public key and must not be group/world writable. The identity path is the matching private key on the worker; only the path enters rendered SSH configuration, never the key contents. Build `known_hosts` after verifying the edge host key through an independent channel.

Without `--component`, `render systemd` emits a labeled multi-section review bundle. Use `--component edge`, `worker`, `tunnel`, `caddy`, `redirect`, or `certbot` to render one section at a time after the complete bundle has been reviewed. The root-only `redirect` component is a manual persistence artifact for an already reviewed port cutover; rendering it neither changes nor authorizes firewall state.

Generated units do not install the CLI. Install the reviewed package first and render each unit with the executable, manifest, bindings, and Node.js paths that will actually exist on that host. Resolve an exact version, pack it once, verify the tarball, and install those same bytes into an immutable checksum-named prefix on each role. Do not use `latest` or a moving global launcher for a service unit. A user-prefix/NVM worker can use this pattern after replacing the expected checksum with the reviewed value:

```bash
LAZYEDGE_VERSION=0.3.0
LAZYEDGE_STAGE=$(mktemp -d)
npm pack "@lazyingart/lazyedge@$LAZYEDGE_VERSION" \
  --pack-destination "$LAZYEDGE_STAGE"
LAZYEDGE_PACKAGE="$LAZYEDGE_STAGE/lazyingart-lazyedge-$LAZYEDGE_VERSION.tgz"
LAZYEDGE_SHA256=$(sha256sum "$LAZYEDGE_PACKAGE" | awk '{print $1}')
test "$LAZYEDGE_SHA256" = "REPLACE_WITH_REVIEWED_SHA256"
LAZYEDGE_RELEASE="$HOME/.local/lib/lazyedge/releases/$LAZYEDGE_VERSION-$LAZYEDGE_SHA256"
npm install --global --ignore-scripts --prefix "$LAZYEDGE_RELEASE" \
  "$LAZYEDGE_PACKAGE"
LAZYEDGE_NODE_BIN=$(dirname "$(command -v node)")

"$LAZYEDGE_RELEASE/bin/lazyedge" render systemd \
  --config "$HOME/.config/lazyedge/lazyedge.yaml" \
  --component worker \
  --executable "$LAZYEDGE_RELEASE/bin/lazyedge" \
  --manifest-path "$HOME/.config/lazyedge/lazyedge.yaml" \
  --bindings-path "$HOME/.config/lazyedge/bindings.worker.yaml" \
  --environment-file "$HOME/.config/lazyedge/worker.env" \
  --runtime-path "$LAZYEDGE_NODE_BIN:$LAZYEDGE_RELEASE/bin:/usr/local/bin:/usr/bin" \
  --after-unit localllm-api.service

"$LAZYEDGE_RELEASE/bin/lazyedge" render systemd \
  --config "$HOME/.config/lazyedge/lazyedge.yaml" \
  --component tunnel \
  --ssh-config-path "$HOME/.config/lazyedge/ssh/config" \
  --ssh-alias lazyedge-edge \
  --worker-unit lazyedge-worker.service
```

Keep the tarball until both roles have been installed and their complete file
lists verified. Record the version, SHA-256, registry integrity and immutable
paths in the deployment revision; upgrades install a new release directory
rather than mutating this one.

The worker's `--runtime-path` must contain the exact Node.js 20+ binary directory used by the CLI. `--after-unit` expresses a reviewed local-upstream dependency; omit it when no matching user unit exists. Edge installations use the same `--executable`, `--manifest-path`, `--bindings-path`, `--environment-file`, and `--runtime-path` options with `--component edge`, and should also point directly into a checksum-named release. These flags write only unit text; they do not install packages or units.

Confirm:

- Caddy contains only intended domains and loopback upstreams;
- `ssh -R` uses an explicit `127.0.0.1:PORT:127.0.0.1:PORT` mapping;
- the account bootstrap authorizes only the supplied public key and exact `permitlisten` ports;
- SSH host-key checking remains enabled;
- service units reference external credential files and no command-line secrets;
- existing Caddy sites are preserved;
- a rollback target is recorded.

## 4. Start a local rehearsal

For a deliberately co-located rehearsal, copy the two templates to separate owner-only files in a private scratch directory and adjust their referenced paths to the rehearsal stores. The edge file must contain only relay + client-token-store paths; the worker file must contain only relay + upstream-key paths. Use separate terminals to inspect and run the guards:

```bash
npx @lazyingart/lazyedge serve --help
npx @lazyingart/lazyedge serve worker \
  --config ./lazyedge.yaml \
  --bindings "$HOME/.config/lazyedge/rehearsal/bindings.worker.yaml"
npx @lazyingart/lazyedge serve edge \
  --config ./lazyedge.yaml \
  --bindings "$HOME/.config/lazyedge/rehearsal/bindings.edge.yaml"
```

A complete rehearsal requires both role-specific files and all three credential boundaries. Each runtime dereferences only the credentials needed for its role. Probe one allowed request and at least one missing token, invalid token, forbidden method, forbidden path, oversized body, and concurrency rejection.

Run diagnostics on the machine that owns each role:

```bash
# On the public edge, after the gateway and reverse listener are up:
npx @lazyingart/lazyedge doctor \
  --config ./lazyedge.yaml \
  --role edge

# On the private worker, after the guard and private upstream are up:
npx @lazyingart/lazyedge doctor \
  --config ./lazyedge.yaml \
  --role worker
```

Use `--role all` only for a deliberately co-located rehearsal where both sets of loopback listeners genuinely exist. `doctor` is read-only and a failed check is evidence to diagnose, not permission to weaken a boundary.

## 5. Deploy deliberately

Version `0.3` does not implement remote `apply`, `rollback`, `uninstall`, or `status`. The render commands write artifacts to standard output for review. Save them to a protected staging directory, validate them with their native tools, and install them manually following [operations](operations.md). The `accounts` output is a bootstrap script: inspect every line and run it only through an authorized administrator session.

Never pipe a downloaded script to a shell, never let LazyEdge replace an unrelated site, and never expose a reverse listener on a wildcard address. Keep the previous native configuration as the rollback target.

If the edge already redirects public ports 80/443 to another application, first verify its exact current targets. The following commands only print reviewable scripts; replace the example previous ports with the observed values and render both directions before any administrator runs either artifact:

```bash
npx @lazyingart/lazyedge render redirect-helper \
  --config ./lazyedge.yaml
npx @lazyingart/lazyedge render nat \
  --config ./lazyedge.yaml \
  --direction apply \
  --previous-http-port 8080 \
  --previous-https-port 8443
npx @lazyingart/lazyedge render nat \
  --config ./lazyedge.yaml \
  --direction rollback \
  --previous-http-port 8080 \
  --previous-https-port 8443
```

The apply rules and persistent helper use an exact ownership-comment token derived from the normalized manifest digest. A different manifest—or a longer comment that merely contains the token—cannot silently claim those rules. The nft transaction rejects extra rule predicates/comments and preserves the presence of anonymous counters, but replacement resets their packet/byte values. The persistent helper reads and changes the native nftables ruleset directly, so it remains convergent after a native nft replacement has made `iptables-save` unable to serialize that table. Missing `ip nat` base chains and all missing rules are created in one checked nft transaction. Existing incompatible or competing IPv4 NAT base chains are rejected. Within the managed chains, the helper permits its four exact rules and only simple numeric TCP/UDP destination-port rules it can prove do not match 80 or 443; overlapping sets/ranges and unknown control flow, named sets, or maps fail closed before mutation. Its systemd unit provides a private runtime directory for the lock and checked nft batch files even under `ProtectSystem=strict`.

Stopping or disabling the rendered redirect service leaves live NAT unchanged. The helper's explicit `stop` action removes exact owned rules but does not restore the previous ports, so run the reviewed nft rollback first unless ingress is deliberately being taken offline. Read the full transactional cutover and counter-reset contract in [operations](operations.md).

On an edge with a preserved site, redirect startup probes that site's high HTTPS port with local resolution and no ambient proxy, so its valid certificate must already be staged. On a fresh Automatic HTTPS edge, it instead probes the managed host on the high HTTP port so certificate issuance is not blocked waiting for the redirect itself. A successful public TLS/SNI probe is still required immediately after cutover.

Test through a temporary hostname or explicit resolver override before changing production DNS. Follow the [migration runbook](migration.md) for a second edge or provider move.

## Next steps

- Understand every field in [configuration](configuration.md).
- Review the [threat model](security.md).
- Connect [OpenAI-compatible clients](integrations/openai-compatible-clients.md).
- Learn the boundaries in [architecture](architecture.md).
