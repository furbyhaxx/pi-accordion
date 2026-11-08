/*
 * taskTranscript.ts — the session transcript seen through its tasks: which blocks each task span holds,
 * how they were folded, and why user messages were kept or folded. Pure: the task views render it, and
 * `transcriptSource` adapts a Truth to its plain input.
 */
import type { Truth } from "../../core/truth";
import type { BlockKind, ContextProjection, Group, GroupHandle } from "../../core/types";
import { scanTaskSpans, taskKeyOfSummary, type TaskSpan } from "../../conductors/in-process/taskfold/taskfold";
import type { Verdict } from "../../conductors/in-process/taskfold/verdicts";
import type { TaskList } from "../tasks";

/** A block as the transcript needs it; tokens are calibrated, `live` is what is sent now. */
export interface TBlock {
	id: string;
	kind: BlockKind;
	text: string;
	full: number;
	live: number;
	turn?: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	/** Persisted tool-result facts used by the conductor span scan. */
	details?: unknown;
	/** Folded on its own (not through a group). */
	folded?: boolean;
	/** What such a block rides as: its digest, the only text the agent holds for it. */
	digest?: string;
	pinned?: boolean;
	/** Inside the protected working tail. */
	protected?: boolean;
}

/** A group with its calibrated tokens at full size and as sent now. */
export interface TGroup {
	id: string;
	memberIds: readonly string[];
	folded: boolean;
	summary: string | null | undefined;
	handles?: readonly GroupHandle[];
	full: number;
	live: number;
}

export interface TranscriptSource {
	lists?: readonly TaskList[];
	listIssues?: readonly string[];
	blocks: readonly TBlock[];
	groups: readonly TGroup[];
	/** Authoritative carrier order and per-block charges, including drops and stragglers. */
	projection: readonly ContextProjection[];
	verdict(id: string): Verdict | undefined;
	/** The fold threshold the verdicts were judged against, when a Taskfold conductor set one. */
	threshold: number | null;
}

/** Tokens at full size and as sent now. */
export interface Tokens {
	full: number;
	live: number;
}

export type TNode =
	| { type: "task"; span: TaskSpan; children: TNode[]; tokens: Tokens; folds: number; subtasks: { done: number; total: number } }
	| { type: "user"; block: TBlock; verdict: Verdict | undefined; folded: boolean; why: string }
	| { type: "untracked"; blocks: TBlock[]; calls: number; tokens: Tokens }
	| { type: "fold"; group: TGroup; code: string | null; key: string | null; level: 0 | 1 | 2 | null; children: TNode[] }
	| { type: "step"; block: TBlock; result: TBlock | null; tokens: Tokens; folded: boolean }
	| { type: "edge"; edge: "start" | "finish"; span: TaskSpan; block: TBlock };

/** Optional session metadata and whether folding is armed on the outgoing request. */
export interface TranscriptOptions extends Pick<TranscriptSource, "lists" | "listIssues"> {
	folding?: boolean;
}

/** Adapt a Truth and its session-local metadata to the transcript's input. */
export function transcriptSource(truth: Truth, verdict: (id: string) => Verdict | undefined, threshold: number | null, options: TranscriptOptions = {}): TranscriptSource {
	const folding = options.folding ?? true;
	const projection = truth.projectContext(folding);
	const charges = new Map(projection.flatMap((p) => p.members.map((b) => [b.id, b] as const)));
	return {
		lists: options.lists,
		listIssues: options.listIssues,
		projection,
		blocks: truth.blocks.map((b) => ({
			id: b.id,
			kind: b.kind,
			text: b.text,
			turn: b.turn,
			full: charges.get(b.id)!.full,
			live: charges.get(b.id)!.live,
			...(b.toolName ? { toolName: b.toolName } : {}),
			...(b.callId ? { callId: b.callId } : {}),
			...(b.isError ? { isError: true } : {}),
			...(b.details !== undefined ? { details: b.details } : {}),
			...(folding && truth.isFolded(b) && !truth.groupOf(b)?.folded ? { folded: true, digest: truth.digestOf(b) } : {}),
			...(b.override === "pinned" ? { pinned: true } : {}),
			...(truth.isProtected(b) ? { protected: true } : {}),
		})),
		groups: truth.groups.map((g) => ({
			id: g.id,
			memberIds: g.memberIds,
			...(g.handles ? { handles: g.handles } : {}),
			folded: folding && g.folded,
			summary: g.digest,
			full: truth.calibratedGroupFullTokens(g),
			live: truth.calibratedGroupLiveTokens(g),
		})),
		verdict,
		threshold,
	};
}

/** One stored record participating in a task's recovery, possibly through a composed handle. */
export interface TaskFoldRef {
	group: Group;
	handleId?: string;
	memberIds: string[];
}

/** Resolve task records and every source group referenced by a composed task handle. */
export function taskFoldRefs(truth: Truth, key: string): TaskFoldRef[] {
	const refs = new Map<string, TaskFoldRef>();
	for (const g of truth.groups) {
		const handle = g.handles?.find((h) => h.id === `t:${key}`);
		if (!handle && taskKeyOfSummary(g.digest) !== key) continue;
		const ids = handle?.memberIds ?? g.memberIds;
		const owners = new Map<string, Group>([[g.id, g]]);
		for (const id of ids) { const block = truth.get(id); const owner = block ? truth.groupOf(block) : undefined; if (owner) owners.set(owner.id, owner); }
		for (const owner of owners.values()) {
			const members = ids.filter((id) => owner.memberIds.includes(id));
			if (!members.length) continue;
			const previous = refs.get(owner.id);
			refs.set(owner.id, { group: owner, ...(handle ? { handleId: handle.id } : {}),
				memberIds: [...new Set([...(previous?.memberIds ?? []), ...members])] });
		}
	}
	return [...refs.values()];
}

/** Every task span of the session, finished and open. */
export function transcriptSpans(src: TranscriptSource): TaskSpan[] {
	return scanTaskSpans(src.blocks, (b) => b.text);
}

const fmtLoss = (n: number) => n.toFixed(1);

/** Why a user message was kept or folded, in the words the views show. */
export function userReason(verdict: Verdict | undefined, folded: boolean, threshold: number | null, inTask = true): string {
	const t = threshold == null ? "" : threshold.toFixed(2);
	if (verdict?.source === "harness") return "harness pattern";
	if (verdict?.source === "opening") return "opening message";
	if (verdict?.source === "error") return "classifier failed";
	if (verdict?.loss != null) {
		const below = threshold != null && verdict.loss < threshold;
		// Eligible but unfolded: only a task record folds user messages, and none covers this one yet.
		if (below && !folded) return `loss ${fmtLoss(verdict.loss)} < ${t} · ${inTask ? "folds with its task" : "no task covers it"}`;
		return folded || below ? `loss ${fmtLoss(verdict.loss)}${t ? ` < ${t}` : ""}` : `loss ${fmtLoss(verdict.loss)}${t ? ` ≥ ${t}` : ""}`;
	}
	return "unclassified";
}

/** A record summary's aging level: 0 full, 1 one line, 2 archived stub; null for other summaries. */
export function recordLevel(summary: string | null | undefined): 0 | 1 | 2 | null {
	if (!taskKeyOfSummary(summary)) return null;
	if (/^\{#[0-9a-z]{6} FOLDED\} \[task-archived\]/.test(summary!)) return 2;
	return /^\{#[0-9a-z]{6} FOLDED\} \[task-record\]/.test(summary!) && (!summary!.includes("\n") || summary!.split("\n", 1)[0].includes(" · recall ")) ? 1 : 0;
}

function codeOf(summary: string | null | undefined): string | null {
	return typeof summary === "string" ? (/^\{#([0-9a-z]{6}) FOLDED\}/.exec(summary)?.[1] ?? null) : null;
}

interface Index {
	src: TranscriptSource;
	groupOf: Map<string, TGroup>;
	resultOf: Map<string, number>;
}

function index(src: TranscriptSource): Index {
	const groupOf = new Map<string, TGroup>();
	for (const g of src.groups) for (const id of g.memberIds) groupOf.set(id, g);
	const resultOf = new Map<string, number>();
	src.blocks.forEach((b, i) => {
		if (b.kind === "tool_result" && b.callId) resultOf.set(b.callId, i);
	});
	return { src, groupOf, resultOf };
}

function blockTokens(blocks: readonly TBlock[]): Tokens {
	return blocks.reduce((out, b) => ({ full: out.full + b.full, live: out.live + b.live }), { full: 0, live: 0 });
}

/** Whether a position belongs to the task's actual working intervals. */
export function spanContains(span: TaskSpan, at: number): boolean {
	return span.intervals.some((r) => r.start <= at && at <= r.end);
}

/** A task's blocks, optionally excluding the actual intervals of its descendants. */
export function spanBlocks(src: TranscriptSource, span: TaskSpan, exclude: readonly TaskSpan[] = []): TBlock[] {
	return src.blocks.filter((_b, i) => spanContains(span, i) && !exclude.some((child) => spanContains(child, i)));
}

function userNode(ix: Index, b: TBlock, inTask = true): TNode {
	const verdict = ix.src.verdict(b.id);
	const folded = !!ix.groupOf.get(b.id)?.folded;
	return { type: "user", block: b, verdict, folded, why: userReason(verdict, folded, ix.src.threshold, inTask) };
}

/** A logical task and its nearest present descendants. */
export interface TaskBranch {
	span: TaskSpan;
	children: TaskBranch[];
}

/** Logical ancestry by task key; siblings remain in transcript order even across pauses. */
export function taskForest(spans: readonly TaskSpan[]): TaskBranch[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
	const nodes = new Map(sorted.map((span) => [span.key, { span, children: [] as TaskBranch[] }]));
	const roots: TaskBranch[] = [];
	for (const span of sorted) {
		let key = span.key;
		let parent: TaskBranch | undefined;
		while (key.includes(".") && !parent) { key = key.slice(0, key.lastIndexOf(".")); parent = nodes.get(key); }
		(parent ? parent.children : roots).push(nodes.get(span.key)!);
	}
	return roots;
}

function branchSpans(branches: readonly TaskBranch[]): TaskSpan[] {
	return branches.flatMap((b) => [b.span, ...branchSpans(b.children)]);
}

function taskNode(ix: Index, f: TaskBranch): TNode {
	const { span } = f;
	const kids = f.children;
	const children: { at: number; node: TNode }[] = kids.map((child) => ({ at: child.span.start, node: taskNode(ix, child) }));
	const exclude = branchSpans(kids);
	for (let i = span.start; i <= span.end; i++) {
		const b = ix.src.blocks[i];
		if (b.kind === "user" && spanContains(span, i) && !exclude.some((child) => spanContains(child, i))) children.push({ at: i, node: userNode(ix, b) });
	}
	const folds = ix.src.groups.filter((g) => {
		if (!g.folded) return false;
		const key = taskKeyOfSummary(g.summary);
		return key === span.key || !!key?.startsWith(`${span.key}.`);
	}).length;
	return {
		type: "task", span,
		children: children.sort((a, b) => a.at - b.at).map((c) => c.node),
		tokens: spanTokens(ix.src, span), folds,
		subtasks: { done: kids.filter((c) => c.span.status === "done").length, total: kids.length },
	};
}

/**
 * The session as a task-centred tree: top-level tasks with their subtasks and user messages, user
 * messages between tasks, and runs of work that happened while no task was in progress.
 */
export function sessionTranscript(src: TranscriptSource): TNode[] {
	const ix = index(src);
	const spans = transcriptSpans(src);
	const roots = taskForest(spans);
	const covered = new Set(spans.flatMap((s) => s.intervals.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i))));
	const out: TNode[] = [];
	let run: TBlock[] = [];
	let runStart = -1;
	const flush = (end: number) => {
		if (run.length) out.push({ type: "untracked", blocks: run, calls: run.filter((b) => b.kind === "tool_call").length, tokens: blockTokens(src.blocks.slice(runStart, end + 1)) });
		run = [];
	};
	let r = 0;
	for (let i = 0; i < src.blocks.length; i++) {
		const root = roots[r];
		if (root && i === root.span.start) {
			flush(i - 1);
			out.push(taskNode(ix, root));
			r++;
		}
		if (covered.has(i)) { flush(i - 1); continue; }
		const b = src.blocks[i];
		if (b.kind === "system") continue;
		if (b.kind === "user") {
			flush(i - 1);
			out.push(userNode(ix, b, false));
			continue;
		}
		if (!run.length) runStart = i;
		run.push(b);
	}
	flush(src.blocks.length - 1);
	return out;
}

/** Additive outgoing charges of the task's real intervals, excluding paused-period work. */
export function spanTokens(src: TranscriptSource, span: TaskSpan): Tokens {
	const ids = new Set(spanBlocks(src, span).map((b) => b.id));
	for (const p of src.projection) if (p.groupId && taskKeyOfSummary(src.groups.find((g) => g.id === p.groupId)?.summary) === span.key)
		for (const b of p.members) ids.add(b.id);
	return blockTokens(src.blocks.filter((b) => ids.has(b.id)));
}

/** The classifier's view of a user message, rebuilt the way Taskfold builds it; null for the opening message. */
export function classifierInput(src: TranscriptSource, id: string): Record<string, string> | null {
	const all = src.blocks;
	const i = all.findIndex((b) => b.id === id);
	const users = all.slice(0, Math.max(0, i)).filter((b) => b.kind === "user");
	if (i < 0 || !users.length) return null;
	let j = i - 1;
	while (j >= 0 && all[j].kind !== "text") j--;
	const reply = j < 0 ? "" : all[j].text;
	return {
		session_goal: users[0].text.slice(0, 1500),
		previous_user_message: users.length > 1 ? users[users.length - 1].text.slice(0, 600) : "",
		assistant_last_reply: reply.slice(-600),
		message: all[i].text.slice(0, 2000),
	};
}

/** A tool call with its result, or a single block. */
function stepNode(ix: Index, b: TBlock, consumed: Set<number>, allowed: ReadonlySet<number>): TNode {
	const ri = b.kind === "tool_call" && b.callId ? ix.resultOf.get(b.callId) : undefined;
	const result = ri !== undefined && allowed.has(ri) ? ix.src.blocks[ri] : null;
	if (ri !== undefined && result) consumed.add(ri);
	const tokens = { full: b.full + (result?.full ?? 0), live: b.live + (result?.live ?? 0) };
	return { type: "step", block: b, result, tokens, folded: !!ix.groupOf.get(b.id)?.folded };
}

/** The call block of a tool result inside `lo..hi`, by call id. */
function callIndex(src: TranscriptSource, resultAt: number, lo: number): number {
	const id = src.blocks[resultAt]?.callId;
	for (let i = resultAt - 1; i >= lo; i--) if (src.blocks[i].kind === "tool_call" && src.blocks[i].callId === id) return i;
	return -1;
}

/**
 * One span from its start to its finish: the start edge, then direct subtasks (as task nodes), folds
 * (holding their members), kept user messages and unfolded steps in order, then the finish edge for a
 * finished span. A fold belonging to this span or an ancestor wins over a subtask it covers.
 */
export function spanTranscript(src: TranscriptSource, span: TaskSpan): TNode[] {
	const ix = index(src);
	const all = transcriptSpans(src);
	const descendants = all.filter((s) => s.key.startsWith(`${span.key}.`));
	const children = taskForest(descendants);
	const allowed = new Set(span.intervals.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i)));
	const hidden = new Set<number>();
	const consumed = new Set<number>();
	const startResult = src.blocks[span.start]?.callId ? ix.resultOf.get(src.blocks[span.start].callId!) : undefined;
	const ownStart = !children.some((c) => c.span.start === span.start);
	if (ownStart) {
		consumed.add(span.start);
		if (startResult !== undefined) consumed.add(startResult);
	}
	const finishBlock = src.blocks[span.end];
	const explicitFinish = !!span.status && finishBlock?.kind === "tool_result" && finishBlock.toolName === "tasks";
	if (explicitFinish) {
		consumed.add(span.end);
		const ci = callIndex(src, span.end, span.start);
		if (ci >= 0) consumed.add(ci);
	}
	const out: TNode[] = [{ type: "edge", edge: "start", span, block: src.blocks[span.start] }];
	const folds = new Map<string, TNode & { type: "fold" }>();
	let k = 0;
	const lo = Math.min(span.start, ...descendants.map((s) => s.start));
	const hi = Math.max(span.end, ...descendants.map((s) => s.end));
	for (let i = lo; i <= hi; i++) {
		const b = src.blocks[i];
		const g = ix.groupOf.get(b.id);
		const gKey = g?.folded ? taskKeyOfSummary(g.summary) : null;
		const child = children[k];
		if (child && i === child.span.start && !(g?.folded && !(gKey && gKey.startsWith(child.span.key)))) {
			out.push(taskNode(ix, child));
			for (const s of descendants.filter((s) => s.key === child.span.key || s.key.startsWith(`${child.span.key}.`)))
				for (const r of s.intervals) for (let j = r.start; j <= r.end; j++) hidden.add(j);
			k++;
			continue;
		}
		while (children[k] && children[k].span.end < i) k++;
		if (!allowed.has(i) || hidden.has(i) || consumed.has(i)) continue;
		const node = b.kind === "user" ? userNode(ix, b) : stepNode(ix, b, consumed, allowed);
		if (g?.folded) {
			let fold = folds.get(g.id);
			if (!fold) {
				fold = { type: "fold", group: g, code: codeOf(g.summary), key: gKey, level: recordLevel(g.summary), children: [] };
				folds.set(g.id, fold);
				out.push(fold);
			}
			fold.children.push(node);
		} else out.push(node);
	}
	if (span.status) out.push({ type: "edge", edge: "finish", span, block: finishBlock });
	return out;
}
