import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Task, TaskList } from "../tasks";
import { buildTaskTree, layoutTaskTree, summarizeTasks, type TaskRow } from "./taskTree";
import { TaskWidgetController, applyTaskWidgetHit, formatDuration, pickTaskList, renderTaskWidget, type TaskWidgetView, type WidgetTheme } from "./taskWidget";

const T0 = Date.parse("2026-11-05T08:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function task(id: string, status: Task["status"], title = `task ${id}`, start?: number, end?: number): Task {
	return { id, title, status, updatedAt: at(0), ...(start === undefined ? {} : { startedAt: at(start) }), ...(end === undefined ? {} : { endedAt: at(end) }) };
}

/** The sketch: 0–2 done, 3 in progress with 3.4.1 running, 3.5–3.7 failed, 4–6 not started. */
function secrets(): Task[] {
	return [
		task("0", "done", "Orientation", 0, 72),
		task("1", "done", "Re-run benchmark", 72, 144),
		task("2", "done", "Redaction hook cost", 144, 216),
		task("3", "doing", "Secrets Redesign", 216),
		task("3.1", "done", "keys", 216, 250),
		task("3.2", "done", "vault table", 250, 280),
		task("3.3", "done", "Secrets.toml v2", 280, 300),
		task("3.4", "doing", "registry rewire to vault", 300),
		task("3.4.1", "doing", "the new registry", 310),
		task("3.4.2", "todo", "vault adapter"),
		task("3.4.3", "todo", "MemoryVault"),
		task("3.5", "failed", "prompt section"),
		task("3.6", "failed", "v1 import"),
		task("3.7", "abandoned", "scoped registry API"),
		task("4", "todo", "Scheme router"),
		task("4.1", "todo", "core"),
		task("4.2", "todo", "secrets handler"),
		task("4.3", "todo", "ask_user kind"),
		task("5", "todo", "benchmark"),
		task("6", "todo", "redaction"),
	];
}

const NOW = T0 + 381_000;
const folded = new Set(["0", "1", "3.1", "3.2"]);
const plain: WidgetTheme = { fg: (_c, t) => t, bold: (t) => t };
const list = (tasks: Task[]): TaskList => ({ slug: "secrets", title: "Secrets", createdAt: at(0), updatedAt: at(0), claim: { session: "s1", at: at(0) }, tasks });
const view = (over: Partial<TaskWidgetView> = {}): TaskWidgetView => ({ expanded: false, maxRows: 12, toggles: new Map(), revealed: new Set(), ...over });

const shape = (rows: TaskRow[]) => rows.map((r) => (r.kind === "hidden" ? `${r.prefix}…${r.count}` : `${r.prefix}${r.node.task.id}`));

describe("task tree", () => {
	test("summarizes progress, folds, the running task and outermost working time", () => {
		const sum = summarizeTasks(buildTaskTree(secrets()), folded, NOW);
		expect([sum.done, sum.total, sum.folded]).toEqual([6, 20, 4]);
		expect(sum.current?.task.id).toBe("3.4.1");
		expect(sum.durationMs).toBe(381_000);
	});

	test("lists everything when it fits, closing finished tasks' subtasks", () => {
		const rows = layoutTaskTree(buildTaskTree(secrets()), { maxRows: 50, now: NOW, folded });
		expect(rows).toHaveLength(20);
		expect(rows.every((r) => r.kind === "task")).toBe(true);
	});

	test("hides siblings furthest from the running task and keeps its path when over budget", () => {
		const rows = layoutTaskTree(buildTaskTree(secrets()), { maxRows: 9, now: NOW, folded });
		// A run of one is shown as the task itself: it takes the row its `… 1 hidden` would.
		expect(shape(rows)).toEqual(["├─…3", "├─3", "│ ├─…3", "│ ├─3.4", "│ │ ├─3.4.1", "│ │ ├─3.4.2", "│ │ └─3.4.3", "│ └─…3", "└─…6"]);
		const first = rows[0] as Extract<TaskRow, { kind: "hidden" }>;
		expect([first.folded, first.durationMs]).toEqual([2, 216_000]);
	});

	test("keeps the path to the running task even below the budget", () => {
		const rows = layoutTaskTree(buildTaskTree(secrets()), { maxRows: 1, now: NOW, folded });
		expect(rows.filter((r) => r.kind === "task").map((r) => (r.kind === "task" ? r.node.task.id : ""))).toEqual(["3", "3.4", "3.4.1"]);
	});

	test("honours a revealed hidden run and a closed branch", () => {
		const roots = buildTaskTree(secrets());
		const rows = layoutTaskTree(roots, { maxRows: 9, now: NOW, folded, revealed: new Set(["4", "5", "6"]), toggles: new Map([["3.4", false]]) });
		expect(shape(rows)).toContain("├─4");
		expect(shape(rows)).not.toContain("│ │ ├─3.4.1");
	});
});

describe("task widget", () => {
	test("collapsed shows the summary and the running task", () => {
		const { lines } = renderTaskWidget({ list: list(secrets()), folded, tokens: { full: 26_700, live: 10_100 } }, view(), 80, plain, NOW, true);
		expect(lines).toEqual(["▲ Tasks 6/20 (≡4) · 6m 21s · 26.7k → 10.1k tok", "  ⎿ 3.4.1 the new registry · 1m 11s"]);
	});

	test("a finished list collapses to one line", () => {
		const done = secrets().map((t) => ({ ...t, status: "done" as const, endedAt: t.endedAt ?? at(400), startedAt: t.startedAt ?? at(0) }));
		const { lines } = renderTaskWidget({ list: list(done), folded, tokens: null }, view(), 80, plain, NOW, true);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("► Tasks 20/20 (≡4)");
	});

	test("expanded draws glyphs and fits every width; clicks toggle and reveal", () => {
		const v = view({ expanded: true, maxRows: 9 });
		const model = { list: list(secrets()), folded, tokens: null };
		for (const width of [36, 57, 80, 140]) {
			const { lines } = renderTaskWidget(model, v, width, plain, NOW, true);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const { lines, hits } = renderTaskWidget(model, v, 80, plain, NOW, true);
		expect(lines[0]).toStartWith("▼ Tasks");
		expect(lines[2]).toBe("  ├─◐ 3 Secrets Redesign · 2m 45s (3/7)");
		expect(lines[5]).toBe("  │ │ ├─▶ 3.4.1 the new registry · 1m 11s");
		expect(lines[1]).toBe("  ├─ … 3 hidden · 3m 36s (2 folded)");
		applyTaskWidgetHit(v, hits[1]);
		expect(renderTaskWidget(model, v, 80, plain, NOW, true).lines[1]).toContain("▣ 0 Orientation");
		applyTaskWidgetHit(v, hits[0]);
		expect(v.expanded).toBe(false);
	});

	test("formats durations and picks this session's active list", () => {
		expect([formatDuration(45_000), formatDuration(312_000), formatDuration(7_500_000)]).toEqual(["45s", "5m 12s", "2h 05m"]);
		const a = { ...list([task("1", "done")]), slug: "a", updatedAt: at(9) };
		const b = { ...list([task("1", "doing")]), slug: "b", updatedAt: at(1) };
		const other = { ...list([task("1", "doing")]), slug: "c", claim: { session: "s2", at: at(0) } };
		expect(pickTaskList([a, b, other], "s1")?.slug).toBe("b");
		expect(pickTaskList([a, other], "s1")?.slug).toBe("a");
	});

	test("folded rows show their tokens; closed parents and hidden runs sum their folded subtasks", () => {
		const folds = new Map([
			["0", { full: 35_200, live: 400 }],
			["3.1", { full: 12_000, live: 300 }],
			["3.2", { full: 8_000, live: 200 }],
		]);
		const model = { list: list(secrets()), folded: new Set(["0", "3.1", "3.2"]), foldTokens: folds, tokens: null };
		const full = renderTaskWidget(model, view({ expanded: true, maxRows: 50, toggles: new Map([["3", false]]) }), 120, plain, NOW, true).lines;
		expect(full[1]).toBe("  ├─▣ 0 Orientation · 1m 12s (fold 35.2k → 400)");
		expect(full.find((l) => l.includes(" 3 Secrets"))).toBe("  ├─◐ 3 Secrets Redesign · 2m 45s (3/7 · 2 folded · 20.0k → 500)");
		const hidden = renderTaskWidget(model, view({ expanded: true, maxRows: 9 }), 120, plain, NOW, true).lines;
		expect(hidden[1]).toBe("  ├─ … 3 hidden · 3m 36s (1 folded · 35.2k → 400)");
		const finished = list([task("1", "done", "Unit", 0, 60), task("1.1", "done", "a", 0, 30), task("1.2", "done", "b", 30, 60), task("2", "doing", "next", 60)]);
		const doneModel = { list: finished, folded: new Set(["1.1", "1.2"]), foldTokens: new Map([["1.1", { full: 9_000, live: 100 }], ["1.2", { full: 1_000, live: 100 }]]), tokens: null };
		expect(renderTaskWidget(doneModel, view({ expanded: true }), 120, plain, NOW, true).lines[1]).toBe("  ├─▣ 1 Unit · 1m 0s (2/2 · 2 folded · 10.0k → 200)");
	});

	test("remembers the expanded state for later sessions", () => {
		const prefs = { mode: "auto" as const, expanded: false, maxRows: 12, toggleKey: "alt+t" };
		const make = () =>
			new TaskWidgetController({
				lists: () => [list(secrets())],
				session: () => "s1",
				truth: () => null,
				enabled: () => true,
				settings: () => prefs,
				saveExpanded: (expanded) => {
					prefs.expanded = expanded;
				},
			});
		const widget = { setWidget: () => {} };
		const first = make();
		first.attach(widget);
		first.toggle();
		expect(prefs.expanded).toBe(true);
		const next = make();
		next.attach(widget);
		next.toggle();
		expect(prefs.expanded).toBe(false);
	});
});
