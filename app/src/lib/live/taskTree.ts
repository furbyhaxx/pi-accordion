/*
 * taskTree.ts — the host's flat task list as the rows of SPEC-0001 §4.4, for the web TasksPanel.
 *
 * Pure: the host sends the projection (`tasks` message) and the panel keeps two pieces of view state
 * (`toggles`, `revealed`); this turns both into the visible rows. Ids are dotted (`2.1.3` is a
 * subtask of `2.1`); a task whose parent is missing becomes a root.
 */
import type { WireTask } from "$core/protocol";

/** How a task is drawn: by status, with in-progress split by whether a subtask already finished. */
export type TaskGlyphState = "todo" | "active" | "partial" | "blocked" | "done" | "failed" | "abandoned";

/** The CSS-token family a glyph takes (`--ok`, `--danger`, `--muted`, `--warn`, `--text`); never the user-block blue. */
export type TaskTone = "success" | "error" | "muted" | "warning" | "text";

export const TASK_GLYPH: Record<TaskGlyphState, string> = {
	todo: "☐",
	active: "▶",
	partial: "◐",
	blocked: "⧗",
	done: "▣",
	failed: "☒",
	abandoned: "⊘",
};

const TONE: Record<TaskGlyphState, TaskTone> = {
	todo: "muted",
	active: "warning",
	partial: "warning",
	blocked: "warning",
	done: "success",
	failed: "error",
	abandoned: "muted",
};

export function glyphTone(state: TaskGlyphState): TaskTone {
	return TONE[state];
}

/** Tokens of a folded task's groups, before and after folding. */
export interface FoldTokens { full: number; live: number }

/** Leaf-status counts under a task with subtasks, e.g. `3▣ 1☒ 2☐`. */
export interface LeafCounts { done: number; failed: number; abandoned: number; pending: number }

/** `≡` folded, `·` finished but raw, `!` finished with unfinished descendants. */
export type TaskMark = "folded" | "raw" | "inconsistent" | null;

export type TaskTreeRow =
	| {
			kind: "task";
			id: string;
			title: string;
			depth: number;
			state: TaskGlyphState;
			mark: TaskMark;
			/** Own folded tokens, when the host sent them for a folded task. */
			tokens: FoldTokens | null;
			/** Leaf counts, for any task with subtasks. */
			progress: LeafCounts | null;
			hasChildren: boolean;
			/** Whether the subtasks are listed below this row. */
			open: boolean;
			/** Folded descendants hidden while this row is closed. */
			foldedBelow: number;
	  }
	| {
			kind: "finished";
			/** Id of the run's first task; `revealed` holds it while the run is expanded. */
			key: string;
			depth: number;
			count: number;
			open: boolean;
			/** Folded tasks in the run, subtasks included, and their summed tokens when the host sent them. */
			folded: number;
			tokens: FoldTokens | null;
	  };

export interface TaskTreeOptions {
	/** Ids of folded tasks. */
	folded?: ReadonlySet<string>;
	/** Folded tokens per task id. */
	foldTokens?: Readonly<Record<string, FoldTokens>>;
	/** Per-task override of whether its subtasks are listed; the default is open unless the task is finished. */
	toggles?: ReadonlyMap<string, boolean>;
	/** Keys of finished runs the user expanded. */
	revealed?: ReadonlySet<string>;
}

interface Node {
	task: WireTask;
	children: Node[];
}

const FINISHED = new Set(["done", "failed", "abandoned"]);

export function isFinishedStatus(status: string): boolean {
	return FINISHED.has(status);
}

function parentId(id: string): string | null {
	const dot = id.lastIndexOf(".");
	return dot < 0 ? null : id.slice(0, dot);
}

/** The list as a forest in list order. */
function buildForest(tasks: readonly WireTask[]): Node[] {
	const byId = new Map<string, Node>();
	for (const task of tasks) byId.set(task.id, { task, children: [] });
	const roots: Node[] = [];
	for (const task of tasks) {
		const node = byId.get(task.id)!;
		const parent = parentId(task.id);
		const owner = parent === null ? undefined : byId.get(parent);
		(owner ? owner.children : roots).push(node);
	}
	return roots;
}

function* preorder(nodes: readonly Node[]): Generator<Node> {
	for (const node of nodes) {
		yield node;
		yield* preorder(node.children);
	}
}

function leafCounts(node: Node): LeafCounts {
	const counts: LeafCounts = { done: 0, failed: 0, abandoned: 0, pending: 0 };
	for (const n of preorder(node.children)) {
		if (n.children.length) continue;
		const s = n.task.status;
		if (s === "done") counts.done++;
		else if (s === "failed") counts.failed++;
		else if (s === "abandoned") counts.abandoned++;
		else counts.pending++;
	}
	return counts;
}

function stateOf(node: Node): TaskGlyphState {
	const s = node.task.status;
	if (s === "done" || s === "failed" || s === "abandoned" || s === "blocked") return s;
	if (s === "doing") return node.children.some((c) => c.task.status === "done") ? "partial" : "active";
	return "todo";
}

function hasUnfinishedBelow(node: Node): boolean {
	for (const n of preorder(node.children)) if (!isFinishedStatus(n.task.status)) return true;
	return false;
}

/** The `3▣ 1☒ 2⊘ 4☐` text of leaf counts; zero counts are left out. */
export function formatProgress(c: LeafCounts): string {
	return [c.done ? `${c.done}▣` : "", c.failed ? `${c.failed}☒` : "", c.abandoned ? `${c.abandoned}⊘` : "", c.pending ? `${c.pending}☐` : ""]
		.filter(Boolean)
		.join(" ");
}

/**
 * The rows to draw. Rules (SPEC-0001 §4.4): a finished task's subtasks start closed, an unfinished
 * task's start open (`toggles` overrides either); a run of two or more finished siblings that have
 * nothing unfinished below them collapses to one `… N finished` row until its key is in `revealed`
 * (a run of one is the task itself); an expanded run keeps its row so it can be collapsed again.
 */
export function buildTaskRows(tasks: readonly WireTask[], options: TaskTreeOptions = {}): TaskTreeRow[] {
	const folded = options.folded ?? new Set<string>();
	const rows: TaskTreeRow[] = [];

	const isOpen = (node: Node): boolean => options.toggles?.get(node.task.id) ?? !isFinishedStatus(node.task.status);
	const collapsible = (node: Node): boolean => isFinishedStatus(node.task.status) && !hasUnfinishedBelow(node);

	const emit = (node: Node, depth: number): void => {
		const state = stateOf(node);
		const hasChildren = node.children.length > 0;
		const open = hasChildren && isOpen(node);
		const isFolded = folded.has(node.task.id);
		const inconsistent = isFinishedStatus(node.task.status) && hasUnfinishedBelow(node);
		rows.push({
			kind: "task",
			id: node.task.id,
			title: node.task.title,
			depth,
			state,
			mark: inconsistent ? "inconsistent" : isFolded ? "folded" : isFinishedStatus(node.task.status) ? "raw" : null,
			tokens: isFolded ? (options.foldTokens?.[node.task.id] ?? null) : null,
			progress: hasChildren ? leafCounts(node) : null,
			hasChildren,
			open,
			foldedBelow: hasChildren && !open ? [...preorder(node.children)].filter((n) => folded.has(n.task.id)).length : 0,
		});
		if (open) level(node.children, depth + 1);
	};

	const level = (nodes: readonly Node[], depth: number): void => {
		let i = 0;
		while (i < nodes.length) {
			if (!collapsible(nodes[i]!)) {
				emit(nodes[i]!, depth);
				i++;
				continue;
			}
			let end = i;
			while (end < nodes.length && collapsible(nodes[end]!)) end++;
			const run = nodes.slice(i, end);
			i = end;
			if (run.length < 2) {
				emit(run[0]!, depth);
				continue;
			}
			const key = run[0]!.task.id;
			const open = options.revealed?.has(key) ?? false;
			const foldedHere = [...preorder(run)].filter((n) => folded.has(n.task.id));
			const withTokens = foldedHere.flatMap((n) => options.foldTokens?.[n.task.id] ?? []);
			const tokens = withTokens.length ? withTokens.reduce((sum, f) => ({ full: sum.full + f.full, live: sum.live + f.live }), { full: 0, live: 0 }) : null;
			rows.push({ kind: "finished", key, depth, count: run.length, open, folded: foldedHere.length, tokens });
			if (open) for (const node of run) emit(node, depth);
		}
	};

	level(buildForest(tasks), 0);
	return rows;
}

/** The collapsed summary line of a list: `done/total` tasks and how many run folded. */
export function summarizeTasks(tasks: readonly WireTask[], folded: readonly string[]): { done: number; total: number; folded: number } {
	const ids = new Set(tasks.map((t) => t.id));
	return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length, folded: folded.filter((id) => ids.has(id)).length };
}
