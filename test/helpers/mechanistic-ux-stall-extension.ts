import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentBroker } from "../../src/broker.ts";
import extension from "../../src/index.ts";

/** Share the real extension's loader graph; inject faults, not durable effects. */
export default function (pi: ExtensionAPI): void {
  extension(pi);
  const observationFailure = process.env.UX_OBSERVATION_FAILURE;
  if (observationFailure) {
    const inspect = AgentBroker.prototype.inspectMechanisticJob;
    AgentBroker.prototype.inspectMechanisticJob = function (id) {
      const result = inspect.call(this, id);
      if (result.job.address === "ci.observer@mechanistic.com" && existsSync(observationFailure)) {
        throw new Error("Injected command observation failure");
      }
      return result;
    };
  }
  const release = process.env.UX_FINALIZATION_RELEASE;
  const held = process.env.UX_FINALIZATION_HELD;
  if (!release || !held) return;
  const init = AgentBroker.prototype.init;
  AgentBroker.prototype.init = async function () {
    await init.call(this);
    const finish = this.mailStore.finishJob.bind(this.mailStore);
    this.mailStore.finishJob = async (...args) => {
      await finish(...args);
      writeFileSync(held, args[0].id);
      while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
    };
  };
}
