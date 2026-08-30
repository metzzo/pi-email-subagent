import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function shutdownOnSettled(pi: ExtensionAPI): void {
  let requested = false;
  pi.on("agent_settled", (_event, ctx) => {
    if (requested) return;
    requested = true;
    ctx.shutdown();
  });
}
