import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { resolveRecall } from "./agentView";
import { RECALL_BUDGET_CHARS, recallView } from "./recallView";
import type { Block } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };
const PARENT = "t:work/1";
const CHILD = "t:work/1.1";

function blk(id: string, kind: Block["kind"], order: number, text: string): Block {
	return { id, kind, turn: 1, order, text, tokens: Math.ceil(text.length / 4), override: null, autoFolded: false, by: null };
}

/** A finished task of `n` large text blocks folded into one group; the first `child` blocks are a subtask. */
function foldedTask(n: number, size: number, child = 0): Truth {
	const blocks = [blk("u:0", "user", 0, "Do the work.")];
	for (let i = 1; i <= n; i++) blocks.push(blk(`a:r${i}:p0`, "text", i, `entry ${i} ${i === 7 ? "NEEDLE-VALUE-42 " : ""}${"x".repeat(size)}`));
	blocks.push(blk("u:9999", "user", n + 1, "Next."));
	const t = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 });
	t.setProtect(0);
	const ids = blocks.slice(1, n + 1).map((b) => b.id);
	const handles = [{ id: PARENT, memberIds: ids }, ...(child ? [{ id: CHILD, memberIds: ids.slice(0, child) }] : [])];
	const summary = `${foldTag(PARENT)} task done${child ? `\n  ${foldTag(CHILD)} subtask` : ""}`;
	const r = t.apply([{ kind: "group", ids, summary, handles }], "auto");
	expect(r.results[0].applied).toBe(true);
	return t;
}

describe("recallView", () => {
	it("returns a small fold whole, like the original recall", () => {
		const t = foldedTask(3, 100);
		const v = recallView(t, { codes: [foldCode(PARENT)] });
		expect(v.items[0].mode).toBe("full");
		expect(v.text).toContain(resolveRecall(t, [foldCode(PARENT)]).restored[0].text);
		expect(v.truncated).toBe(false);
	});

	it("returns an index, never the whole fold, when the fold exceeds the budget", () => {
		const t = foldedTask(400, 2_000, 50);
		const code = foldCode(PARENT);
		expect(resolveRecall(t, [code]).restored[0].text.length).toBeGreaterThan(RECALL_BUDGET_CHARS * 10);
		const v = recallView(t, { codes: [code] });
		expect(v.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(v.items[0].mode).toBe("index");
		expect(v.truncated).toBe(true);
		expect(v.text).toContain(`#${foldCode(CHILD)}`);
		// Entries inside the subtask are reached through its code, not listed again.
		expect(v.text).not.toContain("  .1  ");
		expect(v.text).toContain("  .51  ");
		const last = recallView(t, { codes: [code], page: 99 });
		expect(last.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(last.text).toContain("  .400  ");
	});

	it("reads one entry by address and pages an entry larger than the budget", () => {
		const t = foldedTask(20, 80_000);
		const code = foldCode(PARENT);
		const first = recallView(t, { codes: [`${code}.3`] });
		expect(first.items[0]).toMatchObject({ mode: "entry", ids: ["a:r3:p0"] });
		expect(first.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(first.text).toContain("entry 3 ");
		const pages: string[] = [];
		for (let p = 1; p <= 10; p++) {
			const body = recallView(t, { codes: [`${code}.3`], page: p }).text;
			const text = body.slice(body.indexOf("]\n") + 2).replace(/\n\[continues:.*\]$/, "");
			pages.push(text);
			if (!body.includes("[continues:")) break;
		}
		expect(pages.join("")).toBe(t.get("a:r3:p0")!.text);
	});

	it("searches a large fold and returns addressed excerpts within budget", () => {
		const t = foldedTask(400, 2_000);
		const code = foldCode(PARENT);
		const v = recallView(t, { codes: [code], query: "needle-value" });
		expect(v.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS);
		expect(v.text).toContain(`#${code}.7 `);
		expect(v.text).toContain("NEEDLE-VALUE-42");
		expect(v.items[0].ids).toEqual(["a:r7:p0"]);
		expect(recallView(t, { codes: [code], query: "absent-term" }).text).toContain("No match");
	});

	it("keeps several codes within one budget and names what it could not show", () => {
		const t = foldedTask(20, 30_000);
		const code = foldCode(PARENT);
		const v = recallView(t, { codes: [`${code}.1`, `${code}.2`, `${code}.3`] });
		expect(v.text.length).toBeLessThanOrEqual(RECALL_BUDGET_CHARS + 200);
		expect(v.text).toContain("Not shown:");
		expect(v.truncated).toBe(true);
	});

	it("reports unknown codes and entries out of range as missing", () => {
		const t = foldedTask(3, 100);
		const v = recallView(t, { codes: ["zzzzzz", `${foldCode(PARENT)}.9`, "not a code"] });
		expect(v.missing).toEqual(["zzzzzz", `${foldCode(PARENT)}.9`, "not a code"]);
		expect(v.items).toEqual([]);
	});
});
