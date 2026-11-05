/*
 * treeView.ts — a keyboard-driven, filterable tree for the task views: rows with box-drawing
 * connectors, open/close per branch, a selection that survives data changes, and width fitting
 * that drops a row's secondary segments before its label is cut.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ELLIPSIS = "…";
const ANSI = /\x1b\[[0-9;]*m/g;

/** One node. `label` and the segments may be styled; `text` is the plain text searched by a filter. */
export interface TreeNode<D = unknown> {
	key: string;
	label: string;
	/** Segments after the label, most important first; dropped from the end when narrow. */
	meta?: string[];
	/** Right-aligned value (tokens), dropped before any meta segment. */
	right?: string;
	children?: TreeNode<D>[];
	/** Whether the branch starts open. */
	open?: boolean;
	data?: D;
	text?: string;
}

/** A visible row. */
export interface TreeRow<D = unknown> {
	node: TreeNode<D>;
	depth: number;
	/** Connector columns for ancestors and the row itself (`│ ├─`). */
	prefix: string;
	parent: string | null;
	open: boolean;
	branch: boolean;
}

const plain = (s: string) => s.replace(ANSI, "");

/** The node and the plain text a filter matches against. */
function searchText(n: TreeNode): string {
	return (n.text ?? plain([n.label, ...(n.meta ?? [])].join(" "))).toLowerCase();
}

/** Keys of nodes matching `query` and their ancestors; null when there is no query. */
export function filterKeys(roots: readonly TreeNode[], query: string): Set<string> | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	const keep = new Set<string>();
	const walk = (n: TreeNode): boolean => {
		let hit = searchText(n).includes(q);
		for (const c of n.children ?? []) if (walk(c)) hit = true;
		if (hit) keep.add(n.key);
		return hit;
	};
	for (const r of roots) walk(r);
	return keep;
}

/**
 * The visible rows: branches open per `open` (else their default), all matching branches open while
 * a filter is active.
 */
export function flattenTree<D>(roots: readonly TreeNode<D>[], open: ReadonlyMap<string, boolean>, keep: ReadonlySet<string> | null = null): TreeRow<D>[] {
	const out: TreeRow<D>[] = [];
	const walk = (nodes: readonly TreeNode<D>[], depth: number, lead: string, parent: string | null) => {
		const shown = keep ? nodes.filter((n) => keep.has(n.key)) : nodes;
		shown.forEach((n, i) => {
			const last = i === shown.length - 1;
			const branch = !!n.children?.some((c) => !keep || keep.has(c.key));
			const isOpen = branch && (keep ? true : (open.get(n.key) ?? n.open ?? false));
			const prefix = depth === 0 ? "" : `${lead}${last ? "└─" : "├─"}`;
			out.push({ node: n, depth, prefix, parent, open: isOpen, branch });
			if (isOpen) walk(n.children!, depth + 1, depth === 0 ? "" : `${lead}${last ? "  " : "│ "}`, n.key);
		});
	};
	walk(roots, 0, "", null);
	return out;
}

/** One rendered row: marker, connectors, expander, label, then meta and the right value as room allows. */
export function treeRowLine(row: TreeRow, selected: boolean, width: number, mark: (s: string) => string, dim: (s: string) => string): string {
	const expander = row.branch ? (row.open ? "▼ " : "▶ ") : "  ";
	const head = `${selected ? mark("›") : " "}${dim(row.prefix)}${dim(expander)}${row.node.label}`;
	const meta = row.node.meta ?? [];
	const right = row.node.right ?? "";
	for (let n = meta.length; n >= 0; n--) {
		const left = n ? `${head}${dim(" · ")}${meta.slice(0, n).join(dim(" · "))}` : head;
		const lw = visibleWidth(left);
		if (right && lw + 2 + visibleWidth(right) <= width) return `${left}${" ".repeat(width - lw - visibleWidth(right))}${right}`;
		if (lw <= width) return left;
	}
	return truncateToWidth(head, width, ELLIPSIS);
}

/** Selection, open state, filter and scroll over a tree whose nodes may be rebuilt at any time. */
export class TreeState<D = unknown> {
	readonly open = new Map<string, boolean>();
	selected: string | null = null;
	query = "";
	filtering = false;
	private scroll = 0;
	private last: TreeRow<D>[] = [];

	/** The rows for `roots`, keeping the selection on its key (or the nearest row when it vanished). */
	rows(roots: readonly TreeNode<D>[]): TreeRow<D>[] {
		const rows = flattenTree(roots, this.open, filterKeys(roots, this.query));
		const prevIndex = this.last.findIndex((r) => r.node.key === this.selected);
		this.last = rows;
		if (!rows.some((r) => r.node.key === this.selected)) this.selected = rows[Math.max(0, Math.min(prevIndex, rows.length - 1))]?.node.key ?? null;
		return rows;
	}

	get current(): TreeRow<D> | undefined {
		return this.last.find((r) => r.node.key === this.selected);
	}

	move(delta: number): void {
		const i = this.last.findIndex((r) => r.node.key === this.selected);
		const next = this.last[Math.max(0, Math.min(this.last.length - 1, (i < 0 ? 0 : i) + delta))];
		if (next) this.selected = next.node.key;
	}

	/** → : open a closed branch, else step to its first child. */
	right(): void {
		const row = this.current;
		if (!row?.branch) return;
		if (!row.open) this.open.set(row.node.key, true);
		else this.move(1);
	}

	/** ← : close an open branch, else step to the parent. */
	left(): void {
		const row = this.current;
		if (!row) return;
		if (row.branch && row.open) this.open.set(row.node.key, false);
		else if (row.parent) this.selected = row.parent;
	}

	toggle(key = this.selected): void {
		const row = this.last.find((r) => r.node.key === key);
		if (row?.branch) this.open.set(row.node.key, !row.open);
	}

	/** Lines for a body of `height` rows, the selection kept in view. */
	render(roots: readonly TreeNode<D>[], width: number, height: number, mark: (s: string) => string, dim: (s: string) => string): string[] {
		const rows = this.rows(roots);
		const i = Math.max(0, rows.findIndex((r) => r.node.key === this.selected));
		if (i < this.scroll) this.scroll = i;
		if (i >= this.scroll + height) this.scroll = i - height + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - height)));
		return rows.slice(this.scroll, this.scroll + height).map((r) => treeRowLine(r, r.node.key === this.selected, width, mark, dim));
	}

	/** `12/40` position text for the status line. */
	position(): string {
		const i = this.last.findIndex((r) => r.node.key === this.selected);
		return this.last.length ? `${i + 1}/${this.last.length}` : "0/0";
	}
}
