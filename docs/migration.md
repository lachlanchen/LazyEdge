# Migrating an edge or adding a second edge

LazyEdge separates the public edge from private compute. Moving Alibaba ECS to Huawei Cloud—or keeping both—is therefore an ingress migration: the model weights and GPU service can stay on the private worker.

## Migration goals

- no raw private service is exposed during transition;
- old and new edges use distinct SSH and relay credentials;
- existing sites on either server are preserved;
- DNS cutover is reversible;
- the old edge is retired only after observation.

## Provider-neutral runbook

### 1. Inventory and prepare

Record the current DNS answers, TTL, Caddy site, loopback ports, manifest digest, service units, firewall rules, and last-known-good artifacts. Do not copy private keys or tokens into the inventory.

Provision edge B with a patched OS, its own unprivileged account, Caddy, Node.js 20+, and enough disk for the small gateway runtime. Do not upload GPU model weights to an edge that only forwards traffic.

### 2. Render independently

Use the same reviewed service contract but a distinct edge identity and secret stores. Validate edge B's Caddy and service files without replacing unrelated configuration. Confirm reverse listeners bind only to `127.0.0.1`.

### 3. Connect the worker to both edges

Create a second dedicated SSH key and supervised tunnel. Edge A and edge B should have separate relay tokens, so revoking one edge cannot silently disable or authorize the other.

Do not make two supervisors compete for the same local unit or remote port. Name processes and units by edge identity.

### 4. Test before public DNS

Use a temporary hostname or an explicit resolver override to exercise edge B. Check:

- valid TLS;
- valid token + allowed route succeeds;
- missing/invalid token fails;
- forbidden path and method fail;
- body and concurrency limits work;
- streaming/long requests behave as intended;
- logs contain neither credentials nor request bodies;
- stopping the edge-B tunnel does not affect edge A.

Caddy obtains and renews certificates according to its [Automatic HTTPS](https://caddyserver.com/docs/automatic-https) behavior. Plan certificate issuance before DNS cutover; do not copy Caddy's private key casually between providers.

### 5. Cut over DNS

Lower TTL well before the maintenance window if operationally appropriate. Change only the target record, observe both old and new answers during cache expiry, and keep edge A healthy. DNS is not an instant global switch.

For active/active service, use a health-aware DNS or load-balancing design and ensure requests are safe to retry. Two A/AAAA records alone do not guarantee health-aware failover.

### 6. Observe, drain, retire

After the maximum expected cache window and an agreed observation period, reject new traffic on edge A, confirm it is idle, stop its project-owned tunnel, revoke its external/relay/SSH credentials, and remove only its declared DNS/configuration. Preserve the immediately previous reproducible artifact and sanitized migration record.

## Rollback

If edge B fails, restore the prior DNS record, keep or reconnect edge A's tunnel, and verify the old digest. Do not revoke edge-A credentials until the migration acceptance window has passed.

## Future multi-edge shape

At larger scale, replace manual endpoint choice with health-aware load balancing and service discovery. Kubernetes documents the underlying [service/networking](https://kubernetes.io/docs/concepts/services-networking/) and [self-healing](https://kubernetes.io/docs/concepts/architecture/self-healing/) patterns. That does not require putting LazyEdge itself into Kubernetes; adopt the complexity only when multiple replicas and operators justify it.
