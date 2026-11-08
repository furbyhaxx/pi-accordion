import { describe, expect, it } from "bun:test";
import { scanTaskSpans } from "../conductors/in-process/taskfold/taskfold";
import { linearize, wireToBlock, type PiMessage } from "../core/wire";
import { ADOPTED_ENTRY, adoptionOf, applyAdoption, deriveAdoption, needsAdoption, type AdoptionTask } from "./taskAdoption";

let ts = 1000;
const user = (text: string): PiMessage => ({ role: "user", content: text, timestamp: ts++ });
function direct(id: string, args: Record<string, unknown>, text: string, details?: unknown): PiMessage[] {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "tasks", arguments: args }] as never, timestamp: ts++, responseId: `r-${id}` },
		{ role: "toolResult", toolCallId: id, toolName: "tasks", content: [{ type: "text", text }], details, timestamp: ts++ },
	];
}
function codemode(id: string, calls: Record<string, unknown>[], extra: { name: string; arguments: unknown }[] = []): PiMessage[] {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "codemode", arguments: { code: "…" } }] as never, timestamp: ts++, responseId: `r-${id}` },
		{ role: "toolResult", toolCallId: id, toolName: "codemode", content: [{ type: "text", text: "ok" }], timestamp: ts++,
			details: { calls: [] }, nestedCalls: { calls: [...calls.map((a, n) => ({ id: `${id}/${n + 1}`, name: "tasks", status: "ok", arguments: a })), ...extra.map((e) => ({ ...e, status: "ok" }))], complete: true } } as PiMessage,
	];
}
function bash(id: string, out: string): PiMessage[] {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "x" } }] as never, timestamp: ts++, responseId: `r-${id}` },
		{ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: out }], timestamp: ts++ },
	];
}
const spans = (messages: PiMessage[]) => scanTaskSpans(linearize(messages).map(wireToBlock), (b) => b.text).map((s) => [s.key, s.status, s.title] as const);

const tasks: AdoptionTask[] = [
	{ id: "1", title: "Parent", status: "done", report: { outcome: "All children done." } },
	{ id: "1.1", title: "First", status: "done" },
	{ id: "1.2", title: "Second", status: "done" },
	{ id: "2", title: "Forgotten", status: "done", endedAt: new Date(5_000_000).toISOString() },
];

function legacy(): PiMessage[] {
	ts = 1000;
	return [
		user("Go."),
		...direct("d1", { action: "start", list: "w", id: "1.1" }, `Started w/1.1 "First".\nAlso started parent 1 "Parent" so its span covers this subtask.`),
		...bash("b1", "work"),
		...codemode("m1", [{ action: "complete", list: "w", id: "1.1", report: { outcome: "First done." } }, { action: "start", list: "w", id: "1.2" }], [{ name: "bash", arguments: {} }]),
		...bash("b2", "work"),
		...codemode("m2", [{ action: "complete", list: "w", id: "1.2", report: { outcome: "Second done." } }, { action: "complete", list: "w", id: "1", report: { outcome: "All children done." } }, { action: "start", list: "w", id: "2" }]),
		...bash("b3", "work"),
	];
}

describe("legacy adoption", () => {
	it("derives the spans a native session would have from nested calls", () => {
		const messages = legacy();
		expect(spans(messages).filter((s) => s[1] !== null)).toEqual([]);
		const adoption = deriveAdoption(messages, new Map([["w", tasks.map((t) => (t.id === "2" ? { ...t, status: "doing" } : t))]]));
		expect(adoption.stats.nested).toBe(5);
		expect(adoption.stats.reconciled).toBe(0);
		const adopted = spans(applyAdoption(messages, adoption));
		expect(adopted).toEqual([
			["w/1.1", "done", "First"],
			["w/1.2", "done", "Second"],
			["w/1", "done", "Parent"],
			["w/2", null, "Forgotten"],
		]);
	});

	it("closes a span the list finished outside the session at the first result after its end", () => {
		const messages = [...legacy(), ...bash("b4", "later")];
		messages[messages.length - 1].timestamp = 6_000_000;
		const adoption = deriveAdoption(messages, new Map([["w", tasks]]));
		expect(adoption.stats.reconciled).toBe(1);
		expect(adoption.events.b4?.map((e) => [e.action, e.id])).toEqual([["complete", "2"]]);
		expect(spans(applyAdoption(messages, adoption)).find((s) => s[0] === "w/2")?.[1]).toBe("done");
	});

	it("is idempotent and detected only when needed", () => {
		const messages = legacy();
		const lists = new Map([["w", tasks]]);
		const a = deriveAdoption(messages, lists);
		expect(deriveAdoption(messages, lists)).toEqual(a);
		expect(needsAdoption(messages, null)).toBe(true);
		expect(needsAdoption(messages, a)).toBe(false);
		expect(needsAdoption([...messages, ...bash("b9", "x")], a)).toBe(true);
		expect(adoptionOf([{ type: "custom", customType: ADOPTED_ENTRY, data: a }])).toEqual(a);
		const applied = applyAdoption(messages, a);
		expect(applyAdoption(applied, a)).toEqual(applied);
		expect(needsAdoption(applied, null)).toBe(false);
	});
});
