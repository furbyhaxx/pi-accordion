import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

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
	let host;
	let command;
	const pi = {
		on: (name, fn) => { handlers[name] = fn; },
		registerFlag() {}, getFlag() {}, registerTool(tool) { tools[tool.name] = tool; }, appendEntry() {},
		registerShortcut: () => {},
		registerCommand: (name, def) => { if (name === "accordion") command = def.handler; },
	};
	accordion(pi, { openPanel: async (_ctx, h) => { host = h; } });
	const model = {
		id: "test/model", name: "Test", provider: "openrouter", api: "openai-completions",
		baseUrl: "http://localhost.invalid/v1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576, maxTokens: 943_718,
	};
	const ctx = {
		mode: "tui", hasUI: true, cwd: options.cwd ?? home, model,
		ui: { notify() {}, setStatus() {}, confirm: async () => true, theme: { fg: (_c, s) => s } },
		sessionManager: {
			getSessionId: () => options.sessionId ?? "context-test-session",
			getBranch: () => messages.map(message => ({ type: "message", message })),
			...(options.branchOnly ? {} : { buildSessionContext: () => ({ messages }) }),
		},
		getContextUsage: () => ({ tokens: 132_483, contextWindow: ctx.model.contextWindow }),
		getSystemPrompt: () => "System instructions",
	};
	handlers.session_start({ reason: "resume" }, ctx);
	return {
		handlers, ctx, tools,
		open: async () => { await command("", ctx); return host; },
		request: async input => {
			const folded = await handlers.context({ messages: input }, ctx);
			const wire = [{ role: "system", content: "System instructions", timestamp: 0 }, ...(folded?.messages ?? input)];
			return (await handlers.context_with_system?.({ messages: wire }, ctx))?.messages ?? wire;
		},
		close: () => handlers.session_shutdown({}, ctx),
	};
}
check("shutdown releases only this session's task claims across visited projects", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-claims-"));
	const r = runtime([], { sessionId: "owner" });
	const run = args => r.tools.tasks.execute("call", args, undefined, undefined, r.ctx);
	const read = (project, slug) => JSON.parse(fs.readFileSync(path.join(project, ".pig", "tasks", `${slug}.json`), "utf8"));
	try {
		r.ctx.cwd = dir;
		await run({ action: "create", list: "owned", title: "Owned", tasks: [{ title: "Work" }] });
		await run({ action: "start", list: "owned", id: "1" });
		await run({ action: "create", list: "taken", title: "Taken", tasks: [] });
		const takenFile = path.join(dir, ".pig", "tasks", "taken.json");
		const taken = read(dir, "taken");
		taken.claim.session = "other";
		fs.writeFileSync(takenFile, JSON.stringify(taken));
		r.ctx.cwd = path.join(dir, "second");
		await run({ action: "create", list: "second", title: "Second", tasks: [] });
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
	fs.writeFileSync(file, JSON.stringify({ slug: "resumed", tasks: [], claim: { session: "old", at: new Date().toISOString() } }));
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
let failures = 0;
try {
	for (const { name, fn } of checks) {
		try { await fn(); console.log(`PASS ${name}`); }
		catch (err) { failures++; console.error(`FAIL ${name}:`, err); }
	}
} finally { fs.rmSync(home, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
