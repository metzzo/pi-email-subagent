import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { awaitPromptAcceptance, effectiveWorkerModel, terminalAgentError } from "../../src/sdk-worker.ts";

const failedRun = [{
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "404 resource not found",
}] as unknown as AgentMessage[];

describe("SDK worker failures", () => {
  it("surfaces terminal model errors instead of treating them as successful settlement", () => {
    assert.equal(terminalAgentError(failedRun, false), "404 resource not found");
  });

  it("does not fail a worker while AgentSession will retry the request", () => {
    assert.equal(terminalAgentError(failedRun, true), undefined);
  });

  it("uses the exact model object resolved by the worker runtime snapshot", () => {
    const parent = { provider: "custom", id: "model", baseUrl: "https://parent.invalid" } as never;
    const snapshot = { provider: "custom", id: "model", baseUrl: "https://worker.invalid" } as never;
    assert.equal(effectiveWorkerModel(parent, snapshot), snapshot);
    assert.equal(effectiveWorkerModel(parent), parent);
  });

  it("rejects promptly when AgentSession preflight rejects a prompt", async () => {
    await assert.rejects(
      awaitPromptAcceptance(async (preflight) => { preflight(false); }),
      /rejected during preflight/,
    );
  });

  it("rejects when a prompt completes without a preflight decision", async () => {
    await assert.rejects(awaitPromptAcceptance(async () => undefined), /without being accepted/);
  });
});
