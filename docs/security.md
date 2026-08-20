# Security and threat model

LazyEdge is a narrow gateway, not a promise that an Internet-connected host is risk-free. Read this document as a deployment checklist and as the boundary of what the project intends to protect.

## Privacy promise

> **LazyEdge does not send telemetry, discover services, or expose an undeclared target. Only routes explicitly declared in the manifest can be generated. Request content travels only through the gateway and worker endpoints you configure, and LazyEdge does not persist request bodies.**

This promise covers LazyEdge itself. Your reverse proxy, system journal, upstream service, cloud provider, or client may log data according to its own configuration. Audit those components and minimize metadata; never log Authorization values or request bodies by default.

## Assets

- external client tokens;
- SSH private keys and authorized-key restrictions;
- internal relay tokens;
- private upstream tokens;
- request content and response content;
- configuration, logs, hostnames, and private topology;
- availability of the public edge and private worker.

External, relay, and upstream credentials are separate on purpose. A credential valid at one boundary must not silently become valid at another.

The optional browser chat adds three more deliberately narrow assets: a salted password verifier, a BFF client token scoped to one service, host, `GET`/`POST`, and the two required `/v1` paths, and an independent remembered-session secret. The recoverable browser password remains owner-side; the edge receives only its scrypt verifier. The BFF runs as `lazyedge-chat`, not the edge or tunnel account, and receives its runtime files through systemd credentials.

## Assumed trust

The operator controls and patches the gateway and worker. DNS points to the intended edge. TLS clients validate certificates. The local upstream is either trusted or has its own authentication. An attacker may reach ports 80/443, guess paths, replay stolen tokens, send large or slow requests, and inspect public repository/package content.

LazyEdge cannot contain a fully compromised gateway, worker, root account, SSH key, or upstream application. It also does not provide distributed denial-of-service absorption, a web application firewall, secret rotation service, or end-user identity portal.

## Controls

| Threat | Control |
| --- | --- |
| Direct access to reverse port | remote listener binds to `127.0.0.1`; firewall remains default deny |
| Accidental new endpoint | exact domain + method + path allowlist; default deny at both guards |
| Client token reaches worker/upstream | edge strips it and injects a distinct relay credential |
| Relay token reaches application | worker strips it and injects a distinct required upstream credential |
| Token in Git/npm/process list | secret stores are outside the manifest; no secrets in argv, examples, logs, or package |
| One host reads every credential | edge and worker use separate bindings; each runtime opens only its role's stores |
| Tunnel command injection | manifest values become validated argument arrays, never shell fragments |
| Resource exhaustion | per-service body and concurrency limits; provider/firewall rate controls remain advisable |
| Stale authorization | named token sets support issue/list/revoke and deliberate rotation |
| Silent config drift | validate, plan, render, manifest digest, health probe, and exact rollback target |

Bearer tokens grant access to whoever possesses them. Send them only over TLS, never in URLs, and store them as secrets. These rules follow the security considerations in [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750).

## SSH hardening

Use a dedicated unprivileged account and a dedicated key for each worker-to-edge relationship. Restrict that key to the forwarding behavior it needs, deny interactive shells where practical, and keep `GatewayPorts no` so remote forwards remain loopback-bound. Review the authoritative [`sshd_config(5)`](https://man.openbsd.org/sshd_config) and [`sshd(8)`](https://man.openbsd.org/sshd.8) manuals for `AllowTcpForwarding`, `PermitListen`, `DisableForwarding`, and authorized-key restrictions supported by your server version.

On the client, `ExitOnForwardFailure`, keepalives, and explicit host-key checking help a supervisor distinguish a live tunnel from a failed setup; see [`ssh_config(5)`](https://man.openbsd.org/ssh_config.5). Never weaken host-key verification to make automation convenient.

The account renderer accepts a dedicated **public** key from a file; never give it a private-key path or paste key material into an argument. The OpenSSH renderer records the worker's private-key and pinned-known-hosts **paths**, not their contents. Keep the private key only on the worker with restrictive permissions, and verify the edge host key out of band before writing `known_hosts`.

## TLS and edge authentication

Caddy's [Automatic HTTPS](https://caddyserver.com/docs/automatic-https) handles ordinary public certificates when DNS and ports are correct. For private administrator routes, Caddy also supports [TLS client authentication](https://caddyserver.com/docs/caddyfile/directives/tls) and delegated [`forward_auth`](https://caddyserver.com/docs/caddyfile/directives/forward_auth). These are optional layers; they do not replace LazyEdge's service token contract.

When reusing existing Certbot-managed certificates, render explicit certificate paths and grant Caddy only the minimum read access (for example through a dedicated certificate-reader group). Never copy certificate private keys into the repository, npm package, staging output, or worker host.

## Secret handling

- Generate high-entropy credentials with a cryptographic random source.
- Keep owner-readable files mode `0600`, directories `0700`, or use the service manager's credential facility.
- Rotate external, relay, upstream, and SSH credentials independently.
- Redact headers before logs leave a process.
- Treat a copied command line, screenshot, shell history, support bundle, and CI artifact as public unless proven otherwise.
- Never place a credential in `lazyedge.yaml`, `references/private/`, Git, npm, or a URL.

`secret import-env` is an optional one-time bridge for an existing private service key. It accepts the environment file path and variable **name**, never the value, requires a regular non-symlink source with no permissions for the Unix `other` class, requires exactly one 32–4096-character whitespace-free capability value, writes a new mode-`0600` destination without overwrite, and does not print the value. Mode `0600` is the safe default; review and retain the source according to the upstream project's own secret policy.

`secret sync-env` is a narrow write helper for a coordinated upstream rotation. It reads a 32–4096-character value containing only environment-safe token characters from a private regular non-symlink file, verifies that the target environment file is also private, regular, non-symlink, and no larger than 64 KiB, then replaces or appends the named assignment through an atomic file rename. It preserves the target's mode and prints only metadata. It does not create a backup, restart or reload the external service, prove that the service consumed the value, disable the old credential, or restore a failed change. The operator must perform those steps using the owning project's runbook; see [upstream-key rotation](operations.md#upstream-key-rotation).

Keep the [edge bindings](../examples/local-llm/bindings.edge.example.yaml) on the gateway and the [worker bindings](../examples/local-llm/bindings.worker.example.yaml) on private compute. The only shared application credential is the relay capability, represented by separate protected files on the two hosts. The upstream key remains worker-only, and the external-client token store remains edge-only.

`references/private/` is ignored and excluded from npm for secret-free machine notes only. It is not a secret vault.

Private chat uses opaque sessions, strict cookies, exact Origin and Fetch Metadata, session-bound CSRF, single-flight/rate-limited scrypt verification, stable model aliases, and text-only HTTP/SSE request reserialization. A normal session is memory-only; an opt-in remembered session persists only keyed session and CSRF digests plus expiry metadata in a protected, dedicated state file—never a password or raw cookie. Browser password saving is a best-effort browser-password-manager operation only; LazyEdge never writes a password to browser storage, its service worker, server state, or logs. Its service worker caches only the exact public app shell, never `/chat/api/*`, `/v1/*`, credentials, conversations, or model responses. Conversation persistence is browser-local and is therefore governed by the security of that browser profile. See the full [private-chat contract](private-chat.md).

## Safe review before exposure

Before opening DNS traffic, verify the rendered Caddy and OpenSSH configuration, confirm every tunnel listener with `ss -ltnp`, test a forbidden method/path/token, test body/concurrency limits, confirm upstream credentials do not appear in responses, and record a rollback target. Do not expose CDP, VNC, noVNC, a raw model API, or an arbitrary port through LazyEdge.
