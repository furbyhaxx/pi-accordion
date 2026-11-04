/*
 * taskfold.test.ts — driven through `TestHost` (a real `Truth`), so every proposed group is vetted
 * by the same predicates a live session enforces. Sessions use durable ids (`u:`/`a:…:p<j>`/`r:<callId>`).
 */
import { describe, it, expect } from "vitest";
import { TaskfoldConductor } from "./taskfold";
import { TestHost } from "../../../core/conductor/testhost";
import { foldCode, foldTag } from "../../../core/digest";
import type { Block } from "../../../core/types";

class Session {
	readonly blocks: Block[] = [];
	private order = 0;
	private resp = 0;
	private turn = 0;

	private push(b: Omit<Block, "order" | "turn" | "tokens" | "override" | "autoFolded" | "by">): string {
		this.blocks.push({ ...b, order: this.order++, turn: this.turn, tokens: Math.ceil(b.text.length / 4), override: null, autoFolded: false, by: null });
		return b.id;
	}
	user(text: string): string {
		this.turn++;
		return this.push({ id: `u:${1000 + this.order}`, kind: "user", text });
	}
	call(tool: string, args: Record<string, unknown>, out: string, isError = false): { call: string; result: string } {
		const r = ++this.resp;
		const callId = `c${r}`;
		this.push({ id: `a:resp${r}:p0`, kind: "thinking", text: "x".repeat(400) });
		const call = this.push({ id: `a:resp${r}:p1`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId });
		const result = this.push({ id: `r:${callId}`, kind: "tool_result", text: out, toolName: tool, callId, isError });
		return { call, result };
	}
	start(id: string, title: string) {
		return this.call("tasks", { action: "start", list: "work", id }, `Started work/${id} "${title}".`);
	}
	finish(id: string, report: Record<string, unknown>, action = "complete") {
		return this.call("tasks", { action, list: "work", id, report }, `work/${id} is done.`);
	}
	work(n: number, tag: string) {
		for (let i = 0; i < n; i++) this.call("bash", { command: `cat big-${tag}-${i}.log` }, `${tag} `.repeat(600));
	}
}

function setup(s: Session, budgetFactor = 0.7): TestHost {
	const host = new TestHost();
	host.appendBlocks(s.blocks);
	host.setProtect(200);
	host.setBudget(Math.ceil(host.stats().liveTokens * budgetFactor));
	return host;
}

async function attach(host: TestHost): Promise<TaskfoldConductor> {
	const c = new TaskfoldConductor();
	c.attach(host);
	await host.commitTurn();
	return c;
}

const groupOf = (h: TestHost, id: string) => h.groups().find((g) => g.memberIds.includes(id));

/** A finished task 1, then unrelated tail work so task 1 sits outside the protected tail. */
function oneTask(between?: (s: Session) => void): { s: Session; start: string; end: string } {
	const s = new Session();
	s.user("Fix the parser.");
	const start = s.start("1", "Fix parser").call;
	s.work(2, "a");
	s.call("edit", { path: "src/parse.ts", oldText: "a", newText: "b" }, "Successfully replaced text in src/parse.ts.");
	between?.(s);
	s.call("bash", { command: "npm test" }, "12 passed");
	const end = s.finish("1", { outcome: "Parser handles CRLF.", decisions: ["normalize at read — one place"] }).result;
	s.work(3, "tail");
	return { s, start, end };
}

describe("taskfold", () => {
	it("folds a finished span into a recallable task record once over HIGH", async () => {
		const { s, start, end } = oneTask();
		const host = setup(s);
		await attach(host);
		const g = groupOf(host, start);
		expect(g).toBeDefined();
		expect(g!.memberIds).toContain(end);
		expect(g!.summary).toMatch(new RegExp(`^\\{#${foldCode(g!.id)} FOLDED\\} \\[task-record\\] work/1 "Fix parser"  status: done`));
		expect(g!.summary).toContain("outcome: Parser handles CRLF.");
		expect(g!.summary).toContain("  - normalize at read — one place");
		expect(g!.summary).toContain("changed: src/parse.ts");
		expect(g!.summary).toContain("`npm test` → ok");
		expect(g!.summary!.startsWith(foldTag(g!.id))).toBe(true);
	});

	it("does nothing below HIGH", async () => {
		const { s, start } = oneTask();
		const host = setup(s, 2);
		await attach(host);
		expect(groupOf(host, start)).toBeUndefined();
	});

	it("keeps an unclassified user message verbatim and splits the span around it", async () => {
		const steer = (s: Session) => s.user("Don't touch the lexer.");
		const { s, start, end } = oneTask(steer);
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("lexer"))!.id;
		const host = setup(s);
		await attach(host);
		expect(groupOf(host, userId)).toBeUndefined();
		const first = groupOf(host, start)!;
		const last = groupOf(host, end)!;
		expect(first.id).not.toBe(last.id);
		expect(first.summary).toContain("[task-part] work/1");
		expect(last.summary).toContain("[task-record] work/1");
	});

	it("folds classified steering into the span and lifts it into constraints", async () => {
		const { s, start, end } = oneTask((s) => s.user("Don't touch the lexer."));
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("lexer"))!.id;
		const host = new TestHost();
		host.classifier = () => ({ answers: { kind: { type: "choice", choice: "steering", probabilities: { steering: 0.9 }, confidence: 0.9 } }, model: "test/cls" });
		const c = new TaskfoldConductor();
		c.attach(host);
		host.appendBlocks(s.blocks);
		host.setProtect(200);
		await new Promise((r) => setTimeout(r, 0));
		expect(host.classifyLog.map((r) => r.state.message)).toContain("Don't touch the lexer.");
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		const g = groupOf(host, start)!;
		expect(g.memberIds).toContain(userId);
		expect(g.memberIds).toContain(end);
		expect(g.summary).toContain("constraints:\n  - Don't touch the lexer.");
	});

	it("keeps a low-confidence user message verbatim", async () => {
		const { s } = oneTask((s) => s.user("Don't touch the lexer."));
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("lexer"))!.id;
		const host = new TestHost();
		host.classifier = () => ({ answers: { kind: { type: "choice", choice: "steering", probabilities: { steering: 0.4 }, confidence: 0.4 } }, model: "test/cls" });
		new TaskfoldConductor().attach(host);
		host.appendBlocks(s.blocks);
		host.setProtect(200);
		await new Promise((r) => setTimeout(r, 0));
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		expect(groupOf(host, userId)).toBeUndefined();
	});

	it("absorbs a folded child span when its parent finishes", async () => {
		const s = new Session();
		s.user("Refactor auth.");
		const parentStart = s.start("1", "Refactor auth").call;
		const childStart = s.start("1.1", "Extract token store").call;
		s.work(2, "child");
		const childEnd = s.finish("1.1", { outcome: "Token store extracted." }).result;
		s.work(3, "mid");
		const host = setup(s, 0.75);
		const c = await attach(host);
		const child = groupOf(host, childStart)!;
		expect(child.summary).toContain("[task-record] work/1.1");
		expect(groupOf(host, parentStart)).toBeUndefined();

		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.work(1, "late");
		const parentEnd = more.finish("1", { outcome: "Auth refactored." }).result;
		more.work(3, "tail2");
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		const parent = groupOf(host, parentStart)!;
		expect(parent.memberIds).toEqual(expect.arrayContaining([childStart, childEnd, parentEnd]));
		expect(parent.summary).toContain("[task-record] work/1 ");
		expect(parent.summary).toContain('children:\n  - 1.1 "Extract token store" done: Token store extracted.');
		expect(host.groups().filter((g) => g.summary?.includes("[task-record] work/1.1"))).toHaveLength(0);
		c.detach();
	});

	it("ignores a rejected finish call", async () => {
		const s = new Session();
		s.user("Go.");
		const start = s.start("1", "Thing").call;
		s.work(2, "a");
		s.call("tasks", { action: "complete", list: "work", id: "1" }, "A report is required", true);
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		expect(groupOf(host, start)).toBeUndefined();
	});
});
