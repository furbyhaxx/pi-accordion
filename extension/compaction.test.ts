import { describe, expect, test } from "bun:test";
import { Truth } from "../core/truth";
import type { Block, ParsedSession } from "../core/types";
import { buildBakeSummary, aggressiveProjection, applyUndo, needsSaturationFallback, runCompaction, stripFoldTags, type CompactDeps } from "./compaction";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"], order: number, turn: number, tokens = 1000): Block {
	return { id, kind, turn, order, text: `${id} ` + "x".repeat(tokens * 4), tokens, override: null, autoFolded: false, by: null };
}

function truthOf(blocks: Block[], opts: { budget?: number; protect?: number } = {}): Truth {
	const t = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 } satisfies ParsedSession);
	if (opts.budget !== undefined) t.setBudget(opts.budget);
	if (opts.protect !== undefined) t.setProtect(opts.protect);
	return t;
}

function deps(truth: Truth | null, over: Partial<CompactDeps> = {}): CompactDeps {
	let armed = false;
	return {
		truth: () => truth,
		folding: () => armed,
		armFolding: () => { armed = true; },
		conductor: () => ({ id: "taskfold", label: "Taskfold" }),
		attachDefault: () => undefined,
		requestPass: async () => "settled",
		conductorSaved: () => null,
		now: () => 1_000,
		id: () => "c1",
		...over,
	};
}

describe("compaction strategies", () => {
	test("threshold remains saturated when a pass saves tokens but misses the reserve", () => {
		expect(needsSaturationFallback("threshold", 1000, 900, 1000, 200)).toBe(true);
		expect(needsSaturationFallback("threshold", 1000, 800, 1000, 200)).toBe(false);
		expect(needsSaturationFallback("overflow", 1000, 1000, 1000, 200)).toBe(true);
	});

	test("dry run projects without mutating context or starting a pass", async () => {
		const t = truthOf([blk("a:b0:p0", "text", 0, 1)], { protect: 0 });
		const rev = t.rev;
		let called = false;
		const outcome = await runCompaction({ trigger: "command", strategy: "pass", dryRun: true }, deps(t, {
			armFolding: () => { called = true; },
			requestPass: async () => { called = true; return "settled"; },
			conductorSaved: () => 42,
		}));
		expect(t.rev).toBe(rev);
		expect(called).toBe(false);
		expect(outcome.record.undo).toBeNull();
		expect(outcome.projection).toEqual({ pass: 42, aggressive: aggressiveProjection(t), bake: expect.any(Number), native: null });
	});

	test("aggressive folds every eligible block and records an undo that restores exactly those", async () => {
		const t = truthOf([blk("a:b0:p0", "text", 0, 1), blk("a:b1:p0", "tool_result", 1, 2), blk("a:b2:p0", "text", 2, 3)], { budget: 1000, protect: 0 });
		const before = t.stats().liveTokens;
		const { record } = await runCompaction({ trigger: "command", strategy: "aggressive" }, deps(t));
		expect(record.undo).not.toBeNull();
		expect(t.stats().liveTokens).toBeLessThan(before);
		const undo = applyUndo(t, record.undo!);
		expect(undo.restored).toBe(3);
		expect(undo.skipped).toBe(0);
		expect(t.stats().liveTokens).toBe(before);
	});

	test("pass keeps its own strategy when the conductor freed tokens, with an undo for what it folded", async () => {
		const t = truthOf([blk("a:b0:p0", "text", 0, 1), blk("a:b1:p0", "text", 1, 2)], { budget: 1000, protect: 0 });
		const before = t.stats().liveTokens;
		const { record } = await runCompaction(
			{ trigger: "manual", strategy: "pass" },
			deps(t, { requestPass: async () => { t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); return "settled"; } }),
		);
		expect(record.strategy).toBe("pass");
		expect(record.after).toBeLessThan(before);
		expect(record.undo).toEqual([{ kind: "unfold", ids: ["a:b0:p0"] }]);
	});
	test("undo removes groups created by a conductor pass", async () => {
		const t = truthOf([blk("a:b0:p0", "user", 0, 1), blk("a:b1:p0", "text", 1, 1), blk("a:b2:p0", "user", 2, 2)], { protect: 0 });
		const blocks = structuredClone(t.blocks);
		const groups = structuredClone(t.groups);
		const { record } = await runCompaction({ trigger: "manual", strategy: "pass" }, deps(t, {
			requestPass: async () => {
				t.apply([{ kind: "group", ids: ["a:b0:p0", "a:b1:p0"], summary: "summary" }], "auto");
				return "settled";
			},
		}));
		expect(record.folded.groups).toBe(1);
		expect(record.undo).not.toBeNull();
		expect(applyUndo(t, record.undo!)).toEqual({ restored: 1, skipped: 0 });
		expect(t.blocks).toEqual(blocks);
		expect(t.groups).toEqual(groups);
	});


	test("pass escalates to aggressive and says so when the conductor frees nothing", async () => {
		const t = truthOf([blk("a:b0:p0", "text", 0, 1)], { budget: 1000, protect: 0 });
		const { record } = await runCompaction({ trigger: "panel", strategy: "pass" }, deps(t));
		expect(record.strategy).toBe("aggressive");
		expect(record.message).toBe("conductor freed nothing; folded all eligible blocks");
		expect(record.folded.blocks).toBe(1);
	});

	test("bake folds, strips fold tags and caps the summary by dropping oldest turns first", async () => {
		const blocks = Array.from({ length: 40 }, (_, i) => blk(`a:b${i}:p0`, i % 4 === 0 ? "user" : "text", i, i + 1, 500));
		const summary = buildBakeSummary(blocks, { capTokens: 200, countTokens: (text) => Math.ceil(text.length / 4) });
		expect(summary.startsWith("[accordion-bake v1]")).toBe(true);
		expect(summary).toContain("earlier turns omitted");
		expect(summary).not.toContain("FOLDED}");
		const t = truthOf(blocks.slice(0, 4), { budget: 5000, protect: 0 });
		const { record, bake } = await runCompaction({ trigger: "manual", strategy: "bake", instructions: "keep {#abc123 FOLDED} notes" }, deps(t));
		expect(record.strategy).toBe("bake");
		expect(record.undo).toBeNull();
		expect(bake!.summary).not.toContain("{#abc123 FOLDED}");
	});

	test("native records but changes nothing", async () => {
		const t = truthOf([blk("a:b0:p0", "text", 0, 1)], { budget: 1000, protect: 0 });
		const before = t.stats().liveTokens;
		const { record } = await runCompaction({ trigger: "manual", strategy: "native" }, deps(t));
		expect(record.strategy).toBe("native");
		expect(t.stats().liveTokens).toBe(before);
	});

	test("a projection equals what aggressive actually frees", async () => {
		const t = truthOf([blk("a:b0:p0", "text", 0, 1), blk("a:b1:p0", "text", 1, 2)], { budget: 1000, protect: 0 });
		const before = t.stats().liveTokens;
		const projected = aggressiveProjection(t);
		await runCompaction({ trigger: "command", strategy: "aggressive" }, deps(t));
		expect(before - t.stats().liveTokens).toBe(projected);
	});

	test("stripFoldTags removes only well-formed tags", () => {
		expect(stripFoldTags("{#ab12cd FOLDED} kept {#zz FOLDED}")).toBe("kept {#zz FOLDED}");
	});
});
