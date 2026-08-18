# LazyEdge Repository Guidelines

## Mission

LazyEdge is a small, auditable edge control plane for exposing explicitly approved services from private workers through a public cloud gateway. It uses proven transports (OpenSSH first), a default-deny HTTP gateway/worker guard, and generated Caddy/systemd configuration.

## Safety invariants

- Never expose a raw worker port, wildcard target, management API, browser profile, CDP/noVNC endpoint, or arbitrary TCP destination.
- Cloud reverse listeners bind to `127.0.0.1` only.
- Public routes are exact host + method + path contracts and default deny.
- External client credentials and internal relay/upstream credentials are separate.
- Never place passwords, tokens, cookies, private keys, raw private inventories, or provider sessions in Git, npm packages, logs, argv, examples, or tests.
- Spawn commands with argument arrays. Do not construct shell command strings from manifest values.
- Keep EchoMind, BLOG, LocalLLM, and other projects outside this repository; integrate only through declared loopback endpoints.
- Production changes require validation, health probes, an exact rollback target, and preservation of unrelated services.

## Project conventions

- Node.js 20+ ESM, small dependency surface, built-in `node:test`.
- Source is under `src/`; the executable is `bin/lazyedge.mjs`.
- Public documentation is under `docs/` and translated repository summaries under `i18n/`.
- `references/private/` is ignored and excluded from npm. Store only secret-free, machine-specific teaching notes there.
- Tests must cover negative security behavior as well as successful paths.
- Use atomic same-directory writes for state/config output and restrictive modes for private files.

## Verification

Run before commit or publish:

```bash
npm test
npm run check
npm run pack:dry-run
git diff --check
```

Inspect the npm pack file list and block release if it contains any private reference, `.env`, key, token, log, cache, or runtime state.
