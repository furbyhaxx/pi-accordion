/*
 * taskReports.test.ts — `recall` of task codes through a real Taskfold fold (TestHost + Truth).
 */
import { describe, it, expect } from "vitest";
import { TaskfoldConductor } from "./taskfold";
import { taskReports } from "./taskReports";
import { TestHost } from "../../../core/conductor/testhost";
import { foldCode } from "../../../core/digest";
import { recallView, RECALL_BUDGET_CHARS } from "../../../core/recallView";
import { RecallAccount, serveRecall } from "../../../core/recallAccount";
import type { Block } from "../../../core/types";

const SECRET = "TRANSCRIPT-ONLY-PAYLOAD";

/** `tasks` finished root tasks, each with two subtasks and `callsPerSub` large tool results. */
function session(tasks: number, callsPerSub: number): Block[] {
	const blocks: Block[] = [];
	let order = 0;
	let resp = 0;
	const push = (b: Pick<Block, "id" | "kind" | "text"> & Partial<Block>) => {
		blocks.push({ turn: 1, tokens: Math.ceil(b.text.length / 4), override: null, autoFolded: false, by: null, ...b, order: order++ });
	};
	const call = (tool: string, args: Record<string, unknown>, out: string) => {
		const r = ++resp;
		push({ id: `a:resp${r}:p1`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: `c${r}` });
		push({ id: `r:c${r}`, kind: "tool_result", text: out, toolName: tool, callId: `c${r}` });
	};
	const start = (id: string, title: string) => call("tasks", { action: "start", list: "work", id }, `Started work/${id} "${title}".`);
	const finish = (id: string, report: Record<string, unknown>) => call("tasks", { action: "complete", list: "work", id, report }, `work/${id} is done.`);
	push({ id: "u:1000", kind: "user", text: "Build it." });
	for (let t = 1; t <= tasks; t++) {
		start(`${t}`, `Phase ${t}`);
		for (const sub of [1, 2]) {
			start(`${t}.${sub}`, `Phase ${t} part ${sub}`);
			for (let i = 0; i < callsPerSub; i++) call("bash", { command: `cat phase-${t}-${sub}-${i}.log` }, `${SECRET} `.repeat(1400));
			call("edit", { path: `src/phase${t}/part${sub}.ts`, oldText: "a", newText: "b" }, "Successfully replaced text.");
			call("bash", { command: "npm test" }, "12 passed");
			finish(`${t}.${sub}`, { outcome: `Part ${sub} of phase ${t} works.`, decisions: [`P${t}.${sub} chose streaming — bounded memory`] });
		}
		finish(`${t}`, { outcome: `Phase ${t} delivered with marker OUTCOME-${t}.`, decisions: [`Phase ${t} keeps the v1 wire format — consumers unchanged`], open: [`Phase ${t} load test pending`] });
	}
	push({ id: "u:9000", kind: "user", text: "Now the release." });
	for (let i = 0; i < 4; i++) call("bash", { command: `ls ${i}` }, "tail ".repeat(300));
	return blocks;
}

async function folded(tasks: number, callsPerSub: number): Promise<TestHost> {
	const host = new TestHost();
	host.appendBlocks(session(tasks, callsPerSub));
	host.setProtect(200);
	host.setBudget(Math.ceil(host.stats().liveTokens * 0.5));
	const c = new TaskfoldConductor({ keepRecentTasks: 0 });
	host.truth.setLocks(c.locks, c.label, c.tailTokens);
	c.attach(host);
	await host.commitTurn();
	return host;
}

describe("recall of task codes", () => {
	it("returns eleven reports for eleven large task codes in one call, without transcript", async () => {
		const host = await folded(11, 6);
		const codes = Array.from({ length: 11 }, (_, i) => foldCode(`t:work/${i + 1}`));
		const v = recallView(host.truth, { codes, reportOf: taskReports(host.truth) });
		expect(v.missing).toEqual([]);
		expect(v.skipped).toEqual([]);
		expect(v.items.map((i) => i.mode)).toEqual(Array(11).fill("report"));
		expect(v.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(v.text).not.toContain(SECRET);
		for (let t = 1; t <= 11; t++) expect(v.text).toContain(`OUTCOME-${t}.`);
		// The same call through the account is what the tool returns.
		const served = serveRecall(host.truth, new RecallAccount(), "c0", { codes, reportOf: taskReports(host.truth) });
		expect(served.view?.items.length).toBe(11);
	});

	it("shows a single task's full report with its subtasks as recallable codes", async () => {
		const host = await folded(2, 6);
		const v = recallView(host.truth, { codes: [foldCode("t:work/1")], reportOf: taskReports(host.truth) });
		expect(v.items[0].mode).toBe("report");
		expect(v.text).toContain("Phase 1 keeps the v1 wire format");
		expect(v.text).toContain("Phase 1 load test pending");
		expect(v.text).toContain("src/phase1/part1.ts");
		expect(v.text).toContain("`npm test` → ok");
		const child = foldCode("t:work/1.2");
		expect(v.text).toContain(`#${child}  1.2 · done · Phase 1 part 2 — Part 2 of phase 1 works.`);
		const sub = recallView(host.truth, { codes: [child], reportOf: taskReports(host.truth) });
		expect(sub.items[0].mode).toBe("report");
		expect(sub.text).toContain("P1.2 chose streaming");
		expect(sub.text).not.toContain(SECRET);
	});

	it("still reaches the transcript by entry list, entry address and search", async () => {
		const host = await folded(2, 6);
		const code = foldCode("t:work/1");
		const reportOf = taskReports(host.truth);
		const index = recallView(host.truth, { codes: [`${code}.entries`], reportOf });
		expect(index.items[0].mode).toBe("index");
		const hit = recallView(host.truth, { codes: [code], query: "phase-1-2-3.log", reportOf });
		expect(hit.items[0].mode).toBe("query");
		const address = /#([0-9a-z]{6}\.\d+) /.exec(hit.text)![1];
		const entry = recallView(host.truth, { codes: [address], reportOf });
		expect(entry.items[0].mode).toBe("entry");
		expect(entry.text).toContain("phase-1-2-3.log");
	});

	it("searches all folded content without codes and returns addresses that open the entry", async () => {
		const host = await folded(4, 6);
		const reportOf = taskReports(host.truth);
		const v = recallView(host.truth, { codes: [], query: "phase-3-2-4.log", reportOf });
		expect(v.items[0].mode).toBe("query");
		expect(v.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(v.text).toContain("work/3.2 · ");
		const address = /#([0-9a-z]{6}\.\d+) /.exec(v.text)![1];
		expect(address.startsWith(foldCode("t:work/3.2"))).toBe(true);
		const entry = recallView(host.truth, { codes: [address], reportOf });
		expect(entry.text).toContain("phase-3-2-4.log");
	});

	it("requires every term in one entry, accepts a phrase and a regex, and marks a partial result", async () => {
		const host = await folded(4, 6);
		const ask = (query: string) => recallView(host.truth, { codes: [], query });
		// Both words occur in many entries, together only in the edit call of phase 2 part 1.
		const both = ask("phase2/part1.ts oldText");
		expect(both.items[0].ids.length).toBe(1);
		expect(ask('"part 2 of phase 4 works"').items[0].ids.length).toBe(1);
		const re = ask("/phase-[34]-1-0\\.log/");
		expect(re.items[0].ids.length).toBe(2);
		// Newest first.
		expect(re.text.indexOf("phase-4-1-0.log")).toBeLessThan(re.text.indexOf("phase-3-1-0.log"));
		const partial = ask("phase-1-1-0.log no-such-term-anywhere");
		expect(partial.text).toContain("PARTIAL");
		expect(partial.text).toContain("phase-1-1-0.log");
		expect(ask("no-such-term-anywhere").text).toContain("No match");
		expect(ask("/(a+)+$/").text).toContain("nested repetition");
		expect(ask("/[/").text).toContain("Invalid pattern");
	});

	it("pages a search with many hits within the call limit", async () => {
		const host = await folded(6, 8);
		const first = recallView(host.truth, { codes: [], query: "TRANSCRIPT-ONLY-PAYLOAD" });
		expect(first.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(first.truncated).toBe(true);
		expect(first.text).toContain('next: recall({query:"TRANSCRIPT-ONLY-PAYLOAD", page:2})');
		const second = recallView(host.truth, { codes: [], query: "TRANSCRIPT-ONLY-PAYLOAD", page: 2 });
		expect(second.items[0].ids.some((id) => first.items[0].ids.includes(id))).toBe(false);
	});
});
