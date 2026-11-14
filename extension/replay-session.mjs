import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createJiti } from "jiti";

const usage = "Usage: node extension/replay-session.mjs <session.jsonl> [--conductor <id>|none] [--budget <tokens>] [--tail <tokens>] [--limit-requests <n>] [--sample-every <n>] [--out <file.json>]\n       node extension/replay-session.mjs --self-test";
function options(args) {
	if (args.length === 1 && args[0] === "--self-test") return { selfTest: true };
	const opts = { conductor: "taskfold", budget: 272000, tail: 20000, sampleEvery: 50 };
	const names = { "--conductor": "conductor", "--budget": "budget", "--tail": "tail", "--limit-requests": "limitRequests", "--sample-every": "sampleEvery", "--out": "out" };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const key = names[arg], value = args[++i];
			if (!key || !value || value.startsWith("--")) throw new Error(usage);
			if (["budget", "tail", "limitRequests", "sampleEvery"].includes(key)) {
				if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (key !== "tail" && Number(value) === 0)) throw new Error(usage);
				opts[key] = Number(value);
			} else opts[key] = value;
		} else if (!opts.file) opts.file = arg;
		else throw new Error(usage);
	}
	if (!opts.file) throw new Error(usage);
	return opts;
}

async function loadSession(file) {
	const entries = new Map();
	let leaf, skippedLines = 0;
	const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of lines) {
		let entry;
		try { entry = JSON.parse(line); } catch { skippedLines++; continue; }
		if (entry?.id) {
			entries.set(entry.id, entry);
			if (entry.type !== "session") leaf = entry;
		}
	}
	const branch = [];
	const visited = new Set();
	for (let entry = leaf; entry; entry = entry.parentId ? entries.get(entry.parentId) : undefined) {
		if (visited.has(entry.id)) throw new Error("Session branch contains a cycle");
		visited.add(entry.id);
		if (entry.type === "message" && entry.message) branch.push(entry.message);
	}
	branch.reverse();
	let model;
	for (const message of branch) if (message.role === "assistant") {
		if (!model && message.provider && message.model && message.api) model = { provider: message.provider, id: message.model, api: message.api };
		delete message.usage;
	}
	return { messages: branch, skippedLines, model: model ?? { provider: "anthropic", id: "replay/model", api: "anthropic-messages" } };
}

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function distribution(values) {
	const sorted = [...values].sort((a, b) => a - b), sum = values.reduce((a, b) => a + b, 0);
	const at = p => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : 0;
	return { sum, mean: values.length ? sum / values.length : 0, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

async function replay(opts, home) {
	const started = performance.now();
	const file = path.resolve(opts.file);
	const { messages, skippedLines, model } = await loadSession(file);
	fs.mkdirSync(path.join(home, ".accordion"), { recursive: true });
	fs.writeFileSync(path.join(home, ".accordion", "config.json"), JSON.stringify({ autoArm: true, defaultConductor: opts.conductor, doorPort: 0, debug: false }));
	const { default: accordion } = await createJiti(import.meta.url).import("./accordion.ts");
	const handlers = {}, entries = [], fed = [];
	let host, command, activeTools = [];
	const pi = {
		on: (name, fn) => { handlers[name] = fn; },
		getActiveTools: () => activeTools.slice(), setActiveTools: next => { activeTools = next.slice(); },
		registerFlag() {}, getFlag() {}, registerTool() {}, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendMessage: async () => {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName: () => undefined,
		registerCommand: (name, def) => { if (name === "accordion") command = def.handler; },
	};
	accordion(pi, { openPanel: (_ctx, h) => { host = h; } });
	const ctx = {
		mode: "tui", hasUI: true, cwd: home, isIdle: () => false,
		model: { ...model, name: model.id, baseUrl: "http://localhost.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: opts.budget, maxTokens: 32000 },
		ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async (_title, choices) => choices.at(-1), theme: { fg: (_c, s) => s } },
		sessionManager: { getSessionId: () => "replay-session", getBranch: () => [...fed.map(message => ({ type: "message", message })), ...entries], buildSessionContext: () => ({ messages: fed }) },
		getContextUsage: () => ({ tokens: 0, contextWindow: opts.budget }), getSystemPrompt: () => "System instructions",
	};
	try {
		await handlers.session_start({ reason: "startup" }, ctx);
		await command("", ctx);
		if (!host) throw new Error("Accordion panel host did not open");
		if (opts.conductor !== "none") {
			const deadline = Date.now() + 5000;
			while (host.activeConductor()?.id !== opts.conductor && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
			if (host.activeConductor()?.id !== opts.conductor) throw new Error(`Conductor ${opts.conductor} did not attach within 5 seconds`);
		} else if (host.activeConductor()) throw new Error("A conductor attached despite --conductor none");
		if (opts.tail !== 20000) await host.command({ kind: "setProtect", value: opts.tail });
		const records = [], series = [];
		let prevWire = [], ingestMs = 0, turnIndex = 0, runMessages = [], rssPeak = process.memoryUsage().rss;
		for (const message of messages) {
			if (message.role === "assistant") {
				let t = performance.now();
				await handlers.turn_start?.({ turnIndex: turnIndex++, timestamp: Date.now() }, ctx);
				await settle();
				const commitMs = performance.now() - t;
				const input = structuredClone(fed);
				t = performance.now();
				const result = await handlers.context({ messages: input }, ctx);
				let wire = [{ role: "system", content: "System instructions", timestamp: 0 }, ...(result?.messages ?? fed)];
				wire = (await handlers.context_with_system?.({ messages: wire }, ctx))?.messages ?? wire;
				const hookMs = performance.now() - t;
				const strings = wire.map(msg => JSON.stringify(msg));
				let first = 0;
				while (first < prevWire.length && first < strings.length && prevWire[first] === strings[first]) first++;
				const invalidatedChars = prevWire.slice(first).reduce((sum, s) => sum + s.length, 0);
				prevWire = strings;
				const truth = host.truth(), stats = truth.stats();
				const record = { req: records.length + 1, blocks: truth.blocks.length, fullTokens: stats.fullTokens, liveTokens: stats.liveTokens, hookMs, commitMs, ingestMs, groupsFolded: truth.groups.filter(g => g.folded).length, blocksFolded: truth.blocks.filter(b => truth.isFolded(b)).length, wireChars: strings.reduce((sum, s) => sum + s.length, 0), invalidatedChars };
				records.push(record);
				ingestMs = 0;
				if (record.req % opts.sampleEvery === 0) series.push({ req: record.req, blocks: record.blocks, fullTokens: record.fullTokens, liveTokens: record.liveTokens, hookMs, commitMs, groupsFolded: record.groupsFolded });
				if (record.req % 50 === 0) rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
				if (record.req % 100 === 0) console.error(`request ${record.req}, blocks ${record.blocks}, elapsed ${((performance.now() - started) / 1000).toFixed(1)}s`);
				if (opts.limitRequests && records.length >= opts.limitRequests) break;
			}
			const t = performance.now();
			await handlers.message_end?.({ message }, ctx);
			ingestMs += performance.now() - t;
			fed.push(message);
			runMessages.push(message);
			if (message.role === "user") runMessages = [message];
			if (message.role === "assistant" && !message.content?.some?.(part => part.type === "toolCall")) {
				await handlers.agent_end?.({ messages: runMessages.slice() }, ctx);
				await settle();
			}
		}
		const last = records.at(-1), hooks = distribution(records.map(r => r.hookMs)), commits = distribution(records.map(r => r.commitMs)), ingests = distribution(records.map(r => r.ingestMs));
		const live = distribution(records.map(r => r.liveTokens)), wire = distribution(records.map(r => r.wireChars)), invalid = distribution(records.map(r => r.invalidatedChars));
		const quarters = Array.from({ length: 4 }, (_, i) => distribution(records.slice(Math.floor(records.length * i / 4), Math.floor(records.length * (i + 1) / 4)).map(r => r.hookMs)).mean);
		return { session: createHash("sha256").update(file).digest("hex").slice(0, 8), fileMB: fs.statSync(file).size / 1e6, commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.dirname(new URL(import.meta.url).pathname), encoding: "utf8" }).trim(), conductor: opts.conductor, budget: opts.budget, tail: opts.tail, messages: fed.length, requests: records.length, blocks: last?.blocks ?? 0, fullTokens: last?.fullTokens ?? 0, skippedLines, hookMs: hooks, commitMs: commits, ingestMs: ingests, liveTokens: { mean: live.mean, p95: live.p95, max: live.max, final: last?.liveTokens ?? 0 }, wireChars: { sum: wire.sum, mean: wire.mean, max: wire.max }, invalidatedChars: { sum: invalid.sum, events: records.filter(r => r.invalidatedChars > 0).length, max: invalid.max }, folds: { groupsFolded: last?.groupsFolded ?? 0, blocksFolded: last?.blocksFolded ?? 0 }, overBudgetRequests: records.filter(r => r.liveTokens > opts.budget).length, rssPeakMB: rssPeak / 1e6, wallSec: (performance.now() - started) / 1000, hookMsByQuarter: quarters, series };
	} finally {
		await handlers.session_shutdown?.({}, ctx);
	}
}

function synthetic(file) {
	const entries = [{ type: "session", id: "session" }];
	let id = 0, parentId = null, call = 0, assistants = 0;
	function add(message) { const next = String(++id); entries.push({ type: "message", id: next, parentId, message }); parentId = next; }
	add({ role: "user", timestamp: id + 1, content: "Complete the tasks." });
	function tool(name, args, text) {
		const callId = `call-${++call}`;
		add({ role: "assistant", responseId: `response-${call}`, timestamp: id + 1, content: [{ type: "toolCall", id: callId, name, arguments: args }] });
		assistants++;
		add({ role: "toolResult", toolCallId: callId, toolName: name, timestamp: id + 1, content: [{ type: "text", text }], isError: false });
	}
	for (let i = 1; i <= 3; i++) {
		tool("tasks", { action: "start", list: "work", id: String(i), title: `Task ${i}` }, `Started work/${i} "Task ${i}".`);
		for (let j = 0; j < 6; j++) tool("read", { path: `file-${i}-${j}` }, "x".repeat(8000));
		tool("tasks", { action: "complete", list: "work", id: String(i), report: { outcome: "Completed." } }, `Completed work/${i}.`);
	}
	add({ role: "assistant", responseId: "final", timestamp: id + 1, content: [{ type: "text", text: "Done." }] });
	assistants++;
	fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return assistants;
}

let code = 0, home;
try {
	const opts = options(process.argv.slice(2));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-replay-"));
	process.env.ACCORDION_HOME = home;
	process.env.ACCORDION_DOOR_PORT = "0";
	if (opts.selfTest) {
		const file = path.join(home, "synthetic.jsonl"), expected = synthetic(file);
		const result = await replay({ file, conductor: "taskfold", budget: 20000, tail: 2000, sampleEvery: 50 }, home);
		assert.equal(result.requests, expected);
		assert.ok(result.folds.groupsFolded >= 1);
		assert.ok(result.liveTokens.final < result.fullTokens);
		assert.ok(Number.isFinite(result.hookMs.max));
		console.log("replay-session self-test: OK");
	} else {
		const result = await replay(opts, home);
		const json = JSON.stringify(result, null, 2);
		if (opts.out) fs.writeFileSync(opts.out, json + "\n");
		console.log(json);
		for (const key of ["requests", "blocks", "fullTokens", "hookMs", "commitMs", "liveTokens", "wireChars", "invalidatedChars", "folds", "overBudgetRequests", "hookMsByQuarter", "rssPeakMB", "wallSec"]) console.log(`${key}: ${JSON.stringify(result[key])}`);
	}
} catch (err) {
	console.error(err?.stack ?? err);
	code = err?.message === usage ? 2 : 1;
} finally {
	if (home) fs.rmSync(home, { recursive: true, force: true });
}
process.exit(code);
