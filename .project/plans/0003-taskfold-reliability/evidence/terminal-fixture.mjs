import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TaskStore, runTasksTracked, taskFingerprint } from "../../../../extension/tasks.ts";
import { tasksDetails } from "../../../../extension/tui/toolRows.ts";
import { verdictsOf } from "../../../../conductors/in-process/taskfold/verdicts.ts";

const root = resolve(process.argv[2]);
const repetitions = Number(process.argv[3] ?? 5000);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
mkdirSync(root, { recursive: true });
assert.ok(readdirSync(root).every((name) => name === "home"), "Use a new fixture directory; Bun may already have initialized its isolated home cache");
for (const dir of ["agent", "accordion", "accordion/.accordion", "project", "sessions"]) mkdirSync(resolve(root, dir));
const project = resolve(root, "project");
const json = (file, data) => writeFileSync(resolve(root, file), JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(resolve(project, "notes.txt"), "Recovery remains reversible.\nA scoped fact is not a block pin.\n");
json("agent/settings.json", { quietStartup: true, defaultProvider: "eval", defaultModel: "offline-ui", defaultThinkingLevel: "off", enableLsp: false });
json("agent/models.json", { providers: { eval: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "offline-fixture-only",
	models: [{ id: "offline-ui", name: "Offline UI fixture", reasoning: false, input: ["text"], contextWindow: 50_000, maxTokens: 512,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
json("accordion/.accordion/config.json", { autoArm: true, defaultConductor: "taskfold", doorPort: 0,
	privacyConsent: { taskfold: new Date().toISOString() }, modelDefaults: { "*": { budget: "12k", protect: "1k" } },
	taskWidget: { mode: "auto", expanded: true, maxRows: 12, toggleKey: "alt+t" }, taskfold: { keepRecentTasks: 0 } });
const session = SessionManager.create(project, resolve(root, "sessions"));
session.appendSessionInfo("Synthetic Taskfold UI evaluation");
session.appendModelChange("eval", "offline-ui");
session.appendThinkingLevelChange("off");
const store = new TaskStore(project, () => session.getSessionId());
let sequence = 0, timestamp = Date.now() - 3_600_000;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, stopReason = "stop") => session.appendMessage({ role: "assistant", content, api: "openai-completions", provider: "eval", model: "offline-ui", usage, stopReason, timestamp: timestamp += 1000, responseId: `fixture-${++sequence}` });
const tool = (name, args, text, details, isError = false) => {
	const callId = `fixture-call-${++sequence}`;
	assistant([{ type: "toolCall", id: callId, name, arguments: args }], "toolUse");
	session.appendMessage({ role: "toolResult", toolName: name, toolCallId: callId, content: [{ type: "text", text }], details, isError, timestamp: timestamp += 1000 });
};
const tasks = (args) => {
	const input = { list: "terminal-eval", ...args };
	const run = runTasksTracked(store, input);
	const list = store.read("terminal-eval");
	const facts = (nodes) => nodes.map(({ id, title, status, report, acceptanceCriteria, pins }) => ({ id, title, status, report, acceptanceCriteria, pins }));
	tool("tasks", input, run.text, { ...tasksDetails(input, list), started: run.started, closed: facts(run.closed), cascaded: facts(run.cascaded) });
};
const deep = (remaining) => ({ title: remaining ? "Nested verification branch" : "Inspect six-level task", acceptanceCriteria: ["Full criteria and scoped context remain readable."], ...(remaining ? { subtasks: [deep(remaining - 1)] } : {}) });
const initialUserTime = timestamp += 1000;
session.appendMessage({ role: "user", content: "Synthetic terminal evaluation. Recovery remains reversible.", timestamp: initialUserTime });
session.appendCustomEntry("accordion.taskfold.verdict", { id: `u:${initialUserTime}`, loss: 3, source: "opening" });
assert.equal(verdictsOf(session.getBranch()).get(`u:${initialUserTime}`)?.loss, 3);
tasks({ action: "create", title: "Taskfold reliability terminal evaluation", goal: "Inspect all task context and recover a composed child without losing metadata.", tasks: [
	{ title: "Completed recovery group", subtasks: [{ title: "Prepare durable carrier", acceptanceCriteria: ["Sentinel content can be recalled."] }, { title: "Verify linked recovery", acceptanceCriteria: ["Child handles remain named."] }] },
	{ title: "Inspect native task surfaces", subtasks: [deep(4)] },
	{ title: "Waiting for reviewer" }, { title: "Intentional failed fixture" }, { title: "Superseded fixture" }, { title: "Later work" },
] });
tasks({ action: "pin", items: [{ kind: "rule", text: "Recovery remains reversible.", source: "notes.txt:1" }] });
tasks({ action: "attach", items: [{ path: "notes.txt", lines: "1-2", note: "Two-line attachment for native inspection" }] });
for (const id of ["1.1", "1.2"]) {
	tasks({ action: "start", id });
	if (id === "1.1") tasks({ action: "pin", id, items: [{ kind: "fact", text: "A scoped fact is not a block pin.", source: "notes.txt:2" }] });
	const text = `RECOVERABLE_SENTINEL_${id.replaceAll(".", "_")}\n` + "Synthetic recoverable tool output.\n".repeat(repetitions);
	const file = `carrier-${id}.txt`;
	writeFileSync(resolve(project, file), text);
	tool("read", { path: file }, text);
	tasks({ action: "complete", id, report: { outcome: id === "1.1" ? "Durable carrier contains a recoverable sentinel." : "Linked child recovery remains reversible.", decisions: ["Retain named handles — recovery needs an explicit association."] } });
}
tasks({ action: "complete", id: "1", report: { outcome: "Both child carriers are complete and recoverable." } });
tasks({ action: "start", id: "3" });
tool("read", { path: "notes.txt" }, readFileSync(resolve(project, "notes.txt"), "utf8"));
tasks({ action: "block", id: "3", reason: "user-decision", detail: "Reviewer must choose the desired density." });
tasks({ action: "start", id: "4" });
tool("bash", { command: "false" }, "Synthetic failed check", undefined, true);
tasks({ action: "fail", id: "4", report: { outcome: "Intentional fixture failure: false exited with 1." } });
tasks({ action: "start", id: "5" });
tool("read", { path: "notes.txt" }, "Synthetic supersession evidence");
tasks({ action: "abandon", id: "5", report: { outcome: "Fixture branch deliberately superseded." } });
tasks({ action: "pin", id: "2", items: [{ kind: "fact", text: "A scoped fact is not a block pin.", source: "notes.txt:2" }] });
tasks({ action: "attach", id: "2.1.1.1.1.1", items: [{ path: "notes.txt", lines: "2", note: "Deep scoped attachment" }] });
tasks({ action: "start", id: "2.1.1.1.1.1" });
const active = "Open task work stays protected.\n".repeat(240);
writeFileSync(resolve(project, "active.txt"), active);
tool("read", { path: "active.txt" }, active);
assistant([{ type: "text", text: "Synthetic fixture ready. No provider requests have been made." }]);
session.appendCustomEntry("accordion.tasks.binding", { slug: "terminal-eval", fingerprint: taskFingerprint(store.read("terminal-eval")) });
json("project/.pig/tasks/broken.json", { version: 999, slug: "broken", title: "Intentionally invalid fixture", goal: "Reject unsupported versions visibly.", tasks: [] });
const list = store.read("terminal-eval");
assert.equal(Math.max(...list.tasks.map((t) => t.id.split(".").length)), 6);
json("fixture.json", { project, session: session.getSessionFile(), sessionId: session.getSessionId(), tasks: list.tasks.length, depth: 6,
	credentials: "none; the only configured provider is an unreachable loopback dummy", externalRequests: 0 });
console.log(JSON.stringify({ session: session.getSessionFile(), project, tasks: list.tasks.length, depth: 6 }));
