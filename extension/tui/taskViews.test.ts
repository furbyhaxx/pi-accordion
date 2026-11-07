import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { foldCode, foldTag } from "../../core/digest";
import { foldedTaskIds, foldedTaskTokens } from "./taskWidget";
import { Truth } from "../../core/truth";
import type { TaskList } from "../tasks";
import { sessionTranscript, spanTranscript, transcriptSpans, type TBlock, type TranscriptSource } from "./taskTranscript";
import { TaskViews, detailLines, listDetailLines, listNodes, transcriptNodes, type TaskViewsHost, type ViewData } from "./taskViews";
import { flattenTree, treeRowLine } from "./treeView";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, strikethrough: (s: string) => s };
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
		const enriched = { ...list, goal: "Explicit list goal", pins: [pin], attachments: [attachment], tasks: list.tasks.map((t) => ({ ...t,
			...(t.id === "1" ? { pins: [{ ...pin, id: "p2", text: "Parent constraint" }] } : {}),
			...(t.id === "1.1" ? { acceptanceCriteria: ["Observable result"], pins: [{ ...pin, id: "p3", text: "Own constraint" }], attachments: [{ ...attachment, id: "a2" }] } : {}) })) };
		const lines = detailLines(enriched, "1.1", data(null), []).join("\n");
		for (const text of ["Explicit list goal", "Observable result", "list · p1", "parent 1 · p2", "task 1.1 · p3", "Own constraint", "spec.md:2-4", "Design evidence", "recorded-hash"])
			expect(lines).toContain(text);
		expect(listDetailLines(enriched, theme).join("\n")).toContain("Explicit list goal");
		const host: TaskViewsHost = { truth: () => null, verdict: () => undefined, threshold: () => null, lists: () => [{ ...enriched, tasks: [] }], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const v = new TaskViews({ requestRender() {} }, theme, { matches: () => false }, host, { kind: "list", slug: "l" }, () => {}, () => 30);
		v.handleInput("g");
		for (const width of [36, 57, 80, 140]) {
			const shown = v.render(width);
			expect(shown.join("\n")).toContain("Explicit list goal");
			expect(shown.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		v.dispose();
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

	it("renders cached snapshots and refreshes metadata only outside rendering", () => {
		const truth = truthOf();
		const project = truth.projectContext.bind(truth);
		let projections = 0, reads = 0;
		truth.projectContext = (options) => { projections++; return project(options); };
		let lists = [{ ...list, goal: "Initial goal" }];
		let changed = () => {};
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => { reads++; return lists; }, canSteer: () => false, apply: async () => "",
			subscribe: (listener) => { changed = listener; return () => {}; } };
		const view = new TaskViews({ requestRender() {} }, theme, { matches: () => false }, host, { kind: "list", slug: "l" }, () => {}, () => 30);
		const initialProjections = projections;
		for (let i = 0; i < 3; i++) for (const width of [36, 57, 80, 140]) view.render(width);
		expect(reads).toBe(1);
		expect(projections).toBe(initialProjections);
		lists = [{ ...list, goal: "Updated goal" }]; changed(); view.handleInput("g");
		const afterRefresh = { reads, projections };
		for (const width of [36, 57, 80, 140]) expect(view.render(width).join("\n")).toContain("Updated goal");
		expect({ reads, projections }).toEqual(afterRefresh);
		view.dispose();
	});

	it("does not reuse a different session's transcript at the same revision", () => {
		let truth: Truth | null = truthOf();
		let changed = () => {};
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => truth ? [list] : [], canSteer: () => !!truth, apply: async () => "",
			subscribe: (listener) => { changed = listener; return () => {}; } };
		const view = new TaskViews({ requestRender() {} }, theme, { matches: () => false }, host, { kind: "session" }, () => {}, () => 40);
		expect(view.render(140).join("\n")).toContain("Build the thing");
		const next = truthOf(blocks().map((b, i) => i === 0 ? { ...b, text: "Replacement branch" } : b));
		expect(next.rev).toBe(truth.rev);
		truth = next; changed();
		expect(view.render(140).join("\n")).toContain("Replacement branch");
		truth = null; changed();
		expect(view.render(140).join("\n")).toContain("No session context yet");
		view.dispose();
	});

	it("labels invalid lists rather than claiming they are empty or missing", () => {
		const host: TaskViewsHost = { truth: () => null, verdict: () => undefined, threshold: () => null, lists: () => [], invalid: () => ["l"], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const view = new TaskViews({ requestRender() {} }, theme, { matches: () => false }, host, { kind: "list", slug: "l" }, () => {}, () => 30);
		expect(view.render(140).join("\n")).toContain("Invalid task list");
		view.handleInput("g");
		expect(view.render(140).join("\n")).toContain('"l" is invalid');
		view.dispose();
	});

	it("distinguishes stored records from outgoing text while folding is paused", () => {
		const truth = truthOf(), bs = truth.blocks;
		truth.apply([{ kind: "group", ids: [bs[3].id, bs.at(-1)!.id], summary: `${foldTag(`g:${bs[3].id}`)} [task-record] l/1 "Parent" status: done\noutcome: Built.` }], "auto");
		const host: TaskViewsHost = { truth: () => truth, folding: () => false, verdict: () => undefined, threshold: () => null, lists: () => [list], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const view = new TaskViews({ requestRender() {} }, theme, { matches: (input, key) => input === "\r" && key === "tui.select.confirm" }, host, { kind: "list", slug: "l" }, () => {}, () => 40);
		expect(view.render(140).join("\n")).toContain("folding paused");
		view.handleInput("\r"); view.handleInput("v");
		const shown = view.render(140).join("\n");
		expect(shown).toContain("Stored fold (folding paused)");
		expect(shown).not.toContain("As the agent sees it");
		view.dispose();
	});

	it("opens the list legend with question mark", () => {
		const host: TaskViewsHost = { truth: () => null, verdict: () => undefined, threshold: () => 0.3, lists: () => [list], canSteer: () => false, apply: async () => "", subscribe: () => () => {} };
		const keys = { matches: (d: string, k: string) => k === "tui.select.cancel" && d === "\x1b" };
		const v = new TaskViews({ requestRender() {} }, theme, keys, host, { kind: "list", slug: "l" }, () => {}, () => 30);
		v.handleInput("?");
		expect(v.render(80).join("\n")).toContain("finished but raw");
		v.handleInput("\x1b");
		expect(v.render(80).join("\n")).toContain("Parent");
	});

	it("inspects composed child handles and steers them through the lease instead of rejecting the child", async () => {
		const b = blocks();
		const truth = truthOf(b);
		const childIds = b.slice(5, 9).map((b) => b.id);
		const handleId = "t:l/1.1";
		const summary = `${foldTag(`g:${b[3].id}`)} [task-record] l/1 "Parent"  status: done\nchild l/1.1 ${foldTag(handleId)}`;
		expect(truth.apply([{ kind: "group", ids: [b[3].id, b.at(-1)!.id], summary, handles: [{ id: handleId, memberIds: childIds }] }], "auto").results[0].applied).toBe(true);
		expect([...foldedTaskIds(list, foldedTaskTokens(list, truth))]).toEqual(["1", "1.1"]);
		let allowed = false;
		const applied: unknown[] = [];
		const host: TaskViewsHost = { truth: () => truth, verdict: () => undefined, threshold: () => null, lists: () => [list], canSteer: () => allowed,
			apply: async (ops) => { applied.push(...ops); truth.apply(ops, "you"); return "Applied."; }, subscribe: () => () => {} };
		const keys = { matches: (input: string, key: string) => input === ({ "tui.select.down": "\x1b[B", "tui.select.confirm": "\r", "tui.select.cancel": "\x1b" } as Record<string, string>)[key] };
		const view = new TaskViews({ requestRender() {} }, theme, keys, host, { kind: "list", slug: "l" }, () => {}, () => 40);
		view.render(140); view.handleInput("\x1b[C"); view.handleInput("\x1b[B"); view.handleInput("\r");
		expect(view.render(140).join("\n")).toContain(foldCode(handleId));
		view.handleInput("v");
		expect(view.render(140).join("\n")).toContain("child l/1.1");
		view.handleInput("v");
		expect(view.render(140).join("\n")).toContain("src/a.ts");
		view.handleInput("\x1b"); view.handleInput("u");
		expect(applied).toEqual([]);
		expect(view.render(140).join("\n")).toContain("Read-only");
		allowed = true; view.handleInput("u"); await Promise.resolve();
		expect(applied).toEqual([{ kind: "unfoldGroup", groupId: truth.groups[0].id, handleId }]);
		expect(truth.groups[0].folded).toBe(false);
		view.dispose();
	});

	it("refuses actions without control and stays inside the width", async () => {
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
		let closed = false;
		const keys = { matches: (d: string, k: string) => (k === "tui.select.down" && d === "\x1b[B") || (k === "tui.select.cancel" && d === "\x1b") || (k === "tui.select.confirm" && d === "\r") };
		const v = new TaskViews({ requestRender() {} }, theme, keys, host, { kind: "session" }, () => (closed = true), () => 30);
		for (const w of [36, 57, 80]) for (const line of v.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
		v.handleInput("\x1b[B");
		v.handleInput("\x1b[C");
		v.handleInput("\x1b[B");
		expect(v.render(80).join("\n")).toContain("› ");
		v.handleInput("f");
		expect(applied).toEqual([]);
		expect(v.render(80).join("\n")).toContain("Read-only");
		v.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
