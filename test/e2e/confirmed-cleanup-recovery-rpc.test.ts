import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";
import { MOCK_RECOVERY_ADDRESS } from "./helpers/mock-provider-extension.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const RAW_EVIDENCE = "The human said exact generation 9 was externally verified quiescent. Authorization: Bearer rpc-secret-sentinel";

async function createPersistentSession(agentDir: string): Promise<{ sessionId: string; sessionFile: string }> {
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, EXTENSION],
    persistSession: true,
  });
  try {
    const state = await client.getState();
    assert.equal(state.success, true, client.stderr);
    const data = state.data as { sessionId?: string; sessionFile?: string };
    assert.ok(data.sessionId);
    assert.ok(data.sessionFile);
    const mark = client.mark();
    await client.prompt("E2E PERSIST SESSION");
    await client.waitForSettlement(mark, 30_000);
    return { sessionId: data.sessionId, sessionFile: data.sessionFile };
  } finally {
    assert.equal(await client.close(), 0, client.stderr);
  }
}

async function seedQuarantine(agentDir: string, sessionId: string): Promise<string> {
  const namespaceDir = join(agentDir, "subagents", sessionId);
  const broker = new AgentBroker({
    cwd: process.cwd(),
    agentDir,
    namespaceDir,
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel("mock-e2e", "mock-e2e")],
    mainAdapter: new FakeMainAdapter("main@mock-e2e.com"),
    workerFactory: () => new FakeWorker(),
    projectTrusted: true,
  });
  await broker.init();
  const initial = await broker.send(broker.mainAddress, {
    to: MOCK_RECOVERY_ADDRESS,
    subject: "Seed confirmed cleanup recovery",
    message: "Create the exact durable identity.",
    priority: "low",
  });
  await broker.stop(MOCK_RECOVERY_ADDRESS);
  await broker.cancelRequest(initial.envelope.id, "Fixture closes the seed request before recovery characterization.");
  await broker.shutdown();

  const registryPath = join(namespaceDir, "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
  const record = registry.agents.find((candidate: any) => candidate.address === MOCK_RECOVERY_ADDRESS);
  const now = "2026-09-01T00:00:00.000Z";
  record.state = "failed";
  record.failure = "Cleanup quarantine: RPC confirmation fixture.";
  record.workerEpoch = {
    generation: 9,
    phase: "activated",
    tools: ["bash", "send_email", "fetch_emails"],
    mutationCapable: true,
    runSlotHeld: false,
  };
  record.cleanup = {
    state: "unknown",
    reasonCode: "WORKER_CLEANUP_REPORT_UNKNOWN",
    workerGeneration: 9,
    startedAt: now,
    updatedAt: now,
    abort: "succeeded",
    dispose: "succeeded",
    quiescence: "unknown",
    mutationCapableAtStart: true,
    heldRunSlot: false,
    activeTools: [],
  };
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return registryPath;
}

function manageEnd(line: RpcLine): boolean {
  return line.type === "tool_execution_end" && line.toolName === "manage_agent";
}

function resultText(line: RpcLine): string {
  const content = (line.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
  return content?.find((part) => part.type === "text")?.text ?? "";
}

describe("Pi RPC cleanup recovery confirmation protocol", { concurrency: false }, () => {
  it("emits a supported confirm request, rejects denial without mutation, and consumes each approval once", { timeout: 180_000 }, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-email-confirmed-recovery-rpc-"));
    let client: PiRpcClient | undefined;
    try {
      const { sessionId, sessionFile } = await createPersistentSession(agentDir);
      const registryPath = await seedQuarantine(agentDir, sessionId);
      client = PiRpcClient.launch({
        cwd: process.cwd(),
        agentDir,
        model: "mock-e2e/mock-e2e",
        extensions: [MOCK_EXTENSION, EXTENSION],
        persistSession: true,
        session: sessionFile,
      });
      const state = await client.getState();
      assert.equal((state.data as { sessionId?: string }).sessionId, sessionId);

      const beforeDenial = await readFile(registryPath, "utf8");
      let mark = client.mark();
      await client.prompt("E2E RECOVER CLEANUP");
      const deniedRequest = await client.waitFor(
        (line) => line.type === "extension_ui_request" && line.method === "confirm",
        "cleanup recovery confirmation request",
        30_000,
        mark,
      );
      assert.match(String(deniedRequest.title), /confirm cleanup recovery proposal/i);
      assert.match(String(deniedRequest.message), new RegExp(`Address: ${MOCK_RECOVERY_ADDRESS.replaceAll(".", "\\.")}`));
      assert.match(String(deniedRequest.message), /Worker generation: 9/);
      assert.match(String(deniedRequest.message), /The human said exact generation 9 was externally verified quiescent/);
      assert.match(String(deniedRequest.message), /Authorization: \[redacted\]/i);
      assert.doesNotMatch(String(deniedRequest.message), /rpc-secret-sentinel/);
      assert.match(String(deniedRequest.message), /Pi did not prove process quiescence.*surviving effects may overlap/is);
      assert.equal(deniedRequest.timeout, 30_000);
      client.send({ type: "extension_ui_response", id: deniedRequest.id, confirmed: false });
      const denied = await client.waitFor(manageEnd, "denied manage_agent recovery", 30_000, mark);
      assert.equal(denied.isError, true);
      assert.match(resultText(denied), /proposal rejected.*human confirmation.*denied/i);
      await client.waitForSettlement(mark, 30_000);
      assert.equal(await readFile(registryPath, "utf8"), beforeDenial);

      const requestIds = new Set([deniedRequest.id]);
      for (const [label, value] of [["string-false", "false"], ["number-one", 1], ["object", {}]] as const) {
        const beforeUntrustedResponse = await readFile(registryPath, "utf8");
        mark = client.mark();
        await client.prompt("E2E RECOVER CLEANUP");
        const untrustedRequest = await client.waitFor(
          (line) => line.type === "extension_ui_request" && line.method === "confirm",
          `${label} cleanup recovery confirmation request`,
          30_000,
          mark,
        );
        assert.equal(requestIds.has(untrustedRequest.id), false, `${label} retry receives a fresh request ID`);
        requestIds.add(untrustedRequest.id);
        client.send({ type: "extension_ui_response", id: untrustedRequest.id, confirmed: value });
        const rejected = await client.waitFor(manageEnd, `${label} rejected manage_agent recovery`, 30_000, mark);
        assert.equal(rejected.isError, true, `${label}: ${resultText(rejected)}`);
        assert.match(resultText(rejected), /proposal rejected.*human confirmation.*denied/i, label);
        await client.waitForSettlement(mark, 30_000);
        assert.equal(await readFile(registryPath, "utf8"), beforeUntrustedResponse, `${label} commits no transition`);
      }

      mark = client.mark();
      await client.prompt("E2E RECOVER CLEANUP");
      const approvedRequest = await client.waitFor(
        (line) => line.type === "extension_ui_request" && line.method === "confirm",
        "approved cleanup recovery confirmation request",
        30_000,
        mark,
      );
      assert.equal(requestIds.has(approvedRequest.id), false, "approval retry receives a fresh request ID");
      requestIds.add(approvedRequest.id);
      client.send({ type: "extension_ui_response", id: approvedRequest.id, confirmed: true });
      const approved = await client.waitFor(manageEnd, "approved manage_agent recovery", 30_000, mark);
      assert.equal(approved.isError, false, resultText(approved));
      assert.match(resultText(approved), /recover_cleanup confirmed.*generation 9.*not Pi-verified/is);
      assert.match(resultText(approved), /explicitly restart or archive/i);
      assert.doesNotMatch(resultText(approved), /externally verified|Authorization|rpc-secret-sentinel/i);
      assert.equal(JSON.stringify((approved.result as { details?: unknown }).details).includes(RAW_EVIDENCE), false);
      await client.waitForSettlement(mark, 30_000);

      const committed = JSON.parse(await readFile(registryPath, "utf8")) as any;
      const recovered = committed.agents.find((record: any) => record.address === MOCK_RECOVERY_ADDRESS);
      assert.equal(recovered.state, "failed");
      assert.equal(recovered.cleanup, undefined);
      assert.equal(recovered.workerEpoch.phase, "operator-released");
      assert.equal(recovered.lastCleanupRecovery.workerGeneration, 9);
      assert.equal(recovered.lastCleanupRecovery.source, "operator-attested");
      const committedRaw = await readFile(registryPath, "utf8");

      mark = client.mark();
      await client.prompt("E2E RECOVER CLEANUP");
      const replayRequest = await client.waitFor(
        (line) => line.type === "extension_ui_request" && line.method === "confirm",
        "fresh confirmation for idempotent replay",
        30_000,
        mark,
      );
      assert.equal(requestIds.has(replayRequest.id), false, "approval is not a reusable token");
      requestIds.add(replayRequest.id);
      client.send({ type: "extension_ui_response", id: replayRequest.id, confirmed: true });
      const replay = await client.waitFor(manageEnd, "confirmed idempotent replay", 30_000, mark);
      assert.equal(replay.isError, false, resultText(replay));
      await client.waitForSettlement(mark, 30_000);
      assert.equal(await readFile(registryPath, "utf8"), committedRaw, "confirmed exact retry is idempotent");
    } finally {
      await client?.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
