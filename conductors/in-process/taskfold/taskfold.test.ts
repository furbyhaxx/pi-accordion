/*
 * taskfold.test.ts — driven through `TestHost` (a real `Truth`), so every proposed group is vetted
 * by the same predicates a live session enforces. Sessions use durable ids (`u:`/`a:…:p<j>`/`r:<callId>`).
 */
import { describe, it, expect } from "vitest";
import { foldedTaskIds, foldedTaskTokens } from "../../../extension/tui/taskWidget";
import { TaskfoldConductor, ageRecord, condenseChildren, scanTaskSpans, staleSpans, taskKeyOfSummary } from "./taskfold";
import { TestHost } from "../../../core/conductor/testhost";
import { UNFOLD_ENTRY, VERDICT_ENTRY, VerdictLedger, unfoldStatesOf, verdictsOf, type Verdict } from "./verdicts";
import { foldCode, foldTag } from "../../../core/digest";
import { resolveRecall, resolveUnfold } from "../../../core/agentView";
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
	call(tool: string, args: Record<string, unknown>, out: string, isError = false, details?: unknown): { call: string; result: string } {
		const r = ++this.resp;
		const callId = `c${r}`;
		this.push({ id: `a:resp${r}:p0`, kind: "thinking", text: "x".repeat(400) });
		const call = this.push({ id: `a:resp${r}:p1`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId });
		const result = this.push({ id: `r:${callId}`, kind: "tool_result", text: out, toolName: tool, callId, isError, ...(details === undefined ? {} : { details }) });
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
	it("opens and closes spans from task events recorded on a codemode result", async () => {
		const s = new Session();
		s.user("Batch the bookkeeping.");
		const t = (id: string, title: string, status: string, report?: object) => ({ id, title, status, ...(report ? { report } : {}) });
		const startA = s.call("codemode", { code: "tasks start 1" }, "ok", false, { taskEvents: [{ action: "start", list: "work", id: "1", started: [t("1", "Task A", "doing")] }] }).call;
		s.work(3, "a-work");
		const handoff = s.call("codemode", { code: "tasks complete 1; tasks start 2" }, "ok", false, { taskEvents: [
			{ action: "complete", list: "work", id: "1", task: t("1", "Task A", "done", { outcome: "A is finished." }) },
			{ action: "start", list: "work", id: "2", started: [t("2", "Task B", "doing")] },
		] });
		s.work(3, "b-work");
		const spans = scanTaskSpans(s.blocks, (b) => b.text);
		const a = spans.find((x) => x.key === "work/1")!;
		const bSpan = spans.find((x) => x.key === "work/2")!;
		expect(a.status).toBe("done");
		expect(a.report.outcome).toBe("A is finished.");
		expect(s.blocks[a.end].id).toBe(handoff.result);
		expect(bSpan.status).toBeNull();
		expect(bSpan.start).toBe(a.end + 1);
		expect(bSpan.title).toBe("Task B");
		const host = setup(s, 0.5);
		await attach(host);
		expect(taskKeyOfSummary(groupOf(host, startA)?.summary)).toBe("work/1");
		expect(groupOf(host, handoff.result)?.memberIds).toContain(startA);
	});

	it("reports an open span that other tasks left behind as stale", () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Forgotten");
		s.work(2, "x");
		s.start("2", "Sibling");
		s.work(5, "y");
		s.finish("2", { outcome: "ok" });
		const spans = scanTaskSpans(s.blocks, (b) => b.text);
		expect(staleSpans(spans, s.blocks, 5).map((x) => x.key)).toEqual(["work/1"]);
		expect(staleSpans(spans, s.blocks, 50)).toEqual([]);
		const parent = new Session();
		parent.user("Go.");
		parent.start("1", "Parent");
		parent.start("1.1", "Child");
		parent.work(6, "c");
		parent.finish("1.1", { outcome: "ok" });
		expect(staleSpans(scanTaskSpans(parent.blocks, (b) => b.text), parent.blocks, 3)).toEqual([]);
	});

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

	it("falls back to finished descendants when historical parent intervals cannot cover them", async () => {
		const s = new Session();
		s.user("Continue an old list without rewriting its history.");
		s.start("1", "Already ended parent");
		s.work(1, "parent");
		s.finish("1", { outcome: "Parent ended before later work was added." });
		const child = s.start("1.1", "Later child").call;
		s.work(4, "safe-child");
		s.finish("1.1", { outcome: "Later work is complete." });
		s.work(3, "tail");
		const host = setup(s, 0.6);
		const conductor = await attach(host);
		expect(taskKeyOfSummary(groupOf(host, child)?.summary)).toBe("work/1.1");
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(JSON.stringify(recalled)).toContain("safe-child");
		conductor.detach();
	});

	it("re-proposes a task after protected-tail growth prunes its group", async () => {
		const { s, start } = oneTask();
		const host = setup(s);
		await attach(host);
		expect(groupOf(host, start)).toBeDefined();
		host.setProtect(host.stats().fullTokens * 2);
		expect(groupOf(host, start)).toBeUndefined();
		host.setProtect(200);
		await host.commitTurn();
		expect(taskKeyOfSummary(groupOf(host, start)?.summary)).toBe("work/1");
		expect(resolveRecall(host.truth, [foldCode("t:work/1")]).missing).toEqual([]);
	});

	it("folds long untracked runs without swallowing user messages or work in an open task", async () => {
		const s = new Session();
		const opening = s.user("Go.");
		s.work(9, "outside");
		const steering = s.user("Keep this instruction.");
		const open = s.start("1", "Still working").call;
		s.work(10, "inside");
		const host = setup(s, 0.35);
		await attach(host);
		const untracked = host.groups().find((g) => g.summary?.includes("[untracked-work]"));
		expect(untracked).toBeDefined();
		expect(untracked!.memberIds).not.toContain(opening);
		expect(untracked!.memberIds).not.toContain(steering);
		expect(groupOf(host, open)).toBeUndefined();
		expect(resolveRecall(host.truth, [foldCode(untracked!.id)]).missing).toEqual([]);
	});

	it("does not fold short untracked runs or run the fallback when disabled", async () => {
		const s = new Session();
		s.user("Go.");
		s.work(7, "short");
		s.user("Continue.");
		s.work(1, "tail");
		const host = setup(s, 0.3);
		await attach(host);
		expect(host.groups()).toHaveLength(0);
		const long = new Session();
		long.user("Go.");
		long.work(12, "long");
		const disabled = setup(long, 0.3);
		new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minSteps: 8 } }).attach(disabled);
		await disabled.commitTurn();
		expect(disabled.groups()).toHaveLength(0);
	});

	it("preserves document reads inside an untracked run", async () => {
		const s = new Session();
		s.user("Go.");
		s.work(9, "outside");
		const doc = s.call("read", { path: "docs/spec.md" }, "important rules");
		s.work(9, "later");
		const host = setup(s, 0.3);
		await attach(host);
		expect(host.groups().some((g) => g.summary?.includes("[untracked-work]"))).toBe(true);
		expect(groupOf(host, doc.call)).toBeUndefined();
		expect(groupOf(host, doc.result)).toBeUndefined();
	});

	it("combines finished-task groups and open-task floor folds in one proposal", async () => {
		const s = new Session();
		s.user("Go.");
		const finished = s.start("1", "Finished").call;
		s.work(3, "done");
		s.finish("1", { outcome: "done" });
		const open = s.start("2", "Open").call;
		const doc = s.call("read", { path: "docs/spec.md" }, "Important policy");
		s.work(12, "open");
		const host = setup(s, 0.5);
		const proposals: string[][] = [];
		const propose = host.propose.bind(host);
		host.propose = (txn) => { proposals.push(txn.ops.map((op) => op.kind)); return propose(txn); };
		new TaskfoldConductor({ keepRecentTasks: 0, floor: true, untracked: { enabled: false, minSteps: 8 } }).attach(host);
		await host.commitTurn();
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toContain("group");
		expect(proposals[0].some((kind) => kind === "replace" || kind === "fold")).toBe(true);
		expect(groupOf(host, finished)?.summary).toContain("[task-record] work/1");
		expect(groupOf(host, open)).toBeUndefined();
		expect(host.truth.isFolded(host.truth.get(doc.result)!)).toBe(false);
		expect(host.blocks().filter((b) => b.protected).every((b) => !b.folded)).toBe(true);
	});

	it("reports the largest open task when no safe folding can relieve pressure", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Long task");
		s.work(12, "open");
		const host = setup(s, 0.3);
		await attach(host);
		const last = host.statusLog.at(-1);
		expect(last?.text).toContain("open task work/1");
		expect(last?.metrics?.level).toBe("error");
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
		const oldChildCode = foldCode(child.id);
		expect(child.summary).toContain("[task-record] work/1.1");
		expect(groupOf(host, parentStart)).toBeUndefined();

		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.work(1, "late");
		const parentEnd = more.finish("1", { outcome: "Auth refactored." }).result;
		more.work(3, "tail2");
		host.setBudget(host.stats().liveTokens * 10);
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 1.2));
		await host.commitTurn();
		const parent = groupOf(host, parentStart)!;
		expect(parent.memberIds).toEqual(expect.arrayContaining([childStart, childEnd, parentEnd]));
		expect(parent.summary).toContain("[task-record] work/1 ");
		for (const line of child.summary!.split("\n")) expect(parent.summary).toContain(`  ${line}`);
		expect(parent.summary).toContain(foldTag("t:work/1.1"));
		expect(parent.summary).toContain("outcome: Token store extracted.");
		expect(groupOf(host, childStart)?.id).toBe(parent.id);
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(childStart);
		expect(recalled.restored[0].ids).toContain(childEnd);
		expect(resolveRecall(host.truth, [oldChildCode]).missing).toEqual([]);
		c.detach();
	});

	it("does not recreate full detail when an already-aged child is absorbed", async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		const child = s.start("1.1", "Child").call;
		s.work(2, "child");
		s.finish("1.1", { outcome: "done", decisions: ["Aged detail"] });
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const old = groupOf(host, child)!;
		const aged = ageRecord(old.summary!, 1)!;
		host.truth.apply([{ kind: "ungroup", groupId: old.id }, { kind: "group", ids: [...old.memberIds], summary: aged, handles: old.handles?.map((h) => ({ id: h.id, memberIds: [...h.memberIds] })) }], "auto");
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.finish("1", { outcome: "parent done" });
		more.work(3, "tail2");
		host.setBudget(host.stats().liveTokens * 10);
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 1.2));
		await host.commitTurn();
		const summary = groupOf(host, parent)?.summary ?? "";
		expect(summary).toContain(aged);
		expect(summary).not.toContain("Aged detail");
		expect(resolveRecall(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
	});

	it("composes complete child reports and preserves child handles across a kept user message", async () => {
		const s = new Session();
		s.user("Refactor auth.");
		const parentStart = s.start("1", "Auth").call;
		const childStart = s.start("1.1", "Store").call;
		s.call("edit", { path: "child.ts" }, "edited");
		const message = s.user("Keep the interface stable.");
		s.work(1, "child");
		const childEnd = s.finish("1.1", { outcome: "Store ready", decisions: ["Keep interface — clients rely on it"], open: ["Refresh still untested"] }).result;
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const firstCode = foldCode(groupOf(host, childStart)!.id);
		const lastCode = foldCode(groupOf(host, childEnd)!.id);
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.call("edit", { path: "parent.ts" }, "edited");
		const parentEnd = more.finish("1", { outcome: "Auth ready" }).result;
		more.work(3, "tail2");
		host.setBudget(host.stats().liveTokens * 10);
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 1.2));
		await host.commitTurn();
		const record = groupOf(host, parentEnd)!;
		expect(groupOf(host, parentStart)?.summary).toContain("[task-part] work/1");
		expect(record.summary).toContain("Keep interface — clients rely on it");
		expect(record.summary).toContain("Refresh still untested");
		expect(record.summary).toContain("changed: parent.ts");
		expect(record.summary).toContain("changed: child.ts");
		expect(groupOf(host, message)).toBeUndefined();
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1"), firstCode, lastCode]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored.find((r) => r.code === foldCode("t:work/1.1"))?.ids).toContain(message);
	});

	it("keeps nested child records and precise descendant recall in a folded three-level tree", async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		s.start("1.1", "First child");
		const leaf = s.start("1.1.1", "Leaf").call;
		s.call("edit", { path: "leaf.ts" }, "edited");
		s.finish("1.1.1", { outcome: "Leaf done", decisions: ["A — reason"] });
		s.finish("1.1", { outcome: "First done", open: ["Pending review"] });
		for (const id of ["1.2", "1.3"]) {
			s.start(id, `Child ${id}`);
			s.work(1, id);
			s.finish(id, { outcome: `${id} done` });
		}
		s.finish("1", { outcome: "Parent done" });
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const summary = groupOf(host, parent)?.summary ?? "";
		for (const id of ["1.1", "1.1.1", "1.2", "1.3"]) expect(summary).toContain(foldTag(`t:work/${id}`));
		expect(summary).toContain("A — reason");
		expect(summary).toContain("Pending review");
		expect(summary).toContain("changed: leaf.ts");
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(leaf);
		expect(recalled.restored[0].ids).not.toContain(parent);
	});

	it("rolls back partial parent groups and restores children when its record is rejected", async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		const child = s.start("1.1", "Child").call;
		s.work(1, "child");
		s.finish("1.1", { outcome: "done" });
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const old = groupOf(host, child)!;
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.user("Preserve this message.");
		more.work(1, "parent");
		more.finish("1", { outcome: "parent done" });
		more.work(3, "tail2");
		host.setBudget(host.stats().liveTokens * 10);
		host.appendBlocks(more.blocks);
		const propose = host.propose.bind(host);
		host.propose = async (txn) => {
			const index = txn.ops.findIndex((op) => op.kind === "group" && typeof op.summary === "string" && op.summary.includes('[task-record] work/1 "Parent"'));
			if (index < 0) return propose(txn);
			const result = await propose({ ...txn, ops: txn.ops.filter((_op, i) => i !== index) });
			result.results.splice(index, 0, { op: txn.ops[index], applied: false, clamped: "invalid-group" });
			return result;
		};
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		expect(groupOf(host, parent)).toBeUndefined();
		expect(groupOf(host, child)?.id).toBe(old.id);
		expect(groupOf(host, child)?.summary).toBe(old.summary);
	});

	for (const actor of ["agent", "you"] as const) it(`${actor} unfolds one child while its siblings refold below the pressure threshold`, async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		const first = s.start("1.1", "First").call;
		s.work(1, "first");
		s.finish("1.1", { outcome: "First done" });
		const second = s.start("1.2", "Second").call;
		s.work(1, "second");
		s.finish("1.2", { outcome: "Second done" });
		s.finish("1", { outcome: "Parent done" });
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		expect(groupOf(host, parent)?.summary).toContain('[task-record] work/1 ');
		host.setBudget(host.stats().liveTokens * 10);
		if (actor === "agent") expect(resolveUnfold(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
		else {
			const group = host.truth.groups.find((g) => g.folded && g.handles?.some((h) => h.id === "t:work/1.1"))!;
			const ids = group.handles!.find((h) => h.id === "t:work/1.1")!.memberIds;
			expect(host.truth.apply([{ kind: "unfoldGroup", groupId: group.id, handleId: "t:work/1.1" }, { kind: "unfold", ids }], actor).results.every((r) => r.applied)).toBe(true);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(groupOf(host, parent)).toBeUndefined();
		expect(groupOf(host, first)).toBeUndefined();
		expect(groupOf(host, second)?.summary).toContain('[task-record] work/1.2 ');
		const list = { slug: "work", title: "Work", createdAt: "", updatedAt: "", claim: null,
			tasks: ["1", "1.1", "1.2"].map((id) => ({ id, title: id, status: "done" as const, updatedAt: "" })) };
		expect([...foldedTaskIds(list, foldedTaskTokens(list, host.truth))]).toEqual(["1.2"]);
		if (actor === "you") {
			const more = new Session();
			Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
			for (const id of ["2", "3"]) { more.start(id, `Task ${id}`); more.work(2, id); more.finish(id, { outcome: `${id} done` }); }
			more.work(3, "tail2");
			host.appendBlocks(more.blocks);
			host.setBudget(Math.ceil(host.stats().liveTokens * 0.5));
			await host.commitTurn();
			expect(groupOf(host, first)).toBeUndefined();
			expect(host.truth.get(first)?.override).toBe("unfolded");
			expect(host.truth.get(first)?.by).toBe("you");
			expect(groupOf(host, second)).toBeDefined();
		}
	});

	it("may refold a once-opened child after two newer roots, but not after a second unfold", async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		const child = s.start("1.1", "Child").call;
		s.work(2, "child");
		s.finish("1.1", { outcome: "child done" });
		s.finish("1", { outcome: "parent done" });
		s.work(3, "tail");
		const host = setup(s);
		const entries: unknown[] = [];
		const ledger = new VerdictLedger();
		ledger.reset(new Map(), null, new Map(), (key, state) => entries.push({ type: "custom", customType: UNFOLD_ENTRY, data: { key, ...state } }));
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minSteps: 8 } }, ledger);
		conductor.attach(host);
		await host.commitTurn();
		host.setBudget(host.stats().liveTokens * 10);
		expect(resolveUnfold(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		for (const id of ["2", "3"]) { more.start(id, `Task ${id}`); more.work(2, id); more.finish(id, { outcome: `${id} done` }); }
		more.work(3, "tail2");
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.5));
		await host.commitTurn();
		expect(taskKeyOfSummary(groupOf(host, parent)?.summary)).toBe("work/1");
		host.setBudget(host.stats().liveTokens * 10);
		expect(resolveUnfold(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.5));
		await host.commitTurn();
		expect(groupOf(host, child)).toBeUndefined();
		expect(unfoldStatesOf(entries).get("work/1.1")).toEqual({ count: 2, open: true });
		conductor.detach();
		const resumed = new VerdictLedger();
		resumed.reset(new Map(), null, unfoldStatesOf(entries));
		new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minSteps: 8 } }, resumed).attach(host);
		await host.commitTurn();
		expect(groupOf(host, child)).toBeUndefined();
	});

	it("does not reconstruct facts from a human-dropped group inside a task", async () => {
		const { s, end } = oneTask();
		const call = s.blocks.find((b) => b.toolName === "edit" && b.kind === "tool_call")!;
		const result = s.blocks.find((b) => b.callId === call.callId && b.kind === "tool_result")!;
		const host = setup(s);
		expect(host.truth.apply([{ kind: "group", ids: [call.id, result.id], summary: null }], "you").results[0].applied).toBe(true);
		await attach(host);
		const summary = groupOf(host, end)?.summary ?? "";
		expect(summary).toContain("[task-record] work/1");
		expect(summary).not.toContain("src/parse.ts");
		expect(groupOf(host, call.id)?.by).toBe("you");
	});

	it("does not reconstruct a task report hidden by a human group", async () => {
		const { s, start, end } = oneTask();
		const result = s.blocks.find((b) => b.id === end)!;
		const call = s.blocks.find((b) => b.kind === "tool_call" && b.callId === result.callId)!;
		const host = setup(s);
		expect(host.truth.apply([{ kind: "group", ids: [call.id, result.id], summary: null }], "you").results[0].applied).toBe(true);
		await attach(host);
		expect(groupOf(host, start)).toBeUndefined();
	});

	it("reopens the same child using its original group code after the parent absorbs it", async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		const first = s.start("1.1", "First").call;
		s.work(2, "first");
		s.finish("1.1", { outcome: "First done" });
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const oldCode = foldCode(groupOf(host, first)!.id);
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		const second = more.start("1.2", "Second").call;
		more.work(2, "second");
		more.finish("1.2", { outcome: "Second done" });
		more.finish("1", { outcome: "Parent done" });
		more.work(3, "tail2");
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		expect(taskKeyOfSummary(groupOf(host, parent)?.summary)).toBe("work/1");
		host.setBudget(host.stats().liveTokens * 10);
		expect(resolveUnfold(host.truth, [oldCode]).missing).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(groupOf(host, first)).toBeUndefined();
		expect(groupOf(host, second)?.summary).toContain("[task-record] work/1.2 ");
	});

	it("includes criteria, exact pinned text and unstarted cascaded children without fake handles", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Parent");
		s.work(1, "parent");
		const end = s.finish("1", { outcome: "Cannot continue" }, "fail");
		s.blocks.find((b) => b.id === end.result)!.details = {
			task: { acceptanceCriteria: ["All checks pass"], pins: [{ kind: "rule", text: "Keep\nthis exactly", source: "user" }] },
			cascaded: [{ id: "1.1", title: "Not started", status: "abandoned", report: { outcome: "Abandoned with parent" } }],
		};
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const summary = groupOf(host, end.result)?.summary;
		expect(summary).toContain("acceptance criteria:\n  - All checks pass");
		expect(summary).toContain("Keep\nthis exactly");
		expect(summary).toContain('[task-record] work/1.1 "Not started"  status: abandoned');
		expect(summary).not.toContain(foldTag("t:work/1.1"));
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

	it("keeps a blocked task's span open across the block and resumes it from its first start", () => {
		const s = new Session();
		s.user("Go.");
		const first = s.call("tasks", { action: "start", list: "work", id: "1" }, 'Started work/1 "A".').call;
		s.call("tasks", { action: "block", list: "work", id: "1", reason: "user-decision", detail: "pick a db" }, 'Blocked work/1 "A": needs user decision — pick a db.');
		expect(scanTaskSpans(s.blocks, (b) => b.text).find((x) => x.key === "work/1")?.status).toBeNull();
		s.call("tasks", { action: "start", list: "work", id: "1" }, 'Resumed work/1 "A".');
		s.work(1, "a");
		s.finish("1", { outcome: "a" });
		const one = scanTaskSpans(s.blocks, (b) => b.text).find((x) => x.key === "work/1")!;
		expect(one).toMatchObject({ status: "done", title: "A", start: s.blocks.findIndex((b) => b.id === first) });
	});

	it("ends blocked intervals before unrelated work and opens a new interval on resume", () => {
		const s = new Session();
		s.user("Go.");
		const start = s.start("1", "First").call;
		s.call("tasks", { action: "block", list: "work", id: "1", reason: "user-decision", detail: "choose" }, "blocked");
		const question = s.text("Which option?");
		s.user("Choose A.");
		const other = s.start("2", "Other").call;
		s.finish("2", { outcome: "other" });
		const resume = s.call("tasks", { action: "start", list: "work", id: "1" }, 'Resumed work/1 "First".').call;
		s.finish("1", { outcome: "finished" });
		const span = scanTaskSpans(s.blocks, (b) => b.text).find((x) => x.key === "work/1")!;
		const idx = (id: string) => s.blocks.findIndex((b) => b.id === id);
		expect(span.intervals).toEqual([{ start: idx(start), end: idx(question) }, { start: idx(resume), end: s.blocks.length - 1 }]);
		expect(span.intervals.some((r) => r.start <= idx(other) && idx(other) <= r.end)).toBe(false);
	});

	it("does not fold unrelated work between a blocked task and its resume", async () => {
		const s = new Session();
		s.user("Go.");
		const start = s.start("1", "First").call;
		s.work(1, "first");
		s.call("tasks", { action: "block", list: "work", id: "1", reason: "user-decision", detail: "choose" }, "blocked");
		s.text("Which option?");
		s.user("A.");
		const other = s.start("2", "Other").call;
		s.work(1, "other");
		s.finish("2", { outcome: "other" });
		s.call("tasks", { action: "start", list: "work", id: "1" }, 'Resumed work/1 "First".');
		s.work(1, "resumed");
		s.finish("1", { outcome: "done" });
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		expect(groupOf(host, start)?.summary).toContain("[task-part] work/1");
		expect(groupOf(host, other)?.summary).toContain("[task-record] work/2");
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(start);
		expect(recalled.restored[0].ids).not.toContain(other);
	});

	it("uses persisted task details to identify automatic closures and cascaded abandons", () => {
		const s = new Session();
		s.user("Go.");
		const one = s.start("1", "Parent");
		const child = s.start("1.1", "Child");
		const end = s.call("tasks", { action: "abandon", list: "work", id: "1", report: { outcome: "stopped" } }, "ok");
		s.blocks.find((b) => b.id === end.result)!.details = { cascaded: [{ id: "1.1", title: "Child", status: "abandoned", report: { outcome: "cascaded" } }] };
		const spans = scanTaskSpans(s.blocks, (b) => b.text);
		expect(spans.find((x) => x.key === "work/1.1")).toMatchObject({ status: "abandoned", report: { outcome: "cascaded" }, start: s.blocks.findIndex((b) => b.id === child.call) });
		expect(spans.find((x) => x.key === "work/1")).toMatchObject({ status: "abandoned", start: s.blocks.findIndex((b) => b.id === one.call) });
	});

	it("keeps the newest finished task open by default and folds the older ones", async () => {
		const s = new Session();
		s.user("Two things.");
		const a = s.start("1", "First").call;
		s.work(8, "a");
		s.finish("1", { outcome: "first done" });
		const b = s.start("2", "Second").call;
		s.work(3, "b");
		s.finish("2", { outcome: "second done" });
		s.work(2, "tail");
		const host = setup(s, 1.05);
		const c = new TaskfoldConductor();
		c.attach(host);
		await host.commitTurn();
		expect(groupOf(host, a)?.summary).toContain("[task-record] work/1 ");
		expect(groupOf(host, b)).toBeUndefined();
		c.detach();
	});

	it("waives keep-recent when older work cannot reach the target", async () => {
		const s = new Session();
		s.user("Go.");
		const start = s.start("1", "Only task").call;
		s.work(3, "a");
		s.finish("1", { outcome: "done" });
		s.work(2, "tail");
		const host = setup(s, 0.5);
		new TaskfoldConductor().attach(host);
		await host.commitTurn();
		expect(groupOf(host, start)?.summary).toContain("[task-record] work/1");
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

	it("folds a task whose closing message also carries the next task's work into the protected tail", async () => {
		const s = new Session();
		s.user("Go.");
		const a = s.start("1", "First").call;
		s.work(3, "a");
		// `complete 1`, `start 2` and task 2's work batched in one message, the last one of the session.
		const shared = s.batch([
			["tasks", { action: "complete", list: "work", id: "1", report: { outcome: "first" } }, "work/1 is done."],
			["tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "Second".'],
			["bash", { command: "echo hi > notes.txt" }, ""],
			["tasks", { action: "complete", list: "work", id: "2", report: { outcome: "second" } }, "work/2 is done."],
		]);
		const host = setup(s, 0.4);
		await attach(host);
		const first = groupOf(host, a)!;
		expect(first?.summary).toContain("[task-record] work/1 ");
		expect(first.memberIds).not.toContain(shared.calls[0]);
		expect(host.blocks().filter((b) => first.memberIds.includes(b.id)).some((b) => b.protected)).toBe(false);
	});

	it("condenses oversized child records without losing their recall handles", async () => {
		const s = new Session();
		s.user("Go.");
		const parent = s.start("1", "Parent").call;
		s.start("1.1", "Child");
		s.work(2, "child");
		const finish = s.finish("1.1", { outcome: "done", decisions: ["Details ".repeat(60)] });
		s.blocks.find((b) => b.id === finish.result)!.details = { task: { pins: [{ kind: "rule", text: "Keep this\nexactly", source: "user" }] } };
		s.finish("1", { outcome: "parent done" });
		s.work(3, "tail");
		const host = setup(s);
		new TaskfoldConductor({ keepRecentTasks: 0, recordTokens: 120 }).attach(host);
		await host.commitTurn();
		const summary = groupOf(host, parent)?.summary ?? "";
		expect(summary).toContain(`- ${foldTag("t:work/1.1")} work/1.1 "Child" done · done`);
		expect(summary).not.toContain("Details Details");
		expect(summary).toContain("Keep this\nexactly");
		expect(resolveRecall(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
	});

	it("keeps an oversized record raw rather than truncating its own report", async () => {
		const s = new Session();
		s.user("Go.");
		const start = s.start("1", "Task").call;
		s.work(2, "task");
		s.finish("1", { outcome: "done", decisions: ["Keep ".repeat(100)] });
		s.work(3, "tail");
		const host = setup(s);
		new TaskfoldConductor({ keepRecentTasks: 0, recordTokens: 100, untracked: { enabled: false, minSteps: 8 } }).attach(host);
		await host.commitTurn();
		expect(groupOf(host, start)).toBeUndefined();
		expect(host.statusLog.at(-1)?.metrics?.level).toBe("error");
	});

	it("condenses nested children bottom-up without losing any handle", () => {
		const parent = foldTag("g:parent");
		const child = foldTag("t:work/1.1");
		const leaf = foldTag("t:work/1.1.1");
		const full = `${parent} [task-record] work/1 "Parent"  status: done\noutcome: P\nchildren:\n  ${child} [task-record] work/1.1 "Child"  status: done\n  outcome: C\n  children:\n    ${leaf} [task-record] work/1.1.1 "Leaf"  status: done\n    outcome: L\n    decisions:\n      - detail`;
		const first = condenseChildren(full)!;
		expect(first).toContain(`    - ${leaf} work/1.1.1 "Leaf" done · L`);
		expect(first).toContain(`  ${child} [task-record]`);
		const second = condenseChildren(first)!;
		expect(second).toContain(`  - ${child} work/1.1 "Child" done · C`);
		expect(second).toContain(`${leaf} work/1.1.1 "Leaf" done · L`);
		const archived = ageRecord(second, 2)!;
		expect(archived).toContain(`${child} work/1.1 "Child" done · C`);
		expect(archived).toContain(`${leaf} work/1.1.1 "Leaf" done · L`);
		expect(ageRecord(archived, 2)).toBe(archived);
		expect(condenseChildren(second)).toBeNull();
		const abandoned = condenseChildren(`${parent} [task-record] work/1 "Parent"  status: failed\nchildren:\n  [task-record] work/1.1 "Unstarted"  status: abandoned\n  outcome: Parent failed`);
		expect(abandoned).toContain('work/1.1 "Unstarted" abandoned · Parent failed');
	});

	it("keeps verbatim task pins through child condensation and record aging", () => {
		const root = foldTag("g:parent");
		const child = foldTag("t:work/1.1");
		const full = `${root} [task-record] work/1 "Parent"  status: done\noutcome: Finished parent\npins:\n  - rule: Parent constraint (user)\nchildren:\n  ${child} [task-record] work/1.1 "Child"  status: done\n  outcome: Finished child\n  pins:\n    - constraint: Child constraint (spec.md:1)`;
		const pins = [{ task: "work/1", kind: "rule", text: "Parent constraint", source: "user" }, { task: "work/1.1", kind: "constraint", text: "Child constraint", source: "spec.md:1" }];
		const condensed = condenseChildren(full, pins)!;
		expect(condensed).toContain("Parent constraint");
		expect(condensed).toContain("Child constraint");
		const aged = ageRecord(condensed, 1, pins)!;
		expect(aged).toContain("Parent constraint");
		expect(aged).toContain("Child constraint");
		const archived = ageRecord(aged, 2, pins)!;
		expect(archived).toContain("Parent constraint");
		expect(archived).toContain("Child constraint");
	});

	it("ages records oldest first, keeping fold codes and the newest record whole", () => {
		const full = `${foldTag("g:x")} [task-record] work/1 "First"  status: done\noutcome: It works.\ndecisions:\n  - a — b`;
		const one = ageRecord(full, 1)!;
		expect(one).toBe(`${foldTag("g:x")} [task-record] work/1 "First"  status: done · It works. · recall ${foldTag("g:x")} instead of re-reading`);
		expect(ageRecord(one, 1)).toBe(one);
		const stub = ageRecord(one, 2)!;
		expect(stub).toBe(`${foldTag("g:x")} [task-archived] work/1 "First" done; recall ${foldTag("g:x")} instead of re-reading.`);
		expect(taskKeyOfSummary(stub)).toBe("work/1");
		expect(ageRecord("plain", 1)).toBeNull();
	});

	it("ages older records behind an existing cache break even after the target is met", async () => {
		const s = new Session();
		s.user("Go.");
		const starts: string[] = [];
		const ends: string[] = [];
		for (const id of ["1", "2", "3", "4"]) {
			starts.push(s.start(id, `Task ${id}`).call);
			s.work(id === "1" ? 8 : 1, `w${id}`);
			const end = s.finish(id, { outcome: `${id} done` }).result;
			ends.push(end);
			if (id === "2") s.blocks.find((b) => b.id === end)!.details = { task: { pins: [{ kind: "rule", text: "Keep this rule", source: "user" }] } };
		}
		s.work(2, "tail");
		const host = setup(s, 2);
		const index = s.blocks.findIndex((b) => b.id === starts[1]);
		const gid = `g:${s.blocks[index - 1].id}`;
		const full = `${foldTag(gid)} [task-record] work/2 "Task 2"  status: done\noutcome: 2 done\ndecisions:\n  - ${"detail ".repeat(60)}\npins:\n  - rule: Keep this rule (user)`;
		expect(host.truth.apply([{ kind: "group", ids: [starts[1], ends[1]], summary: full }], "auto").results[0].applied).toBe(true);
		new TaskfoldConductor({ keepRecentTasks: 1, aging: [1, 2, 3], untracked: { enabled: false, minSteps: 8 } }).attach(host);
		await host.commitTurn();
		expect(groupOf(host, starts[1])?.summary).toBe(full);
		host.setBudget(Math.ceil(host.stats().liveTokens * 1.2));
		await host.commitTurn();
		expect(groupOf(host, starts[0])?.summary).toContain("[task-record] work/1");
		expect(groupOf(host, starts[1])?.summary).not.toContain("decisions:");
		expect(groupOf(host, starts[1])?.summary).toContain("Keep this rule");
		expect(groupOf(host, starts[3])).toBeUndefined();
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
		expect(resolveRecall(host.truth, [foldCode("t:work/1")]).missing).toEqual([]);
		expect(taskKeyOfSummary(summaries[3])).toBe("work/4");
		expect(resolveRecall(host.truth, [foldCode("t:work/4")]).missing).toEqual([]);
		expect(summaries.every((x, i) => taskKeyOfSummary(x) === `work/${i + 1}`)).toBe(true);
		c.detach();
	});
});

