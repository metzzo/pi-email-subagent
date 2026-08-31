import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Threshold { lines: number; functions: number; branches: number }
interface ThresholdConfig {
  schemaVersion: 1;
  excluded: string[];
  files: Record<string, Threshold>;
}
interface CoverageCounts { found: number; hit: number }
interface FileCoverage { lines: CoverageCounts; functions: CoverageCounts; branches: CoverageCounts }

function field(block: string, name: string): number {
  const match = new RegExp(`^${name}:(\\d+)$`, "m").exec(block);
  if (!match) throw new Error(`LCOV record is missing ${name}.`);
  return Number(match[1]);
}

export function parseLcov(text: string): Map<string, FileCoverage> {
  const result = new Map<string, FileCoverage>();
  for (const block of text.split("end_of_record")) {
    const source = /^SF:(.+)$/m.exec(block)?.[1];
    if (!source) continue;
    if (result.has(source)) throw new Error(`LCOV contains duplicate source record ${source}.`);
    const file = {
      lines: { found: field(block, "LF"), hit: field(block, "LH") },
      functions: { found: field(block, "FNF"), hit: field(block, "FNH") },
      branches: { found: field(block, "BRF"), hit: field(block, "BRH") },
    };
    for (const [metric, counts] of Object.entries(file)) {
      if (counts.hit > counts.found) throw new Error(`LCOV ${source} ${metric} hits exceed found count.`);
    }
    result.set(source, file);
  }
  if (result.size === 0) throw new Error("LCOV contains no source records.");
  return result;
}

function threshold(value: unknown, path: string): Threshold {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const record = value as Record<string, unknown>;
  for (const metric of ["lines", "functions", "branches"] as const) {
    const candidate = record[metric];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 100) {
      throw new Error(`${path}.${metric} must be a finite number from 0 to 100.`);
    }
  }
  return { lines: record.lines as number, functions: record.functions as number, branches: record.branches as number };
}

export function validateThresholdConfig(value: unknown): ThresholdConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Coverage threshold configuration must be an object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.excluded)
    || record.excluded.some((item) => typeof item !== "string")
    || !record.files || typeof record.files !== "object" || Array.isArray(record.files)) {
    throw new Error("Coverage threshold configuration is invalid.");
  }
  const files: Record<string, Threshold> = {};
  for (const [path, value] of Object.entries(record.files as Record<string, unknown>)) {
    if (!path) throw new Error("Coverage threshold path must not be empty.");
    files[path] = threshold(value, `files.${path}`);
  }
  return { schemaVersion: 1, excluded: [...record.excluded] as string[], files };
}

function percentage(counts: CoverageCounts): number {
  return counts.found === 0 ? 100 : (counts.hit * 100) / counts.found;
}

async function sourceFiles(directory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path, root));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative(root, path));
  }
  return files.sort();
}

export async function checkCoverage(
  lcovPath: string,
  configPath: string,
  sourceRoot = process.cwd(),
): Promise<number> {
  const coverage = parseLcov(await readFile(lcovPath, "utf8"));
  const config = validateThresholdConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const configured = new Set(Object.keys(config.files));
  const excluded = new Set(config.excluded);
  const missingThresholds = (await sourceFiles(resolve(sourceRoot, "src"), sourceRoot))
    .filter((path) => !configured.has(path) && !excluded.has(path));
  if (missingThresholds.length > 0) throw new Error(`Coverage thresholds are missing source files: ${missingThresholds.join(", ")}.`);

  const failures: string[] = [];
  for (const [path, expected] of Object.entries(config.files)) {
    const actual = coverage.get(path);
    if (!actual) {
      failures.push(`${path}: no LCOV record`);
      continue;
    }
    for (const metric of ["lines", "functions", "branches"] as const) {
      const value = percentage(actual[metric]);
      if (value + Number.EPSILON < expected[metric]) {
        failures.push(`${path} ${metric}: ${value.toFixed(2)}% < ${expected[metric]}%`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`Coverage ratchet failed:\n${failures.join("\n")}`);
  return Object.keys(config.files).length;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [lcovPath = ".test-workspaces/coverage.lcov", configPath = "coverage-thresholds.json"] = process.argv.slice(2);
  const count = await checkCoverage(lcovPath, configPath);
  process.stdout.write(`Coverage ratchet passed for ${count} source files.\n`);
}
