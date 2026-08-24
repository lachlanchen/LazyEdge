# Configuration

LazyEdge uses a declarative YAML manifest for non-secret intent and separate, role-specific bindings files for secret locations. The current API is `lazyedge.lazying.art/v1alpha1`; it may change before a stable release.

## Minimal shape

```yaml
apiVersion: lazyedge.lazying.art/v1alpha1
kind: EdgeProject
metadata:
  name: personal-edge
spec:
  edge:
    gatewayListen: 127.0.0.1:17600
  transport:
    provider: openssh-reverse
    sshHost: edge.example.com
    sshUser: lazyedge-tunnel
    sshPort: 22
  services:
    - id: local-llm
      profile: localllm-openai-admission
      domains: [llm.example.com]
      edge:
        upstream: http://127.0.0.1:18008
      worker:
        listen: 127.0.0.1:17800
        target: http://127.0.0.1:8008
        healthPath: /healthz
      public:
        tokenSet: local-llm-users
        maxBodyBytes: 33554432
        maxConcurrentRequests: 2
        idleTimeoutSeconds: 900
        routes:
          - path: /v1/models
            methods: [GET]
          - path: /v1/chat/completions
            methods: [POST]
          - path: /v1/responses
            methods: [POST]
          - path: /v1/embeddings
            methods: [POST]
          - path: /readyz
            methods: [GET]
          - path: /api/node/capabilities
            methods: [GET]
```

See [`examples/local-llm/lazyedge.yaml`](../examples/local-llm/lazyedge.yaml) and the machine-readable [`schemas/lazyedge.schema.json`](../schemas/lazyedge.schema.json).

## Top-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | exactly `lazyedge.lazying.art/v1alpha1` |
| `kind` | yes | exactly `EdgeProject` |
| `metadata.name` | yes | lowercase project identity used in generated names |
| `spec.edge` | yes | public-gateway listeners and coexistence information |
| `spec.transport` | yes | outbound-created transport; v0.3 preview supports `openssh-reverse` |
| `spec.services` | yes | one or more explicit HTTP service contracts |

Unknown keys are rejected rather than silently ignored.

## `spec.edge`

| Field | Meaning |
| --- | --- |
| `gatewayListen` | exact `127.0.0.1:PORT` listener for the edge guard |
| `compatibilityListen` | optional loopback-only adapter for one explicitly selected service used by a cloud-local application; it does not bypass token or route policy |
| `compatibilityService` | service ID used by `compatibilityListen`; inferred only when the manifest has exactly one service and required otherwise |
| `privateListeners[]` | optional bounded application-neutral loopback listeners; each entry selects one unique service and exact listener |
| `privateListeners[].service` | configured `exposure: private` service ID selected at manifest validation time, never by a request or CLI override; public services are rejected |
| `privateListeners[].listen` | exact unique `127.0.0.1:PORT` with canonical decimal `PORT` in 1024–65535; wildcard, privileged/zero/leading-zero ports and collisions are rejected |
| `httpPort` / `httpsPort` | optional unprivileged Caddy ports, both 1024–65535; defaults are `10080` / `10443` |
| `existingSites[]` | sites that generated Caddy output must preserve and forward to existing loopback upstreams |
| `existingSites[].host` | exact DNS hostname |
| `existingSites[].upstream` | HTTP(S) numeric-loopback URL |
| `existingSites[].tlsServerName` | optional TLS server name for an HTTPS loopback upstream |

`existingSites` is declarative coexistence, not automatic discovery. Inventory and verify existing ingress before applying generated output.

## `spec.transport`

| Field | Meaning |
| --- | --- |
| `provider` | exactly `openssh-reverse` in the v0.3 preview |
| `sshHost` | reviewed, directly resolvable edge DNS name or IP address written as `HostName` in the generated standalone SSH config |
| `sshUser` | dedicated unprivileged tunnel account |
| `sshPort` | optional SSH port; default is implementation-defined/22 |
| `hostKeyAlias` | optional explicit alias for known-host verification |

The renderer must preserve strict host-key verification, request failure when a remote forward cannot bind, and bind the remote listener to exact IPv4 loopback `127.0.0.1`. SSH passwords and key material never belong here. The JSON Schema intentionally describes canonical, lower-case hostname/alias input for editor tooling; the CLI normalizer remains authoritative and may canonicalize an equivalent IDN or IP representation before hashing it.

## `spec.services[]`

| Field | Meaning |
| --- | --- |
| `id` | stable lowercase identifier |
| `exposure` | `public` (default) or `private`; controls public ingress independently of the route contract |
| `profile` | `localllm-openai`, `localllm-openai-admission`, or `generic-http` |
| `domains[]` | one or more exact public DNS names for public exposure; exactly `[]` for private exposure |
| `edge.upstream` | exact `http://127.0.0.1:PORT` URL reached by the edge guard |
| `worker.listen` | exact `127.0.0.1:PORT` worker guard listener |
| `worker.target` | exact `http://127.0.0.1:PORT` private upstream URL |
| `worker.healthPath` | optional private transport-health path; it cannot overlap any public route |
| `public.tokenSet` | name resolved to an external token store through bindings |
| `public.routes[]` | exact path plus unique uppercase HTTP methods |
| `public.maxBodyBytes` | 1 byte–1 GiB request limit |
| `public.maxConcurrentRequests` | 1–1024 admitted requests; choose a measured, small value |
| `public.idleTimeoutSeconds` | 1–86400 seconds; align with proxy/client/upstream timeouts |

The profile may be omitted, which behaves as `generic-http`.
`localllm-openai` permits only a chosen subset of the four reviewed
OpenAI-compatible inference routes shown above and keeps every health route
private. `localllm-openai-admission` is the explicit enrollment/switching
variant: it permits that same inference set and requires both exact claims
`GET /readyz` and `GET /api/node/capabilities`. Those two documents receive the
same external bearer-token, relay-token, and worker upstream-token enforcement
as inference. No other `/api`, readiness, liveness, management, or wildcard path
is implied. `generic-http` remains exact-path only and is intended for reviewed
APIs such as Whisper or SoVITS—not arbitrary TCP forwarding.

For the admission profile, `doctor --role worker` reports transport and
application admission independently. The private `worker.healthPath` proves
only that the transport can reach its target. Application admission instead
requires exact HTTP 200, JSON, `Cache-Control: no-store`, matching immutable
release evidence, a fresh passing configured canary, supported protocols, and
matching model provenance from `/readyz` plus `/api/node/capabilities`.
LocalLLM's legacy `/healthz` compatibility document is never admission evidence,
even when it returns HTTP 200.

The backwards-compatible `public` object names the external-client token,
route, body, concurrency and timeout contract even when `exposure: private`.
Private exposure requires one matching `spec.edge.privateListeners` entry and
produces no DNS, Caddy, certificate or NAT ingress. Public exposure keeps the
existing non-empty domain contract and cannot add a private listener. This
prevents a hostless private capability from authorizing the same service's
public route. See [private service listeners](private-service-listeners.md).

## Bindings and secrets

Bindings map service IDs to secret **file locations**, but each role gets a different file. Copy only the [edge template](../examples/local-llm/bindings.edge.example.yaml) to the public gateway:

```yaml
bindings:
  local-llm:
    relaySecretFile: /etc/lazyedge/secrets/local-llm-relay
    clientTokenStore: /var/lib/lazyedge/tokens/local-llm-users.json
```

Copy only the [worker template](../examples/local-llm/bindings.worker.example.yaml) to private compute:

```yaml
bindings:
  local-llm:
    relaySecretFile: ~/.config/lazyedge/secrets/local-llm-relay
    upstreamAuthorizationFile: ~/.config/lazyedge/secrets/local-llm-upstream-key
```

The two `relaySecretFile` paths refer to protected files containing the same relay capability on different hosts. The edge runtime dereferences only the relay secret and `clientTokenStore`; the worker runtime dereferences only the relay secret and `upstreamAuthorizationFile`. Do not copy the client token store to the worker or the upstream key to the edge. Bindings and every referenced secret must be regular, owner-readable, non-symlink files with restrictive permissions. In the v0.3 preview, every worker binding requires `upstreamAuthorizationFile`; it contains the bare token that the worker injects as `Authorization: Bearer …`. Configure the private service to require that token.

To reuse an existing LocalLLM key without printing or manually copying it, `lazyedge secret import-env --env-file FILE --name LOCALLLM_API_KEY --out FILE` can extract exactly one 32–4096-character whitespace-free capability variable from a private regular non-symlink `.env` into a new mode-`0600` file. The source remains unchanged, and the command refuses to overwrite the destination. This is a migration convenience, not permission to put `.env` in Git or `references/private/`.

For a coordinated upstream-key rotation, `lazyedge secret sync-env --env-file FILE --name NAME --value-file FILE` atomically replaces or adds one unquoted environment assignment from a private value file without printing the value. The value must be 32–4096 characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, `~`, or `-`; both inputs must be private regular non-symlink files. This command does **not** make a backup, restart the service that owns the environment file, probe the new key, revoke the old key, or roll back. Follow the operator procedure in [operations](operations.md) before using it.

Never put a secret value in YAML, an environment file committed to Git, a URL, a command-line argument, `references/private/`, generated systemd unit text, or an npm package. The edge receives external-token metadata and its relay secret; the worker receives the matching relay secret and the required upstream token. Do not distribute more secrets to a host than its boundary requires.

## Route semantics

Configured paths are canonical, exact absolute paths. Wildcards, repeated separators, traversal components, encoded separators, query strings in route declarations, and fragments are rejected. The public gateway and legacy compatibility listener preserve their existing behavior: a query string on an otherwise approved path is forwarded but cannot select another path. Application-neutral private listeners reject every query string because the current route schema has no query declaration.

Methods are uppercase and limited to `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. Listing a path does not imply all methods.

## Validate before render

```bash
npx @lazyingart/lazyedge validate --config ./lazyedge.yaml
npx @lazyingart/lazyedge plan --config ./lazyedge.yaml
```

Validation proves that data matches the versioned manifest contract and the CLI's cross-field project invariants, not that DNS, firewall, Caddy, SSH authorization, credentials, or the upstream are correct. The shipped JSON Schema is a machine-readable tooling companion; the CLI normalizer remains authoritative. Run `doctor --role edge` on the gateway and `doctor --role worker` on the private compute host, then use boundary probes and a rollback plan before deployment. For the admission profile, require both `boundaries.transport.ok` and `boundaries.applicationAdmission.ok`; one does not substitute for the other. Reserve `--role all` for a truly co-located setup.
