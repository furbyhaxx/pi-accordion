import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Truth } from "../../core/truth";
import type { Block, BlockKind } from "../../core/types";
import { buildContextMap, buildContextBreakdown, renderCategoryBar } from "./map";

function block(id: string, order: number, kind: BlockKind = "text", tokens = 20): Block {
	return { id, order, kind, tokens, turn: 1, text: `content ${id}`, override: null, autoFolded: false, by: null };
}

function truth(blocks: Block[]): Truth {
	return new Truth({ meta: { format: "pi", title: "test", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 });
}

describe("context map", () => {
	test("fits terminal widths and lays out cells in conversation order", () => {
		const t = truth(Array.from({ length: 50 }, (_, i) => block(String(i), i)));
		t.setProtect(0);
		for (const width of [20, 36, 57, 80, 140]) {
			const map = buildContextMap(t, "0", width, 100);
			expect(map.columns).toBe(Math.floor((width + 1) / 6));
			expect(map.selectedIndex).toBe(0);
			expect(map.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(map.lines[0].startsWith("[A1 ]  A1  ")).toBe(true);
			expect(map.lines.join("").match(/A1 /g)).toHaveLength(50);
		}
	});

	test("scrolls by whole rows around selection and reports absolute index", () => {
		const t = truth(Array.from({ length: 24 }, (_, i) => block(String(i), i, "text", i * 1000)));
		t.setProtect(0);
		const middle = buildContextMap(t, "13", 17, 3);
		expect(middle.columns).toBe(3);
		expect(middle.selectedIndex).toBe(13);
		expect(middle.lines).toEqual([" A5    A5    A5  ", " A5   [A5 ]  A5  ", " A5    A6    A6  "]);
		expect(buildContextMap(t, "23", 17, 2).lines).toEqual([" A6    A6    A6  ", " A6    A6   [A6 ]"]);
	});

	test("uses role, folding, and flag precedence from Truth", () => {
		const t = truth([
			block("sys:0", -1, "system"), block("u", 0, "user"),
			block("a", 1), block("h", 2, "thinking"),
			block("c", 3, "tool_call"), block("r", 4, "tool_result"), block("tail", 5, "user"),
		]);
		t.setProtect(20);
		const result = t.apply([{ kind: "fold", ids: ["a"] }, { kind: "pin", ids: ["h"] }, { kind: "group", ids: ["c", "r"] }], "you");
		expect(result.results.every((entry) => entry.applied)).toBe(true);
		const before = { rev: t.rev, blocks: structuredClone(t.blocks), groups: structuredClone(t.groups) };
		const map = buildContextMap(t, "u", 80, 5);
		expect(map.lines).toEqual([" S1!  [U1 ]  a1    H1*   c1G   r1G   U1P "]);
		expect({ rev: t.rev, blocks: t.blocks, groups: t.groups }).toEqual(before);
		const group = t.groups[0];
		t.apply([{ kind: "unfoldGroup", groupId: group.id }], "you");
		expect(buildContextMap(t, "u", 80, 5).lines[0]).toContain(" C1G   R1G ");
		t.apply([{ kind: "pin", ids: ["tail"] }], "you");
		expect(buildContextMap(t, "u", 80, 5).lines[0]).toEndWith(" U1* ");
	});

	test("uses inclusive calibrated full-token thresholds", () => {
		const values = [100, 101, 500, 501, 1500, 1501, 5000, 5001, 15000, 15001];
		const t = truth(values.map((tokens, i) => block(String(i), i, "text", tokens)));
		t.setProtect(0);
		expect(buildContextMap(t, undefined, 140, 2).lines[0]).toBe("[A1 ]  A2    A2    A3    A3    A4    A4    A5    A5    A6  ");
		t.apply([{ kind: "fold", ids: ["0"] }], "you");
		t.setCalibration(2, 0);
		expect(buildContextMap(t, "0", 140, 2).lines[0].startsWith("[a2 ]  A2 ")).toBe(true);
	});

	test("handles missing selection, empty context and narrow or zero dimensions", () => {
		const t = truth([block("a", 0)]);
		const missing = buildContextMap(t, "missing", 5, 1);
		expect(missing.selectedIndex).toBe(0);
		expect(missing.lines).toEqual(["[A1P]"]);
		for (const width of [0, 1, 2, 3, 4]) {
			const map = buildContextMap(t, "a", width, 1);
			expect(map.columns).toBe(1);
			expect(map.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		expect(buildContextMap(t, "a", 20, 0).lines).toEqual([]);
		expect(buildContextMap(t, "a", -1, -1).lines).toEqual([]);
		const empty = buildContextMap(truth([]), undefined, 20, 1);
		expect(empty.selectedIndex).toBe(-1);
		expect(empty.lines.join("")).toContain("No blocks");
	});

	test("computes Claude Code /context breakdown and renders Spectrum colored bar and cells", () => {
		const t = truth([
			block("sys:0", -1, "system", 1000),
			block("u1", 0, "user", 500),
			block("a1", 1, "text", 2000),
			block("r1", 2, "tool_result", 4000),
		]);
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["r1"] }], "you");
		const bd = buildContextBreakdown(t);
		expect(bd.fullTokens).toBe(7500);
		expect(bd.liveTokens).toBeLessThan(bd.fullTokens);
		expect(bd.savedTokens).toBeGreaterThan(3000);
		expect(bd.categories.find((c) => c.kind === "tool_result")?.foldedBlocks).toBe(1);

		for (const width of [20, 36, 57, 80, 140]) {
			const bar = renderCategoryBar(t, width);
			expect(bar).toHaveLength(2);
			expect(bar.every((line) => visibleWidth(line) <= width)).toBe(true);
			const coloredMap = buildContextMap(t, "a1", width, 4, { colored: true });
			expect(coloredMap.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(coloredMap.lines.join("\n")).toContain("[A4 ]");
			expect(coloredMap.lines.join("\n")).toContain("\x1b[38;2;");
		}
	});
});
