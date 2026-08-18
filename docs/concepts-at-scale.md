# From one tunnel to a fleet: the concepts

The starting problem is asymmetric reachability: a private machine can initiate an outbound connection to a cloud server, but the server cannot initiate a connection through the private machine's NAT or firewall. A reverse tunnel keeps that outbound connection open and creates a tightly scoped rendezvous point on the server.

## Three networking layers

| Layer | Question | Common technology | LazyEdge use |
| --- | --- | --- | --- |
| L3 overlay | How do hosts join one private routed network? | [WireGuard](https://www.wireguard.com/quickstart/) | optional future transport |
| L4 forwarding | How does a byte stream reach a private port? | [OpenSSH remote forwarding](https://man.openbsd.org/ssh.1), [rathole](https://github.com/rathole-org/rathole), [frp](https://gofrp.org/en/docs/overview/) | OpenSSH first |
| L7 application edge | Which hostname, identity, method, and path may reach which service? | [Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) | TLS plus an exact HTTP contract |

A tunnel alone is not access control. Binding a reverse listener to loopback prevents direct Internet access, while the L7 guards decide which authenticated HTTP requests may pass.

## What larger systems add

Large services use the same ideas at more layers:

- A load balancer or ingress accepts a stable public address and distributes requests among healthy replicas.
- Service discovery replaces hand-maintained host/port pairs with a changing set of endpoints.
- A deployment controller creates and replaces replicas; Kubernetes [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) are one example.
- Health checks and reconciliation repair failures. Kubernetes documents this as [self-healing](https://kubernetes.io/docs/concepts/architecture/self-healing/).
- Networking abstractions give clients one service identity while backends change. Kubernetes groups these ideas under [Services, load balancing, and networking](https://kubernetes.io/docs/concepts/services-networking/).
- A service mesh adds workload identity, policy, telemetry, retries, and traffic management between many services. [Istio's service-mesh overview](https://istio.io/latest/about/service-mesh/) explains the sidecar/data-plane and control-plane model.

Those systems solve fleet-scale scheduling and reliability. LazyEdge deliberately does not try to be a small Kubernetes. It targets one to a handful of edge hosts and private workers where a manifest, a standard tunnel, a reverse proxy, and ordinary service supervision are easier to audit.

## Choosing a transport

| Situation | Reasonable starting point |
| --- | --- |
| A few HTTP services; SSH already administered | OpenSSH remote forwards |
| Many ports/services across stable machines | WireGuard overlay plus L7 gateway |
| Need a dedicated tunnel broker and multiplexing | Evaluate rathole or frp |
| Many replicas, scheduling, discovery, autoscaling | Orchestrator and load balancer; possibly Kubernetes |
| Many service-to-service policies and workload identities | Consider a service mesh only after the operational need is real |

frp includes HTTP/HTTPS virtual-host features and transport TLS; see its [HTTP/HTTPS](https://gofrp.org/en/docs/features/http-https/) and [TLS](https://gofrp.org/en/docs/features/common/network/network-tls/) documentation. rathole focuses on NAT traversal with a small client/server design. Either adds another privileged network component to maintain. For LazyEdge v0.1, OpenSSH offers the smallest initial dependency and its behavior is documented in the OpenBSD manuals.

## Reliability grows one failure domain at a time

A single edge is a deliberate single point of failure. The next step is usually a warm second edge, not a complex cluster:

1. render the same reviewed service contract for edge B;
2. give edge B distinct SSH and relay credentials;
3. connect the worker to both loopback listeners;
4. test edge B through a temporary hostname or explicit resolver override;
5. move DNS gradually and keep edge A available for rollback.

That pattern separates compute migration from ingress migration. See [migration](migration.md) for a provider-neutral runbook.
