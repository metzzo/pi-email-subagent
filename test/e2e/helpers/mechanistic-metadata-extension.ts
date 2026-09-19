import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../../src/index.ts";
import { AgentBroker } from "../../../src/broker.ts";
import { WorkerRuntimeFactory, type WorkerRuntimeSnapshot } from "../../../src/model-runtime.ts";

let broker: AgentBroker;
let preparation: WorkerRuntimeSnapshot | undefined;
const init = AgentBroker.prototype.init;
AgentBroker.prototype.init = async function () { await init.call(this); broker = this; };
const preflight = WorkerRuntimeFactory.prototype.preflight;
WorkerRuntimeFactory.prototype.preflight = async function (provider, modelId) {
  preparation = await preflight.call(this, provider, modelId);
  return preparation;
};

export default function mechanisticMetadata(pi: ExtensionAPI): void {
  extension(pi);
  pi.registerCommand("mechanistic-metadata", {
    description: "Exercise real catalog drift before Python creates a queued LLM identity",
    handler: async (_args, ctx) => {
      assert.ok(broker); assert.ok(ctx.model);
      const root = process.env.PI_CODING_AGENT_DIR!;
      const scenario = process.env.PI_METADATA_CASE!;
      const current = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)!;
      const changed = structuredClone(current);
      const compat = { ...changed.compat } as Record<string, unknown>;
      if (scenario === "remove") delete compat.supportsMidConvoSystemMessages;
      else if (scenario === "false") compat.supportsMidConvoSystemMessages = false;
      else if (scenario === "policy") compat.supportsToolSearch = !compat.supportsToolSearch;
      else if (scenario === "malformed") compat.supportsMidConvoSystemMessages = "true";
      else compat.supportsMidConvoSystemMessages = true;
      changed.compat = compat;
      if (scenario === "endpoint") changed.baseUrl = "https://changed.invalid/v1";
      if (scenario === "headers") changed.headers = { authorization: "PRIVATE_METADATA_HEADER" };
      if (scenario === "registered") {
        // A real registered provider can interpret arbitrary metadata in its
        // callback, so even this catalog annotation must remain exact there.
        const config = ctx.modelRegistry.getRegisteredProviderConfig(current.provider)!;
        config.models![0]!.compat = compat;
      } else {
        // Write the actual persisted overlay consumed by Pi's ModelRuntime,
        // reproducing catalog refresh without a network or model request.
        await writeFile(join(root, "models-store.json"), JSON.stringify({
          [current.provider]: { models: [changed], checkedAt: Date.now(), lastModified: 4_102_444_800_000 },
        }));
      }
      const recipient = `reader.metadata@${current.id}.com`;
      const accepted = await broker.send(broker.mainAddress, {
        to: "evidence.metadata@mechanistic.com", subject: "Observe changed catalog",
        message: JSON.stringify({ notify_to: recipient }), priority: "low",
      });
      let acknowledgment: Record<string, unknown> | undefined;
      const end = Date.now() + 10_000;
      while (!acknowledgment) {
        try { acknowledgment = JSON.parse(await readFile(join(root, "ack.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (Date.now() >= end) throw new Error("Python did not publish its acknowledgment");
        if (!acknowledgment) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const snapshot = broker.getSnapshot();
      const record = snapshot.agents.find((agent) => agent.address === recipient);
      if (record) {
        assert.equal(record.kind, "llm");
        assert.equal(record.state, "queued");
        if (record.kind !== "llm") throw new Error("Expected a real LLM identity");
        const session = await readFile(record.sessionFile!, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        });
        assert.doesNotMatch(session, /"type":"message"/, "queued recipient has no prompt or assistant turn");
        await broker.stop(recipient);
      }
      await broker.stop(accepted.envelope.to);
      await writeFile(process.env.PI_METADATA_PROOF!, JSON.stringify({
        acknowledgment, record, prepared: preparation?.model,
        mail: broker.mailStore.list(), jobs: broker.mailStore.listJobs(), snapshot,
      }));
      ctx.shutdown();
    },
  });
}
