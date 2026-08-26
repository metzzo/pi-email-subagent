import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CLEANUP_RECOVERY_CONFIRMATION_TIMEOUT_MS,
  createCleanupRecoveryProposalCapability,
} from "../../src/confirmed-cleanup-recovery.ts";
import type { CleanupRecoveryCommandResult } from "../../src/cleanup-recovery.ts";

const ADDRESS = "worker.confirmed-recovery@gpt-5.6-sol.com";
const EVIDENCE = "The human said they externally verified exact generation 9 is quiescent.";

interface FakeContextOptions {
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  confirm?: (title: string, message: string, options?: { timeout?: number; signal?: AbortSignal }) => Promise<unknown>;
  sessionId?: string;
}

function fakeContext(options: FakeContextOptions = {}): ExtensionContext {
  return {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: options.confirm ?? (async () => true),
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-confirmed-recovery",
    },
  } as unknown as ExtensionContext;
}

function commandResult(evidence = EVIDENCE): CleanupRecoveryCommandResult {
  return {
    address: ADDRESS,
    audit: {
      workerGeneration: 9,
      releasedAt: "2026-09-01T00:00:00.000Z",
      evidence,
      source: "operator-attested",
    },
    offline: false,
  };
}

describe("one-use cleanup recovery confirmation capability", () => {
  it("gives model-provided evidence zero authority on denial, cancellation, timeout, or no UI", async () => {
    for (const label of ["denied", "cancelled", "timed out"] as const) {
      let executions = 0;
      let confirmationOptions: { timeout?: number } | undefined;
      const context = fakeContext({
        confirm: async (_title, _message, options) => {
          confirmationOptions = options;
          return false;
        },
      });
      const capability = createCleanupRecoveryProposalCapability({
        getState: () => ({ context, generation: 4, broker: undefined }),
        namespaceDir: (sessionId) => `/tmp/${sessionId}`,
        execute: async () => { executions += 1; return commandResult(); },
      });
      await assert.rejects(capability.propose("tool-fabricated", {
        address: ADDRESS,
        workerGeneration: 9,
        operatorEvidence: "Plausible but fabricated external quiescence evidence.",
      }), /rejected.*denied.*cancelled.*timed out|not authorized/i, label);
      assert.equal(executions, 0, label);
      assert.equal(confirmationOptions?.timeout, CLEANUP_RECOVERY_CONFIRMATION_TIMEOUT_MS, label);
    }

    const controller = new AbortController();
    let abortedExecutions = 0;
    const abortedContext = fakeContext({ confirm: async () => { controller.abort(); return true; } });
    const abortedCapability = createCleanupRecoveryProposalCapability({
      getState: () => ({ context: abortedContext, generation: 1, broker: undefined }),
      namespaceDir: () => "/tmp/aborted-ui",
      execute: async () => { abortedExecutions += 1; return commandResult(); },
    });
    await assert.rejects(abortedCapability.propose("tool-aborted", {
      address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
    }, controller.signal), /cancelled.*aborted|not authorized/i);
    assert.equal(abortedExecutions, 0);

    for (const [mode, hasUI] of [["json", false], ["print", false], ["tui", false]] as const) {
      let prompted = false;
      let executions = 0;
      const context = fakeContext({ mode, hasUI, confirm: async () => { prompted = true; return true; } });
      const capability = createCleanupRecoveryProposalCapability({
        getState: () => ({ context, generation: 1, broker: undefined }),
        namespaceDir: () => "/tmp/no-ui",
        execute: async () => { executions += 1; return commandResult(); },
      });
      await assert.rejects(capability.propose("tool-no-ui", {
        address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
      }), /live Pi UI.*unavailable|not authorized/i);
      assert.equal(prompted, false);
      assert.equal(executions, 0);
    }
  });

  it("requires exact boolean true and rejects every other runtime confirmation value", async () => {
    const rejectedValues: unknown[] = ["false", "true", "", 0, 1, -1, {}, [], null, undefined];
    for (const [index, value] of rejectedValues.entries()) {
      let executions = 0;
      const context = fakeContext({ confirm: async () => value });
      const capability = createCleanupRecoveryProposalCapability({
        getState: () => ({ context, generation: 1, broker: undefined }),
        namespaceDir: () => "/tmp/untrusted-confirmation",
        execute: async () => { executions += 1; return commandResult(); },
      });
      await assert.rejects(capability.propose(`tool-untrusted-${index}`, {
        address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
      }), /proposal rejected.*confirmation.*denied|not authorized/i, JSON.stringify(value));
      assert.equal(executions, 0, JSON.stringify(value));
    }
  });

  it("displays the exact canonical tuple and only bounded, sanitized evidence before one execution", async () => {
    const dialogs: Array<{ title: string; message: string; timeout?: number }> = [];
    let executions = 0;
    const rawEvidence = `  Human externally verified exact generation 9.\nAuthorization: Bearer do-not-display\u001b]0;bad\u0007 ${"x".repeat(500)}  `;
    const context = fakeContext({
      mode: "rpc",
      confirm: async (title, message, options) => {
        dialogs.push({ title, message, timeout: options?.timeout });
        return true;
      },
    });
    const capability = createCleanupRecoveryProposalCapability({
      getState: () => ({ context, generation: 7, broker: undefined }),
      namespaceDir: (sessionId) => `/tmp/${sessionId}`,
      execute: async (input, broker, namespaceDir) => {
        executions += 1;
        assert.equal(broker, undefined);
        assert.equal(namespaceDir, "/tmp/session-confirmed-recovery");
        assert.deepEqual(input, {
          address: ADDRESS,
          workerGeneration: 9,
          evidence: dialogs[0]!.message.match(/Evidence:\n([^\n]+)/)?.[1],
        });
        return commandResult(input.evidence);
      },
    });

    const result = await capability.propose("tool-approved-once", {
      address: "  WORKER.CONFIRMED-RECOVERY@GPT-5.6-SOL.COM  ",
      workerGeneration: 9,
      operatorEvidence: rawEvidence,
    });
    assert.equal(executions, 1);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0]!.title, /confirm cleanup recovery/i);
    assert.match(dialogs[0]!.message, new RegExp(`Address: ${ADDRESS.replaceAll(".", "\\.")}`));
    assert.match(dialogs[0]!.message, /Worker generation: 9/);
    assert.match(dialogs[0]!.message, /Evidence:\nHuman externally verified exact generation 9\./);
    assert.match(dialogs[0]!.message, /Authorization: \[redacted\]/i);
    assert.doesNotMatch(dialogs[0]!.message, /do-not-display|\u001b|bad/);
    assert.match(dialogs[0]!.message, /Pi did not prove process quiescence/i);
    assert.match(dialogs[0]!.message, /surviving effects may overlap/i);
    assert.match(dialogs[0]!.message, /one execution.*exact address.*generation.*evidence/i);
    assert.ok(Buffer.byteLength(dialogs[0]!.message, "utf8") < 1_500);
    assert.equal(dialogs[0]!.timeout, CLEANUP_RECOVERY_CONFIRMATION_TIMEOUT_MS);
    assert.equal(result.address, ADDRESS);
  });

  it("rejects context replacement or session-generation change after the dialog without executing", async () => {
    for (const scenario of ["context", "generation", "session"] as const) {
      let executions = 0;
      let generation = 3;
      let context = fakeContext({
        sessionId: "session-a",
        confirm: async () => {
          if (scenario === "context") context = fakeContext({ sessionId: "session-a" });
          if (scenario === "generation") generation += 1;
          if (scenario === "session") context = fakeContext({ sessionId: "session-b" });
          return true;
        },
      });
      const capability = createCleanupRecoveryProposalCapability({
        getState: () => ({ context, generation, broker: undefined }),
        namespaceDir: (sessionId) => `/tmp/${sessionId}`,
        execute: async () => { executions += 1; return commandResult(); },
      });
      await assert.rejects(capability.propose(`tool-stale-${scenario}`, {
        address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
      }), /session.*changed|context.*replaced|stale.*confirmation/i, scenario);
      assert.equal(executions, 0, scenario);
    }
  });

  it("consumes each approval once and a replay is a fresh confirmation", async () => {
    let prompts = 0;
    let executions = 0;
    const context = fakeContext({ confirm: async () => { prompts += 1; return true; } });
    const capability = createCleanupRecoveryProposalCapability({
      getState: () => ({ context, generation: 2, broker: undefined }),
      namespaceDir: () => "/tmp/replay",
      execute: async () => { executions += 1; return commandResult(); },
    });
    const input = { address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE };
    await capability.propose("tool-first", input);
    await capability.propose("tool-replay", input);
    assert.equal(prompts, 2);
    assert.equal(executions, 2);
  });

  it("rechecks current cleanup generation after approval and does not authorize a changed generation", async () => {
    let currentCleanupGeneration = 9;
    let mutations = 0;
    const context = fakeContext({ confirm: async () => { currentCleanupGeneration = 10; return true; } });
    const capability = createCleanupRecoveryProposalCapability({
      getState: () => ({ context, generation: 5, broker: undefined }),
      namespaceDir: () => "/tmp/generation-change",
      execute: async (input) => {
        if (input.workerGeneration !== currentCleanupGeneration) {
          throw new Error(`Cleanup generation mismatch: current is ${currentCleanupGeneration}.`);
        }
        mutations += 1;
        return commandResult();
      },
    });
    await assert.rejects(capability.propose("tool-generation-change", {
      address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
    }), /generation mismatch/i);
    assert.equal(mutations, 0);
  });
});
