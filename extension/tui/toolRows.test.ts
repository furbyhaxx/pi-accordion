import { describe, expect, test } from "bun:test";
import { foldToolRow, tasksRow, type TasksDetails } from "./toolRows";
import type { WidgetTheme } from "./taskWidget";

const plain: WidgetTheme = { fg: (_c, t) => t, bold: (t) => t };

describe("tool rows", () => {
	test("task actions carry the task title and time; list actions never do", () => {
		const task = { id: "3.2", title: "Watch config.json", status: "done" as const, startedAt: "2026-11-05T08:00:00Z", endedAt: "2026-11-05T08:01:12Z", report: { outcome: "Done." } };
		expect(tasksRow(plain, { action: "start", list: "p", id: "3.2" }, "ok", { action: "start", task: { ...task, status: "doing" } }, "", false)).toEqual(["✓ tasks start 3.2 Watch config.json"]);
		expect(tasksRow(plain, { action: "complete", list: "p", id: "3.2" }, "ok", { action: "complete", task }, "", false)[0]).toBe("✓ tasks complete 3.2 Watch config.json · 1m 12s");
		const status: TasksDetails = { action: "status", list: "p", task, progress: { done: 1, total: 9 } };
		expect(tasksRow(plain, { action: "status", list: "p", id: "3.2" }, "ok", status, "", false)).toEqual(["✓ tasks status p · 1/9 done"]);
		expect(tasksRow(plain, { action: "list" }, "ok", { action: "list", lists: 1 }, "", false)).toEqual(["✓ tasks list · 1 list"]);
	});

	test("a refused call shows the reason, and rows recorded before details still find the title", () => {
		expect(tasksRow(plain, { action: "start", list: "p", id: "2" }, "error", undefined, "Task 2 is done. Add a follow-up task instead.", false)).toEqual(["✗ tasks start 2 · Task 2 is done. Add a follow-up task instead."]);
		expect(tasksRow(plain, { action: "start", list: "p", id: "2" }, "ok", undefined, 'Started p/2 "Report".', false)).toEqual(["✓ tasks start 2 Report"]);
	});

	test("unfold and recall report what came back", () => {
		expect(foldToolRow(plain, "recall", { codes: ["3f9a2c", "000001"] }, "ok", { restored: [{}], missing: ["000001"] }, "", false)).toEqual(["▲ recall #3f9a2c #000001 · 1 recalled · 1 not found"]);
		expect(foldToolRow(plain, "unfold", { codes: ["3f9a2c"] }, "ok", { restored: [], missing: ["3f9a2c"] }, "", false)[0]).toStartWith("✗ unfold #3f9a2c");
	});
});
