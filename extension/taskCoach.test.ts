import { describe, expect, test } from "bun:test";
import { emptySpanRefusal, idleVerdict, nextTask, TaskCoach, TEXT_WORK_CHARS } from "./taskCoach";
import type { Task, TaskList } from "./tasks";

const t = (id: string, status: Task["status"], title = `T${id}`): Task => ({ id, title, status, updatedAt: "" });
const list = (tasks: Task[]): TaskList => ({ slug: "w", title: "W", createdAt: "", updatedAt: "", claim: null, tasks });

describe("task coach", () => {
	test("reminds once after the orientation allowance, naming the next task", () => {
		const c = new TaskCoach();
		c.setList(list([t("1", "done"), t("2", "todo", "Wire it")]));
		const notes = Array.from({ length: 20 }, () => { c.callStarted(false); return c.toolResult(false); });
		expect(notes.map((n, i) => (n ? i + 1 : 0)).filter(Boolean)).toEqual([11]);
		expect(notes[10]).toContain('next to do: 2 "Wire it"');
	});

	test("a new user prompt restores the allowance and the reminder", () => {
		const c = new TaskCoach();
		c.setList(list([t("1", "todo", "Wire it")]));
		c.setPolicy({ orientationCalls: 2, enforce: "coach", gateFailOpenAfter: 3 });
		const call = () => { c.callStarted(false); return c.toolResult(false); };
		expect([1, 2, 3].map(call).filter(Boolean)).toHaveLength(1);
		c.userPrompt();
		expect([1, 2, 3].map(call).filter(Boolean)).toHaveLength(1);
	});

	test("reminds once about work that belongs to no list at all", () => {
		const c = new TaskCoach();
		c.setPolicy({ orientationCalls: 1, enforce: "coach", gateFailOpenAfter: 3 });
		const call = () => { c.callStarted(false); return c.toolResult(false); };
		expect(call()).toBeNull();
		expect(call()).toContain("no task list attached");
		expect(call()).toBeNull();
		c.userPrompt();
		expect(call()).toBeNull();
		expect(call()).toContain("no task list attached");
	});

	test("stays quiet inside a task, for nested calls, and when nothing is left to do", () => {
		const c = new TaskCoach();
		const call = (nested = false) => { c.callStarted(nested); return c.toolResult(nested); };
		c.setList(list([t("1", "doing")]));
		expect([1, 2, 3, 4].map(() => call())).toEqual([null, null, null, null]);
		c.setList(list([t("1", "todo")]));
		expect([1, 2, 3].map(() => call(true))).toEqual([null, null, null]);
		c.setList(list([t("1", "done")]));
		expect([1, 2, 3].map(() => call())).toEqual([null, null, null]);
	});

	test("counts span work for the task and its ancestors, including long assistant text", () => {
		const c = new TaskCoach();
		c.started("w", ["1", "1.1"]);
		c.setList(list([t("1", "doing"), t("1.1", "doing")]));
		c.toolResult(false);
		expect([c.spanWork("w", "1.1"), c.spanWork("w", "1")]).toEqual([1, 1]);
		c.finished("w", "1.1");
		c.started("w", ["1.2"]);
		c.setList(list([t("1", "doing"), t("1.1", "done"), t("1.2", "doing")]));
		c.assistantText(TEXT_WORK_CHARS);
		expect(c.spanWork("w", "1.2")).toBe(0);
		c.assistantText(TEXT_WORK_CHARS + 1);
		expect([c.spanWork("w", "1.2"), c.spanWork("w", "1")]).toEqual([1, 2]);
		expect(c.spanWork("w", "9")).toBeUndefined();
	});

	test("counts work that reports before its batched start call, and keeps a resumed task's work", () => {
		const c = new TaskCoach();
		c.setList(list([t("1", "doing")]));
		c.toolResult(false);
		c.started("w", ["1"]);
		expect(c.spanWork("w", "1")).toBe(1);
		c.started("w", ["1"]);
		expect(c.spanWork("w", "1")).toBe(1);
	});

	test("the empty-span refusal offers block before replying and abandon onto the previous task", () => {
		const text = emptySpanRefusal("w", "5", "4");
		expect(text).toContain("Nothing ran inside 5 since tasks start.");
		expect(text).toContain('block 5 {reason: "user-decision"');
		expect(text).toContain('abandon 5 {supersededBy: "4"}');
		expect(emptySpanRefusal("w", "1", null)).toContain("abandon 1 with a report");
	});

	test("suggests resuming a task whose dependency finished, and freezes the run behind a user wait", () => {
		const at = "2026-11-05T10:00:00.000Z";
		const t = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, title: id, status, updatedAt: at, ...extra });
		const l = (tasks: Task[]): TaskList => ({ slug: "w", title: "W", createdAt: at, updatedAt: at, claim: null, tasks });
		const dep = { reason: "dependency" as const, detail: "needs 2", on: "2", at };
		const ask = { reason: "user-decision" as const, detail: "db?", at };
		expect(nextTask(l([t("1", "blocked", { blocks: [dep] }), t("2", "doing"), t("3", "todo")]))?.task.id).toBe("3");
		expect(nextTask(l([t("1", "blocked", { blocks: [dep] }), t("2", "done"), t("3", "todo")]))).toMatchObject({ task: { id: "1" }, resume: true });
		expect(nextTask(l([t("1", "blocked", { blocks: [ask] }), t("1.1", "todo"), t("2", "todo")]))).toBeNull();
		expect(nextTask(l([t("1", "blocked", { blocks: [ask] }), t("2", "todo")]), false)?.task.id).toBe("2");
		expect(idleVerdict(l([t("1", "blocked", { blocks: [ask] }), t("2", "done")]))).toEqual({ state: "waiting", tasks: [{ id: "1", reason: "user-decision" }] });
		expect(idleVerdict(l([t("1", "doing"), t("1.1", "doing")]))).toEqual({ state: "in-progress", task: "1.1" });
		expect(idleVerdict(l([t("1", "blocked", { blocks: [ask] }), t("2", "todo")]))).toEqual({ state: "waiting", tasks: [{ id: "1", reason: "user-decision" }] });
		expect(idleVerdict(l([t("1", "blocked", { blocks: [ask] }), t("2", "todo")]), false)).toEqual({ state: "pending", next: "2" });
		expect(idleVerdict(l([t("1", "done"), t("2", "abandoned")]))).toEqual({ state: "finished" });
	});
});

describe("gate", () => {
	const gate = () => {
		const c = new TaskCoach();
		c.setPolicy({ orientationCalls: 1, enforce: "gate", gateFailOpenAfter: 3 });
		return c;
	};

	test("refuses with the exact repair once the allowance is spent", () => {
		const c = gate();
		c.setList(list([t("1", "todo", "Wire it")]));
		expect(c.callStarted(false)).toEqual({});
		const first = c.callStarted(false);
		expect(first.refuse).toContain('tasks start {list: "w", id: "1"}');
		expect(first.opened).toBeUndefined();
	});

	test("names a create when no list is attached", () => {
		const c = gate();
		c.callStarted(false);
		expect(c.callStarted(false).refuse).toContain("tasks create");
	});

	test("counts nested calls but only refuses the outer one", () => {
		const c = gate();
		expect(c.callStarted(true)).toEqual({});
		expect(c.callStarted(false).refuse).toBeDefined();
	});

	test("opens for the rest of the run after repeated refusals, and a prompt closes it", () => {
		const c = gate();
		c.callStarted(false);
		for (let i = 0; i < 3; i++) expect(c.callStarted(false).refuse).toBeDefined();
		expect(c.callStarted(false)).toEqual({ opened: true });
		expect(c.callStarted(false).refuse).toBeUndefined();
		c.userPrompt();
		c.callStarted(false);
		expect(c.callStarted(false).refuse).toBeDefined();
	});

	test("stays silent inside a task and in coach or off mode", () => {
		const inside = gate();
		inside.setList(list([t("1", "doing")]));
		inside.callStarted(false);
		expect(inside.callStarted(false)).toEqual({});
		for (const enforce of ["coach", "off"] as const) {
			const c = new TaskCoach();
			c.setPolicy({ orientationCalls: 0, enforce, gateFailOpenAfter: 3 });
			expect(c.callStarted(false)).toEqual({});
		}
	});
});

describe("large leaf", () => {
	const setup = () => {
		const c = new TaskCoach();
		c.setPolicy({ orientationCalls: 0, enforce: "coach", gateFailOpenAfter: 3, stopOnBlock: true, largeLeaf: { budgetShare: 0.5, toolResults: 3, repeatEvery: 2 }, budget: 1000 });
		c.started("w", ["1"]);
		c.setList(list([t("1", "doing", "Big")]));
		return c;
	};

	test("taps once the result count is reached, then only after the repeat interval", () => {
		const c = setup();
		const notes = Array.from({ length: 6 }, () => { c.callStarted(false); return c.toolResult(false, 0); });
		expect(notes[2]).toContain('Task 1 "Big"');
		expect(notes.slice(0, 2)).toEqual([null, null]);
		expect(notes[4]).toContain("It is still open");
		expect(notes.slice(3, 4)).toEqual([null]);
		expect(notes[5]).toBeNull();
	});

	test("taps on the budget share of accumulated content, not only on result count", () => {
		const c = setup();
		c.callStarted(false);
		expect(c.toolResult(false, 100)).toBeNull();
		c.callStarted(false);
		// 2,400 characters is 600 tokens: past half of the 1,000-token budget.
		expect(c.toolResult(false, 2400)).toContain("625 tokens");
	});

	test("stays quiet for a leaf with no ceiling, and inside a nested call's own result", () => {
		const c = new TaskCoach();
		c.setPolicy({ orientationCalls: 0, enforce: "coach", gateFailOpenAfter: 3, stopOnBlock: true, largeLeaf: { budgetShare: 0.5, toolResults: 2, repeatEvery: 1 }, budget: null });
		c.started("w", ["1"]);
		c.setList(list([t("1", "doing", "Big")]));
		const notes = Array.from({ length: 4 }, () => { c.callStarted(false); return c.toolResult(false, 0); });
		expect(notes[1]).toContain("tool results");
		expect(notes[1]).not.toContain("configured share");
	});
});

describe("floor tap", () => {
	test("names the current leaf only when a pressure fold touched its span", () => {
		const c = new TaskCoach();
		c.setPolicy({ orientationCalls: 0, enforce: "coach", gateFailOpenAfter: 3, stopOnBlock: true, largeLeaf: { budgetShare: 1, toolResults: 99, repeatEvery: 10 }, budget: null });
		c.started("w", ["1"]);
		c.setList(list([t("1", "doing", "Big")]));
		c.floorTap(["w/2", "w/1.1"]);
		c.callStarted(false);
		expect(c.toolResult(false, 0)).toContain('folded part of the span of 1 "Big" of "w"');
		c.callStarted(false);
		expect(c.toolResult(false, 0)).toBeNull();
		c.floorTap(["other/1"]);
		c.callStarted(false);
		expect(c.toolResult(false, 0)).toBeNull();
	});
});
