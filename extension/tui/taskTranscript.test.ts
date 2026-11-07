import { describe, expect, it } from "bun:test";
import { foldTag } from "../../core/digest";
import type { Verdict } from "../../conductors/in-process/taskfold/verdicts";
import { recordLevel, sessionTranscript, spanTranscript, transcriptSpans, userReason, type TBlock, type TGroup, type TNode, type TranscriptSource } from "./taskTranscript";

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
	return { blocks: log.blocks, groups, verdict: (id) => verdicts[id], threshold: 0.3 };
}

const types = (nodes: readonly TNode[]) => nodes.map((n) => (n.type === "task" ? `task:${n.span.id}` : n.type === "edge" ? `edge:${n.edge}` : n.type === "step" ? `step:${n.block.toolName}` : n.type));

describe("task transcript", () => {
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

	it("shows a span as start, folds with their members, kept user messages and finish", () => {
		const log = new Log();
		log.user("Go.");
		const s = log.start("1", "Task");
		const w1 = log.work("a");
		const steer = log.user("don't touch x");
		const w2 = log.work("b");
		const f = log.finish("1", "done");
		const before: TGroup = { id: "g:1", memberIds: [s.call, s.result, w1.call, w1.result], folded: true, summary: `${foldTag("g:1")} [task-part] l/1 "Task" part 1/2; …`, full: 240, live: 20 };
		const after: TGroup = { id: "g:2", memberIds: [w2.call, w2.result, f.call, f.result], folded: true, summary: `${foldTag("g:2")} [task-record] l/1 "Task"  status: done\noutcome: done`, full: 220, live: 30 };
		const src = source(log, [before, after], { [steer]: { loss: 2, source: "classifier" } });
		const span = transcriptSpans(src).find((x) => x.id === "1")!;
		const nodes = spanTranscript(src, span);
		expect(types(nodes)).toEqual(["edge:start", "fold", "user", "fold", "edge:finish"]);
		const first = nodes[1] as TNode & { type: "fold" };
		expect(types(first.children)).toEqual(["step:bash"]);
		expect((nodes[2] as TNode & { type: "user" }).why).toBe("loss 2.0 ≥ 0.30");
		expect((nodes[3] as TNode & { type: "fold" }).level).toBe(0);
		const root = sessionTranscript(src)[1] as TNode & { type: "task" };
		expect(root.tokens).toEqual({ full: 470, live: 60 });
		expect(root.folds).toBe(2);
	});

	it("names each verdict source and reads record aging levels", () => {
		expect(userReason({ loss: 0, source: "harness" }, true, 0.3)).toBe("harness pattern");
		expect(userReason({ loss: null, source: "opening" }, false, 0.3)).toBe("opening message");
		expect(userReason({ loss: null, source: "error" }, false, 0.3)).toBe("classifier failed");
		expect(userReason(undefined, false, null)).toBe("unclassified");
		expect(userReason({ loss: 0.1, source: "classifier" }, false, 0.3)).toBe("loss 0.1 < 0.30 · folds with its task");
		expect(userReason({ loss: 0.1, source: "classifier" }, true, 0.3)).toBe("loss 0.1 < 0.30");
		expect(userReason({ loss: 0.1, source: "classifier" }, false, 0.3, false)).toBe("loss 0.1 < 0.30 · no task covers it");
		expect(recordLevel(`${foldTag("g:x")} [task-record] l/1 "T"  status: done\noutcome: x`)).toBe(0);
		expect(recordLevel(`${foldTag("g:x")} [task-record] l/1 "T"  status: done · x`)).toBe(1);
		expect(recordLevel(`${foldTag("g:x")} [task-archived] l/1 "T" done; recall the code for its record and transcript.`)).toBe(2);
		expect(recordLevel(`${foldTag("g:x")} [task-record] l/1 "T"  status: done · x · recall ${foldTag("g:x")} instead of re-reading\n[retained-task-pins 4]\nrule`)).toBe(1);
		expect(recordLevel("plain")).toBeNull();
	});
});
