import { createHash } from "node:crypto";
/*
 * taskfold.test.ts — driven through `TestHost` (a real `Truth`), so every proposed group is vetted
 * by the same predicates a live session enforces. Sessions use durable ids (`u:`/`a:…:p<j>`/`r:<callId>`).
 */
import { describe, it, expect, vi } from "vitest";
import { foldedTaskIds, foldedTaskTokens } from "../../../extension/tui/taskWidget";
import { TaskfoldConductor, scanTaskSpans, staleSpans, taskKeyOfSummary } from "./taskfold";
import { isHistoryCarrier, parseCarrier, shrinkDeepest, toHistory, type RecordObj } from "./records";
import { TestHost } from "../../../core/conductor/testhost";
import type { RoutingPort, TaskfoldRouting } from "./routing";
import { UNFOLD_ENTRY, VERDICT_ENTRY, VerdictLedger, unfoldStatesOf, verdictsOf, type Verdict } from "./verdicts";
import { foldCode, foldTag } from "../../../core/digest";
import { resolveRecall, resolveUnfold } from "../../../core/agentView";
import type { Block } from "../../../core/types";
import { parseExtraction } from "../../../extension/taskRouting";
import type { ClassificationResult, ConductorHost, FoldTiming } from "../../../core/conductor/contract";
import { cacheProfileFor } from "../../../core/cacheProfiles";
import type { TaskEvent } from "../../../core/taskEvents";
import { entryById } from "../../../core/conductor/registry";

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
	custom(text: string): string {
		return this.push({ id: `c:${1000 + this.order}:notice`, kind: "custom", text });
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
	host.truth.setLocks(c.locks, c.label, c.tailTokens);
	c.attach(host);
	await host.commitTurn();
	return c;
}

const groupOf = (h: TestHost, id: string) => h.groups().find((g) => g.memberIds.includes(id));
/** The parsed JSON of a group's carrier summary. */
const carrier = (g: { summary?: string | null } | undefined) => parseCarrier(g?.summary)?.obj as Record<string, any> | undefined;

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

	it("retries classifier capacity only after another call settles", async () => {
		vi.useFakeTimers();
		try {
			const s = new Session();
			s.user("Goal");
			const host = setup(s, 10);
			const first = Promise.withResolvers<ClassificationResult>();
			const result: ClassificationResult = { answers: { loss: { type: "score", score: 0.1, confidence: 0.9 } }, model: "test" };
			let calls = 0;
			host.classifier = () => {
				calls++;
				if (calls === 1) return first.promise;
				if (calls === 2) throw new Error("too many concurrent model calls in flight (max 4)");
				return result;
			};
			const c = new TaskfoldConductor();
			c.attach(host);
			const at = s.blocks.length;
			s.user("First");
			s.user("Second");
			host.appendBlocks(s.blocks.slice(at));
			await Promise.resolve();
			await Promise.resolve();
			expect(calls).toBe(2);
			await vi.advanceTimersByTimeAsync(249);
			expect(calls).toBe(2);
			first.resolve(result);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toBe(3);
			c.detach();
		} finally {
			vi.useRealTimers();
		}
	});

	it("evaluates 20,000 blocks with 400 folded tasks in under 500 ms", async () => {
		const s = new Session();
		const ranges: string[][] = [];
		for (let i = 0; i < 400; i++) {
			const start = s.blocks.length;
			s.start(`${i + 1}`, `Task ${i + 1}`);
			for (let j = 0; j < 44; j++) s.text(`Task ${i} step ${j} ${"work ".repeat(20)}`);
			s.finish(`${i + 1}`, { outcome: "done" });
			ranges.push(s.blocks.slice(start, s.blocks.length).map((b) => b.id));
		}
		const host = setup(s, 100);
		host.setProtect(0);
		const ops = ranges.map((ids) => ({ kind: "group" as const, ids, summary: "folded", role: "assistant" as const }));
		const result = await host.propose({ baseRev: host.stats().rev, ops });
		expect(result.results.filter((r) => r.applied)).toHaveLength(400);
		const c = new TaskfoldConductor({ timing: "pressure" });
		c.attach(host);
		const start = performance.now();
		await host.commitTurn();
		const elapsed = performance.now() - start;
		console.log(`20k planner evaluation: ${elapsed.toFixed(1)} ms`);
		// Measured 93 ms alone and 216 ms under parallel load; the bound only has to catch a planner that scales with tasks x blocks again.
		expect(elapsed).toBeLessThan(500);
		c.detach();
	}, 120000);

	it("skips unchanged idle events and replans after a classifier verdict", async () => {
		const s = new Session();
		s.user("Goal");
		const host = setup(s, 10);
		Object.assign(host, { foldPolicy: () => ({ timing: "eager", cache: cacheProfileFor("*"), now: 1000, lastRequestAt: null }) });
		const blocks = host.blocks.bind(host);
		let reads = 0;
		host.blocks = () => { reads++; return blocks(); };
		const c = new TaskfoldConductor();
		c.attach(host);
		const before = s.blocks.length;
		s.text("Work");
		host.appendBlocks(s.blocks.slice(before));
		await host.commitTurn();
		await host.departWire();
		expect(reads).toBe(1);
		const pending = Promise.withResolvers<ClassificationResult>();
		host.classifier = () => pending.promise;
		const at = s.blocks.length;
		s.user("Another instruction");
		host.appendBlocks(s.blocks.slice(at));
		const afterAppend = reads;
		pending.resolve({ answers: { loss: { type: "score", score: 0.1, confidence: 0.9 } }, model: "test" });
		await pending.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(reads).toBeGreaterThan(afterAppend);
		c.detach();
	});

	it("characterizes seeded long-session planning", async () => {
		const digests: string[] = [];
		for (const seed of [1, 2, 3]) {
			let random = seed;
			const next = () => (random = (random * 16807) % 2147483647);
			const s = new Session();
			s.user("Seeded session");
			const host = new TestHost();
			const records: unknown[] = [];
			let previousEpoch = "";
			Object.assign(host, {
				debug: (record: { type: string }) => {
					if (record.type !== "epoch") return;
					const serialized = JSON.stringify(record);
					if (serialized !== previousEpoch) records.push(record);
					previousEpoch = serialized;
				},
				foldPolicy: () => ({ timing: seed === 3 ? "lazy" : "eager", cache: cacheProfileFor("*"), now: 100000, lastRequestAt: null }),
			});
			const propose = host.propose.bind(host);
			host.propose = (txn) => { records.push(txn.ops); return propose(txn); };
			host.setProtect(0);
			host.setBudget(3000);
			const c = new TaskfoldConductor({ keepRecentTasks: 0, floor: seed === 2, timing: seed === 3 ? "lazy" : "eager" }, undefined, undefined, () => false);
			host.truth.setLocks(c.locks, c.label, c.tailTokens);
			c.attach(host);
			let appended = 0;
			for (let i = 0; i < 50; i++) {
				const list = i % 2 ? "other" : "work";
				const ids = [`${i + 1}`, `${i + 1}.1`, `${i + 1}.1.1`];
				for (const id of ids) {
					s.call("tasks", { action: "start", list, id }, `Started ${list}/${id} "Task ${id}". Criteria: ${"criteria ".repeat(20)}`);
					s.call("read", { path: `docs/${next() % 7}.md` }, `Document ${id}`);
				}
				for (const [j, id] of ids.toReversed().entries()) {
					const action = ["complete", "fail", "abandon", "block", "complete"][(i * 3 + j) % 5];
					if ((i * 3 + j) % 11 !== 0) s.call("tasks", { action, list, id, reason: "dependency", report: { outcome: `Outcome ${id}` } }, `${list}/${id} ${action}.`);
				}
				for (let j = 0, n = 3 + next() % 10; j < n; j++) s.text(`Untracked ${i}.${j} ${"work ".repeat(80)}`);
				if (i % 8 === 7 || i === 49) {
					host.appendBlocks(s.blocks.slice(appended));
					appended = s.blocks.length;
					await host.commitTurn();
					await host.departWire();
				}
			}
			expect(records.filter((r) => !Array.isArray(r) && (r as { pressure?: boolean }).pressure).length).toBeGreaterThanOrEqual(5);
			digests.push(`${records.length} ${createHash("sha256").update(JSON.stringify(records)).digest("hex")}`);
			c.detach();
		}
		expect(digests).toMatchInlineSnapshot(`
			[
			  "31 7cd927252b60d5373cd380cb8bf8b6b285b74fe13bb7887fdd432d03d1487e7b",
			  "31 37260b9b90614f4fb97c9bc112b7d1d103c72248de52caac2a27aef0d04df320",
			  "33 b24942e4a1b38c0cd4ae08bd5cd60273d86b3f8ad0f75a50581995f390ffb694",
			]
		`);
	}, 120000);

	it("reports the last epoch's estimated savings for compaction previews", async () => {
		const { s, start } = oneTask();
		const host = setup(s, 2);
		const before = host.stats().liveTokens;
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0 });
		conductor.attach(host);
		await host.departWire();
		const status = host.statusLog.at(-1);
		expect(groupOf(host, start)).toBeDefined();
		expect(host.stats().liveTokens).toBeLessThan(before);
		expect(status?.metrics?.saved).toBeGreaterThan(0);
		expect(status?.text).toContain(`~${status?.metrics?.saved} tokens`);
		conductor.detach();
	});

	it("keeps deterministic work running and waits for consent before any model call", async () => {
		const { s, start } = oneTask((s) => s.user("Never touch vendor/."));
		const steering = s.blocks.find((b) => b.text === "Never touch vendor/.")!.id;
		const host = new TestHost(), ledger = new VerdictLedger();
		let allowed = false;
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0 }, ledger, undefined, () => allowed);
		conductor.attach(host);
		host.appendBlocks(s.blocks);
		await new Promise((r) => setTimeout(r, 0));
		expect(host.completeLog).toHaveLength(0);
		expect(ledger.get(steering)).toBeUndefined();
		expect(host.statusLog.at(-1)?.text).toContain("classifier: awaiting consent");
		allowed = true;
		// Consent alone must reach the queued message: a resync is what the host fires when the gate opens.
		await host.resync();
		await new Promise((r) => setTimeout(r, 0));
		expect(ledger.get(steering)).toBeDefined();
		expect(host.statusLog.at(-1)?.text ?? "").not.toContain("awaiting consent");
		conductor.detach();
		expect(!!groupOf(host, start)).toBe(false);
	});

	it("resolves registry defaults and keeps the configured number of recent tasks raw", async () => {
		for (const keepRecentTasks of [undefined, 0, 1]) {
			const { s, start } = oneTask();
			const host = setup(s, 2);
			const conductor = entryById("taskfold")!.create!(keepRecentTasks === undefined ? undefined : { keepRecentTasks });
			conductor.attach(host);
			await host.departWire();
			expect(!!groupOf(host, start)).toBe(keepRecentTasks !== 1);
			conductor.detach();
		}
	});

	it("uses registry watermarks to trigger pressure folding", async () => {
		for (const high of [0.7, 0.9]) {
			const { s, start } = oneTask();
			const host = setup(s, 1.25);
			Object.assign(host, { foldPolicy: () => ({ timing: "pressure", cache: cacheProfileFor("*"), now: 1_000, lastRequestAt: null }) });
			const conductor = entryById("taskfold")!.create!({ high, low: 0.4 });
			conductor.attach(host);
			await host.departWire();
			expect(!!groupOf(host, start)).toBe(high === 0.7);
			conductor.detach();
		}
	});

	it("retries parse failures once but reports truncation and provider errors without retrying", async () => {
		for (const mode of ["recover", "malformed", "length", "error"] as const) {
			const { s } = oneTask((s) => s.user("Never touch vendor/."));
			const id = s.blocks.find((b) => b.text === "Never touch vendor/.")!.id;
			const host = new TestHost(), ledger = new VerdictLedger();
			host.queueCompletion({ text: "not JSON", stopReason: mode === "length" || mode === "error" ? mode : "stop" });
			host.queueCompletion({ text: mode === "recover" ? '{"ops":[{"op":"+","kind":"pin","target":"list","value":"Never touch vendor/.","pinKind":"rule"}]}' : "still not JSON", stopReason: "stop" });
			const port: RoutingPort = { current: {
				prepare: () => ({ system: "Extract", prompt: "Never touch vendor/.", apply: async (reply) => { const { ops } = parseExtraction(reply); return { ids: ops.length ? ["p1"] : [], applied: ops.length, dropped: 0 }; } }),
			} };
			new TaskfoldConductor({ keepRecentTasks: 0 }, ledger, port).attach(host);
			host.appendBlocks(s.blocks);
			await new Promise((r) => setTimeout(r, 0));
			expect(host.completeLog).toHaveLength(mode === "recover" || mode === "malformed" ? 2 : 1);
			if (mode === "recover") expect(ledger.get(id)?.routed).toBeDefined();
			else {
				expect(ledger.get(id)?.routed).toBeUndefined();
				expect(host.statusLog.some((r) => r.text?.includes(mode === "length" ? "truncated" : mode === "error" ? "provider error" : "did not return JSON"))).toBe(true);
			}
		}
	});
describe("taskfold", () => {
	it("folds extension notices in task spans without classifying or routing them", async () => {
		const s = new Session();
		s.user("Build it.");
		const start = s.start("1", "Build").call;
		const notice = s.custom("extension notice ".repeat(500));
		s.text("Working.");
		s.finish("1", { outcome: "Done" });
		s.work(2, "tail");
		const index = s.blocks.findIndex((b) => b.id === notice);
		const span = scanTaskSpans(s.blocks, (b) => b.text)[0];
		expect(span.intervals.some((r) => r.start <= index && index <= r.end)).toBe(true);
		const host = new TestHost(), ledger = new VerdictLedger();
		const classifier = vi.fn(() => ({ answers: { loss: { type: "score" as const, score: 2, confidence: 0.9 } }, model: "test" }));
		host.setProtect(0);
		const prepare = vi.fn(() => ({ system: "Extract", prompt: "p", apply: async () => ({ ids: [], applied: 0, dropped: 0 }) }));
		host.classifier = classifier;
		const c = new TaskfoldConductor({ keepRecentTasks: 0 }, ledger, { current: { prepare } });
		c.attach(host);
		host.appendBlocks(s.blocks);
		await new Promise((r) => setTimeout(r, 0));
		await host.departWire();
		expect(groupOf(host, notice)?.id).toBe(groupOf(host, start)?.id);
		expect(groupOf(host, notice)).toBeDefined();
		expect(ledger.get(notice)).toBeUndefined();
		expect(classifier).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		c.detach();
	});

	it("counts a custom-only untracked run and seals it only at a human turn", async () => {
		const s = new Session();
		s.user("Go.");
		const notice = s.custom("large extension work ".repeat(1000));
		const host = setup(s, 10);
		host.setProtect(0);
		const c = await attach(host);
		expect(groupOf(host, notice)).toBeUndefined();
		const at = s.blocks.length;
		s.user("Continue.");
		s.text("Continuing.");
		host.appendBlocks(s.blocks.slice(at));
		await host.commitTurn();
		expect(carrier(groupOf(host, notice))?.untracked).toBeDefined();
		c.detach();
	});

	it("keeps a closing message shared with the next start intact in bracket form", async () => {
		const s = new Session();
		s.user("Build two.");
		const start = s.start("1", "First").call;
		s.work(2, "first");
		const boundary = s.batch([["tasks", { action: "complete", list: "work", id: "1", report: { outcome: "First done" } }, "done"], ["tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "Second".']]);
		const host = setup(s, 2), c = new TaskfoldConductor({ leafForm: "bracket" });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.departWire();
		expect(groupOf(host, start)).toBeDefined();
		for (const id of [...boundary.calls, ...boundary.results]) expect(groupOf(host, id)).toBeUndefined();
		c.detach();
	});

	it("keeps automatically assembled reports in the carrier when there is no original closing call", async () => {
		const s = new Session();
		s.user("Build the tree.");
		const start = s.start("1", "Root").call;
		s.start("1.1", "Child");
		s.work(2, "child");
		s.finish("1.1", { outcome: "Child done" });
		s.call("tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "Next".', false, { closed: [{ id: "1", title: "Root", status: "done", report: { outcome: "Automatically assembled" } }] });
		const host = setup(s, 2), c = new TaskfoldConductor({ leafForm: "bracket" });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.departWire();
		expect(carrier(groupOf(host, start))).toMatchObject({ outcome: "Automatically assembled" });
		c.detach();
	});
	it("bracket folds at the first request after completion and keeps the report in the raw closing call", async () => {
		for (const leafForm of ["record", "bracket"] as const) {
			const s = new Session();
			s.user("Build it.");
			const start = s.start("1", "Build").call;
			s.work(2, "body");
			const finish = s.finish("1", { outcome: "Whole outcome", decisions: ["Use one path"], open: ["Check rollout"] });
			const host = setup(s, 2);
			const c = new TaskfoldConductor({ leafForm });
			host.truth.setLocks(c.locks, c.label, c.tailTokens);
			c.attach(host);
			await host.departWire();
			const group = groupOf(host, start);
			if (leafForm === "record") expect(group).toBeUndefined();
			else {
				expect(group).toBeDefined();
				expect(groupOf(host, finish.call)).toBeUndefined();
				expect(groupOf(host, finish.result)).toBeUndefined();
				expect(carrier(group)).not.toHaveProperty("outcome");
				expect(carrier(group)).not.toHaveProperty("decisions");
				expect(carrier(group)).not.toHaveProperty("open");
				expect(resolveRecall(host.truth, [foldCode("t:work/1")]).missing).toEqual([]);
			}
			c.detach();
		}
	});

	it("absorbs bracket closing tails into the parent and restores full child reports and handles", async () => {
		const s = new Session();
		s.user("Build the tree.");
		s.start("1", "Root");
		const parent = s.start("1.1", "Parent").call;
		const child = s.start("1.1.1", "Child").call;
		s.work(2, "child");
		const close = s.finish("1.1.1", { outcome: "Child outcome", decisions: ["Child decision"], open: ["Child follow-up"] });
		const host = setup(s, 2), c = new TaskfoldConductor({ leafForm: "bracket" });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.departWire();
		expect(groupOf(host, child)).toBeDefined();
		expect(groupOf(host, close.call)).toBeUndefined();
		const before = s.blocks.length;
		s.work(1, "parent");
		const parentClose = s.finish("1.1", { outcome: "Parent outcome" });
		host.appendBlocks(s.blocks.slice(before));
		await host.departWire();
		const group = groupOf(host, parent)!;
		expect(carrier(group).children).toEqual([expect.objectContaining({ task: "work/1.1.1", outcome: "Child outcome", decisions: ["Child decision"], open: ["Child follow-up"] })]);
		expect(group.memberIds).toContain(close.call);
		expect(group.memberIds).toContain(close.result);
		expect(groupOf(host, parentClose.call)).toBeUndefined();
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(close.result);
		c.detach();
	});
	it("keeps shared child reports in the visible closing tail until an ancestor absorbs it", async () => {
		for (const prefoldChild of [false, true]) {
			const s = new Session();
			s.user("Build the tree.");
			s.start("1", "Root");
			const grand = s.start("1.1", "Grandparent").call;
			const parent = s.start("1.1.1", "Parent").call;
			const child = s.start("1.1.1.1", "Child").call;
			s.work(2, "child");
			const host = setup(s, 2), c = new TaskfoldConductor({ leafForm: "bracket" });
			host.truth.setLocks(c.locks, c.label, c.tailTokens);
			c.attach(host);
			const before = s.blocks.length;
			const boundary = s.batch([
				["tasks", { action: "complete", list: "work", id: "1.1.1.1", report: { outcome: "Child outcome", decisions: ["Child decision"], open: ["Child follow-up"] } }, "done"],
				["tasks", { action: "complete", list: "work", id: "1.1.1", report: { outcome: "Parent outcome" } }, "done"],
			]);
			const split = prefoldChild ? s.blocks.findIndex((b) => b.id === boundary.results[0]) + 1 : before;
			if (prefoldChild) {
				host.appendBlocks(s.blocks.slice(before, split));
				await host.departWire();
				expect(groupOf(host, child)).toBeDefined();
			}
			host.appendBlocks(s.blocks.slice(split));
			await host.departWire();
			const record = carrier(groupOf(host, parent));
			for (const field of ["outcome", "decisions", "open"]) expect(record.children[0]).not.toHaveProperty(field);
			for (const id of [...boundary.calls, ...boundary.results]) expect(groupOf(host, id)).toBeUndefined();
			expect(resolveRecall(host.truth, [foldCode("t:work/1.1.1.1")]).missing).toEqual([]);
			const after = s.blocks.length;
			s.work(1, "grandparent");
			s.finish("1.1", { outcome: "Grandparent outcome" });
			host.appendBlocks(s.blocks.slice(after));
			await host.departWire();
			const absorbed = carrier(groupOf(host, grand)).children[0];
			expect(absorbed.outcome).toBe("Parent outcome");
			expect(absorbed.children[0]).toMatchObject({ outcome: "Child outcome", decisions: ["Child decision"], open: ["Child follow-up"] });
			c.detach();
		}
	});
	it("keeps a child wholly inside a visible closing call raw without an empty handle", async () => {
		const s = new Session();
		s.user("Build a tree.");
		const start = s.start("1", "Root").call;
		s.work(1, "parent");
		const childReport = { outcome: "Child work done" }, rootReport = { outcome: "Root done" };
		const events: TaskEvent[] = [
			{ action: "start", list: "work", id: "1.1", task: { id: "1.1", title: "Child", status: "doing" }, started: [{ id: "1.1", title: "Child", status: "doing" }] },
			{ action: "complete", list: "work", id: "1.1", task: { id: "1.1", title: "Child", status: "done", report: childReport } },
			{ action: "complete", list: "work", id: "1", task: { id: "1", title: "Root", status: "done", report: rootReport } },
		];
		const code = events.map((event, i) => `${i === 1 ? 'await tools.bash({command:"printf child-work-visible"}); ' : ""}await tools.tasks(${JSON.stringify({ action: event.action, list: event.list, id: event.id, ...(event.task?.report ? { report: event.task.report } : {}) })});`).join("\n");
		const closing = s.call("codemode", { code }, "child-work-visible", false, { taskEvents: events });
		const host = setup(s, 2), c = new TaskfoldConductor({ leafForm: "bracket" });
		const diagnostics: Parameters<NonNullable<ConductorHost["debug"]>>[0][] = [];
		Object.assign(host, { debug: (event: typeof diagnostics[number]) => diagnostics.push(event) });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.departWire();
		const group = groupOf(host, start);
		expect(group).toBeDefined();
		expect(group!.handles?.every((h) => h.memberIds.length > 0)).toBe(true);
		expect(groupOf(host, closing.call)).toBeUndefined();
		expect(groupOf(host, closing.result)).toBeUndefined();
		expect(host.blocks().find((b) => b.id === closing.result)?.text).toBe("child-work-visible");
		expect(resolveRecall(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([foldCode("t:work/1.1")]);
		const before = s.blocks.length;
		host.setBudget(1_000_000);
		s.work(41, "later");
		host.appendBlocks(s.blocks.slice(before));
		await host.departWire();
		const tasks = diagnostics.filter((e) => e.type === "epoch").at(-1)!.tasks as { key: string; reason: string }[];
		expect(tasks.find((task) => task.key === "work/1.1")?.reason).toBe("no-whole-message");
		expect(host.statusLog.some((status) => status.text?.includes("work/1.1 still raw"))).toBe(true);
		c.detach();
	});
	it("does not warn that absorbed descendants are raw after forty later tool results", async () => {
		for (const leafForm of ["record", "bracket"] as const) {
			const s = new Session();
			s.user("Build a tree.");
			s.start("1", "Root");
			s.start("1.1", "Child");
			s.start("1.1.1", "Grandchild");
			s.work(2, "body");
			s.finish("1.1.1", { outcome: "Grandchild done" });
			s.finish("1.1", { outcome: "Child done" });
			s.finish("1", { outcome: "Root done" });
			s.work(1, "tail");
			const host = setup(s, 2), c = new TaskfoldConductor({ leafForm });
			const events: Parameters<NonNullable<ConductorHost["debug"]>>[0][] = [];
			Object.assign(host, { debug: (event: typeof events[number]) => events.push(event) });
			host.truth.setLocks(c.locks, c.label, c.tailTokens);
			c.attach(host);
			await host.departWire();
			host.setBudget(1_000_000);
			const before = s.blocks.length;
			s.work(41, "later");
			host.appendBlocks(s.blocks.slice(before));
			await host.departWire();
			const tasks = events.filter((e) => e.type === "epoch").at(-1)!.tasks as { key: string; reason: string }[];
			for (const key of ["work/1.1", "work/1.1.1"]) expect(tasks.find((t) => t.key === key)?.reason).toBe("already-folded");
			expect(host.statusLog.some((status) => status.text?.includes("still raw"))).toBe(false);
			c.detach();
		}
	});
	it("explains deferred finished tasks and warns once they outlive forty tool results", async () => {
		for (const reason of ["prefill-guard", "held-boundary", "keep-recent-tasks", "timing-pressure"] as const) {
			const s = new Session();
			s.user("Go.");
			s.start("1", "Root");
			const start = s.start("1.1", "Child").call;
			s.work(2, "body");
			s.finish("1.1", { outcome: "Finished", decisions: ["Keep ".repeat(100)] });
			if (reason !== "prefill-guard") s.work(reason === "timing-pressure" ? 41 : 3, "tail");
			const host = setup(s, reason === "held-boundary" ? 0.5 : 2);
			host.truth.setLocks(["tail-size"], "Taskfold", 0);
			if (reason === "held-boundary") host.truth.apply([{ kind: "pin", ids: [start] }], "you");
			const events: Parameters<NonNullable<ConductorHost["debug"]>>[0][] = [];
			Object.assign(host, { debug: (event: typeof events[number]) => events.push(event) });
			new TaskfoldConductor({ keepRecentTasks: reason === "keep-recent-tasks" ? 1 : 0, timing: reason === "timing-pressure" ? "pressure" : "eager" }).attach(host);
			await host.commitTurn();
			const tasks = events.find((e) => e.type === "epoch")?.tasks as { key: string; reason: string }[];
			expect(tasks.find((t) => t.key === "work/1.1")?.reason).toBe(reason);
			if (reason === "timing-pressure") expect(host.statusLog.at(-1)?.text).toContain("work/1.1 still raw after 41 steps (timing-pressure)");
		}
	});

	it("records committed fold savings and the changed frontier", async () => {
		const { s } = oneTask();
		const host = setup(s);
		const events: Parameters<NonNullable<ConductorHost["debug"]>>[0][] = [];
		Object.assign(host, { debug: (event: typeof events[number]) => events.push(event) });
		await attach(host);
		const event = events.find((e) => e.type === "fold");
		expect(event?.task).toBe("work/1");
		expect(event?.tokensRemoved).toBeGreaterThan(0);
		expect(event?.carrierTokens).toBeGreaterThan(0);
		expect(event?.firstChangedBlock).toBe(1);
	});
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

	it("holds the first request after load until the epoch has folded", async () => {
		const { s, start } = oneTask();
		const host = setup(s);
		const c = new TaskfoldConductor({ keepRecentTasks: 0 });
		expect(c.holdWireUpToMs).toBeGreaterThan(0);
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		// Load fires the epoch asynchronously (the host's initial turn-committed); the wire leaves before it commits unless the hold waits.
		const epoch = host.commitTurn();
		await host.departWire();
		await epoch;
		expect(groupOf(host, start)).toBeDefined();
	});

	for (const timing of ["eager", "lazy", "pressure"] as const) {
		it(`${timing} controls a finished 60-block task independently of its distance from the request tail`, async () => {
			const s = new Session();
			s.user("Go.");
			const start = s.start("1", "Long task").call;
			s.work(20, "body");
			s.finish("1", { outcome: "Done." });
			s.work(1, "next step");
			const host = setup(s, 2);
			host.truth.setLocks(["tail-size"], "Taskfold", 0);
			let now = 1_000;
			Object.assign(host, { foldPolicy: () => ({ timing, cache: cacheProfileFor("claude/claude-sonnet-5-5"), now, lastRequestAt: 1_000 }) });
			new TaskfoldConductor().attach(host);
			await host.departWire();
			expect(!!groupOf(host, start)).toBe(timing === "eager");
			now += 300_000;
			await host.departWire();
			expect(!!groupOf(host, start)).toBe(timing !== "pressure");
			if (timing === "pressure") {
				host.setBudget(Math.ceil(host.stats().liveTokens * 0.5));
				await host.commitTurn();
				expect(groupOf(host, start)).toBeDefined();
			}
		});
	}
	it("lazy folds on cold caches and warm-cache pressure, but respects a host's longer TTL", async () => {
		for (const state of ["cold", "pressure", "long-ttl"] as const) {
			const { s, start } = oneTask();
			const host = setup(s, state === "pressure" ? 0.5 : 2);
			host.truth.setLocks(["tail-size"], "Taskfold", 0);
			Object.assign(host, { foldPolicy: () => ({ timing: "lazy", cache: cacheProfileFor("claude/claude-sonnet-5-5", 3_600_000), now: 301_000, lastRequestAt: state === "cold" ? null : 1_000 }) });
			new TaskfoldConductor().attach(host);
			await host.departWire();
			expect(!!groupOf(host, start)).toBe(state !== "long-ttl");
		}
	});
	it("samples mode changes at the next epoch without unfolding existing records", async () => {
		const { s, start } = oneTask();
		const host = setup(s, 2);
		host.truth.setLocks(["tail-size"], "Taskfold", 0);
		let timing: FoldTiming = "pressure";
		Object.assign(host, { foldPolicy: () => ({ timing, cache: cacheProfileFor("*"), now: 1_000, lastRequestAt: 1_000 }) });
		new TaskfoldConductor().attach(host);
		await host.commitTurn();
		expect(groupOf(host, start)).toBeUndefined();
		timing = "eager";
		await host.commitTurn();
		const folded = host.groups();
		expect(groupOf(host, start)).toBeDefined();
		timing = "pressure";
		await host.commitTurn();
		expect(host.groups()).toEqual(folded);
	});

	it("folds a finished root into a one-line history carrier on an assistant group", async () => {
		const { s, start, end } = oneTask();
		const host = setup(s);
		await attach(host);
		const g = groupOf(host, start);
		expect(g).toBeDefined();
		expect(g!.memberIds).toContain(end);
		expect(g!.role).toBe("assistant");
		expect(g!.summary!.startsWith(foldTag("t:work/1"))).toBe(true);
		expect(carrier(g)).toEqual({ history: "work/1", title: "Fix parser", status: "done", outcome: "Parser handles CRLF." });
		expect(isHistoryCarrier(g!.summary)).toBe(true);
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(start);
	});

	it("writes a finished subtask as a full JSON record inside its still-open parent", async () => {
		const s = new Session();
		s.user("Fix the parser.");
		s.start("1", "Parser");
		const child = s.start("1.1", "Fix CRLF").call;
		s.call("edit", { path: "src/parse.ts", oldText: "a", newText: "b" }, "Successfully replaced text in src/parse.ts.");
		s.call("bash", { command: "npm test" }, "12 passed");
		const end = s.finish("1.1", { outcome: "Parser handles CRLF.", decisions: ["normalize at read — one place"], open: ["Windows path untested"] }).result;
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const g = groupOf(host, child)!;
		expect(g.memberIds).toContain(end);
		expect(g.role).toBe("assistant");
		expect(Object.keys(carrier(g)!)).toEqual(["task", "title", "status", "outcome", "decisions", "open", "changed", "verified"]);
		expect(carrier(g)).toMatchObject({ task: "work/1.1", status: "done", changed: ["src/parse.ts"], verified: ["`npm test` → ok"], decisions: ["normalize at read — one place"] });
		expect(groupOf(host, "a:resp1:p0")).toBeUndefined();
	});

	it("folds a finished task below HIGH without touching later turns, and never rewrites earlier folds", async () => {
		const { s, start } = oneTask();
		const host = setup(s, 5);
		const proposals: string[][] = [];
		const propose = host.propose.bind(host);
		host.propose = (txn) => { proposals.push(txn.ops.map((op) => op.kind)); return propose(txn); };
		await attach(host);
		expect(host.stats().liveTokens).toBeLessThan(0.8 * host.stats().budget);
		const first = groupOf(host, start)!;
		expect(taskKeyOfSummary(first.summary)).toBe("work/1");
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		const second = more.start("2", "Next").call;
		more.work(2, "n");
		more.finish("2", { outcome: "next done" });
		more.work(3, "tail2");
		host.appendBlocks(more.blocks);
		await host.commitTurn();
		expect(taskKeyOfSummary(groupOf(host, second)?.summary)).toBe("work/2");
		expect(groupOf(host, start)?.summary).toBe(first.summary);
		expect(proposals.flat().filter((kind) => kind === "ungroup")).toEqual([]);
	});

	it("folds a finished task at the next request even when the user's tail dial covers it", async () => {
		const { s, start } = oneTask();
		const host = setup(s, 5);
		host.setProtect(host.stats().fullTokens);
		await attach(host);
		expect(taskKeyOfSummary(groupOf(host, start)?.summary)).toBe("work/1");
		expect(host.stats().protectTokens).toBe(host.stats().fullTokens);
	});
	it("waits one step when a root's finish is the final message, then folds it once as history", async () => {
		const s = new Session();
		s.user("Fix the parser.");
		s.start("1", "Parser");
		const first = s.start("1.1", "Fix CRLF").call;
		s.work(2, "c1");
		s.finish("1.1", { outcome: "CRLF handled." });
		s.start("1.2", "Fix tabs");
		s.work(2, "c2");
		s.finish("1.2", { outcome: "Tabs handled." });
		const root = s.finish("1", { outcome: "Parser fixed." }).result;
		const host = setup(s, 5);
		const proposals: string[][] = [];
		const propose = host.propose.bind(host);
		host.propose = (txn) => { proposals.push(txn.ops.map((op) => op.kind)); return propose(txn); };
		await attach(host);
		expect(host.groups()).toEqual([]);
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.work(1, "next");
		host.appendBlocks(more.blocks);
		await host.commitTurn();
		const g = groupOf(host, first)!;
		expect(g.memberIds).toContain(root);
		expect(taskKeyOfSummary(g.summary)).toBe("work/1");
		expect(isHistoryCarrier(g.summary)).toBe(true);
		expect(proposals.flat().filter((kind) => kind === "ungroup")).toEqual([]);
	});

	it("re-proposes a task after a user tail resize between attachments prunes its group", async () => {
		const { s, start } = oneTask();
		const host = setup(s);
		const c = await attach(host);
		expect(groupOf(host, start)).toBeDefined();
		c.detach();
		host.truth.clearLocks();
		host.setProtect(host.stats().fullTokens * 2);
		expect(groupOf(host, start)).toBeUndefined();
		await attach(host);
		expect(taskKeyOfSummary(groupOf(host, start)?.summary)).toBe("work/1");
		expect(resolveRecall(host.truth, [foldCode("t:work/1")]).missing).toEqual([]);
	});

	it("folds sealed untracked work eagerly while preserving the reply and current turn", async () => {
		const s = new Session();
		const opening = s.user("Go.");
		const start = s.blocks.length;
		s.work(6, "outside");
		const work = s.blocks.slice(start).map((b) => b.id);
		const reply = s.text("Finished.");
		s.custom("Notice after the reply.");
		const steering = s.user("Continue.");
		const tail = s.blocks.length;
		s.work(2, "tail");
		const host = setup(s, 10);
		await attach(host);
		const untracked = host.groups().find((g) => carrier(g)?.untracked !== undefined);
		expect(untracked).toBeDefined();
		expect(work.every((id) => untracked!.memberIds.includes(id))).toBe(true);
		for (const id of [opening, reply, steering, ...s.blocks.slice(tail).map((b) => b.id)]) expect(groupOf(host, id)).toBeUndefined();
		expect(resolveRecall(host.truth, [foldCode(untracked!.id)]).missing).toEqual([]);
	});

	it("leaves sealed untracked work live in pressure timing without pressure", async () => {
		const s = new Session();
		s.user("Go.");
		s.work(6, "outside");
		s.user("Continue.");
		s.work(2, "tail");
		const host = setup(s, 10);
		const c = new TaskfoldConductor({ timing: "pressure" });
		c.attach(host);
		await host.commitTurn();
		expect(host.groups()).toHaveLength(0);
	});

	it("keeps untracked pressure folds outside the user's tail dial while holding tail-size", async () => {
		const s = new Session();
		s.user("Go.");
		s.work(10, "early");
		const lateFrom = s.blocks.length;
		s.work(10, "late");
		const late = s.blocks.slice(lateFrom).map((b) => b.id);
		const host = setup(s, 0.35);
		const lateTokens = s.blocks.slice(lateFrom).reduce((n, b) => n + b.tokens, 0);
		host.setProtect(lateTokens);
		await attach(host);
		expect(host.groups().find((g) => carrier(g)?.untracked !== undefined)).toBeDefined();
		expect(host.groups().some((g) => late.some((id) => g.memberIds.includes(id)))).toBe(false);
	});

	it("never folds the final message: a record waits until another message follows", async () => {
		const s = new Session();
		s.user("Go.");
		const start = s.start("1", "Only task").call;
		s.work(3, "w");
		const done = s.finish("1", { outcome: "done" }).result;
		const host = setup(s, 0.5);
		await attach(host);
		expect(groupOf(host, start)).toBeUndefined();
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.user("Next?");
		host.appendBlocks(more.blocks);
		await host.commitTurn();
		expect(groupOf(host, done)?.role).toBe("assistant");
		expect(host.blocks().at(-1)?.kind).toBe("user");
	});

	it("uses reclaimed tokens and cache temperature for sealed runs and respects opt-out", async () => {
		const s = new Session();
		s.user("Go.");
		s.work(2, "short");
		s.user("Continue.");
		s.work(1, "tail");
		const warm = setup(s, 10);
		Object.assign(warm, { foldPolicy: () => ({ timing: "eager", cache: cacheProfileFor("*"), now: 1000, lastRequestAt: 999 }) });
		await attach(warm);
		expect(warm.groups()).toHaveLength(0);
		const cold = setup(s, 10);
		Object.assign(cold, { foldPolicy: () => ({ timing: "eager", cache: cacheProfileFor("*"), now: 1000, lastRequestAt: null }) });
		await attach(cold);
		expect(cold.groups().some((g) => carrier(g)?.untracked !== undefined)).toBe(true);
		const disabled = setup(s, 0.3);
		new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minTokens: 2000 } }).attach(disabled);
		await disabled.commitTurn();
		expect(disabled.groups()).toHaveLength(0);
	});

	it("preserves all document reads without pressure and only the newest under pressure", async () => {
		const s = new Session();
		s.user("Go.");
		s.work(3, "first");
		const old = s.call("read", { path: "docs/spec.md" }, "old rules ".repeat(500));
		s.work(3, "middle");
		s.user("Continue.");
		s.work(3, "second");
		const latest = s.call("read", { path: "docs/spec.md" }, "new rules ".repeat(500));
		s.work(3, "tail");
		s.user("Next.");
		s.work(1, "current");
		const warm = setup(s, 10);
		await attach(warm);
		for (const id of [old.call, old.result, latest.call, latest.result]) expect(groupOf(warm, id)).toBeUndefined();
		const pressured = setup(s, 0.1);
		await attach(pressured);
		expect(groupOf(pressured, old.call)).toBeDefined();
		expect(groupOf(pressured, old.result)).toBeDefined();
		expect(groupOf(pressured, latest.call)).toBeUndefined();
		expect(groupOf(pressured, latest.result)).toBeUndefined();
	});

	it("combines finished-task groups and open-task floor folds in one proposal", async () => {
		const s = new Session();
		s.user("Go.");
		const finished = s.start("1", "Finished").call;
		s.work(3, "done");
		s.finish("1", { outcome: "done" });
		const open = s.start("2", "Open").call;
		const doc = s.call("read", { path: "docs/spec.md" }, "Important policy");
		s.work(8, "open");
		const tailFrom = s.blocks.length;
		s.work(4, "recent");
		const host = setup(s, 0.5);
		const events: Parameters<NonNullable<ConductorHost["debug"]>>[0][] = [];
		Object.assign(host, { debug: (event: typeof events[number]) => events.push(event) });
		host.setProtect(s.blocks.slice(tailFrom).reduce((n, b) => n + b.tokens, 0));
		const proposals: string[][] = [];
		const propose = host.propose.bind(host);
		host.propose = (txn) => { proposals.push(txn.ops.map((op) => op.kind)); return propose(txn); };
		const c = new TaskfoldConductor({ keepRecentTasks: 0, floor: true, untracked: { enabled: false, minTokens: 2000 } });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.commitTurn();
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toContain("group");
		expect(proposals[0].some((kind) => kind === "replace" || kind === "fold")).toBe(true);
		expect(taskKeyOfSummary(groupOf(host, finished)?.summary)).toBe("work/1");
		expect(groupOf(host, open)).toBeUndefined();
		expect(host.truth.isFolded(host.truth.get(doc.result)!)).toBe(false);
		expect(s.blocks.slice(tailFrom).every((b) => !host.truth.isFolded(host.truth.get(b.id)!))).toBe(true);
		const floor = events.find(e => e.type === "fold" && e.task === null);
		expect(floor?.firstChangedBlock).toBeGreaterThanOrEqual(s.blocks.findIndex(b => b.id === open));
		expect(floor?.rewrittenTokens).toBeGreaterThan(0);
		// The coach needs to know whose span the pressure fold touched, not just that it happened.
		const status = host.statusLog.at(-1);
		expect(status?.metrics?.floor).toBe(1);
		expect(String(status?.metrics?.floor_spans).split(",")).toContain("work/2");
	});

	for (const timing of ["eager", "lazy", "pressure"] as const) it(`folds old steps of a long open task under pressure in ${timing} mode`, async () => {
		const s = new Session();
		const go = s.user("Go.");
		const start = s.start("1", "Long task").call;
		s.work(12, "open");
		const newest = s.blocks.at(-1)!.id;
		const host = setup(s, 0.3);
		const c = new TaskfoldConductor({ timing });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.commitTurn();
		const steps = host.groups().filter((g) => carrier(g)?.steps === "work/1");
		expect(steps.length).toBeGreaterThan(0);
		expect(groupOf(host, start)).toBeUndefined();
		expect(groupOf(host, go)).toBeUndefined();
		expect(groupOf(host, newest)).toBeUndefined();
		expect(host.stats().liveTokens).toBeLessThanOrEqual(host.stats().budget);
		expect(host.statusLog.some((e) => e.metrics?.level === "error")).toBe(false);
		expect(resolveRecall(host.truth, [foldCode(steps[0].id)]).missing).toEqual([]);
	});

	it("keeps open task delivery results live through steps and floor pressure", async () => {
		for (const floor of [false, true]) {
			const s = new Session();
			s.user("Go.");
			const claim = s.call("tasks", { action: "claim", list: "work" }, "claim ".repeat(350));
			const start = s.call("tasks", { action: "start", list: "work", id: "1" }, `Started work/1 "Task".\n${"criteria ".repeat(250)}`);
			const pin = s.call("tasks", { action: "pin", list: "work" }, "pin ".repeat(500));
			const attachment = s.call("tasks", { action: "attach", list: "work", id: "1" }, "attachment ".repeat(200));
			s.work(12, "open");
			const host = setup(s, 0.3);
			const c = new TaskfoldConductor({ keepRecentTasks: 0, floor });
			host.truth.setLocks(c.locks, c.label, c.tailTokens);
			c.attach(host);
			await host.commitTurn();
			expect(host.groups().length + host.truth.blocks.filter((b) => host.truth.isFolded(b)).length).toBeGreaterThan(0);
			for (const { result } of [claim, start, pin, attachment]) {
				expect(groupOf(host, result)).toBeUndefined();
				expect(host.truth.isFolded(host.truth.get(result)!)).toBe(false);
			}
			const more = new Session();
			Object.assign(more, { order: s.blocks.length, resp: 100, turn: 3 });
			more.finish("1", { outcome: "done" });
			more.work(3, "tail");
			host.appendBlocks(more.blocks);
			await host.commitTurn();
			expect(groupOf(host, start.result)).toBeDefined();
		}
	});

	it("absorbs an open task's step carriers into its record when it finishes", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Long task");
		s.work(12, "open");
		const host = setup(s, 0.3);
		await attach(host);
		expect(host.groups().some((g) => carrier(g)?.steps === "work/1")).toBe(true);
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.finish("1", { outcome: "Long task done." });
		more.work(1, "next");
		host.appendBlocks(more.blocks);
		await host.commitTurn();
		expect(host.groups().some((g) => carrier(g)?.steps !== undefined)).toBe(false);
		const records = host.groups().filter((g) => taskKeyOfSummary(g.summary) === "work/1");
		expect(records.length).toBeGreaterThan(0);
	});

	it("clears saturation status once pressure subsides", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Long task");
		s.work(12, "open");
		const host = setup(s, 0.3);
		const c = new TaskfoldConductor({ steps: { enabled: false, minSteps: 4 } });
		c.attach(host);
		await host.commitTurn();
		expect(host.statusLog.at(-1)?.metrics?.level).toBe("error");
		host.setBudget(host.stats().liveTokens * 10);
		await host.commitTurn();
		expect(host.statusLog.at(-1)?.metrics?.level).toBeUndefined();
	});

	it("reports the largest open task when step folding is off and nothing else can relieve pressure", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Long task");
		s.work(12, "open");
		const host = setup(s, 0.3);
		const c = new TaskfoldConductor({ keepRecentTasks: 0, steps: { enabled: false, minSteps: 4 } });
		host.truth.setLocks(c.locks, c.label, c.tailTokens);
		c.attach(host);
		await host.commitTurn();
		const last = host.statusLog.at(-1);
		expect(last?.text).toContain("open task work/1");
		expect(last?.metrics?.level).toBe("error");
		expect(last?.metrics?.saturated).toBe(1);
		expect(last?.metrics?.holder_task).toBe("work/1");
		expect(last?.metrics?.holder_tokens).toBeGreaterThan(0);
	});

	it("classifies twelve messages with bounded concurrency and retries capacity errors", async () => {
		vi.useFakeTimers();
		const s = new Session();
		s.user("Goal");
		const ids = Array.from({ length: 12 }, (_, i) => s.user(`Message ${i}`));
		const host = new TestHost();
		const ledger = new VerdictLedger();
		let active = 0;
		let maximum = 0;
		let capacityFailures = 0;
		host.classifier = async () => {
			active++;
			maximum = Math.max(maximum, active);
			try {
				if (active > 2 || capacityFailures++ < 2) throw new Error("too many concurrent model calls in flight (max 4)");
				await Promise.resolve();
				return { answers: { loss: { type: "score", score: 0.1, confidence: 0.9 } }, model: "test" };
			} finally {
				active--;
			}
		};
		new TaskfoldConductor({}, ledger).attach(host);
		host.appendBlocks(s.blocks);
		await vi.advanceTimersByTimeAsync(250);
		vi.useRealTimers();
		for (let i = 0; i < 100 && ids.some((id) => !ledger.has(id)); i++) await Promise.resolve();
		expect(maximum).toBeLessThanOrEqual(2);
		expect(ids.map((id) => ledger.get(id)?.source)).toEqual(ids.map(() => "classifier"));
	});

	it("ignores classifier results and errors after detach", async () => {
		for (const fail of [false, true]) {
			const s = new Session();
			s.user("Goal");
			const id = s.user("Steer");
			const host = new TestHost();
			const ledger = new VerdictLedger();
			const deferred = Promise.withResolvers<ClassificationResult>();
			host.classifier = () => deferred.promise;
			const c = new TaskfoldConductor({}, ledger);
			c.attach(host);
			host.appendBlocks(s.blocks);
			expect(host.classifyLog).toHaveLength(1);
			c.detach();
			if (fail) deferred.reject(new Error("failed"));
			else deferred.resolve({ answers: { loss: { type: "score", score: 0.1, confidence: 0.9 } }, model: "test" });
			await deferred.promise.catch(() => {});
			await Promise.resolve();
			await Promise.resolve();
			expect(ledger.get(id)).toBeUndefined();
		}
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
		expect(carrier(first)).toEqual({ part: "work/1", of: [1, 2] });
		expect(isHistoryCarrier(last.summary)).toBe(true);
		expect(taskKeyOfSummary(last.summary)).toBe("work/1");
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

	it("uses classifier fallback for empty or rejected extraction, but routes existing facts", async () => {
		for (const result of [{ ids: [], applied: 0, dropped: 0 }, { ids: [], applied: 0, dropped: 2 }, { ids: ["g1"], applied: 0, dropped: 0 }]) {
			const { s, start } = oneTask((s) => s.user("Never touch vendor/."));
			const userId = s.blocks.find((b) => b.text === "Never touch vendor/.")!.id;
			const ledger = new VerdictLedger(), host = new TestHost();
			host.classifier = () => ({ answers: { loss: { type: "score", score: 2.9, confidence: 0.9 } }, model: "test/cls" });
			host.queueCompletion({ text: '{"ops":[]}', model: "test/x" });
			const port: RoutingPort = { current: { prepare: () => ({ system: "Extract", prompt: "p", apply: async () => result }) } };
			new TaskfoldConductor({ keepRecentTasks: 0 }, ledger, port).attach(host);
			host.appendBlocks(s.blocks);
			host.setProtect(200);
			await new Promise((r) => setTimeout(r, 0));
			host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
			await host.commitTurn();
			if (result.ids.length) {
				expect(ledger.get(userId)?.routed?.ids).toEqual(["g1"]);
				expect(groupOf(host, start)?.memberIds).toContain(userId);
			} else {
				expect(ledger.get(userId)?.routed).toBeUndefined();
				expect(groupOf(host, userId)).toBeUndefined();
			}
		}
	});

	it("routes a new user message into the list, then folds it with its span", async () => {
		const { s, start, end } = oneTask((s) => s.user("Never touch vendor/."));
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("vendor"))!.id;
		const applied: string[] = [];
		const port: RoutingPort = { current: { prepare: (m, last) => ({ system: "extract", prompt: `${last}|${m}`, apply: async (reply, message) => { applied.push(`${reply}|${message}`); return { ids: ["p1"], applied: 1, dropped: 0 }; } }) } satisfies TaskfoldRouting };
		const ledger = new VerdictLedger();
		const host = new TestHost();
		host.queueCompletion({ text: '{"ops":[]}', model: "test/x" });
		const c = new TaskfoldConductor({ keepRecentTasks: 0 }, ledger, port);
		c.attach(host);
		host.appendBlocks(s.blocks);
		host.setProtect(200);
		await new Promise((r) => setTimeout(r, 0));
		expect(host.completeLog).toHaveLength(1);
		expect(host.completeLog[0].system).toBe("extract");
		expect(applied).toEqual(['{"ops":[]}|Never touch vendor/.']);
		expect(ledger.get(userId)?.routed).toMatchObject({ ids: ["p1"] });
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		const g = groupOf(host, start)!;
		expect(g.memberIds).toContain(userId);
		expect(g.memberIds).toContain(end);
	});

	it("links a routed message to the items it created in the record of an open parent's child", async () => {
		const s = new Session();
		s.user("Build the store.");
		s.start("1", "Store");
		const start = s.start("1.1", "Draft").call;
		s.work(2, "a");
		s.user("Never touch vendor/ and keep the API stable.");
		s.call("bash", { command: "npm test" }, "12 passed");
		s.finish("1.1", { outcome: "Drafted." });
		s.work(4, "next");
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("vendor"))!.id;
		const ledger = new VerdictLedger();
		ledger.route(userId, { ids: ["p1", "g2"], at: "2026-11-08T00:00:00.000Z" });
		const host = new TestHost();
		const c = new TaskfoldConductor({ keepRecentTasks: 0 }, ledger);
		c.attach(host);
		host.appendBlocks(s.blocks);
		host.setProtect(200);
		await host.commitTurn();
		const g = groupOf(host, start)!;
		expect(g.memberIds).toContain(userId);
		expect(g.summary).toContain('"user":[{"said":"Never touch vendor/ and keep the API stable.","ids":["p1","g2"]}]');
	});

	it("keeps the message raw when the extraction fails", async () => {
		const { s, start, end } = oneTask((s) => s.user("Never touch vendor/."));
		const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("vendor"))!.id;
		const port: RoutingPort = { current: { prepare: () => ({ system: "extract", prompt: "p", apply: async () => { throw new Error("the extractor did not return JSON"); } }) } };
		const ledger = new VerdictLedger();
		const host = new TestHost();
		host.queueCompletion({ text: "sure", model: "test/x" });
		const c = new TaskfoldConductor({ keepRecentTasks: 0 }, ledger, port);
		c.attach(host);
		host.appendBlocks(s.blocks);
		host.setProtect(200);
		await new Promise((r) => setTimeout(r, 0));
		expect(ledger.get(userId)?.routed).toBeUndefined();
		host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
		await host.commitTurn();
		expect(groupOf(host, userId)).toBeUndefined();
		expect(groupOf(host, start)!.id).not.toBe(groupOf(host, end)!.id);

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

	it("uses the registry maxLoss threshold and keeps a user message at the boundary verbatim", async () => {
		for (const maxLoss of [2, 2.1]) {
			const { s } = oneTask((s) => s.user("Don't touch the lexer."));
			const userId = s.blocks.find((b) => b.kind === "user" && b.text.includes("lexer"))!.id;
			const host = new TestHost();
			host.classifier = () => ({ answers: { loss: { type: "score", score: 2, confidence: 0.8 } }, model: "test/cls" });
			const conductor = entryById("taskfold")!.create!({ maxLoss });
			conductor.attach(host);
			host.appendBlocks(s.blocks);
			host.setProtect(200);
			await new Promise((r) => setTimeout(r, 0));
			host.setBudget(Math.ceil(host.stats().liveTokens * 0.7));
			await host.commitTurn();
			expect(!!groupOf(host, userId)).toBe(maxLoss > 2);
			conductor.detach();
		}
	});
	it("keeps the second task's code when its start shares the first task's closing message", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "First");
		s.work(2, "first");
		const boundary = s.batch([
			["tasks", { action: "complete", list: "work", id: "1", report: { outcome: "First done" } }, "work/1 is done."],
			["tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "Second".'],
		]);
		s.work(2, "second");
		const host = setup(s, 10);
		const proposals = vi.spyOn(host, "propose");
		const c = await attach(host);
		expect(groupOf(host, boundary.calls[1])).toBeDefined();
		const before = s.blocks.length;
		s.finish("2", { outcome: "Second done" });
		s.work(3, "tail");
		host.appendBlocks(s.blocks.slice(before));
		await host.commitTurn();
		const group = host.groups().find((g) => taskKeyOfSummary(g.summary) === "work/2");
		expect(group?.summary?.startsWith(foldTag("t:work/2"))).toBe(true);
		const handle = group?.handles?.find((h) => h.id === "t:work/2");
		expect(handle).toBeDefined();
		for (const id of boundary.calls) expect(handle?.memberIds).not.toContain(id);
		expect(resolveRecall(host.truth, [foldCode("t:work/2")]).missing).toEqual([]);
		for (const result of proposals.mock.results) expect((await result.value).results.some((r) => r.clamped === "invalid-group")).toBe(false);
		c.detach();
	});

	it("recalls a task around a human-held middle block", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Task");
		s.work(1, "before");
		const held = s.text("Keep this visible");
		s.work(1, "after");
		const end = s.finish("1", { outcome: "Done" }).result;
		s.work(3, "tail");
		const host = setup(s, 10);
		expect(host.truth.apply([{ kind: "pin", ids: [held] }], "you").results[0].applied).toBe(true);
		const proposals = vi.spyOn(host, "propose");
		const c = await attach(host);
		const group = groupOf(host, end);
		expect(group?.summary?.startsWith(foldTag("t:work/1"))).toBe(true);
		const handle = group?.handles?.find((h) => h.id === "t:work/1");
		expect(handle).toBeDefined();
		expect(handle?.memberIds).not.toContain(held);
		expect(resolveRecall(host.truth, [foldCode("t:work/1")]).missing).toEqual([]);
		for (const result of proposals.mock.results) expect((await result.value).results.some((r) => r.clamped === "invalid-group")).toBe(false);
		c.detach();
	});

	it("includes a recall code for a child held only in part", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Parent");
		s.start("1.1", "Child");
		s.work(1, "before");
		const held = s.text("Keep this visible");
		s.work(1, "after");
		s.finish("1.1", { outcome: "Child done" });
		const end = s.finish("1", { outcome: "Parent done" }).result;
		s.work(3, "tail");
		const host = setup(s, 10);
		expect(host.truth.apply([{ kind: "pin", ids: [held] }], "you").results[0].applied).toBe(true);
		const proposals = vi.spyOn(host, "propose");
		const c = await attach(host);
		const group = groupOf(host, end);
		expect(carrier(group)?.children["1.1"].recall).toBe(foldTag("t:work/1.1"));
		expect(group?.handles?.find((h) => h.id === "t:work/1.1")?.memberIds).not.toContain(held);
		expect(resolveRecall(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
		for (const result of proposals.mock.results) expect((await result.value).results.some((r) => r.clamped === "invalid-group")).toBe(false);
		c.detach();
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
		const oldChildCode = foldCode("t:work/1.1");
		expect(carrier(child)).toMatchObject({ task: "work/1.1", outcome: "Token store extracted." });
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
		expect(carrier(parent)).toMatchObject({ history: "work/1", outcome: "Auth refactored.", subtasks: { done: 1 }, children: { "1.1": { title: expect.any(String), recall: foldTag("t:work/1.1") } } });
		expect(groupOf(host, childStart)?.id).toBe(parent.id);
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(childStart);
		expect(recalled.restored[0].ids).toContain(childEnd);
		expect(resolveRecall(host.truth, [oldChildCode]).missing).toEqual([]);
		c.detach();
	});

	it("keeps a child's handles and the user message intact when the parent folds around them", async () => {
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
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.call("edit", { path: "parent.ts" }, "edited");
		const parentEnd = more.finish("1", { outcome: "Auth ready" }).result;
		more.work(3, "tail2");
		host.setBudget(host.stats().liveTokens * 10);
		host.appendBlocks(more.blocks);
		host.setBudget(Math.ceil(host.stats().liveTokens * 1.2));
		await host.commitTurn();
		expect(carrier(groupOf(host, parentStart))).toEqual({ part: "work/1", of: [1, 2] });
		expect(carrier(groupOf(host, parentEnd))).toMatchObject({ history: "work/1", subtasks: { done: 1 }, children: { "1.1": { title: expect.any(String), recall: foldTag("t:work/1.1") } } });
		expect(groupOf(host, message)).toBeUndefined();
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toEqual(expect.arrayContaining([childStart, childEnd]));
		expect(recalled.restored.find((r) => r.code === foldCode("t:work/1.1"))?.ids).toContain(message);
		expect(JSON.stringify(recalled)).toContain("Keep interface");
	});
	it("shows a folded root's direct children only, and recalls each child's own content", async () => {
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
		const entry = carrier(groupOf(host, parent))!;
		expect(entry.children).toEqual({ "1.1": { title: expect.any(String), recall: foldTag("t:work/1.1") }, "1.2": { title: expect.any(String), recall: foldTag("t:work/1.2") }, "1.3": { title: expect.any(String), recall: foldTag("t:work/1.3") } });
		expect(entry.subtasks).toEqual({ done: 4 });
		const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1")]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toContain(leaf);
		expect(recalled.restored[0].ids).not.toContain(parent);
		expect(resolveRecall(host.truth, [foldCode("t:work/1")]).restored[0].ids).toContain(parent);
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
		const propose = host.propose.bind(host);
		host.propose = async (txn) => {
			const index = txn.ops.findIndex((op) => op.kind === "group" && typeof op.summary === "string" && op.summary.includes('"history":"work/1"'));
			if (index < 0) return propose(txn);
			const result = await propose({ ...txn, ops: txn.ops.filter((_op, i) => i !== index) });
			result.results.splice(index, 0, { op: txn.ops[index], applied: false, clamped: "invalid-group" });
			return result;
		};
		host.appendBlocks(more.blocks);
		await new Promise((resolve) => setTimeout(resolve, 0));
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
		expect(taskKeyOfSummary(groupOf(host, parent)?.summary)).toBe("work/1");
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
		expect(carrier(groupOf(host, second))).toMatchObject({ task: "work/1.2" });
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

	it("keeps once-opened tasks open below pressure after two newer roots", async () => {
		const s = new Session();
		s.user("Go.");
		for (const id of ["1", "2", "3"]) {
			s.start(id, `Task ${id}`);
			s.work(2, id);
			s.finish(id, { outcome: "done" });
		}
		const host = setup(s, 10);
		const ledger = new VerdictLedger();
		ledger.setUnfold("work/1", { count: 1, open: true });
		new TaskfoldConductor({ keepRecentTasks: 0 }, ledger).attach(host);
		await host.commitTurn();
		expect(ledger.unfoldStates().get("work/1")).toEqual({ count: 1, open: true });
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
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minTokens: 2000 } }, ledger);
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
		new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minTokens: 2000 } }, resumed).attach(host);
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
		expect(taskKeyOfSummary(summary)).toBe("work/1");
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
		const oldCode = foldCode("t:work/1.1");
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
		expect(carrier(groupOf(host, second))).toMatchObject({ task: "work/1.2" });
	});

	it("keeps criteria, exact pins and a cascaded abandon in a failed subtask's record", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Parent");
		const child = s.start("1.1", "Child").call;
		s.work(1, "child");
		const end = s.finish("1.1", { outcome: "Cannot continue" }, "fail");
		s.blocks.find((b) => b.id === end.result)!.details = {
			task: { acceptanceCriteria: ["All checks pass"], pins: [{ kind: "rule", text: "Keep\nthis exactly", source: "user" }] },
			cascaded: [{ id: "1.1.1", title: "Not started", status: "abandoned", report: { outcome: "Abandoned with parent" } }],
		};
		s.work(3, "tail");
		const host = setup(s);
		await attach(host);
		const entry = carrier(groupOf(host, child))!;
		expect(entry.status).toBe("failed");
		expect(entry.criteria).toEqual(["All checks pass"]);
		expect(entry.pins).toEqual([{ kind: "rule", text: "Keep\nthis exactly", source: "user" }]);
		expect(entry.children).toEqual([{ task: "work/1.1.1", title: "Not started", status: "abandoned", outcome: "Abandoned with parent" }]);
		expect(groupOf(host, child)!.summary).not.toContain(foldTag("t:work/1.1.1"));
	});

	it("keeps a root's pins verbatim in its history entry", async () => {
		const { s, start, end } = oneTask();
		s.blocks.find((b) => b.id === end)!.details = { task: { pins: [{ kind: "rule", text: "Keep\nthis exactly", source: "user" }] } };
		const host = setup(s);
		await attach(host);
		expect(carrier(groupOf(host, start))?.pins).toEqual([{ kind: "rule", text: "Keep\nthis exactly", source: "user" }]);
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

	it("scans open spans to the last block after finished ones, and keys carriers by their JSON", () => {
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
		const tag = foldTag("g:x");
		expect(taskKeyOfSummary(`${tag} {"task":"work/1.1","title":"Inner","status":"done"}`)).toBe("work/1.1");
		expect(taskKeyOfSummary(`${tag} {"history":"work/1","title":"Outer","status":"done"}`)).toBe("work/1");
		expect(taskKeyOfSummary(`${tag} {"part":"work/2","of":[1,2]}`)).toBe("work/2");
		expect(taskKeyOfSummary(`${tag} {"untracked":"Work outside tasks"}`)).toBe("untracked");
		expect(taskKeyOfSummary(`${tag} [task-record] work/1.1 "Inner"  status: done`)).toBeNull();
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
		expect(carrier(groupOf(host, start))).toEqual({ part: "work/1", of: [1, 2] });
		expect(taskKeyOfSummary(groupOf(host, other)?.summary)).toBe("work/2");
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

	it("keeps the newest finished tasks raw when keepRecentTasks asks for it, and folds the older ones", async () => {
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
		const c = new TaskfoldConductor({ keepRecentTasks: 1 });
		c.attach(host);
		await host.commitTurn();
		expect(taskKeyOfSummary(groupOf(host, a)?.summary)).toBe("work/1");
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
		new TaskfoldConductor({ keepRecentTasks: 1 }).attach(host);
		await host.commitTurn();
		expect(taskKeyOfSummary(groupOf(host, start)?.summary)).toBe("work/1");
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
		expect(taskKeyOfSummary(first.summary)).toBe("work/1");
		expect(first.memberIds).toContain(shared.calls[1]);
		expect(taskKeyOfSummary(second.summary)).toBe("work/2");
		expect(second.memberIds).not.toContain(shared.calls[1]);
		expect(second.memberIds).toContain(shared.results[1]);
	});

	it("folds a task whose closing message also carries the next task's work at once, without growing later", async () => {
		const s = new Session();
		s.user("Go.");
		const a = s.start("1", "First").call;
		s.work(3, "a");
		const shared = s.batch([
			["tasks", { action: "complete", list: "work", id: "1", report: { outcome: "first" } }, "work/1 is done."],
			["tasks", { action: "start", list: "work", id: "2" }, 'Started work/2 "Second".'],
			["bash", { command: "echo hi > notes.txt" }, ""],
			["tasks", { action: "complete", list: "work", id: "2", report: { outcome: "second" } }, "work/2 is done."],
		]);
		const host = setup(s, 0.4);
		await attach(host);
		const first = groupOf(host, a)!;
		expect(taskKeyOfSummary(first?.summary)).toBe("work/1");
		expect(first.memberIds).toContain(shared.results[0]);
		expect(groupOf(host, shared.results[3])).toBeUndefined();
		const more = new Session();
		Object.assign(more, { order: s.blocks.length, resp: 100, turn: 5 });
		more.work(3, "later");
		host.appendBlocks(more.blocks);
		await host.commitTurn();
		expect(groupOf(host, a)?.memberIds).toEqual(first.memberIds);
	});
	it("turns the deepest children into history entries when a record exceeds recordTokens, keeping handles and pins", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Root");
		const parent = s.start("1.1", "Parent").call;
		s.start("1.1.1", "Child");
		s.work(2, "child");
		const finish = s.finish("1.1.1", { outcome: "done", decisions: ["Details ".repeat(60)] });
		s.blocks.find((b) => b.id === finish.result)!.details = { task: { pins: [{ kind: "rule", text: "Keep this\nexactly", source: "user" }] } };
		s.finish("1.1", { outcome: "parent done" });
		s.work(3, "tail");
		const host = setup(s);
		new TaskfoldConductor({ keepRecentTasks: 0, recordTokens: 110 }).attach(host);
		await host.commitTurn();
		const entry = carrier(groupOf(host, parent))!;
		expect(entry.task).toBe("work/1.1");
		expect(entry.children).toHaveLength(1);
		expect(entry.children[0]).toMatchObject({ history: "work/1.1.1", pins: [{ kind: "rule", text: "Keep this\nexactly", source: "user" }], recall: foldTag("t:work/1.1.1") });
		expect(groupOf(host, parent)!.summary).not.toContain("Details Details");
		expect(resolveRecall(host.truth, [foldCode("t:work/1.1.1")]).missing).toEqual([]);
	});
	it("keeps child records within the raw child budget regardless of own report size or calibration", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Root");
		const parent = s.start("1.1", "Parent").call;
		s.start("1.1.1", "Child");
		s.work(2, "child");
		const decisions = ["Detail ".repeat(50)];
		s.finish("1.1.1", { outcome: "done", decisions });
		s.finish("1.1", { outcome: "done ".repeat(400) });
		s.work(3, "tail");
		const host = setup(s);
		host.truth.setCalibration(4);
		new TaskfoldConductor({ keepRecentTasks: 0, recordTokens: 300 }).attach(host);
		await host.commitTurn();
		expect(carrier(groupOf(host, parent))?.children[0]).toMatchObject({ task: "work/1.1.1", decisions });
	});
	it("folds long own reports verbatim despite a small child cap and high calibration", async () => {
		for (const root of [false, true]) {
			const s = new Session();
			s.user("Go.");
			s.start("1", "Root");
			const start = s.start("1.1", "Task").call;
			s.work(2, "task");
			const report = { outcome: "done ".repeat(400), decisions: ["Keep ".repeat(200)] };
			s.finish("1.1", report);
			if (root) s.finish("1", { outcome: report.outcome });
			s.work(3, "tail");
			const host = setup(s);
			host.truth.setCalibration(4);
			new TaskfoldConductor({ keepRecentTasks: 0, recordTokens: 100 }).attach(host);
			await host.commitTurn();
			const entry = carrier(groupOf(host, start));
			expect(entry?.outcome).toBe(report.outcome);
			expect(root ? entry?.history : entry?.task).toBe(root ? "work/1" : "work/1.1");
			if (!root) expect(entry?.decisions).toEqual(report.decisions);
			const recalled = resolveRecall(host.truth, [foldCode("t:work/1.1")]);
			expect(recalled.missing).toEqual([]);
			expect(JSON.stringify(recalled.restored)).toContain("Keep Keep");
		}
	});
	it("under pressure turns folded records inside an open root into history entries, oldest first, keeping tags and pins", async () => {
		const s = new Session();
		s.user("Go.");
		s.start("1", "Root");
		const starts: string[] = [];
		for (const id of ["1.1", "1.2", "1.3"]) {
			starts.push(s.start(id, `Step ${id}`).call);
			s.work(1, id);
			const end = s.finish(id, { outcome: `${id} done`, decisions: [`decision ${id} — ${"why ".repeat(400)}`] });
			if (id === "1.1") s.blocks.find((b) => b.id === end.result)!.details = { task: { pins: [{ kind: "rule", text: "Keep this rule", source: "user" }] } };
		}
		s.work(1, "tail");
		const host = setup(s, 5);
		const c = new TaskfoldConductor({ keepRecentTasks: 0, recordTokens: 5000, untracked: { enabled: false, minTokens: 2000 } });
		c.attach(host);
		await host.commitTurn();
		expect(starts.map((id) => carrier(groupOf(host, id))?.task)).toEqual(["work/1.1", "work/1.2", "work/1.3"]);
		host.setBudget(Math.floor(host.stats().liveTokens / 0.81));
		await host.commitTurn();
		const kinds = starts.map((id) => (isHistoryCarrier(groupOf(host, id)?.summary) ? "history" : "task"));
		expect(kinds[0]).toBe("history");
		expect(kinds.lastIndexOf("history")).toBeLessThan(kinds.length - 1);
		expect(carrier(groupOf(host, starts[0]))).toMatchObject({ history: "work/1.1", pins: [{ kind: "rule", text: "Keep this rule", source: "user" }] });
		expect(groupOf(host, starts[0])!.summary!.startsWith(foldTag("t:work/1.1"))).toBe(true);
		expect(groupOf(host, starts[0])!.role).toBe("assistant");
		expect(resolveRecall(host.truth, [foldCode("t:work/1.1")]).missing).toEqual([]);
		c.detach();
	});

	it("builds history entries that stay truthful about failed and abandoned descendants", () => {
		const leaf: RecordObj = { task: "w/1.1.1", title: "Leaf", status: "failed", recall: foldTag("t:w/1.1.1"), outcome: "Boom", pins: [{ kind: "rule", text: "r", source: "user" }] };
		const mid: RecordObj = { task: "w/1.1", title: "Mid", status: "done", recall: foldTag("t:w/1.1"), children: [leaf, { task: "w/1.1.2", title: "Skipped", status: "abandoned" }] };
		const root: RecordObj = { task: "w/1", title: "Root", status: "done", outcome: "x".repeat(400), children: [mid] };
		const h = toHistory(root);
		expect(h.subtasks).toEqual({ done: 1, failed: 1, abandoned: 1 });
		expect(h.children).toEqual({ "1.1": { title: expect.any(String), recall: foldTag("t:w/1.1") } });
		expect(h.outcome).toBe(root.outcome);
		expect(h.pins).toEqual([{ kind: "rule", text: "r", source: "user" }]);
		expect(shrinkDeepest(root)).toBe(true);
		expect((root.children![0] as RecordObj).children![0]).toMatchObject({ history: "w/1.1.1" });
		expect(shrinkDeepest(root)).toBe(true);
		expect((root.children![0] as RecordObj).children![1]).toMatchObject({ history: "w/1.1.2" });
		expect(shrinkDeepest(root)).toBe(true);
		expect(root.children![0]).toMatchObject({ history: "w/1.1" });
		expect(shrinkDeepest(root)).toBe(false);
	});
	it("turns every finished root into history at the next request, newest included, each recallable by its own code", async () => {
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
		const groups = starts.map((id) => groupOf(host, id));
		expect(groups.every((g, i) => isHistoryCarrier(g?.summary) && taskKeyOfSummary(g?.summary) === `work/${i + 1}`)).toBe(true);
		expect(new Set(groups.map((g) => g!.id)).size).toBe(4);
		for (const i of [1, 2, 3, 4]) expect(resolveRecall(host.truth, [foldCode(`t:work/${i}`)]).missing).toEqual([]);
		c.detach();
	});});

