import { describe, expect, test } from "bun:test";
import { compactCardLines, foldedLine, usageBar } from "./compactCard";
import type { CompactRecord } from "./compaction";

const record: CompactRecord = {
	id: "c1", at: 0, trigger: "manual", strategy: "pass", conductor: "taskfold",
	before: 105_100, after: 62_400, durationMs: 1_400,
	folded: { blocks: 17, groups: 0, byKind: { tool_result: 12, user: 2, text: 3 } },
	undo: [{ kind: "unfold", ids: ["a:b0:p0"] }], message: "conductor freed 42700 tok",
};

describe("compaction card", () => {
	test("leads with outcome, strategy and conductor, then before/after with the saving", () => {
		const lines = compactCardLines(record);
		expect(lines[0]).toBe("✓ accordion compact · pass (taskfold) · 1.4s");
		expect(lines[1]).toContain("before ");
		expect(lines[2]).toContain("−42.7k (41%)");
		expect(lines[4]).toBe("/accordion compact undo · /accordion to inspect");
	});

	test("names folded kinds largest first and omits the undo hint when there is none", () => {
		expect(foldedLine(record)).toBe("folded 12 tool results · 3 assistant texts · 2 user messages");
		expect(foldedLine({ ...record, folded: { blocks: 0, groups: 0, byKind: {} }, undo: null })).toBe("folded nothing");
		expect(compactCardLines({ ...record, undo: null })[4]).toBe("/accordion to inspect");
	});

	test("the bar is a fixed width whatever the tokens", () => {
		expect(usageBar(0, 100)).toHaveLength(26);
		expect(usageBar(100, 100)).toBe("█".repeat(26));
		expect(usageBar(0, 0)).toBe("░".repeat(26));
	});
});
