# Rollout safety and controller ownership

LazyEdge packages three generic rollout safety libraries for an application-owned
deployment controller. They provide a strict artifact-claim contract, a durable
phase journal, and a short-lived one-shot stop authority. They do not form a
deployment engine and do not move application policy into LazyEdge.

## Read-only CLI

The public CLI commands are intentionally non-mutating:

```bash
lazyedge rollout validate --rollout ./edge-rollout.yaml [--json]
lazyedge rollout plan --rollout ./edge-rollout.yaml [--json]
lazyedge rollout inspect \
  --state /absolute/private/path/phase.json \
  [--plan-digest LOWERCASE_SHA256] \
  [--operation-id PORTABLE_ID] \
  [--json]
```

`validate` and `plan` accept a non-empty regular YAML or JSON file up to 1 MiB;
the final path must not be a symbolic link and the bytes must be valid UTF-8.
The loader reads at most 1 MiB plus one byte and rejects a file that changes
during the read. Parsing uses strict unique keys, disables YAML merges, and
rejects aliases, custom tags, and parser warnings. The `EdgeRollout` normalizer
then rejects unknown fields, duplicate artifact IDs or paths, non-canonical
absolute paths, unsupported artifact types, and inexact digest, owner, group, or
mode claims.

`validate` reports the normalized plan digest and bounded summary. `plan` prints
the same deterministic digest plus the canonical, ID-sorted artifact claims.
Neither command stats, opens, hashes, owns, installs, removes, or verifies an
artifact path. A normalized plan and its digest identify declared intent only;
they are not evidence of live state and grant no write authority.

`inspect` reads one existing journal record and can require an exact plan digest
and operation ID. It does not create or acquire a lease. The journal's direct
parent must already be an effective-owner `0700` directory, and the state record
must be an effective-owner `0600` regular file with one link. Inspection can
therefore fail closed on a state file that another Unix identity could alter.

There is no `rollout verify`, rollout executor, remote apply/rollback command, or
`render rollout-systemd` command in this preview.

## Package subpaths

Controllers can import only the layer they need:

```js
import {
  edgeRolloutDigest,
  normalizeEdgeRollout,
} from "@lazyingart/lazyedge/rollout/contract";
import {
  createRolloutJournal,
  inspectRolloutJournal,
  openRolloutJournal,
} from "@lazyingart/lazyedge/rollout/journal";
import {
  consumeStopPermit,
  FileStopPermitStore,
  issueStopPermit,
} from "@lazyingart/lazyedge/rollout/authority";
```

The machine-readable schema is exported as
`@lazyingart/lazyedge/schemas/edge-rollout.schema.json`. The JavaScript
normalizer remains authoritative because JSON Schema cannot express every
cross-item and filesystem-safety invariant.

## Contract and identity separation

An `EdgeRollout` contains:

- the digest of the normalized `EdgeProject` it accompanies;
- a deployment ID identifying the declared deployment;
- one to 256 exact regular-file claims: ID, absolute destination path, SHA-256,
  owner, group, four-digit mode, and type.

The digest returned by `edgeRolloutDigest()` is the `planDigest` used by the
journal and stop authority. A deployment ID names declared intent; an operation
ID names one controller attempt. Both use the portable 16–128 character grammar
and reject `:`.

## Durable journal boundary

The journal serializes generic adjacent activation and rollback phases under an
exclusive cross-process lease. It requires exact effective UID/GID ownership,
`0700` lease directories, `0600` one-link records, same-directory durable
publication, sequence compare-and-swap, and immutable terminal receipts.
Every directory in the path must be owned by root or the effective UID; a
group- or world-writable ancestor is accepted only when it has the sticky bit.
This prevents another Unix identity from renaming a validated private parent.

Lease reclamation is fail closed. LazyEdge first proves that the recorded Linux
PID/start-ticks instance is no longer running, and then requires the controller's
explicit `verifyOwnerDead` callback to return exactly `true`. PID absence alone
is not the identity model: a present PID with different `/proc/<pid>/stat` start
ticks represents reuse of the number and not the recorded process. A live exact
PID/start-ticks instance cannot be reclaimed even if a callback attempts to
permit it.

The phase names do not prove that an application probe, drain, fence, route
change, service transition, or rollback actually happened. The controller must
perform and verify each application-owned action before advancing the journal.

## Stop authority boundary

A `StopPermit` binds the plan and operation to an exact role, systemd service
unit, systemd `InvocationID`, PID, Linux process start ticks, unit digest,
listener set, admission/fence generation, and proof digest. It is short-lived,
stored durably without plaintext claims, and can be consumed only once.

The file-backed permit store applies the same stable-ancestor rule as the
journal, requires an effective-owner `0700` direct parent and store, and pins
both directory identities for the lifetime of an opened instance. Direct or
forged construction is rejected; callers must use `FileStopPermitStore.open()`.

Permit consumption rechecks the PID/start-ticks identity around durable
one-shot consumption and returns a stop authorization marked as requiring
immediate process and invocation coupling. It does not call systemd and it does
not prove that the claimed `InvocationID` is currently authoritative.

The controller must therefore, without queueing unrelated work:

1. obtain the current systemd unit identity through its bounded systemd/DBus
   integration;
2. compare the exact unit, `InvocationID`, PID, and process start ticks to the
   returned authorization;
3. refuse the stop if any value changed or cannot be established;
4. perform the one intended stop immediately; and
5. verify the post-stop listener and service state before advancing the journal.

A consumed authorization is not reusable if the unit restarts, the PID is
recycled, or systemd creates a new invocation.

## What remains application-owned

The embedding application or controller remains solely responsible for:

- building artifacts and resolving the intended source-to-destination mapping;
- hashing and verifying staged and live files, owners, groups, modes, link
  counts, and parent directories;
- discovering the exact project-owned systemd unit, PID, `InvocationID`, and
  listeners;
- defining readiness, idle, drain, canary, and acceptance predicates;
- creating and enforcing the admission/fence generation;
- installing artifacts, changing routes, reloading services, and stopping a
  process;
- implementing the rollback controller, rollback deadline, and boot behavior;
- retaining the last-known-good artifacts and deciding terminal acceptance;
- cleaning up only its own superseded revisions and processes.

Application-specific probes or shell hooks are deliberately not accepted by the
generic rollout contract. Keep their implementation, evidence, and failure
policy in the owning application.

## Security limitations

The owner-private stores treat the effective Unix account as their local trust
boundary. They are not a distributed signature system and do not defend against
arbitrary code already running as that same account or root. Do not put secrets,
tokens, private runtime histories, request bodies, or browser state in a rollout
contract or journal. Keep machine-specific paths and sanitized evidence in the
private operational handoff, never in the npm package or public documentation.
