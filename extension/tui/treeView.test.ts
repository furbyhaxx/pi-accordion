import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TreeState, filterKeys, flattenTree, treeRowLine, type TreeNode } from "./treeView";

const id = (s: string) => s;
const tree: TreeNode[] = [
	{ key: "1", label: "1 Parent", children: [{ key: "1.1", label: "1.1 Child" }, { key: "1.2", label: "1.2 Needle", children: [{ key: "1.2.1", label: "1.2.1 Leaf" }] }] },
	{ key: "2", label: "2 Other", meta: ["3/4", "2m"], right: "10k → 1k" },
];

describe("tree view", () => {
	it("draws connectors for open branches only", () => {
		const rows = flattenTree(tree, new Map([["1", true], ["1.2", true]]));
		expect(rows.map((r) => `${r.prefix}${r.node.key}`)).toEqual(["1", "├─1.1", "└─1.2", "  └─1.2.1", "2"]);
	});

	it("filters to matches and their ancestors, opening them", () => {
		const keep = filterKeys(tree, "needle")!;
		expect(flattenTree(tree, new Map(), keep).map((r) => r.node.key)).toEqual(["1", "1.2"]);
		expect(filterKeys(tree, " ")).toBeNull();
	});

	it("drops the right value, then meta, before cutting the label", () => {
		const row = flattenTree(tree, new Map())[1];
		const wide = treeRowLine(row, false, 40, id, id);
		expect(wide).toContain("2 Other · 3/4 · 2m");
		expect(wide.endsWith("10k → 1k")).toBe(true);
		expect(visibleWidth(wide)).toBe(40);
		expect(treeRowLine(row, false, 22, id, id)).toBe("   2 Other · 3/4 · 2m");
		expect(treeRowLine(row, false, 12, id, id)).toBe("   2 Other");
		expect(visibleWidth(treeRowLine(row, true, 6, id, id))).toBeLessThanOrEqual(6);
	});

	it("moves with arrows and keeps the selection when nodes are rebuilt", () => {
		const s = new TreeState();
		s.rows(tree);
		expect(s.selected).toBe("1");
		s.right();
		s.rows(tree);
		s.right();
		expect(s.selected).toBe("1.1");
		s.left();
		expect(s.selected).toBe("1");
		s.move(5);
		s.rows(tree);
		expect(s.selected).toBe("2");
		s.rows(tree.slice(0, 1));
		expect(s.selected).toBe("1.2");
	});
});
