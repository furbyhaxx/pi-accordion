import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { estTokens } from "./tokens";
import { resolveUnfoldBounded } from "./agentView";
import type { Block } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"], order: number, text: string): Block {
	return { id, kind, turn: 1, order, text, tokens: estTokens(text), override: null, autoFolded: false, by: null };
}

/** A large folded group (~40k tokens) and a small one (~1k), then live work. */
function session(): { truth: Truth; big: string; small: string } {
	const blocks = [blk("u:0", "user", 0, "Go.")];
	for (let i = 0; i < 10; i++) blocks.push(blk(`a:big${i}:p0`, "text", blocks.length, `big ${i} ${"x".repeat(16_000)}`));
	for (let i = 0; i < 2; i++) blocks.push(blk(`a:small${i}:p0`, "text", blocks.length, `small ${i} ${"y".repeat(2_000)}`));
	blocks.push(blk("u:9", "user", blocks.length, "Next."));
	const truth = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 });
	truth.setProtect(0);
	truth.setBudget(200_000);
	const group = (prefix: string) => {
		const ids = blocks.filter((b) => b.id.startsWith(`a:${prefix}`)).map((b) => b.id);
		expect(truth.apply([{ kind: "group", ids, summary: `${foldTag(`g:${ids[0]}`)} ${prefix} work` }], "auto").results[0].applied).toBe(true);
		return foldCode(`g:${ids[0]}`);
	};
	return { truth, big: group("big"), small: group("small") };
}

const LIMITS = { maxTokens: 20_000, ceiling: 160_000 };

describe("resolveUnfoldBounded", () => {
	it("refuses a fold larger than one unfold may add and changes nothing", () => {
		const { truth, big } = session();
		const before = truth.stats();
		const r = resolveUnfoldBounded(truth, [big], LIMITS);
		expect(r.restored).toEqual([]);
		expect(r.missing).toEqual([]);
		expect(r.refused).toHaveLength(1);
		expect(r.refused[0]).toMatchObject({ code: big, reason: "size" });
		expect(r.refused[0].tokens).toBeGreaterThan(39_000);
		expect(truth.stats().rev).toBe(before.rev);
		expect(truth.stats().liveTokens).toBe(before.liveTokens);
	});

	it("unfolds a small fold, and decides each code of one call on its own", () => {
		const { truth, big, small } = session();
		const r = resolveUnfoldBounded(truth, [big, small, "zzzzzz"], LIMITS);
		expect(r.restored.map((x) => x.code)).toEqual([small]);
		expect(r.refused.map((x) => x.code)).toEqual([big]);
		expect(r.missing).toEqual(["zzzzzz"]);
		expect(truth.groups.find((g) => foldCode(g.id) === small)?.folded).toBe(false);
		expect(truth.groups.find((g) => foldCode(g.id) === big)?.folded).toBe(true);
	});

	it("refuses a fold that fits the per-unfold limit but not the room left below the ceiling", () => {
		const { truth, small } = session();
		const live = truth.stats().liveTokens;
		const r = resolveUnfoldBounded(truth, [small], { maxTokens: 20_000, ceiling: live + 500 });
		expect(r.refused).toMatchObject([{ code: small, reason: "budget" }]);
		expect(truth.stats().liveTokens).toBe(live);
	});
});
