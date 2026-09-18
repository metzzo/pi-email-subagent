import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Node emits one LCOV record per generated-script URL. Combine line hits for
 * the same original source while retaining every variant's function/branch
 * obligations. Never count import execution as execution of a function body. */
export function mergeCoverage(input: string): string {
  const sources = new Map<string, string[]>();
  for (const record of input.split("end_of_record")) {
    const source = /^SF:(.+)$/m.exec(record)?.[1];
    if (!source) continue;
    const records = sources.get(source) ?? []; records.push(record); sources.set(source, records);
  }
  return [...sources].map(([source, records]) => {
    if (records.length === 1) return `${records[0]!.trim()}\nend_of_record\n`;
    const lines = new Map<number, number>();
    const functions: string[] = []; const functionHits: string[] = []; const branches: string[] = [];
    let functionsFound = 0; let functionsHit = 0; let branchesFound = 0; let branchesHit = 0;
    const blocks = new Map<string, number>();
    records.forEach((record, variant) => {
      const count = (key: string): number => {
        const value = new RegExp(`^${key}:(\\d+)$`, "m").exec(record)?.[1];
        if (value === undefined) throw new Error(`Missing ${key} for ${source}`);
        return Number(value);
      };
      functionsFound += count("FNF"); functionsHit += count("FNH");
      branchesFound += count("BRF"); branchesHit += count("BRH");
      for (const line of record.split("\n")) {
        let match: RegExpExecArray | null;
        if ((match = /^DA:(\d+),(\d+)$/.exec(line))) {
          const number = Number(match[1]); lines.set(number, (lines.get(number) ?? 0) + Number(match[2]));
        } else if ((match = /^FN:(\d+),(.+)$/.exec(line))) {
          functions.push(`FN:${match[1]},variant${variant}:${match[2]}`);
        } else if ((match = /^FNDA:(\d+),(.+)$/.exec(line))) {
          functionHits.push(`FNDA:${match[1]},variant${variant}:${match[2]}`);
        } else if ((match = /^BRDA:(\d+),(\d+),(\d+),(-|\d+)$/.exec(line))) {
          const key = `${variant}:${match[2]}`;
          if (!blocks.has(key)) blocks.set(key, blocks.size);
          branches.push(`BRDA:${match[1]},${blocks.get(key)},${match[3]},${match[4]}`);
        }
      }
    });
    return [`SF:${source}`, ...functions, ...functionHits, `FNF:${functionsFound}`, `FNH:${functionsHit}`,
      ...[...lines].sort(([a], [b]) => a - b).map(([line, count]) => `DA:${line},${count}`),
      `LF:${lines.size}`, `LH:${[...lines.values()].filter((count) => count > 0).length}`,
      ...branches, `BRF:${branchesFound}`, `BRH:${branchesHit}`, "end_of_record", ""].join("\n");
  }).join("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: merge-coverage <input.lcov> <output.lcov>");
  await writeFile(output, mergeCoverage(await readFile(input, "utf8")));
}
