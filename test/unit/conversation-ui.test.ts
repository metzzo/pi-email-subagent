import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ConversationComponent,
  ConversationSource,
  HISTORY_PREVIEW_MAX_CHARS,
  conversationBlocks,
  formatConversationPreview,
  formatConversationTranscript,
  readConversationBlocks,
} from "../../src/ui.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function userMessage(content: string) {
  return { role: "user", content, timestamp: Date.now() } as never;
}

function assistantMessage(content: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
    provider: "test",
    model: "test",
    api: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as never;
}

describe("recorded conversation UI", () => {
  it("loads the persisted active branch asynchronously and refreshes after appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conversation-ui-"));
    try {
      const manager = SessionManager.create(root, root);
      const first = manager.appendMessage(userMessage("root request"));
      manager.appendMessage(assistantMessage("abandoned branch"));
      manager.branch(first);
      manager.appendMessage(assistantMessage("active branch"));
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);

      const source = new ConversationSource(sessionFile, 0);
      assert.equal(await source.refresh(true), true);
      assert.match(formatConversationTranscript(source.blocks), /root request/);
      assert.match(formatConversationTranscript(source.blocks), /active branch/);
      assert.doesNotMatch(formatConversationTranscript(source.blocks), /abandoned branch/);

      await appendFile(sessionFile, "{not valid json}\n", "utf8");
      await source.refresh(true);
      assert.match(formatConversationTranscript(source.blocks), /active branch/);

      manager.appendMessage(userMessage("appended after partial data"));
      assert.equal(await source.refresh(true), true);
      assert.match(formatConversationTranscript(source.blocks), /appended after partial data/);

      await rm(sessionFile);
      assert.equal(await source.refresh(true), true);
      // Transient read failures keep the last good blocks and only surface the error.
      assert.match(formatConversationTranscript(source.blocks), /appended after partial data/);
      assert.match(source.error ?? "", /ENOENT|no such file/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy v1 and v2 session files before rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conversation-legacy-"));
    try {
      const timestamp = new Date().toISOString();
      const v1 = join(root, "v1.jsonl");
      await writeFile(v1, [
        JSON.stringify({ type: "session", id: "legacy-v1", timestamp, cwd: root }),
        JSON.stringify({ type: "message", timestamp, message: userMessage("legacy v1 request") }),
        JSON.stringify({ type: "message", timestamp, message: assistantMessage("legacy v1 answer") }),
      ].join("\n") + "\n");
      const v1Transcript = formatConversationTranscript(await readConversationBlocks(v1));
      assert.match(v1Transcript, /legacy v1 request/);
      assert.match(v1Transcript, /legacy v1 answer/);

      const v2 = join(root, "v2.jsonl");
      await writeFile(v2, [
        JSON.stringify({ type: "session", version: 2, id: "legacy-v2", timestamp, cwd: root }),
        JSON.stringify({
          type: "message", id: "legacy01", parentId: null, timestamp,
          message: { role: "hookMessage", customType: "legacy-hook", content: "legacy v2 context", display: true, timestamp: Date.now() },
        }),
      ].join("\n") + "\n");
      const v2Transcript = formatConversationTranscript(await readConversationBlocks(v2));
      assert.match(v2Transcript, /Context · legacy-hook/);
      assert.match(v2Transcript, /legacy v2 context/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds supported-path conversation session reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conversation-bound-"));
    try {
      const sessionFile = join(root, "oversized.jsonl");
      await writeFile(sessionFile, `${JSON.stringify({
        type: "session", version: 3, id: "oversized", timestamp: new Date().toISOString(), cwd: root,
      })}\n`);
      await truncate(sessionFile, 20 * 1024 * 1024 + 1);
      await assert.rejects(readConversationBlocks(sessionFile), /session exceeds 20 MB conversation lookup bound/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strips terminal controls from labels and bodies", () => {
    const timestamp = new Date().toISOString();
    const entries = [
      {
        type: "message", id: "shell", parentId: null, timestamp,
        message: {
          role: "bashExecution",
          command: "echo one\n\x1b]52;c;clipboard\x07\tsecond",
          output: "safe\n\x1b[31mred\x1b[0m\n\x9dtitle\x9cend",
          exitCode: 0,
          timestamp: Date.now(),
        },
      },
      {
        type: "message", id: "tool", parentId: "shell", timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read\r\n\x1b]0;title\x07next",
          content: [{ type: "text", text: "body\x1b]8;;https://bad.invalid\x07link\x1b]8;;\x07" }],
          isError: false,
          timestamp: Date.now(),
        },
      },
    ] as unknown as SessionEntry[];

    const blocks = conversationBlocks(entries);
    const transcript = formatConversationTranscript(blocks);
    for (const block of blocks) {
      assert.doesNotMatch(block.label, /[\r\n\t\x00-\x1f\x7f-\x9f]/);
      assert.doesNotMatch(block.body, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    }
    assert.doesNotMatch(transcript, /clipboard|https:\/\/bad\.invalid|\x1b|\x07/);
    assert.match(transcript, /echo one second/);
    assert.match(transcript, /safe\nred\nend/);
  });

  it("bounds history previews while retaining the newest entries", () => {
    const blocks = Array.from({ length: 10 }, (_, index) => ({
      at: new Date(Date.now() + index).toISOString(),
      role: "assistant" as const,
      label: `Assistant ${index}`,
      body: `${`large-${index} `.repeat(2_000)}`,
    }));
    const preview = formatConversationPreview(blocks);
    assert.ok(preview.length <= HISTORY_PREVIEW_MAX_CHARS);
    assert.match(preview, /Assistant 6/);
    assert.match(preview, /Assistant 9/);
    assert.match(preview, /earlier entries omitted/);
    assert.match(preview, /Full transcript: \/agents/);
  });

  it("refreshes an open viewer and keeps the bottom pinned", async () => {
    const initial = Array.from({ length: 5 }, (_, index) => ({
      at: new Date(Date.now() + index).toISOString(),
      role: "assistant" as const,
      label: `Assistant ${index}`,
      body: `message ${index}`,
    }));
    let blocks = initial;
    let appendOnRefresh = false;
    let renders = 0;
    const source = {
      get blocks() { return blocks; },
      async refresh() {
        if (!appendOnRefresh) return false;
        appendOnRefresh = false;
        blocks = [...blocks, {
          at: new Date().toISOString(), role: "assistant" as const, label: "Assistant newest", body: "new live message",
        }];
        return true;
      },
    };
    const component = new ConversationComponent(
      "worker.live@test.com",
      source,
      () => undefined,
      () => { renders += 1; },
      fakeTheme,
      6,
      undefined,
      5,
    );
    component.render(40);
    component.handleInput("\x1b[F"); // End: pin the viewport to the newest content.
    component.render(40);
    appendOnRefresh = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = component.render(40);
    assert.ok(renders > 0);
    assert.match(lines.join("\n"), /new live message/);
    assert.equal(lines.every((line) => visibleWidth(line) <= 40), true);
    component.dispose();
    const rendersAfterDispose = renders;
    appendOnRefresh = true;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(renders, rendersAfterDispose, "disposed viewers stop refresh work");
  });
});
