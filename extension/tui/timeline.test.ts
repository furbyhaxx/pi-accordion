import { describe, expect, test } from "bun:test";
import { Truth } from "../../core/truth";
import type { Block, ParsedSession } from "../../core/types";
import { buildTimeline, cellGlyph, clampCell, timelineColumns, weightGlyph } from "./timeline";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"], order: number, turn: number, tokens: number, extra: Partial<Block> = {}): Block {
	return { id, kind, turn, order, text: `${id}\nsecond line`, tokens, override: null, autoFolded: false, by: null, ...extra };
}

function truthOf(blocks: Block[]): Truth {
	return new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 } satisfies ParsedSession);
}

describe("context timeline", () => {
	test("one row per turn, one cell per block, with the protected boundary marked once", () => {
		const t = truthOf([
			blk("sys:0", "system", -1, 0, 55_000),
			blk("a:b0:p0", "user", 0, 1, 100),
			blk("a:b1:p0", "text", 1, 1, 2_000),
			blk("a:b2:p0", "tool_result", 2, 2, 30_000),
		]);
		t.setProtect(35_000);
		const rows = buildTimeline(t);
		expect(rows.map((r) => r.turn)).toEqual([0, 1, 2]);
		expect(rows[0].system).toBe(true);
		expect(rows[1].cells.map((c) => c.glyph)).toEqual(["U", "A"]);
		expect(rows[1].label).toBe("a:b0:p0");
		expect(rows.reduce((n, r) => n + r.cells.filter((c) => c.boundary).length, 0)).toBe(1);
	});

	test("weight glyphs follow the 500 and 5000 thresholds", () => {
		expect([499, 500, 4_999, 5_000].map(weightGlyph)).toEqual(["▪", "■", "■", "█"]);
	});

	test("a turn held in one folded group reads as its task, and the last protected turn reads as the tail", () => {
		const t = truthOf([
			blk("a:b0:p0", "user", 0, 1, 100),
			blk("a:b1:p0", "text", 1, 1, 200),
			blk("a:b2:p0", "tool_result", 2, 2, 300),
		]);
		t.setProtect(0);
		t.apply([{ kind: "group", ids: ["a:b0:p0", "a:b1:p0"], summary: '{#abc123 FOLDED} {"task":"demo/1","title":"Survey"}', folded: true }], "auto");
		const rows = buildTimeline(t);
		expect(rows[0].label).toBe('▣ task demo/1 "Survey"');
		expect(rows[0].cells.every((c) => c.glyph === "▣")).toBe(true);
		expect(rows[0].folded).toBe(true);
	});

	test("columns drop `full` below 80 and the prompt below 57, keeping the block strip usable", () => {
		const wide = timelineColumns(140);
		const mid = timelineColumns(80);
		const narrow = timelineColumns(57);
		const tiny = timelineColumns(36);
		expect(wide.full).toBe(7);
		expect(mid.full).toBe(7);
		expect(narrow.full).toBe(0);
		expect([wide.prompt, mid.prompt, narrow.prompt]).toEqual([32, 24, 17]);
		expect(tiny.prompt).toBe(0);
		expect([wide, mid, narrow, tiny].every((c) => c.blocks >= 8)).toBe(true);
	});

	test("cell clamping keeps the index inside the row", () => {
		const t = truthOf([blk("a:b0:p0", "user", 0, 1, 10), blk("a:b1:p0", "text", 1, 1, 10)]);
		const rows = buildTimeline(t);
		expect(clampCell(9, rows[0])).toBe(1);
		expect(clampCell(-3, rows[0])).toBe(0);
		expect(clampCell(2, undefined)).toBe(0);
		expect(cellGlyph(t, t.blocks[0])).toBe("U");
	});
});
