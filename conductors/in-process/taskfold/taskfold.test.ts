/*
 * taskfold.test.ts — driven through `TestHost` (a real `Truth`), so every proposed group is vetted
 * by the same predicates a live session enforces. Sessions use durable ids (`u:`/`a:…:p<j>`/`r:<callId>`).
 */
import { describe, it, expect } from "vitest";
import { TaskfoldConductor, ageRecord, scanTaskSpans, taskKeyOfSummary } from "./taskfold";
import { TestHost } from "../../../core/conductor/testhost";
import { VERDICT_ENTRY, VerdictLedger, verdictsOf, type Verdict } from "./verdicts";
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
	text(text: string): string {
		return this.push({ id: `a:resp${++this.resp}:p0`, kind: "text", text });
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
	/** Several tool calls in ONE assistant message, e.g. `complete A` and `start B` batched together. */
	batch(calls: [string, Record<string, unknown>, string][]): { calls: string[]; results: string[] } {
		const r = ++this.resp;
		this.push({ id: `a:resp${r}:p0`, kind: "thinking", text: "x".repeat(400) });
		const ids = calls.map(([tool, args], j) => this.push({ id: `a:resp${r}:p${j + 1}`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: `c${r}-${j}` }));
		const results = calls.map(([tool, , out], j) => this.push({ id: `r:c${r}-${j}`, kind: "tool_result", text: out, toolName: tool, callId: `c${r}-${j}` }));
		return { calls: ids, results };
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
	const c = new TaskfoldConductor({ keepRecentTasks: 0 });
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

	it("folds a user message the classifier scores as costing nothing, with goal-aware context", async () => {
		const { s, start, end } = oneTask((s) => {
			s.text("Tests pass; shall I commit?");
			s.user("ok, commit it");
		});
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("commit"))!.id;
		const host = new TestHost();
		host.classifier = () => ({ answers: { loss: { type: "score", score: 0.1, confidence: 0.9 } }, model: "test/cls" });
		const c = new TaskfoldConductor({ keepRecentTasks: 0 });
		c.attach(host);
		host.appendBlocks(s.blocks);
		host.setProtect(200);
		await new Promise((r) => setTimeout(r, 0));
		expect(host.classifyLog).toHaveLength(1);
		expect(host.classifyLog[0].state).toEqual({
			session_goal: "Fix the parser.",
			previous_user_message: "",
			assistant_last_reply: "Tests pass; shall I commit?",
			message: "ok, commit it",
		});
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		const g = groupOf(host, start)!;
		expect(g.memberIds).toContain(userId);
		expect(g.memberIds).toContain(end);
	});

	it("records verdicts once and reuses a resumed session's verdicts without classifying again", async () => {
		const build = () =>
			oneTask((s) => {
				s.text("Tests pass; shall I commit?");
				s.user("ok, commit it");
			});
		const { s } = build();
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("commit"))!.id;
		const recorded: [string, Verdict][] = [];
		const ledger = new VerdictLedger();
		ledger.reset(new Map(), (id, v) => recorded.push([id, v]));
		const host = new TestHost();
		host.classifier = () => ({ answers: { loss: { type: "score", score: 0.1, confidence: 0.9 } }, model: "test/cls" });
		new TaskfoldConductor({ keepRecentTasks: 0 }, ledger).attach(host);
		host.appendBlocks(s.blocks);
		await new Promise((r) => setTimeout(r, 0));
		const opening = s.blocks.find((b) => b.kind === "user")!.id;
		expect(recorded).toEqual([
			[opening, { loss: null, source: "opening" }],
			[userId, expect.objectContaining({ loss: 0.1, source: "classifier", confidence: 0.9, model: "test/cls" })],
		]);
		expect(ledger.threshold).toBe(0.3);

		const entries = recorded.map(([id, v]) => ({ type: "custom", customType: VERDICT_ENTRY, data: { id, ...v } }));
		const resumed = new VerdictLedger();
		resumed.reset(verdictsOf(entries), () => {});
		const next = new TestHost();
		next.classifier = () => ({ answers: { loss: { type: "score", score: 2, confidence: 0.9 } }, model: "test/cls" });
		new TaskfoldConductor({ keepRecentTasks: 0 }, resumed).attach(next);
		next.appendBlocks(build().s.blocks);
		await new Promise((r) => setTimeout(r, 0));
		expect(next.classifyLog).toHaveLength(0);
		expect(resumed.get(userId)).toMatchObject({ loss: 0.1, source: "classifier", confidence: 0.9, model: "test/cls" });
	});

	it("keeps a user message whose loss reaches maxLoss verbatim", async () => {
		const { s } = oneTask((s) => s.user("Don't touch the lexer."));
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("lexer"))!.id;
		const host = new TestHost();
		host.classifier = () => ({ answers: { loss: { type: "score", score: 2, confidence: 0.8 } }, model: "test/cls" });
		new TaskfoldConductor({ keepRecentTasks: 0 }).attach(host);
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

	it("scans open spans to the last block after finished ones, and keys records by their tag", () => {
		const s = new Session();
		s.user("Do both.");
		s.start("1", "Outer");
		s.start("1.1", "Inner");
		s.finish("1.1", { outcome: "inner done" });
		s.work(1, "x");
		const spans = scanTaskSpans(s.blocks, (b) => b.text);
		expect(spans.map((x) => [x.key, x.status, x.title])).toEqual([
			["work/1.1", "done", "Inner"],
			["work/1", null, "Outer"],
		]);
		expect(spans[1].end).toBe(s.blocks.length - 1);
		expect(taskKeyOfSummary(`${foldTag("g:x")} [task-record] work/1.1 "Inner"  status: done`)).toBe("work/1.1");
		expect(taskKeyOfSummary("plain summary")).toBeNull();
	});

	it("opens auto-started parents with the subtask and ends auto-closed parents before the moving-on call", () => {
		const s = new Session();
		s.user("Go.");
		const first = s.call("tasks", { action: "start", list: "work", id: "1.1" }, 'Started work/1.1 "A1".\nAlso started parent 1 "A" so its span covers this subtask.').call;
		s.work(1, "a");
		s.finish("1.1", { outcome: "a1" });
		const next = s.call("tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "B".\nClosed 1 "A" as done from its subtasks\' reports, because you moved on.').call;
		const spans = scanTaskSpans(s.blocks, (b) => b.text);
		const one = spans.find((x) => x.key === "work/1")!;
		const idx = (id: string) => s.blocks.findIndex((b) => b.id === id);
		expect(one).toMatchObject({ title: "A", status: "done", start: idx(first) });
		expect(one.end).toBe(idx(next) - 1);
		expect(spans.find((x) => x.key === "work/2")).toMatchObject({ title: "B", status: null, start: idx(next) });
	});

	it("keeps the newest finished task open by default and folds the older ones", async () => {
		const s = new Session();
		s.user("Two things.");
		const a = s.start("1", "First").call;
		s.work(3, "a");
		s.finish("1", { outcome: "first done" });
		const b = s.start("2", "Second").call;
		s.work(3, "b");
		s.finish("2", { outcome: "second done" });
		s.work(2, "tail");
		const host = setup(s, 0.5);
		const c = new TaskfoldConductor();
		c.attach(host);
		await host.commitTurn();
		expect(groupOf(host, a)?.summary).toContain("[task-record] work/1 ");
		expect(groupOf(host, b)).toBeUndefined();
		c.detach();
	});

	it("folds both tasks when `complete A` and `start B` share one assistant message", async () => {
		const s = new Session();
		s.user("Go.");
		const a = s.start("1", "First").call;
		s.work(3, "a");
		const shared = s.batch([
			["tasks", { action: "complete", list: "work", id: "1", report: { outcome: "first" } }, "work/1 is done."],
			["tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "Second".'],
		]);
		s.work(3, "b");
		const bEnd = s.finish("2", { outcome: "second" }).result;
		s.work(3, "tail");
		const host = setup(s, 0.4);
		await attach(host);
		const first = groupOf(host, a)!;
		const second = groupOf(host, bEnd)!;
		expect(first.summary).toContain("[task-record] work/1 ");
		expect(first.memberIds).toContain(shared.calls[1]);
		expect(second.summary).toContain("[task-record] work/2 ");
		expect(second.memberIds).not.toContain(shared.calls[1]);
		expect(second.memberIds).toContain(shared.results[1]);
	});

	it("ages records oldest first, keeping fold codes and the newest record whole", () => {
		const full = `${foldTag("g:x")} [task-record] work/1 "First"  status: done\noutcome: It works.\ndecisions:\n  - a — b`;
		const one = ageRecord(full, 1)!;
		expect(one).toBe(`${foldTag("g:x")} [task-record] work/1 "First"  status: done · It works.`);
		expect(ageRecord(one, 1)).toBe(one);
		const stub = ageRecord(one, 2)!;
		expect(stub).toBe(`${foldTag("g:x")} [task-archived] work/1 "First" done; recall the code for its record and transcript.`);
		expect(taskKeyOfSummary(stub)).toBe("work/1");
		expect(ageRecord("plain", 1)).toBeNull();
	});

	it("shortens older records when folding every finished span is not enough", async () => {
		const s = new Session();
		s.user("Many.");
		const starts: string[] = [];
		for (const id of ["1", "2", "3", "4"]) {
			starts.push(s.start(id, `Task ${id}`).call);
			s.work(2, `w${id}`);
			s.finish(id, { outcome: `${id} done`, decisions: [`decision for ${id} — ${"why ".repeat(30)}`], open: ["x ".repeat(40)] });
		}
		s.work(2, "tail");
		const host = setup(s, 0.6);
		const c = new TaskfoldConductor({ keepRecentTasks: 0 });
		c.attach(host);
		await host.commitTurn();
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.8));
		await host.commitTurn();
		const summaries = starts.map((id) => groupOf(host, id)?.summary ?? "");
		expect(summaries[0]).not.toContain("\n");
		expect(summaries[3]).toContain("\noutcome: 4 done");
		expect(summaries.every((x, i) => taskKeyOfSummary(x) === `work/${i + 1}`)).toBe(true);
		c.detach();
	});
});

