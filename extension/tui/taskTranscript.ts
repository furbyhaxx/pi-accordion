/*
 * taskTranscript.ts — the session transcript seen through its tasks: which blocks each task span holds,
 * how they were folded, and why user messages were kept or folded. Pure: the task views render it, and
 * `transcriptSource` adapts a Truth to its plain input.
 */
import type { Truth } from "../../core/truth";
import type { BlockKind } from "../../core/types";
import { scanTaskSpans, taskKeyOfSummary, type TaskSpan } from "../../conductors/in-process/taskfold/taskfold";
import type { Verdict } from "../../conductors/in-process/taskfold/verdicts";

/** A block as the transcript needs it; tokens are calibrated, `live` is what is sent now. */
export interface TBlock {
	id: string;
	kind: BlockKind;
	text: string;
	full: number;
	live: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	/** Folded on its own (not through a group). */
	folded?: boolean;
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
	full: number;
	live: number;
}

export interface TranscriptSource {
	blocks: readonly TBlock[];
	groups: readonly TGroup[];
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

/** Adapt a Truth to the transcript's input. */
export function transcriptSource(truth: Truth, verdict: (id: string) => Verdict | undefined, threshold: number | null): TranscriptSource {
	return {
		blocks: truth.blocks.map((b) => ({
			id: b.id,
			kind: b.kind,
			text: b.text,
			full: truth.calBlockTokens(b, b.tokens),
			live: truth.calBlockTokens(b, truth.effTokens(b)),
			...(b.toolName ? { toolName: b.toolName } : {}),
			...(b.callId ? { callId: b.callId } : {}),
			...(b.isError ? { isError: true } : {}),
			...(truth.isFolded(b) && !truth.groupOf(b)?.folded ? { folded: true } : {}),
			...(b.override === "pinned" ? { pinned: true } : {}),
			...(truth.isProtected(b) ? { protected: true } : {}),
		})),
		groups: truth.groups.map((g) => ({
			id: g.id,
			memberIds: g.memberIds,
			folded: g.folded,
			summary: g.digest,
			full: truth.calibratedGroupFullTokens(g),
			live: truth.calibratedGroupLiveTokens(g),
		})),
		verdict,
		threshold,
	};
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
	return /^\{#[0-9a-z]{6} FOLDED\} \[task-record\]/.test(summary!) && !summary!.includes("\n") ? 1 : 0;
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

/** Tokens of blocks `lo..hi`, a folded group counted once at its own size. */
function rangeTokens(ix: Index, lo: number, hi: number): Tokens {
	const out = { full: 0, live: 0 };
	const seen = new Set<string>();
	for (let i = lo; i <= hi; i++) {
		const b = ix.src.blocks[i];
		const g = ix.groupOf.get(b.id);
		if (g?.folded) {
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			out.full += g.full;
			out.live += g.live;
		} else {
			out.full += b.full;
			out.live += b.live;
		}
	}
	return out;
}

function userNode(ix: Index, b: TBlock, inTask = true): TNode {
	const verdict = ix.src.verdict(b.id);
	const folded = !!ix.groupOf.get(b.id)?.folded;
	return { type: "user", block: b, verdict, folded, why: userReason(verdict, folded, ix.src.threshold, inTask) };
}

/** Spans nested by containment; siblings in transcript order. */
function forest(spans: readonly TaskSpan[]): { span: TaskSpan; children: ReturnType<typeof forest> }[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
	const roots: { span: TaskSpan; children: ReturnType<typeof forest> }[] = [];
	const stack: { span: TaskSpan; children: ReturnType<typeof forest> }[] = [];
	for (const span of sorted) {
		while (stack.length && !(stack[stack.length - 1].span.start <= span.start && span.end <= stack[stack.length - 1].span.end)) stack.pop();
		const node = { span, children: [] as ReturnType<typeof forest> };
		(stack.length ? stack[stack.length - 1].children : roots).push(node);
		stack.push(node);
	}
	return roots;
}

function taskNode(ix: Index, f: { span: TaskSpan; children: ReturnType<typeof forest> }): TNode {
	const { span } = f;
	const children: TNode[] = [];
	const kids = f.children;
	let k = 0;
	for (let i = span.start; i <= span.end; i++) {
		const child = kids[k];
		if (child && i === child.span.start) {
			children.push(taskNode(ix, child));
			i = child.span.end;
			k++;
			continue;
		}
		const b = ix.src.blocks[i];
		if (b.kind === "user") children.push(userNode(ix, b));
	}
	const folds = ix.src.groups.filter((g) => {
		if (!g.folded) return false;
		const key = taskKeyOfSummary(g.summary);
		return key === span.key || !!key?.startsWith(`${span.key}.`);
	}).length;
	return {
		type: "task",
		span,
		children,
		tokens: rangeTokens(ix, span.start, span.end),
		folds,
		subtasks: { done: kids.filter((c) => c.span.status === "done").length, total: kids.length },
	};
}

/**
 * The session as a task-centred tree: top-level tasks with their subtasks and user messages, user
 * messages between tasks, and runs of work that happened while no task was in progress.
 */
export function sessionTranscript(src: TranscriptSource): TNode[] {
	const ix = index(src);
	const roots = forest(transcriptSpans(src));
	const out: TNode[] = [];
	let run: TBlock[] = [];
	let runStart = -1;
	const flush = (end: number) => {
		if (run.length) out.push({ type: "untracked", blocks: run, calls: run.filter((b) => b.kind === "tool_call").length, tokens: rangeTokens(ix, runStart, end) });
		run = [];
	};
	let r = 0;
	for (let i = 0; i < src.blocks.length; i++) {
		const root = roots[r];
		if (root && i === root.span.start) {
			flush(i - 1);
			out.push(taskNode(ix, root));
			i = root.span.end;
			r++;
			continue;
		}
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

/** Tokens of a span, a folded group counted once at its own size. */
export function spanTokens(src: TranscriptSource, span: TaskSpan): Tokens {
	return rangeTokens(index(src), span.start, span.end);
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
function stepNode(ix: Index, b: TBlock, consumed: Set<number>, lo: number, hi: number): TNode {
	const ri = b.kind === "tool_call" && b.callId ? ix.resultOf.get(b.callId) : undefined;
	const result = ri !== undefined && ri >= lo && ri <= hi ? ix.src.blocks[ri] : null;
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
	const children = forest(all.filter((s) => s !== span && s.key !== span.key && span.start <= s.start && s.end <= span.end));
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
	for (let i = span.start; i <= span.end; i++) {
		const b = src.blocks[i];
		const g = ix.groupOf.get(b.id);
		const gKey = g?.folded ? taskKeyOfSummary(g.summary) : null;
		const child = children[k];
		if (child && i === child.span.start && !(g?.folded && !(gKey && gKey.startsWith(child.span.key)))) {
			out.push(taskNode(ix, child));
			i = child.span.end;
			k++;
			continue;
		}
		while (children[k] && children[k].span.end < i) k++;
		if (consumed.has(i)) continue;
		const node = b.kind === "user" ? userNode(ix, b) : stepNode(ix, b, consumed, span.start, span.end);
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
