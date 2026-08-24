import assert from "node:assert/strict";
import { it } from "node:test";
import { isConfiguredWritable, isConservativeCleanupCapable } from "../../src/capability.ts";

it("uses named configured and cleanup predicates with fail-closed legacy custom tools", () => {
  const readOnly = ["read", "grep", "find", "ls", "send_email", "fetch_emails"];
  assert.equal(isConfiguredWritable(readOnly), false);
  assert.equal(isConservativeCleanupCapable(readOnly), false);
  for (const tools of [["bash"], ["edit"], ["write"], ["legacy_custom_tool"]]) {
    assert.equal(isConfiguredWritable(tools), true);
    assert.equal(isConservativeCleanupCapable(tools), true);
  }
});
