import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Truth } from "../../core/truth";
import type { TaskList } from "../tasks";
import { sessionTranscript, spanTranscript, transcriptSpans, type TBlock, type TranscriptSource } from "./taskTranscript";
import { TaskViews, detailLines, listNodes, transcriptNodes, type TaskViewsHost, type ViewData } from "./taskViews";
import { flattenTree, treeRowLine } from "./treeView";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
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

function data(src: TranscriptSource | null): ViewData {
	return { src, spans: src ? transcriptSpans(src) : [], theme, now: Date.parse(at(40)) };
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

	it("lists plan time, wait, run, report and the recorded facts in the details", () => {
		const src: TranscriptSource = { blocks: blocks(), groups: [], verdict: () => undefined, threshold: 0.3 };
		const lines = detailLines(list, "1", data(src), []).join("\n");
		expect(lines).toContain("1/2 subtasks done");
		expect(lines).toContain("waited 10m 0s before starting");
		expect(lines).toContain("10m 0s · done");
		expect(lines).toContain("all done");
		expect(lines).toContain("· a — b");
		expect(lines).toContain("src/a.ts");
		expect(lines).toContain("`bun test` → failed: 1 fail");
		expect(detailLines(list, "2", data(src), []).join("\n")).toContain("not run in this session");
	});

	it("flags untracked work and marks failed steps in the session tree", () => {
		const src: TranscriptSource = { blocks: blocks(), groups: [], verdict: () => undefined, threshold: 0.3 };
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

	it("refuses actions without control and stays inside the width", async () => {
		const applied: unknown[] = [];
		const b = blocks();
		const truth = {
			rev: 1,
			blocks: b.map((x) => ({ ...x, tokens: x.full })),
			groups: [],
			isFolded: () => false,
			groupOf: () => undefined,
			isProtected: () => false,
			calBlockTokens: (_b: unknown, t: number) => t,
			effTokens: (x: { tokens: number }) => x.tokens,
			calibratedGroupFullTokens: () => 0,
			calibratedGroupLiveTokens: () => 0,
		} as unknown as Truth;
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
