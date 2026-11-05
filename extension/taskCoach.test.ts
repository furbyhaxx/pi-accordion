import { describe, expect, test } from "bun:test";
import { idleVerdict, nextTask, TaskCoach } from "./taskCoach";
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

	test("flags a finished task whose span saw no work, counting work for its ancestors too", () => {
		const c = new TaskCoach();
		c.started("w", ["1", "1.1"]);
		c.setList(list([t("1", "doing"), t("1.1", "doing")]));
		c.toolResult(false);
		expect(c.finished("w", "1.1")).toBeNull();
		c.started("w", ["1.2"]);
		c.setList(list([t("1", "doing"), t("1.1", "done"), t("1.2", "doing")]));
		expect(c.finished("w", "1.2")).toContain("no tool work ran between starting and finishing 1.2");
		expect(c.finished("w", "1")).toBeNull();
		expect(c.finished("w", "9")).toBeNull();
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
