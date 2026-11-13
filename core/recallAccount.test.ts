import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { estTokens } from "./tokens";
import { RECALL_POLICY, RecallAccount, serveRecall } from "./recallAccount";
import type { Block } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"], order: number, text: string, extra: Partial<Block> = {}): Block {
	return { id, kind, turn: 1, order, text, tokens: estTokens(text), override: null, autoFolded: false, by: null, ...extra };
}

/** `folds` folded groups of 40 entries of 4k tokens each: every one far larger than a call. */
function archive(folds: number, budget = 200_000): { truth: Truth; codes: string[] } {
	const blocks = [blk("u:0", "user", 0, "Do the work.")];
	const groups: string[][] = [];
	let order = 1;
	for (let f = 0; f < folds; f++) {
		const ids: string[] = [];
		for (let i = 0; i < 40; i++) {
			const b = blk(`a:f${f}r${i}:p0`, "text", order++, `fold ${f} entry ${i} ${"x".repeat(16_000)}`);
			blocks.push(b);
			ids.push(b.id);
		}
		groups.push(ids);
	}
	blocks.push(blk("u:9999", "user", order, "Next."));
	const truth = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 });
	truth.setProtect(0);
	truth.setBudget(budget);
	const r = truth.apply(groups.map((ids) => ({ kind: "group" as const, ids, summary: `${foldTag(`g:${ids[0]}`)} done` })), "auto");
	expect(r.results.every((x) => x.applied)).toBe(true);
	return { truth, codes: groups.map((ids) => foldCode(`g:${ids[0]}`)) };
}

function land(truth: Truth, callId: string, text: string): void {
	const order = truth.blocks[truth.blocks.length - 1].order + 1;
	truth.append([blk(`r:${callId}`, "tool_result", order, text, { toolName: "recall", callId })]);
}

describe("RecallAccount", () => {
	it("bounds parallel calls with many codes by the session allowance, not per call", () => {
		const { truth, codes } = archive(11);
		const account = new RecallAccount();
		const entries = codes.map((c) => `${c}.1`);
		const served = Array.from({ length: 12 }, (_, i) => serveRecall(truth, account, `call${i}`, { codes: entries }));
		const total = served.reduce((n, s) => n + (s.view ? estTokens(s.text) : 0), 0);
		expect(total).toBeLessThanOrEqual(RECALL_POLICY.liveTokens);
		for (const s of served) if (s.view) expect(estTokens(s.text)).toBeLessThanOrEqual(RECALL_POLICY.callTokens);
		expect(served.filter((s) => s.view).length).toBeGreaterThanOrEqual(3);
		const refused = served.filter((s) => !s.view);
		expect(refused.length).toBeGreaterThan(0);
		for (const s of refused) {
			expect(s.text.length).toBeLessThan(500);
			expect(s.text).toMatch(/^Recall refused/);
			expect(s.text).not.toContain("xxxx");
		}
	});

	it("counts results once they are in the log and refuses across turns", () => {
		const { truth, codes } = archive(3);
		const account = new RecallAccount();
		let refusedAt = -1;
		for (let i = 0; i < 12 && refusedAt < 0; i++) {
			const s = serveRecall(truth, account, `c${i}`, { codes: [`${codes[i % 3]}.${i + 1}`] });
			if (!s.view) refusedAt = i;
			else land(truth, `c${i}`, s.text);
			expect(account.outstanding(truth)).toBeLessThanOrEqual(RECALL_POLICY.liveTokens);
		}
		expect(refusedAt).toBeGreaterThan(2);
		expect(account.outstanding(truth)).toBeGreaterThan(RECALL_POLICY.liveTokens - RECALL_POLICY.callTokens);
	});

	it("keeps the projection below the budget whatever the allowance says", () => {
		const { truth, codes } = archive(2, 6_000);
		const account = new RecallAccount();
		const before = truth.stats().liveTokens;
		const s = serveRecall(truth, account, "c0", { codes: [`${codes[0]}.1`] });
		const added = s.view ? estTokens(s.text) : 0;
		expect(added).toBeGreaterThan(0);
		expect(before + added).toBeLessThanOrEqual(6_000);
	});

	it("serves again after room was made", () => {
		const { truth, codes } = archive(3);
		const account = new RecallAccount();
		const landed: string[] = [];
		for (let i = 0; i < 12; i++) {
			const s = serveRecall(truth, account, `c${i}`, { codes: [`${codes[i % 3]}.${i + 1}`] });
			if (!s.view) break;
			land(truth, `c${i}`, s.text);
			landed.push(`r:c${i}`);
		}
		expect(serveRecall(truth, account, "probe", { codes: [`${codes[0]}.30`] }).view).toBeNull();
		const release = () => { truth.apply(landed.map((id) => ({ kind: "replace" as const, id, content: "[released]", recoverable: false })), "auto"); };
		const s = serveRecall(truth, account, "after", { codes: [`${codes[0]}.30`] }, release);
		expect(s.view).not.toBeNull();
	});
});
