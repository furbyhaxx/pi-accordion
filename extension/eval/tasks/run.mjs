import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenario, scenarios } from "./scenarios.mjs";
import { quote, sandboxArgs } from "./sandbox.mjs";
import { auditSession, readJsonLines } from "../../audit-tasks.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const auth = "/home/furbyhaxx/.pi/agent/git/github.com/furbyhaxx/pi-auth-plus/src/index.ts";

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once("error", () => resolveExit({ code: null, signal: null, spawnError: true }));
    child.once("exit", (code, signal) => resolveExit({ code, signal, spawnError: false }));
  });
}

async function runCheck(args, cwd, timeout = 15000, mounts = []) {
  const command = ["/usr/bin/node", ...args].map(quote).join(" ");
  const child = spawn("bwrap", sandboxArgs(resolve(cwd), command, mounts), { cwd, detached: true, stdio: "ignore" });
  const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, timeout);
  const result = await waitForExit(child);
  clearTimeout(timer);
  return result;
}

async function behavior(name, project) {
  const script = `import { verifyScenario } from '/eval/scenarios.mjs'; process.exit(await verifyScenario(process.argv[1], process.cwd()) ? 0 : 1)`;
  const mounts = ["--dir", "/eval", "--ro-bind", fileURLToPath(new URL("./scenarios.mjs", import.meta.url)), "/eval/scenarios.mjs"];
  return (await runCheck(["--input-type=module", "-e", script, name], project, 15000, mounts)).code === 0;
}

export async function evaluate(name, project, base) {
  const behaviorPassed = await behavior(name, project);
  const testsPassed = (await runCheck(["--test"], project)).code === 0;
  let regressionDetected = null;
  if (testsPassed && name !== "refactor" && name !== "history") {
    const copy = join(base, "mutation-check");
    await cp(project, copy, { recursive: true, dereference: false });
    try {
      if ((await lstat(join(copy, "src"))).isDirectory()) {
        const file = { bug: "src/cart.mjs", docs: "src/search.mjs", decision: "src/invoice.mjs" }[name];
        await rm(join(copy, file));
        await writeFile(join(copy, file), scenarios[name].files[file]);
        const mutation = await runCheck(["--test"], copy);
        regressionDetected = mutation.code === 0 ? false : mutation.code === null ? null : true;
      }
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }
  return { behaviorPassed, testsPassed, regressionDetected };
}

function send(child, id, message) {
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
}

async function sessionFile(dir) {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"));
  if (files.length !== 1) throw new Error("Expected one session file");
  return join(dir, files[0]);
}

export function observedDecisionBlock(entries) {
  const calls = new Map();
  const blocked = new Set();
  function apply(args) {
    if (typeof args?.list !== "string" || typeof args?.id !== "string") return;
    const key = `${args.list}/${args.id}`;
    if (args.action === "block") {
      if (args.reason === "user-decision") blocked.add(key); else blocked.delete(key);
    } else if (["start", "complete", "fail", "abandon"].includes(args.action)) blocked.delete(key);
  }
  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === "assistant") for (const item of message.content ?? []) if (item?.type === "toolCall" && item.name === "tasks") calls.set(item.id, item.arguments);
    if (message?.role !== "toolResult") continue;
    if (!message.isError && calls.has(message.toolCallId)) apply(calls.get(message.toolCallId));
    if (message.nestedCalls?.complete === true) for (const call of message.nestedCalls.calls ?? []) if (call.name === "tasks" && call.status === "ok") apply(call.arguments);
  }
  return blocked.size > 0;
}

export async function run({ model, scenario: name, output, prompt = scenarios[name]?.prompt, timeoutMs = 360000, maxRequests = 30, enforce = "coach" }) {
  if (!model || !scenarios[name]) throw new Error("A model and known scenario are required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("Invalid bounds");
  const base = resolve(output);
  await mkdir(base, { mode: 0o700 });
  const project = join(base, "project");
  const home = join(base, "home");
  const sessions = join(base, "sessions");
  await createScenario(name, project);
  const skillRoot = join(project, ".eval-extension/skills/accordion-task-lists");
  await cp(join(root, "extension/skills/accordion-task-lists"), skillRoot, { recursive: true });
  for (const file of ["taskSchema.ts", "taskPins.ts", "taskAnchors.ts", "taskSymbols.ts"]) await cp(join(root, "extension", file), join(project, ".eval-extension", file));
  await mkdir(join(home, ".accordion"), { recursive: true, mode: 0o700 });
  await mkdir(sessions, { mode: 0o700 });
  if (enforce !== "coach" && enforce !== "gate" && enforce !== "off") throw new Error("enforce must be coach, gate or off");
  await writeFile(join(home, ".accordion/config.json"), JSON.stringify({ autoArm: true, defaultConductor: "taskfold", debug: true, doorPort: 0, tasks: { enforce }, privacyConsent: { "taskfold-chat-v1": new Date().toISOString() } }), { mode: 0o600 });
  // ACCORDION_EVAL_PROVIDER selects the provider separately for colon-bearing model IDs.
  const providerArgs = process.env.ACCORDION_EVAL_PROVIDER ? ["--provider", process.env.ACCORDION_EVAL_PROVIDER] : [];
  const args = ["--offline", "--no-extensions", "-e", auth, "-e", join(root, "extension/accordion.ts"), "-e", fileURLToPath(new URL("./sandbox.mjs", import.meta.url)), "--tools", "read,bash,edit,write,tasks,unfold,recall", "--no-skills", "--skill", skillRoot, ...["accordion-context-folding", "accordion-context-recall"].flatMap((skill) => ["--skill", join(root, "extension/skills", skill)]), "--no-prompt-templates", "--no-context-files", "--no-mcp", "--approve", "--session-dir", sessions, ...providerArgs, "--model", model, "--thinking", "low", "--mode", "rpc"];
  const env = { ...process.env, ACCORDION_HOME: home };
  for (const key of ["ACCORDION_TOKEN", "ACCORDION_HOST", "ACCORDION_PORT", "ACCORDION_DOOR_PORT", "ACCORDION_AUTO_ARM", "ACCORDION_DEFAULT_CONDUCTOR", "ACCORDION_DEBUG"]) delete env[key];
  const child = spawn("pi-bolt", args, { cwd: project, env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  let killTimer;
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    if (!killTimer) killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000);
  };
  const exit = waitForExit(child);
  let timedOut = false;
  let capped = false;
  let requests = 0;
  let phases = 0;
  let decisionImplementedEarly = null;
  let decisionBlocked = false;
  let decisionAnswered = false;
  let historyAnswer = null;
  let historyReadsAfterAsk = null;
  let processing = Promise.resolve();
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "message_start" && event.message?.role === "assistant" && ++requests > maxRequests) {
      capped = true;
      stop();
    }
    if (event.type !== "agent_end") return;
    processing = processing.then(async () => {
      phases++;
      if (name === "history" && phases === 1) {
        send(child, "followup", scenarios[name].followup);
        return;
      }
      if (name === "decision" && phases === 1) {
        try { decisionBlocked = observedDecisionBlock(await readJsonLines(await sessionFile(sessions))); } catch { decisionBlocked = false; }
        decisionImplementedEarly = await behavior(name, project);
        decisionAnswered = true;
        send(child, "answer", scenarios[name].answer);
        return;
      }
      child.stdin.end();
    });
  });
  send(child, "initial", `${prompt}\n\nShell commands run in an isolated workspace at /work; use relative paths.`);
  const result = await exit;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  lines.close();
  await processing;
  let metrics = null;
  try {
    const entries = await readJsonLines(await sessionFile(sessions));
    metrics = auditSession(entries);
    if (name === "history") {
      const last = entries.findLast((entry) => entry?.message?.role === "assistant");
      const content = last?.message?.content;
      historyAnswer = typeof content === "string" ? content : (content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
      historyReadsAfterAsk = entries.slice(entries.findLastIndex((entry) => entry?.message?.role === "user")).filter((entry) => entry?.message?.role === "toolResult").map((entry) => entry.message.toolName);
    }
  } catch { /* A failed startup may not create a session. */ }
  const evaluation = await evaluate(name, project, base);
  const summary = { scenario: name, model, timeoutMs, maxRequests, requests, phases, decisionBlocked, decisionAnswered, decisionImplementedEarly, historyAnswer, historyReadsAfterAsk, timedOut, capped, process: result, ...evaluation, metrics };
  await writeFile(join(base, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [model, scenario, output, enforce] = process.argv.slice(2);
  run({ model, scenario, output, enforce }).then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
