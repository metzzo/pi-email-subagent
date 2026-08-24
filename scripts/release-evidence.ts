import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function git(args: string[], encoding: BufferEncoding | "buffer" = "utf8"): string | Buffer {
  const result = spawnSync("git", args, { encoding: encoding === "buffer" ? null : encoding });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${String(result.stderr)}`);
  }
  return result.stdout as string | Buffer;
}

function zeroFields(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter((field) => field.length > 0);
}

const [baseInput, candidateInput = "HEAD", outputInput = ".test-workspaces/release-evidence"] = process.argv.slice(2);
if (!baseInput) throw new Error("Usage: tsx scripts/release-evidence.ts <base> [candidate=HEAD] [output-dir]");

const base = String(git(["rev-parse", "--verify", `${baseInput}^{commit}`])).trim();
const candidate = String(git(["rev-parse", "--verify", `${candidateInput}^{commit}`])).trim();
const head = String(git(["rev-parse", "HEAD"])).trim();
const originMain = String(git(["rev-parse", "origin/main"])).trim();
const mergeBase = String(git(["merge-base", base, candidate])).trim();
if (mergeBase !== base) throw new Error(`Explicit base ${base} is not an ancestor of candidate ${candidate}.`);
if (candidate !== head) throw new Error(`Candidate ${candidate} is not current HEAD ${head}.`);

const statusFields = zeroFields(git(["diff", "--name-status", "-z", `${base}..${candidate}`], "buffer") as Buffer);
const entries: Array<{ status: string; path: string; oldPath?: string }> = [];
for (let index = 0; index < statusFields.length;) {
  const status = statusFields[index++]!;
  if (/^[RC]/u.test(status)) {
    const oldPath = statusFields[index++];
    const path = statusFields[index++];
    if (!oldPath || !path) throw new Error(`Malformed rename/copy entry for ${status}.`);
    entries.push({ status, oldPath, path });
  } else {
    const path = statusFields[index++];
    if (!path) throw new Error(`Malformed changed-file entry for ${status}.`);
    entries.push({ status, path });
  }
}
const canonicalPaths = zeroFields(git(["diff", "--name-only", "-z", `${base}..${candidate}`], "buffer") as Buffer).sort();
const entryPaths = entries.map((entry) => entry.path).sort();
if (JSON.stringify(canonicalPaths) !== JSON.stringify(entryPaths)) {
  throw new Error("Canonical name-only inventory disagrees with parsed name-status inventory.");
}
git(["diff", "--check", `${base}..${candidate}`]);

const porcelain = String(git(["status", "--porcelain=v1"]));
const outputDir = resolve(outputInput);
await mkdir(outputDir, { recursive: true });
const auditCommand = ["audit", "--omit=dev", "--omit=peer"];
const audit = spawnSync("npm", auditCommand, { encoding: "utf8" });
const auditArtifact = "production-audit.log";
await writeFile(
  resolve(outputDir, auditArtifact),
  `$ npm ${auditCommand.join(" ")}\n${audit.stdout ?? ""}${audit.stderr ?? ""}`,
);
if (audit.status !== 0) {
  throw new Error(`npm ${auditCommand.join(" ")} failed (${audit.status}); see ${resolve(outputDir, auditArtifact)}.`);
}

const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  base,
  candidate,
  head,
  originMain,
  mergeBase,
  candidateIsHead: candidate === head,
  candidateIsOriginMain: candidate === originMain,
  worktreeClean: porcelain.length === 0,
  range: `${base}..${candidate}`,
  changedFileCount: entries.length,
  changedFiles: entries,
  canonicalChangedFileVerification: "parsed git diff --name-status -z equals parsed git diff --name-only -z; git diff --check passed",
  productionAudit: {
    command: "npm audit --omit=dev --omit=peer",
    status: audit.status,
    artifact: auditArtifact,
  },
};
await writeFile(resolve(outputDir, "range-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
