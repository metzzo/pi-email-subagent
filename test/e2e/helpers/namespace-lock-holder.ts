import { NamespaceLock } from "../../../src/namespace-lock.ts";

const namespace = process.argv[2];
if (!namespace) throw new Error("namespace path argument is required");

await NamespaceLock.acquire(namespace, (error) => {
  process.stderr.write(`namespace lock compromised: ${error.message}\n`);
  process.exit(2);
});

process.stdout.write(`READY ${process.pid}\n`);
setInterval(() => undefined, 60_000);
