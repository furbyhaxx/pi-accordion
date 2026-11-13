import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { estTokens } from "./tokens";
import { expireRecall } from "./recallExpiry";
import { RECALL_POLICY, RecallAccount, serveRecall } from "./recallAccount";
import { foldCode, foldTag } from "./digest";
import type { Block } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

class Log {
	readonly blocks: Block[] = [];
	private resp = 0;
	private push(b: Pick<Block, "id" | "kind" | "text"> & Partial<Block>): Block {
		const block: Block = { turn: 1, tokens: estTokens(b.text), override: null, autoFolded: false, by: null, ...b, order: this.blocks.length };
		this.blocks.push(block);
		return block;
	}
	user(text: string) { return this.push({ id: `u:${this.blocks.length}`, kind: "user", text }); }
	call(tool: string, args: Record<string, unknown>, out: string): Block {
		const r = ++this.resp;
		this.push({ id: `a:resp${r}:p0`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: `c${r}` });
		return this.push({ id: `r:c${r}`, kind: "tool_result", text: out, toolName: tool, callId: `c${r}` });
	}
	/** One assistant message with several recall calls, as a model issues them in parallel. */
	parallelRecalls(n: number, size: number): Block[] {
		const r = ++this.resp;
		for (let j = 0; j < n; j++) this.push({ id: `a:resp${r}:p${j}`, kind: "tool_call", text: `recall ${JSON.stringify({ codes: [`aaaaa${j}`] })}`, toolName: "recall", callId: `c${r}-${j}` });
		return Array.from({ length: n }, (_, j) => this.push({ id: `r:c${r}-${j}`, kind: "tool_result", text: "recalled ".repeat(size), toolName: "recall", callId: `c${r}-${j}` }));
	}
	truth(): Truth {
		const t = new Truth({ meta: META, blocks: this.blocks, lineCount: 0, skipped: 0 });
		t.setProtect(0);
		t.setBudget(400_000);
		return t;
	}
}

const BIG = "recalled text ".repeat(2_000);

describe("expireRecall", () => {
	it("replaces used results by a line naming the call, in one transaction, and leaves recent ones", () => {
		const log = new Log();
		log.user("Go.");
		const a = log.call("recall", { codes: ["abc123"], query: "p95 latency" }, BIG);
		const b = log.call("recall", { codes: ["def456.7"], page: 2 }, BIG);
		log.call("bash", { command: "ls" }, "x");
		log.call("bash", { command: "ls" }, "x");
		const recent = log.call("recall", { query: "ECONNREFUSED" }, BIG);
		log.call("bash", { command: "ls" }, "x");
		const t = log.truth();
		const revBefore = t.stats().rev;
		const ops = expireRecall(t, { keepSteps: 3 });
		expect(ops.map((o) => (o as { id: string }).id)).toEqual([a.id, b.id]);
		const r = t.apply(ops, "auto");
		expect(r.results.every((x) => x.applied)).toBe(true);
		expect(t.stats().rev).toBe(revBefore + 1);
		expect(t.digestOf(t.get(a.id)!)).toBe('[recall of #abc123 query "p95 latency" released to free context; run it again if you still need it]');
		expect(t.digestOf(t.get(b.id)!)).toBe("[recall of #def456.7 page 2 released to free context; run it again if you still need it]");
		expect(t.isFolded(t.get(recent.id)!)).toBe(false);
		// A released result offers no fold code: there is nothing to recall from a recall.
		expect(t.digestOf(t.get(a.id)!)).not.toContain("FOLDED}");
		expect(expireRecall(t, { keepSteps: 3 })).toEqual([]);
	});

	it("leaves results of the running prompt alone when none is used, and releases earlier prompts on request", () => {
		const log = new Log();
		log.user("First.");
		const old = log.call("recall", { codes: ["abc123"] }, BIG);
		log.user("Second.");
		const fresh = log.parallelRecalls(2, 4_000);
		const t = log.truth();
		expect(expireRecall(t, { keepSteps: 3 })).toEqual([]);
		const ops = expireRecall(t, { keepSteps: 3, earlierPrompts: true });
		expect(ops.map((o) => (o as { id: string }).id)).toEqual([old.id]);
		expect(ops.some((o) => fresh.some((f) => f.id === (o as { id: string }).id))).toBe(false);
	});

	it("never touches a result the human holds, other tools' results or small results", () => {
		const log = new Log();
		log.user("Go.");
		const held = log.call("recall", { codes: ["abc123"] }, BIG);
		const other = log.call("bash", { command: "cat big.log" }, BIG);
		const small = log.call("recall", { codes: ["abc123"] }, "No folded content for: #abc123");
		for (let i = 0; i < 4; i++) log.call("bash", { command: "ls" }, "x");
		const t = log.truth();
		t.apply([{ kind: "pin", ids: [held.id] }], "you");
		expect(expireRecall(t, { keepSteps: 3 })).toEqual([]);
		expect(t.isFolded(t.get(other.id)!)).toBe(false);
		expect(t.isFolded(t.get(small.id)!)).toBe(false);
	});

	it("gives a refused call room: the account serves again after used results were released", () => {
		const log = new Log();
		log.user("Go.");
		const filler = log.call("bash", { command: "cat" }, "archive entry ".repeat(40_000));
		const first = log.blocks.find((b) => b.id === "a:resp1:p0")!;
		log.user("Next.");
		for (let i = 0; i < 3; i++) log.call("recall", { codes: ["zzzzzz"] }, "r".repeat(RECALL_POLICY.callTokens * 4 - 40));
		for (let i = 0; i < 3; i++) log.call("bash", { command: "ls" }, "x");
		const t = log.truth();
		expect(t.apply([{ kind: "group", ids: [first.id, filler.id], summary: `${foldTag(`g:${first.id}`)} done` }], "auto").results[0].applied).toBe(true);
		const account = new RecallAccount();
		const code = `${foldCode(`g:${first.id}`)}.2`;
		expect(serveRecall(t, account, "x1", { codes: [code] }).view).toBeNull();
		let transactions = 0;
		const served = serveRecall(t, account, "x2", { codes: [code] }, () => {
			const ops = expireRecall(t, { keepSteps: 3, earlierPrompts: true });
			if (ops.length) { t.apply(ops, "auto"); transactions++; }
		});
		expect(served.view).not.toBeNull();
		expect(transactions).toBe(1);
		expect(account.outstanding(t)).toBeLessThanOrEqual(RECALL_POLICY.liveTokens);
	});
});
