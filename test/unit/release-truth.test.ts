import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("release contract truth", () => {
  it("documents the safe Pi 0.84.2 reload handoff", async () => {
    const readme = await text("README.md");
    assert.match(readme, /await ctx\.reload\(\); return;/i);
    assert.match(readme, /sendUserMessage\([\s\S]*\/reload-runtime[\s\S]*deliverAs[\s\S]*followUp[\s\S]*expandPromptTemplates[\s\S]*true/i);
    assert.doesNotMatch(readme, /extension-originated slash messages cannot safely defer/i);
  });

  it("keeps the unpublished initial release candidate entirely under Unreleased", async () => {
    const readme = await text("README.md");
    const changelog = await text("CHANGELOG.md");
    assert.match(readme, /unpublished `0\.1\.0` release candidate/i);
    assert.match(changelog, /## \[Unreleased\][\s\S]*Initial `0\.1\.0` release candidate \(unpublished\)/i);
    assert.doesNotMatch(changelog, /^## \[0\.1\.0\](?:\s|$)/im);
    assert.doesNotMatch(changelog, /compare\/v0\.1\.0|releases\/tag\/v0\.1\.0|initial release uses tag `v0\.1\.0`/i);
  });

  it("describes registered-provider readiness as a public availability check, not a refresh receipt", async () => {
    const runtimeSource = await text("src/model-runtime.ts");
    assert.match(runtimeSource, /public post-registration availability\/auth check/i);
    assert.doesNotMatch(runtimeSource, /coalesces that exact pending refresh|pending refresh is joined|joined available set/i);

    const currentDocs = [
      "README.md",
      "CHANGELOG.md",
      "SECURITY.md",
      ...(await readdir("docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
    ];
    const staleRefreshReceipt = /(?:getAvailable(?:\([^)]*\))?[\s\S]{0,160}(?:join\w*|coalesc\w*)[\s\S]{0,160}(?:pending|refresh)|(?:pending|refresh)[\s\S]{0,160}(?:join\w*|coalesc\w*)[\s\S]{0,160}getAvailable(?:\([^)]*\))?)/i;
    for (const path of currentDocs) {
      assert.doesNotMatch(await text(path), staleRefreshReceipt, path);
    }
  });

  it("states removed nested delegation and exact-dead-owner automatic reclaim without obsolete release claims", async () => {
    const changelog = await text("CHANGELOG.md");
    const unreleased = changelog.split("## [0.1.0]", 1)[0]!;
    assert.match(unreleased, /Removed the disabled nested-delegation subsystem/i);
    assert.match(unreleased, /automatically reclaim.*exact dead.*owner|exact dead.*owner.*automatically reclaim/is);
    assert.match(unreleased, /live.*SIGSTOP.*fail-closed/is);
    assert.doesNotMatch(unreleased, /explicitly opted-in child requests|opt-in parent parking|canSpawn` now means subagent delegation permission/i);
    assert.doesNotMatch(unreleased, /unless the user explicitly accepts|late replies arrive automatically/i);
  });

  it("documents conservative custom-tool capability and both raw/effective tool-list limits", async () => {
    const config = await text("docs/configuration.md");
    assert.match(config, /unknown\/custom.*tool.*conservative.*writable.*effect-capable/i);
    assert.match(config, /source tools array.*at most 128 raw items/i);
    assert.match(config, /effective set.*at most 128 unique names.*required mail tools/i);
    assert.match(config, /available-model.*6 KiB.*52 lines.*48 entries.*partial/i);
  });

  it("documents exact-dead-owner automatic reclaim and removes cleanup recovery surfaces", async () => {
    for (const path of ["README.md", "docs/README.md", "docs/lifecycle.md", "docs/manage-agent.md", "docs/inspect-agent.md"]) {
      const value = await text(path);
      assert.doesNotMatch(value, /manage_agent recover_cleanup|\/agents recover-cleanup|operatorEvidence|cleanup-recovery\.guard/i, path);
    }
    for (const path of ["README.md", "docs/lifecycle.md"]) {
      const value = await text(path);
      assert.match(value, /exact.*owner.*dead[\s\S]{0,100}startup automatically reclaim|automatically reclaim.*exact.*dead.*owner/is, path);
      assert.match(value, /live.*SIGSTOP.*fail-closed|live or `SIGSTOP`ed.*reject/is, path);
      assert.match(value, /exact live owner[\s\S]*(?:do not|never) delete[\s\S]*same parent session[\s\S]*explicitly restart/is, path);
      assert.match(value, /preserv.*(?:session|mailbox)/i, path);
      assert.match(value, /clone.*fresh mailbox.*cannot recover.*obligations/i, path);
      assert.doesNotMatch(value, /\bPID\s+\d+|current generation \d+ case/i, path);
    }
    const manage = await text("src/main-tools.ts");
    assert.doesNotMatch(manage, /recover_cleanup|operatorEvidence|recoveryStatus/);
    await assert.rejects(text("src/cleanup-recovery.ts"), /ENOENT/);
    await assert.rejects(text("src/confirmed-cleanup-recovery.ts"), /ENOENT/);
  });

  it("documents session/tool cleanup and detached-process scope", async () => {
    for (const path of ["README.md", "SECURITY.md", "docs/lifecycle.md", "docs/manage-agent.md"]) {
      const value = await text(path);
      assert.match(value, /AgentSession|Pi session\/tool/i, path);
      assert.match(value, /not an OS sandbox|outside.*stop semantics/i, path);
      assert.match(value, /do not start background or detached processes unless.*explicitly requires/i, path);
      assert.match(value, /report how it is stopped/i, path);
    }
  });

  it("records the exact production audit inside full-range release evidence", async () => {
    const script = await text("scripts/release-evidence.ts");
    assert.match(script, /\["audit", "--omit=dev", "--omit=peer"\]/);
    assert.match(script, /production-audit\.log/);
    assert.match(script, /candidate !== originMain.*not pushed origin\/main/s);
    assert.match(script, /status.*--porcelain=v1.*requires a clean worktree and index/s);
    assert.match(script, /productionAudit/);
  });

});
