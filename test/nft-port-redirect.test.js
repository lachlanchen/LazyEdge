import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderPortRedirectHelper } from "../src/systemd.js";

const fixtureUrl = new URL("./fixtures/ops-sshem-sanitized.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

async function writeFlag(filePath, enabled) {
  await writeFile(filePath, enabled ? "1\n" : "0\n");
}

test("native nft redirect helper accepts live tagged rules and boots from empty state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazyedge-nft-helper-"));
  try {
    const nftPath = path.join(directory, "nft");
    const helperPath = path.join(directory, "redirect-helper.sh");
    const tablePath = path.join(directory, "table.exists");
    const preroutingExistsPath = path.join(directory, "prerouting.exists");
    const outputExistsPath = path.join(directory, "output.exists");
    const preroutingPath = path.join(directory, "prerouting.rules");
    const outputPath = path.join(directory, "output.rules");
    const nextHandlePath = path.join(directory, "next-handle");
    const mutationPath = path.join(directory, "mutations.log");
    const extraRulesetPath = path.join(directory, "extra-ruleset.nft");
    const extraNatPath = path.join(directory, "extra-ip-nat.nft");
    const helper = renderPortRedirectHelper(fixture, {
      nftPath,
      runtimeDirectory: directory,
    });
    const ownershipTag = /^ownership_tag=(lazyedge-[a-f0-9]{16})$/mu.exec(helper)?.[1];
    assert.ok(ownershipTag);
    assert.doesNotMatch(helper, /iptables(?:-save)?/u);
    await writeFile(helperPath, helper, { mode: 0o700 });

    const fakeNft = [
      "#!/bin/bash",
      "set -eu",
      "flag() { test \"$(cat \"$1\")\" = 1; }",
      "if test \"$1\" = --stateless; then",
      "  test \"$2\" = --handle && test \"$3\" = --numeric || exit 8",
      "  test \"$4\" = list || exit 8",
      "  if test \"$5\" = ruleset; then",
      "    if flag \"$FAKE_TABLE\"; then",
      "      printf 'table ip nat {\\n'",
      "      if flag \"$FAKE_PREROUTING_EXISTS\"; then",
      "        priority=-100",
      "        test -z \"$FAKE_BAD_PREROUTING\" || priority=-90",
      "        printf '\\tchain PREROUTING {\\n\\t\\ttype nat hook prerouting priority %s; policy accept;\\n\\t}\\n' \"$priority\"",
      "      fi",
      "      if flag \"$FAKE_OUTPUT_EXISTS\"; then",
      "        priority=-100",
      "        test -z \"$FAKE_BAD_OUTPUT\" || priority=-90",
      "        printf '\\tchain OUTPUT {\\n\\t\\ttype nat hook output priority %s; policy accept;\\n\\t}\\n' \"$priority\"",
      "      fi",
      "      cat \"$FAKE_EXTRA_IP_NAT\"",
      "      printf '}\\n'",
      "    fi",
      "    cat \"$FAKE_EXTRA_RULESET\"",
      "    exit 0",
      "  fi",
      "  if test \"$5\" = table; then",
      "    test \"$6\" = ip && test \"$7\" = nat || exit 8",
      "    flag \"$FAKE_TABLE\" || exit 1",
      "    printf 'table ip nat {}\\n'",
      "    exit 0",
      "  fi",
      "  test \"$5\" = chain && test \"$6\" = ip && test \"$7\" = nat || exit 8",
      "  flag \"$FAKE_TABLE\" || exit 1",
      "  chain=$8",
      "  case \"$chain\" in",
      "    PREROUTING)",
      "      flag \"$FAKE_PREROUTING_EXISTS\" || exit 1",
      "      hook=prerouting",
      "      state=$FAKE_PREROUTING",
      "      ;;",
      "    OUTPUT)",
      "      flag \"$FAKE_OUTPUT_EXISTS\" || exit 1",
      "      hook=output",
      "      state=$FAKE_OUTPUT",
      "      ;;",
      "    *) exit 8 ;;",
      "  esac",
      "  priority=-100",
      "  if test \"$chain\" = PREROUTING; then",
      "    test -z \"$FAKE_BAD_PREROUTING\" || priority=-90",
      "  else",
      "    test -z \"$FAKE_BAD_OUTPUT\" || priority=-90",
      "  fi",
      "  printf 'table ip nat {\\n\\tchain %s { # handle 1\\n' \"$chain\"",
      "  printf '\\t\\ttype nat hook %s priority %s; policy accept;\\n' \"$hook\" \"$priority\"",
      "  cat \"$state\"",
      "  printf '\\t}\\n}\\n'",
      "  exit 0",
      "fi",
      "if test \"$1\" = --check; then",
      "  test \"$2\" = --file && test -f \"$3\" || exit 8",
      "  if test -n \"$FAKE_SIGNAL_CHECK\"; then",
      "    kill -TERM \"$PPID\"",
      "    exit 0",
      "  fi",
      "  test -z \"$FAKE_FAIL_CHECK\" || exit 9",
      "  exit 0",
      "fi",
      "test \"$1\" = --file && test -f \"$2\" || exit 8",
      "test -z \"$FAKE_FAIL_APPLY\" || exit 9",
      "batch=$2",
      "for source in \"$FAKE_TABLE\" \"$FAKE_PREROUTING_EXISTS\" \"$FAKE_OUTPUT_EXISTS\" \"$FAKE_PREROUTING\" \"$FAKE_OUTPUT\" \"$FAKE_NEXT_HANDLE\"; do",
      "  cp \"$source\" \"$source.stage\"",
      "done",
      "next_handle=$(cat \"$FAKE_NEXT_HANDLE.stage\")",
      "while IFS= read -r line; do",
      "  test -n \"$line\" || continue",
      "  set -- $line",
      "  operation=$1",
      "  object=$2",
      "  if test \"$operation $object\" = \"add table\"; then",
      "    printf '1\\n' >\"$FAKE_TABLE.stage\"",
      "    continue",
      "  fi",
      "  chain=$5",
      "  case \"$chain\" in",
      "    PREROUTING)",
      "      exists=$FAKE_PREROUTING_EXISTS.stage",
      "      state=$FAKE_PREROUTING.stage",
      "      ;;",
      "    OUTPUT)",
      "      exists=$FAKE_OUTPUT_EXISTS.stage",
      "      state=$FAKE_OUTPUT.stage",
      "      ;;",
      "    *) exit 8 ;;",
      "  esac",
      "  if test \"$operation $object\" = \"add chain\"; then",
      "    printf '1\\n' >\"$exists\"",
      "    continue",
      "  fi",
      "  case \"$operation $object\" in",
      "    \"add rule\")",
      "      shift 5",
      "      printf '\\t\\t%s # handle %s\\n' \"$*\" \"$next_handle\" >>\"$state\"",
      "      next_handle=$((next_handle + 1))",
      "      ;;",
      "    \"delete rule\")",
      "      handle=$7",
      "      awk -v handle=\"$handle\" '$0 !~ (\"# handle \" handle \"$\") { print }' \"$state\" >\"$state.next\"",
      "      mv \"$state.next\" \"$state\"",
      "      ;;",
      "    *) exit 8 ;;",
      "  esac",
      "done <\"$batch\"",
      "printf '%s\\n' \"$next_handle\" >\"$FAKE_NEXT_HANDLE.stage\"",
      "for target in \"$FAKE_TABLE\" \"$FAKE_PREROUTING_EXISTS\" \"$FAKE_OUTPUT_EXISTS\" \"$FAKE_PREROUTING\" \"$FAKE_OUTPUT\" \"$FAKE_NEXT_HANDLE\"; do",
      "  mv \"$target.stage\" \"$target\"",
      "done",
      "cat \"$batch\" >>\"$FAKE_MUTATIONS\"",
      "",
    ].join("\n");
    await writeFile(nftPath, fakeNft, { mode: 0o700 });

    const environment = {
      ...process.env,
      FAKE_TABLE: tablePath,
      FAKE_PREROUTING_EXISTS: preroutingExistsPath,
      FAKE_OUTPUT_EXISTS: outputExistsPath,
      FAKE_PREROUTING: preroutingPath,
      FAKE_OUTPUT: outputPath,
      FAKE_NEXT_HANDLE: nextHandlePath,
      FAKE_MUTATIONS: mutationPath,
      FAKE_EXTRA_RULESET: extraRulesetPath,
      FAKE_EXTRA_IP_NAT: extraNatPath,
      FAKE_FAIL_CHECK: "",
      FAKE_FAIL_APPLY: "",
      FAKE_SIGNAL_CHECK: "",
      FAKE_BAD_PREROUTING: "",
      FAKE_BAD_OUTPUT: "",
    };
    const unrelated = "\t\ttcp dport 81 counter redirect to :18081 # handle 10\n";
    const livePrerouting = unrelated
      + "\t\ttcp dport 80 counter redirect to :10080 comment \""
      + ownershipTag
      + "\" # handle 21\n"
      + "\t\ttcp dport 443 redirect to :10443 comment \""
      + ownershipTag
      + "\" # handle 22\n";
    const liveOutput = "\t\tip daddr 127.0.0.1 tcp dport 80 counter redirect to :10080 comment \""
      + ownershipTag
      + "\" # handle 23\n"
      + "\t\tip daddr 127.0.0.1 tcp dport 443 redirect to :10443 comment \""
      + ownershipTag
      + "\" # handle 24\n";

    await writeFlag(tablePath, true);
    await writeFlag(preroutingExistsPath, true);
    await writeFlag(outputExistsPath, true);
    await writeFile(preroutingPath, livePrerouting);
    await writeFile(outputPath, liveOutput);
    await writeFile(nextHandlePath, "100\n");
    await writeFile(mutationPath, "");
    await writeFile(extraRulesetPath, "");
    await writeFile(extraNatPath, "");

    const liveStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(liveStart.status, 0, liveStart.stderr);
    assert.equal(await readFile(mutationPath, "utf8"), "");
    assert.equal(await readFile(preroutingPath, "utf8"), livePrerouting);
    assert.equal(await readFile(outputPath, "utf8"), liveOutput);
    const liveStatus = spawnSync("/bin/bash", [helperPath, "status"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(liveStatus.status, 0, liveStatus.stderr);

    const stopped = spawnSync("/bin/bash", [helperPath, "stop"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stderr, /previous mappings are not restored/u);
    assert.equal(await readFile(preroutingPath, "utf8"), unrelated);
    assert.equal(await readFile(outputPath, "utf8"), "");

    await writeFlag(tablePath, false);
    await writeFlag(preroutingExistsPath, false);
    await writeFlag(outputExistsPath, false);
    await writeFile(preroutingPath, "");
    await writeFile(outputPath, "");
    await writeFile(mutationPath, "");
    const failedEmptyStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: { ...environment, FAKE_FAIL_APPLY: "1" },
      encoding: "utf8",
    });
    assert.notEqual(failedEmptyStart.status, 0);
    assert.equal(await readFile(tablePath, "utf8"), "0\n");
    assert.equal(await readFile(preroutingPath, "utf8"), "");
    assert.equal(await readFile(outputPath, "utf8"), "");
    assert.equal(await readFile(mutationPath, "utf8"), "");

    const emptyStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(emptyStart.status, 0, emptyStart.stderr);
    assert.equal(await readFile(tablePath, "utf8"), "1\n");
    assert.equal(await readFile(preroutingExistsPath, "utf8"), "1\n");
    assert.equal(await readFile(outputExistsPath, "utf8"), "1\n");
    const createdRules = (await readFile(preroutingPath, "utf8"))
      + (await readFile(outputPath, "utf8"));
    assert.equal((createdRules.match(new RegExp(ownershipTag, "gu")) ?? []).length, 4);
    const mutations = await readFile(mutationPath, "utf8");
    assert.match(mutations, /^add table ip nat$/mu);
    assert.match(mutations, /^add chain ip nat PREROUTING /mu);
    assert.match(mutations, /^add chain ip nat OUTPUT /mu);
    assert.equal(spawnSync("/bin/bash", [helperPath, "status"], {
      env: environment,
      encoding: "utf8",
    }).status, 0);

    await writeFlag(tablePath, true);
    await writeFlag(preroutingExistsPath, true);
    await writeFlag(outputExistsPath, false);
    await writeFile(preroutingPath, unrelated);
    await writeFile(outputPath, "");
    await writeFile(mutationPath, "");
    const missingChainStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(missingChainStart.status, 0, missingChainStart.stderr);
    assert.match(await readFile(preroutingPath, "utf8"), /tcp dport 81/u);
    const missingChainMutations = await readFile(mutationPath, "utf8");
    assert.doesNotMatch(missingChainMutations, /^add table /mu);
    assert.doesNotMatch(missingChainMutations, /^add chain ip nat PREROUTING /mu);
    assert.match(missingChainMutations, /^add chain ip nat OUTPUT /mu);
    assert.equal(spawnSync("/bin/bash", [helperPath, "status"], {
      env: environment,
      encoding: "utf8",
    }).status, 0);

    const provenDisjoint = [
      "\t\ttcp dport { 81, 82 } redirect to :18081 # handle 250",
      "\t\ttcp dport 81-442 jump CHILD # handle 251",
      "\t\tudp dport { 80, 443 } redirect to :18082 # handle 252",
      "",
    ].join("\n");
    await writeFlag(outputExistsPath, true);
    await writeFile(preroutingPath, provenDisjoint);
    await writeFile(outputPath, "");
    await writeFile(mutationPath, "");
    const disjointStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(disjointStart.status, 0, disjointStart.stderr);
    assert.match(await readFile(preroutingPath, "utf8"), /tcp dport \{ 81, 82 \}/u);
    assert.equal(spawnSync("/bin/bash", [helperPath, "status"], {
      env: environment,
      encoding: "utf8",
    }).status, 0);

    const conflict = "\t\tip saddr 10.0.0.0/8 tcp dport 80 counter redirect to :10080 comment \""
      + ownershipTag
      + "\" # handle 301\n";
    await writeFile(preroutingPath, conflict);
    await writeFile(outputPath, "");
    const conflictStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(conflictStart.status, 0);
    assert.match(conflictStart.stderr, /overlapping or unprovable NAT rule/u);
    assert.equal(await readFile(preroutingPath, "utf8"), conflict);

    const substring = "\t\ttcp dport 80 counter redirect to :10080 comment \"prefix-"
      + ownershipTag
      + "-suffix\" # handle 302\n";
    await writeFile(preroutingPath, substring);
    const substringStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(substringStart.status, 0);
    assert.match(substringStart.stderr, /overlapping or unprovable NAT rule/u);
    const substringStop = spawnSync("/bin/bash", [helperPath, "stop"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(substringStop.status, 0, substringStop.stderr);
    assert.equal(await readFile(preroutingPath, "utf8"), substring);

    const overlapCases = [
      ["anonymous set", "\t\ttcp dport { 80, 443 } redirect to :10080 # handle 401\n"],
      ["range", "\t\ttcp dport 80-443 redirect to :10080 # handle 402\n"],
      ["unconditional redirect", "\t\tredirect # handle 403\n"],
      ["unconditional jump", "\t\tjump CHILD # handle 404\n"],
      ["named set", "\t\ttcp dport @webports redirect to :10080 # handle 405\n"],
      ["verdict map", "\t\ttcp dport vmap { 80 : jump CHILD } # handle 406\n"],
    ];
    await writeFile(extraRulesetPath, "");
    for (const [label, rule] of overlapCases) {
      await writeFlag(tablePath, true);
      await writeFlag(preroutingExistsPath, true);
      await writeFlag(outputExistsPath, true);
      await writeFile(preroutingPath, rule);
      await writeFile(outputPath, "");
      await writeFile(mutationPath, "");
      const result = spawnSync("/bin/bash", [helperPath, "start"], {
        env: environment,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, /overlapping or unprovable NAT rule/u, label);
      assert.equal(await readFile(preroutingPath, "utf8"), rule, label);
      assert.equal(await readFile(mutationPath, "utf8"), "", label);
    }

    const wrongChainCases = [
      [
        "PREROUTING owned shape in OUTPUT",
        "",
        `\t\ttcp dport 80 counter redirect to :10080 comment "${ownershipTag}" # handle 407\n`,
      ],
      [
        "OUTPUT owned shape in PREROUTING",
        `\t\tip daddr 127.0.0.1 tcp dport 443 redirect to :10443 comment "${ownershipTag}" # handle 408\n`,
        "",
      ],
    ];
    for (const [label, prerouting, output] of wrongChainCases) {
      await writeFile(preroutingPath, prerouting);
      await writeFile(outputPath, output);
      await writeFile(mutationPath, "");
      const result = spawnSync("/bin/bash", [helperPath, "start"], {
        env: environment,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, /overlapping or unprovable NAT rule/u, label);
      assert.equal(await readFile(preroutingPath, "utf8"), prerouting, label);
      assert.equal(await readFile(outputPath, "utf8"), output, label);
      assert.equal(await readFile(mutationPath, "utf8"), "", label);
    }

    await writeFile(extraNatPath, [
      "\tchain CHILD {",
      "\t\ttcp dport 80 redirect to :10090",
      "\t}",
      "",
    ].join("\n"));
    await writeFile(preroutingPath, "\t\tjump CHILD # handle 408\n");
    const subchainRedirect = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(subchainRedirect.status, 0);
    assert.match(subchainRedirect.stderr, /overlapping or unprovable NAT rule/u);
    await writeFile(extraNatPath, "");

    const duplicate = livePrerouting
      + "\t\ttcp dport 80 counter redirect to :10080 comment \""
      + ownershipTag
      + "\" # handle 407\n";
    await writeFile(preroutingPath, duplicate);
    await writeFile(outputPath, liveOutput);
    const duplicateStart = spawnSync("/bin/bash", [helperPath, "start"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(duplicateStart.status, 0);
    assert.match(duplicateStart.stderr, /duplicate owned NAT rule/u);

    await writeFile(preroutingPath, livePrerouting);
    const incompatibleBase = spawnSync("/bin/bash", [helperPath, "start"], {
      env: { ...environment, FAKE_BAD_PREROUTING: "1" },
      encoding: "utf8",
    });
    assert.notEqual(incompatibleBase.status, 0);
    assert.match(incompatibleBase.stderr, /incompatible nft base chain PREROUTING/u);

    await writeFile(extraRulesetPath, [
      "table inet competing {",
      "\tchain EDGE {",
      "\t\ttype nat hook prerouting priority -90; policy accept;",
      "\t}",
      "}",
      "",
    ].join("\n"));
    const competingRuleset = spawnSync(nftPath, [
      "--stateless",
      "--handle",
      "--numeric",
      "list",
      "ruleset",
    ], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(competingRuleset.status, 0, competingRuleset.stderr);
    assert.match(competingRuleset.stdout, /table inet competing/u);
    const competingBase = spawnSync("/bin/bash", [helperPath, "status"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(competingBase.status, 0, competingBase.stderr);
    assert.match(competingBase.stderr, /competing nft NAT base chain/u);
    await writeFile(extraRulesetPath, "");

    await writeFile(extraNatPath, [
      "\tchain OTHER {",
      "\t\ttype nat hook output priority -90; policy accept;",
      "\t}",
      "",
    ].join("\n"));
    const sameTableCompetingBase = spawnSync("/bin/bash", [helperPath, "status"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(sameTableCompetingBase.status, 0);
    assert.match(sameTableCompetingBase.stderr, /competing nft NAT base chain/u);
    await writeFile(extraNatPath, "");

    await writeFlag(tablePath, false);
    await writeFlag(preroutingExistsPath, false);
    await writeFlag(outputExistsPath, false);
    await writeFile(preroutingPath, "");
    await writeFile(outputPath, "");
    await writeFile(mutationPath, "");
    const failedCheck = spawnSync("/bin/bash", [helperPath, "start"], {
      env: { ...environment, FAKE_FAIL_CHECK: "1" },
      encoding: "utf8",
    });
    assert.notEqual(failedCheck.status, 0);
    assert.equal(await readFile(mutationPath, "utf8"), "");
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith("lazyedge-nft.")),
      [],
    );

    const interruptedCheck = spawnSync("/bin/bash", [helperPath, "start"], {
      env: { ...environment, FAKE_SIGNAL_CHECK: "1" },
      encoding: "utf8",
    });
    assert.equal(interruptedCheck.status, 130, interruptedCheck.stderr);
    assert.equal(await readFile(mutationPath, "utf8"), "");
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith("lazyedge-nft.")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
