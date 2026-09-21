import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PACKAGE_MAX_ENTRIES, PACKAGE_MAX_SIZE_BYTES, PACKAGE_MAX_UNPACKED_BYTES, PACKAGE_PATHS,
  assertPackageMarkdownLinks, assertPackageSurface, type PackResult,
} from "../../scripts/package-policy.ts";

function pack(overrides: Partial<PackResult> = {}): PackResult {
  return { filename: "pi-email-subagent-0.1.0.tgz", entryCount: PACKAGE_PATHS.length,
    size: PACKAGE_MAX_SIZE_BYTES, unpackedSize: PACKAGE_MAX_UNPACKED_BYTES,
    files: PACKAGE_PATHS.map((path) => ({ path })), ...overrides };
}

describe("authoritative npm package surface policy", () => {
  it("keeps the original ceilings and the exact 59-file runtime/documentation inventory", () => {
    assert.equal(PACKAGE_MAX_ENTRIES, 60);
    assert.equal(PACKAGE_MAX_SIZE_BYTES, 220_000);
    assert.equal(PACKAGE_MAX_UNPACKED_BYTES, 850_000);
    assert.equal(PACKAGE_PATHS.length, 59);
    assert.doesNotThrow(() => assertPackageSurface(pack()));
    assert.doesNotThrow(() => assertPackageSurface(pack({ size: 214634, unpackedSize: 795220 })));
    assert.throws(() => assertPackageSurface(pack({ size: 220060, unpackedSize: 807752 })), /tarball size/, "the retained CI overage is not authorized by a larger ceiling");
    assert.throws(() => assertPackageSurface(pack({ entryCount: 60, files: [...pack().files, { path: "src/surprise.ts" }] })), /inventory differs/);
  });
  it("rejects each bound by one and malformed sizes", () => {
    assert.throws(() => assertPackageSurface(pack({ entryCount: PACKAGE_MAX_ENTRIES + 1 })), /entry count/);
    assert.throws(() => assertPackageSurface(pack({ size: PACKAGE_MAX_SIZE_BYTES + 1 })), /tarball size/);
    assert.throws(() => assertPackageSurface(pack({ unpackedSize: PACKAGE_MAX_UNPACKED_BYTES + 1 })), /unpacked size/);
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
      assert.throws(() => assertPackageSurface(pack({ size: value })), /tarball size/);
      assert.throws(() => assertPackageSurface(pack({ unpackedSize: value })), /unpacked size/);
    }
  });
  it("rejects every forbidden internal path and unreviewed src/docs substitutions", () => {
    for (const path of ["test/private.test.ts", "scripts/internal.ts", ".github/workflows/ci.yml", "plans/internal-plan.md", "src/python/__pycache__/file.pyc", "src/python/file.pyo"]) {
      assert.throws(() => assertPackageSurface(pack({ files: [...pack().files.slice(0, -1), { path }] })), /Forbidden packed file/);
    }
    for (const path of ["src/surprise.ts", "docs/surprise.md", "docs/mechanistic-subagents.md", "docs/mechanistic-subagents-review.md", PACKAGE_PATHS[0]]) {
      assert.throws(() => assertPackageSurface(pack({ files: [...pack().files.slice(0, -1), { path }] })), /inventory differs/);
    }
    assert.throws(() => assertPackageSurface(pack({ files: pack().files.slice(1), entryCount: PACKAGE_PATHS.length - 1 })), /missing CHANGELOG/);
  });
  it("rejects package-local Markdown links to files omitted from the artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-package-links-"));
    try {
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "README.md"), "[guide](docs/guide.md) [internal](plans/internal.md)\n");
      await writeFile(join(root, "docs", "guide.md"), "[home](../README.md)\n");
      const linkedPack = pack({ files: [{ path: "README.md" }, { path: "docs/guide.md" }] });
      await assert.rejects(assertPackageMarkdownLinks(linkedPack, root), /README\.md.*plans\/internal\.md/);
      await writeFile(join(root, "README.md"), "[guide](docs/guide.md) [historical design](https://github.com/metzzo/pi-email-subagent/blob/main/docs/mechanistic-subagents.md) [historical review](https://github.com/metzzo/pi-email-subagent/blob/main/docs/mechanistic-subagents-review.md)\n");
      await assert.doesNotReject(assertPackageMarkdownLinks(linkedPack, root));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
