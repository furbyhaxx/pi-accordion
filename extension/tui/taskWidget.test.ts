import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Task, TaskList } from "../tasks";
import { buildTaskTree, layoutTaskTree, summarizeTasks, type TaskRow } from "./taskTree";
import { TaskWidgetController, TaskWidgetComponent, applyTaskWidgetHit, foldedTaskIds, formatDuration, pickTaskList, renderTaskWidget, type TaskWidgetView, type WidgetTheme } from "./taskWidget";

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
const plain: WidgetTheme = { fg: (_c, t) => t, bold: (t) => t, strikethrough: (t) => t };
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

	test("separates adjacent finished and upcoming hidden siblings", () => {
		const roots = buildTaskTree([task("1", "done"), task("2", "done"), task("3", "todo"), task("4", "todo"), task("5", "doing")]);
		const rows = layoutTaskTree(roots, { maxRows: 2, now: NOW, folded: new Set() });
		const hidden = rows.filter((r): r is Extract<TaskRow, { kind: "hidden" }> => r.kind === "hidden");
		expect(hidden.map((r) => [r.finished, r.ids])).toEqual([[true, ["1", "2"]], [false, ["3", "4"]]]);
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
		expect(lines).toEqual(["▲ Tasks Secrets 6/20 (≡4) · 6m 21s · 26.7k → 10.1k tok", "  ⎿ 3.4.1 the new registry · 1m 11s"]);
	});

	test("fits long list titles while preserving task counts", () => {
		const model = { list: { ...list(secrets()), title: "A very long list title that does not fit in a narrow terminal" }, folded, tokens: null };
		for (const width of [36, 57, 80, 140]) {
			const header = renderTaskWidget(model, view(), width, plain, NOW, true).lines[0];
			expect(visibleWidth(header)).toBeLessThanOrEqual(width);
			expect(header).toContain("6/20");
		}
		expect(renderTaskWidget(model, view(), 36, plain, NOW, true).lines[0]).toContain("…");
	});

	test("a finished list collapses to one line", () => {
		const done = secrets().map((t) => ({ ...t, status: "done" as const, endedAt: t.endedAt ?? at(400), startedAt: t.startedAt ?? at(0) }));
		const { lines } = renderTaskWidget({ list: list(done), folded, tokens: null }, view(), 80, plain, NOW, true);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("► Tasks Secrets 20/20 (≡4)");
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
		expect(lines[2]).toBe("  ├─◐  3 Secrets Redesign · 2m 45s (3✓ 2☒ 1⊘ 3☐)");
		expect(lines[5]).toBe("  │ │ ├─▶  3.4.1 the new registry · 1m 11s");
		expect(lines[1]).toBe("  ├─ … 3 finished · 3m 36s (2≡)");
		applyTaskWidgetHit(v, hits[1]);
		expect(renderTaskWidget(model, v, 80, plain, NOW, true).lines[1]).toContain("▣≡ 0 Orientation");
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
		expect(full[1]).toBe("  ├─▣≡ 0 Orientation · 1m 12s (35.2k → 400)");
		expect(full.find((l) => l.includes(" 3 Secrets"))).toBe("  ├─◐  3 Secrets Redesign · 2m 45s (3✓ 2☒ 1⊘ 3☐ · 2≡ · 20.0k → 500)");
		const hidden = renderTaskWidget(model, view({ expanded: true, maxRows: 9 }), 120, plain, NOW, true).lines;
		expect(hidden[1]).toBe("  ├─ … 3 finished · 3m 36s (1≡ · 35.2k → 400)");
		const finished = list([task("1", "done", "Unit", 0, 60), task("1.1", "done", "a", 0, 30), task("1.2", "done", "b", 30, 60), task("2", "doing", "next", 60)]);
		const doneModel = { list: finished, folded: new Set(["1.1", "1.2"]), foldTokens: new Map([["1.1", { full: 9_000, live: 100 }], ["1.2", { full: 1_000, live: 100 }]]), tokens: null };
		expect(renderTaskWidget(doneModel, view({ expanded: true }), 120, plain, NOW, true).lines[1]).toBe("  ├─▣· 1 Unit · 1m 0s (2✓ · 2≡ · 10.0k → 200)");
	});

	test("shows a width-fitted legend without assigning it a click action", () => {
		const model = { list: list(secrets()), folded, tokens: null };
		const result = renderTaskWidget(model, view({ expanded: true, showLegend: true }), 36, plain, NOW, true);
		expect(result.lines[1]).toContain("≡ folded · raw");
		expect(visibleWidth(result.lines[1])).toBeLessThanOrEqual(36);
		expect(result.hits[1]).toBeNull();
	});

	test("warns if a finished task has unfinished descendants", () => {
		const model = { list: list([task("1", "done"), task("1.1", "todo")]), folded: new Set<string>(), tokens: null };
		expect(renderTaskWidget(model, view({ expanded: true }), 80, plain, NOW, true).lines[1]).toContain("▣! 1");
	});

	test("draws each end state apart: failed, abandoned struck through, blocked with its reason and paused time excluded", () => {
		const strike: WidgetTheme = { ...plain, strikethrough: (t) => `~${t}~` };
		const blocked: Task = { ...task("3", "blocked", "Deploy", 0), blocks: [{ reason: "user-decision", detail: "which region?", at: at(60) }] };
		const tasks = [task("1", "failed", "Flaky test", 0, 30), { ...task("2", "abandoned", "Old plan", 30, 40), supersededBy: "4" }, blocked, task("4", "todo", "New plan")];
		const lines = renderTaskWidget({ list: list(tasks), folded: new Set(), tokens: null }, view({ expanded: true, maxRows: 50 }), 100, strike, NOW, true).lines;
		expect(lines.slice(1)).toEqual([
			"  ├─☒· 1 Flaky test · 30s",
			"  ├─⊘· ~2~~ ~~Old plan~ · → 4 · 10s",
			"  ├─⧗  3 Deploy · needs user decision · 1m 0s",
			"  └─☐  4 New plan",
		]);
		const collapsed = renderTaskWidget({ list: list(tasks), folded: new Set(), tokens: null }, view(), 100, plain, NOW, true).lines;
		expect(collapsed[1]).toBe("  ⎿ ⧗ 3 Deploy · needs user decision");
	});

	test("counts actual coverage, never inferring a late child is folded from its parent", () => {
		const l = list([task("1", "done", "P", 0, 60), task("1.1", "done", "ran", 0, 30), { ...task("1.2", "abandoned", "never ran"), report: { outcome: "x" } }, task("1.3", "abandoned", "ran, then dropped", 30, 40)]);
		expect([...foldedTaskIds(l, new Map([["1", { full: 1, live: 1 }]]))]).toEqual(["1"]);
		expect([...foldedTaskIds(l, new Map(["1", "1.1", "1.3"].map((id) => [id, { full: 1, live: 1 }])))].sort()).toEqual(["1", "1.1", "1.3"]);
	});

	test("an invalid list produces a visible cached warning even without a readable list", () => {
		let scans = 0;
		let component: TaskWidgetComponent | null = null;
		const controller = new TaskWidgetController({
			lists: () => [],
			scan: () => { scans++; return { lists: [], invalid: ["broken"] }; },
			session: () => "s1", truth: () => null, enabled: () => true,
			settings: () => ({ mode: "auto", expanded: false, maxRows: 12, toggleKey: "alt+t" }),
			saveExpanded() {},
		});
		controller.attach({ setWidget: (_key, factory) => { if (factory) component = factory({ requestRender() {} }, plain); } });
		expect(controller.reason()).toContain("Invalid lists: broken");
		if (!component) throw new Error("warning widget was not installed");
		for (const width of [36, 57, 80, 140]) {
			const lines = (component as TaskWidgetComponent).render(width);
			expect(lines.join("\n")).toContain("Invalid lists: broken");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		expect(scans).toBe(1);
		controller.detach();
	});

	test("suspends inspection widgets without changing preferences or letting stale releases affect a new session", () => {
		let installed = false, saved = 0;
		const selectedList = list(secrets());
		const controller = new TaskWidgetController({ lists: () => [selectedList], scan: () => ({ lists: [selectedList], invalid: ["broken"] }), session: () => "s1", truth: () => null, enabled: () => true,
			settings: () => ({ mode: "auto", expanded: true, maxRows: 12, toggleKey: "alt+t" }), saveExpanded() { saved++; } });
		const ui: NonNullable<Parameters<TaskWidgetController["attach"]>[0]> = { setWidget: (_key, factory) => {
			installed = !!factory;
			if (factory) factory({ requestRender() {} }, plain);
		} };
		controller.attach(ui);
		expect(installed).toBe(true);
		expect(controller.reason()).toBeNull();
		const release = controller.suspend(), nested = controller.suspend();
		controller.reload(); release();
		expect(installed).toBe(false);
		nested(); nested();
		expect(installed).toBe(true);
		const stale = controller.suspend();
		controller.attach(ui);
		expect(installed).toBe(true);
		const current = controller.suspend(); stale();
		expect(installed).toBe(false);
		current();
		expect(installed).toBe(true);
		controller.hide(); const hidden = controller.suspend(); hidden();
		expect(installed).toBe(false);
		expect(saved).toBe(0);
		controller.detach();
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
