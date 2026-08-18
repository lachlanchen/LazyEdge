# Private LocalLLM chat

LazyEdge can serve an optional, responsive browser chat at the same hostname as a
`localllm-openai` API. It is disabled unless the service has a `chat` block. The
browser never receives an API token, raw model identifier, LocalLLM management
route, or Ollama endpoint.

## Request boundaries

The browser path is intentionally different from the public Bearer API path:

```text
browser → HTTPS Caddy → 127.0.0.1:17610 chat BFF
                         ↓ server-held, narrowly scoped client token
                 127.0.0.1:18080 compatibility listener
                         ↓ existing relay / tunnel / worker guards
                    private LocalLLM /v1 API
```

Caddy sends only exact document, asset, session, model, login, logout, and
completion paths to the chat BFF. It removes an incoming `Authorization` header
on those routes. The `/v1` API continues to go to the ordinary edge guard with
Bearer authentication; Caddy removes browser cookies on that path. `/api`, the
LocalLLM Studio UI, Ollama, CDP, VNC, noVNC, tools, image inputs, and remote URL
content are not chat routes.

The BFF reserializes a small text-only `{model, messages}` request and forces
streaming. It parses the upstream event stream and re-emits only bounded text
deltas plus the completion marker; upstream model names, usage objects, and
other metadata never cross the browser boundary. Browser-facing model IDs are
stable `deep`, `fast`, and `code` aliases. The operator maps those aliases to
stable LocalLLM aliases; raw artifact names are not returned to the browser.
`Deep` is selected by default. `Max` is deliberately not a default choice
because its resource cost may be unsafe on a shared worker.

## Manifest

The service must use `profile: localllm-openai`, declare `GET /v1/models` and
`POST /v1/chat/completions`, and own the manifest's compatibility listener:

```yaml
spec:
  edge:
    gatewayListen: 127.0.0.1:17600
    compatibilityListen: 127.0.0.1:18080
    compatibilityService: local-llm
  services:
    - id: local-llm
      profile: localllm-openai
      domains: [llm.example.com]
      # edge, worker, and public fields omitted here
      chat:
        listen: 127.0.0.1:17610
        username: operator
        defaultModel: deep
        maxBodyBytes: 262144
        models:
          deep: localllm-deep
          fast: localllm-fast
          code: localllm-code
```

See the complete secret-free [chat overlay example](../examples/local-llm/lazyedge.chat-overlay.example.yaml).

`listen` defaults to exact loopback `127.0.0.1:17610`. The username is
non-secret manifest data. Passwords and API capabilities never belong in the
manifest. A chat service has exactly one public domain so the compatibility
listener's token-host scope is unambiguous.

## Create owner credentials

The safest first-run helper generates a random 256-bit password and two new
owner-only files. It prints only paths and the hash algorithm:

```bash
lazyedge chat create-credentials \
  --username operator \
  --credentials-out /private/operator-chat-login.json \
  --hash-out /private/local-llm-chat-password-hash
```

The JSON file contains the only recoverable username/password copy. Keep it on
the owner's machine or in an encrypted password vault/private sync location;
never install it on the server, commit it, attach it to a ticket, or place it in
`references/private/`. Install only the salted scrypt verifier on the edge.

To use an existing password, put only that password in a temporary owner-only
file and hash it without an argv secret:

```bash
lazyedge chat hash-password \
  --password-file /private/password.input \
  --out /private/local-llm-chat-password-hash
```

`--password-file -` also reads standard input, but a protected file or hidden
password-manager pipe is preferable to a terminal that echoes input. The record
uses scrypt `N=131072,r=8,p=1`, a random 32-byte salt, and a 32-byte verifier.

## Issue the BFF's least-privilege token

Run the chat-specific issuer as the owner of the existing edge token store. It
derives and verifies every scope axis from the reviewed chat manifest. The raw
token is written only to the requested mode-`0600` file; the store retains its
digest:

```bash
lazyedge chat issue-client-token \
  --config /etc/lazyedge-chat/lazyedge.yaml \
  --service local-llm \
  --store /var/lib/lazyedge/tokens/local-llm-users.json \
  --days 30 \
  --out /private/local-llm-chat-client-token
```

The command's JSON output contains the record ID and exact service, host,
method, and path scope but never the raw token. Retain that metadata as the
revocation receipt and compare it with the manifest before installation. Do not
substitute the generic token issuer without independently verifying all four
scope axes. Rotate this capability independently from browser credentials,
relay credentials, and the private upstream key.

## Dedicated runtime

The rendered `lazyedge-chat.service` runs as the separate `lazyedge-chat`
account. It uses systemd `LoadCredential` to receive only the password verifier
and BFF client token at runtime, and it cannot read `/etc/lazyedge`, the edge
token store, LazyEdge logs, or the worker's credentials. Its default files are:

```text
/etc/lazyedge-chat/
├── lazyedge.yaml                              root:lazyedge-chat 0640
└── secrets/                                   root:root 0700
    ├── local-llm-chat-password-hash           root:root 0600
    └── local-llm-chat-client-token            root:root 0600
```

Render only the dedicated component when adding chat to an existing edge:

```bash
lazyedge render systemd \
  --config /etc/lazyedge-chat/lazyedge.yaml \
  --component chat
```

The unit applies loopback-only network policy, a 512 MiB memory limit, a 64-task
limit, a 1024-file-descriptor limit, and process/filesystem isolation. Validate
the rendered unit with the target host's `systemd-analyze verify` before
installation.

## Existing deployment: immutable overlay rule

Adding `chat` changes the normalized manifest digest. On a live edge whose nft
redirect ownership tag, edge unit, and rollback record were created from an
older digest, **do not overwrite the primary `/etc/lazyedge/lazyedge.yaml` and do
not render or apply NAT/redirect artifacts from the chat manifest**.

Instead:

1. copy the exact primary manifest to `/etc/lazyedge-chat/lazyedge.yaml`;
2. add only the reviewed `chat` block to that copy;
3. record both the unchanged primary digest and the new chat-overlay digest;
4. use the overlay only for `render caddy`, `render systemd --component chat`,
   and `serve chat`;
5. leave the existing edge, worker, tunnel, redirect unit, nft ownership tag,
   and rollback artifacts on the primary manifest;
6. perform a separate, explicit ownership migration if those components should
   ever adopt the overlay digest.

A brand-new deployment may use one reviewed manifest for all components. The
overlay rule is specifically what prevents an optional UI upgrade from silently
changing live firewall ownership.

## Transactional installation and rollback

Treat the chat UI as a separate immutable release and Caddy reload, not as an
edge/firewall upgrade:

1. Record the current LazyEdge release symlink, Caddyfile digest, Caddy unit,
   running service PIDs, primary manifest digest, and exact nft ownership tag.
2. Pack and test the exact Git release, install it under a new digest-named
   release directory, and verify `lazyedge --version` there before changing the
   current symlink. Never build from a dirty tree.
3. Create the `lazyedge-chat` system account with a nologin shell. Install
   `/etc/lazyedge-chat` as `root:lazyedge-chat 0750`, its `secrets` directory as
   `root:root 0700`, the reviewed overlay as `root:lazyedge-chat 0640`, and only
   the verifier and derived-scope client token as `root:root 0600` regular
   non-symlink files.
4. Render the chat unit and candidate Caddyfile from the same release and
   overlay. Validate them on the target with `systemd-analyze verify` and
   `caddy validate` before installation.
5. Start (but do not enable) `lazyedge-chat.service`; confirm its listener is
   exactly loopback and test unauthenticated login/session behavior through the
   local high-port Caddy path.
6. Back up the current Caddyfile, install the validated candidate atomically,
   and use the existing Unix admin socket to reload Caddy. Do not restart
   EchoMind, change DNS/certificates, or touch nft/redirect ownership.
7. Run the full browser/API acceptance matrix below. Enable the chat unit only
   after it passes, then record release/config/unit digests and the token record
   ID in the private handoff (never its raw value).

Chat-only rollback is intentionally small: restore the exact previous
Caddyfile and reload it, stop and disable `lazyedge-chat.service`, restore the
previous release symlink, revoke the recorded chat client token ID, and retain
the failed artifacts for diagnosis. Confirm the old landing/API behavior,
unchanged EchoMind PID/release, and unchanged nft rules afterward. The redirect
helper's `stop` action is not a chat rollback and must not be used here.

## Browser security and storage

- The session cookie is opaque, `Secure`, `HttpOnly`, `SameSite=Strict`, and
  `Path=/`; the server stores only its SHA-256 digest in memory.
- Sessions are lost on restart/logout, limited to four, idle-expire after one
  hour, and absolutely expire after eight hours. Logout, eviction, and expiry
  also abort model streams owned by that session.
- Authenticated POSTs require exact HTTPS Origin, Fetch Metadata, and a CSRF
  header/cookie value bound to the session by digest.
- Password verification is globally single-flight and rate limited per Caddy-
  asserted client address to bound scrypt CPU/memory pressure without letting
  one Internet address lock out another. Caddy overwrites the internal address
  header, and the loopback-only BFF rejects login requests that lack it.
- Security headers include a same-origin CSP, HSTS, frame denial, no-sniff,
  restrictive permissions policy, and no-store caching.
- Conversation history is stored only in that browser's `localStorage`. The BFF
  does not persist messages. Clear site data to remove browser history.
- The assets contain no external CDN, analytics, telemetry, inline script,
  dynamic HTML sink, or third-party font.

Acceptance must cover correct and incorrect login, session expiry/logout,
Origin/Fetch/CSRF rejection, body limits, unknown methods/routes/hosts, model
alias filtering, SSE cancellation, missing/wrong/revoked BFF tokens, blocked
direct chat and compatibility ports, unchanged `/v1` Bearer behavior, and
continued denial of `/api` and management surfaces.
