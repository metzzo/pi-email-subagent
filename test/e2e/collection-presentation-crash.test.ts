import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { MailStore } from "../../src/mail-store.ts";
import { PiRpcClient } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const PROBE_EXTENSION = resolve("test/e2e/helpers/collection-crash-probe-extension.ts");
type Boundary = "reply-reserved" | "claim-acquired" | "answer-committed" | "execute-resolved" | "tool-result-entry-observed";
const BOUNDARIES: Boundary[] = [
  "reply-reserved",
  "claim-acquired",
  "answer-committed",
  "execute-resolved",
  "tool-result-entry-observed",
];

async function eventually<T>(read: () => Promise<T | undefined>, description: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last ?? "no observation")}`);
}

async function sessionEntries(path: string): Promise<Array<Record<string, any>>> {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
}

it("characterizes every collected-reply crash boundary by stable mail and session IDs", { timeout: 300_000 }, async () => {
  for (const boundary of BOUNDARIES) {
    const agentDir = await mkdtemp(join(tmpdir(), `pi-email-collection-${boundary}-`));
    const markerPath = join(agentDir, "boundary.json");
    const client = PiRpcClient.launch({
      cwd: process.cwd(),
      agentDir,
      model: "mock-e2e/mock-e2e",
      extensions: [MOCK_EXTENSION, PROBE_EXTENSION],
      persistSession: true,
      env: {
        PI_EMAIL_COLLECTION_PROBE_BOUNDARY: boundary,
        PI_EMAIL_COLLECTION_PROBE_MARKER: markerPath,
      },
    });
    try {
      const state = await client.getState();
      const data = state.data as { sessionId?: string; sessionFile?: string } | undefined;
      assert.ok(data?.sessionId);
      assert.ok(data?.sessionFile);
      const journalPath = join(agentDir, "subagents", data.sessionId, "mail.jsonl");

      await client.prompt("E2E DELEGATE SLOW 1000");
      let observed: { requestId: string; replyId: string };
      if (boundary === "tool-result-entry-observed") {
        observed = await eventually(async () => {
          const entries = await sessionEntries(data.sessionFile!);
          const result = entries.find((entry) => entry.type === "message"
            && entry.message?.role === "toolResult"
            && entry.message?.toolName === "wait_for_replies");
          const item = result?.message?.details?.result?.items?.[0];
          return typeof item?.requestId === "string" && typeof item?.reply?.id === "string"
            ? { requestId: item.requestId, replyId: item.reply.id }
            : undefined;
        }, "wait_for_replies tool-result session entry");
      } else {
        observed = await eventually(async () => {
          await stat(markerPath);
          const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
            boundary?: string;
            requestId?: string;
            replyId?: string;
          };
          return marker.boundary === boundary && marker.requestId && marker.replyId
            ? { requestId: marker.requestId, replyId: marker.replyId }
            : undefined;
        }, `${boundary} marker`);
      }

      assert.equal(client.kill("SIGKILL"), true);
      const exit = await client.waitForExit();
      assert.equal(exit, null);

      const store = new MailStore(journalPath);
      await store.init();
      const request = store.get(observed.requestId);
      const reply = store.get(observed.replyId);
      assert.equal(request?.id, observed.requestId);
      assert.equal(reply?.id, observed.replyId);
      assert.equal(reply?.inReplyTo, observed.requestId);

      const entries = await sessionEntries(data.sessionFile);
      const matchingToolResults = entries.filter((entry) => entry.type === "message"
        && entry.message?.role === "toolResult"
        && entry.message?.toolName === "wait_for_replies"
        && entry.message?.details?.result?.items?.some((item: { requestId?: string }) => item.requestId === observed.requestId));

      if (boundary === "reply-reserved" || boundary === "claim-acquired") {
        assert.equal(request?.answeredAt, undefined);
        assert.equal(request?.replyReservedBy, observed.replyId);
        assert.equal(reply?.deliveryState, "queued");
        assert.equal(matchingToolResults.length, 0);
      } else {
        assert.equal(request?.answeredBy, observed.replyId);
        assert.equal(reply?.deliveryState, "delivered");
        assert.equal(matchingToolResults.length, boundary === "tool-result-entry-observed" ? 1 : 0);
      }
    } finally {
      client.kill("SIGKILL");
      await client.waitForExit().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  }
});
