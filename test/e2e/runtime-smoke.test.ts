import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { it } from "node:test";

interface RpcLine {
  type: string;
  command?: string;
  success?: boolean;
  data?: any;
  method?: string;
  widgetKey?: string;
}

it("starts inside an isolated real Pi RPC runtime and exposes /agents", { timeout: 30_000 }, async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-runtime-smoke-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.env.PI_BIN ?? "pi", ["-ne", "-e", "./src/index.ts", "--mode", "rpc", "--no-session"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
    child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child!.once("error", reject);
      child!.once("close", resolveExit);
    });
    assert.equal(exitCode, 0, stderr);
    assert.doesNotMatch(stderr, /Failed to load extension|conflicts with|Error:/);

    const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RpcLine);
    const state = lines.find((line) => line.type === "response" && line.command === "get_state");
    assert.equal(state?.success, true);
    assert.equal(typeof state?.data?.sessionId, "string");
    const commands = lines.find((line) => line.type === "response" && line.command === "get_commands");
    assert.equal(commands?.success, true);
    assert.equal(commands?.data?.commands?.some((command: { name: string }) => command.name === "agents"), true);
    assert.equal(lines.some((line) => line.type === "extension_ui_request" && line.method === "setWidget" && line.widgetKey === "pi-email-subagent"), true);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await rm(agentDir, { recursive: true, force: true });
  }
});
