import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackedFile {
  path: string;
}

export interface PackResult {
  filename: string;
  entryCount: number;
  size: number;
  files: PackedFile[];
}

export const PACKAGE_MAX_ENTRIES = 50;
export const PACKAGE_MAX_SIZE_BYTES = 200_000;

const REQUIRED_PATHS = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "src/index.ts",
] as const;
const FORBIDDEN_PATH = /^(?:test|scripts|\.github|plans)(?:\/|$)/;
const ALLOWED_ROOT_PATHS = new Set<string>(REQUIRED_PATHS);

export function assertPackageSurface(pack: PackResult): void {
  if (!Number.isInteger(pack.entryCount) || pack.entryCount < 1 || pack.entryCount > PACKAGE_MAX_ENTRIES) {
    throw new Error(`Unexpected package entry count ${pack.entryCount}; maximum is ${PACKAGE_MAX_ENTRIES}.`);
  }
  if (!Number.isInteger(pack.size) || pack.size < 1 || pack.size > PACKAGE_MAX_SIZE_BYTES) {
    throw new Error(`Unexpected package tarball size ${pack.size}; maximum is ${PACKAGE_MAX_SIZE_BYTES} bytes.`);
  }
  if (pack.entryCount !== pack.files.length) {
    throw new Error(`Package entry count ${pack.entryCount} does not match the ${pack.files.length} listed files.`);
  }
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of REQUIRED_PATHS) {
    if (!paths.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }
  const forbidden = pack.files.map((file) => file.path).filter((path) => FORBIDDEN_PATH.test(path));
  if (forbidden.length > 0) throw new Error(`Forbidden packed file(s): ${forbidden.join(", ")}.`);
  const unexpected = pack.files.map((file) => file.path).filter((path) =>
    !ALLOWED_ROOT_PATHS.has(path) && !path.startsWith("src/") && !path.startsWith("docs/"));
  if (unexpected.length > 0) throw new Error(`Unexpected packed file(s): ${unexpected.join(", ")}.`);
}

function localMarkdownTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) {
    targets.push((match[1] ?? match[2] ?? "").trim());
  }
  for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm)) {
    targets.push((match[1] ?? match[2] ?? "").trim());
  }
  return targets.filter((target) => {
    if (!target || target.startsWith("#") || target.startsWith("/")) return false;
    return !/^[a-z][a-z\d+.-]*:/i.test(target);
  });
}

export async function assertPackageMarkdownLinks(pack: PackResult, root: string): Promise<void> {
  const paths = new Set(pack.files.map((file) => file.path));
  for (const source of [...paths].filter((path) => path.toLowerCase().endsWith(".md")).sort()) {
    const markdown = await readFile(join(root, source), "utf8");
    for (const rawTarget of localMarkdownTargets(markdown)) {
      const withoutFragment = rawTarget.split(/[?#]/, 1)[0]!;
      if (!withoutFragment) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(withoutFragment); } catch { decoded = withoutFragment; }
      const target = posix.normalize(posix.join(posix.dirname(source), decoded.replaceAll("\\", "/")));
      if (target === ".." || target.startsWith("../") || !paths.has(target)) {
        throw new Error(`${source} links to package-local path ${rawTarget}, but ${target} is not in the packed artifact.`);
      }
    }
  }
}

export async function checkCurrentPackage(root = resolve(import.meta.dirname, "..")): Promise<PackResult> {
  const temp = await mkdtemp(join(tmpdir(), "pi-email-package-policy-"));
  try {
    const result = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (result.status !== 0) {
      throw new Error(`npm pack failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    const pack = (JSON.parse(result.stdout) as PackResult[])[0];
    if (!pack) throw new Error("npm pack returned no package metadata.");
    assertPackageSurface(pack);
    await assertPackageMarkdownLinks(pack, root);
    return pack;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pack = await checkCurrentPackage();
  console.log(`package policy passed: ${pack.entryCount} files, ${pack.size} bytes`);
}
