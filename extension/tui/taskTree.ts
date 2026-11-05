/*
 * taskTree.ts — the task list as a tree, its progress summary, and a row layout that fits a row
 * budget by hiding the parts of the tree furthest from the work in progress.
 */
import { currentBlock, type Task } from "../tasks";

/** How a task is drawn: by status, with in-progress split into `active` and `partial` (some subtasks finished). */
export type TaskGlyphState = "todo" | "active" | "partial" | "blocked" | "done" | "failed" | "abandoned";

export interface TaskNode {
	task: Task;
	parent: TaskNode | null;
	children: TaskNode[];
}

/** Progress over a whole list. */
export interface TaskSummary {
	/** Tasks completed successfully. */
	done: number;
	total: number;
	folded: number;
	/** Summed working time of the outermost started tasks; null when none has timing. */
	durationMs: number | null;
	/** The innermost task in progress. */
	current: TaskNode | null;
	/** The first task not started yet, when nothing is in progress. */
	next: TaskNode | null;
	/** The innermost blocked task, when nothing is in progress. */
	blocked: TaskNode | null;
	/** No task is left to do or in progress. */
	allFinished: boolean;
}

/** One row of the expanded tree. `prefix` holds the tree connectors, e.g. `│ ├─`. */
export type TaskRow =
	| {
			kind: "task";
			prefix: string;
			node: TaskNode;
			state: TaskGlyphState;
			durationMs: number | null;
			folded: boolean;
			/** Done/total direct subtasks, for every task with subtasks. */
			progress: { done: number; total: number } | null;
			/** Whether the subtasks are listed below this row. */
			open: boolean;
	  }
	| {
			kind: "hidden";
			prefix: string;
			/** The hidden sibling tasks this row stands for; their subtasks are hidden with them. */
			ids: string[];
			count: number;
			durationMs: number | null;
			folded: number;
	  };

export interface TaskLayoutOptions {
	/** Row budget for the tree; the work in progress and its ancestors are shown even beyond it. */
	maxRows: number;
	now: number;
	/** Ids of folded tasks (subtasks of a folded task count as folded). */
	folded: ReadonlySet<string>;
	/** Per-task override of whether its subtasks are listed. */
	toggles?: ReadonlyMap<string, boolean>;
	/** Tasks the user revealed from a hidden row; they stay visible regardless of the budget. */
	revealed?: ReadonlySet<string>;
}

const FINISHED = new Set(["done", "failed", "abandoned"]);

export function isFinished(task: Task): boolean {
	return FINISHED.has(task.status);
}

function parentId(id: string): string | null {
	const dot = id.lastIndexOf(".");
	return dot < 0 ? null : id.slice(0, dot);
}

/** The list as a forest in list order; a task whose parent is missing becomes a root. */
export function buildTaskTree(tasks: readonly Task[]): TaskNode[] {
	const byId = new Map<string, TaskNode>();
	const roots: TaskNode[] = [];
	for (const task of tasks) byId.set(task.id, { task, parent: null, children: [] });
	for (const task of tasks) {
		const node = byId.get(task.id)!;
		const parent = parentId(task.id);
		const p = parent === null ? undefined : byId.get(parent);
		if (p) {
			node.parent = p;
			p.children.push(node);
		} else roots.push(node);
	}
	return roots;
}

function* preorder(nodes: readonly TaskNode[]): Generator<TaskNode> {
	for (const n of nodes) {
		yield n;
		yield* preorder(n.children);
	}
}

/** Milliseconds a task has been worked on, blocked periods excluded, or null when it has no start time. */
export function taskDuration(task: Task, now: number): number | null {
	const start = task.startedAt ? Date.parse(task.startedAt) : NaN;
	if (!Number.isFinite(start)) return null;
	const parsed = task.endedAt ? Date.parse(task.endedAt) : now;
	const end = Number.isFinite(parsed) ? parsed : now;
	let paused = 0;
	for (const b of task.blocks ?? []) {
		const from = Date.parse(b.at);
		const to = b.resumedAt ? Date.parse(b.resumedAt) : end;
		if (Number.isFinite(from) && Number.isFinite(to)) paused += Math.max(0, Math.min(to, end) - Math.max(from, start));
	}
	return Math.max(0, end - start - paused);
}

/** Sum of the durations of `nodes` that have one; nested tasks are inside their parent's time. */
function outermostDuration(nodes: readonly TaskNode[], now: number): number | null {
	let total: number | null = null;
	const visit = (n: TaskNode) => {
		const d = taskDuration(n.task, now);
		if (d !== null) total = (total ?? 0) + d;
		else n.children.forEach(visit);
	};
	nodes.forEach(visit);
	return total;
}

function count(nodes: readonly TaskNode[]): number {
	let n = 0;
	for (const _ of preorder(nodes)) n++;
	return n;
}

function countFolded(nodes: readonly TaskNode[], folded: ReadonlySet<string>): number {
	let n = 0;
	for (const node of preorder(nodes)) if (folded.has(node.task.id)) n++;
	return n;
}

export function summarizeTasks(roots: readonly TaskNode[], folded: ReadonlySet<string>, now: number): TaskSummary {
	let done = 0;
	let finished = 0;
	let total = 0;
	let current: TaskNode | null = null;
	let next: TaskNode | null = null;
	let blocked: TaskNode | null = null;
	for (const n of preorder(roots)) {
		total++;
		if (n.task.status === "done") done++;
		if (isFinished(n.task)) finished++;
		if (n.task.status === "doing" && !n.children.some((c) => c.task.status === "doing")) current = n;
		if (!next && n.task.status === "todo") next = n;
		if (n.task.status === "blocked" && !n.children.some((c) => c.task.status === "blocked")) blocked ??= n;
	}
	return {
		done,
		total,
		folded: countFolded(roots, folded),
		durationMs: outermostDuration(roots, now),
		current,
		next: current ? null : next,
		blocked: current ? null : blocked,
		allFinished: total > 0 && finished === total,
	};
}

export function glyphState(node: TaskNode): TaskGlyphState {
	const s = node.task.status;
	if (s === "doing") return node.children.some((c) => isFinished(c.task)) ? "partial" : "active";
	return s;
}

/** The task the layout centres on: the innermost one in progress, else the next to do, else the last one. */
function anchorOf(roots: readonly TaskNode[]): TaskNode | null {
	let last: TaskNode | null = null;
	let firstTodo: TaskNode | null = null;
	let current: TaskNode | null = null;
	for (const n of preorder(roots)) {
		last = n;
		if (!firstTodo && n.task.status === "todo") firstTodo = n;
		if (n.task.status === "doing" && !n.children.some((c) => c.task.status === "doing")) current = n;
	}
	return current ?? firstTodo ?? last;
}

/** A sibling list as laid out: which siblings are visible; the rest collapse into hidden rows. */
interface Level {
	siblings: TaskNode[];
	visible: boolean[];
	pivot: number;
}

/**
 * Rows for the expanded tree. Everything is listed when it fits `maxRows`, with finished tasks'
 * subtasks closed. Otherwise only the path to the anchor task stays; its siblings collapse into
 * `… N hidden` rows and are revealed again nearest-first (upcoming before finished, deepest level
 * first) while the budget allows.
 */
export function layoutTaskTree(roots: readonly TaskNode[], options: TaskLayoutOptions): TaskRow[] {
	const toggles = options.toggles ?? new Map<string, boolean>();
	const revealed = options.revealed ?? new Set<string>();
	const anchor = anchorOf(roots);
	const path = new Set<TaskNode>();
	for (let n = anchor; n; n = n.parent) path.add(n);

	const fullOpen = (n: TaskNode) => toggles.get(n.task.id) ?? (path.has(n) || !isFinished(n.task));
	const full = render(roots, () => true, fullOpen, options);
	if (full.length <= options.maxRows) return full;

	// One level per sibling list on the path, plus the anchor's own subtasks.
	const levels = new Map<TaskNode[], Level>();
	const addLevel = (siblings: TaskNode[], pivot: number) => {
		levels.set(siblings, { siblings, pivot: Math.max(0, pivot), visible: siblings.map((s) => path.has(s) || revealed.has(s.task.id)) });
	};
	const chain = [...path].reverse();
	chain.forEach((n, i) => addLevel(i === 0 ? (roots as TaskNode[]) : chain[i - 1].children, (i === 0 ? roots : chain[i - 1].children).indexOf(n)));
	if (anchor && anchor.children.length) {
		const firstOpen = anchor.children.findIndex((c) => !isFinished(c.task));
		addLevel(anchor.children, firstOpen < 0 ? anchor.children.length - 1 : firstOpen);
		if (firstOpen >= 0) levels.get(anchor.children)!.visible[firstOpen] = true;
	}

	const smartOpen = (n: TaskNode) => toggles.get(n.task.id) ?? path.has(n);
	const isVisible = (n: TaskNode, siblings: TaskNode[]) => {
		const level = levels.get(siblings);
		return level ? level.visible[siblings.indexOf(n)] : true;
	};
	const rows = () => render(roots, isVisible, smartOpen, options);

	// Nearest-first reveal order: deepest level first, the next upcoming sibling before the previous one.
	const ordered = [...levels.values()].reverse();
	const reach = Math.max(0, ...ordered.map((l) => l.siblings.length));
	for (let d = 0; d <= reach; d++) {
		for (const level of ordered) {
			for (const i of [level.pivot + d, level.pivot - d]) {
				if (i < 0 || i >= level.siblings.length || level.visible[i]) continue;
				level.visible[i] = true;
				if (rows().length > options.maxRows) level.visible[i] = false;
			}
		}
	}
	return rows();
}

function render(
	roots: readonly TaskNode[],
	isVisible: (n: TaskNode, siblings: TaskNode[]) => boolean,
	isOpen: (n: TaskNode) => boolean,
	options: TaskLayoutOptions,
): TaskRow[] {
	const out: TaskRow[] = [];
	const walk = (siblings: TaskNode[], indent: string) => {
		const items: Array<TaskNode | TaskNode[]> = [];
		for (const s of siblings) {
			if (isVisible(s, siblings)) items.push(s);
			else if (Array.isArray(items[items.length - 1])) (items[items.length - 1] as TaskNode[]).push(s);
			else items.push([s]);
		}
		items.forEach((item, i) => {
			const last = i === items.length - 1;
			const prefix = `${indent}${last ? "└─" : "├─"}`;
			if (Array.isArray(item)) {
				out.push({
					kind: "hidden",
					prefix,
					ids: item.map((n) => n.task.id),
					count: count(item),
					durationMs: outermostDuration(item, options.now),
					folded: countFolded(item, options.folded),
				});
				return;
			}
			const open = item.children.length > 0 && isOpen(item);
			out.push({
				kind: "task",
				prefix,
				node: item,
				state: glyphState(item),
				durationMs: taskDuration(item.task, options.now),
				folded: options.folded.has(item.task.id),
				progress: item.children.length ? { done: item.children.filter((c) => c.task.status === "done").length, total: item.children.length } : null,
				open,
			});
			if (open) walk(item.children, `${indent}${last ? "  " : "│ "}`);
		});
	};
	walk(roots as TaskNode[], "");
	return out;
}
