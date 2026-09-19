import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, EmailEnvelope, MechanisticJob } from "../../src/types.ts";
import { PiRpcClient } from "./helpers/rpc-client.ts";

for (const scenario of ["add", "remove", "empty", "false", "policy", "malformed", "endpoint", "headers", "registered"]) {
  const allowed = ["add", "remove", "empty"].includes(scenario);
  it(`Python/new-LLM admission ${allowed ? "accepts equivalent" : "rejects changed"} ${scenario} catalog metadata`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "python-model-metadata-"));
    const proof = join(root, "proof.json");
    const script = join(root, "evidence.py");
    // Real SDK credential-source checks only; the shared run slot keeps the
    // recipient queued, so this test makes no model/provider request.
    await writeFile(join(root, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "metadata-admission-only" } }), { mode: 0o600 });
    await writeFile(script, "import json, time\nfrom pathlib import Path\nfrom pi_mechanistic import arguments, send_email\na=arguments()\nack=send_email(a['notify_to'],'METADATA_NOTIFICATION','Local metadata observation')\nPath('ack.tmp').write_text(json.dumps(ack))\nPath('ack.tmp').replace('ack.json')\ntime.sleep(60)\n");
    await writeFile(join(root, "subagents.json"), JSON.stringify({ maxConcurrent: 1, mechanisticPrograms: { evidence: { python: "python3", script, cwd: root } } }));
    if (scenario === "remove" || scenario === "empty") {
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
      const model = structuredClone(runtime.getModel("openai", "gpt-5.4")!);
      assert.ok(model);
      const compatibility: Record<string, unknown> = scenario === "empty" ? {} : { ...model.compat, supportsMidConvoSystemMessages: true };
      model.compat = compatibility;
      await writeFile(join(root, "models-store.json"), JSON.stringify({ openai: { models: [model], checkedAt: Date.now(), lastModified: 4_102_444_800_000 } }));
    }
    const client = PiRpcClient.launch({
      cwd: root, agentDir: root, model: scenario === "registered" ? "mock-e2e/mock-e2e" : "openai/gpt-5.4",
      extensions: [...(scenario === "registered" ? [resolve("test/e2e/helpers/mock-provider-extension.ts")] : []), resolve("test/e2e/helpers/mechanistic-metadata-extension.ts")],
      env: { PI_OFFLINE: "1", PI_METADATA_CASE: scenario, PI_METADATA_PROOF: proof },
    });
    try {
      await client.getState(); await client.prompt("/mechanistic-metadata");
      const result = JSON.parse(await readFile(proof, "utf8").catch((error: unknown) => {
        throw new Error(`${String(error)}\n${JSON.stringify(client.events())}\n${client.stderr}`);
      })) as {
        acknowledgment: { accepted: boolean; mailId?: string; error?: string; deliveryUncertain?: unknown };
        record?: AgentRecord; prepared?: { compat?: Record<string, unknown> };
        mail: EmailEnvelope[]; jobs: MechanisticJob[]; snapshot: { capacity: { runSlotsUsed: number } };
      };
      assert.equal(result.acknowledgment.accepted, allowed, JSON.stringify(result.acknowledgment));
      assert.equal(result.snapshot.capacity.runSlotsUsed, 1, "real Python holds the one shared run slot");
      assert.equal(result.jobs.length, 1);
      const notifications = result.mail.filter((mail) => mail.subject === "METADATA_NOTIFICATION");
      if (allowed) {
        assert.equal(result.record?.kind, "llm");
        if (result.record?.kind !== "llm") throw new Error("Expected LLM record");
        assert.equal(result.record.provider, "openai"); assert.equal(result.record.modelId, "gpt-5.4");
        assert.equal(result.record.state, "queued"); assert.equal(typeof result.record.sessionFile, "string");
        assert.equal(notifications.length, 1);
        const mail = notifications[0]!;
        assert.equal(mail.id, result.acknowledgment.mailId);
        assert.equal(mail.from, "evidence.metadata@mechanistic.com"); assert.equal(mail.to, result.record.address);
        assert.equal(mail.kind, "notification"); assert.equal(mail.requiresResponse, false); assert.equal(mail.inReplyTo, undefined);
        assert.equal(result.prepared?.compat?.supportsMidConvoSystemMessages, scenario === "remove" ? undefined : true, "only comparison is normalized; the exact runtime model is preserved");
      } else {
        assert.equal(result.record, undefined); assert.equal(result.prepared, undefined);
        assert.equal(result.acknowledgment.mailId, undefined); assert.equal(result.acknowledgment.deliveryUncertain, undefined);
        assert.equal(notifications.length, 0, "unsafe metadata fails before mail/identity acceptance");
        assert.match(result.acknowledgment.error!, scenario === "headers" ? /header.*provenance/i : /request metadata differs.*reload/i);
        assert.doesNotMatch(result.acknowledgment.error!, /PRIVATE_METADATA_HEADER/);
      }
    } finally { await client.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  });
}
