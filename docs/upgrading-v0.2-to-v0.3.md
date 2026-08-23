# Upgrade from v0.2 to transport-only v0.3

## Status and scope

This guide describes the transport-only v0.3 release line. Its presence is not
evidence that an exact v0.3 package has been published or deployed. Verify the
Git commit, registry version, package checksum and running immutable path at
each checkpoint; do not substitute a moving branch, tag, symlink or unpinned
`npx`.

The candidate keeps LazyEdge responsible for authenticated, bounded transport.
The v0.2 private-chat BFF, browser assets, sessions, service-worker cache,
chat-specific commands, `chat` manifest block, and `lazyedge-chat.service`
renderer are removed. An independently released application such as
LazyingAgentWeb owns those application concerns.

The candidate also adds explicit application-neutral `privateListeners` and
strict role-specific runtime bindings. These changes do not authorize an
in-place production update.

## Choose the legacy-chat path before changing the launcher

Inventory the current deployment and record owner-only rollback evidence:

- exact v0.2 executable or package, its checksum, and its immutable release
  directory;
- stable launcher target and the complete effective `ExecStart` for each
  LazyEdge-owned unit;
- normalized manifest digest and copies of the exact manifests used by the
  transport and legacy chat processes;
- unit enablement and active state, listener ownership, and the
  `lazyedge-chat.service` unit bytes;
- exact accepted Caddy configuration bytes, imported snippets, and checksum;
- redirect/NAT ownership tag and the immediately previous rollback artifact;
- ownership, mode, and backup procedure for the legacy chat session state.

Do not put credentials, cookies, session records, private host inventories, or
live configuration containing secrets in Git or an npm package. A transport
candidate must not replace a shared stable launcher while an active legacy-chat
unit still resolves that launcher. Choose one of the following paths first.

### Temporary compatibility: pin legacy chat to v0.2

Use this path only while LazyingAgentWeb acceptance is incomplete.

1. Retain the exact verified v0.2 artifact and its runtime dependencies in an
   immutable release directory. A Git tag by itself is not a deployed rollback
   artifact.
2. Prepare a candidate `lazyedge-chat.service` whose executable resolves
   directly to that retained artifact, not to the stable LazyEdge launcher.
   Preserve its reviewed v0.2 arguments, credentials, account, hardening,
   manifest, and state paths.
3. Validate the candidate unit and prove after a controlled restart that the
   running process resolves the pinned v0.2 artifact, owns only its expected
   loopback listener, and preserves the intended remembered-session behavior.
4. Retain both the prior unit and the pinned candidate as exact rollback
   artifacts. Do not feed the transport-only manifest to the v0.2 chat process.

Only after this pin is accepted may the separate edge and worker units be
considered for a transport candidate. The pin is a temporary compatibility
boundary, not a reason to keep chat code in future LazyEdge releases.

### Preferred retirement: move application ownership out of LazyEdge

Retire legacy chat only after the independently deployed LazyingAgentWeb has
passed its own authentication, session, streaming, image-input, cache/version,
restart, and rollback tests through the accepted external route composition.

1. Prove no accepted Caddy route, monitor, or client still selects the legacy
   chat BFF. Confirm the standalone application has an independent health and
   release identity; transport health alone is not application acceptance.
2. Preserve the exact legacy unit, v0.2 artifact, manifest, state, and route
   configuration under the deployment's protected rollback policy.
3. Stop and disable only the exact `lazyedge-chat.service`; verify that it is
   inactive and its old loopback listener is absent. Do not delete its state or
   revoke rollback credentials during the observation window.
4. Re-probe LazyingAgentWeb and the public API independently. Promote the
   retirement only after the observation window passes.

Rollback restores the retained v0.2 artifact and exact unit, re-enables only
that unit, restores the prior Caddy artifact if routing changed, and repeats the
old-path acceptance probes. Deleting state or credentials before that test
would make this rollback incomplete.

## Preserve externally composed LazyingAgentWeb routes

The transport-only Caddy renderer does not describe or reproduce a standalone
application's same-host UI, sign-in, session, upload, asset, or application API
routes. `existingSites` can preserve a separate upstream site, but it is not a
general same-site route-composition language. Therefore:

- keep the exact accepted external Caddy configuration and every imported
  snippet unchanged during a code-only edge/worker upgrade;
- do not install `lazyedge render caddy` output over a configuration that
  externally composes LazyingAgentWeb routes;
- if route composition must change, build a separate candidate from
  LazyingAgentWeb's reviewed route manifest, validate it independently, and
  retain the exact previous Caddy bytes before reload;
- verify handler order and route ownership so application paths reach only
  LazyingAgentWeb, declared public transport paths reach only the LazyEdge edge
  guard, and neither route becomes an unauthenticated catch-all;
- directly probe sign-in, session continuity/logout, image upload, application
  streaming, public Bearer API allow/deny behavior, and an unknown path before
  and after any route change.

Application asset URLs, service-worker cache names, update activation, and
cache headers belong to LazyingAgentWeb. A new application release should use
a distinct asset/cache version and must not cache authenticated API responses,
uploads, sessions, or generated content. LazyEdge preserves an application's
explicit ordinary `Cache-Control` response but does not provide application
cache busting or a website release identifier.

## Convert runtime bindings by role

Keep one protected bindings file per runtime role. The edge file may contain
only manifest-declared service IDs with `relaySecretFile` and
`clientTokenStore`. The worker file may contain only manifest-declared service
IDs with `relaySecretFile` and `upstreamAuthorizationFile`.

The transport candidate rejects an upstream authorization locator on the edge,
a client token-store locator on the worker, unknown fields, and bindings for a
service not declared by the loaded manifest. Remove obsolete entries; do not
merge the two role files or copy the opposite role's credentials to make a
validation error disappear. Validate both files with the exact candidate in a
non-production rehearsal before changing a unit.

## Manifest digest, public ingress, and NAT ownership

If both releases accept the unchanged transport manifest, normalize it with
both exact releases and compare the digests. A v0.2 chat overlay is not a v0.3
transport manifest; keep it with the pinned legacy process and validate a
separately transformed candidate instead of deleting fields in place merely to
obtain a digest. A code-only change whose normalized transport-manifest digest
is unchanged does not require a new redirect/NAT ownership tag. Adding
`privateListeners` or any other normalized manifest field can change the digest
even though a private listener never belongs in Caddy or DNS.

If the digest changes, render and review the new artifacts and explicitly
reconcile the prior ownership tag using the operations runbook. Do not enable a
new redirect helper over rules owned by another digest, and do not use a
firewall change to solve an application-routing problem. Preserve the accepted
Caddy and NAT artifacts when neither boundary needs to change.

## Repair provenance drift before the v0.3 promotion

Do not restart a process merely because its launcher now resolves to a reviewed
package. A long-running Node.js process can still be executing code loaded from
an older release, while its unit and stable symlink already name a newer one.
Record all three identities independently: the running process start time and
arguments, the unit's effective `ExecStart`, and the current symlink target.

If the exact artifact executing in either role is absent, the current state is
not an executable rollback target. Before v0.3, establish a reproducible bridge
release on both roles:

1. obtain one exact prior package and verify its checksum and installed file
   list independently on the edge and worker;
2. render edge and worker units with that release's absolute executable path,
   never a shared moving launcher;
3. retain the pre-change unit bytes and a controller that restores both the
   unit and executable path and restarts that exact role;
4. promote and probe the bridge release in a controlled window, one role at a
   time, including positive, negative, streaming and bounded-outage checks;
5. record the resulting process identities as the immediately previous
   reproducible release for v0.3.

A source tag is insufficient if its packed bytes cannot be proven identical to
the missing deployed artifact. Do not label a different patch release as the
exact prior runtime; it can be a reviewed bridge or fallback only after its own
acceptance.

## Stage and promote both transport roles

Build one v0.3.0 tarball from the reviewed release commit, audit its file list,
and record its SHA-256. Install those exact bytes into new checksum-named
directories on both hosts. Verify the CLI version and complete installed file
hashes under each service manager's account. Render candidate units with the
immutable executable paths and retain the complete previous unit bytes.

First rehearse the candidate without public cutover. Use a separate manifest
whose edge, reverse and worker listeners are unused loopback ports; the
candidate tunnel must use only those separate ports. Start at most one
candidate worker, tunnel and edge for that manifest, then run the positive and
negative contract matrix. Stop the rehearsal stack after evidence capture.

During promotion, keep Caddy, NAT and tunnel configuration unchanged unless the
reviewed manifest requires a boundary change. Promote the worker unit to the
immutable v0.3 path and prove the existing edge path still works. Then promote
the edge unit and repeat edge-local and public probes. Retarget a convenience
launcher only after every remaining consumer, especially a legacy chat unit,
is pinned elsewhere or retired. Never leave one role on an unidentified
runtime and call the pair v0.3.

The transport rollback controller must restore and restart the failed runtime,
not only rewrite symlinks. For an edge failure, restore the previous edge unit
and immutable executable, restart only the edge, and re-probe before touching
the worker. For a worker failure, restore the previous worker unit and
immutable executable, restart only the worker, confirm exactly one worker and
tunnel own their expected listeners, and re-probe through the edge. Restart
the tunnel only when its reviewed unit or SSH configuration changed. Caddy and
NAT use their separately retained rollback artifacts and are not part of a
code-only transport rollback.

## Candidate acceptance and rollback

Before promotion, require all of the following:

- exact candidate commit, package checksum, manifest digest, and immutable
  edge/worker executable paths are recorded;
- the immediately previous edge and worker packages and unit bytes are present,
  reproducible, and their rollback controllers restart the restored runtimes;
- validation, plan, doctor, unit verification, and direct high-port probes pass
  separately on each role;
- edge and worker use only their role-specific bindings; negative startup
  checks reject the opposite role's fields and undeclared fields/services, and
  negative request probes reject missing/invalid client authorization,
  forbidden paths, and invalid relay authorization;
- every public site and externally composed LazyingAgentWeb route passes its
  own acceptance suite without replacing unrelated Caddy configuration;
- legacy chat is either proven pinned to v0.2 or proven retired, never left on
  a shared moving launcher;
- application, transport, tunnel, public ingress, and NAT each retain one exact
  independently usable rollback artifact.

Rollback switches only the failed boundary to its retained artifact. Restore
the prior executable/unit for a transport failure, the prior external Caddy
bytes for a route failure, and the prior owned NAT transaction only for a NAT
failure. Validate before reload, then repeat positive and negative probes. Do
not describe a merge, tag, package publication, or documentation update as
deployment acceptance.
