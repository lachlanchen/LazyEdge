import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EDGE_ROLLOUT_API_VERSION,
  EDGE_ROLLOUT_ARTIFACT_TYPE,
  EDGE_ROLLOUT_KIND,
  edgeRolloutDigest,
  normalizeEdgeRollout,
} from "../src/rollout-contract.js";

function artifact({
  id = "candidate-config",
  pathname = "/srv/example/releases/candidate/service.conf",
  digest = "b".repeat(64),
  owner = "service_user",
  group = "service_group",
  mode = "0640",
  type = EDGE_ROLLOUT_ARTIFACT_TYPE,
} = {}) {
  return { id, path: pathname, sha256: digest, owner, group, mode, type };
}

function rollout() {
  return {
    apiVersion: EDGE_ROLLOUT_API_VERSION,
    kind: EDGE_ROLLOUT_KIND,
    metadata: { name: "example-rollout" },
    spec: {
      edgeProjectDigest: "a".repeat(64),
      deploymentId: "example-rollout-0001",
      artifacts: [
        artifact(),
        artifact({
          id: "baseline-config",
          pathname: "/srv/example/releases/baseline/service.conf",
          digest: "c".repeat(64),
          mode: "0600",
        }),
      ],
    },
  };
}

function rolloutWithArtifactCount(count) {
  const source = rollout();
  source.spec.artifacts = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return artifact({
      id: `artifact-${suffix}`,
      pathname: `/srv/example/releases/artifact-${suffix}/service.conf`,
      digest: "d".repeat(64),
    });
  });
  return source;
}

function envelopeCases() {
  return [
    {
      label: "rollout",
      field: "apiVersion",
      select: (value) => value,
    },
    {
      label: "metadata",
      field: "name",
      select: (value) => value.metadata,
    },
    {
      label: "spec",
      field: "edgeProjectDigest",
      select: (value) => value.spec,
    },
    {
      label: "artifact",
      field: "owner",
      select: (value) => value.spec.artifacts[0],
    },
  ];
}

test("EdgeRollout normalization is strict, sorted, detached, and deeply frozen", () => {
  const source = rollout();
  const normalized = normalizeEdgeRollout(source);
  assert.equal(normalized.apiVersion, EDGE_ROLLOUT_API_VERSION);
  assert.equal(normalized.kind, EDGE_ROLLOUT_KIND);
  assert.deepEqual(
    normalized.spec.artifacts.map((entry) => entry.id),
    ["baseline-config", "candidate-config"],
  );
  assert.equal(normalized.spec.artifacts[0].type, "regular-file");
  assert(Object.isFrozen(normalized));
  assert(Object.isFrozen(normalized.spec));
  assert(Object.isFrozen(normalized.spec.artifacts));
  assert(Object.isFrozen(normalized.spec.artifacts[0]));

  source.spec.artifacts[0].path = "/srv/example/changed";
  assert.equal(
    normalized.spec.artifacts[1].path,
    "/srv/example/releases/candidate/service.conf",
  );
});

test("EdgeRollout rejects accessors at every object level without invoking getters", () => {
  for (const { label, field, select } of envelopeCases()) {
    const source = rollout();
    const target = select(source);
    let getterCalls = 0;
    Object.defineProperty(target, field, {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(`${label} getter must not run`);
      },
    });

    assert.throws(
      () => normalizeEdgeRollout(source),
      /own enumerable data property/u,
      label,
    );
    assert.equal(getterCalls, 0, label);
  }
});

test("EdgeRollout requires enumerable data properties at every object level", () => {
  for (const { label, field, select } of envelopeCases()) {
    const source = rollout();
    const target = select(source);
    const fieldValue = target[field];
    Object.defineProperty(target, field, {
      configurable: true,
      enumerable: false,
      value: fieldValue,
      writable: true,
    });

    assert.throws(
      () => normalizeEdgeRollout(source),
      /own enumerable data property/u,
      label,
    );
  }
});

test("EdgeRollout rejects symbols before invoking an object getter at every level", () => {
  for (const { label, field, select } of envelopeCases()) {
    const source = rollout();
    const target = select(source);
    let getterCalls = 0;
    Object.defineProperty(target, field, {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(`${label} getter must not run`);
      },
    });
    Object.defineProperty(target, Symbol(`${label}-authority`), {
      configurable: true,
      enumerable: true,
      value: "forbidden",
    });

    assert.throws(
      () => normalizeEdgeRollout(source),
      /non-string field/u,
      label,
    );
    assert.equal(getterCalls, 0, label);
  }
});

test("EdgeRollout rejects inherited authority without invoking prototype getters", () => {
  for (const { label, field, select } of envelopeCases()) {
    const source = rollout();
    const target = select(source);
    const fieldValue = target[field];
    let getterCalls = 0;
    delete target[field];
    Object.setPrototypeOf(target, Object.create(Object.prototype, {
      [field]: {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          return fieldValue;
        },
      },
    }));

    assert.throws(() => normalizeEdgeRollout(source), /must be an object/u, label);
    assert.equal(getterCalls, 0, label);
  }
});

test("EdgeRollout never reads required authority from Object.prototype pollution", () => {
  for (const { label, field, select } of envelopeCases()) {
    const source = rollout();
    const target = select(source);
    const fieldValue = target[field];
    const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, field);
    let getterCalls = 0;
    delete target[field];
    Object.defineProperty(Object.prototype, field, {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return fieldValue;
      },
    });
    try {
      assert.throws(
        () => normalizeEdgeRollout(source),
        /own enumerable data property/u,
        label,
      );
      assert.equal(getterCalls, 0, label);
    } finally {
      if (priorDescriptor === undefined) delete Object.prototype[field];
      else Object.defineProperty(Object.prototype, field, priorDescriptor);
    }
  }
});

test("EdgeRollout ignores unrelated Object.prototype getter pollution", () => {
  const pollutionField = "__lazyedgeRolloutPollutedAuthority__";
  const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, pollutionField);
  let getterCalls = 0;
  Object.defineProperty(Object.prototype, pollutionField, {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("Object.prototype getter must not run");
    },
  });
  try {
    const normalized = normalizeEdgeRollout(rollout());
    assert.equal(normalized.metadata.name, "example-rollout");
    assert.equal(normalized.spec.artifacts.length, 2);
    assert.equal(getterCalls, 0);
  } finally {
    if (priorDescriptor === undefined) delete Object.prototype[pollutionField];
    else Object.defineProperty(Object.prototype, pollutionField, priorDescriptor);
  }
});

test("EdgeRollout rejects a custom artifact iterator without consuming it", () => {
  const source = rollout();
  let iteratorCalls = 0;
  Object.defineProperty(source.spec.artifacts, Symbol.iterator, {
    configurable: true,
    value() {
      iteratorCalls += 1;
      throw new Error("custom artifact iterator must not run");
    },
  });

  assert.throws(() => normalizeEdgeRollout(source), /non-string property/u);
  assert.equal(iteratorCalls, 0);
});

test("EdgeRollout rejects an infinite-style artifact iterator without consuming it", () => {
  const source = rollout();
  let iteratorCalls = 0;
  let nextCalls = 0;
  Object.defineProperty(source.spec.artifacts, Symbol.iterator, {
    configurable: true,
    value() {
      iteratorCalls += 1;
      return {
        next() {
          nextCalls += 1;
          if (nextCalls > 512) {
            throw new Error("infinite iterator safety tripwire");
          }
          return { done: false, value: source.spec.artifacts[0] };
        },
      };
    },
  });

  assert.throws(() => normalizeEdgeRollout(source), /non-string property/u);
  assert.equal(iteratorCalls, 0);
  assert.equal(nextCalls, 0);
});

test("EdgeRollout rejects every extra artifact-array property without invoking it", () => {
  const cases = [
    {
      label: "enumerable string",
      expected: /unexpected property/u,
      define(array, get) {
        Object.defineProperty(array, "extra", {
          configurable: true,
          enumerable: true,
          get,
        });
      },
    },
    {
      label: "non-enumerable string",
      expected: /unexpected property/u,
      define(array, get) {
        Object.defineProperty(array, "extra", {
          configurable: true,
          enumerable: false,
          get,
        });
      },
    },
    {
      label: "symbol",
      expected: /non-string property/u,
      define(array, get) {
        Object.defineProperty(array, Symbol("extra"), {
          configurable: true,
          enumerable: true,
          get,
        });
      },
    },
  ];

  for (const { label, expected, define } of cases) {
    const source = rollout();
    let getterCalls = 0;
    define(source.spec.artifacts, () => {
      getterCalls += 1;
      throw new Error(`${label} getter must not run`);
    });
    assert.throws(() => normalizeEdgeRollout(source), expected, label);
    assert.equal(getterCalls, 0, label);
  }
});

test("EdgeRollout is immune to poisoned Array.prototype indexed accessors", () => {
  const poisonedIndex = "255";
  const priorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, poisonedIndex);
  let getterCalls = 0;
  let denseNormalized;
  let sparseError;
  Object.defineProperty(Array.prototype, poisonedIndex, {
    configurable: true,
    get() {
      getterCalls += 1;
      return artifact({
        id: "prototype-artifact",
        pathname: "/srv/example/releases/prototype/service.conf",
      });
    },
  });
  try {
    denseNormalized = normalizeEdgeRollout(rolloutWithArtifactCount(256));
    const sparse = rolloutWithArtifactCount(256);
    delete sparse.spec.artifacts[255];
    try {
      normalizeEdgeRollout(sparse);
    } catch (error) {
      sparseError = error;
    }
  } finally {
    if (priorDescriptor === undefined) delete Array.prototype[poisonedIndex];
    else Object.defineProperty(Array.prototype, poisonedIndex, priorDescriptor);
  }

  assert.equal(denseNormalized.spec.artifacts.length, 256);
  assert.equal(sparseError?.name, "SecurityError");
  assert.match(sparseError.message, /enumerable data property/u);
  assert.equal(getterCalls, 0);
});

test("EdgeRollout requires a bounded ordinary dense artifact array", () => {
  const empty = rollout();
  empty.spec.artifacts = [];
  assert.throws(() => normalizeEdgeRollout(empty), /1-256 artifacts/u);

  const oversized = rollout();
  oversized.spec.artifacts = new Array(257).fill(null);
  assert.throws(() => normalizeEdgeRollout(oversized), /1-256 artifacts/u);

  class ArtifactArray extends Array {}
  const subclassed = rollout();
  subclassed.spec.artifacts = ArtifactArray.from(subclassed.spec.artifacts);
  assert.throws(() => normalizeEdgeRollout(subclassed), /ordinary array/u);

  const sparse = rollout();
  delete sparse.spec.artifacts[0];
  assert.throws(() => normalizeEdgeRollout(sparse), /enumerable data property/u);

  const accessor = rollout();
  let accessorCalls = 0;
  Object.defineProperty(accessor.spec.artifacts, "0", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalls += 1;
      return artifact();
    },
  });
  assert.throws(() => normalizeEdgeRollout(accessor), /enumerable data property/u);
  assert.equal(accessorCalls, 0);
});

test("EdgeRollout deployment IDs use the portable operation ID grammar without colon", () => {
  const portable = rollout();
  portable.spec.deploymentId = "Rollout_2026.08~29-01";
  assert.equal(
    normalizeEdgeRollout(portable).spec.deploymentId,
    portable.spec.deploymentId,
  );

  const colon = rollout();
  colon.spec.deploymentId = "rollout:20260829-001";
  assert.throws(
    () => normalizeEdgeRollout(colon),
    (error) => error.name === "SecurityError"
      && error.code === "INVALID_ROLLOUT"
      && /deploymentId is invalid/u.test(error.message),
  );
});

test("EdgeRollout digest is deterministic for an artifact set", () => {
  const first = rollout();
  const reordered = {
    spec: {
      artifacts: [...first.spec.artifacts].reverse().map((entry) => ({
        type: entry.type,
        mode: entry.mode,
        group: entry.group,
        owner: entry.owner,
        sha256: entry.sha256,
        path: entry.path,
        id: entry.id,
      })),
      deploymentId: first.spec.deploymentId,
      edgeProjectDigest: first.spec.edgeProjectDigest,
    },
    metadata: { name: first.metadata.name },
    kind: first.kind,
    apiVersion: first.apiVersion,
  };
  assert.equal(edgeRolloutDigest(first), edgeRolloutDigest(reordered));
  assert.match(edgeRolloutDigest(first), /^[a-f0-9]{64}$/u);

  reordered.spec.artifacts[0].sha256 = "d".repeat(64);
  assert.notEqual(edgeRolloutDigest(first), edgeRolloutDigest(reordered));
});

test("EdgeRollout rejects unknown fields at every contract level", () => {
  const cases = [
    (value) => { value.unexpected = true; },
    (value) => { value.metadata.unexpected = true; },
    (value) => { value.spec.unexpected = true; },
    (value) => { value.spec.artifacts[0].unexpected = true; },
  ];
  for (const mutate of cases) {
    const value = rollout();
    mutate(value);
    assert.throws(
      () => normalizeEdgeRollout(value),
      (error) => error.name === "SecurityError"
        && error.code === "INVALID_ROLLOUT"
        && /unknown field/u.test(error.message),
    );
  }
});

test("EdgeRollout accepts only canonical absolute artifact paths", () => {
  const unsafe = [
    "relative/service.conf",
    "/",
    "/srv//example/service.conf",
    "/srv/./example/service.conf",
    "/srv/example/../service.conf",
    "/srv/example/service.conf/",
    "/srv/example/service conf",
    "/srv/example\\service.conf",
    `/srv/example/service\u0000.conf`,
    `/srv/${"a".repeat(256)}/service.conf`,
  ];
  for (const pathname of unsafe) {
    const value = rollout();
    value.spec.artifacts[0].path = pathname;
    assert.throws(
      () => normalizeEdgeRollout(value),
      /canonical absolute artifact path/u,
      pathname,
    );
  }
});

test("EdgeRollout requires exact artifact digest, identity, mode, and type", () => {
  const mutations = [
    (entry) => { entry.sha256 = "A".repeat(64); },
    (entry) => { entry.sha256 = "a".repeat(63); },
    (entry) => { entry.owner = "ServiceUser"; },
    (entry) => { entry.group = "service:group"; },
    (entry) => { entry.mode = "640"; },
    (entry) => { entry.mode = "0660"; },
    (entry) => { entry.mode = "0602"; },
    (entry) => { entry.type = "directory"; },
    (entry) => { delete entry.owner; },
    (entry) => { delete entry.group; },
    (entry) => { delete entry.mode; },
    (entry) => { delete entry.type; },
  ];
  for (const mutate of mutations) {
    const value = rollout();
    mutate(value.spec.artifacts[0]);
    assert.throws(() => normalizeEdgeRollout(value), { name: "SecurityError" });
  }
});

test("EdgeRollout rejects duplicate artifact IDs and paths independently", () => {
  const duplicateId = rollout();
  duplicateId.spec.artifacts[1].id = duplicateId.spec.artifacts[0].id;
  assert.throws(
    () => normalizeEdgeRollout(duplicateId),
    (error) => error.code === "DUPLICATE_CLAIM" && /artifact id/u.test(error.message),
  );

  const duplicatePath = rollout();
  duplicatePath.spec.artifacts[1].path = duplicatePath.spec.artifacts[0].path;
  assert.throws(
    () => normalizeEdgeRollout(duplicatePath),
    (error) => error.code === "DUPLICATE_CLAIM" && /artifact path/u.test(error.message),
  );

  const sameContentAtDifferentPaths = rollout();
  sameContentAtDifferentPaths.spec.artifacts[1].sha256 =
    sameContentAtDifferentPaths.spec.artifacts[0].sha256;
  assert.doesNotThrow(() => normalizeEdgeRollout(sameContentAtDifferentPaths));
});

test("EdgeRollout JSON Schema mirrors the bounded public shape", async () => {
  const schemaUrl = new URL("../schemas/edge-rollout.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.apiVersion.const, EDGE_ROLLOUT_API_VERSION);
  assert.equal(schema.properties.kind.const, EDGE_ROLLOUT_KIND);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.metadata.additionalProperties, false);
  assert.equal(schema.properties.spec.additionalProperties, false);
  const deploymentIdPattern = new RegExp(
    schema.properties.spec.properties.deploymentId.pattern,
    "u",
  );
  assert.match("Rollout_2026.08~29-01", deploymentIdPattern);
  assert.doesNotMatch("rollout:20260829-001", deploymentIdPattern);
  assert.equal(schema.$defs.artifact.additionalProperties, false);
  assert.deepEqual(
    new Set(schema.$defs.artifact.required),
    new Set(["id", "path", "sha256", "owner", "group", "mode", "type"]),
  );
  assert.equal(schema.$defs.artifact.properties.type.const, EDGE_ROLLOUT_ARTIFACT_TYPE);
});
