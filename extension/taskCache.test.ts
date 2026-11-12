import { expect, test } from "bun:test";
import { linearize, wireToBlock, type PiMessage } from "../core/wire";
import { withTaskEvents } from "../core/taskEvents";
import { taskCacheFrontier } from "./taskCache";

const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const long = { type: "ephemeral", ttl: "1h" };

interface FixturePayload {
	model: string;
	tools: Record<string, unknown>[];
	system: Record<string, unknown>[];
	messages: { role: string; content: Record<string, unknown>[] }[];
}

function fixture(merged = true) {
	const messages: PiMessage[] = [
		{ role: "user", timestamp: 1, content: "Do the work." },
		{ role: "assistant", responseId: "parent", content: [{ type: "toolCall", id: "root", name: "tasks", arguments: { action: "start", list: "w", id: "1" } }] },
		{ role: "toolResult", toolCallId: "root", toolName: "tasks", content: [{ type: "text", text: "Started" }], details: withTaskEvents(undefined, [{ action: "start", list: "w", id: "1", started: [{ id: "1", title: "Parent", status: "doing" }] }]) },
		{ role: "assistant", responseId: "carrier", content: [{ type: "text", text: "Prior sibling record." }] },
		{ role: "assistant", responseId: "child", content: [
			{ type: "thinking", thinking: "Plan the second child.", thinkingSignature: "sealed" },
			{ type: "text", text: "Starting child." },
			{ type: "toolCall", id: "child", name: "tasks", arguments: { action: "start", list: "w", id: "1.2" } },
		] },
		{ role: "toolResult", toolCallId: "child", toolName: "tasks", content: [{ type: "text", text: "Started" }], details: withTaskEvents(undefined, [{ action: "start", list: "w", id: "1.2", started: [{ id: "1.2", title: "Child", status: "doing" }] }]) },
	];
	const carrier = { type: "text", text: "Prior sibling record." };
	const opener = [
		{ type: "thinking", thinking: "Plan the second child.", signature: "sealed" },
		{ type: "text", text: "Starting child." },
		{ type: "tool_use", id: "child", name: "tasks", input: { action: "start", list: "w", id: "1.2" } },
	];
	const payload: FixturePayload = {
		model: "claude-sonnet-5-5",
		tools: [{ name: "tasks", input_schema: {}, cache_control: long }],
		system: [{ type: "text", text: identity, cache_control: long }, { type: "text", text: "Instructions", cache_control: long }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Do the work." }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "root", name: "tasks", input: { action: "start", list: "w", id: "1" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "root", content: "Started" }] },
			...(merged ? [{ role: "assistant", content: [carrier, ...opener] }] : [{ role: "assistant", content: [carrier] }, { role: "assistant", content: opener }]),
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "child", content: "Started", cache_control: long }] },
		],
	};
	return { messages, blocks: linearize(messages).map(wireToBlock), payload };
}

function withoutControls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutControls);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
		.filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutControls(item)]));
	return value;
}

function controls(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(controls);
	if (value && typeof value === "object") return Object.entries(value)
		.flatMap(([key, item]) => key === "cache_control" ? [item] : controls(item));
	return [];
}

for (const merged of [true, false]) test(`marks before the whole innermost opener, merged=${merged}`, () => {
	const { payload, blocks, messages } = fixture(merged);
	const original = structuredClone(payload);
	const result = taskCacheFrontier(payload, blocks, messages);
	expect(result).toMatchObject({ reason: "applied", task: "w/1.2", message: 3, block: 0, markers: 4 });
	expect(result.payload?.system).toEqual([{ type: "text", text: identity }, payload.system[1]]);
	expect(result.payload?.tools).toEqual(payload.tools);
	expect(result.payload?.messages).toEqual(expect.arrayContaining([
		expect.objectContaining({ role: "assistant", content: expect.arrayContaining([{ type: "text", text: "Prior sibling record.", cache_control: long }]) }),
		payload.messages.at(-1),
	]));
	expect(controls(result.payload)).toHaveLength(4);
	expect(withoutControls(result.payload)).toEqual(withoutControls(payload));
	expect(payload).toEqual(original);
});

test("seeds the identity before the known post-hook OAuth transform, without a redundant marker", () => {
	const { payload, blocks, messages } = fixture();
	payload.system.shift();
	const result = taskCacheFrontier(payload, blocks, messages, true);
	expect(result.reason).toBe("applied");
	expect(controls(result.payload)).toHaveLength(4);
	expect(withoutControls(result.payload)).toEqual(withoutControls({ ...payload, system: [{ type: "text", text: identity }, ...payload.system] }));
	expect(controls(payload)).toHaveLength(3);
	const apiKey = taskCacheFrontier(payload, blocks, messages);
	expect(withoutControls(apiKey.payload)).toEqual(withoutControls(payload));
});

test("uses persisted outer-call events for starts inside codemode", () => {
	const { payload, blocks, messages } = fixture();
	const call = blocks.find((b) => b.callId === "child" && b.kind === "tool_call");
	if (!call) throw new Error("Missing fixture call");
	call.toolName = "codemode";
	call.text = 'codemode {"code":"await tools.tasks({action: \'start\'})"}';
	expect(taskCacheFrontier(payload, blocks, messages)).toMatchObject({ reason: "applied", task: "w/1.2", message: 3, block: 0 });
});

test("does not enable caching or rewrite an unrecognizable payload", () => {
	const { payload, blocks, messages } = fixture();
	expect(taskCacheFrontier(withoutControls(payload), blocks, messages).reason).toBe("cache-disabled");
	expect(taskCacheFrontier(undefined, blocks, messages).payload).toBeUndefined();
	expect(taskCacheFrontier({ messages: [] }, blocks, messages).payload).toBeUndefined();
});

test("does not use a task from another request or a completed/paused branch", () => {
	const { payload, blocks, messages } = fixture();
	const different = structuredClone(payload);
	different.messages[3]!.content.pop();
	expect(taskCacheFrontier(different, blocks, messages).payload).toBeUndefined();
	expect(taskCacheFrontier(payload, [], messages).reason).toBe("no-open-task");
	messages.push({ role: "assistant", responseId: "pause", content: [{ type: "toolCall", id: "pause", name: "tasks", arguments: { action: "block", list: "w", id: "1.2" } }] },
		{ role: "toolResult", toolCallId: "pause", toolName: "tasks", content: [{ type: "text", text: "Blocked" }], details: withTaskEvents(undefined, [{ action: "block", list: "w", id: "1.2" }]) },
		{ role: "user", content: "New request.", timestamp: 9 });
	expect(taskCacheFrontier(payload, linearize(messages).map(wireToBlock), messages).reason).toBe("no-open-task");
});

test("requires a unique source-message match", () => {
	const { payload, blocks, messages } = fixture();
	payload.messages.splice(4, 0, structuredClone(payload.messages[3]!));
	expect(taskCacheFrontier(payload, blocks, messages).reason).toBe("ambiguous-boundary");
});

test("does not evict a nonredundant marker to make room", () => {
	const { payload, blocks, messages } = fixture();
	payload.system[0]!.text = "A separate cache tier";
	expect(taskCacheFrontier(payload, blocks, messages)).toMatchObject({ reason: "no-marker-slot" });
	expect(controls(payload)).toHaveLength(4);
});

test("counts automatic caching as a slot", () => {
	const { payload, blocks, messages } = fixture();
	const result = taskCacheFrontier({ ...payload, cache_control: long }, blocks, messages);
	expect(result.reason).toBe("no-marker-slot");
	expect(result.payload).toBeUndefined();
});

test("preserves mixed TTL ordering and never marks thinking", () => {
	const { payload, blocks, messages } = fixture();
	payload.system[0]!.cache_control = { type: "ephemeral", ttl: "5m" };
	payload.system[1]!.cache_control = { type: "ephemeral", ttl: "5m" };
	payload.messages.at(-1)!.content[0]!.cache_control = { type: "ephemeral", ttl: "5m" };
	const result = taskCacheFrontier(payload, blocks, messages);
	expect(result).toMatchObject({ reason: "applied", message: 3, block: 0 });
	expect(controls(result.payload)).toEqual([long, { type: "ephemeral", ttl: "5m" }, { type: "ephemeral", ttl: "5m" }, { type: "ephemeral", ttl: "5m" }]);
});

test("does not add a duplicate breakpoint or change unsafe controls", () => {
	const { payload, blocks, messages } = fixture();
	const marked = structuredClone(payload);
	Object.assign(marked.messages[3]!.content[0]!, { cache_control: long });
	expect(taskCacheFrontier(marked, blocks, messages).reason).toBe("already-marked");
	payload.system[1]!.cache_control = { type: "ephemeral", ttl: "5m" };
	expect(taskCacheFrontier(payload, blocks, messages).reason).toBe("unsupported-controls");
});

test("leaves a preceding sealed thought untouched and marks the earlier cacheable block", () => {
	const { payload, messages } = fixture();
	const thought = { type: "thinking", thinking: "Prior reasoning.", signature: "prior-seal" };
	payload.messages[3]!.content.splice(1, 0, thought);
	const prior = messages.find((message) => message.responseId === "carrier");
	if (!prior || !Array.isArray(prior.content)) throw new Error("Missing fixture carrier");
	prior.content.push({ type: "thinking", thinking: thought.thinking, thinkingSignature: thought.signature });
	const result = taskCacheFrontier(payload, linearize(messages).map(wireToBlock), messages);
	expect(result).toMatchObject({ reason: "applied", message: 3, block: 0 });
	expect(result.payload?.messages).toEqual(expect.arrayContaining([
		expect.objectContaining({ content: expect.arrayContaining([thought]) }),
	]));
	expect(withoutControls(result.payload)).toEqual(withoutControls(payload));
});

for (const form of ["redacted", "unsigned"]) test(`recognizes ${form} opening reasoning without editing it`, () => {
	const { payload, messages } = fixture();
	const opener = messages.find((message) => message.responseId === "child");
	if (!opener || !Array.isArray(opener.content)) throw new Error("Missing fixture opener");
	opener.content[0] = form === "redacted"
		? { type: "thinking", thinking: "[Reasoning redacted]", redacted: true, thinkingSignature: "opaque-data" }
		: { type: "thinking", thinking: "Plan the second child." };
	payload.messages[3]!.content[1] = form === "redacted"
		? { type: "redacted_thinking", data: "opaque-data" }
		: { type: "text", text: "Plan the second child." };
	const result = taskCacheFrontier(payload, linearize(messages).map(wireToBlock), messages);
	expect(result).toMatchObject({ reason: "applied", message: 3, block: 0 });
	expect(withoutControls(result.payload)).toEqual(withoutControls(payload));
});
