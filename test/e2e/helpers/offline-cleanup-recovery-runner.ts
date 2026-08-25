import { writeFile } from "node:fs/promises";
import { recoverOrphanedCleanup } from "../../../src/cleanup-recovery.ts";

const [namespaceDir, address, generationRaw, evidence, marker] = process.argv.slice(2);
if (!namespaceDir || !address || !generationRaw || !evidence || !marker) {
  throw new Error("Usage: offline-cleanup-recovery-runner <namespace> <address> <generation> <evidence> <marker>");
}

try {
  const result = await recoverOrphanedCleanup(namespaceDir, {
    address,
    workerGeneration: Number(generationRaw),
    evidence,
    confirmed: true,
  }, {
    afterGuardAcquired: () => writeFile(`${marker}.guard`, `${process.pid}\n`),
    afterBackupCreated: () => writeFile(`${marker}.backup`, `${process.pid}\n`),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, audit: result.audit })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
