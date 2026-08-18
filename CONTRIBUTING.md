# Contributing to LazyEdge

LazyEdge sits on a security boundary. Small, reviewable changes and negative tests are more valuable than a large feature surface.

## Development

Use Node.js 20 or newer. Fork the repository, create a focused branch, and run:

```bash
npm ci
npm test
npm run check
npm run pack:dry-run
git diff --check
```

Inspect the dry-run package file list. It must not contain credentials, private references, runtime state, logs, browser profiles, `.env` files, keys, or caches.

## npm releases and recovery

Run the release helper only from a clean `main` source checkout, never from an installed package:

```bash
npm run release:npm:dry-run
npm run release:npm -- patch
```

The helper commits and tags locally, publishes, verifies the exact registry version through a temporary global install, and pushes only after verification succeeds. If authentication, publication, verification, or the final push fails after the `Release vX.Y.Z` commit and `vX.Y.Z` tag exist, retain that checkpoint and resume it without another version bump, commit, or tag:

```bash
npm run publish:npm:current
```

Recovery refuses a dirty tree, a non-`main` branch, a mismatched package lock, a tag that does not point at `HEAD`, or a `HEAD` subject other than the exact release message. If npm already contains that version, recovery skips republishing and continues exact install verification and the pending push.

This local helper is the canonical release path unless the maintainers have
explicitly configured npm trusted publishing for this repository. Manual
dispatch of `.github/workflows/publish.yml` validates only and can never
publish. A stable GitHub Release may publish through trusted OIDC only when its
tag, commit, package lock, and `CITATION.cff` all match and the version is still
unpublished. Never publish a GitHub Release for a version already sent by the
local helper; that workflow will fail closed rather than republish it.

## Packed CLI and user services

A prefix install places the executable below that exact prefix; generated units do not discover or guess it. The CLI uses `#!/usr/bin/env node`, so a systemd unit must also receive a `PATH` containing the Node.js 20+ installation. For an NVM-backed user install, render the worker with concrete paths and its upstream dependency:

```bash
LAZYEDGE_BIN=$(command -v lazyedge)
NODE_BIN_DIR=$(dirname "$(command -v node)")

lazyedge render systemd \
  --config "$HOME/.config/lazyedge/lazyedge.yaml" \
  --component worker \
  --executable "$LAZYEDGE_BIN" \
  --manifest-path "$HOME/.config/lazyedge/lazyedge.yaml" \
  --bindings-path "$HOME/.config/lazyedge/bindings.worker.yaml" \
  --environment-file "$HOME/.config/lazyedge/worker.env" \
  --runtime-path "$NODE_BIN_DIR:$HOME/.local/bin:/usr/bin" \
  --after-unit localllm-api.service
```

The edge unit must similarly name its actual executable and `bindings.edge.yaml`. Never point either role at the other role's bindings file.

## Security invariants

Every change must preserve these rules:

- reverse listeners on the cloud host bind to `127.0.0.1`;
- routes are exact host + method + path contracts and default deny;
- arbitrary destination hosts, wildcard ports, management APIs, CDP, VNC, and noVNC are never exposed;
- external client credentials and internal upstream credentials remain separate;
- manifests are data, not shell programs—spawn commands with argument arrays;
- secrets never enter Git, npm, command-line arguments, generated examples, or test snapshots.

Add tests for both allowed behavior and the closest forbidden behavior. A feature that weakens these invariants needs a design discussion before code.

## Pull requests

Explain the threat being addressed, the user-visible behavior, rollback considerations, and tests. Keep generated or machine-specific material out of commits. Public, reusable guidance belongs in `docs/`; private deployment notes belong in ignored `references/private/` and must still be secret-free.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
