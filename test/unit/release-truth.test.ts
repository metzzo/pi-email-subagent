import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("release contract truth", () => {
  it("states disabled nested delegation and manual fail-closed orphan recovery without obsolete release claims", async () => {
    const changelog = await text("CHANGELOG.md");
    const unreleased = changelog.split("## [0.1.0]", 1)[0]!;
    assert.match(unreleased, /nested response-required delegation.*fail-closed disabled/i);
    assert.match(unreleased, /orphan[\s\S]*manual recovery/i);
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

  it("directs orphan-lock operators to manual recovery rather than waiting", async () => {
    for (const path of ["README.md", "docs/README.md", "docs/lifecycle.md"]) {
      const value = await text(path);
      assert.match(value, /orphan[\s\S]{0,300}manual recovery/i, path);
      assert.doesNotMatch(value, /orphan[\s\S]{0,200}(wait for|waiting period)/i, path);
    }
  });

  it("documents exact operator-attested cleanup recovery and the startup-blocked session sequence", async () => {
    for (const path of ["README.md", "docs/README.md", "docs/lifecycle.md", "docs/manage-agent.md", "docs/inspect-agent.md"]) {
      const value = await text(path);
      assert.match(value, /recover.cleanup|recover_cleanup/i, path);
      assert.match(value, /operator-attested|operator attestation/i, path);
      assert.match(value, /not Pi-verified|Pi did not verify/i, path);
      assert.match(value, /capacity pressure.*never authorization/i, path);
    }
    for (const path of ["README.md", "docs/lifecycle.md", "docs/manage-agent.md"]) {
      const value = await text(path);
      assert.match(value, /exit the live owner[\s\S]*resume the same session[\s\S]*startup(?:\s|\*)+fails[\s\S]*recover-cleanup[\s\S]*\/reload[\s\S]*(restart|archive)/i, path);
      assert.match(value, /clone.*fresh mailbox.*(?:does not|cannot).*recover.*old obligations/i, path);
    }
  });

  it("records the exact production audit inside full-range release evidence", async () => {
    const script = await text("scripts/release-evidence.ts");
    assert.match(script, /\["audit", "--omit=dev", "--omit=peer"\]/);
    assert.match(script, /production-audit\.log/);
    assert.match(script, /productionAudit/);
  });

  it("marks remediation plans complete and retains exactly the three upstream capability gates", async () => {
    const overview = await text("plans/remaining-open-problems.md");
    assert.match(overview, /Status: remediation complete/i);
    assert.doesNotMatch(overview, /regeneration in progress|implementation not started/i);
    assert.match(overview, /durable session-presentation receipt/i);
    assert.match(overview, /process-tree quiescence receipt/i);
    assert.match(overview, /mutation-alias identity/i);
    for (const path of [
      "plans/remaining-open-problems/01-mail-obligations.md",
      "plans/remaining-open-problems/02-runtime-provider-boundary.md",
      "plans/remaining-open-problems/03-runtime-truth-and-liveness.md",
      "plans/remaining-open-problems/04-crash-recovery-and-containment.md",
      "plans/remaining-open-problems/05-compatibility-and-release.md",
    ]) {
      const value = await text(path);
      assert.match(value, /Status: (?:remediation )?complete/i, path);
      assert.match(value, /Historical implementation record/i, path);
    }
  });
});
