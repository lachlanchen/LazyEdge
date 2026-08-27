# Troubleshooting

Diagnose from the public boundary inward. Do not restart unrelated services or weaken security controls merely to see whether an error disappears.

On split deployments, run `lazyedge doctor --role edge` only on the cloud gateway and `lazyedge doctor --role worker` only on the private worker. Running the default `all` role on either half reports expected missing listeners and obscures the failing boundary.

## Fast boundary map

| Symptom | First check | Likely boundary |
| --- | --- | --- |
| hostname not found/wrong IP | authoritative DNS and local cache | DNS |
| certificate or HTTPS failure | ports 80/443, Caddy logs/config | TLS/edge |
| 401 | external token set and Authorization scheme | edge auth |
| 403/404/405 | exact host/path/method contract | route guard |
| 413 | `maxBodyBytes` and client payload | edge/worker limits |
| 429/503 under load | concurrency limit and upstream capacity | admission/upstream |
| 502/504 | loopback reverse listener, tunnel, worker, timeout | transport/upstream |
| connection works locally but not publicly | Caddy site/upstream and firewall | edge routing |

## DNS and TLS

Confirm the hostname resolves to the intended edge from more than one resolver. Verify system time. Ensure Caddy—not a stale process—owns the intended HTTP/HTTPS ports and that an existing site was not replaced. Review [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) and [global HTTP/HTTPS port options](https://caddyserver.com/docs/caddyfile/options) before using nonstandard ports.

Do not disable certificate validation. A resolver override is safer for pre-cutover testing than pretending a bad certificate is acceptable.

## Tunnel

On the edge, inspect the expected listener. It must be on `127.0.0.1`, not a wildcard address. On the worker, inspect the supervised SSH process and its recent logs. `ExitOnForwardFailure` catches initial bind failures; worker-side `ServerAliveInterval`/`ServerAliveCountMax` detect a dead edge, and the generated edge-side `ClientAliveInterval`/`ClientAliveCountMax` policy detects a dead worker and releases its reverse listeners. See [`ssh_config(5)`](https://man.openbsd.org/ssh_config.5) and [`sshd_config(5)`](https://man.openbsd.org/sshd_config).

Common causes are a port already in use, an unauthorized key, a changed host key, `AllowTcpForwarding`/`PermitListen` restrictions, DNS failure, or a supervisor repeatedly starting duplicate tunnels. Do not set `StrictHostKeyChecking=no` as a repair.

The rendered user tunnel retries indefinitely with a 15-second delay. If an
older unit exhausted systemd's start limit during a long outage, first prove
that no duplicate SSH process or remote listener exists, then use the user
manager's `reset-failed` and `start` actions for that exact LazyEdge unit. Do
not treat repeated bind failure as permission to kill an unknown listener. A
gateway rendered with the current account policy should remove an unreachable
tunnel user's orphaned listener after roughly 45 seconds; if the listener
persists longer, verify the effective per-user `sshd` configuration before any
targeted recovery.

## Guards and credentials

Test one invalid token and one forbidden method deliberately. If either succeeds, stop exposure and inspect the loaded manifest before testing anything else.

A valid external token is intentionally invalid at the worker boundary. A valid relay token is intentionally different from any upstream token. Rotate only the failed boundary; do not collapse all three into one credential.

## Upstream

Probe the worker guard locally, then the private service locally. Confirm target scheme, address, health path, request size, concurrency, streaming, and timeout. An OpenAI-compatible client may require a base URL ending in `/v1`, while the manifest route contains the complete public path.

Do not expose the private port temporarily for diagnosis. Use loopback probes or an SSH session administered outside LazyEdge.

## Service supervision

If a user service stops after logout, verify whether the administrator intended to enable systemd lingering; see [`loginctl`](https://www.freedesktop.org/software/systemd/man/252/loginctl.html). If two units fight over a port, identify ownership and stop only the superseded LazyEdge-owned unit.

## Safe support bundle

Share versions, manifest schema/version, redacted service IDs, a manifest digest, bound addresses, exit codes, and sanitized error text. Do not share tokens, keys, `Authorization` headers, cookies, request bodies, browser profiles, raw inventories, or the contents of a secret store.

Machine-specific investigation notes may go in ignored `references/private/`, but that directory is plaintext and must remain secret-free.
