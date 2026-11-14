import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiMessage } from "../core/wire";
import type { Block } from "../core/types";
import type { AccordionTuiHost } from "./tui/host";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-custom-"));
process.env.ACCORDION_HOME = home;
process.env.ACCORDION_DOOR_PORT = "0";
process.env.ACCORDION_AUTO_ARM = "1";
// The extension reads its home configuration during module loading.
const { default: accordion } = await import("./accordion");

async function runtime(messages: PiMessage[], branch?: object[]) {
	const handlers: Record<string, Function> = {};
	let host: AccordionTuiHost | undefined, command: Function = () => {};
	let activeTools: string[] = [];
	const pi = {
		on: (name: string, fn: Function) => { handlers[name] = fn; },
		getActiveTools: () => activeTools.slice(), setActiveTools: (next: string[]) => { activeTools = next.slice(); },
		registerFlag() {}, getFlag() {}, registerTool() {}, appendEntry() {}, sendMessage() {},
		registerShortcut() {}, registerMessageRenderer() {}, getSessionName: () => undefined,
		registerCommand: (name: string, def: { handler: Function }) => { if (name === "accordion") command = def.handler; },
	};
	accordion(pi as unknown as ExtensionAPI, { openPanel: (_ctx, h) => { host = h; } });
	const ctx = {
		mode: "tui", hasUI: true, cwd: home, isIdle: () => false,
		model: { id: "test/model", name: "Test", provider: "openrouter", api: "openai-completions", baseUrl: "http://localhost.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 100000 },
		ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async (_title: string, choices: unknown[]) => choices.at(-1), theme: { fg: (_c: string, s: string) => s } },
		sessionManager: { getSessionId: () => "custom-test", getBranch: () => branch ?? messages.map(message => ({ type: "message", message })), ...(branch ? {} : { buildSessionContext: () => ({ messages }) }) },
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000000 }), getSystemPrompt: () => "System instructions",
	};
	await handlers.session_start({ reason: "resume" }, ctx);
	await command("", ctx);
	if (!host) throw new Error("Panel host did not open");
	return { handlers, ctx, host, close: () => handlers.session_shutdown({}, ctx) };
}

const user = { role: "user", content: "inspect", timestamp: 1 };
const custom = { role: "custom", customType: "ext.notice", content: "A large extension notice ".repeat(100), display: false, details: { source: "test" }, timestamp: 2 };
const assistant = { role: "assistant", responseId: "reply", content: [{ type: "text", text: "done" }], timestamp: 3 };

test("live custom messages are counted once and fold as custom messages", async () => {
	const r = await runtime([user]);
	try {
		const before = r.host.truth()?.stats().liveTokens ?? 0;
		await r.handlers.message_end({ message: custom }, r.ctx);
		await r.handlers.message_end({ message: assistant }, r.ctx);
		const truth = r.host.truth();
		if (!truth) throw new Error("Truth did not initialize");
		const blocks = truth.blocks.filter((b) => b.kind !== "system");
		expect(blocks.map((b) => [b.kind, b.turn])).toEqual([["user", 1], ["custom", 1], ["text", 1]]);
		expect(truth.stats().liveTokens).toBeGreaterThanOrEqual(blocks[1].tokens);
		expect(blocks[1].tokens).toBeGreaterThan(0);
		expect(truth.stats().liveTokens - before).toBeGreaterThanOrEqual(blocks[1].tokens);
		const messages = [user, custom, assistant];
		await r.handlers.context({ messages }, r.ctx);
		await r.handlers.context({ messages }, r.ctx);
		expect(truth.blocks.filter((b) => b.kind === "custom")).toHaveLength(1);
		await r.host.command({ kind: "setFolding", value: true });
		await r.host.command({ kind: "setProtect", value: 0 });
		await r.host.command({ kind: "ops", ops: [{ kind: "fold", ids: [blocks[1].id] }] });
		const result = await r.handlers.context({ messages }, r.ctx);
		const folded = result.messages.find((m: PiMessage) => m.role === "custom");
		expect(folded.customType).toBe(custom.customType);
		expect(folded.details).toEqual(custom.details);
		expect(folded.content).toMatch(/\{#[^}]+ FOLDED\}/);
	} finally { await r.close(); }
});

test("context alone ingests a custom message in its original position", async () => {
	const r = await runtime([user]);
	try {
		await r.handlers.context({ messages: [user, custom, assistant] }, r.ctx);
		const truth = r.host.truth();
		if (!truth) throw new Error("Truth did not initialize");
		expect(truth.blocks.filter((b) => b.kind !== "system").map((b) => b.kind)).toEqual(["user", "custom", "text"]);
	} finally { await r.close(); }
});

test("fallback branch reconstructs Pi custom entries in order", async () => {
	const entry = { type: "custom_message", id: "c1", timestamp: "2026-01-01T00:00:00.000Z", customType: custom.customType, content: custom.content, display: false, details: custom.details };
	const r = await runtime([], [{ type: "message", message: user }, entry, { type: "message", message: assistant }]);
	try {
		const truth = r.host.truth();
		if (!truth) throw new Error("Truth did not initialize");
		const blocks = truth.blocks.filter((b) => b.kind !== "system");
		expect(blocks.map((b) => b.kind)).toEqual(["user", "custom", "text"]);
		expect(blocks[1].id.startsWith(`c:${Date.parse(entry.timestamp)}:`)).toBe(true);
		expect(blocks[1].text).toBe(custom.content);
	} finally { await r.close(); }
});

test("positional custom messages retain their indices across suffix appends", async () => {
	const r = await runtime([user]);
	try {
		const first = { role: "custom", customType: "one", content: "first", display: false };
		const second = { role: "custom", customType: "two", content: "second", display: false };
		await r.handlers.message_end({ message: first }, r.ctx);
		await r.handlers.message_end({ message: second }, r.ctx);
		const truth = r.host.truth();
		if (!truth) throw new Error("Truth did not initialize");
		expect(truth.blocks.filter((b: Block) => b.kind === "custom").map((b: Block) => [b.id, b.text])).toEqual([["m1:c", "first"], ["m2:c", "second"]]);
		await r.handlers.agent_end({ messages: [first, second] }, r.ctx);
		expect(truth.blocks.filter((b) => b.kind === "custom")).toHaveLength(2);
		await r.handlers.context({ messages: [user, first, second] }, r.ctx);
		expect(truth.blocks.filter((b: Block) => b.kind === "custom")).toHaveLength(2);
	} finally { await r.close(); }
});

test("identical positional messages survive backstop and a missed identity is reconciled", async () => {
	const r = await runtime([user]);
	try {
		const first = { role: "custom", customType: "notice", content: "same", display: false };
		const second = { ...first };
		await r.handlers.message_end({ message: first }, r.ctx);
		await r.handlers.message_end({ message: second }, r.ctx);
		await r.handlers.agent_end({ messages: [first, second] }, r.ctx);
		const truth = r.host.truth();
		if (!truth) throw new Error("Truth did not initialize");
		expect(truth.blocks.filter((b) => b.kind === "custom").map((b) => b.id)).toEqual(["m1:c", "m2:c"]);
		await r.handlers.agent_end({ messages: [{ ...second }] }, r.ctx);
		expect(truth.blocks.filter((b) => b.kind === "custom")).toHaveLength(3);
		await r.handlers.context({ messages: [user, first, second] }, r.ctx);
		expect(r.host.truth()?.blocks.filter((b) => b.kind === "custom").map((b) => b.id)).toEqual(["m1:c", "m2:c"]);
	} finally { await r.close(); }
});

process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
