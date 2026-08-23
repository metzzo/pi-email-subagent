import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const readinessPath = process.argv[2];
const heartbeatPath = process.argv[3];
if (!readinessPath || !heartbeatPath) throw new Error("readiness and heartbeat paths are required");

const childScript = [
  "const fs = require('node:fs');",
  "const path = process.argv[1];",
  "let sequence = 0;",
  "const write = () => fs.writeFileSync(path, JSON.stringify({ pid: process.pid, sequence: ++sequence, at: Date.now() }));",
  "write();",
  "setInterval(write, 100);",
].join("");
const child = spawn(process.execPath, ["-e", childScript, heartbeatPath], {
  detached: false,
  stdio: "ignore",
});
if (!child.pid) throw new Error("descendant PID was unavailable");

writeFileSync(readinessPath, JSON.stringify({
  parentPid: process.pid,
  childPid: child.pid,
  heartbeatPath,
  startedAt: new Date().toISOString(),
}));
setInterval(() => undefined, 60_000);
