# LazyEdge documentation

Start with the [quickstart](quickstart.md), then read the [architecture](architecture.md) and [security model](security.md) before connecting a real service.

| Guide | Purpose |
| --- | --- |
| [Quickstart](quickstart.md) | Create, validate, render, and inspect a minimal project |
| [Configuration](configuration.md) | Understand the manifest and secret stores |
| [Architecture](architecture.md) | Follow a request from the public edge to a private worker |
| [Security](security.md) | Threat model, invariants, credentials, and limitations |
| [Operations](operations.md) | Install, observe, rotate, update, and roll back |
| [Migration](migration.md) | Move or duplicate an edge without moving private compute |
| [LocalLLM + AgInTi](integrations/local-llm-aginti.md) | Keep models local while agents use a stable HTTPS endpoint |
| [Troubleshooting](troubleshooting.md) | Diagnose DNS, TLS, tunnel, guard, and upstream failures |
| [Concepts at scale](concepts-at-scale.md) | Learn how LazyEdge relates to load balancers, overlays, Kubernetes, and service meshes |

Public, reusable material belongs in `docs/`. Machine-specific notes belong in ignored `references/private/`; that directory is excluded from npm and must remain secret-free. Put live secrets only in owner-readable runtime files or a service credential store.
