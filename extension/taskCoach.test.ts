import { describe, expect, test } from "bun:test";
import { TaskCoach } from "./taskCoach";
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
});
