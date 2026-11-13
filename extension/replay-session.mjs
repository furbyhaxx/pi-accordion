// Replay a saved Pi session as a resume under Taskfold and report whether its context fits the budget.
// Usage: node replay-session.mjs <session.jsonl> [--budget 272000] [--upto <line>]
// Reads the file only; no model is called (extraction and classification are unavailable, as offline).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--") && fs.existsSync(a));
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
if (!file) { console.error("usage: node replay-session.mjs <session.jsonl> [--budget N] [--upto LINE]"); process.exit(2); }
const budget = flag("--budget", 272_000);
const upto = flag("--upto", Infinity);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-replay-"));
process.env.ACCORDION_HOME = home;
process.env.ACCORDION_AUTO_ARM = "1";
process.env.ACCORDION_DOOR_PORT = "0";
fs.mkdirSync(path.join(home, ".accordion"), { recursive: true });
fs.writeFileSync(path.join(home, ".accordion", "config.json"), JSON.stringify({ autoArm: true, defaultConductor: "taskfold", privacyConsent: { taskfold: "2026-01-01T00:00:00Z" } }));

// The branch that ends at the last entry read, oldest first.
const byId = new Map();
let leaf = null;
fs.readFileSync(file, "utf8").split("\n").slice(0, upto).forEach(line => {
	let e;
	try { e = JSON.parse(line); } catch { return; }
	if (e?.id) { byId.set(e.id, e); leaf = e; }
});
const branch = [];
for (let e = leaf; e; e = e.parentId ? byId.get(e.parentId) : null) branch.unshift(e);
const messages = branch.filter(e => e.type === "message" && e.message).map(e => e.message);

const jiti = createJiti(import.meta.url);
const { default: accordion } = await jiti.import("./accordion.ts");
const handlers = {}, tools = {}, notices = [];
let host, command;
const pi = {
	on: (name, fn) => { handlers[name] = fn; }, registerFlag() {}, getFlag() {}, registerTool(tool) { tools[tool.name] = tool; },
	appendEntry() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName: () => undefined, getThinkingLevel: () => "off",
	registerCommand: (name, def) => { if (name === "accordion") command = def.handler; },
};
accordion(pi, { openPanel: (_ctx, h) => { host = h; }, complete: async () => { throw new Error("no model in a replay"); } });
const ctx = {
	mode: "tui", hasUI: true, cwd: home, isIdle: () => true,
	model: { id: "replay/model", name: "Replay", provider: "replay", api: "openai-completions", baseUrl: "http://localhost.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 64_000 },
	ui: { notify: text => notices.push(String(text)), setStatus() {}, confirm: async () => false, select: async () => undefined, theme: { fg: (_c, s) => s } },
	sessionManager: { getSessionId: () => "replay", getBranch: () => branch },
	getContextUsage: () => ({ tokens: 0, contextWindow: 1_048_576 }),
	getSystemPrompt: () => "",
};
let code = 0;
try {
	handlers.session_start({ reason: "resume" }, ctx);
	await command("", ctx);
	host.command({ kind: "setBudget", value: budget });
	const full = host.truth().stats().fullTokens;
	// Several requests: folds are proposed off the request path and land on the next one.
	let live = 0, status = null;
	for (let i = 0; i < 6; i++) {
		await handlers.context({ messages }, ctx);
		await new Promise(resolve => setTimeout(resolve, 150));
		live = host.truth().stats().liveTokens;
		status = host.conductorStatus();
	}
	const saturated = /saturated/i.test(status?.text ?? "") || notices.some(n => /saturated/i.test(n));
	console.log(JSON.stringify({ messages: messages.length, fullTokens: full, liveTokens: live, budget, fits: live < budget, saturated, status: status?.text ?? null }, null, 1));
	assert.ok(live < budget && !saturated);
} catch (err) {
	if (!(err instanceof assert.AssertionError)) console.error(err);
	code = 1;
} finally {
	try { handlers.session_shutdown?.({}, ctx); } catch {}
	fs.rmSync(home, { recursive: true, force: true });
}
process.exit(code);
