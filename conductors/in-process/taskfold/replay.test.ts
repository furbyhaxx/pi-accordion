/*
 * replay.test.ts — synthetic adversarial replays of SPEC-0002 §8–§9.
 *
 * Each scenario builds a session whose live tokens sit far above the budget, runs real epochs
 * through `TestHost` (a real `Truth`, so every proposed op is clamped exactly as in a live
 * session), and asserts the properties the spec actually promises:
 *
 *   1. nothing leaves the context — every fold stays recallable and every block survives;
 *   2. an epoch never grows the context;
 *   3. a finished task outside the tail folds at eager timing regardless of span size;
 *   4. once no foldable unit is left, a session still above `high·budget` says "saturated"
 *      instead of staying quiet — with or without the opt-in safety options.
 *
 * Taskfold is explicitly not a hard budget guarantee (SPEC-0002 §9.2), so these tests never
 * assert `live <= low·budget`; they assert that whatever remains is reported.
 */
import { describe, it, expect } from "vitest";
import { TaskfoldConductor } from "./taskfold";
import { TestHost } from "../../../core/conductor/testhost";
import { foldCode } from "../../../core/digest";
import { resolveRecall } from "../../../core/agentView";
import type { Block } from "../../../core/types";

const BIG = 4000;

class Script {
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
	read(label: string, size = BIG): { call: string; result: string } {
		const r = ++this.resp;
		const callId = `c${r}`;
		const call = this.push({ id: `a:resp${r}:p0`, kind: "tool_call", text: `read ${label}`, toolName: "read", callId });
		const result = this.push({ id: `r:${callId}`, kind: "tool_result", text: `${label} `.repeat(size), toolName: "read", callId });
		return { call, result };
	}
	task(action: string, id: string | null, extra: Record<string, unknown> = {}, isError = false): { call: string; result: string } {
		const r = ++this.resp;
		const callId = `c${r}`;
		const args = { action, list: "work", ...(id === null ? {} : { id }), ...extra };
		const call = this.push({ id: `a:resp${r}:p0`, kind: "tool_call", text: `tasks ${JSON.stringify(args)}`, toolName: "tasks", callId });
		const result = this.push({ id: `r:${callId}`, kind: "tool_result", text: `work/${id ?? ""} ${action}`, toolName: "tasks", callId, isError });
		return { call, result };
	}
	note(text: string): string {
		return this.push({ id: `a:resp${++this.resp}:p0`, kind: "text", text });
	}
}

type Scenario = { name: string; build(s: Script): void; finishedTask?: boolean };

const scenarios: Scenario[] = [
	{
		name: "no tasks at all",
		build(s) {
			s.user("Triage this incident.");
			for (let i = 0; i < 6; i++) s.read(`log-${i}`);
			s.note("Read every log; no list is bound yet.");
		},
	},
	{
		name: "one giant leaf result",
		finishedTask: true,
		build(s) {
			s.user("Fix the parser.");
			s.task("start", "1", { title: "Fix parser" });
			s.read("parser-source", 40_000);
			s.task("complete", "1", { report: { outcome: "Parser fixed." } });
			s.read("tail");
		},
	},
	{
		name: "blocked sibling work",
		build(s) {
			s.user("Split the migration.");
			s.task("start", "1", { title: "Migration" });
			s.task("start", "1.1", { title: "Schema" });
			s.read("schema");
			s.task("block", "1.1", { reason: "user-decision", detail: "schema flavour" }, true);
			s.task("start", "1.2", { title: "Backfill" });
			s.read("backfill");
			s.task("complete", "1.2", { report: { outcome: "Backfilled." } });
			s.note("Parent left open while 1.1 waits.");
		},
	},
	{
		name: "pre-list exploration",
		finishedTask: true,
		build(s) {
			s.user("Understand the repo.");
			s.read("readme");
			s.read("config");
			s.read("entrypoint");
			s.task("start", "1", { title: "Map the codebase" });
			s.read("module");
			s.task("complete", "1", { report: { outcome: "Mapped." } });
			// Record form waits for a following message (SPEC-0002 §8); without one the span is
			// legitimately still raw, so the fixture must not expect a group.
			s.read("wrapup");
		},
	},
	{
		name: "model switch mid-session",
		finishedTask: true,
		build(s) {
			s.user("Write the docs.");
			s.task("start", "1", { title: "Docs" });
			s.read("draft-a");
			s.read("draft-b");
			s.task("complete", "1", { report: { outcome: "Docs written." } });
			s.read("appendix");
		},
	},
];

function session(script: Script, factor: number): TestHost {
	const host = new TestHost();
	host.appendBlocks(script.blocks);
	host.setProtect(300);
	host.setBudget(Math.ceil(host.stats().liveTokens / factor));
	return host;
}

function foldableCodes(host: TestHost): string[] {
	const codes = new Set<string>();
	for (const group of host.groups()) {
		const handle = group.handles?.find((h) => typeof h.id === "string" && h.id.startsWith("t:"));
		if (handle) codes.add(foldCode(handle.id));
	}
	for (const block of host.truth.blocks) if (block.subst && block.id.startsWith("r:")) codes.add(foldCode(block.id));
	return [...codes];
}

/** Restores every fold and checks the original text is still there. */
function expectRecallable(host: TestHost): void {
	const texts = new Map(host.truth.blocks.map((b) => [b.id, b.text]));
	for (const code of foldableCodes(host)) {
		const recalled = resolveRecall(host.truth, [code]);
		expect(recalled.missing, `unreachable fold ${code}`).toEqual([]);
		for (const item of recalled.restored) {
			for (const id of item.ids) {
				const text = texts.get(id);
				if (!text || text.length < 200) continue;
				expect(item.text.includes(text.slice(0, 200)), `${code} lost ${id}`).toBe(true);
			}
		}
	}
}

const lastStatus = (host: TestHost) => host.statusLog.at(-1);
const saturated = (host: TestHost) => String(lastStatus(host)?.text ?? "").includes("saturated") && lastStatus(host)?.metrics?.level === "error";

describe("taskfold budget replays", () => {
	for (const k of [0.42, 1.0, 1.7]) {
		for (const scenario of scenarios) {
			it(`replays ${scenario.name} honestly at k=${k}`, async () => {
				const s = new Script();
				scenario.build(s);
				const host = session(s, 1.4);
				host.truth.setCalibration(k, host.truth.blocks.at(-1)!.order);
				const conductor = new TaskfoldConductor({ keepRecentTasks: 0 });
				host.truth.setLocks(conductor.locks, conductor.label, conductor.tailTokens);
				conductor.attach(host);
				const before = host.stats();
				await host.commitTurn();
				const after = host.stats();

				expect(host.truth.blocks).toHaveLength(s.blocks.length);
				expect(after.liveTokens).toBeLessThanOrEqual(before.liveTokens);
				expectRecallable(host);
				if (scenario.finishedTask) expect(host.groups().length).toBeGreaterThan(0);

				// A second epoch over unchanged content must be a no-op, and if the session is still at
				// or above the high watermark at that point, spec §9 step 7 requires it to say so.
				const rev = host.stats().rev;
				await host.commitTurn();
				const settled = host.stats();
				const grew = settled.liveTokens > after.liveTokens;
				expect(grew, `${scenario.name}@${k} grew on a repeated epoch`).toBe(false);
				if (settled.liveTokens >= 0.8 * settled.budget) {
					expect(saturated(host), `${scenario.name}@${k} left ${settled.liveTokens}/${settled.budget} unreported after rev ${rev}`).toBe(true);
				}
				conductor.detach();
			});
		}
	}

	it("reports saturation instead of hiding it when the safety options are off", async () => {
		const s = new Script();
		s.user("One huge open task.");
		s.task("start", "1", { title: "Everything" });
		s.read("everything", 60_000);
		const host = session(s, 1.2);
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minTokens: 2000 }, floor: false, steps: { enabled: false, minSteps: 1 } });
		host.truth.setLocks(conductor.locks, conductor.label, conductor.tailTokens);
		conductor.attach(host);
		await host.commitTurn();
		await host.commitTurn();
		const after = host.stats();
		expect(host.truth.blocks).toHaveLength(s.blocks.length);
		expect(after.liveTokens).toBeGreaterThan(0.8 * after.budget);
		expect(saturated(host)).toBe(true);
		expect(lastStatus(host)?.text).toContain("open task work/1");
		conductor.detach();
	});

	it("honours an opt-out of untracked records instead of folding them anyway", async () => {
		const s = new Script();
		s.user("Read a lot without a list.");
		for (let i = 0; i < 12; i++) s.read(`doc-${i}`);
		const host = session(s, 1.3);
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: false, minTokens: 2000 } });
		host.truth.setLocks(conductor.locks, conductor.label, conductor.tailTokens);
		conductor.attach(host);
		await host.commitTurn();
		expect(host.groups()).toHaveLength(0);
		expect(host.truth.blocks.every((b) => b.subst === undefined || b.subst === null)).toBe(true);
		conductor.detach();

		const folded = new TaskfoldConductor({ keepRecentTasks: 0, untracked: { enabled: true, minTokens: 100 } });
		const host2 = session(s, 1.3);
		host2.truth.setLocks(folded.locks, folded.label, folded.tailTokens);
		folded.attach(host2);
		await host2.commitTurn();
		expect(host2.groups().length).toBeGreaterThan(0);
		expectRecallable(host2);
		folded.detach();
	});

	it("keeps every fold recallable after repeated receipts at the same ratio", async () => {
		const s = new Script();
		s.user("Do the work.");
		s.task("start", "1", { title: "Work" });
		s.read("work-a");
		s.task("complete", "1", { report: { outcome: "Done." } });
		s.read("tail");
		const host = session(s, 1.6);
		for (let i = 0; i < 3; i++) host.truth.setCalibration(0.8, host.truth.blocks.at(-1)!.order);
		const conductor = new TaskfoldConductor({ keepRecentTasks: 0 });
		host.truth.setLocks(conductor.locks, conductor.label, conductor.tailTokens);
		conductor.attach(host);
		await host.commitTurn();
		expectRecallable(host);
		expect(host.truth.blocks).toHaveLength(s.blocks.length);
		conductor.detach();
	});
});
