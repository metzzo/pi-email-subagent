import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ALLOWED_PRODUCTION_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

interface LockPackage {
  version?: unknown;
  license?: unknown;
  dev?: unknown;
  peer?: unknown;
  link?: unknown;
}

interface PackageLock {
  lockfileVersion?: unknown;
  packages?: unknown;
}

export interface DependencyLicense {
  name: string;
  version: string;
  license: string;
  path: string;
}

function dependencyName(path: string): string {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index + marker.length);
}

export function productionLicenseInventory(lock: PackageLock): DependencyLicense[] {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("Expected a package-lock.json with lockfileVersion 3 and a packages object.");
  }

  const inventory: DependencyLicense[] = [];
  for (const [path, value] of Object.entries(lock.packages as Record<string, LockPackage>)) {
    if (!path || !path.includes("node_modules/") || !value || typeof value !== "object") continue;
    if (value.dev === true || value.peer === true || value.link === true) continue;
    const name = dependencyName(path);
    if (!name || typeof value.version !== "string" || !value.version) {
      throw new Error(`Production dependency at ${path} has no usable name/version.`);
    }
    if (typeof value.license !== "string" || !value.license.trim()) {
      throw new Error(`${name}@${value.version} has no SPDX license in package-lock.json; review it explicitly.`);
    }
    inventory.push({ name, version: value.version, license: value.license.trim(), path });
  }

  return inventory.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.path.localeCompare(b.path));
}

export function rejectedProductionLicenses(inventory: DependencyLicense[]): DependencyLicense[] {
  return inventory.filter((dependency) => !ALLOWED_PRODUCTION_LICENSES.has(dependency.license));
}

export function licenseReport(inventory: DependencyLicense[]): object {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    policy: { allowedSpdxLicenses: [...ALLOWED_PRODUCTION_LICENSES].sort() },
    productionDependencies: inventory,
  };
}

function parseOutputArgument(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--output" && args[1]) return args[1];
  throw new Error("Usage: tsx scripts/check-dependency-licenses.ts [--output <path>]");
}

async function main(): Promise<void> {
  const output = parseOutputArgument(process.argv.slice(2));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as PackageLock;
  const inventory = productionLicenseInventory(lock);
  const rejected = rejectedProductionLicenses(inventory);
  if (rejected.length) {
    const details = rejected.map(({ name, version, license }) => `  - ${name}@${version}: ${license}`).join("\n");
    throw new Error(`Production dependency license review required:\n${details}\nUpdate the dependency or explicitly amend the reviewed SPDX allowlist.`);
  }
  if (inventory.length === 0) throw new Error("No production dependencies were found; refusing to emit an empty license inventory.");

  const report = `${JSON.stringify(licenseReport(inventory), null, 2)}\n`;
  if (output) await writeFile(output, report, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`dependency license policy passed: ${inventory.length} production packages${output ? `; inventory: ${output}` : ""}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
