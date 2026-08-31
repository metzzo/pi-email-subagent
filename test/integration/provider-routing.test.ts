import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { ProviderReadinessError } from "../../src/model-runtime.ts";
import { MailStore } from "../../src/mail-store.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { SendEmailResult } from "../../src/types.ts";
import { eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

interface Harness {
  broker: AgentBroker;
  main: FakeMainAdapter;
  workers: FakeWorker[];
  providers: string[];
}

async function start(
  root: string,
  models: Model<any>[],
  preferredProvider: string | undefined,
  main = new FakeMainAdapter("main@shared.com"),
  boundary: {
    preflight?: (model: Model<any>) => Promise<void>;
    factory?: (model: Model<any>) => FakeWorker | Promise<FakeWorker>;
  } = {},
): Promise<Harness> {
  const workers: FakeWorker[] = [];
  const providers: string[] = [];
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models,
    preferredProvider,
    mainAdapter: main,
    workerPreflight: boundary.preflight,
    workerFactory: async (model) => {
      providers.push(model.provider);
      const worker = boundary.factory ? await boundary.factory(model) : new FakeWorker();
      workers.push(worker);
      return worker;
    },
    projectTrusted: true,
  });
  await broker.init();
  return { broker, main, workers, providers };
}

const alpha = () => fakeModel("shared", "provider-alpha");
const beta = () => fakeModel("shared", "provider-beta");

async function answerAndIdle(harness: Harness, sent: SendEmailResult, workerIndex: number): Promise<void> {
  const worker = harness.workers[workerIndex]!;
  await worker.send({
    to: harness.broker.mainAddress,
    subject: makeReplySubject(sent.envelope.id, sent.envelope.subject),
    message: "Done.",
    priority: "low",
  });
  worker.settle();
  await eventually(() => assert.equal(harness.broker.inspectAgent(sent.envelope.to).state, "idle"));
}

describe("provider-aware durable routing", () => {
  it("fails a new credential-source incompatibility before email acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-preflight-"));
    let preflights = 0;
    const harness = await start(root, [alpha()], "provider-alpha", undefined, {
      preflight: async (selected) => {
        preflights += 1;
        throw new ProviderReadinessError(
          selected.provider,
          "credential-source-unsupported",
          "Credential source for provider provider-alpha is unsupported for isolated workers (parent: runtime; worker: stored). Reload after correcting provider authentication.",
        );
      },
    });
    try {
      await assert.rejects(
        harness.broker.send(harness.broker.mainAddress, {
          to: "worker.preflight@shared.com", subject: "Preflight", message: "Do not accept this.", priority: "low",
        }),
        /credential source.*runtime.*stored/i,
      );
      assert.equal(preflights, 1);
      assert.equal(harness.broker.mailStore.list().length, 0);
      assert.equal(harness.broker.getSnapshot().agents.length, 0);
      assert.equal(harness.workers.length, 0);
    } finally {
      await harness.broker.shutdown();
    }
  });

  it("keeps archived mail queued on readiness failure and never probes ordinary mail to the failed identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-readiness-existing-"));
    let blocked = false;
    let preflights = 0;
    let factories = 0;
    const readinessFailure = () => new ProviderReadinessError(
      "provider-alpha",
      "credential-source-mismatch",
      "Credential source for provider provider-alpha is incompatible with the extension-start snapshot (parent: environment; worker: stored). Reload after correcting provider authentication.",
    );
    const harness = await start(root, [alpha()], "provider-alpha", undefined, {
      preflight: async () => {
        preflights += 1;
        if (blocked) throw readinessFailure();
      },
      factory: async () => {
        factories += 1;
        if (blocked) throw readinessFailure();
        return new FakeWorker();
      },
    });
    try {
      const initial = await harness.broker.send(harness.broker.mainAddress, {
        to: "worker.readiness-existing@shared.com", subject: "Initial", message: "Create supported identity.", priority: "low",
      });
      await answerAndIdle(harness, initial, 0);
      await harness.broker.archive(initial.envelope.to);
      assert.equal(preflights, 1);
      assert.equal(factories, 1);

      blocked = true;
      await assert.rejects(
        harness.broker.send(harness.broker.mainAddress, {
          to: initial.envelope.to, subject: "Restore", message: "Keep queued if readiness changed.", priority: "low",
        }),
        /persisted but delivery failed.*credential source.*environment.*stored/i,
      );
      const failed = harness.broker.inspectAgent(initial.envelope.to);
      assert.equal(failed.state, "failed");
      assert.match(failed.failure ?? "", /credential source.*environment.*stored/i);
      const restore = harness.broker.mailStore.list().find((email) => email.subject === "Restore");
      assert.equal(restore?.deliveryState, "queued");
      assert.equal(preflights, 1, "existing identity restoration does not run new-identity preflight");
      assert.equal(factories, 2);

      const ordinary = await harness.broker.send(harness.broker.mainAddress, {
        to: initial.envelope.to, subject: "While failed", message: "Accept without readiness work.", priority: "low",
      });
      assert.equal(ordinary.recipientDisposition, "failed");
      assert.equal(ordinary.envelope.deliveryState, "queued");
      assert.equal(preflights, 1);
      assert.equal(factories, 2, "ordinary mail to failed identity performs no runtime readiness work");

      await assert.rejects(harness.broker.restart(initial.envelope.to), /credential source.*environment.*stored/i);
      assert.equal(factories, 3, "explicit restart performs readiness through worker creation");
      assert.equal(harness.broker.mailStore.list().filter((email) => email.subject === "Restore")[0]?.deliveryState, "queued");
    } finally {
      await harness.broker.shutdown();
    }
  });

  it("fails a new duplicate address before acceptance when current provider cannot select exactly one candidate", async () => {
    for (const preferred of [undefined, "provider-gamma"]) {
      const root = await mkdtemp(join(tmpdir(), "pi-email-provider-ambiguous-"));
      const harness = await start(root, [alpha(), beta()], preferred);
      try {
        await assert.rejects(
          harness.broker.send(harness.broker.mainAddress, {
            to: "worker.ambiguous@shared.com", subject: "Ambiguous", message: "Do not accept this.", priority: "low",
          }),
          new RegExp(`current main provider \\"${preferred ?? "none"}\\" does not identify exactly one candidate.*no email was accepted`, "i"),
        );
        assert.equal(harness.broker.mailStore.list().length, 0);
        assert.equal(harness.broker.getSnapshot().agents.length, 0);
        assert.equal(harness.workers.length, 0);
      } finally {
        await harness.broker.shutdown();
      }
    }
  });

  it("preserves an existing exact binding after duplicates appear under another main provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-routing-"));
    const first = await start(root, [alpha()], "provider-alpha");
    const sent = await first.broker.send(first.broker.mainAddress, {
      to: "worker.persist@shared.com", subject: "Persist", message: "Keep this binding.", priority: "low",
    });
    assert.equal(sent.recipientProvider, "provider-alpha");
    assert.deepEqual(sent.envelope.modelBindingIntent, { provider: "provider-alpha", modelId: "shared" });
    await first.broker.shutdown();

    const restored = await start(root, [alpha(), beta()], "provider-beta");
    try {
      assert.deepEqual(restored.providers, ["provider-alpha"]);
      const inspection = restored.broker.inspectAgent(sent.envelope.to);
      assert.equal(inspection.provider, "provider-alpha");
      assert.equal(inspection.modelId, "shared");
      assert.equal(restored.broker.getSnapshot().agents[0]?.provider, "provider-alpha");
    } finally {
      await restored.broker.shutdown();
    }
  });

  it("updates future selection on a same-model main switch while stop, restart, archive, and reuse retain bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-switch-"));
    const harness = await start(root, [alpha(), beta()], "provider-alpha");
    try {
      const alphaSend = await harness.broker.send(harness.broker.mainAddress, {
        to: "worker.alpha@shared.com", subject: "Alpha", message: "Bind alpha.", priority: "low",
      });
      assert.equal(alphaSend.recipientProvider, "provider-alpha");
      await answerAndIdle(harness, alphaSend, 0);
      await harness.broker.stop(alphaSend.envelope.to);

      await harness.broker.updateMainModel("main@shared.com", "provider-beta");
      assert.equal(harness.broker.mainAddress, "main@shared.com");
      await harness.broker.restart(alphaSend.envelope.to);
      assert.equal(harness.providers.at(-1), "provider-alpha");
      await eventually(() => assert.equal(harness.broker.inspectAgent(alphaSend.envelope.to).state, "idle"));
      await harness.broker.archive(alphaSend.envelope.to);

      const betaSend = await harness.broker.send(harness.broker.mainAddress, {
        to: "worker.beta@shared.com", subject: "Beta", message: "Bind beta.", priority: "low",
      });
      assert.equal(betaSend.recipientProvider, "provider-beta");
      assert.deepEqual(betaSend.envelope.modelBindingIntent, { provider: "provider-beta", modelId: "shared" });

      const restoredAlpha = await harness.broker.send(harness.broker.mainAddress, {
        to: alphaSend.envelope.to, subject: "Restore alpha", message: "Reuse original binding.", priority: "low",
      });
      assert.equal(restoredAlpha.recipientDisposition, "restored");
      assert.equal(restoredAlpha.recipientProvider, "provider-alpha");
      assert.equal(harness.providers.at(-1), "provider-alpha");
    } finally {
      await harness.broker.shutdown();
    }
  });

  it("keeps a removed known binding unavailable without blocking unrelated restore, then recovers it when reintroduced", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-removed-"));
    const initial = await start(root, [alpha(), beta()], "provider-alpha");
    const alphaSend = await initial.broker.send(initial.broker.mainAddress, {
      to: "worker.removed@shared.com", subject: "Alpha", message: "Persist alpha.", priority: "low",
    });
    await initial.broker.updateMainModel("main@shared.com", "provider-beta");
    const betaSend = await initial.broker.send(initial.broker.mainAddress, {
      to: "worker.available@shared.com", subject: "Beta", message: "Persist beta.", priority: "low",
    });
    await initial.broker.shutdown();
    const registryPath = join(root, "state", "registry.json");
    const persisted = JSON.parse(await readFile(registryPath, "utf8"));
    const persistedAlpha = persisted.agents.find((record: any) => record.address === alphaSend.envelope.to);
    persistedAlpha.tools = ["read", "legacy-tool", "send_email", "fetch_emails"];
    persistedAlpha.instructions = "Preserve this unavailable profile.";
    await writeFile(registryPath, JSON.stringify(persisted, null, 2));

    const missing = await start(root, [beta()], "provider-beta");
    try {
      assert.deepEqual(missing.providers, ["provider-beta"]);
      const removed = missing.broker.inspectAgent(alphaSend.envelope.to);
      assert.equal(removed.provider, "provider-alpha");
      assert.equal(removed.modelId, "shared");
      assert.equal(removed.state, "failed");
      assert.equal(removed.providerReady, "unavailable");
      assert.equal(removed.holdsActivationLease, false);
      assert.deepEqual(removed.tools, ["read", "legacy-tool", "send_email", "fetch_emails"]);
      assert.equal(removed.instructions, "Preserve this unavailable profile.");
      assert.match(removed.failure ?? "", /bound to provider-alpha\/shared.*not rebound/is);
      assert.equal(missing.broker.inspectAgent(betaSend.envelope.to).provider, "provider-beta");
      const before = missing.broker.mailStore.list().length;
      const queued = await missing.broker.send(missing.broker.mainAddress, {
        to: alphaSend.envelope.to, subject: "Do not substitute", message: "Accept under the failed identity only.", priority: "low",
      });
      assert.equal(queued.recipientDisposition, "failed");
      assert.equal(queued.recipientProvider, "provider-alpha");
      assert.equal(queued.envelope.deliveryState, "queued");
      assert.equal(queued.spawned, false);
      assert.equal(missing.broker.mailStore.list().length, before + 1);
      await assert.rejects(missing.broker.restart(alphaSend.envelope.to), /bound to provider-alpha\/shared.*not rebound/is);
    } finally {
      await missing.broker.shutdown();
    }

    const returned = await start(root, [alpha(), beta()], "provider-beta");
    try {
      assert.equal(returned.providers.includes("provider-alpha"), false, "catalog recovery does not implicitly restart a failed identity");
      assert.equal(returned.broker.inspectAgent(alphaSend.envelope.to).provider, "provider-alpha");
      assert.equal(returned.broker.inspectAgent(alphaSend.envelope.to).state, "failed");
      assert.equal(returned.broker.mailStore.list().some((email) => email.subject === "Do not substitute"), true);
      await returned.broker.restart(alphaSend.envelope.to);
      assert.ok(returned.providers.includes("provider-alpha"));
      await eventually(() => assert.notEqual(returned.broker.inspectAgent(alphaSend.envelope.to).state, "failed"));
    } finally {
      await returned.broker.shutdown();
    }
  });

  it("recovers crash-window binding intent exactly and fails closed for an ambiguous legacy orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-orphan-"));
    const store = new MailStore(join(root, "state", "mail.jsonl"));
    await store.init();
    await store.accept({
      id: "mail_bound_orphan",
      from: "main@shared.com",
      to: "worker.bound-orphan@shared.com",
      subject: "Bound orphan",
      message: "Recover alpha exactly.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
      effortIntent: "high",
      lifecycleIntent: structuredClone(DEFAULT_CONFIG.lifecycle),
      modelBindingIntent: { provider: "provider-alpha", modelId: "shared" },
    });
    await store.accept({
      id: "mail_legacy_orphan",
      from: "main@shared.com",
      to: "worker.legacy-orphan@shared.com",
      subject: "Legacy orphan",
      message: "Do not guess.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date(Date.now() + 1).toISOString(),
      deliveryState: "queued",
    });

    const recovered = await start(root, [alpha(), beta()], "provider-beta");
    try {
      assert.equal(recovered.broker.inspectAgent("worker.bound-orphan@shared.com").provider, "provider-alpha");
      const legacy = recovered.broker.inspectAgent("worker.legacy-orphan@shared.com");
      assert.equal(legacy.provider, "unavailable");
      assert.equal(legacy.state, "failed");
      assert.match(legacy.failure ?? "", /original provider cannot be inferred.*no substitution/is);
      assert.deepEqual(recovered.providers, ["provider-alpha"]);
    } finally {
      await recovered.broker.shutdown();
    }
  });

  it("uniquely migrates legacy queued mail and a historical synthetic unavailable record without main preference", async () => {
    const orphanRoot = await mkdtemp(join(tmpdir(), "pi-email-provider-legacy-"));
    const orphanStore = new MailStore(join(orphanRoot, "state", "mail.jsonl"));
    await orphanStore.init();
    await orphanStore.accept({
      id: "mail_legacy_unique",
      from: "main@shared.com",
      to: "worker.legacy-unique@shared.com",
      subject: "Legacy unique",
      message: "Recover only from one global candidate.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
    });
    const orphan = await start(orphanRoot, [alpha()], "provider-beta");
    try {
      const migrated = orphan.broker.inspectAgent("worker.legacy-unique@shared.com");
      assert.equal(migrated.provider, "provider-alpha");
      assert.ok(orphan.broker.getSnapshot().agents[0]?.activity.some((item) => /Legacy provider binding uniquely migrated/.test(item.summary)));
    } finally {
      await orphan.broker.shutdown();
    }

    const syntheticRoot = await mkdtemp(join(tmpdir(), "pi-email-provider-synthetic-"));
    const first = await start(syntheticRoot, [alpha()], "provider-alpha");
    const sent = await first.broker.send(first.broker.mainAddress, {
      to: "worker.synthetic@shared.com", subject: "Synthetic", message: "Persist before migration.", priority: "low",
    });
    await first.broker.shutdown();
    const registryPath = join(syntheticRoot, "state", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const record = registry.agents.find((candidate: any) => candidate.address === sent.envelope.to);
    record.provider = "unavailable";
    record.state = "failed";
    record.failure = "Model unavailable during restore: historical unbound record";
    await writeFile(registryPath, JSON.stringify(registry, null, 2));

    const synthetic = await start(syntheticRoot, [alpha()], "provider-beta");
    try {
      const migrated = synthetic.broker.inspectAgent(sent.envelope.to);
      assert.equal(migrated.provider, "provider-alpha");
      assert.equal(migrated.state, "failed");
      assert.match(migrated.failure ?? "", /explicit same-identity restart is required/i);
      assert.ok(synthetic.broker.getSnapshot().agents.find((item) => item.address === sent.envelope.to)?.activity
        .some((item) => /Legacy provider binding uniquely migrated to provider-alpha\/shared/.test(item.summary)));
      await synthetic.broker.restart(sent.envelope.to);
      await eventually(() => assert.notEqual(synthetic.broker.inspectAgent(sent.envelope.to).state, "failed"));
    } finally {
      await synthetic.broker.shutdown();
    }
  });

  it("publishes the new provider preference synchronously before model-switch persistence completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-update-race-"));
    const harness = await start(root, [alpha(), beta()], "provider-alpha");
    let saveEntered!: () => void;
    const enteredSave = new Promise<void>((resolve) => { saveEntered = resolve; });
    let releaseSave!: () => void;
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    const realSave = harness.broker.registryStore.save.bind(harness.broker.registryStore);
    let blockNext = true;
    harness.broker.registryStore.save = async (registry) => {
      if (blockNext) {
        blockNext = false;
        saveEntered();
        await saveRelease;
      }
      await realSave(registry);
    };
    let acceptEntered!: () => void;
    const enteredAccept = new Promise<void>((resolve) => { acceptEntered = resolve; });
    const realAccept = harness.broker.mailStore.accept.bind(harness.broker.mailStore);
    harness.broker.mailStore.accept = async (email) => {
      await realAccept(email);
      acceptEntered();
    };
    try {
      const switching = harness.broker.updateMainModel("main@shared.com", "provider-beta");
      await enteredSave;
      const sending = harness.broker.send(harness.broker.mainAddress, {
        to: "worker.new-preference@shared.com", subject: "New preference", message: "Bind beta.", priority: "low",
      });
      await enteredAccept;
      releaseSave();
      const [sent] = await Promise.all([sending, switching]);
      assert.equal(sent.recipientProvider, "provider-beta");
      assert.deepEqual(sent.envelope.modelBindingIntent, { provider: "provider-beta", modelId: "shared" });
      assert.equal(harness.providers[0], "provider-beta");
    } finally {
      releaseSave();
      harness.broker.registryStore.save = realSave;
      harness.broker.mailStore.accept = realAccept;
      await harness.broker.shutdown();
    }
  });

  it("uses the binding chosen before a blocked acceptance even when main switches provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-provider-race-"));
    const harness = await start(root, [alpha(), beta()], "provider-alpha");
    let entered!: () => void;
    const acceptanceEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const acceptanceRelease = new Promise<void>((resolve) => { release = resolve; });
    const realAccept = harness.broker.mailStore.accept.bind(harness.broker.mailStore);
    harness.broker.mailStore.accept = async (email) => {
      entered();
      await acceptanceRelease;
      await realAccept(email);
    };
    try {
      const sending = harness.broker.send(harness.broker.mainAddress, {
        to: "worker.race@shared.com", subject: "Race", message: "Keep selected binding.", priority: "low",
      });
      await acceptanceEntered;
      const switching = harness.broker.updateMainModel("main@shared.com", "provider-beta");
      const concurrent = harness.broker.send(harness.broker.mainAddress, {
        to: "worker.race@shared.com", subject: "Concurrent", message: "Reuse accepted intent.", priority: "low",
      });
      release();
      const [sent, concurrentSent] = await Promise.all([sending, concurrent, switching]);
      assert.equal(sent.recipientProvider, "provider-alpha");
      assert.equal(concurrentSent.recipientProvider, "provider-alpha");
      assert.deepEqual(sent.envelope.modelBindingIntent, { provider: "provider-alpha", modelId: "shared" });
      assert.equal(concurrentSent.envelope.modelBindingIntent, undefined);
      assert.equal(harness.providers[0], "provider-alpha");
      assert.equal(harness.broker.getSnapshot().agents.filter((record) => record.address === sent.envelope.to).length, 1);
    } finally {
      release();
      harness.broker.mailStore.accept = realAccept;
      await harness.broker.shutdown();
    }
  });
});
