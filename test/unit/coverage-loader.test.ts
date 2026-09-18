import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { mergeCoverage } from "../../scripts/merge-coverage.ts";
import { parseLcov } from "../../scripts/coverage-gate.ts";

it("real TSX and Pi-loader coverage retains separate maps and merges lines without discarding function obligations", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-coverage-loader-"));
  try {
    const raw = join(root, "raw.lcov");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--import=${resolve("scripts/coverage-register.mjs")}`, NODE_V8_COVERAGE: join(root, "v8") };
    // This is an independent coverage probe, not a Node test-runner worker.
    // Inheriting child-v8 suppresses its requested standalone reporter output.
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--experimental-test-isolation=none", "--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${raw}`, "test/e2e/extension-load.test.ts", "test/unit/abandoned-owner-recovery.test.ts"], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 50_000,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const input = await readFile(raw, "utf8");
    const records = input.split("end_of_record").filter((record) => /^SF:src\/abandoned-owner-recovery.ts$/m.test(record));
    assert.equal(records.length, 2, "distinct generated script URLs retain independent source maps");
    const merged = mergeCoverage(input); assert.equal(mergeCoverage(merged), merged);
    const counts = parseLcov(merged).get("src/abandoned-owner-recovery.ts")!;
    const sourceCounts = records.map((record) => parseLcov(`${record}\nend_of_record\n`).get("src/abandoned-owner-recovery.ts")!);
    for (const key of ["functions", "branches"] as const) {
      assert.equal(counts[key].found, sourceCounts.reduce((sum, source) => sum + source[key].found, 0));
      assert.equal(counts[key].hit, sourceCounts.reduce((sum, source) => sum + source[key].hit, 0));
    }
    const lineHits = new Map<number, number>();
    for (const record of records) for (const match of record.matchAll(/^DA:(\d+),(\d+)$/gm)) lineHits.set(Number(match[1]), (lineHits.get(Number(match[1])) ?? 0) + Number(match[2]));
    assert.equal(counts.lines.found, lineHits.size); assert.equal(counts.lines.hit, [...lineHits.values()].filter((count) => count > 0).length);
    assert.ok(counts.lines.hit >= 80, "executed function bodies are no longer overwritten by another compiler's map");
    assert.throws(() => parseLcov(input), /duplicate source record/, "the ratchet still rejects unnormalized duplicate records");
  } finally { await rm(root, { recursive: true, force: true }); }
});
