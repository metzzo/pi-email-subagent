import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { PiRpcClient } from "../e2e/helpers/rpc-client.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PiRpcClient physical close", () => {
  it("separates malformed protocol failure from SIGKILL physical close", async () => {
    const root = await mkdtemp(join(tmpdir(), "rpc-close-"));
    const script = join(root, "bad-child.js");
    await writeFile(script, "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>{}); process.stdout.write('{bad}\\n'); setInterval(()=>{},1000);\n");
    await chmod(script, 0o755);
    const client = PiRpcClient.launch({ cwd: root, agentDir: root, model: "dummy/dummy", extensions: [], piBin: script });
    try {
      await assert.rejects(client.waitForExit());
      const short = await Promise.race([client.waitForClose().then(() => true), wait(100).then(() => false)]);
      assert.equal(short, false);
      assert.equal(client.kill("SIGTERM"), true);
      const term = await Promise.race([client.waitForClose().then(() => true), wait(100).then(() => false)]);
      assert.equal(term, false);
      client.kill("SIGKILL");
      assert.deepEqual(await client.waitForClose(), { code: null, signal: "SIGKILL" });
    } finally {
      client.kill("SIGKILL");
      await Promise.race([client.waitForClose(), wait(2000)]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
