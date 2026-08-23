# Security policy

LazyEdge is an early-stage security-sensitive project. Only the latest published release line receives fixes while the interface is experimental. An unreleased branch or pull request is not a supported release; consult the GitHub and npm release metadata before deploying.

## Report a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/lachlanchen/LazyEdge/security/advisories/new). Do not include live tokens, private keys, cookies, complete private inventories, or production request bodies. Replace them with redacted reproductions.

If a credential may have been disclosed, revoke or rotate it immediately; a software fix cannot make an exposed credential secret again.

## Security boundaries

LazyEdge reduces accidental exposure, but it does not replace host patching, firewalling, least-privilege accounts, TLS, upstream authentication, backups, or monitoring. The project assumes the public gateway and private worker are administered systems. A compromise of either host, its account, SSH keys, or an explicitly configured upstream can exceed LazyEdge's protection.

Read the full [threat model](docs/security.md) before deploying.
