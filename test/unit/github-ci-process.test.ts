import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

it("CI observer bounds real subprocess output/time, reaps failures and does not expose stderr", { timeout: 30000 }, async (t) => {
  const code = `
import sys, time
sys.path.insert(0, ${JSON.stringify(resolve("src/python/examples"))})
from github_ci import read_command, ObservationError
assert read_command([sys.executable, '-c', "print('actual output')"]) == 'actual output'
for command, fragment in [
 ([sys.executable, '-c', "import sys; sys.stderr.write('PRIVATE_STDERR'); sys.exit(7)"], 'exit 7'),
 ([sys.executable, '-c', "import sys; sys.stdout.write('x'*1048577)"], '1 MiB'),
 ([sys.executable, '-c', "import sys; sys.stderr.write('x'*1048577)"], '1 MiB'),
 ([sys.executable, '-c', "import time; time.sleep(25)"], 'timed out'),
]:
 start=time.monotonic()
 try:
  read_command(command)
  raise AssertionError('expected bounded read failure')
 except ObservationError as error:
  assert fragment in str(error), str(error)
  assert 'PRIVATE_STDERR' not in str(error)
 assert time.monotonic()-start < 23
print('real subprocess bounds confirmed')
`;
  const result = await promisify(execFile)("python3", ["-c", code], { env: { ...process.env, PYTHONPATH: resolve("src/python"), PYTHONDONTWRITEBYTECODE: "1" }, timeout: 26000, signal: t.signal });
  assert.match(result.stdout, /real subprocess bounds confirmed/);
});
