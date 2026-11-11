import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-context-"));
process.env.ACCORDION_HOME = home;
process.env.ACCORDION_AUTO_ARM = "1";
process.env.ACCORDION_DOOR_PORT = "0";
const jiti = createJiti(import.meta.url);
const { default: accordion } = await jiti.import("./accordion.ts");
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function runtime(messages = [], options = {}) {
	const handlers = {};
	const tools = {};
	const entries = options.entries ?? [];
	let host;
	let command;
	const pi = {
		on: (name, fn) => { handlers[name] = fn; },
		registerFlag() {}, getFlag() {}, registerTool(tool) { tools[tool.name] = tool; },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		registerShortcut: () => {}, registerMessageRenderer: () => {}, getSessionName: () => undefined,
		registerCommand: (name, def) => { if (name === "accordion") command = def.handler; },
	};
	accordion(pi, { openPanel: (_ctx, h) => { host = h; return options.openPanel?.(_ctx, h); } });
	const model = {
		id: "test/model", name: "Test", provider: "openrouter", api: "openai-completions",
		baseUrl: "http://localhost.invalid/v1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576, maxTokens: 943_718,
	};
	const ctx = {
		mode: "tui", hasUI: true, cwd: options.cwd ?? home, model,
		ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async (_title, options) => options.at(-1), theme: { fg: (_c, s) => s } },
		sessionManager: {
			getSessionId: () => options.sessionId ?? "context-test-session",
			getBranch: () => [...messages.map(message => ({ type: "message", message })), ...entries],
			...(options.branchOnly ? {} : { buildSessionContext: () => ({ messages }) }),
		},
		getContextUsage: () => ({ tokens: 132_483, contextWindow: ctx.model.contextWindow }),
		getSystemPrompt: () => "System instructions",
	};
	handlers.session_start({ reason: "resume" }, ctx);
	return {
		handlers, ctx, tools, entries,
		open: async () => { await command("", ctx); return host; },
		command: args => command(args, ctx),
		request: async input => {
			const folded = await handlers.context({ messages: input }, ctx);
			const wire = [{ role: "system", content: "System instructions", timestamp: 0 }, ...(folded?.messages ?? input)];
			return (await handlers.context_with_system?.({ messages: wire }, ctx))?.messages ?? wire;
		},
		close: () => handlers.session_shutdown({}, ctx),
	};
}
check("chat extraction requires new consent even after classifier-only consent", async () => {
	const config = path.join(home, ".accordion", "config.json");
	fs.mkdirSync(path.dirname(config), { recursive: true });
	const previous = fs.existsSync(config) ? fs.readFileSync(config) : null;
	fs.writeFileSync(config, JSON.stringify({ autoArm: false, privacyConsent: { taskfold: "2026-01-01T00:00:00Z" } }));
	const r = runtime();
	try {
		let prompt = "";
		r.ctx.ui.confirm = async (_title, text) => { prompt = text; return false; };
		const host = await r.open();
		host.command({ kind: "selectConductor", id: "taskfold" });
		await new Promise(resolve => setImmediate(resolve));
		assert.match(prompt, /chat model/);
		assert.match(prompt, /openai\/gpt-6-luna/);
		assert.match(prompt, /openai-codex\/gpt-6-luna/);
		assert.equal(host.settings().privacyConsent["taskfold-chat-v1"], undefined);
	} finally {
		r.close();
		if (previous === null) fs.rmSync(config, { force: true }); else fs.writeFileSync(config, previous);
	}
});
check("task sizing guidance reaches the default system prompt only while tasks is selected", async () => {
	const r = runtime();
	try {
		const tool = r.tools.tasks;
		const options = { cwd: home, toolGuidelines: { tasks: tool.promptGuidelines }, toolSnippets: { tasks: tool.promptSnippet } };
		const active = buildSystemPrompt({ ...options, selectedTools: ["tasks"] });
		const inactive = buildSystemPrompt({ ...options, selectedTools: [] });
		assert.match(active, /split broad features into child tasks/);
		assert.match(active, /completed work can fold while its parent stays open/);
		assert.match(active, /avoid splitting trivial steps/);
		assert.doesNotMatch(inactive, /split broad features into child tasks/);
	} finally { r.close(); }
});
check("the context panel suspends its task widget and restores it after every exit", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-panel-widget-"));
	const theme = { fg: (_c, s) => s, bold: s => s, strikethrough: s => s };
	let widget, inspect = false, failure = "";
	const notices = [], during = [];
	const r = runtime([], { cwd: dir, openPanel: () => {
		if (!inspect) return;
		during.push(widget === undefined);
		if (failure === "sync") throw new Error("intentional synchronous open failure");
		if (failure === "async") return Promise.reject(new Error("intentional rejected open"));
	} });
	r.ctx.ui.setWidget = (_key, factory) => { widget = factory?.({ requestRender() {} }, theme); };
	r.ctx.ui.notify = text => notices.push(text);
	try {
		const host = await r.open();
		host.command({ kind: "selectConductor", id: "taskfold" });
		await new Promise(resolve => setImmediate(resolve));
		await r.tools.tasks.execute("create", { action: "create", list: "panel", title: "Panel work", goals: ["Keep controls visible"], tasks: [{ title: "Inspect" }] }, undefined, undefined, r.ctx);
		assert.match(widget.render(80).join("\n"), /Panel work/);
		const settings = JSON.stringify(host.settings().taskWidget);
		inspect = true;
		for (failure of ["", "sync", "async"]) {
			await r.open();
			assert.match(widget.render(80).join("\n"), /Panel work/);
			assert.equal(JSON.stringify(host.settings().taskWidget), settings);
		}
		assert.deepEqual(during, [true, true, true], "the widget must not consume the panel viewport");
		assert.equal(notices.filter(text => /intentional/.test(text)).length, 2);
	} finally { r.close(); }
});
check("nested tasks calls put their span events on the outer tool result", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-task-events-"));
	const r = runtime([{ role: "user", content: "Work", timestamp: 1 }], { cwd: dir, sessionId: "events" });
	const run = (id, args) => r.tools.tasks.execute(id, args, undefined, undefined, r.ctx);
	try {
		await run("c1", { action: "create", list: "w", title: "W", goals: ["Done"], tasks: [{ title: "A" }, { title: "B" }] });
		const direct = await run("c2", { action: "start", list: "w", id: "1" });
		assert.deepEqual(direct.details.taskEvents.map(e => [e.action, e.id, e.task.title]), [["start", "1", "A"]]);
		await r.handlers.tool_result({ toolName: "bash", toolCallId: "c3", input: {}, content: [], details: undefined, isError: false }, r.ctx);
		const nestedA = await run("c4/1", { action: "complete", list: "w", id: "1", report: { outcome: "A done." } });
		const nestedB = await run("c4/2", { action: "start", list: "w", id: "2" });
		assert.equal(nestedA.details.taskEvents, undefined);
		assert.equal(nestedB.details.taskEvents, undefined);
		const inner = await r.handlers.tool_result({ toolName: "tasks", toolCallId: "c4/2", parentToolCallId: "c4", input: {}, content: [], details: nestedB.details, isError: false }, r.ctx);
		assert.equal(inner?.details, undefined, "a nested result is not the carrier");
		const outer = await r.handlers.tool_result({ toolName: "codemode", toolCallId: "c4", input: {}, content: [{ type: "text", text: "ok" }], details: { calls: 2 }, isError: false }, r.ctx);
		assert.equal(outer.details.calls, 2);
		assert.deepEqual(outer.details.taskEvents.map(e => [e.action, e.id]), [["complete", "1"], ["start", "2"]]);
		assert.equal(outer.details.taskEvents[0].task.report.outcome, "A done.");
		const again = await r.handlers.tool_result({ toolName: "codemode", toolCallId: "c4", input: {}, content: [], details: {}, isError: false }, r.ctx);
		assert.equal(again?.details, undefined, "events are delivered once");
	} finally { r.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
check("start delivers anchored attachments with their states and upgrades legacy line ranges", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-anchors-"));
	const r = runtime([{ role: "user", content: "Work", timestamp: 1 }], { cwd: dir, sessionId: "anchors" });
	const run = async (id, args) => JSON.parse((await r.tools.tasks.execute(id, args, undefined, undefined, r.ctx)).content[0].text);
	try {
		fs.writeFileSync(path.join(dir, "auth.md"), "# Auth\n\n## Interface\n\nget and set\n\n## Notes\n\nfirst\nsecond\n");
		fs.writeFileSync(path.join(dir, "store.ts"), "export class TokenStore {\n\tget() { return 1; }\n}\n");
		await run("c1", { action: "create", list: "w", title: "W", goals: ["Done"], tasks: [{ title: "A" }, { title: "B" }] });
		const attached = await run("c2", { action: "attach", list: "w", id: "1", items: [{ path: "auth.md", section: "Auth > Interface" }, { path: "store.ts", symbol: "TokenStore.get" }, { path: "auth.md", quote: "second" }] });
		assert.deepEqual(attached.attachments.map(a => a.ref), ["auth.md#Auth > Interface", "store.ts::TokenStore.get", "auth.md@q:a3"]);
		// The file changes before the task starts: lines are added above, the quote moves, a section is rewritten elsewhere.
		fs.writeFileSync(path.join(dir, "auth.md"), "intro\n\n# Auth\n\n## Interface\n\nget and set\n\n## Notes\n\nrewritten\nsecond\n");
		fs.writeFileSync(path.join(dir, "store.ts"), "// header\nexport class TokenStore {\n\tget() { return 1; }\n}\n");
		const started = await run("c3", { action: "start", list: "w", id: "1" });
		const byRef = Object.fromEntries(started.started[0].attachments.map(a => [a.ref, a]));
		assert.equal(byRef["auth.md#Auth > Interface"].content, "## Interface\n\nget and set");
		assert.equal(byRef["auth.md#Auth > Interface"].state, undefined, "a section that still exists is not reported");
		assert.equal(byRef["store.ts::TokenStore.get"].content, "get() { return 1; }");
		assert.equal(byRef["auth.md@q:a3"].content, "second");
		assert.equal(byRef["auth.md@q:a3"].state, "moved");
		const stored = JSON.parse(fs.readFileSync(path.join(dir, ".pig", "tasks", "w.json"), "utf8"));
		assert.equal(stored.tasks[0].attachments.find(a => a.id === "a3").anchor.quote.exact, "second");
		// A legacy line range in a hand-written list is delivered by its lines and replaced by a quote.
		fs.writeFileSync(path.join(dir, "spec.md"), "one\ntwo\nthree\n");
		stored.tasks[1].attachments = [{ id: "a4", path: "spec.md", lines: "2-3" }];
		fs.writeFileSync(path.join(dir, ".pig", "tasks", "w.json"), JSON.stringify(stored));
		await run("c4", { action: "complete", list: "w", id: "1", report: { outcome: "Done." } });
		const second = await run("c5", { action: "start", list: "w", id: "2" });
		assert.deepEqual(second.started[0].attachments, [{ id: "a4", ref: "spec.md:2-3", content: "two\nthree" }]);
		const upgraded = JSON.parse(fs.readFileSync(path.join(dir, ".pig", "tasks", "w.json"), "utf8")).tasks[1].attachments[0];
		assert.equal(upgraded.lines, undefined);
		assert.equal(upgraded.anchor.quote.exact, "two\nthree");
	} finally { r.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
check("a legacy session is adopted once on resume and its nested finishes close spans", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-adopt-"));
	fs.mkdirSync(path.join(dir, ".pig", "tasks"), { recursive: true });
	const now = new Date().toISOString();
	fs.writeFileSync(path.join(dir, ".pig", "tasks", "w.json"), JSON.stringify({ version: 2, slug: "w", title: "W", goal: "Done", createdAt: now, updatedAt: now, claim: null,
		tasks: [{ id: "1", title: "A", status: "done", updatedAt: now }, { id: "2", title: "B", status: "doing", updatedAt: now }] }));
	const call = (id, name, args) => ({ role: "assistant", responseId: `resp-${id}`, timestamp: 10, content: [{ type: "toolCall", id, name, arguments: args }] });
	const messages = [
		{ role: "user", content: "Work", timestamp: 1 },
		call("d1", "tasks", { action: "start", list: "w", id: "1" }),
		{ role: "toolResult", toolCallId: "d1", toolName: "tasks", content: [{ type: "text", text: 'Started w/1 "A".' }], isError: false, timestamp: 11 },
		call("m1", "codemode", { code: "…" }),
		{ role: "toolResult", toolCallId: "m1", toolName: "codemode", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 12, details: { calls: [] },
			nestedCalls: { complete: true, calls: [
				{ id: "m1/1", name: "tasks", status: "ok", arguments: { action: "complete", list: "w", id: "1", report: { outcome: "A done." } } },
				{ id: "m1/2", name: "tasks", status: "ok", arguments: { action: "start", list: "w", id: "2" } }] } },
	];
	const notes = [];
	const r = runtime(messages, { cwd: dir, sessionId: "adopt" });
	try {
		const adopted = r.entries.filter(e => e.customType === "accordion.taskfold.adopted");
		assert.equal(adopted.length, 1, "auto adoption writes one entry");
		assert.deepEqual(adopted[0].data.events.m1.map(e => [e.action, e.id]), [["complete", "1"], ["start", "2"]]);
		const host = await r.open();
		const { scanTaskSpans } = await jiti.import("../conductors/in-process/taskfold/taskfold.ts");
		const spans = scanTaskSpans(host.truth().blocks, b => b.text).map(s => [s.key, s.status]);
		assert.deepEqual(spans, [["w/1", "done"], ["w/2", null]]);
		r.ctx.ui.notify = text => notes.push(text);
		await r.command("tasks adopt --dry-run");
		assert.match(notes.at(-1), /Nothing to adopt/);
	} finally { r.close(); }
	try {
		const again = runtime(messages, { cwd: dir, sessionId: "adopt", entries: r.entries });
		try { assert.equal(again.entries.filter(e => e.customType === "accordion.taskfold.adopted").length, 1, "resume does not adopt twice"); }
		finally { again.close(); }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
check("native task inspection caches disk reads, refreshes changes and refuses a replacement session", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-task-views-"));
	const messages = [{ role: "user", content: "Inspect tasks", timestamp: 1 }];
	const r = runtime(messages, { cwd: dir, sessionId: "views-old" });
	const run = args => r.tools.tasks.execute("call", args, undefined, undefined, r.ctx);
	const { TaskStore } = await jiti.import("./tasks.ts");
	const scan = TaskStore.prototype.scan;
	let scans = 0;
	TaskStore.prototype.scan = function (...args) { scans++; return scan.apply(this, args); };
	let view;
	try {
		await run({ action: "create", list: "ui", title: "UI", goals: ["Initial goal"], tasks: [{ title: "Inspect work" }] });
		const result = await run({ action: "start", list: "ui", id: "1" });
		messages.push({ role: "assistant", responseId: "start", timestamp: 2, content: [{ type: "toolCall", id: "begin", name: "tasks", arguments: { action: "start", list: "ui", id: "1" } }] },
			{ role: "toolResult", toolCallId: "begin", toolName: "tasks", timestamp: 3, ...result, isError: false });
		await r.request(messages);
		r.ctx.ui.custom = async factory => {
			view = factory({ requestRender() {}, terminal: { rows: 40 } }, { fg: (_c, s) => s, bold: s => s, strikethrough: s => s },
				{ matches: (input, key) => input === ({ "tui.select.down": "\x1b[B", "tui.select.cancel": "\x1b" })[key] }, () => {});
			view.render(140); view.handleInput("\x1b[B"); view.handleInput("d");
			const before = scans;
			for (const width of [36, 57, 80, 140]) assert.match(view.render(width).join("\n"), /Initial goal/);
			assert.equal(scans, before, "render must not scan task files");
			await run({ action: "update", list: "ui", goals: { edit: [{ id: "g1", text: "Updated goal" }] } });
			assert.ok(scans > before, "task updates must reload the shared snapshot");
			const after = scans;
			for (const width of [36, 57, 80, 140]) assert.match(view.render(width).join("\n"), /Updated goal/);
			assert.equal(scans, after);
			r.ctx.sessionManager.getSessionId = () => "views-new";
			messages.splice(0, messages.length, { role: "user", content: "Replacement session", timestamp: 4 });
			r.entries.length = 0;
			await r.handlers.session_start({ reason: "new" }, r.ctx);
			await r.request(messages);
			view.handleInput("\x1b");
			assert.match(view.render(140).join("\n"), /No session context yet/);
			view.handleInput("p");
			assert.ok((await r.open()).truth().blocks.every(b => b.override === null));
		};
		await r.command("tasks tree");
	} finally {
		view?.dispose();
		TaskStore.prototype.scan = scan;
		r.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
check("task context rides in the start result and requests are never rewritten", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-task-context-"));
	const configDir = path.join(home, ".accordion");
	const config = path.join(configDir, "config.json");
	fs.mkdirSync(configDir, { recursive: true });
	const previous = fs.existsSync(config) ? fs.readFileSync(config) : null;
	fs.writeFileSync(config, JSON.stringify({ autoArm: true, defaultConductor: "taskfold", privacyConsent: { "taskfold-chat-v1": "2026-01-01T00:00:00Z" } }));
	fs.writeFileSync(path.join(dir, "spec.md"), "before");
	const messages = [{ role: "user", content: "Always use decimal.", timestamp: 1 }];
	const r = runtime(messages, { cwd: dir, sessionId: "task-context" });
	const run = args => r.tools.tasks.execute("call", args, undefined, undefined, r.ctx).then(res => res.content[0].text);
	try {
		await run({ action: "create", list: "w", title: "Work", goals: ["Finish work"], tasks: [{ title: "Task", acceptanceCriteria: ["Decimal everywhere"] }, { title: "Next" }] });
		await run({ action: "pin", list: "w", items: [{ kind: "constraint", text: "Always use decimal.", source: "user" }] });
		await run({ action: "attach", list: "w", id: "1", items: [{ path: "spec.md:1" }] });
		assert.equal(await run({ action: "start", list: "w", id: "1" }), JSON.stringify({ ok: true,
			list: { goals: [{ id: "g1", text: "Finish work" }], pins: [{ id: "p1", kind: "constraint", text: "Always use decimal.", source: "user" }] },
			started: [{ id: "1", title: "Task", criteria: [{ id: "c1", text: "Decimal everywhere" }], attachments: [{ id: "a1", ref: "spec.md@q:a1", content: "before" }] }] }));
		assert.equal(await run({ action: "pin", list: "w", id: "1", items: [{ kind: "fact", text: "Always use decimal.", source: "user" }] }), '{"ok":true,"pins":["p2"]}', "pin acknowledges only");
		assert.equal(await run({ action: "status", list: "w" }), '{"ok":true,"done":0,"total":2,"doing":["1"],"next":{"id":"2","title":"Next"}}', "status never repeats content");
		const stable = [{ role: "user", content: "Go.", timestamp: 10 }];
		const firstWire = r.handlers.context_with_system({ messages: stable.map(m => ({ ...m })) }, r.ctx)?.messages ?? stable;
		assert.equal(JSON.stringify(firstWire), JSON.stringify(stable), "no task text is appended to the request");
		await run({ action: "abandon", list: "w", id: "1", report: { outcome: "Done." } });
		const followUp = [...stable, { role: "assistant", responseId: "a", timestamp: 11, content: [{ type: "toolCall", id: "call-2", name: "tasks", arguments: {} }] },
			{ role: "toolResult", toolCallId: "call-2", toolName: "tasks", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 12 }];
		const secondWire = r.handlers.context_with_system({ messages: followUp.map(m => ({ ...m })) }, r.ctx)?.messages ?? followUp;
		assert.equal(JSON.stringify(secondWire.slice(0, firstWire.length)), JSON.stringify(firstWire), "a task transition keeps the previous request a byte prefix");
		await r.request(messages);
		await r.command("tasks dump-transcript --formats all snapshot");
		const flat = fs.readFileSync(path.join(dir, "snapshot.log"), "utf8");
		assert.doesNotMatch(flat, /working.set/i);
		const metadata = JSON.parse(flat.split("metadata (not on wire)\n")[1].split("\n").map(line => line.slice(4)).join("\n"));
		assert.deepEqual(metadata.task_lists[0].goals, [{ id: "g1", text: "Finish work" }]);
		assert.equal(metadata.task_lists[0].version ?? 3, 3);
		assert.equal(messages[0].content, "Always use decimal.");
	} finally {
		r.close();
		if (previous === null) fs.rmSync(config, { force: true }); else fs.writeFileSync(config, previous);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
check("start re-delivers task context only when the model can no longer see it", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-liveness-"));
	const messages = [{ role: "user", content: "Plan it.", timestamp: 1 }];
	const r = runtime(messages, { cwd: dir, sessionId: "liveness" });
	let call = 0;
	const run = async args => {
		const id = `live-${++call}`;
		const res = await r.tools.tasks.execute(id, args, undefined, undefined, r.ctx);
		messages.push({ role: "assistant", responseId: id, timestamp: 2 * call, content: [{ type: "toolCall", id, name: "tasks", arguments: args }] },
			{ role: "toolResult", toolCallId: id, toolName: "tasks", content: res.content, details: res.details, isError: false, timestamp: 2 * call + 1 });
		await r.request(messages);
		return JSON.parse(res.content[0].text);
	};
	try {
		const host = await r.open();
		await run({ action: "create", list: "w", title: "W", goals: ["Ship it"], tasks: [{ title: "A", acceptanceCriteria: ["a holds"], subtasks: [{ title: "A1" }, { title: "A2" }] }] });
		const first = await run({ action: "start", list: "w", id: "1.1" });
		assert.deepEqual(first.list, { goals: [{ id: "g1", text: "Ship it" }] });
		assert.deepEqual(first.started[0], { id: "1", title: "A", criteria: [{ id: "c1", text: "a holds" }] });
		await run({ action: "abandon", list: "w", id: "1.1", report: { outcome: "x" } });
		assert.deepEqual(await run({ action: "start", list: "w", id: "1.2" }), { ok: true, started: [{ id: "1.2", title: "A2" }] }, "live goal is not re-sent");
		// The model can no longer see a folded delivery, so its content comes back once.
		const truth = host.truth();
		const carrier = truth.blocks.find(b => b.details?.delivered?.some(k => k.startsWith("w/item:g1#")));
		assert.ok(carrier, "the first start result records its delivery keys");
		host.command({ kind: "setFolding", value: true });
		host.command({ kind: "setProtect", value: 0 });
		const folded = host.command({ kind: "ops", ops: [{ kind: "fold", ids: [carrier.id] }] });
		assert.ok(truth.isFolded(carrier), JSON.stringify(folded.results));
		assert.ok(truth.isFolded(carrier));
		await run({ action: "block", list: "w", id: "1.2", reason: "user-input", detail: "key" });
		const resumed = await run({ action: "start", list: "w", id: "1.2" });
		assert.deepEqual(resumed.list, { goals: [{ id: "g1", text: "Ship it" }] });
		assert.deepEqual(resumed.resumed[0], { id: "1", title: "A", criteria: [{ id: "c1", text: "a holds" }] });
		// An edited goal has a new key, so it counts as not delivered.
		await run({ action: "update", list: "w", goals: { edit: [{ id: "g1", text: "Ship it today" }] } });
		await run({ action: "block", list: "w", id: "1.2", reason: "user-input", detail: "key" });
		assert.deepEqual((await run({ action: "start", list: "w", id: "1.2" })).list, { goals: [{ id: "g1", text: "Ship it today" }] });
		// A pin the agent wrote is live through its own pin result.
		await run({ action: "pin", list: "w", items: [{ kind: "rule", text: "Plan it.", source: "user" }] });
		await run({ action: "block", list: "w", id: "1.2", reason: "user-input", detail: "key" });
		assert.equal((await run({ action: "start", list: "w", id: "1.2" })).list, undefined);
	} finally {
		r.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
check("start resends a doing parent's context once folding hid it", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-parents-"));
	const messages = [{ role: "user", content: "Plan it.", timestamp: 1 }];
	const r = runtime(messages, { cwd: dir, sessionId: "parents" });
	let call = 0;
	const run = async args => {
		const id = `par-${++call}`;
		const res = await r.tools.tasks.execute(id, args, undefined, undefined, r.ctx);
		messages.push({ role: "assistant", responseId: id, timestamp: 2 * call, content: [{ type: "toolCall", id, name: "tasks", arguments: args }] },
			{ role: "toolResult", toolCallId: id, toolName: "tasks", content: res.content, details: res.details, isError: false, timestamp: 2 * call + 1 });
		await r.request(messages);
		return JSON.parse(res.content[0].text);
	};
	try {
		const host = await r.open();
		await run({ action: "create", list: "w", title: "W", goals: ["Ship it"], tasks: [{ title: "A", acceptanceCriteria: ["a holds"], subtasks: [{ title: "A1" }, { title: "A2" }, { title: "A3" }] }] });
		await run({ action: "start", list: "w", id: "1.1" });
		await run({ action: "complete", list: "w", id: "1.1", report: { outcome: "x" } });
		assert.deepEqual(await run({ action: "start", list: "w", id: "1.2" }), { ok: true, started: [{ id: "1.2", title: "A2" }] }, "a live parent delivery is not resent");
		await run({ action: "complete", list: "w", id: "1.2", report: { outcome: "x" } });
		const truth = host.truth();
		const carrier = truth.blocks.find(b => b.details?.delivered?.some(k => k.startsWith("w/item:c1#")));
		host.command({ kind: "setFolding", value: true });
		host.command({ kind: "setProtect", value: 0 });
		host.command({ kind: "ops", ops: [{ kind: "fold", ids: [carrier.id] }] });
		assert.ok(truth.isFolded(carrier));
		const third = await run({ action: "start", list: "w", id: "1.3" });
		assert.deepEqual(third.parents, [{ id: "1", title: "A", criteria: [{ id: "c1", text: "a holds" }] }]);
		assert.deepEqual(third.started, [{ id: "1.3", title: "A3" }]);
	} finally {
		r.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
check("shutdown releases only this session's task claims across visited projects", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-claims-"));
	const r = runtime([], { sessionId: "owner" });
	const run = args => r.tools.tasks.execute("call", args, undefined, undefined, r.ctx);
	const read = (project, slug) => JSON.parse(fs.readFileSync(path.join(project, ".pig", "tasks", `${slug}.json`), "utf8"));
	try {
		r.ctx.cwd = dir;
		await run({ action: "create", list: "owned", title: "Owned", goals: ["G"], tasks: [{ title: "Work" }] });
		await run({ action: "start", list: "owned", id: "1" });
		await run({ action: "create", list: "taken", title: "Taken", goals: ["G"], tasks: [] });
		const takenFile = path.join(dir, ".pig", "tasks", "taken.json");
		const taken = read(dir, "taken");
		taken.claim.session = "other";
		fs.writeFileSync(takenFile, JSON.stringify(taken));
		r.ctx.cwd = path.join(dir, "second");
		await run({ action: "create", list: "second", title: "Second", goals: ["G"], tasks: [] });
		// A mutable session manager must not make cleanup release the replacement session's claims.
		r.ctx.sessionManager.getSessionId = () => "other";
		r.close();
		assert.equal(read(dir, "owned").claim, null);
		assert.equal(read(dir, "owned").tasks[0].status, "doing");
		assert.equal(read(dir, "taken").claim.session, "other");
		assert.equal(read(path.join(dir, "second"), "second").claim, null);
	} finally {
		r.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
check("session replacement releases resumed claims before tracking the next session", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-resumed-claims-"));
	const taskDir = path.join(dir, ".pig", "tasks");
	fs.mkdirSync(taskDir, { recursive: true });
	const file = path.join(taskDir, "resumed.json");
	fs.writeFileSync(file, JSON.stringify({ slug: "resumed", title: "Resumed", tasks: [], claim: { session: "old", at: new Date().toISOString() } }));
	const r = runtime([], { cwd: dir, sessionId: "old" });
	try {
		r.ctx.sessionManager.getSessionId = () => "new";
		r.handlers.session_start({ reason: "new" }, r.ctx);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claim, null);
		await r.tools.tasks.execute("call", { action: "claim", list: "resumed" }, undefined, undefined, r.ctx);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claim.session, "new");
		r.close();
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claim, null);
	} finally {
		r.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
const usage = { input: 70, output: 150, cacheRead: 132_193, cacheWrite: 70, totalTokens: 132_483, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function history(repeats = 60_000) {
	return [
		{ role: "user", content: "Previous context ".repeat(repeats), timestamp: 1 },
		{ role: "assistant", provider: "synthetic", api: "openai-completions", model: "old-model", responseId: "old-reply", content: [{ type: "text", text: "Done" }], timestamp: 2, stopReason: "stop", usage: structuredClone(usage) },
		{ role: "user", content: "Continue", timestamp: 3 },
	];
}
check("request-local usage cannot undercount the serialized prefix after switching models", async () => {
	const messages = history();
	const r = runtime(messages);
	try {
		const wire = await r.request(messages);
		let payload;
		const result = await streamSimple(r.ctx.model, { messages: wire }, {
			apiKey: "test-key",
			onPayload: p => { payload = p; },
			fetch: async () => new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }),
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const output = payload.max_tokens ?? payload.max_completion_tokens;
		const inputEstimate = Math.ceil(JSON.stringify(payload.messages).length / 3.5);
		console.log(`request budget: input estimate ${inputEstimate}, output ${output}, window ${r.ctx.model.contextWindow}`);
		assert.ok(inputEstimate + output < r.ctx.model.contextWindow, "stale usage reserved output space already occupied by input");
		assert.deepEqual(messages[1].usage, usage, "stored usage must remain unchanged");
		assert.equal(wire[2].usage.totalTokens, 0);
	} finally { r.close(); }
});
check("all same-model usage anchors are invalidated without changing content or cost", async () => {
	const messages = history(2);
	messages[1] = { ...messages[1], provider: "openrouter", model: "test/model" };
	messages.push({ ...messages[1], responseId: "second-reply", timestamp: 4, usage: { ...usage, totalTokens: 100 } });
	const original = structuredClone(messages);
	const r = runtime(messages);
	try {
		const wire = await r.request(messages);
		const assistants = wire.filter(m => m.role === "assistant");
		assert.equal(assistants.length, 2);
		for (const message of assistants) {
			assert.equal(message.usage.totalTokens, 0);
			assert.equal(message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite, 0);
			assert.deepEqual(message.usage.cost, usage.cost);
			assert.deepEqual(message.content, messages[1].content);
		}
		assert.deepEqual(messages, original);
	} finally { r.close(); }
});
check("folding disabled preserves the request and its usage", async () => {
	const messages = history();
	const r = runtime(messages);
	try {
		const host = await r.open();
		host.command({ kind: "setFolding", value: false });
		const wire = await r.request(messages);
		assert.deepEqual(wire.slice(1), messages);
	} finally { r.close(); }
});
check("chronological branch-only resume matches resolved session history", async () => {
	const messages = history();
	const r = runtime(messages.map(m => m.role === "user" ? { ...m, content: m.content.slice(0, 32) } : m), { branchOnly: true });
	try {
		const host = await r.open();
		assert.deepEqual(host.truth().blocks.filter(b => b.kind === "user").map(b => b.text), [messages[0].content.slice(0, 32), messages[2].content]);
	} finally { r.close(); }
});
check("a model change invalidates previous provider calibration", async () => {
	const r = runtime(history(2));
	try {
		const host = await r.open();
		const t = host.truth();
		await r.request(history(2));
		t.setCalibration(0.2);
		r.ctx.model = { ...r.ctx.model, id: "other-model", provider: "other-provider" };
		r.handlers.model_select({ model: r.ctx.model }, r.ctx);
		assert.equal(t.calibration, 1);
		r.handlers.message_end({ message: { ...history(2)[1], responseId: "late-old-reply", timestamp: 4 } }, r.ctx);
		assert.equal(t.calibration, 1, "a late old-provider receipt must not restore the invalidated calibration");
	} finally { r.close(); }
});
check("session replacement without a model clears the old window", async () => {
	const r = runtime(history(2));
	try {
		r.ctx.model = undefined;
		r.ctx.getContextUsage = () => undefined;
		r.handlers.session_start({ reason: "new" }, r.ctx);
		const host = await r.open();
		assert.equal(host.truth().contextWindow, null);
	} finally { r.close(); }
});
check("the same model selection preserves calibration and human settings", async () => {
	const r = runtime(history(2));
	try {
		const host = await r.open();
		const t = host.truth();
		t.setCalibration(0.5);
		t.setBudget(100_000);
		r.handlers.model_select({ model: r.ctx.model }, r.ctx);
		assert.equal(t.calibration, 0.5);
		assert.equal(t.budget, 100_000);
	} finally { r.close(); }
});
check("a resumed session restores the budget and tail the user set for its model", async () => {
	const first = runtime(history(2));
	let entries;
	try {
		const host = await first.open();
		await host.command({ kind: "setBudget", value: 200_000 });
		await host.command({ kind: "setProtect", value: 8_000 });
		entries = first.entries;
	} finally { first.close(); }
	const resumed = runtime(history(2), { entries });
	try {
		const t = (await resumed.open()).truth();
		assert.equal(t.budget, 200_000);
		assert.equal(t.protectTokens, 8_000);
	} finally { resumed.close(); }
});
check("switching models follows each model's own budget: session value, then its default, then the window", async () => {
	fs.writeFileSync(path.join(home, ".accordion", "config.json"), JSON.stringify({ modelDefaults: { "openrouter/*": { budget: "272k", protect: "10k" } } }));
	const r = runtime(history(2));
	try {
		const host = await r.open();
		const t = host.truth();
		assert.equal(t.budget, 272_000);
		assert.equal(t.protectTokens, 10_000);
		await host.command({ kind: "setBudget", value: 150_000 });
		const other = { ...r.ctx.model, provider: "anthropic", id: "claude", contextWindow: 400_000 };
		const back = r.ctx.model;
		r.ctx.model = other;
		r.handlers.model_select({ model: other }, r.ctx);
		assert.equal(t.budget, 400_000);
		assert.equal(t.protectTokens, 20_000);
		r.ctx.model = back;
		r.handlers.model_select({ model: back }, r.ctx);
		assert.equal(t.budget, 150_000);
		assert.equal(t.protectTokens, 10_000);
		assert.equal(host.saveDialDefault("budget", 180_000), "Saved budget 180k as the default for openrouter/test/model");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".accordion", "config.json"), "utf8")).modelDefaults["openrouter/test/model"], { budget: "180k" });
	} finally {
		r.close();
		fs.rmSync(path.join(home, ".accordion", "config.json"), { force: true });
	}
});
check("fold timing commands persist per model without unfolding or changing numeric dials", async () => {
	const r = runtime(history(2));
	try {
		const host = await r.open();
		const truth = host.truth();
		const before = { budget: truth.budget, protect: truth.protectTokens, groups: structuredClone(truth.groups) };
		assert.equal(host.dials().timing, "eager");
		await r.command("fold pressure");
		assert.equal(host.dials().timing, "pressure");
		assert.deepEqual(r.entries.filter(e => e.customType === "accordion.dials").at(-1).data, { model: "openrouter/test/model", timing: "pressure" });
		await r.command("fold invalid");
		assert.equal(host.dials().timing, "pressure");
		assert.deepEqual({ budget: truth.budget, protect: truth.protectTokens, groups: truth.groups }, before);
		const original = r.ctx.model;
		r.ctx.model = { ...original, id: "another-model" };
		r.handlers.model_select({ model: r.ctx.model }, r.ctx);
		assert.equal(host.dials().timing, "eager");
		r.ctx.model = original;
		r.handlers.model_select({ model: original }, r.ctx);
		assert.equal(host.dials().timing, "pressure");
		r.handlers.session_start({ reason: "resume" }, r.ctx);
		assert.equal((await r.open()).dials().timing, "pressure");
	} finally { r.close(); }
});
check("host cache observations reset on model and session changes", async () => {
	const r = runtime([], { sessionId: "cache-reset-smoke" });
	const selectTaskfold = async () => {
		const host = await r.open();
		await host.command({ kind: "selectConductor", id: "taskfold" });
		await new Promise(resolve => setImmediate(resolve));
	};
	try {
		await r.command("debug on");
		r.ctx.model = { ...r.ctx.model, provider: "anthropic", id: "claude-sonnet-5-5" };
		r.handlers.model_select({ model: r.ctx.model }, r.ctx);
		await selectTaskfold();
		r.handlers.before_provider_request({ payload: { cache_control: { type: "ephemeral", ttl: "1h" } } }, r.ctx);
		await r.request([]);
		r.ctx.model = { ...r.ctx.model, id: "claude-opus-5-5" };
		r.handlers.model_select({ model: r.ctx.model }, r.ctx);
		await r.request([]);
		r.handlers.before_provider_request({ payload: { cache_control: { type: "ephemeral", ttl: "1h" } } }, r.ctx);
		r.handlers.session_start({ reason: "new" }, r.ctx);
		await selectTaskfold();
		await r.request([]);
	} finally { await r.close(); }
	const epochs = fs.readFileSync(path.join(home, ".accordion/debug/cache-reset-smoke.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(row => row.type === "epoch");
	assert.ok(epochs.some(row => row.cache.ttlMs === 3_600_000 && !row.cold));
	const warm = epochs.findIndex(row => row.cache.ttlMs === 3_600_000);
	assert.ok(epochs.slice(warm + 1).some(row => row.cache.ttlMs === 300_000 && row.cold), "model change clears the prior provider TTL and cache age");
	assert.equal(epochs.at(-1).cache.ttlMs, 300_000);
	assert.equal(epochs.at(-1).cold, true, "new session starts cold");
});
check("a provider-only change and a late-learned model change both invalidate calibration", async () => {
	const r = runtime(history(2));
	try {
		const host = await r.open();
		const t = host.truth();
		t.setCalibration(0.2);
		r.ctx.model = { ...r.ctx.model, provider: "other-provider" };
		r.handlers.model_select({ model: r.ctx.model }, r.ctx);
		assert.equal(t.calibration, 1);
		t.setCalibration(0.3);
		r.ctx.model = { ...r.ctx.model, id: "late-model" };
		await r.request(history(2));
		assert.equal(t.calibration, 1);
	} finally { r.close(); }
});
check("debug records receipts and rejected tasks without synchronous writes on the context hook", async () => {
	const r = runtime([], { sessionId: "debug-smoke" });
	try {
		await r.command("debug on");
		const writes = ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync"];
		const originals = new Map(writes.map(key => [key, fsDefault[key]]));
		try {
			for (const key of writes) fsDefault[key] = () => { throw new Error(`synchronous write in context: ${key}`); };
			syncBuiltinESMExports();
			await r.request([{ role: "user", content: "Debug smoke", timestamp: 1 }]);
			r.handlers.before_provider_request({ payload: { prompt_cache_options: { ttl: "12h" } } }, r.ctx);
		} finally {
			for (const [key, value] of originals) fsDefault[key] = value;
			syncBuiltinESMExports();
		}
		r.handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done" }], responseId: "debug-reply", timestamp: 2,
			stopReason: "stop", usage: { input: 200, cacheRead: 10, cacheWrite: 20 } } }, r.ctx);
		await assert.rejects(r.tools.tasks.execute("debug-invalid", { action: "create", list: "bad!", title: "Invalid", goals: ["Test"], tasks: [] }, undefined, undefined, r.ctx));
		await r.command("debug off");
		assert.deepEqual(r.entries.filter(e => e.customType === "accordion.debug").map(e => e.data.enabled), [true, false]);
	} finally { await r.close(); }
	const rows = fs.readFileSync(path.join(home, ".accordion/debug/debug-smoke.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	assert.ok(rows.some(row => row.type === "request" && row.realInput === 230 && row.cacheRead === 10));
	assert.ok(rows.some(row => row.type === "tasks" && row.error));
	assert.ok(rows.some(row => row.type === "cache-profile" && row.cache.ttlMs === 43_200_000));
});
let failures = 0;
try {
	for (const { name, fn } of checks) {
		try { await fn(); console.log(`PASS ${name}`); }
		catch (err) { failures++; console.error(`FAIL ${name}:`, err); }
	}
} finally { fs.rmSync(home, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
