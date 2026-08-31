import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { checkCoverage, parseLcov, validateThresholdConfig } from "../../scripts/coverage-gate.ts";

const record = (hits = 1): string => `SF:src/a.ts\nLF:1\nLH:${hits}\nFNF:1\nFNH:${hits}\nBRF:1\nBRH:${hits}\nend_of_record\n`;

it("rejects malformed LCOV records", () => {
  assert.throws(() => parseLcov("SF:src/a.ts\nLF:1\nLH:1\nend_of_record\n"), /missing FNF/);
  assert.throws(() => parseLcov(record(2)), /hits exceed found/);
  assert.throws(() => parseLcov("not lcov"), /no source records/);
});

it("strictly validates every coverage threshold field", () => {
  const base = { schemaVersion: 1, excluded: [], files: { "src/a.ts": { lines: 90, functions: 90, branches: 90 } } };
  assert.deepEqual(validateThresholdConfig(base), base);
  for (const invalid of [
    { lines: 90, functions: 90 },
    { lines: -1, functions: 90, branches: 90 },
    { lines: 101, functions: 90, branches: 90 },
    { lines: Number.NaN, functions: 90, branches: 90 },
  ]) {
    assert.throws(() => validateThresholdConfig({ ...base, files: { "src/a.ts": invalid } }), /must be a finite number from 0 to 100/);
  }
});

it("reports a below-threshold source from temporary LCOV/config files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-coverage-gate-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    const lcov = join(root, "coverage.lcov");
    const config = join(root, "thresholds.json");
    await writeFile(lcov, record(0));
    await writeFile(config, JSON.stringify({
      schemaVersion: 1,
      excluded: [],
      files: { "src/a.ts": { lines: 100, functions: 100, branches: 100 } },
    }));
    await assert.rejects(checkCoverage(lcov, config, root), /src\/a\.ts lines: 0\.00% < 100%/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
