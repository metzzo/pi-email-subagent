import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG, DEFAULT_LIFECYCLE } from "../../src/config.ts";
import { emailErrorDetails } from "../../src/email-error.ts";
import { MailStore } from "../../src/mail-store.ts";
import { createWorkerMailTools } from "../../src/sdk-worker.ts";
import type { AgentRecord } from "../../src/types.ts";

for (const fault of ["registry", "publication", "failure-finalization"] as const) {
  it(`preserves accepted mail at the tool boundary after ${fault} failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-acceptance-"));
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
    const model = runtime.getModel("openai-codex", "gpt-5.4-mini")!;
    assert.ok(model);
    const mainAddress = `main@${model.id}.com`;
    const session = SessionManager.inMemory(root);
    let armed = false;
    const record: AgentRecord = {
      address: `worker.acceptance@${model.id}.com`, name: "worker", taskSlug: "acceptance",
      provider: model.provider, modelId: model.id, effort: "off", tools: ["send_email", "fetch_emails"],
      state: "failed", failure: "Prior failure", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      enforcementAttempts: 0, lifecycle: { ...DEFAULT_LIFECYCLE }, activity: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
    const broker = new AgentBroker({
      cwd: root, agentDir: root, namespaceDir: join(root, "state"),
      config: structuredClone(DEFAULT_CONFIG), models: [model], projectTrusted: false,
      mainAdapter: {
        getAddress: () => mainAddress, getAliases: () => new Set([mainAddress]), isIdle: () => true,
        async deliver({ formatted, envelope }) {
          if (armed && fault === "failure-finalization") {
            // The accepted append is complete; now make failure journaling fail too.
            await rename(broker.mailStore.path, `${broker.mailStore.path}.saved`);
            await mkdir(broker.mailStore.path);
            throw new Error("delivery unavailable");
          }
          session.appendCustomMessageEntry("test.mail", formatted, true, envelope);
        },
        notifyFailure(message) { session.appendCustomEntry("test.failure", { message }); },
        updateState(snapshot) {
          if (armed && fault === "publication") throw new Error("publication unavailable");
          session.appendCustomEntry("test.state", snapshot);
        },
      },
      workerFactory: async () => { throw new Error("Failed recipients must not start workers"); },
    });
    await mkdir(join(root, "state"));
    await broker.registryStore.save({ version: 1, mainAddress, mainAliases: [mainAddress], agents: [record], updatedAt: record.updatedAt });
    await broker.init();
    const blockedPath = fault === "registry" ? broker.registryStore.path : broker.mailStore.path;
    try {
      if (fault === "registry") {
        await rename(blockedPath, `${blockedPath}.saved`);
        await mkdir(blockedPath);
      }
      armed = true;
      const sender = fault === "failure-finalization" ? record.address : mainAddress;
      const [send] = createWorkerMailTools({
        sendEmail: (input, signal) => broker.send(sender, input, signal),
        fetchEmails: () => broker.fetchUnansweredBatch(sender),
      });
      await assert.rejects(send.execute("send", {
        to: fault === "failure-finalization" ? mainAddress : record.address,
        subject: "Accepted work", message: "Do not duplicate this request.", priority: "low",
      }, new AbortController().signal, undefined, undefined as never), (error: unknown) => {
        const details = emailErrorDetails(error);
        assert.equal(details.code, "EMAIL_DELIVERY_FAILED");
        const [accepted] = broker.mailStore.list();
        assert.ok(accepted);
        assert.equal(details.fields.email_id, accepted.id);
        assert.match(details.message, /persisted/);
        return true;
      });
      const recovered = new MailStore(fault === "failure-finalization" ? `${blockedPath}.saved` : broker.mailStore.path);
      await recovered.init();
      assert.equal(recovered.list().length, 1);
      assert.equal(recovered.list()[0]!.deliveryState, "queued");
    } finally {
      armed = false;
      if (fault !== "publication") {
        await rm(blockedPath, { recursive: true, force: true });
        await rename(`${blockedPath}.saved`, blockedPath);
      }
      if (fault === "failure-finalization") await assert.rejects(broker.shutdown(), /poisoned/);
      else await broker.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}
