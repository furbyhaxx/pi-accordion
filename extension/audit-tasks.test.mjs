import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditSession } from "./audit-tasks.mjs";

function taskSession(calls) {
	return calls.flatMap((args, i) => [
		{ type: "message", id: `a${i}`, parentId: i ? `r${i - 1}` : null, message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "tasks", arguments: args }] } },
		{ type: "message", id: `r${i}`, parentId: `a${i}`, message: { role: "toolResult", toolCallId: `t${i}`, toolName: "tasks" } },
	]);
}

test("unpaired usage and diagnostics never become passing budget observations", () => {
	const session = [{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [], usage: { input: 999999 } } }];
	const result = auditSession(session, [{ type: "request", realInput: 999999 }]);
	assert.equal(result.tokens.unknownRequests, 1);
	assert.equal(result.tokens.trustedRequests, 0);
	assert.equal(result.tokens.requestsOverBudget, null);
	assert.equal(result.tokens.leafTokensPerBudgetP90, null);
	assert.equal(result.tokens.diagnosticRequests, 1);
});

test("counts a branch's task events, blocked intervals and nested calls without disclosing content", () => {
	const entries = [{ type: "session", id: "s" }];
	let previous = null;
	const add = (entry) => {
		const id = `e${entries.length}`;
		entries.push({ ...entry, id, parentId: previous });
		previous = id;
	};
	const message = (value) => add({ type: "message", message: value });
	const direct = (id, action, failed = false) => {
		message({ role: "assistant", content: [{ type: "toolCall", id, name: "tasks", arguments: { action, list: "private-list", id: "1" } }] });
		message({ role: "toolResult", toolCallId: id, toolName: "tasks", isError: failed, content: "private content" });
	};
	message({ role: "user", content: "private request" });
	add({ type: "custom", customType: "accordion.tasks.binding", data: { slug: "private-list" } });
	direct("start", "start");
	message({ role: "assistant", content: [{ type: "toolCall", id: "batch", name: "codemode" }] });
	message({ role: "toolResult", toolCallId: "batch", toolName: "codemode", nestedCalls: { complete: true, calls: [{ name: "read", status: "ok" }, { name: "bash", status: "ok" }] } });
	direct("block", "block");
	message({ role: "assistant", content: [{ type: "toolCall", id: "read", name: "read" }] });
	message({ role: "toolResult", toolCallId: "read", toolName: "read" });
	direct("resume", "start");
	direct("bad", "start", true);
	add({ type: "custom", customType: "accordion.tasks.idle", data: { state: "in-progress" } });
	const result = auditSession(entries);
	assert.equal(result.taskCalls, 4);
	assert.equal(result.rejected, 1);
	assert.equal(result.blocks, 1);
	assert.equal(result.resumes, 1);
	assert.equal(result.workResults, 3);
	assert.equal(result.trackedResults, 2);
	assert.equal(result.prematureStops, 1);
	assert.equal(result.callsBeforeFirstStart, 0);
	assert(!JSON.stringify(result).includes("private"));
});

test("ignores abandoned branches and reports mixed lifecycle batches as ambiguous", () => {
	const entries = [
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: "request" } },
		{ type: "message", id: "old", parentId: "u", message: { role: "user", content: "abandoned" } },
		{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", id: "batch", name: "codemode" }] } },
		{ type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "batch", toolName: "codemode", nestedCalls: { complete: true, calls: [
			{ name: "tasks", status: "ok", arguments: { action: "start", list: "l", id: "1" } },
			{ name: "read", status: "ok" },
		] } } },
	];
	const result = auditSession(entries);
	assert.equal(result.prompts, 1);
	assert.equal(result.taskCalls, 1);
	assert.equal(result.uncertainResults, 1);
	assert.equal(result.trackedFraction, null);
});

test("missing nested or lifecycle evidence cannot produce a success rate", () => {
	const session = [
		{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode" }] } },
		{ type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "c", toolName: "codemode" } },
		{ type: "message", id: "c", parentId: "b", message: { role: "toolResult", toolCallId: "missing", toolName: "tasks" } },
	];
	const result = auditSession(session);
	assert.equal(result.incompleteNested, 1);
	assert.equal(result.incompleteTasks, 1);
	assert.equal(result.rejectionsPer100, null);
	assert.equal(result.trackedFraction, null);
	assert.equal(result.callsBeforeFirstStart, null);
});

test("concurrent start and work cannot be attributed from result order", () => {
	const session = [
		{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [
			{ type: "toolCall", id: "t", name: "tasks", arguments: { action: "start", list: "l", id: "1" } },
			{ type: "toolCall", id: "r", name: "read" },
		] } },
		{ type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "t", toolName: "tasks" } },
		{ type: "message", id: "c", parentId: "b", message: { role: "toolResult", toolCallId: "r", toolName: "read" } },
	];
	const result = auditSession(session);
	assert.equal(result.uncertainResults, 1);
	assert.equal(result.trackedFraction, null);
	assert.equal(result.callsBeforeFirstStart, null);
});

test("preserves recorded nested lifecycle events when call metadata was dropped", () => {
	const session = [
		{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode" }] } },
		{ type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "c", toolName: "codemode", details: { taskEvents: [{ action: "start", list: "l", id: "1" }] } } },
	];
	const result = auditSession(session);
	assert.equal(result.taskCalls, 1);
	assert.equal(result.incompleteNested, 1);
	assert.equal(result.rejectionsPer100, null);
	assert.equal(result.callsBeforeFirstStart, null);
});

test("detects a start before the first unfinished leaf in a fully observed list", () => {
	const calls = [
		{ action: "create", list: "l", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] },
		{ action: "start", list: "l", id: "1.2" },
		{ action: "complete", list: "l", id: "1.2" },
		{ action: "start", list: "l", id: "1.1" },
	];
	const result = auditSession(taskSession(calls));
	assert.equal(result.orderEvaluatedStarts, 2);
	assert.equal(result.orderViolationsObserved, 1);
	assert.equal(result.outOfOrderStarts, 1);
});

test("distinguishes explicit replacements from ordinary list edits", () => {
	const calls = [
		{ action: "add", list: "l", tasks: [{ title: "new" }] },
		{ action: "add", list: "l", tasks: [{ title: "replacement", supersedes: "1" }] },
		{ action: "abandon", list: "l", id: "2", supersededBy: "3" },
	];
	const result = auditSession(taskSession(calls));
	assert.equal(result.planChanges, 3);
	assert.equal(result.explicitRepairActions, 2);
	assert.equal(result.planRepairs, null);
});

test("leaves order unknown after a list edit whose renumbering is not observed", () => {
	const result = auditSession(taskSession([
		{ action: "create", list: "l", tasks: [{ title: "A" }] },
		{ action: "add", list: "l", before: "1", tasks: [{ title: "B" }] },
		{ action: "start", list: "l", id: "1" },
	]));
	assert.equal(result.orderUnknownStarts, 1);
	assert.equal(result.outOfOrderStarts, null);
});

test("accepts sequential leaf starts in a fully reconstructed list", () => {
	const result = auditSession(taskSession([
		{ action: "create", list: "l", tasks: [{ title: "A" }, { title: "B" }] },
		{ action: "start", list: "l", id: "1" },
		{ action: "complete", list: "l", id: "1" },
		{ action: "start", list: "l", id: "2" },
	]));
	assert.equal(result.orderEvaluatedStarts, 2);
	assert.equal(result.outOfOrderStarts, 0);
});

test("does not infer lifecycle order from multiple nested call records", () => {
	const session = taskSession([{ action: "create", list: "l", tasks: [{ title: "A" }, { title: "B" }] }]);
	session.push({ type: "message", id: "a", parentId: "r0", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode" }] } });
	session.push({ type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "c", toolName: "codemode", nestedCalls: { complete: true, calls: [
		{ name: "tasks", status: "ok", arguments: { action: "start", list: "l", id: "1" } },
		{ name: "tasks", status: "ok", arguments: { action: "complete", list: "l", id: "1" } },
	] } } });
	const result = auditSession(session);
	assert.equal(result.orderUnknownStarts, 1);
	assert.equal(result.outOfOrderStarts, null);
});

test("fresh sessions have no active task until a binding, while inherited state remains unknown", () => {
	const calls = [
		{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read" }] } },
		{ type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "r", toolName: "read" } },
	];
	const fresh = auditSession([{ type: "session", id: "s" }, ...calls]);
	assert.equal(fresh.workResults, 1);
	assert.equal(fresh.uncertainResults, 0);
	assert.equal(fresh.trackedFraction, 0);
	const inherited = auditSession([{ type: "session", id: "s", parentSession: "prior" }, ...calls]);
	assert.equal(inherited.uncertainResults, 1);
	assert.equal(inherited.trackedFraction, null);
});
