import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { askAnswer, askFallback, askMaterial, askPrompt, checkCitations, questionQuery } from "./recallAsk";
import type { TaskReport } from "./recallView";
import type { Block } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };
const TASK = "t:work/1";

function blk(id: string, kind: Block["kind"], order: number, text: string): Block {
	return { id, kind, turn: 1, order, text, tokens: Math.ceil(text.length / 4), override: null, autoFolded: false, by: null };
}

/** A folded task of 60 entries of ~20k chars (~300k tokens); entry 7 holds the fact asked about. */
function foldedTask(): Truth {
	const blocks = [blk("u:0", "user", 0, "Do the work.")];
	for (let i = 1; i <= 60; i++) blocks.push(blk(`a:r${i}:p0`, "text", i, `entry ${i} ${i === 7 ? "the scheduler deadlock was caused by lock order in flush_queue; fixed by taking mu before qmu " : ""}${"x".repeat(20_000)}`));
	blocks.push(blk("u:9999", "user", 61, "Next."));
	const t = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 });
	t.setProtect(0);
	const ids = blocks.slice(1, 61).map((b) => b.id);
	expect(t.apply([{ kind: "group", ids, summary: `${foldTag(TASK)} task done`, handles: [{ id: TASK, memberIds: ids }] }], "auto").results[0].applied).toBe(true);
	return t;
}

const REPORT: TaskReport = { title: "Fix scheduler", status: "done", outcome: "Deadlock fixed.", decisions: ["take mu before qmu"] };
const reportOf = (key: string) => (key === "work/1" ? REPORT : null);
const CODE = foldCode(TASK);

describe("recall ask", () => {
	it("builds bounded material from reports and hits, never the transcript", () => {
		const truth = foldedTask();
		const m = askMaterial(truth, { question: "What caused the scheduler deadlock in flush_queue?", codes: [], reportOf, inputTokens: 6_000 });
		expect(m.text.length).toBeLessThanOrEqual(6_000 * 4);
		expect(m.text).toContain("Deadlock fixed.");
		expect(m.text).toContain("lock order in flush_queue");
		expect(m.addresses.has(CODE)).toBe(true);
		expect(m.addresses.has(`${CODE}.7`)).toBe(true);
		expect(askPrompt("Q?", m.text).length).toBeLessThan(6_000 * 4 + 200);
	});

	it("uses the caller's query instead of the question's words when one is given", () => {
		const truth = foldedTask();
		const m = askMaterial(truth, { question: "why did it hang", codes: [CODE], query: "flush_queue", reportOf, inputTokens: 6_000 });
		expect(m.hits).toContain(`#${CODE}.7`);
	});

	it("derives one alternation of distinctive words from a question", () => {
		expect(questionQuery("What caused the scheduler deadlock in flush_queue?")).toBe("/flush_queue|scheduler|deadlock|caused/");
		expect(questionQuery("is it the a?")).toBeUndefined();
		expect(questionQuery("path a/b.c (x)")).toBe("/a\\/b\\.c|path/");
	});

	it("keeps citations the material showed and removes invented ones", () => {
		const addresses = new Set([CODE, `${CODE}.7`]);
		const r = checkCitations(`Lock order was wrong [${CODE}.7]. It took 3 hours [zzzzzz.4]. See list [1] and [#${CODE}, aaaaaa.2].`, addresses);
		expect(r.text).toBe(`Lock order was wrong [${CODE}.7]. It took 3 hours. See list [1] and [${CODE}].`);
		expect(r.cited.sort()).toEqual([CODE, `${CODE}.7`].sort());
		expect(r.removed).toBe(2);
	});

	it("marks an answer without any valid citation and names a follow-up read otherwise", () => {
		const addresses = new Set([`${CODE}.7`]);
		expect(askAnswer("Q", "It was lock order.", addresses).text).toContain("cites no source");
		const ok = askAnswer("Q", `It was lock order [${CODE}.7].`, addresses);
		expect(ok.text).toContain(`recall({codes:["${CODE}.7"]})`);
		expect(ok.cited).toEqual([`${CODE}.7`]);
	});

	it("falls back to the hits within the grant, and says so when nothing matches", () => {
		const truth = foldedTask();
		const m = askMaterial(truth, { question: "scheduler deadlock flush_queue", codes: [], reportOf, inputTokens: 6_000 });
		const text = askFallback("no model available", m, 500);
		expect(text.startsWith("[no answer: no model available.")).toBe(true);
		expect(text.length).toBeLessThanOrEqual(500 * 4);
		const none = askMaterial(truth, { question: "kubernetes ingress", codes: [`${CODE}.3`], reportOf, inputTokens: 6_000 });
		expect(askFallback("x", none, 500)).toContain("Nothing folded matches");
	});
});
