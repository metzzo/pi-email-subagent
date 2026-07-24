#!/usr/bin/env tsx
/**
 * Optional paid live-provider acceptance helper.
 *
 * This intentionally does not run under `npm test`. It starts Pi RPC with the
 * extension and asks the selected main model to delegate a tiny read-only task.
 * Set LIVE_MODEL to a registered provider/model CLI spec and LIVE_EMAIL_MODEL
 * to its model ID as encoded in an email address. Set LIVE_EXTENSIONS to a
 * comma-separated list when the target model comes from a provider extension.
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const cliModel = process.env.LIVE_MODEL;
const emailModel = process.env.LIVE_EMAIL_MODEL;
if (!cliModel || !emailModel) {
  console.error("Set LIVE_MODEL (provider/model) and LIVE_EMAIL_MODEL (model ID).");
  process.exit(2);
}

const extraExtensions = (process.env.LIVE_EXTENSIONS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const extensionArgs = extraExtensions.flatMap((extension) => ["-e", extension]);
const child = spawn("pi", [
  "-ne",
  ...extensionArgs,
  "-e",
  "./src/index.ts",
  "--mode",
  "rpc",
  "--no-session",
  "--model",
  cliModel,
], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "inherit"],
});

const prompt = [
  "Use send_email exactly once to delegate a tiny read-only task.",
  `Recipient: scout.live-mail@${emailModel}.com`,
  "Subject: Verify live mailbox",
  "Message: Call fetch_emails, then reply with the names of the two virtual email tools available to you. Do not modify files.",
  "Priority: low",
  "After delegating, continue to watch for the email response and report it.",
].join("\n");

let buffer = "";
let sawSend = false;
let sawIncoming = false;
let sessionId: string | undefined;
const timer = setTimeout(() => {
  console.error("Live test timed out.");
  child.kill("SIGTERM");
}, 180_000);

child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    console.log(line);
    try {
      const event = JSON.parse(line) as any;
      if (event.type === "response" && event.command === "get_state") sessionId = event.data?.sessionId;
      if (event.type === "tool_execution_start" && event.toolName === "send_email") sawSend = true;
      if (event.type === "message_start" && event.message?.customType === "pi-email-subagent.email") sawIncoming = true;
      if (event.type === "tool_execution_end" && event.toolName === "wait_for_replies"
        && event.result?.details?.result?.items?.some((item: any) => item.state === "answered")) sawIncoming = true;
      if (sawSend && sawIncoming) {
        clearTimeout(timer);
        child.stdin.end();
      }
    } catch { /* retain raw output */ }
  }
});

child.on("close", async (code) => {
  clearTimeout(timer);
  if (sessionId) {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    await rm(join(agentDir, "subagents", sessionId), { recursive: true, force: true });
  }
  if (!sawSend || !sawIncoming) {
    console.error(`Live acceptance incomplete: send_email=${sawSend}, incoming=${sawIncoming}`);
    process.exitCode = 1;
  } else process.exitCode = code ?? 0;
});

child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
