import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { JsonLineFramer, PiRpcClient, type RpcLine } from "../e2e/helpers/rpc-client.ts";

function clientWithFakeChild(): { client: PiRpcClient; child: EventEmitter & Record<string, any> } {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  return { client: new (PiRpcClient as any)(child), child };
}

describe("Pi RPC JSONL framing", () => {
  it("decodes a UTF-8 code point split across stdout chunks", () => {
    const records: RpcLine[] = [];
    const framer = new JsonLineFramer((record) => records.push(record));
    const payload = Buffer.from(`${JSON.stringify({ type: "response", text: "split 🙂 value" })}\n`, "utf8");
    const emoji = Buffer.from("🙂", "utf8");
    const split = payload.indexOf(emoji) + 1;

    framer.write(payload.subarray(0, split));
    framer.write(payload.subarray(split));
    framer.end();

    assert.deepEqual(records, [{ type: "response", text: "split 🙂 value" }]);
  });

  it("rejects a nonempty malformed LF-delimited record", async () => {
    const { client, child } = clientWithFakeChild();
    const waiting = client.waitFor(() => false, "unreachable response");
    child.stdout.write(Buffer.from('{"type": nope}\n'));
    await assert.rejects(waiting, /Malformed Pi RPC stdout JSONL record/);
    await assert.rejects(client.waitForExit(), /Malformed Pi RPC stdout JSONL record/);
  });

  it("rejects a nonempty unterminated record when stdout closes", async () => {
    const { client, child } = clientWithFakeChild();
    const waiting = client.waitFor(() => false, "unreachable response");
    child.stdout.write(Buffer.from('{"type":"response"}'));
    child.emit("close", 0);
    await assert.rejects(waiting, /Unterminated Pi RPC stdout JSONL record/);
    await assert.rejects(client.waitForExit(), /Unterminated Pi RPC stdout JSONL record/);
  });
});
