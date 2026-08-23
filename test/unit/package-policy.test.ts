import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PACKAGE_MAX_ENTRIES,
  PACKAGE_MAX_SIZE_BYTES,
  assertPackageMarkdownLinks,
  assertPackageSurface,
  type PackResult,
} from "../../scripts/package-policy.ts";

const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "src/index.ts",
];

function pack(overrides: Partial<PackResult> = {}): PackResult {
  const filler = Array.from(
    { length: PACKAGE_MAX_ENTRIES - REQUIRED.length },
    (_, index) => ({ path: `src/filler-${index}.ts` }),
  );
  return {
    filename: "pi-email-subagent-0.1.0.tgz",
    entryCount: PACKAGE_MAX_ENTRIES,
    size: PACKAGE_MAX_SIZE_BYTES,
    files: [...REQUIRED.map((path) => ({ path })), ...filler],
    ...overrides,
  };
}

describe("authoritative npm package surface policy", () => {
  it("accepts the exact entry and tarball size bounds", () => {
    assert.doesNotThrow(() => assertPackageSurface(pack()));
  });

  it("rejects either bound by one", () => {
    assert.throws(() => assertPackageSurface(pack({ entryCount: PACKAGE_MAX_ENTRIES + 1 })), /entry count/);
    assert.throws(() => assertPackageSurface(pack({ size: PACKAGE_MAX_SIZE_BYTES + 1 })), /tarball size/);
  });

  it("rejects every forbidden internal path prefix", () => {
    for (const path of ["test/private.test.ts", "scripts/internal.ts", ".github/workflows/ci.yml", "plans/internal-plan.md"]) {
      assert.throws(
        () => assertPackageSurface(pack({ files: [...pack().files.slice(0, -1), { path }] })),
        new RegExp(`Forbidden packed file.*${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    }
  });

  it("rejects package-local Markdown links to files omitted from the artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-package-links-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "[guide](docs/guide.md) [internal](plans/internal.md)\n");
    await writeFile(join(root, "docs", "guide.md"), "[home](../README.md)\n");
    const linkedPack = pack({ files: [{ path: "README.md" }, { path: "docs/guide.md" }] });
    await assert.rejects(assertPackageMarkdownLinks(linkedPack, root), /README\.md.*plans\/internal\.md/);
  });
});
