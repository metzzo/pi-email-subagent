import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentBroker } from "../../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../../src/config.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../../helpers/fakes.ts";

const root = process.argv[2];
const stage = process.argv[3];
if (!root || (stage !== "before-save" && stage !== "after-save")) {
  throw new Error("usage: abandoned-init-failure-runner.ts <root> <before-save|after-save>");
}

const workers: FakeWorker[] = [];
const namespaceDir = join(root, "state");
const broker = new AgentBroker({
  cwd: root,
  agentDir: root,
  namespaceDir,
  config: structuredClone(DEFAULT_CONFIG),
  models: [fakeModel("gpt-5.4")],
  mainAdapter: new FakeMainAdapter(),
  workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
  projectTrusted: true,
});

const originalSave = broker.registryStore.save.bind(broker.registryStore);
let injected = false;
broker.registryStore.save = async (registry) => {
  if (injected) return originalSave(registry);
  injected = true;
  if (stage === "after-save") await originalSave(registry);
  throw new Error(`injected ${stage} normalized registry failure`);
};

let error = "initialization unexpectedly succeeded";
try {
  await broker.init();
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
}
const owner = JSON.parse(await readFile(join(namespaceDir, ".broker-owner.json"), "utf8")) as { pid: number };
const registry = JSON.parse(await readFile(join(namespaceDir, "registry.json"), "utf8")) as any;
const record = registry.agents.find((candidate: any) => candidate.address === "worker.dead-owner@gpt-5.4.com");
process.stdout.write(`${JSON.stringify({
  stage,
  error,
  workers: workers.length,
  ownerPid: owner.pid,
  recordState: record?.state,
  workerPhase: record?.workerEpoch?.phase,
  sessionFile: record?.sessionFile,
})}\n`);
// Intentionally terminate without broker shutdown. This models the process
// death that makes the retained exact takeover owner reclaimable by retry.
process.exit(error === "initialization unexpectedly succeeded" ? 2 : 0);
