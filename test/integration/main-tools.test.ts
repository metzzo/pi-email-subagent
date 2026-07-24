import assert from "node:assert/strict";
import { it } from "node:test";
import { createMainCoordinationTools } from "../../src/main-tools.ts";

it("exposes inspection, reply joining, and lifecycle control without a spawn tool", async () => {
  const tools = createMainCoordinationTools(() => undefined);
  assert.deepEqual(tools.map((tool) => tool.name), ["inspect_agent", "wait_for_replies", "manage_agent"]);
  assert.equal(tools.some((tool) => tool.name.includes("spawn")), false);

  const result = await tools[0].execute(
    "inspect-unready",
    { address: "worker.task@gpt-5.4.com" },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match((result.content[0] as { text: string }).text, /broker is not ready/i);
});
