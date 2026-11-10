import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const KIND_RGB: Record<BlockKind, readonly [number, number, number]> = {
	system: [255, 246, 164], // #FFF6A4
	user: [4, 78, 255], // #044EFF
	text: [26, 166, 232], // #1AA6E8
	thinking: [180, 128, 223], // #B480DF
	tool_call: [33, 212, 193], // #21D4C1
	tool_result: [225, 156, 125], // #E19C7D
};

const GROUP_RGB: readonly [number, number, number] = [124, 82, 48]; // #7C5230

export function fgRgb([r, g, b]: readonly [number, number, number], text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function dimRgb([r, g, b]: readonly [number, number, number], text: string): string {
	const dr = Math.round(r * 0.55);
	const dg = Math.round(g * 0.55);
	const db = Math.round(b * 0.55);
	return `\x1b[38;2;${dr};${dg};${db}m${text}\x1b[39m`;
}

export function colorKind(kind: BlockKind, text: string, folded = false, inFoldedGroup = false): string {
	if (inFoldedGroup) return dimRgb(GROUP_RGB, text);
	const rgb = KIND_RGB[kind];
	return folded ? dimRgb(rgb, text) : fgRgb(rgb, text);
}

export function kindGlyph(kind: BlockKind, folded = false, inFoldedGroup = false): string {
	const glyph = kind === "system" ? "⛨" : inFoldedGroup ? "▣" : folded ? "▫" : "■";
	return colorKind(kind, glyph, folded, inFoldedGroup);
}

export function formatCompactTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

export interface CategoryShare {
	kind: BlockKind;
	label: string;
	liveTokens: number;
	fullTokens: number;
	blocks: number;
	foldedBlocks: number;
}

export interface ContextBreakdown {
	categories: CategoryShare[];
	liveTokens: number;
	fullTokens: number;
	savedTokens: number;
	savedPct: number;
	budget: number;
	protectTokens: number;
	freeTokens: number;
	usagePct: number;
}

/** Compute Claude Code `/context`-style token breakdown across block categories. */
export function buildContextBreakdown(truth: Truth): ContextBreakdown {
	const order: { kind: BlockKind; label: string }[] = [
		{ kind: "system", label: "System" },
		{ kind: "user", label: "User" },
		{ kind: "text", label: "Assistant" },
		{ kind: "thinking", label: "Thinking" },
		{ kind: "tool_call", label: "Tool Call" },
		{ kind: "tool_result", label: "Tool Result" },
	];
	const map = new Map<BlockKind, CategoryShare>();
	for (const item of order) {
		map.set(item.kind, { kind: item.kind, label: item.label, liveTokens: 0, fullTokens: 0, blocks: 0, foldedBlocks: 0 });
	}
	for (const b of truth.blocks) {
		const entry = map.get(b.kind)!;
		entry.blocks++;
		const folded = truth.isFolded(b);
		if (folded) entry.foldedBlocks++;
		entry.fullTokens += truth.calBlockTokens(b, b.tokens);
		entry.liveTokens += truth.calBlockTokens(b, truth.effTokens(b));
	}
	const stats = truth.stats();
	const savedTokens = Math.max(0, stats.fullTokens - stats.liveTokens);
	const savedPct = stats.fullTokens > 0 ? Math.round((savedTokens / stats.fullTokens) * 100) : 0;
	const budget = Math.max(1, stats.budget);
	const freeTokens = Math.max(0, budget - stats.liveTokens);
	const usagePct = Math.min(999, Math.round((stats.liveTokens / budget) * 100));
	return {
		categories: order.map((o) => map.get(o.kind)!),
		liveTokens: stats.liveTokens,
		fullTokens: stats.fullTokens,
		savedTokens,
		savedPct,
		budget: stats.budget,
		protectTokens: stats.protectTokens,
		freeTokens,
		usagePct,
	};
}

/** Render a Claude Code `/context`-inspired proportional Spectrum bar + category legend. */
export function renderCategoryBar(truth: Truth, width: number, paintFree: (text: string) => string = (text) => `\x1b[38;5;240m${text}\x1b[39m`): string[] {
	const available = Math.max(0, Math.floor(width));
	if (available < 10) return [];
	const bd = buildContextBreakdown(truth);
	const denom = Math.max(bd.budget, bd.liveTokens, 1);
	const statsSuffix = ` ${formatCompactTokens(bd.liveTokens)}/${formatCompactTokens(bd.budget)} (${bd.usagePct}%)${bd.savedTokens > 0 ? ` · −${formatCompactTokens(bd.savedTokens)} (${bd.savedPct}%)` : ""}`;
	const barCells = Math.max(8, Math.min(44, available - visibleWidth(statsSuffix) - 4));
	let usedCells = 0;
	const segments: string[] = [];
	for (const cat of bd.categories) {
		if (cat.liveTokens <= 0) continue;
		const raw = (cat.liveTokens / denom) * barCells;
		const cells = Math.max(1, Math.round(raw));
		const clamped = Math.min(cells, Math.max(0, barCells - usedCells));
		if (clamped > 0) {
			usedCells += clamped;
			segments.push(fgRgb(KIND_RGB[cat.kind], "█".repeat(clamped)));
		}
	}
	const freeCells = Math.max(0, barCells - usedCells);
	if (freeCells > 0) {
		segments.push(paintFree("░".repeat(freeCells)));
	}
	const barLine = truncateToWidth(`  ▕${segments.join("")}▏${statsSuffix}`, available);

	const parts: string[] = [];
	for (const cat of bd.categories) {
		if (cat.blocks === 0 && cat.kind !== "system" && cat.kind !== "user") continue;
		const dot = fgRgb(KIND_RGB[cat.kind], cat.foldedBlocks > 0 ? "▣" : "■");
		parts.push(`${dot} ${cat.label} ${formatCompactTokens(cat.liveTokens)}`);
	}
	parts.push(`${paintFree("░")} Free ${formatCompactTokens(bd.freeTokens)}`);
	const legendLine = truncateToWidth(`  ${parts.join(" · ")}`, available);
	return [barLine, legendLine];
}

/** Project the context into a width-bounded, selection-centered grid. */
export function buildContextMap(
	truth: Truth,
	selectedId: string | undefined,
	width: number,
	maxRows: number,
	options?: { colored?: boolean },
): { lines: string[]; columns: number; selectedIndex: number } {
	const availableWidth = Math.max(0, Math.floor(width));
	const rowLimit = Math.max(0, Math.floor(maxRows));
	const columns = Math.max(1, Math.floor((availableWidth + 1) / 6));
	const blocks = truth.blocks;
	const foundIndex = blocks.findIndex((block) => block.id === selectedId);
	const selectedIndex = blocks.length ? Math.max(0, foundIndex) : -1;
	if (!rowLimit) return { lines: [], columns, selectedIndex };
	if (!blocks.length) return { lines: [truncateToWidth("No blocks yet", availableWidth)], columns, selectedIndex };

	const colored = options?.colored === true;
	const totalRows = Math.ceil(blocks.length / columns);
	const selectedRow = Math.floor(selectedIndex / columns);
	const startRow = Math.max(0, Math.min(selectedRow - Math.floor(rowLimit / 2), totalRows - rowLimit));
	const lines: string[] = [];
	for (let row = startRow; row < Math.min(totalRows, startRow + rowLimit); row++) {
		const cells = blocks.slice(row * columns, (row + 1) * columns).map((block, column) => {
			const tokens = truth.calBlockTokens(block, block.tokens);
			const face = tokens <= 100 ? 1 : tokens <= 500 ? 2 : tokens <= 1500 ? 3 : tokens <= 5000 ? 4 : tokens <= 15000 ? 5 : 6;
			const folded = truth.isFolded(block);
			const group = truth.groupOf(block);
			const role = folded ? roles[block.kind].toLowerCase() : roles[block.kind];
			const flag = isBolted(block) ? "!" : block.override === "pinned" ? "*" : truth.isProtected(block) ? "P" : group ? "G" : ".";
			const content = `${role}${face}${flag}`;
			const isSelected = row * columns + column === selectedIndex;
			const rawCell = isSelected ? `[${content}]` : ` ${content} `;
			if (!colored) return rawCell;
			return colorKind(block.kind, rawCell, folded, !!group?.folded);
		});
		lines.push(truncateToWidth(cells.join(" "), availableWidth));
	}
	return { lines, columns, selectedIndex };
}
