import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";
import { UNSAFE_NATIVE_HEADER_SENTINEL } from "./helpers/unsafe-native-provider-extension.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const UNSAFE_NATIVE_EXTENSION = resolve("test/e2e/helpers/unsafe-native-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");

function sendEnd(line: RpcLine): boolean {
  return line.type === "tool_execution_end" && line.toolName === "send_email";
}

function toolText(line: RpcLine): string {
  const content = (line.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  return content?.find((part) => part.type === "text")?.text ?? "";
}

it("real Pi rejects an unsafe native public provider before email acceptance", { timeout: 180_000 }, async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-native-policy-e2e-"));
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, UNSAFE_NATIVE_EXTENSION, EXTENSION],
  });
  try {
    const state = await client.getState();
    assert.equal(state.success, true, client.stderr);
    const sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
    assert.ok(sessionId);

    const mark = client.mark();
    await client.prompt("E2E NATIVE PROVIDER REJECT NOWAIT");
    const send = await client.waitFor(sendEnd, "unsafe native provider rejection", 90_000, mark);
    assert.equal(send.isError, true);
    assert.match(toolText(send), /native provider unsafe-native-fixture.*cannot be proven.*no email was accepted/i);
    assert.doesNotMatch(`${toolText(send)}\n${client.stderr}`, new RegExp(UNSAFE_NATIVE_HEADER_SENTINEL, "i"));
    await client.waitForSettlement(mark, 90_000);

    const stateDir = join(agentDir, "subagents", sessionId);
    const registry = JSON.parse(await readFile(join(stateDir, "registry.json"), "utf8")) as { agents: unknown[] };
    assert.deepEqual(registry.agents, []);
    const journal = await readFile(join(stateDir, "mail.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert.equal(journal.trim(), "", "native provider preflight rejection journals no email event");
  } finally {
    await client.close().catch(() => undefined);
    await rm(agentDir, { recursive: true, force: true });
  }
});
