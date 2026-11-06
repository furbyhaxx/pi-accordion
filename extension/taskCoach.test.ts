import { describe, expect, test } from "bun:test";
import { emptySpanRefusal, idleVerdict, nextTask, TaskCoach, TEXT_WORK_CHARS } from "./taskCoach";
import type { Task, TaskList } from "./tasks";

const t = (id: string, status: Task["status"], title = `T${id}`): Task => ({ id, title, status, updatedAt: "" });
const list = (tasks: Task[]): TaskList => ({ slug: "w", title: "W", createdAt: "", updatedAt: "", claim: null, tasks });

describe("task coach", () => {
	test("reminds on the 3rd tool result outside any task, then every 8th, naming the next task", () => {
		const c = new TaskCoach();
		c.setList(list([t("1", "done"), t("2", "todo", "Wire it")]));
		const notes = Array.from({ length: 12 }, () => c.toolResult(false));
		expect(notes.map((n, i) => (n ? i + 1 : 0)).filter(Boolean)).toEqual([3, 11]);
		expect(notes[2]).toContain('next to do: 2 "Wire it"');
	});

	test("stays quiet inside a task, for nested calls, and when nothing is left to do", () => {
		const c = new TaskCoach();
		c.setList(list([t("1", "doing")]));
		expect([1, 2, 3, 4].map(() => c.toolResult(false))).toEqual([null, null, null, null]);
		c.setList(list([t("1", "todo")]));
		expect([1, 2, 3].map(() => c.toolResult(true))).toEqual([null, null, null]);
		c.setList(list([t("1", "done")]));
		expect([1, 2, 3].map(() => c.toolResult(false))).toEqual([null, null, null]);
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

	test("suggests resuming a task whose dependency finished, and skips work under a user wait", () => {
		const at = "2026-11-05T10:00:00.000Z";
		const t = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, title: id, status, updatedAt: at, ...extra });
		const l = (tasks: Task[]): TaskList => ({ slug: "w", title: "W", createdAt: at, updatedAt: at, claim: null, tasks });
		const dep = { reason: "dependency" as const, detail: "needs 2", on: "2", at };
		const ask = { reason: "user-decision" as const, detail: "db?", at };
		expect(nextTask(l([t("1", "blocked", { blocks: [dep] }), t("2", "doing"), t("3", "todo")]))?.task.id).toBe("3");
		expect(nextTask(l([t("1", "blocked", { blocks: [dep] }), t("2", "done"), t("3", "todo")]))).toMatchObject({ task: { id: "1" }, resume: true });
		expect(nextTask(l([t("1", "blocked", { blocks: [ask] }), t("1.1", "todo"), t("2", "todo")]))?.task.id).toBe("2");
		expect(idleVerdict(l([t("1", "blocked", { blocks: [ask] }), t("2", "done")]))).toEqual({ state: "waiting", tasks: [{ id: "1", reason: "user-decision" }] });
		expect(idleVerdict(l([t("1", "doing"), t("1.1", "doing")]))).toEqual({ state: "in-progress", task: "1.1" });
		expect(idleVerdict(l([t("1", "blocked", { blocks: [ask] }), t("2", "todo")]))).toEqual({ state: "pending", next: "2" });
		expect(idleVerdict(l([t("1", "done"), t("2", "abandoned")]))).toEqual({ state: "finished" });
	});
});
