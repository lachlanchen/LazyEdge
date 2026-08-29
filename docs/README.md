# LazyEdge documentation

Start with the [quickstart](quickstart.md), then read the [architecture](architecture.md) and [security model](security.md) before connecting a real service.

| Guide | Purpose |
| --- | --- |
| [Quickstart](quickstart.md) | Create, validate, render, and inspect a minimal project |
| [Configuration](configuration.md) | Understand the manifest and secret stores |
| [Architecture](architecture.md) | Follow a request from the public edge to a private worker |
| [Security](security.md) | Threat model, invariants, credentials, and limitations |
| [Private service listeners](private-service-listeners.md) | Authenticated application-neutral cloud-local ingress without DNS or Caddy exposure |
| [Rollout safety](rollout-safety.md) | Embed the read-only contract, durable journal, and one-shot stop authority without giving LazyEdge deployment ownership |
| [Operations](operations.md) | Install, observe, rotate, update, and roll back |
| [Upgrade v0.2 to v0.3](upgrading-v0.2-to-v0.3.md) | Separate legacy private chat from transport without losing rollback or external application routes |
| [v0.4.0 release notes](releases/v0.4.0.md) | Add read-only rollout contracts, durable journals, and one-shot stop authority without adding a deployment executor |
| [v0.3.1 release notes](releases/v0.3.1.md) | Add opt-in, release-bound LocalLLM node admission without adding fleet ownership |
| [v0.3.0 release notes](releases/v0.3.0.md) | Review the breaking application split, private-listener contract, and release boundaries |
| [Migration](migration.md) | Move or duplicate an edge without moving private compute |
| [OpenAI-compatible clients](integrations/openai-compatible-clients.md) | Keep inference private behind an exact, authenticated HTTPS contract |
| [Troubleshooting](troubleshooting.md) | Diagnose DNS, TLS, tunnel, guard, and upstream failures |
| [Concepts at scale](concepts-at-scale.md) | Learn how LazyEdge relates to load balancers, overlays, Kubernetes, and service meshes |

Public, reusable material belongs in `docs/`. Machine-specific notes belong in ignored `references/private/`; that directory is excluded from npm and must remain secret-free. Put live secrets only in owner-readable runtime files or a service credential store.
