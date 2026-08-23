import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const WORKER_ADDRESS = "worker.work-e2e@mock-e2e.com";

interface Readiness {
  parentPid: number;
  childPid: number;
  heartbeatPath: string;
  startedAt: string;
}

function toolEnd(toolName: string) {
  return (line: RpcLine) => line.type === "tool_execution_end" && line.toolName === toolName;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function eventually<T>(read: () => Promise<T | undefined>, description: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      last = value;
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(last)?.slice(0, 500)}`);
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

function killExact(pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* exact test PID is already absent */ }
}

describe("real worker cleanup containment", { concurrency: false }, () => {
  it("records one same-group parent+descendant termination but stays quarantined without a Pi receipt", {
    timeout: 120_000,
    skip: process.platform !== "linux" ? "representative exact-PID proof currently targets Linux process groups" : false,
  }, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-email-cleanup-e2e-agent-"));
    const readinessPath = join(agentDir, "cleanup-readiness.json");
    const heartbeatPath = join(agentDir, "cleanup-heartbeat.json");
    const client = PiRpcClient.launch({
      cwd: process.cwd(),
      agentDir,
      model: "mock-e2e/mock-e2e",
      extensions: [MOCK_EXTENSION, EXTENSION],
    });
    let readiness: Readiness | undefined;
    try {
      const state = await client.getState();
      assert.equal(state.success, true, client.stderr);
      const sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
      assert.ok(sessionId);

      let mark = client.mark();
      await client.prompt(`E2E CLEANUP START NOWAIT PATH ${readinessPath} HEARTBEAT ${heartbeatPath}`);
      await client.waitFor(toolEnd("send_email"), "cleanup process delegation", 60_000, mark);
      readiness = await eventually(async () => {
        const candidate = await readJson(readinessPath) as Readiness;
        return Number.isSafeInteger(candidate.parentPid) && Number.isSafeInteger(candidate.childPid) ? candidate : undefined;
      }, "structured parent+descendant readiness");
      assert.equal(readiness.heartbeatPath, heartbeatPath);
      assert.ok(Number.isFinite(Date.parse(readiness.startedAt)));
      assert.equal(processExists(readiness.parentPid), true);
      assert.equal(processExists(readiness.childPid), true);
      const heartbeatBefore = await eventually(async () => {
        const heartbeat = await readJson(heartbeatPath) as { pid: number; sequence: number };
        return heartbeat.pid === readiness!.childPid && heartbeat.sequence > 0 ? heartbeat : undefined;
      }, "descendant heartbeat");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
      const heartbeatDuring = await readJson(heartbeatPath) as { pid: number; sequence: number };
      assert.ok(heartbeatDuring.sequence > heartbeatBefore.sequence, "recorded descendant was live before cleanup");

      mark = client.mark();
      await client.prompt("E2E CLEANUP STOP");
      const managed = await client.waitFor(toolEnd("manage_agent"), "cleanup stop result", 60_000, mark);

      await eventually(async () => !processExists(readiness!.parentPid) && !processExists(readiness!.childPid) ? true : undefined,
        "exact parent and descendant PIDs to become absent");
      const stoppedHeartbeat = await readJson(heartbeatPath) as { sequence: number };
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 350));
      const heartbeatAfter = await readJson(heartbeatPath) as { sequence: number };
      assert.equal(heartbeatAfter.sequence, stoppedHeartbeat.sequence, "heartbeat stopped after exact PID termination");

      const registry = await eventually(async () => {
        const candidate = await readJson(join(agentDir, "subagents", sessionId, "registry.json"));
        const agent = candidate.agents?.find((item: any) => item.address === WORKER_ADDRESS);
        return agent?.cleanup?.state === "unknown" ? candidate : undefined;
      }, "persisted cleanup quarantine");
      const agent = registry.agents.find((item: any) => item.address === WORKER_ADDRESS);
      assert.equal(managed.isError, true, "stop cannot claim success without an authoritative process receipt");
      assert.equal(agent.state, "failed");
      assert.equal(agent.cleanup.quiescence, "unknown");
      assert.equal(agent.cleanup.heldCapacity, true);
      assert.equal(agent.cleanup.activeTools.map((tool: any) => [tool.toolCallId, tool.toolName]).length, 1);
      assert.doesNotMatch(JSON.stringify(agent.cleanup), /--import|descendant-process|heartbeat|stdout|command/i);
    } finally {
      // Red and green paths both clean only the exact PIDs recorded by this test.
      if (!readiness) {
        try { readiness = await readJson(readinessPath) as Readiness; } catch { /* process never reached readiness */ }
      }
      killExact(readiness?.childPid);
      killExact(readiness?.parentPid);
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
