/*
 * resultGuard.test.ts — the oversized-result guard against a real Truth and a real Taskfold.
 */
import { describe, it, expect } from "vitest";
import { TaskfoldConductor } from "./taskfold";
import { TestHost } from "../../../core/conductor/testhost";
import { foldCode } from "../../../core/digest";
import { guardResults } from "../../../core/resultGuard";
import { recallView, RECALL_BUDGET_CHARS } from "../../../core/recallView";
import type { Block } from "../../../core/types";

const LIMIT = 16_000;
const GIANT = Array.from({ length: 60_000 }, (_, i) => `row ${i} ${i === 31_337 ? "NEEDLE-31337" : "data"}`).join("\n");

function session(giantTool: string, giantArgs: Record<string, unknown>): { blocks: Block[]; giant: string } {
	const blocks: Block[] = [];
	let resp = 0;
	const push = (b: Pick<Block, "id" | "kind" | "text"> & Partial<Block>) => { blocks.push({ turn: 1, tokens: Math.ceil(b.text.length / 4), override: null, autoFolded: false, by: null, ...b, order: blocks.length }); };
	const call = (tool: string, args: Record<string, unknown>, out: string): string => {
		const r = ++resp;
		push({ id: `a:resp${r}:p0`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: `c${r}` });
		push({ id: `r:c${r}`, kind: "tool_result", text: out, toolName: tool, callId: `c${r}` });
		return `r:c${r}`;
	};
	push({ id: "u:1000", kind: "user", text: "Go." });
	call("tasks", { action: "start", list: "work", id: "1" }, 'Started work/1 "Long task".');
	for (let i = 0; i < 3; i++) call("bash", { command: `ls ${i}` }, "ok ".repeat(200));
	const giant = call(giantTool, giantArgs, GIANT);
	return { blocks, giant };
}

async function run(host: TestHost): Promise<void> {
	const c = new TaskfoldConductor({ keepRecentTasks: 0 });
	host.truth.setLocks(c.locks, c.label, c.tailTokens);
	c.attach(host);
	// The first epoch folds what it can; the second reports what is left.
	await host.commitTurn();
	await host.commitTurn();
}

const saturated = (host: TestHost) => host.statusLog.some((e) => e.text?.includes("Taskfold saturated"));

describe("oversized tool-result guard", () => {
	it("is what keeps one giant result at the tail of an open task from saturating Taskfold", async () => {
		const without = new TestHost();
		without.appendBlocks(session("bash", { command: "cat huge.log" }).blocks);
		without.setProtect(20_000);
		without.setBudget(100_000);
		await run(without);
		expect(saturated(without)).toBe(true);
		expect(without.stats().liveTokens).toBeGreaterThan(without.stats().budget);

		const { blocks, giant } = session("bash", { command: "cat huge.log" });
		const host = new TestHost();
		host.appendBlocks(blocks);
		host.setProtect(20_000);
		host.setBudget(100_000);
		const ops = guardResults(host.truth, LIMIT);
		expect(ops.map((o) => (o as { id: string }).id)).toEqual([giant]);
		expect(host.truth.apply(ops, "auto").results[0].applied).toBe(true);
		await run(host);
		expect(saturated(host)).toBe(false);
		expect(host.stats().liveTokens).toBeLessThan(10_000);
	});

	it("keeps both ends, names the recall calls, and the rest is reachable by search and pages", () => {
		const { blocks, giant } = session("bash", { command: "cat huge.log" });
		const host = new TestHost();
		host.appendBlocks(blocks);
		host.truth.apply(guardResults(host.truth, LIMIT), "auto");
		const code = foldCode(giant);
		const shown = host.truth.digestOf(host.truth.get(giant)!);
		expect(shown).toContain("row 0 data");
		expect(shown).toContain("row 59999 data");
		expect(shown).not.toContain("NEEDLE-31337");
		expect(shown).toContain(`recall({codes:["${code}"], query:"text"})`);
		expect(shown.length).toBeLessThan(3_200 * 4);
		const hit = recallView(host.truth, { codes: [], query: "NEEDLE-31337" });
		expect(hit.text).toContain(`#${code}.1 `);
		const page = recallView(host.truth, { codes: [`${code}.1`], page: 2 });
		expect(page.items[0].mode).toBe("entry");
		expect(page.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
	});

	it("leaves alone what the model already saw, what a human holds and what is under the limit", async () => {
		const { blocks, giant } = session("bash", { command: "cat huge.log" });
		const sent = new TestHost();
		sent.appendBlocks(blocks);
		await sent.departWire();
		expect(guardResults(sent.truth, LIMIT)).toEqual([]);
		// A loaded session is all "sent"; its one repair pass clips anyway and Taskfold recovers.
		const repair = guardResults(sent.truth, LIMIT, true);
		expect(repair.map((o) => (o as { id: string }).id)).toEqual([giant]);
		sent.setBudget(100_000);
		const c = new TaskfoldConductor({ keepRecentTasks: 0 });
		sent.truth.setLocks(c.locks, c.label, c.tailTokens);
		expect(sent.truth.apply(repair, "auto").results[0].applied).toBe(true);
		expect(sent.stats().liveTokens).toBeLessThan(10_000);

		const held = new TestHost();
		held.appendBlocks(session("bash", { command: "cat huge.log" }).blocks);
		held.truth.apply([{ kind: "pin", ids: [giant] }], "you");
		expect(guardResults(held.truth, LIMIT)).toEqual([]);

		const small = new TestHost();
		small.appendBlocks(session("bash", { command: "cat huge.log" }).blocks);
		expect(guardResults(small.truth, 1_000_000)).toEqual([]);
		expect(guardResults(small.truth, 0)).toEqual([]);
	});

	it("turns an oversized recall result into its stub, with no fold code to recall it by", () => {
		const { blocks, giant } = session("recall", { codes: ["q03k9a", "8mcsjm"] });
		const host = new TestHost();
		host.appendBlocks(blocks);
		host.truth.apply(guardResults(host.truth, LIMIT), "auto");
		expect(host.truth.digestOf(host.truth.get(giant)!)).toBe("[recall of #q03k9a #8mcsjm released to free context; run it again if you still need it]");
	});
});
