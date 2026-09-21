import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { PiRpcClient } from "./helpers/rpc-client.ts";

const observer = join(
  process.cwd(),
  "test/e2e/helpers/provider-request-observer-extension.ts",
);
const production = join(process.cwd(), "src/index.ts");
const statusProgram = join(process.cwd(), "src/python/examples/status_file.py");

it(
  "real Pi exposes and directly runs the packaged status observer without model requests",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mechanistic-direct-"));
    const agentDir = join(root, ".pi");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(root, "status.txt"), "ready\n");
    await writeFile(
      join(agentDir, "subagents.json"),
      JSON.stringify({
        mechanisticPrograms: {
          ci: {
            python: "python3",
            script: statusProgram,
            cwd: root,
            description: "Observe local status",
            inputExamples: ["{}"],
          },
        },
      }),
    );
    const client = PiRpcClient.launch({
      cwd: root,
      agentDir,
      model: "openai/gpt-4.1-nano",
      extensions: [production, observer],
      approveProject: true,
      env: { OPENAI_API_KEY: "deterministic-unused", PI_OFFLINE: "1" },
    });
    try {
      const models = await client.getAvailableModels();
      const available =
        (models.data as { models?: Array<{ provider?: string; id?: string }> })
          .models ?? [];
      assert.ok(
        available.some(
          (model) => model.provider === "openai" && model.id === "gpt-4.1-nano",
        ),
      );
      await client.prompt("/agents programs");

      await client.prompt("/agents program ci");
      await client.prompt("/agents run ci.main-status {}");

      assert.equal(
        await readFile(join(root, ".provider-requests")).catch(() => ""),
        "",
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
