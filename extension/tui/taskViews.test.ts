import { describe, expect, it } from "bun:test";
import { foldCode, foldTag } from "../../core/digest";
import { foldedTaskIds, foldedTaskTokens } from "./taskWidget";
import { Truth } from "../../core/truth";
import type { TaskList } from "../tasks";
import { sessionTranscript, spanTranscript, transcriptSource, transcriptSpans, type TBlock, type TranscriptSource } from "./taskTranscript";
import { TASK_LEGEND, TaskViews, detailLines, listDetailLines, listNodes, transcriptNodes, type TaskViewsHost, type TaskViewsStart, type ViewData } from "./taskViews";
import { flattenTree, treeRowLine } from "./treeView";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, strikethrough: (s: string) => s };
const BIND: Record<string, string> = { "tui.select.confirm": "\r", "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B" };
const keys = { matches: (data: string, binding: string) => BIND[binding] === data, getKeys: () => [] };
const alt = (key: string) => `\x1b${key}`;
const RIGHT = "\x1b[C", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

/** The screens as the panel shell drives them: Esc goes back, everything else is a key. */
function open(host: TaskViewsHost, start: TaskViewsStart) {
	const said: string[] = [];
	const v = new TaskViews({ theme: () => theme, keys: () => keys, say: (text) => void said.push(text), confirm() {}, update() {} }, host, start);
	return {
		v,
		said,
		press: (...input: string[]) => input.map((d) => (d === ESC ? v.back() : v.key(d))),
		screen: (width = 140, rows = 30) => {
			const view = v.view(width, rows);
			return [view.crumbs.join(" › "), ...view.body, view.description].join("\n");
		},
	};
}

const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 9, min, 0)).toISOString();

const list: TaskList = {
	slug: "l",
	title: "List",
	createdAt: at(0),
	updatedAt: at(30),
	claim: null,
	tasks: [
		{ id: "1", title: "Parent", status: "done", createdAt: at(0), startedAt: at(10), endedAt: at(20), updatedAt: at(20), report: { outcome: "all done", decisions: ["a — b"] } },
		{ id: "1.1", title: "Sub one", status: "done", createdAt: at(0), startedAt: at(10), endedAt: at(15), updatedAt: at(15), report: { outcome: "one" } },
		{ id: "1.2", title: "Sub two", status: "failed", createdAt: at(0), startedAt: at(15), endedAt: at(20), updatedAt: at(20), report: { outcome: "two" } },
		{ id: "2", title: "Later", status: "todo", createdAt: at(0), updatedAt: at(0) },
	],
};

let n = 0;
function blocks(): TBlock[] {
	const out: TBlock[] = [];
	const call = (tool: string, args: Record<string, unknown>, result: string, tokens = 10, isError = false) => {
		const c = `c${++n}`;
		out.push({ id: `a:${c}:p0`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: c, full: tokens, live: tokens });
		out.push({ id: `r:${c}`, kind: "tool_result", text: result, toolName: tool, callId: c, full: tokens, live: tokens, ...(isError ? { isError: true } : {}) });
	};
	out.push({ id: "u:1", kind: "user", text: "Build the thing", full: 5, live: 5 });
	call("bash", { command: "ls" }, "x");
	call("tasks", { action: "start", list: "l", id: "1" }, 'Started l/1 "Parent".');
	call("edit", { path: "src/a.ts" }, "ok", 300);
	call("bash", { command: "bun test" }, "1 fail", 50, true);
	call("tasks", { action: "complete", list: "l", id: "1", report: { outcome: "all done" } }, "l/1 is done.");
	return out;
}

function source(b = blocks()): TranscriptSource {
	return { blocks: b, groups: [], projection: b.map((b) => ({ text: b.text, members: [{ id: b.id, full: b.full, live: b.live }] })), verdict: () => undefined, threshold: 0.3 };
}

function data(src: TranscriptSource | null): ViewData {
	return { src, spans: src ? transcriptSpans(src) : [], theme, now: Date.parse(at(40)) };
}

function truthOf(bs = blocks()): Truth {
	const truth = new Truth({ meta: { format: "pi", title: "Task views", cwd: "", model: "" }, lineCount: 0, skipped: 0,
		blocks: bs.map((b, order) => ({ ...b, tokens: b.full, turn: 0, order, override: null, autoFolded: false, by: null })) });
	truth.setProtect(0);
	return truth;
}

describe("task views", () => {
	it("shows subtask progress, time and folds in the list tree", () => {
		const nodes = listNodes(list, null, data(null));
		const rows = flattenTree(nodes, new Map([["l/1", true]]));
		expect(rows.map((r) => `${r.prefix}${r.node.key}`)).toEqual(["l/1", "├─l/1.1", "└─l/1.2", "l/2"]);
		const parent = treeRowLine(rows[0], false, 80, (s) => s, (s) => s);
		expect(parent).toContain("1 Parent · 1/2 · 10m 0s");
		expect(nodes[1].open).toBe(true);
	});

	it("shows goal, criteria and scoped facts without confusing inherited and task pins", () => {
		const pin = { id: "p1", kind: "rule" as const, text: "Exact\nlist fact", source: "user", at: at(0) };
		const attachment = { id: "a1", path: "spec.md", lines: "2-4", note: "Design evidence", at: at(0), hash: "recorded-hash" };
		const enriched = { ...list, goals: [{ id: "g1", text: "Explicit list goal" }], pins: [pin], attachments: [attachment], tasks: list.tasks.map((t) => ({ ...t,
			...(t.id === "1" ? { pins: [{ ...pin, id: "p2", text: "Parent constraint" }] } : {}),
			...(t.id === "1.1" ? { goals: [{ id: "g2", text: "Task goal" }], acceptanceCriteria: [{ id: "c1", text: "Observable result" }], pins: [{ ...pin, id: "p3", text: "Own constraint" }], attachments: [{ ...attachment, id: "a2" }] } : {}) })) };
		const lines = detailLines(enriched, "1.1", data(null), []).join("\n");
		for (const text of ["g1 Explicit list goal", "g2 Task goal", "c1 Observable result", "list · p1", "parent 1 · p2", "task 1.1 · p3", "Own constraint", "spec.md:2-4", "Design evidence", "recorded-hash"])
			expect(lines).toContain(text);
		expect(listDetailLines(enriched, theme).join("\n")).toContain("Explicit list goal");
		const host: TaskViewsHost = { truth: () => null, verdict: () => undefined, threshold: () => null, lists: () => [{ ...enriched, tasks: [] }], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const o = open(host, { kind: "list", slug: "l" });
		o.press(alt("g"));
		for (const width of [36, 57, 80, 140]) expect(o.screen(width)).toContain("Explicit list goal");
		o.v.dispose();
	});

	it("lists plan time, wait, run, report and the recorded facts in the details", () => {
		const src = source();
		const lines = detailLines(list, "1", data(src), []).join("\n");
		expect(lines).toContain("1/2 subtasks done");
		expect(lines).toContain("waited 10m 0s before starting");
		expect(lines).toContain("10m 0s · done");
		expect(lines).toContain("all done");
		expect(lines).toContain("· a — b");
		expect(lines).toContain("src/a.ts");
		expect(lines).toContain("`bun test` → failed: 1 fail");
		expect(detailLines(list, "2", data(src), []).join("\n")).toContain("none · never started");
		const elsewhere = { ...list, tasks: list.tasks.map((x) => (x.id === "2" ? { ...x, status: "done" as const, startedAt: list.updatedAt, endedAt: list.updatedAt } : x)) };
		expect(detailLines(elsewhere, "2", data(src), []).join("\n")).toContain("not run in this session");
		const never = { ...list, tasks: [...list.tasks, { id: "3", title: "Dropped", status: "abandoned" as const, updatedAt: list.updatedAt, report: { outcome: "x" }, supersededBy: "2" }] };
		const neverLines = detailLines(never, "3", data(src), []).join("\n");
		expect(neverLines).toContain("none · never started");
		expect(neverLines).toContain("Superseded by 2");
	});

	it("derives parent facts from its own intervals instead of its children's work", () => {
		const b = blocks();
		const event = (action: "start" | "complete"): TBlock[] => {
			const c = `child-${action}`;
			return [
				{ id: `a:${c}:p0`, kind: "tool_call", toolName: "tasks", callId: c, full: 10, live: 10,
					text: `tasks ${JSON.stringify({ action, list: "l", id: "1.1", ...(action === "complete" ? { report: { outcome: "Child done" } } : {}) })}` },
				{ id: `r:${c}`, kind: "tool_result", toolName: "tasks", callId: c, full: 10, live: 10,
					text: action === "start" ? 'Started l/1.1 "Sub one".' : "l/1.1 is done." },
			];
		};
		b.splice(5, 0, ...event("start"));
		b.splice(b.length - 2, 0, ...event("complete"));
		const src = source(b);
		const parent = detailLines(list, "1", data(src), []).join("\n");
		const child = detailLines(list, "1.1", data(src), []).join("\n");
		expect(parent).not.toContain("src/a.ts");
		expect(parent).not.toContain("`bun test`");
		expect(child).toContain("src/a.ts");
		expect(child).toContain("`bun test` → failed");
	});

	it("flags untracked work and marks failed steps in the session tree", () => {
		const src = source();
		const nodes = transcriptNodes(sessionTranscript(src), data(src));
		expect(nodes.map((x) => x.data?.type)).toEqual(["user", "untracked", "task"]);
		expect(nodes[1].label).toContain("untracked · 1 call");
		const span = transcriptSpans(src)[0];
		const steps = transcriptNodes(spanTranscript(src, span), data(src)).map((c) => c.label);
		expect(steps[0]).toContain("start");
		expect(steps[steps.length - 1]).toContain("finish  done");
		expect(steps.some((l) => l.startsWith("✗ bash  bun test"))).toBe(true);
		expect(steps.some((l) => l.startsWith("✓ edit  src/a.ts"))).toBe(true);
	});

	it("renders cached snapshots and rebuilds them once per change", () => {
		const truth = truthOf();
		const project = truth.projectContext.bind(truth);
		let projections = 0, reads = 0;
		truth.projectContext = (options) => { projections++; return project(options); };
		let lists = [{ ...list, goal: "Initial goal" }];
		let changed = () => {};
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => { reads++; return lists; }, canSteer: () => false, apply: async () => "",
			subscribe: (listener) => { changed = listener; return () => {}; } };
		const o = open(host, { kind: "list", slug: "l" });
		o.screen();
		const initialProjections = projections;
		for (let i = 0; i < 3; i++) for (const width of [36, 57, 80, 140]) o.screen(width);
		expect(reads).toBe(1);
		expect(projections).toBe(initialProjections);
		lists = [{ ...list, goals: [{ id: "g1", text: "Updated goal" }] }]; changed(); o.press(alt("g"));
		const afterRefresh = { reads, projections };
		for (const width of [36, 57, 80, 140]) expect(o.screen(width)).toContain("Updated goal");
		expect({ reads, projections }).toEqual(afterRefresh);
		expect(reads).toBe(2);
		o.v.dispose();
	});

	it("does not reuse a different session's transcript at the same revision", () => {
		let truth: Truth | null = truthOf();
		let changed = () => {};
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => truth ? [list] : [], canSteer: () => !!truth, apply: async () => "",
			subscribe: (listener) => { changed = listener; return () => {}; } };
		const o = open(host, { kind: "session" });
		expect(o.screen()).toContain("Build the thing");
		const next = truthOf(blocks().map((b, i) => i === 0 ? { ...b, text: "Replacement branch" } : b));
		expect(next.rev).toBe(truth.rev);
		truth = next; changed();
		expect(o.screen()).toContain("Replacement branch");
		truth = null; changed();
		expect(o.screen()).toContain("No session context yet");
		o.v.dispose();
	});

	it("keeps every screen's body inside the rows it was given", () => {
		const host: TaskViewsHost = { truth: () => truthOf(), verdict: () => undefined, threshold: () => null, lists: () => [{ ...list, goals: [{ id: "g1", text: "A long goal with enough context to wrap across several narrow terminal rows." }] }], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const o = open(host, { kind: "list", slug: "l" });
		for (const input of ["", alt("g"), ESC, ENTER, ENTER, ESC, ESC, alt("i")]) {
			if (input) o.press(input);
			for (const width of [36, 57, 80, 140]) {
				const view = o.v.view(width, 3);
				expect(view.body.length).toBeLessThanOrEqual(3);
				expect(view.above).toBeGreaterThanOrEqual(0);
				expect(view.below).toBeGreaterThanOrEqual(0);
			}
		}
		o.v.dispose();
	});

	it("labels invalid lists rather than claiming they are empty or missing", () => {
		const host: TaskViewsHost = { truth: () => null, verdict: () => undefined, threshold: () => null, lists: () => [], invalid: () => ["l"], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const o = open(host, { kind: "list", slug: "l" });
		expect(o.screen()).toContain("Invalid task list");
		o.press(alt("g"));
		expect(o.screen()).toContain('"l" is invalid');
		o.v.dispose();
	});

	it("distinguishes stored records from outgoing text while folding is paused", () => {
		const truth = truthOf(), bs = truth.blocks;
		truth.apply([{ kind: "group", ids: [bs[3].id, bs.at(-1)!.id], summary: `${foldTag(`g:${bs[3].id}`)} {"task":"l/1","title":"Parent","status":"done","outcome":"Built."}` }], "auto");
		const host: TaskViewsHost = { truth: () => truth, folding: () => false, verdict: () => undefined, threshold: () => null, lists: () => [list], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const o = open(host, { kind: "list", slug: "l" });
		o.screen(); o.press(ENTER, alt("v"));
		const shown = o.screen();
		expect(shown).toContain("Stored fold (folding paused)");
		expect(shown).not.toContain("As the agent sees it");
		o.v.dispose();
	});

	it("explains the glyphs in the help legend", () => {
		expect(TASK_LEGEND.join("\n")).toContain("finished but raw");
	});

	it("inspects composed child handles and steers them through the lease instead of rejecting the child", async () => {
		const b = blocks();
		const truth = truthOf(b);
		const childIds = b.slice(5, 9).map((b) => b.id);
		const handleId = "t:l/1.1";
		const summary = `${foldTag(`g:${b[3].id}`)} {"task":"l/1","title":"Parent","status":"done","children":[{"task":"l/1.1","recall":"${foldTag(handleId)}"}]}`;
		expect(truth.apply([{ kind: "group", ids: [b[3].id, b.at(-1)!.id], summary, handles: [{ id: handleId, memberIds: childIds }] }], "auto").results[0].applied).toBe(true);
		expect([...foldedTaskIds(list, foldedTaskTokens(list, truth))]).toEqual(["1", "1.1"]);
		let allowed = false;
		const applied: unknown[] = [];
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => [list], canSteer: () => allowed,
			apply: async (ops) => { applied.push(...ops); truth.apply(ops, "you"); return "Applied."; }, subscribe: () => () => {} };
		const o = open(host, { kind: "list", slug: "l" });
		o.screen(); o.press(RIGHT, DOWN, ENTER);
		expect(o.screen()).toContain(foldCode(handleId));
		o.press(alt("v"));
		expect(o.screen()).toContain(`"task":"l/1.1"`);
		o.press(alt("v"));
		expect(o.screen()).toContain("src/a.ts");
		o.press(ESC, alt("f"));
		expect(applied).toEqual([]);
		expect(o.said.at(-1)).toContain("Read-only");
		allowed = true; o.press(alt("f")); await Promise.resolve();
		expect(truth.groups[0].folded).toBe(false);
		expect(childIds.every((id) => truth.get(id)?.override === "unfolded" && truth.get(id)?.by === "you")).toBe(true);
		expect(b.filter((b) => !childIds.includes(b.id)).every((b) => truth.get(b.id)?.override === null)).toBe(true);
		o.v.dispose();
	});

	it("keeps whole-task folds reversible without treating them as selective recovery", async () => {
		const b = blocks(), truth = truthOf(b);
		const ids = b.slice(3).map((b) => b.id), handleId = "t:l/1";
		const summary = `${foldTag(`g:${ids[0]}`)} {"task":"l/1","title":"Parent","status":"done","recall":"${foldTag(handleId)}"}`;
		expect(truth.apply([{ kind: "group", ids, summary, handles: [{ id: handleId, memberIds: ids }] }], "auto").results[0].applied).toBe(true);
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => [list], canSteer: () => true,
			apply: async (ops) => { const result = truth.apply(ops, "you"); expect(result.results.every((r) => r.applied)).toBe(true); return "Applied."; }, subscribe: () => () => {} };
		const o = open(host, { kind: "list", slug: "l" });
		o.screen(); o.press(alt("f")); await Promise.resolve();
		expect(truth.groups[0].folded).toBe(false);
		expect(ids.every((id) => truth.get(id)?.override === null)).toBe(true);
		o.press(alt("f")); await Promise.resolve();
		expect(truth.groups[0].folded).toBe(true);
		expect(transcriptSource(truth, () => undefined, null).projection.some((p) => p.text === summary)).toBe(true);
		o.v.dispose();
	});

	it("refuses actions without control and ignores bare keys", async () => {
		const applied: unknown[] = [];
		const b = blocks();
		const truth = new Truth({
			meta: { format: "pi", title: "Views", cwd: "", model: "" }, lineCount: 0, skipped: 0,
			blocks: b.map((x, order) => ({ ...x, tokens: x.full, turn: 0, order, override: null, autoFolded: false, by: null })),
		});
		truth.setProtect(0);
		const host: TaskViewsHost = {
			truth: () => truth,
			verdict: () => undefined,
			threshold: () => 0.3,
			lists: () => [list],
			canSteer: () => false,
			apply: async (ops) => {
				applied.push(...ops);
				return "Applied.";
			},
			subscribe: () => () => {},
		};
		const o = open(host, { kind: "session" });
		o.press(DOWN, RIGHT, DOWN);
		expect(o.screen(80)).toContain("→");
		for (const key of ["f", "p", "u", "i", "d", "t", "g", "v", "?", "/", " "]) expect(o.v.key(key)).toBe(false);
		o.press(alt("f"));
		expect(applied).toEqual([]);
		expect(o.said.at(-1)).toContain("Read-only");
		expect(o.v.back()).toBe(false);
		o.v.dispose();
	});
});
