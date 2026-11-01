import { truncateToWidth } from "@earendil-works/pi-tui";
import { isBolted } from "../../core/digest";
import type { Truth } from "../../core/truth";
import type { BlockKind } from "../../core/types";

const roles: Record<BlockKind, string> = {
	system: "S",
	user: "U",
	text: "A",
	thinking: "H",
	tool_call: "C",
	tool_result: "R",
};

/** Project the context into a width-bounded, selection-centered grid. */
export function buildContextMap(truth: Truth, selectedId: string | undefined, width: number, maxRows: number): { lines: string[]; columns: number; selectedIndex: number } {
	const availableWidth = Math.max(0, Math.floor(width));
	const rowLimit = Math.max(0, Math.floor(maxRows));
	const columns = Math.max(1, Math.floor((availableWidth + 1) / 6));
	const blocks = truth.blocks;
	const foundIndex = blocks.findIndex((block) => block.id === selectedId);
	const selectedIndex = blocks.length ? Math.max(0, foundIndex) : -1;
	if (!rowLimit) return { lines: [], columns, selectedIndex };
	if (!blocks.length) return { lines: [truncateToWidth("No blocks yet", availableWidth)], columns, selectedIndex };

	const totalRows = Math.ceil(blocks.length / columns);
	const selectedRow = Math.floor(selectedIndex / columns);
	const startRow = Math.max(0, Math.min(selectedRow - Math.floor(rowLimit / 2), totalRows - rowLimit));
	const lines: string[] = [];
	for (let row = startRow; row < Math.min(totalRows, startRow + rowLimit); row++) {
		const cells = blocks.slice(row * columns, (row + 1) * columns).map((block, column) => {
			const tokens = truth.calBlockTokens(block, block.tokens);
			const face = tokens <= 100 ? 1 : tokens <= 500 ? 2 : tokens <= 1500 ? 3 : tokens <= 5000 ? 4 : tokens <= 15000 ? 5 : 6;
			const role = truth.isFolded(block) ? roles[block.kind].toLowerCase() : roles[block.kind];
			const flag = isBolted(block) ? "!" : block.override === "pinned" ? "*" : truth.isProtected(block) ? "P" : truth.groupOf(block) ? "G" : ".";
			const content = `${role}${face}${flag}`;
			return row * columns + column === selectedIndex ? `[${content}]` : ` ${content} `;
		});
		lines.push(truncateToWidth(cells.join(" "), availableWidth));
	}
	return { lines, columns, selectedIndex };
}
