# Private service listeners

## Status

This page documents an unreleased pull-request implementation proposed for a
future transport-only v0.3. It is not part of the published v0.2.0 package.
Merge, documentation, and test evidence do not mean release or deployment, and
must not be cited as production acceptance evidence.

## Problem

Some edge-local applications need an authenticated route to a private worker
without publishing that route through Caddy or DNS. The transport primitive is
application-neutral and does not depend on the caller's product or protocol.

The v0.2 compatibility listener remains limited to one selected `/v1` service.
It is not a general multi-service private ingress and is not widened implicitly.

## Manifest contract

LazyEdge supports a bounded list of explicit edge-local service listeners:

```yaml
spec:
  edge:
    gatewayListen: 127.0.0.1:17600
    privateListeners:
      - service: private-service-id
        listen: 127.0.0.1:18120
  services:
    - id: private-service-id
      exposure: private
      domains: []
      edge:
        upstream: http://127.0.0.1:18020
      worker:
        listen: 127.0.0.1:17820
        target: http://127.0.0.1:8100
      public:
        tokenSet: private-service-users
        maxBodyBytes: 1048576
        maxConcurrentRequests: 2
        idleTimeoutSeconds: 120
        routes:
          - path: /v1/capabilities
            methods: [GET]
          - path: /v1/jobs
            methods: [POST]
```

`exposure` defaults to `public`, preserving existing manifests. Public services
must retain at least one exact domain. A service with `exposure: private` must
use `domains: []` and own exactly one `privateListeners` entry. A private
listener may select only a service whose exposure is `private`; dual public and
private ingress for one service is rejected because a hostless private token
must never become a public bearer capability. Omitted and explicit
`exposure: public` canonicalize to the same normalized digest. Listener entries
and their ports are globally unique on the edge. Private listeners use
canonical decimal ports in the unprivileged 1024–65535 range; privileged ports,
port zero and leading-zero spellings are rejected.

The existing `public` object remains the backwards-compatible name of the
external-client route and resource contract. For a private listener it does not
mean the service is published through DNS; `exposure` alone controls that.

Each listener selects exactly one existing service. It binds only exact
`127.0.0.1`, accepts only that service's declared method/path claims, requires
that service's external token set and scope, applies its body, concurrency and
duration limits, injects only its relay capability, and forwards to the existing
reviewed reverse listener and worker guard. It does not inspect or understand
the application protocol.

Successful responses preserve the application's ordinary headers, including an
explicit `Cache-Control`, through the existing proxy sanitizer. LazyEdge adds no
application versioning, cache policy, or session behavior at this seam.
Security-sensitive response headers such as `Set-Cookie`, Authorization and the
relay capability remain stripped. LazyEdge-generated denial and outage errors
retain `Cache-Control: no-store`. When an application omits `Cache-Control`, the
existing worker guard's unchanged fallback is also `no-store`; the new private
listener does not add or rewrite that fallback.

## Lifecycle and public-artifact separation

`lazyedge serve edge` starts the edge guard, the unchanged optional compatibility
listener, and every declared private listener in one supervised lifecycle. No
request field or CLI option selects a private listener or changes its service.
The legacy edge `--service` option remains only an exact assertion for
`compatibilityService`; it cannot filter or override `privateListeners`.

When a manifest contains no public service and no preserved `existingSites`,
the Caddy, certificate, redirect-helper, and nft renderers refuse to produce
public-ingress artifacts. `render systemd` emits only the edge, worker, and
tunnel units. A mixed manifest renders public artifacts only for public service
domains; private listener addresses never enter Caddy or certificate output.

Doctor reports the private listener, reverse listener, and worker-guard transport
health. Application capability, health semantics, state and lifecycle continue
to belong to the transported service.

## Client token

Issue the listener's client token with service, method, and path scope and omit
host scope because a private service has no public DNS identity:

```bash
lazyedge token issue \
  --store /var/lib/lazyedge/tokens/private-service-users.json \
  --set private-service-users \
  --service private-service-id \
  --methods GET,POST \
  --paths /v1/capabilities,/v1/jobs \
  --out /run/credentials/private-service-client.token
```

The raw token belongs only in the requested owner-protected file. It must not be
placed in the manifest, command line, logs, or documentation.

## Non-negotiable behavior

- No wildcard, Unix-socket alias, dynamic port, privileged port, port zero,
  leading-zero port spelling or implicit listener.
- No query-based service selection, caller-supplied upstream, wildcard path,
  method override or transparent arbitrary proxy.
- Listener/service pairs and ports are unique and included in the normalized
  manifest digest.
- A listener can select only an `exposure: private` service. Public/private
  dual ingress requires a future separately audience-bound credential contract
  and is rejected in the current schema normalizer.
- Tokens remain scoped by exact service, method and normalized path. A token for
  one private listener cannot authenticate another.
- External Authorization and forwarding headers are stripped; the worker sees
  only the intended relay boundary and application body.
- Unknown methods, paths, encoded separators, traversal, over-limit bodies and
  management paths fail closed. The route schema has no query declaration, so
  private listeners reject every query string rather than forwarding it.
- Caddy and certificate renderers never infer public exposure from a private
  listener.
- A private-only manifest produces no Caddy, TLS or NAT lifecycle artifact.

## Acceptance

Offline automated tests cover multiple simultaneous private services, port and
service collisions, exact route/token separation, unavailable tunnel recovery,
oversized requests, concurrency, streaming detach cleanup, restart recovery and
absence from rendered public artifacts. This is development evidence only.
Production acceptance must additionally prove the listener is loopback-only,
direct Internet access fails, outage recovery remains bounded under the real
service manager, and the reviewed rollback works.

This primitive is the intended LazyEdge seam for replaceable model, Raspberry
Pi, Jetson, Kria, robot, and other reviewed HTTP services. Those products retain
their own API, health, state, and lifecycle contracts.
