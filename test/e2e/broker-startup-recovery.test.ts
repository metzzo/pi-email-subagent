/**
 * Broker startup-recovery e2e: a session whose broker startup fails must not
 * be stuck on "Email broker is not ready" until a manual session restart.
 * Every later tool call transparently retries startup, surfaces the
 * actionable cause while it persists, and recovers once the cause is gone.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");

function toolEnd(toolName: string) {
  return (line: RpcLine) => line.type === "tool_execution_end" && line.toolName === toolName;
}

function toolText(line: RpcLine): string {
  const result = line.result as { content?: Array<{ text?: string }> } | undefined;
  return (result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

it("retries broker startup on later tool calls and recovers once the cause is fixed", { timeout: 240_000 }, async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-recovery-"));
  // A regular file where the broker must create its namespace directory makes
  // every startup attempt fail deterministically until the file is removed.
  const blocker = join(agentDir, "subagents");
  await writeFile(blocker, "namespace root blocked");
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, EXTENSION],
  });
  try {
    const state = await client.getState();
    assert.equal(state.success, true, client.stderr);

    let mark = client.mark();
    await client.prompt("E2E FETCH");
    const failedFetch = await client.waitFor(toolEnd("fetch_emails"), "fetch while startup is blocked", 90_000, mark);
    assert.equal(failedFetch.isError, true, toolText(failedFetch));
    assert.match(toolText(failedFetch), /startup failed/i);
    await client.waitForSettlement(mark);

    // Fix the environment; no session restart or manual broker action follows.
    await rm(blocker);

    mark = client.mark();
    await client.prompt("E2E FETCH");
    const recoveredFetch = await client.waitFor(toolEnd("fetch_emails"), "fetch after recovery", 90_000, mark);
    assert.notEqual(recoveredFetch.isError, true, toolText(recoveredFetch));
    await client.waitForSettlement(mark);

    mark = client.mark();
    await client.prompt("E2E INSPECT");
    const inspection = await client.waitFor(toolEnd("inspect_agent"), "inspect after recovery", 90_000, mark);
    assert.notEqual(inspection.isError, true, toolText(inspection));
    const details = (inspection.result as { details?: { inspection?: { exists?: boolean } } } | undefined)?.details?.inspection;
    assert.equal(details?.exists, false);
    await client.waitForSettlement(mark);

    assert.equal(await client.close(), 0, client.stderr);
  } finally {
    await client.close().catch(() => undefined);
    await rm(agentDir, { recursive: true, force: true });
  }
});
