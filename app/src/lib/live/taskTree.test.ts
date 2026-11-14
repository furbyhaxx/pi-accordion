import { describe, it, expect } from "vitest";
import type { WireTask } from "$core/protocol";
import { buildTaskRows, formatProgress, glyphTone, summarizeTasks, TASK_GLYPH, type TaskTreeRow } from "./taskTree";

const t = (id: string, status: string): WireTask => ({ id, title: `Task ${id}`, status });

/** `depth id` per row, `… N` for a finished run, so a tree reads as a flat list in assertions. */
const shape = (rows: TaskTreeRow[]) => rows.map((r) => (r.kind === "task" ? `${r.depth} ${r.id}` : `${r.depth} …${r.count}${r.open ? " open" : ""}`));

describe("buildTaskRows", () => {
	it("indents subtasks by depth and starts a missing parent's children at the root", () => {
		const rows = buildTaskRows([t("1", "doing"), t("1.1", "todo"), t("1.1.1", "todo"), t("2", "todo"), t("5.1", "todo")]);
		expect(shape(rows)).toEqual(["0 1", "1 1.1", "2 1.1.1", "0 2", "0 5.1"]);
	});

	it("derives the glyph state: partial once a subtask is done, active before", () => {
		const active = buildTaskRows([t("1", "doing"), t("1.1", "todo")])[0]!;
		const partial = buildTaskRows([t("1", "doing"), t("1.1", "done"), t("1.2", "todo")])[0]!;
		expect(active.kind === "task" && active.state).toBe("active");
		expect(partial.kind === "task" && partial.state).toBe("partial");
		expect(glyphTone("done")).toBe("success");
		expect(glyphTone("failed")).toBe("error");
		expect(TASK_GLYPH.blocked).toBe("⧗");
	});

	it("collapses a run of finished siblings into one row and expands it on reveal", () => {
		const tasks = [t("1", "done"), t("2", "failed"), t("3", "abandoned"), t("4", "doing"), t("5", "todo")];
		expect(shape(buildTaskRows(tasks))).toEqual(["0 …3", "0 4", "0 5"]);
		expect(shape(buildTaskRows(tasks, { revealed: new Set(["1"]) }))).toEqual(["0 …3 open", "0 1", "0 2", "0 3", "0 4", "0 5"]);
	});

	it("sums the folded tasks of a collapsed run, subtasks included", () => {
		const rows = buildTaskRows([t("1", "done"), t("2", "done"), t("2.1", "done"), t("3", "doing")], {
			folded: new Set(["1", "2.1"]),
			foldTokens: { "1": { full: 100, live: 10 }, "2.1": { full: 50, live: 5 } },
		});
		expect(rows[0]).toMatchObject({ kind: "finished", count: 2, folded: 2, tokens: { full: 150, live: 15 } });
	});

	it("shows a run of one as the task itself and splits runs at an unfinished sibling", () => {
		expect(shape(buildTaskRows([t("1", "done"), t("2", "doing")]))).toEqual(["0 1", "0 2"]);
		expect(shape(buildTaskRows([t("1", "done"), t("2", "done"), t("3", "doing"), t("4", "done"), t("5", "done")]))).toEqual(["0 …2", "0 3", "0 …2"]);
	});

	it("collapses finished siblings on every level, indented with them", () => {
		const rows = buildTaskRows([t("1", "doing"), t("1.1", "done"), t("1.2", "done"), t("1.3", "todo")]);
		expect(shape(rows)).toEqual(["0 1", "1 …2", "1 1.3"]);
	});

	it("keeps a finished task with unfinished descendants visible and marks it", () => {
		const rows = buildTaskRows([t("1", "done"), t("1.1", "todo"), t("2", "done"), t("3", "done")]);
		expect(shape(rows)).toEqual(["0 1", "0 …2"]);
		expect(rows[0]!.kind === "task" && rows[0]!.mark).toBe("inconsistent");
	});

	it("closes a finished task's subtasks by default and lets a toggle override either default", () => {
		const tasks = [t("1", "done"), t("1.1", "done"), t("2", "doing"), t("2.1", "todo")];
		expect(shape(buildTaskRows(tasks))).toEqual(["0 1", "0 2", "1 2.1"]);
		expect(shape(buildTaskRows(tasks, { toggles: new Map([["1", true], ["2", false]]) }))).toEqual(["0 1", "1 1.1", "0 2"]);
		const closed = buildTaskRows(tasks, { toggles: new Map([["2", false]]) })[1]!;
		expect(closed.kind === "task" && closed.open).toBe(false);
		expect(closed.kind === "task" && closed.hasChildren).toBe(true);
	});

	it("marks folded tasks with their tokens, and counts folded descendants of a closed row", () => {
		const rows = buildTaskRows([t("1", "doing"), t("1.1", "done"), t("2", "doing"), t("2.1", "done"), t("3", "todo")], {
			folded: new Set(["1.1", "2.1"]),
			foldTokens: { "1.1": { full: 35_200, live: 400 } },
			toggles: new Map([["2", false]]),
		});
		const byId = new Map(rows.filter((r) => r.kind === "task").map((r) => [r.id, r]));
		expect(byId.get("1.1")).toMatchObject({ mark: "folded", tokens: { full: 35_200, live: 400 } });
		expect(byId.get("2")).toMatchObject({ open: false, foldedBelow: 1 });
		expect(byId.get("1")).toMatchObject({ foldedBelow: 0, mark: null });
		expect(byId.has("2.1")).toBe(false);
		expect(byId.get("3")).toMatchObject({ mark: null, tokens: null });
	});

	it("counts leaves for progress and formats them", () => {
		const row = buildTaskRows([t("1", "doing"), t("1.1", "done"), t("1.2", "failed"), t("1.3", "todo"), t("1.3.1", "todo"), t("1.4", "abandoned")])[0]!;
		expect(row.kind === "task" && row.progress).toEqual({ done: 1, failed: 1, abandoned: 1, pending: 1 });
		expect(formatProgress({ done: 3, failed: 0, abandoned: 0, pending: 2 })).toBe("3▣ 2☐");
	});
});

describe("summarizeTasks", () => {
	it("counts done tasks and only the folded ids that belong to the list", () => {
		expect(summarizeTasks([t("1", "done"), t("2", "doing"), t("3", "done")], ["1", "3", "9"])).toEqual({ done: 2, total: 3, folded: 2 });
		expect(summarizeTasks([], [])).toEqual({ done: 0, total: 0, folded: 0 });
	});
});
