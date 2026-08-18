# Operations

Treat every change as a small deployment: inspect, validate, plan, install, probe, and retain one exact rollback target.

## Before the first deployment

1. Patch the edge and worker, confirm time synchronization, and verify backups.
2. Confirm ports 80/443 are owned by the intended reverse proxy and inventory existing sites before editing Caddy.
3. Create a dedicated edge account and worker key; do not reuse an administrator key.
4. Confirm the private upstream listens only on loopback.
5. Validate the manifest and inspect all rendered files.
6. Test with a temporary hostname or local resolver override before changing production DNS.

The CLI's `doctor` command is a diagnostic aid, not authorization to change unrelated services. LazyEdge must preserve existing Caddy sites and project-owned processes.

## Routine lifecycle

```bash
npx @lazyingart/lazyedge validate --config ./lazyedge.yaml
npx @lazyingart/lazyedge plan --config ./lazyedge.yaml
npx @lazyingart/lazyedge doctor --config ./lazyedge.yaml --role edge
npx @lazyingart/lazyedge doctor --config ./lazyedge.yaml --role worker
```

Run the `edge` doctor on the public gateway and the `worker` doctor on the private compute host. `--role all` is only for a genuinely co-located deployment. Run commands with the exact release you reviewed in production; an unpinned `npx` resolves the current registry version. Version `0.1` does not implement remote `apply`, `rollback`, `uninstall`, or `status`. It renders inspectable native artifacts; an authorized administrator validates and installs them deliberately.

## Coexisting with an existing website

Do not make a shared server's current web application disappear merely to install a gateway. Inventory its exact listeners and TLS behavior first. LazyEdge's `existingSites` entries let generated Caddy configuration retain named sites and proxy them to their existing loopback HTTPS/HTTP ports, including a TLS server name when the local upstream requires it.

A low-risk takeover pattern is:

1. run Caddy and the edge guard on unused unprivileged high ports;
2. validate configuration and test every existing plus new hostname directly;
3. save the exact current firewall/NAT or front-proxy rules as a rollback artifact;
4. switch public 80/443 forwarding transactionally to the validated Caddy ports;
5. probe existing sites first, then the new site, including negative authorization tests;
6. restore the prior rule set immediately if any acceptance check fails.

Changing firewall/NAT ownership is an administrator action. It must not be hidden inside a generic install command in preview software. An alternative is to keep the existing ingress on 80/443 and add one explicit hostname proxy to LazyEdge's loopback gateway.

LazyEdge separates the live one-shot cutover from reboot persistence:

```bash
lazyedge render redirect-helper --config ./lazyedge.yaml
lazyedge render systemd --config ./lazyedge.yaml --component redirect
lazyedge render nat --config ./lazyedge.yaml \
  --direction apply \
  --previous-http-port 8080 \
  --previous-https-port 8443
lazyedge render nat --config ./lazyedge.yaml \
  --direction rollback \
  --previous-http-port 8080 \
  --previous-https-port 8443
```

`render nat` emits bounded nftables transaction scripts. The apply direction expects exactly one current rule for each public/loopback 80/443 mapping, checks the batch, atomically moves them from the explicitly supplied previous ports to the manifest's high ports, and adds an ownership comment derived from the normalized manifest digest. An accepted `PREROUTING` rule contains only the exact TCP destination port, an optional anonymous counter, and the redirect. An accepted `OUTPUT` rule additionally requires the exact `127.0.0.1` destination. Extra predicates or comments are rejected. Rollback selects only the exact ownership-comment token and restores the same destination-policy shape and explicitly supplied previous ports; a comment containing the token as a substring is not ownership.

The scripts retain whether each rule had an anonymous counter expression, in both directions. nft rule replacement resets that counter's packet and byte values, however, because traffic can change them between inspection and replacement and the separately retained rollback artifact cannot reconstruct that history. Treat the cutover as a counter-reset boundary and capture any required accounting evidence before running it. The `8080`/`8443` defaults are conveniences, not discovery; always pass the ports verified from live state.

`render redirect-helper` emits the conflict-detecting native nftables persistence helper; `render systemd --component redirect` emits its root-level unit. The helper deliberately does not inspect through `iptables-save`: replacing an xtables-created rule with native `nft` can remove xtables compatibility metadata, after which `iptables-save` reports that the table is incompatible instead of returning the live rules. The helper reads the complete stateless, numeric nft ruleset with handles, accepts the exact counter/no-counter shapes produced by the cutover, and applies all missing topology and rules in one checked nft transaction. On an empty boot it can create `table ip nat` plus the exact `PREROUTING` and `OUTPUT` NAT base chains. It rejects incompatible expected chains and any other `ip` or `inet` NAT base chain on the IPv4 `prerouting` or `output` hook. Within the two managed chains it accepts its four exact owned redirects and only simple numeric TCP/UDP destination-port rules it can prove are disjoint from both 80 and 443. Overlapping sets/ranges, unconditional or chained control flow, named sets, maps, and every unrecognized expression fail closed before mutation; this conservative policy may require an administrator to coordinate a complex but genuinely disjoint firewall rule. The helper then verifies the final four-rule set. Its desired rules carry the same digest-derived ownership tag, and ownership is an exact comment token rather than a substring. If a manifest change produces a new digest, reconcile or roll back rules owned by the previous digest before enabling the new helper.

The redirect unit—not `/etc/iptables/rules.v4`—is LazyEdge's role-specific reboot persistence artifact. Never refresh `rules.v4` with `iptables-save` after the native cutover: the command may be unable to serialize the table, and redirecting its output can replace a useful file with a diagnostic or incomplete snapshot. Before cutover, inventory package **status**, executables/plugins, native units, and SysV activation links that might restore firewall state. `dpkg-query -W` and `systemctl is-enabled` alone are insufficient: a package in `deinstall ok config-files` state can retain an orphaned `/etc/rcS.d/S*` link even though its runtime and native unit are gone. Archive the existing persistence file to an owner-only revision record and verify its digest. Then choose exactly one branch:

- If `netfilter-persistent`, `iptables-persistent`, `nftables.service`, or another firewall manager owns the file/ruleset, stop and coordinate through that manager. Prepare its candidate from the compatible **pre-cutover** snapshot, review an exact four-rule-only diff, and use the manager's validation path. Do not let two persistence owners race at boot.
- If no functional manager remains, and review proves `/etc/iptables/rules.v4` contains only the superseded redirect state, atomically rename that exact file to a fixed owner-only backup name in the same directory before enabling the LazyEdge unit. A residual `deinstall ok config-files` package state is in this branch only after proving the runtime/plugins/native unit are absent; explicitly neutralize an exact orphaned `S` activation symlink by renaming it to a fixed non-activating backup name. Preserve unrelated `K` shutdown links and configuration. Do not use a glob and do not delete the verified backups. Enable the rendered redirect unit only after the live nft cutover and its public acceptance probes pass; its empty-boot path recreates only the reviewed NAT table/chains/rules.

For the second branch, resolve every path and revision label before running anything. A bounded command sequence is:

```bash
dpkg-query -W \
  -f='${db:Status-Abbrev}\t${binary:Package}\t${Version}\n' \
  netfilter-persistent iptables-persistent nftables || true
command -v netfilter-persistent || true
sudo test ! -x /usr/sbin/netfilter-persistent
sudo systemctl cat netfilter-persistent.service nftables.service || true
sudo test -L /etc/rcS.d/S01netfilter-persistent
test "$(readlink /etc/rcS.d/S01netfilter-persistent)" = \
  ../init.d/netfilter-persistent
sudo test ! -e \
  /var/lib/lazyedge/revisions/REVIEWED_REVISION/rules.v4.pre-lazyedge
sudo install -m 0600 -o root -g root /etc/iptables/rules.v4 \
  /var/lib/lazyedge/revisions/REVIEWED_REVISION/rules.v4.pre-lazyedge
sudo sha256sum \
  /etc/iptables/rules.v4 \
  /var/lib/lazyedge/revisions/REVIEWED_REVISION/rules.v4.pre-lazyedge
sudo cmp --silent \
  /etc/iptables/rules.v4 \
  /var/lib/lazyedge/revisions/REVIEWED_REVISION/rules.v4.pre-lazyedge
sudo test ! -e \
  /etc/rcS.d/netfilter-persistent.disabled-REVIEWED_REVISION
sudo test ! -L \
  /etc/rcS.d/netfilter-persistent.disabled-REVIEWED_REVISION
sudo mv -- \
  /etc/rcS.d/S01netfilter-persistent \
  /etc/rcS.d/netfilter-persistent.disabled-REVIEWED_REVISION
sudo test ! -e \
  /etc/iptables/rules.v4.pre-lazyedge-REVIEWED_REVISION
sudo test ! -L \
  /etc/iptables/rules.v4.pre-lazyedge-REVIEWED_REVISION
sudo mv -- \
  /etc/iptables/rules.v4 \
  /etc/iptables/rules.v4.pre-lazyedge-REVIEWED_REVISION
```

Treat any installed/active owner, executable/plugin/native unit, unexpected activation link, digest mismatch, extra rule, or pre-existing destination as a hard stop. Omit the symlink-renaming lines when that exact residual link is absent; never generalize them to a wildcard. The example is not permission to move an administrator-managed firewall file.

The redirect unit's direct high-port probe bypasses ambient proxies with `--noproxy '*'` and retries a bounded Caddy startup race. A preserved site's probe uses the high HTTPS port, retains local address resolution and TLS/SNI validation, and requires a successful HTTP status. Therefore a preserved-site takeover must stage a valid certificate before enabling this unit; the high-port TLS probe is the bootstrap prerequisite, not a certificate-issuance mechanism. If there is no preserved site, the unit probes the managed host on Caddy's high HTTP port and accepts an authenticated gateway's expected deny status at `/`. The HTTP probe deliberately avoids an Automatic HTTPS bootstrap cycle: on a fresh host Caddy may need public 80/443 routing before it can obtain a certificate. Immediately after cutover, TLS/SNI and the managed host's expected unauthenticated and authenticated statuses remain mandatory acceptance checks; the startup probe is not that acceptance evidence.

Stopping or disabling `lazyedge-port-redirect.service` intentionally leaves the live firewall unchanged: the unit has no `ExecStop`, so an ordinary service lifecycle action cannot silently take public ingress offline. The helper's explicit `stop` action removes only the four exact rules owned by its manifest digest and does **not** restore the previous mappings. Use it only when intentionally taking ingress offline, or after the reviewed nft rollback has already restored the prior mappings. Never use helper `stop` as a substitute for rollback.

The helper submits each start or stop change as one nft transaction, so an ordinary validation or apply failure cannot leave a per-rule partial batch. The unit creates `/run/lazyedge-port-redirect` with mode `0700`; the helper verifies that directory's ownership and mode, serializes operations with an exclusive lock there, writes checked batch files with mode `0600`, and removes them on success, failure, or termination. `ReadWritePaths` keeps this bounded runtime location writable under the unit's `ProtectSystem=strict` sandbox. No shell helper can control a concurrent firewall writer after its preflight or distinguish that writer's intent. Keep other firewall managers quiescent during this bounded operation. The helper is convergent when rerun: `status` rejects partial/conflicting state, while `start` completes an otherwise exact partial owned set. Inspect `status` after any interruption or external firewall change.

All four commands above only write artifacts to standard output. They do not inspect, modify, or authorize the host firewall. Keep apply and rollback outputs together in the owner-only revision record, inspect every line, and run a transaction only after the replacement high-port gateway and preserved site have passed direct probes.

## Service supervision

System services are appropriate on a dedicated gateway. A user service can be useful when sudo is unavailable, provided the administrator explicitly enables lingering so the user's manager survives logout. `loginctl enable-linger USER` is the relevant systemd mechanism; see the official [`loginctl`](https://www.freedesktop.org/software/systemd/man/252/loginctl.html) manual. Enabling it is an administrator decision, not something LazyEdge should silently change.

Give each unit:

- an unprivileged account and restrictive filesystem access;
- a restart policy with a bounded delay;
- explicit configuration and credential paths;
- startup ordering on the network, without assuming DNS is instantly ready;
- logs that exclude Authorization headers and request bodies;
- a health probe that checks the intended boundary.

Only the private worker owns and restarts its tunnel. The edge must not start a second tunnel for the same listener while the first is active.

The renderers default to `/usr/local/bin/lazyedge` and the documented role-specific bindings paths. If npm was installed under a user prefix or Node.js comes from NVM, render the worker with explicit `--executable` and `--runtime-path` values and verify both paths from the target user manager. Use `--manifest-path`, `--bindings-path`, and `--environment-file` when the reviewed installation layout differs; use worker `--after-unit SERVICE` for a real local-upstream user unit. Tunnel paths are independently configurable with `--ssh-config-path`, `--ssh-alias`, and `--worker-unit`. Never install a unit whose rendered path exists only in the shell that generated it.

## Health checks

Observe boundaries separately:

1. **DNS/TLS:** hostname resolves to the intended edge and presents the intended certificate.
2. **Caddy:** site is loaded and proxies to the edge guard.
3. **edge guard:** health endpoint responds locally; forbidden requests are denied.
4. **tunnel:** the reverse port is listening on `127.0.0.1`, never `0.0.0.0` or `::`.
5. **worker guard:** relay-authenticated health reaches the worker.
6. **upstream:** a minimal representative request succeeds without exposing its private credential.

Health checks should be cheap and disclose no model list, filesystem path, build secret, or private inventory.

## Updating

### Optional chat overlay on an existing edge

Adding a `chat` block changes the manifest digest. If live edge/redirect/nft
ownership was created from the primary manifest, leave that manifest and those
units untouched. Copy it to `/etc/lazyedge-chat/lazyedge.yaml`, add only chat,
record both digests, and use the overlay only to render Caddy and
`lazyedge-chat.service`. Do not render or apply NAT, the redirect helper, or the
edge/worker/tunnel units from the overlay without a separate reviewed ownership
migration. Follow the complete [private-chat overlay procedure](private-chat.md#existing-deployment-immutable-overlay-rule).

1. Read release notes and diff the manifest/schema changes.
2. Back up only the current config, generated units, token metadata, and last-known-good digest—not live tokens in a shared archive.
3. Validate and render with the new version without applying.
4. Test on a spare port or second edge.
5. Apply once, probe allowed and forbidden behavior, and record the verified digest.
6. Stop superseded project-owned processes after evidence is captured.

## Token rotation

Issue a replacement into the same named token set, update the intended client, verify it, then revoke the old token. Relay and upstream credentials require their own coordinated two-sided rotation. Do not paste a token into a ticket, README, shell command argument, or screenshot.

## Upstream-key rotation

`secret sync-env` can atomically copy a proposed upstream key from an owner-protected value file into one named variable in an external service's private environment file. It is a file update, not a service manager or rotation transaction. Use this sequence:

1. Record the owning service and its documented restart, readiness, credential-probe, and rollback procedures. Confirm that the [worker bindings](../examples/local-llm/bindings.worker.example.yaml)—not the edge bindings—reference the proposed value file.
2. Create a protected, restorable backup of the current environment file outside Git, npm, logs, and `references/private/`. Verify that both the backup and proposed value file are regular non-symlink files with owner-only access.
3. Ensure the proposed token is 32–4096 characters drawn only from letters, digits, `.`, `_`, `~`, and `-`. Then update the file without putting the value in an argument or terminal output:

   ```bash
   npx @lazyingart/lazyedge secret sync-env \
     --env-file /absolute/path/to/LocalLLM/.env \
     --name LOCALLLM_API_KEY \
     --value-file "$HOME/.config/lazyedge/secrets/local-llm-upstream-key"
   ```

4. The operator—not LazyEdge—must restart or reload the external service using that project's documented mechanism. LazyEdge neither discovers nor restarts it.
5. Probe through the worker boundary with the new credential and confirm a representative allowed request succeeds. Separately confirm that the old credential is denied; success with both means rotation is incomplete.
6. If the restart or either probe fails, atomically restore the protected backup, restart/reload the owning service again, and verify that the restored credential works while the failed proposed credential is denied.

Do not delete the backup or old key until the acceptance window has passed. Then remove them according to the owning project's secret-retention policy; never archive live tokens in the public documentation tree.

## Rollback

Rollback is a known artifact, not “undo whatever changed.” Keep the immediately previous rendered configuration and package version. Validate the previous files, restore them atomically, reload only the project-owned units/Caddy configuration, probe, and document why the new version was rejected.

If a deployment touched an existing shared Caddyfile, restore the exact prior file and validate before reload. Never stop or overwrite another project's listener to free a port.

## Private handoff notes

Put host aliases, chosen ports, unit names, runtime paths, current digests, and sanitized probe results in `references/private/`. Keep passwords, tokens, keys, cookies, raw inventories, and browser/CDP profiles out of that directory. It is ignored and excluded from npm, but it is still ordinary plaintext on disk.
