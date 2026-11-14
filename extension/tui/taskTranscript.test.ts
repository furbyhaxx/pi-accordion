import { describe, expect, it } from "bun:test";
import { Truth } from "../../core/truth";
import { foldTag } from "../../core/digest";
import type { Verdict } from "../../conductors/in-process/taskfold/verdicts";
import { recordForm } from "../../conductors/in-process/taskfold/records";
import { sessionTranscript, spanTranscript, spanTokens, spanTokenIndex, spanContains, transcriptSource, transcriptSpans, userReason, type TBlock, type TGroup, type TNode, type TranscriptSource } from "./taskTranscript";

class Log {
	blocks: TBlock[] = [];
	private n = 0;
	private push(b: Omit<TBlock, "full" | "live">, tokens = 10): string {
		this.blocks.push({ ...b, full: tokens, live: tokens });
		return b.id;
	}
	user(text: string): string {
		return this.push({ id: `u:${++this.n}`, kind: "user", text });
	}
	call(tool: string, args: Record<string, unknown>, out: string, tokens = 10): { call: string; result: string } {
		const c = `c${++this.n}`;
		const call = this.push({ id: `a:${c}:p0`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: c }, tokens);
		const result = this.push({ id: `r:${c}`, kind: "tool_result", text: out, toolName: tool, callId: c }, tokens);
		return { call, result };
	}
	start(id: string, title: string, extra = "") {
		return this.call("tasks", { action: "start", list: "l", id }, `Started l/${id} "${title}".${extra}`);
	}
	finish(id: string, outcome: string) {
		return this.call("tasks", { action: "complete", list: "l", id, report: { outcome } }, `l/${id} is done.`);
	}
	work(label: string, tokens = 100) {
		return this.call("bash", { command: label }, `${label} out`, tokens);
	}
}

function source(log: Log, groups: TGroup[] = [], verdicts: Record<string, Verdict> = {}): TranscriptSource {
	const blocks = log.blocks.map((b) => {
		const g = groups.find((g) => g.folded && g.memberIds.includes(b.id));
		return g ? { ...b, live: g.memberIds[0] === b.id ? g.live : 0 } : b;
	});
	const projection = blocks.flatMap((b) => {
		const g = groups.find((g) => g.folded && g.memberIds.includes(b.id));
		if (g && g.memberIds[0] !== b.id) return [];
		return [{ ...(g ? { groupId: g.id } : {}), text: g ? g.summary ?? null : b.digest ?? b.text,
			members: (g ? blocks.filter((b) => g.memberIds.includes(b.id)) : [b]).map(({ id, full, live }) => ({ id, full, live })) }];
	});
	return { blocks, groups, projection, verdict: (id) => verdicts[id], threshold: 0.3 };
}

const types = (nodes: readonly TNode[]) => nodes.map((n) => (n.type === "task" ? `task:${n.span.id}` : n.type === "edge" ? `edge:${n.edge}` : n.type === "step" ? `step:${n.block.toolName}` : n.type));

describe("task transcript", () => {
	it("preserves structured criteria, pins, handles and projection charges through the Truth adapter", () => {
		const log = new Log();
		log.user("Go.");
		const start = log.start("1", "Task");
		const details = { task: { acceptanceCriteria: ["Preserve the facts"], pins: [{ kind: "rule", text: "Exact fact", source: "user" }] } };
		log.blocks.find((b) => b.id === start.result)!.details = details;
		log.work("changes");
		const finish = log.finish("1", "Done");
		const truth = new Truth({ meta: { format: "pi", title: "Adapter", cwd: "", model: "" }, lineCount: 0, skipped: 0,
			blocks: log.blocks.map((b, order) => ({ ...b, tokens: b.full, turn: 0, order, override: null, autoFolded: false, by: null })) });
		truth.setProtect(0);
		const handles = [{ id: "t:l/1", memberIds: log.blocks.slice(1).map((b) => b.id) }];
		expect(truth.apply([{ kind: "group", ids: [start.call, finish.result], summary: `${foldTag("t:l/1")} record`, handles }], "auto").results[0].applied).toBe(true);
		truth.setCalibration(1.375);
		const src = transcriptSource(truth, () => undefined, 0.3);
		expect(src.blocks.find((b) => b.id === start.result)?.details).toEqual(details);
		expect(src.groups[0].handles).toEqual(handles);
		expect(transcriptSpans(src)[0].acceptanceCriteria).toEqual(["Preserve the facts"]);
		expect(transcriptSpans(src)[0].pins?.[0].text).toBe("Exact fact");
		expect(src.blocks.reduce((n, b) => n + b.live, 0)).toBe(truth.stats().liveTokens);
		expect(src.projection.flatMap((p) => p.members).map((b) => b.id)).toEqual(src.blocks.map((b) => b.id));
		const disarmed = transcriptSource(truth, () => undefined, 0.3, { folding: false });
		expect(disarmed.groups.every((g) => !g.folded)).toBe(true);
		expect(disarmed.projection.map((p) => p.text)).toEqual(log.blocks.map((b) => b.text));
		expect(disarmed.blocks.reduce((n, b) => n + b.live, 0)).toBe(truth.stats().fullTokens);
	});
	it("nests subtasks under auto-started parents and keeps work outside tasks as untracked runs", () => {
		const log = new Log();
		log.user("Build it.");
		log.work("explore");
		log.start("1.1", "Sub", '\nAlso started parent 1 "Parent" so its span covers this subtask.');
		log.work("w1");
		log.finish("1.1", "sub done");
		log.user("ok");
		log.finish("1", "parent done");
		log.user("next");
		const tree = sessionTranscript(source(log, [], { "u:6": { loss: 0.1, source: "classifier" } }));
		expect(types(tree)).toEqual(["user", "untracked", "task:1", "user"]);
		const parent = tree[2] as TNode & { type: "task" };
		expect(types(parent.children)).toEqual(["task:1.1", "user"]);
		expect(parent.subtasks).toEqual({ done: 1, total: 1 });
		const ack = parent.children[1] as TNode & { type: "user" };
		expect(ack.why).toBe("loss 0.1 < 0.30 · folds with its task");
	});

	it("keeps paused siblings and untracked gaps outside the resumed task", () => {
		const log = new Log();
		log.user("Go.");
		log.start("1", "Paused");
		log.work("own-first");
		log.call("tasks", { action: "block", list: "l", id: "1" }, "Paused.");
		log.start("2", "Sibling");
		log.work("sibling-only");
		log.finish("2", "Sibling done");
		log.work("untracked-gap");
		log.start("1", "Paused");
		log.work("own-last");
		log.finish("1", "Done");
		const src = source(log);
		const tree = sessionTranscript(src);
		expect(types(tree)).toEqual(["user", "task:1", "task:2", "untracked"]);
		const span = transcriptSpans(src).find((s) => s.id === "1")!;
		expect(spanTokens(src, span)).toEqual({ full: 480, live: 480 });
		const shown = JSON.stringify(spanTranscript(src, span));
		expect(shown).toContain("own-first");
		expect(shown).toContain("own-last");
		expect(shown).not.toContain("sibling-only");
		expect(shown).not.toContain("untracked-gap");
	});

	it("indexes the same charges as the per-task filter across nested and interleaved spans", () => {
		const log = new Log();
		log.start("1.1", "Child", '\nAlso started parent 1 "Parent" so its span covers this subtask.');
		log.work("child");
		log.finish("1.1", "done");
		log.call("tasks", { action: "block", list: "l", id: "1" }, "Paused.");
		log.start("2", "Sibling");
		const sibling = log.work("sibling");
		log.finish("2", "done");
		log.start("1", "Parent");
		log.work("resumed");
		log.finish("1", "done");
		const group: TGroup = { id: "g", memberIds: [sibling.call, sibling.result], folded: true,
			summary: `${foldTag("g")} {"task":"l/1","title":"Parent","status":"done","outcome":"done"}`, full: 200, live: 20 };
		const src = source(log, [group]);
		const spans = transcriptSpans(src);
		const charges = spanTokenIndex(src, spans);
		expect(spans.map((s) => s.key)).toContain("l/1.1");
		expect(spans.find((s) => s.key === "l/1")!.intervals.length).toBeGreaterThan(1);
		for (const span of spans) {
			const ids = new Set(src.blocks.filter((_b, i) => spanContains(span, i)).map((b) => b.id));
			for (const p of src.projection) if (p.groupId === group.id && span.key === "l/1") for (const b of p.members) ids.add(b.id);
			const expected = src.blocks.filter((b) => ids.has(b.id)).reduce((sum, b) => ({ full: sum.full + b.full, live: sum.live + b.live }), { full: 0, live: 0 });
			expect(charges.get(span)).toEqual(expected);
			expect(spanTokens(src, span)).toEqual(expected);
		}
	});

	it("shows a span as start, folds with their members, kept user messages and finish", () => {
		const log = new Log();
		log.user("Go.");
		const s = log.start("1", "Task");
		const w1 = log.work("a");
		const steer = log.user("don't touch x");
		const w2 = log.work("b");
		const f = log.finish("1", "done");
		const before: TGroup = { id: "g:1", memberIds: [s.call, s.result, w1.call, w1.result], folded: true, summary: `${foldTag("g:1")} {"part":"l/1","of":[1,2]}`, full: 220, live: 20 };
		const after: TGroup = { id: "g:2", memberIds: [w2.call, w2.result, f.call, f.result], folded: true, summary: `${foldTag("g:2")} {"task":"l/1","title":"Task","status":"done","outcome":"done"}`, full: 220, live: 30 };
		const src = source(log, [before, after], { [steer]: { loss: 2, source: "classifier" } });
		const span = transcriptSpans(src).find((x) => x.id === "1")!;
		const nodes = spanTranscript(src, span);
		expect(types(nodes)).toEqual(["edge:start", "fold", "user", "fold", "edge:finish"]);
		const first = nodes[1] as TNode & { type: "fold" };
		expect(types(first.children)).toEqual(["step:bash"]);
		expect((nodes[2] as TNode & { type: "user" }).why).toBe("loss 2.0 ≥ 0.30");
		expect((nodes[3] as TNode & { type: "fold" }).form).toBe("record");
		const root = sessionTranscript(src)[1] as TNode & { type: "task" };
		expect(root.tokens).toEqual({ full: 450, live: 60 });
		expect(root.folds).toBe(2);
	});

	it("names each verdict source and reads the record form", () => {
		expect(userReason({ loss: 0, source: "harness" }, true, 0.3)).toBe("harness pattern");
		expect(userReason({ loss: null, source: "opening" }, false, 0.3)).toBe("opening message");
		expect(userReason({ loss: null, source: "error" }, false, 0.3)).toBe("classifier failed");
		expect(userReason(undefined, false, null)).toBe("unclassified");
		expect(userReason({ loss: 0.1, source: "classifier" }, false, 0.3)).toBe("loss 0.1 < 0.30 · folds with its task");
		expect(userReason({ loss: 0.1, source: "classifier" }, true, 0.3)).toBe("loss 0.1 < 0.30");
		expect(userReason({ loss: 0.8, source: "classifier", routed: { ids: ["p1", "g2"], at: "t" } }, false, 0.3)).toBe("routed → p1, g2");
		expect(userReason({ loss: 0.8, source: "classifier", routed: { ids: [], at: "t" } }, false, 0.3, false)).toBe("routed · no change · no task covers it");
		expect(userReason({ loss: 0.1, source: "classifier" }, false, 0.3, false)).toBe("loss 0.1 < 0.30 · no task covers it");
		expect(recordForm(`${foldTag("g:x")} {"task":"l/1","title":"T","status":"done","outcome":"x"}`)).toBe("record");
		expect(recordForm(`${foldTag("g:x")} {"history":"l/1","title":"T","status":"done"}`)).toBe("history");
		expect(recordForm(`${foldTag("g:x")} {"part":"l/1","of":[1,2]}`)).toBeNull();
		expect(recordForm(`${foldTag("g:x")} [task-record] l/1 "T"  status: done`)).toBeNull();
		expect(recordForm("plain")).toBeNull();
	});

	it("keeps an extension message as an ordinary step inside a task and as untracked work outside", () => {
		const log = new Log();
		log.user("Go");
		log.blocks.push({ id: "c:1:aa", kind: "custom", text: "ext before", full: 10, live: 10 });
		log.start("1", "Task");
		log.blocks.push({ id: "c:2:bb", kind: "custom", text: "ext inside", full: 10, live: 10 });
		log.work("w");
		log.finish("1", "done");
		const src = source(log);
		const tree = sessionTranscript(src);
		expect(tree.some((n) => n.type === "user" && n.block.kind === "custom")).toBe(false);
		expect(tree.filter((n) => n.type === "user").length).toBe(1);
		const untracked = tree.find((n) => n.type === "untracked") as Extract<TNode, { type: "untracked" }>;
		expect(untracked.blocks.map((b) => b.id)).toEqual(["c:1:aa"]);
		const task = tree.find((n) => n.type === "task") as Extract<TNode, { type: "task" }>;
		const body = spanTranscript(src, task.span);
		const inside = body.filter((n): n is Extract<TNode, { type: "step" }> => n.type === "step" && n.block.kind === "custom");
		expect(inside.map((n) => n.block.id)).toEqual(["c:2:bb"]);
		expect(body.some((n) => n.type === "user")).toBe(false);
	});
});
