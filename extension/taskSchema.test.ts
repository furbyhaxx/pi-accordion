import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCK_REASONS, CRITERIA_MAX, CRITERION_MAX, GOAL_MAX, LIST_KEYS, TASK_KEYS, TASK_STATUSES, TITLE_MAX, parseListFile, toListFile, type FlatList } from "./taskSchema";

const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "skills/accordion-task-lists/references/tasks.schema.json"), "utf8"));

const errorsOf = (raw: unknown, slug = "auth") => {
	const r = parseListFile(raw, slug);
	return r.ok ? [] : r.errors;
};

const v2 = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ version: 2, slug: "auth", title: "Auth", goal: "Tokens go through TokenStore.", tasks, ...extra });

describe("task list v2 schema", () => {
	test("the JSON schema states the same fields and limits as the validator", () => {
		const task = schema.$defs.task.properties;
		expect(Object.keys(schema.properties).sort()).toEqual([...LIST_KEYS, "tasks"].sort());
		expect(Object.keys(task).sort()).toEqual([...TASK_KEYS, "subtasks"].sort());
		expect(task.status.enum).toEqual([...TASK_STATUSES]);
		expect(task.blocks.items.properties.reason.enum).toEqual([...BLOCK_REASONS]);
		expect([task.title.maxLength, schema.properties.title.maxLength, schema.properties.goal.maxLength]).toEqual([TITLE_MAX, TITLE_MAX, GOAL_MAX]);
		expect([task.acceptanceCriteria.maxItems, task.acceptanceCriteria.items.maxLength]).toEqual([CRITERIA_MAX, CRITERION_MAX]);
	});

	test("a hand-written tree without ids or statuses loads flat with positional ids", () => {
		const r = parseListFile(v2([{ title: "Survey", acceptanceCriteria: ["every caller listed"] }, { title: "Extract", subtasks: [{ title: "Interface" }, { title: "Migrate" }] }]), "auth");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.list.tasks.map((t) => [t.id, t.status])).toEqual([
			["1", "todo"],
			["2", "todo"],
			["2.1", "todo"],
			["2.2", "todo"],
		]);
		expect(r.list.tasks[0].acceptanceCriteria).toEqual(["every caller listed"]);
	});

	test("every problem is reported with its location and fix", () => {
		const errors = errorsOf({
			version: 2,
			slug: "other",
			title: "Auth",
			tasks: [{ title: "A", id: "2", subtask: [] }, { title: "B", acceptanceCriteria: ["a", "b", "c", "d"] }, { title: "C", status: "done" }],
		});
		expect(errors.join("\n")).toMatch(/slug: "other" must equal the file name "auth"/);
		expect(errors.join("\n")).toMatch(/goal: required/);
		expect(errors.join("\n")).toMatch(/tasks\[0\]: id "2" does not match its position 1/);
		expect(errors.join("\n")).toMatch(/tasks\[0\]\.subtask: unknown field/);
		expect(errors.join("\n")).toMatch(/tasks\[1\]\.acceptanceCriteria: has 4 items/);
		expect(errors.join("\n")).toMatch(/tasks\[2\]: a done task needs a report/);
	});

	test("pin and attachment ids must be unique across the whole list", () => {
		const pin = { id: "p1", kind: "rule", text: "Use decimals", source: "user", at: "now" };
		const attachment = { id: "a1", path: "spec.md" };
		const errors = errorsOf(v2([{ title: "A", pins: [pin], attachments: [attachment] }], { pins: [pin], attachments: [attachment] }));
		expect(errors.join("\n")).toContain("duplicate pin id p1");
		expect(errors.join("\n")).toContain("duplicate attachment id a1");
	});

	test("depth beyond four levels and impossible status trees are rejected", () => {
		const deep = { title: "1", subtasks: [{ title: "2", subtasks: [{ title: "3", subtasks: [{ title: "4", subtasks: [{ title: "5" }] }] }] }] };
		expect(errorsOf(v2([deep])).join("\n")).toMatch(/deeper than 4 levels/);
		expect(errorsOf(v2([{ title: "P", subtasks: [{ title: "C", status: "doing" }] }])).join("\n")).toMatch(/task 1.1 is doing but its parent 1 is todo/);
	});

	test("a v1 file migrates and writes back as the same tree", () => {
		const v1 = {
			slug: "auth",
			title: "Auth",
			createdAt: "t",
			updatedAt: "t",
			claim: null,
			tasks: [
				{ id: "1", title: "A", status: "done", report: { outcome: "ok" }, updatedAt: "t" },
				{ id: "1.1", title: "A1", status: "done", report: { outcome: "ok" }, updatedAt: "t" },
				{ id: "2", title: "B", status: "todo", updatedAt: "t" },
			],
		};
		const r = parseListFile(v1, "auth");
		expect(r.ok && r.migrated).toBe(true);
		if (!r.ok) return;
		expect(r.list.goal).toBeUndefined();
		const file = toListFile({ ...r.list, goal: "G" } as FlatList);
		expect((file.tasks as { subtasks?: { id: string }[] }[])[0].subtasks?.map((t) => t.id)).toEqual(["1.1"]);
		const again = parseListFile(JSON.parse(JSON.stringify(file)), "auth");
		expect(again.ok && again.list.tasks.map((t) => t.id)).toEqual(["1", "1.1", "2"]);
		expect(again.ok && again.list.tasks[2]).toEqual({ id: "2", title: "B", status: "todo", updatedAt: "t" });
	});
});
