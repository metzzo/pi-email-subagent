import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { PiRpcClient } from "../test/e2e/helpers/rpc-client.ts";
import {
  childJournalPath,
  safeSessionId,
  parseFiniteEnv,
  parseLiveModel,
  parseLfJournal,
  collectEnvelopes,
  hasDurableFinal,
  validateLiveGraph,
} from "./live-mechanistic-e2e-support.ts";
import type { MailEvent } from "../src/mail-store.ts";

interface RpcSummary {
  getStateResponses: number;
  promptResponses: number;
  settled: number;
  toolEnds: Array<{ toolName: string; isError: boolean }>;
  extensionErrors: number;
}
async function waitForExitWithin(
  client: PiRpcClient,
  milliseconds: number,
): Promise<{ exited: true; code: number | null } | { exited: false }> {
  const controller = new AbortController();
  const exit = client.waitForExit().then(
    (code) => ({ exited: true as const, code }),
    () => ({ exited: true as const, code: null }),
  );
  const deadline = delay(milliseconds, undefined, {
    signal: controller.signal,
  }).then(
    () => ({ exited: false as const }),
    () => ({ exited: false as const }),
  );
  const result = await Promise.race([exit, deadline]);
  controller.abort();
  return result;
}
async function stopClient(client: PiRpcClient): Promise<number | null> {
  client.kill("SIGTERM");
  const term = await waitForExitWithin(client, 5000);
  if (term.exited) return term.code;
  client.kill("SIGKILL");
  const killed = await waitForExitWithin(client, 5000);
  return killed.exited ? killed.code : null;
}
async function writeFixture(
  root: string,
  main: string,
  worker: string,
): Promise<void> {
  const script = join(root, "evidence.py");
  await writeFile(
    join(root, "evidence.txt"),
    "NONCE-" + Math.random().toString(36).slice(2, 12),
  );
  await writeFile(
    script,
    `import json\nfrom pathlib import Path\nfrom pi_mechanistic import arguments,invocation,send_email,success\na=arguments(); n=Path('evidence.txt').read_text().strip(); j=invocation()['jobId']; ack=send_email(a['notify_to'],'MECHANISTIC_EVIDENCE',"Call send_email(to='${main}', subject='MECHANISTIC_CHAIN_COMPLETE', message=<exact JSON {nonce,jobId}>, requires_response=false): "+json.dumps({'nonce':n,'jobId':j},separators=(',',':'))); assert ack['accepted']; success('evidence processed: '+n)\n`,
  );
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "subagents.json"),
    JSON.stringify({
      mechanisticPrograms: {
        evidence: {
          python: "/usr/bin/python3",
          script,
          cwd: root,
          allowedCallers: ["main"],
        },
      },
    }),
  );
}
function summarizeRpc(
  events: ReadonlyArray<{
    type?: string;
    command?: string;
    toolName?: unknown;
    isError?: unknown;
  }>,
): RpcSummary {
  return {
    getStateResponses: events.filter(
      (e) => e.type === "response" && e.command === "get_state",
    ).length,
    promptResponses: events.filter(
      (e) => e.type === "response" && e.command === "prompt",
    ).length,
    settled: events.filter((e) => e.type === "agent_settled").length,
    toolEnds: events
      .filter((e) => e.type === "tool_execution_end")
      .map((e) => ({
        toolName: typeof e.toolName === "string" ? e.toolName : "other",
        isError: e.isError === true,
      })),
    extensionErrors: events.filter((e) => e.type === "extension_error").length,
  };
}
async function main(): Promise<number> {
  const model = parseLiveModel(process.env.LIVE_MODEL);
  const timeout = parseFiniteEnv(process.env.LIVE_TIMEOUT_MS, 240000);
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ??
    join(process.env.HOME ?? tmpdir(), ".pi", "agent");
  const root = await mkdtemp(join(tmpdir(), "pi-mechanistic-live-"));
  await chmod(root, 0o700);
  const mainAddress = `main@${model.modelId}.com`;
  const worker = `evidence-worker.nonce@${model.modelId}.com`;
  const mechanistic = "evidence.nonce@mechanistic.com";
  let client: PiRpcClient | undefined;
  let sessionId: string | undefined;
  let journal: string | undefined;
  let events: MailEvent[] = [];
  let finalObserved = false;
  let timedOut = false;
  let shutdown = "failure";
  let category: string | undefined;
  let pollPromise: Promise<void> | undefined;
  let pollController: AbortController | undefined;
  let timeoutController: AbortController | undefined;
  try {
    await writeFixture(root, mainAddress, worker);
    client = PiRpcClient.launch({
      cwd: root,
      agentDir,
      model: `${model.provider}/${model.modelId}`,
      extensions: [resolve("./src/index.ts")],
      approveProject: true,
    });
    const state = await client.getState();
    if (state.success !== true) throw new Error("startup");
    sessionId = safeSessionId(
      (state.data as { sessionId?: unknown }).sessionId,
    );
    if (!sessionId) throw new Error("startup");
    journal = childJournalPath(agentDir, sessionId);
    const activeJournal = journal;
    const prompt = `You MUST make one send_email tool call before any final answer. Call ${mechanistic} exactly once as a notification with requires_response:false and JSON {"notify_to":"${worker}"}; do not merely describe or wait. The worker must send exact subject MECHANISTIC_CHAIN_COMPLETE to ${mainAddress} with exact structured nonce/job JSON.`;
    await client.prompt(prompt);
    pollController = new AbortController();
    timeoutController = new AbortController();
    const activePollController = pollController;
    const activeTimeoutController = timeoutController;
    const poll = async () => {
      while (!activePollController.signal.aborted) {
        try {
          events = parseLfJournal(await readFile(activeJournal, "utf8"));
          if (
            hasDurableFinal(collectEnvelopes(events), worker, mainAddress) &&
            client?.events().some((e) => e.type === "agent_settled")
          ) {
            finalObserved = true;
            return;
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            !/truncated/.test(String(error))
          ) {
            category = "journal polling failed";
            return;
          }
        }
        await delay(250, undefined, {
          signal: activePollController.signal,
        }).catch(() => undefined);
      }
    };
    pollPromise = poll();
    const timer = delay(timeout, undefined, {
      signal: activeTimeoutController.signal,
    }).then(() => {
      timedOut = true;
      category = "timeout";
    });
    await Promise.race([pollPromise, timer]);
    if (finalObserved) {
      timeoutController.abort();
      pollController.abort();
      shutdown = "completed";
      await client.close();
    } else {
      pollController.abort();
      timeoutController.abort();
      shutdown = category ?? "failure";
      await stopClient(client);
    }
  } catch {
    category = "lifecycle failure";
    if (client) await stopClient(client);
  } finally {
    pollController?.abort();
    timeoutController?.abort();
    if (pollPromise) await pollPromise.catch(() => undefined);
    if (client) {
      await client.waitForExit().catch(() => null);
    }
  }
  if (journal) {
    try {
      events = parseLfJournal(await readFile(journal, "utf8"));
    } catch {
      category = category ?? "final journal unavailable or malformed";
    }
  }
  const childExitCode = client
    ? await client.waitForExit().catch(() => null)
    : null;
  const validation = validateLiveGraph({
    events,
    worker,
    main: mainAddress,
    mechanistic,
    childExitCode,
    timedOut,
    durableFinalObserved: finalObserved,
    mainSettled:
      client?.events().some((e) => e.type === "agent_settled") === true,
    pollError: category,
  });
  const runnerExitCode = validation.ok ? 0 : 1;
  const output = resolve(
    process.env.LIVE_EVIDENCE_DIR ?? ".test-workspaces/mechanistic-subagents",
  );
  await mkdir(output, { recursive: true });
  const terminalJobs = events
    .filter((event) => event.type === "job.terminal")
    .map((event) => {
      const job = (
        event as {
          job: {
            id: string;
            result?: string;
            reported?: { status?: string };
            outcomeMailId?: string;
            exitCode?: number | null;
            signal?: string | null;
            cleanup?: unknown;
          };
        }
      ).job;
      return {
        id: job.id,
        result: job.result,
        reported: job.reported?.status,
        outcomeMailId: job.outcomeMailId,
        exitCode: job.exitCode,
        signal: job.signal,
        cleanup: job.cleanup,
      };
    });
  const log = join(output, `live-mechanistic-${Date.now()}.json`);
  await writeFile(
    log,
    JSON.stringify(
      {
        model: `${model.provider}/${model.modelId}`,
        runnerExitCode,
        childExitCode,
        timedOut,
        shutdown,
        mainSettled:
          client?.events().some((e) => e.type === "agent_settled") === true,
        finalObserved,
        sessionId,
        rpcSummary: client ? summarizeRpc(client.events()) : undefined,
        jobs: terminalJobs,
        envelopes: collectEnvelopes(events).map((e) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          subject: e.subject,
          kind: e.kind,
          requiresResponse: e.requiresResponse,
          inReplyTo: e.inReplyTo,
          completion: e.completion,
          deliveryState: e.deliveryState,
        })),
        validation,
      },
      null,
      2,
    ),
  );
  const namespace = journal ? dirname(journal) : undefined;
  if (runnerExitCode === 0) {
    if (namespace) await rm(namespace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  } else {
    await chmod(root, 0o700);
    if (namespace) await chmod(namespace, 0o700);
    console.error(
      `preserved project: ${root}${namespace ? `; namespace: ${namespace}` : ""}`,
    );
  }
  console.log(
    JSON.stringify({
      passed: runnerExitCode === 0,
      runnerExitCode,
      childExitCode,
      log,
    }),
  );
  return runnerExitCode;
}
try {
  process.exitCode = await main();
} catch {
  process.exitCode = 1;
}
