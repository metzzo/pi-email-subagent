import { readFileSync, writeFileSync } from "node:fs";

const readinessPath = process.argv[2];
const heartbeatPath = process.argv[3];
if (!readinessPath || !heartbeatPath) throw new Error("readiness and heartbeat paths are required");

function processStartTime(pid: number): string {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = value.lastIndexOf(")");
  const fields = value.slice(close + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime) throw new Error("process start time unavailable");
  return startTime;
}

writeFileSync(readinessPath, JSON.stringify({
  pid: process.pid,
  processStartTime: processStartTime(process.pid),
  heartbeatPath,
  startedAt: new Date().toISOString(),
}));
let sequence = 0;
const write = () => writeFileSync(heartbeatPath, JSON.stringify({
  pid: process.pid,
  processStartTime: processStartTime(process.pid),
  sequence: ++sequence,
  at: Date.now(),
}));
write();
setInterval(write, 100);
