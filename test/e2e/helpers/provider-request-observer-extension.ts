import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function providerRequestObserver(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (_event, context) => {
    appendFileSync(join(context.cwd, ".provider-requests"), "1\n", "utf8");
  });
}
