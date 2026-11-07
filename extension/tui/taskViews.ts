/*
 * taskViews.ts — the task-centred inspection screens: a list's task tree, one task's details, one
 * span's transcript (folds, kept user messages, steps), the whole session by task, and a text viewer.
 * Node building is pure (`*Nodes`); `TaskViews` holds the screen stack and applies actions through
 * the host, which enforces the controller lease.
 */
import { decodeKittyPrintable, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { foldCode, wireFoldable } from "../../core/digest";
import type { ClampReason, Op } from "../../core/ops";
import type { Truth } from "../../core/truth";
import { recordFacts, type TaskSpan } from "../../conductors/in-process/taskfold/taskfold";
import type { Verdict } from "../../conductors/in-process/taskfold/verdicts";
import { blockLabel, type Task, type TaskList } from "../tasks";
import type { PinHolder } from "../taskPins";
import { formatCompactTokens } from "./map";
import { frame } from "./taskLists";
import { classifierInput, recordLevel, sessionTranscript, spanBlocks, spanTokens, taskFoldRefs, spanTranscript, transcriptSource, transcriptSpans, type TBlock, type TNode, type Tokens, type TranscriptSource } from "./taskTranscript";
import { buildTaskTree, glyphState, taskDuration, type TaskNode } from "./taskTree";
import { GLYPH, foldedTaskTokens, formatDuration, glyphColor, taskNote, taskParts, type FoldTokens, type WidgetTheme } from "./taskWidget";
import { TreeState, type TreeNode } from "./treeView";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
const firstLine = (text: string, max = 80) => {
	const t = clean(text.split("\n").find((l) => l.trim()) ?? "").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const tok = (t: Tokens) => (t.full === t.live ? formatCompactTokens(t.full) : `${formatCompactTokens(t.full)} → ${formatCompactTokens(t.live)}`);
const LEVEL = ["record", "one line", "stub"] as const;

/** `09:58:12`, or `04.11. 09:58` for another day, local time. */
export function formatClock(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "–";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "–";
	const time = d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" })} ${time.slice(0, 5)}`;
}

const REASONS: Partial<Record<ClampReason, string>> = {
	protected: "inside the protected working tail",
	"not-foldable": "this kind of block folds only inside a group",
	bolted: "the system prompt never folds",
	locked: "the attached conductor locks this control",
	grouped: "part of a folded group; select the fold and press u",
	"human-override": "a human override owns it",
	"unknown-id": "no longer in the context",
	"non-durable": "it has no durable id yet",
};

/** A refusal in words, each reason once: `Refused: inside the protected working tail`. */
export function refusalMessage(reasons: readonly string[]): string {
	const words = [...new Set(reasons.map((r) => REASONS[r as ClampReason] ?? r))];
	return words.length ? `Refused: ${words.join("; ")}` : "Applied.";
}

/** What a tree node points at. */
export type ViewRef =
	| { type: "task"; slug: string; id: string; key: string }
	| { type: "fold"; groupId: string }
	| { type: "user"; id: string }
	| { type: "step"; id: string; resultId: string | null }
	| { type: "untracked"; answer?: boolean }
	| { type: "edge"; edge: "start" | "finish"; key: string };

/** What the screens need from the extension. */
export interface TaskViewsHost {
	truth(): Truth | null;
	verdict(id: string): Verdict | undefined;
	threshold(): number | null;
	lists(): TaskList[];
	invalid?(): readonly string[];
	folding?(): boolean;
	/** Whether this panel may change the context; actions are refused otherwise. */
	canSteer(): boolean;
	/** Apply ops through the controller; resolves to a status message. */
	apply(ops: Op[]): Promise<string>;
	subscribe(listener: () => void): () => void;
}

/** The inputs every node builder shares. */
export interface ViewData {
	src: TranscriptSource | null;
	spans: TaskSpan[];
	theme: WidgetTheme;
	now: number;
}

function spanOf(data: ViewData, key: string): TaskSpan | undefined {
	// The newest span wins when a task key ran twice (a re-created list).
	return [...data.spans].reverse().find((s) => s.key === key);
}

/** A task that ended or waits without ever having been started has no span. */
function neverRan(t: Task): boolean {
	return !t.startedAt && t.status !== "doing";
}

function taskLabel(t: Task, state: ReturnType<typeof glyphState>, theme: WidgetTheme): string {
	const { head, title } = taskParts(t, state, theme);
	return head + title;
}

/** A list's tasks as a tree: progress, time, folds and span tokens when the span ran in this session. */
export function listNodes(list: TaskList, truth: Truth | null, data: ViewData, folds: ReadonlyMap<string, FoldTokens> = truth ? foldedTaskTokens(list, truth) : new Map()): TreeNode<ViewRef>[] {
	const t = data.theme;
	const build = (n: TaskNode): TreeNode<ViewRef> => {
		const task = n.task;
		const key = `${list.slug}/${task.id}`;
		const span = data.src ? spanOf(data, key) : undefined;
		const done = n.children.filter((c) => c.task.status === "done").length;
		const ms = taskDuration(task, data.now);
		const own = folds.get(task.id);
		const inner = [...folds.entries()].filter(([id, f]) => id.startsWith(`${task.id}.`) && f.complete !== false);
		const note = taskNote(task);
		const meta = [
			note ? t.fg(task.status === "blocked" ? "warning" : "dim", note) : "",
			n.children.length ? `${done}/${n.children.length}` : "",
			ms !== null ? formatDuration(ms) : "",
			own && own.complete !== false ? t.fg("muted", "≡") : inner.length ? t.fg("muted", `≡${inner.length}`) : "",
			task.autoClosed ? t.fg("dim", "closed automatically") : "",
		].filter(Boolean);
		return {
			key,
			label: taskLabel(task, glyphState(n), t),
			meta,
			right: span && data.src ? t.fg("muted", tok(spanTokens(data.src, span))) : own ? t.fg("muted", tok(own)) : undefined,
			open: task.status === "doing" || task.status === "todo" || task.status === "blocked",
			children: n.children.map(build),
			data: { type: "task", slug: list.slug, id: task.id, key },
			text: `${task.id} ${task.title}`,
		};
	};
	return buildTaskTree(list.tasks).map(build);
}

function stepTarget(b: TBlock): string {
	const space = b.text.indexOf(" ");
	try {
		const args = JSON.parse(b.text.slice(space + 1)) as Record<string, unknown>;
		for (const k of ["path", "command", "action", "query", "url", "pattern", "codes"]) {
			const v = args[k];
			if (typeof v === "string") return firstLine(v, 60);
			if (Array.isArray(v)) return firstLine(v.join(", "), 60);
		}
	} catch {
		/* not JSON arguments */
	}
	return firstLine(b.text.slice(space + 1), 60);
}

/** Pinned, folded or in the tail, for one block or a call with its result. */
function blockState(theme: WidgetTheme, ...blocks: (TBlock | null)[]): string {
	const bs = blocks.filter((b): b is TBlock => !!b);
	if (bs.some((b) => b.pinned)) return theme.fg("accent", "pinned");
	if (bs.some((b) => b.folded)) return theme.fg("dim", "folded");
	return bs.some((b) => b.protected) ? theme.fg("dim", "tail") : "";
}

/** Nodes for transcript nodes; `keyBase` keeps keys unique per screen. */
export function transcriptNodes(nodes: readonly TNode[], data: ViewData, keyBase = ""): TreeNode<ViewRef>[] {
	const t = data.theme;
	const out: TreeNode<ViewRef>[] = [];
	for (const n of nodes) {
		if (n.type === "task") {
			const s = n.span;
			const state = s.status ?? "active";
			out.push({
				key: `${keyBase}task:${s.key}`,
				label: (({ head, title }) => head + title)(taskParts({ id: s.id, title: s.title, status: "doing", updatedAt: "" }, state, t)),
				meta: [n.subtasks.total ? `${n.subtasks.done}/${n.subtasks.total}` : "", n.folds ? t.fg("muted", `≡${n.folds}`) : ""].filter(Boolean),
				right: t.fg("muted", tok(n.tokens)),
				children: transcriptNodes(n.children, data, `${keyBase}${s.key}>`),
				data: { type: "task", slug: s.list, id: s.id, key: s.key },
				text: `${s.id} ${s.title}`,
			});
		} else if (n.type === "user") {
			const kept = !n.folded;
			out.push({
				key: `${keyBase}user:${n.block.id}`,
				label: `${kept ? t.fg("accent", "●") : t.fg("dim", "○")} ${t.fg("muted", "U")} "${firstLine(n.block.text, 60)}"`,
				meta: [kept ? "kept" : t.fg("dim", "folded"), t.fg("dim", n.why), blockState(t, n.block)].filter(Boolean),
				right: t.fg("dim", formatCompactTokens(n.block.full)),
				data: { type: "user", id: n.block.id },
				text: n.block.text.slice(0, 400),
			});
		} else if (n.type === "untracked" && n.calls === 0) {
			// Plain replies between tasks are normal, not protocol misses.
			const answer = n.blocks.find((b) => b.kind === "text") ?? n.blocks[0];
			out.push({
				key: `${keyBase}answer:${n.blocks[0].id}`,
				label: `${t.fg("muted", "A")} ${firstLine(answer.text, 70)}`,
				meta: [blockState(t, ...n.blocks)].filter(Boolean),
				right: t.fg("dim", tok(n.tokens)),
				children: n.blocks.length > 1 ? stepNodes(n.blocks, data, `${keyBase}a:${n.blocks[0].id}>`) : undefined,
				data: n.blocks.length > 1 ? { type: "untracked", answer: true } : { type: "step", id: answer.id, resultId: null },
				text: answer.text.slice(0, 200),
			});
		} else if (n.type === "untracked") {
			out.push({
				key: `${keyBase}untracked:${n.blocks[0].id}`,
				label: `${t.fg("warning", "⋯")} untracked · ${n.calls} call${n.calls === 1 ? "" : "s"}`,
				meta: [t.fg("warning", "▲ no task in progress")],
				right: t.fg("muted", tok(n.tokens)),
				children: stepNodes(n.blocks, data, `${keyBase}u:${n.blocks[0].id}>`),
				data: { type: "untracked" },
				text: "untracked",
			});
		} else if (n.type === "fold") {
			const level = n.level === null ? "fold" : LEVEL[n.level];
			out.push({
				key: `${keyBase}fold:${n.group.id}`,
				label: `${t.fg("muted", "≡")} ${t.fg("accent", n.code ? `{#${n.code}}` : n.group.id)} ${level}`,
				meta: [`${n.children.length} item${n.children.length === 1 ? "" : "s"}`],
				right: t.fg("muted", tok(n.group)),
				children: transcriptNodes(n.children, data, `${keyBase}${n.group.id}>`),
				data: { type: "fold", groupId: n.group.id },
				text: `${n.code ?? ""} ${n.key ?? ""} fold`,
			});
		} else if (n.type === "step") {
			out.push(stepNode(n.block, n.result, data, keyBase));
		} else {
			const s = n.span;
			out.push(
				n.edge === "start"
					? { key: `${keyBase}start`, label: `${t.fg("accent", "▸")} start  ${t.fg("muted", s.id)} "${clean(s.title)}"`, data: { type: "edge", edge: "start", key: s.key }, text: "start" }
					: {
							key: `${keyBase}finish`,
							label: `${t.fg(s.status === "done" ? "success" : "error", "■")} finish  ${s.status}`,
							meta: [s.report.outcome ? t.fg("dim", firstLine(s.report.outcome, 60)) : ""].filter(Boolean),
							data: { type: "edge", edge: "finish", key: s.key },
							text: `finish ${s.report.outcome ?? ""}`,
						},
			);
		}
	}
	return out;
}

function stepNode(b: TBlock, result: TBlock | null, data: ViewData, keyBase: string): TreeNode<ViewRef> {
	const t = data.theme;
	const failed = !!result?.isError;
	const label = b.kind === "tool_call" ? `${t.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${b.toolName ?? "tool"}  ${stepTarget(b)}` : `${t.fg("muted", b.kind === "text" ? "A" : b.kind === "thinking" ? "H" : "R")} ${firstLine(b.text, 60)}`;
	return {
		key: `${keyBase}step:${b.id}`,
		label,
		meta: [blockState(t, b, result)].filter(Boolean),
		right: t.fg("dim", tok({ full: b.full + (result?.full ?? 0), live: b.live + (result?.live ?? 0) })),
		data: { type: "step", id: b.id, resultId: result?.id ?? null },
		text: `${b.toolName ?? ""} ${b.text.slice(0, 200)}`,
	};
}

/** Calls paired with their results, other blocks on their own. */
function stepNodes(blocks: readonly TBlock[], data: ViewData, keyBase: string): TreeNode<ViewRef>[] {
	const results = new Map(blocks.filter((b) => b.kind === "tool_result" && b.callId).map((b) => [b.callId!, b]));
	const used = new Set<string>();
	const out: TreeNode<ViewRef>[] = [];
	for (const b of blocks) {
		if (used.has(b.id)) continue;
		const r = b.kind === "tool_call" && b.callId ? (results.get(b.callId) ?? null) : null;
		if (r) used.add(r.id);
		out.push(stepNode(b, r, data, keyBase));
	}
	return out;
}

function detailField(theme: WidgetTheme, key: string, value: string): string[] {
	return value.split("\n").map((line, i) => ` ${theme.fg("muted", (i ? "" : key).padEnd(10))} ${clean(line)}`);
}

function holderLines(holder: PinHolder, scope: string, theme: WidgetTheme): string[] {
	return [
		...(holder.pins ?? []).flatMap((pin) => detailField(theme, "Pins", `${scope} · ${pin.id} · ${pin.kind} · ${pin.source}\n${pin.text}`)),
		...(holder.attachments ?? []).flatMap((a) => detailField(theme, "Files", `${scope} · ${a.id} · ${a.path}${a.lines ? `:${a.lines}` : ""}${a.note ? ` · ${a.note}` : ""}\nhash ${a.hash ?? "not recorded"} · attached ${formatClock(a.at)}`)),
	];
}

/** A list's goal and scoped facts, available even before any task exists. */
export function listDetailLines(list: TaskList, theme: WidgetTheme): string[] {
	return [
		` ${theme.bold(clean(list.title))}`,
		...detailField(theme, "List", list.slug),
		...detailField(theme, "Goal", list.goal ?? "not set"),
		...detailField(theme, "Claim", list.claim ? `${list.claim.session}${list.claim.name ? ` · ${list.claim.name}` : ""}` : "unclaimed"),
		...holderLines(list, "list", theme),
	];
}

/** A task's lifecycle, scoped context, report and actual work in this session. */
export function detailLines(list: TaskList, id: string, data: ViewData, groups: readonly { id: string; summary: string | null | undefined; full: number; live: number; members: number; handleId?: string }[]): string[] {
	const t = data.theme;
	const task = list.tasks.find((x) => x.id === id);
	if (!task) return [t.fg("dim", ` Task ${id} no longer exists in "${list.slug}".`)];
	const roots = buildTaskTree(list.tasks);
	const find = (ns: TaskNode[]): TaskNode | undefined => ns.map((n) => (n.task.id === id ? n : find(n.children))).find(Boolean);
	const node = find(roots)!;
	const siblings = node.parent ? node.parent.children : roots;
	const label = (k: string) => t.fg("muted", k.padEnd(10));
	const wrap = (k: string, v: string) => [` ${label(k)} ${v}`];
	const items = (k: string, xs: readonly string[] | undefined) => (xs?.length ? xs.map((x, i) => ` ${label(i ? "" : k)} · ${clean(x)}`) : [` ${label(k)} ${t.fg("dim", "–")}`]);
	const lines = [` ${taskLabel(task, glyphState(node), t)}`, ...detailField(t, "Goal", list.goal ?? "not set")];
	lines.push(...items("Criteria", task.acceptanceCriteria), ...holderLines(list, "list", t));
	for (const parent of list.tasks.filter((p) => task.id.startsWith(`${p.id}.`))) lines.push(...holderLines(parent, `parent ${parent.id}`, t));
	lines.push(...holderLines(task, `task ${task.id}`, t));
	const done = node.children.filter((c) => c.task.status === "done").length;
	lines.push(
		...wrap(
			"Task",
			[node.parent ? `parent ${node.parent.task.id}` : "top level", `${siblings.indexOf(node) + 1} of ${siblings.length}`, node.children.length ? `${done}/${node.children.length} subtasks done` : "no subtasks"].join(" · "),
		),
	);
	const waited = task.createdAt && task.startedAt ? ` · waited ${formatDuration(Date.parse(task.startedAt) - Date.parse(task.createdAt))} before starting` : "";
	lines.push(...wrap("Planned", `${formatClock(task.createdAt, data.now)}${waited}`));
	const ms = taskDuration(task, data.now);
	lines.push(
		...wrap(
			"Ran",
			task.startedAt ? `${formatClock(task.startedAt, data.now)} → ${task.endedAt ? formatClock(task.endedAt, data.now) : "now"}${ms !== null ? ` · ${formatDuration(ms)}` : ""} · ${task.status}${task.autoClosed ? " (closed automatically)" : ""}` : `not started · ${task.status}`,
		),
	);
	for (const b of task.blocks ?? [])
		lines.push(
			...wrap(
				b.resumedAt ? "Paused" : "Blocked",
				`${blockLabel(b)} — ${clean(b.detail)} · ${formatClock(b.at, data.now)}${b.resumedAt ? ` → ${formatClock(b.resumedAt, data.now)}` : ` · ${formatDuration(Math.max(0, data.now - Date.parse(b.at)))} so far`}`,
			),
		);
	if (task.supersededBy) lines.push(...wrap("Superseded", `by ${task.supersededBy}`));
	const replaces = list.tasks.filter((x) => x.supersededBy === task.id).map((x) => x.id);
	if (replaces.length) lines.push(...wrap("Replaces", replaces.join(", ")));
	lines.push(...wrap("Outcome", task.report?.outcome ? clean(task.report.outcome) : t.fg("dim", "–")));
	lines.push(...items("Decisions", task.report?.decisions), ...items("Open", task.report?.open));
	const span = data.src ? spanOf(data, `${list.slug}/${id}`) : undefined;
	if (span && data.src) {
		const descendants = data.spans.filter((s) => s.key.startsWith(`${span.key}.`));
		const facts = recordFacts(spanBlocks(data.src, span, descendants), (b) => b.text);
		lines.push(...wrap("Changed", facts.changed.length ? facts.changed.join(", ") : t.fg("dim", "–")), ...items("Checks", facts.verified));
		lines.push(...wrap("Span", `${spanBlocks(data.src, span).length} blocks · ${tok(spanTokens(data.src, span))}`));
	} else lines.push(...wrap("Span", t.fg("dim", neverRan(task) ? "none · never started" : "not run in this session")));
	for (const g of groups) {
		const code = g.handleId ? foldCode(g.handleId) : /^\{#([0-9a-z]{6}) FOLDED\}/.exec(g.summary ?? "")?.[1];
		const level = recordLevel(g.summary);
		const pct = g.full > 0 ? ` (−${Math.round(((g.full - g.live) / g.full) * 100)}%)` : "";
		lines.push(...wrap("Fold", `${code ? `{#${code}}` : g.id} · ${level === null ? "fold" : LEVEL[level]} · ${g.members} blocks${g.handleId ? " · shared record" : ""} · ${formatCompactTokens(g.full)} → ${formatCompactTokens(g.live)}${pct}`));
	}
	return lines;
}

/** Wrap a detail line so continuation lines start under the value column. */
function hang(line: string, width: number): string[] {
	const indent = 12;
	if (width <= indent + 10) return wrapTextWithAnsi(line, Math.max(1, width));
	const [first, ...rest] = wrapTextWithAnsi(line, width);
	if (!rest.length) return [first];
	return [first, ...wrapTextWithAnsi(rest.join(" "), width - indent).map((l) => `${" ".repeat(indent)}${l}`)];
}

interface Keys {
	matches(data: string, binding: string): boolean;
}

type TreeScreen = { kind: "list"; slug: string; tree: TreeState<ViewRef> } | { kind: "span"; key: string; tree: TreeState<ViewRef> } | { kind: "session"; tree: TreeState<ViewRef>; show: "all" | "tasks" | "untracked" };
type Screen = TreeScreen | { kind: "details"; slug: string; id: string; scroll: number } | { kind: "list-details"; slug: string; scroll: number } | { kind: "text"; title: string; main: string[]; alt: string[] | null; altLabel: string; showAlt: boolean; scroll: number };

/** Where the screens open. */
export type TaskViewsStart = { kind: "list"; slug: string } | { kind: "session" };

/** The task inspection screens; Esc on the first screen calls `done`. */
export class TaskViews {
	private stack: Screen[];
	private message = "";
	private cache: { truth: Truth; rev: number; folding: boolean; data: { src: TranscriptSource; spans: TaskSpan[] } } | null = null;
	private listsSnapshot: TaskList[] = [];
	private invalidLists: readonly string[] = [];
	private byBlock = new Map<string, TBlock>();
	private foldCache = new Map<string, ReadonlyMap<string, FoldTokens>>();
	private recordCache = new Map<string, ReturnType<TaskViews["computeGroups"]>>();
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: WidgetTheme,
		private readonly keys: Keys,
		private readonly host: TaskViewsHost,
		start: TaskViewsStart,
		private readonly done: () => void,
		private readonly rows: () => number,
	) {
		this.stack = [start.kind === "list" ? { kind: "list", slug: start.slug, tree: new TreeState() } : { kind: "session", tree: new TreeState(), show: "all" }];
		this.refresh();
		this.unsubscribe = host.subscribe(() => this.requestRender());
	}

	/** True while only the first screen is open (the list browser handles its own keys then). */
	get atRoot(): boolean {
		return this.stack.length === 1 && !this.filtering;
	}

	private get top(): Screen {
		return this.stack[this.stack.length - 1];
	}

	private get filtering(): boolean {
		const s = this.top;
		return "tree" in s && s.tree.filtering;
	}

	private refresh(): void {
		const lists = this.host.lists(), previousLists = this.listsSnapshot;
		this.listsSnapshot = lists;
		this.invalidLists = this.host.invalid?.() ?? [];
		const truth = this.host.truth();
		const folding = this.host.folding?.() ?? true;
		const changed = !truth || this.cache?.truth !== truth || this.cache.rev !== truth.rev || this.cache.folding !== folding;
		if (!truth) { this.cache = null; this.byBlock.clear(); }
		else if (changed) {
			const src = transcriptSource(truth, (id) => this.host.verdict(id), this.host.threshold(), { folding, lists, listIssues: this.invalidLists });
			this.cache = { truth, rev: truth.rev, folding, data: { src, spans: transcriptSpans(src) } };
			this.byBlock = new Map(src.blocks.map((b) => [b.id, b]));
		}
		if (changed || lists !== previousLists) {
			this.foldCache.clear();
			this.recordCache.clear();
			const root = this.stack[0];
			const list = root.kind === "list" ? this.list(root.slug) : undefined;
			if (list && truth) this.foldCache.set(list.slug, foldedTaskTokens(list, truth));
		}
		const top = this.top;
		if (top.kind === "details") {
			const key = `${top.slug}/${top.id}`;
			if (!this.recordCache.has(key)) this.recordCache.set(key, this.computeGroups(key));
		}
	}

	private requestRender(): void { this.refresh(); this.tui.requestRender(); }

	private data(): ViewData {
		const src = this.cache ? { ...this.cache.data.src, lists: this.listsSnapshot, listIssues: this.invalidLists,
			verdict: (id: string) => this.host.verdict(id), threshold: this.host.threshold() } : null;
		return { src, spans: this.cache?.data.spans ?? [], theme: this.theme, now: Date.now() };
	}

	private list(slug: string): TaskList | undefined {
		return this.listsSnapshot.find((l) => l.slug === slug);
	}

	private nodes(s: TreeScreen, data: ViewData): TreeNode<ViewRef>[] {
		if (s.kind === "list") {
			const list = this.list(s.slug);
			return list ? listNodes(list, this.cache?.truth ?? null, data, this.foldCache.get(list.slug) ?? new Map()) : [];
		}
		if (!data.src) return [];
		if (s.kind === "span") {
			const span = spanOf(data, s.key);
			return span ? transcriptNodes(spanTranscript(data.src, span), data) : [];
		}
		const all = transcriptNodes(sessionTranscript(data.src), data);
		const kinds = all.filter((n) => n.data && (s.show === "all" || (s.show === "tasks" ? n.data.type === "task" : n.data.type === "untracked" && !n.data.answer)));
		return kinds;
	}

	private computeGroups(key: string): { id: string; summary: string | null | undefined; full: number; live: number; members: number; handleId?: string }[] {
		const truth = this.host.truth();
		if (!truth) return [];
		const blocks = this.byBlock;
		return taskFoldRefs(truth, key).filter((ref) => ref.group.folded).map((ref) => {
			const tokens = ref.memberIds.reduce((n, id) => ({ full: n.full + (blocks.get(id)?.full ?? 0), live: n.live + (blocks.get(id)?.live ?? 0) }), { full: 0, live: 0 });
			return { id: ref.group.id, summary: ref.group.digest, ...tokens, members: ref.memberIds.length, ...(ref.handleId ? { handleId: ref.handleId } : {}) };
		});
	}

	private groupsOf(key: string): ReturnType<TaskViews["computeGroups"]> { return this.recordCache.get(key) ?? []; }

	render(width: number): string[] {
		const t = this.theme;
		const data = this.data();
		const height = Math.max(4, Math.min(30, this.rows() - 8));
		const s = this.top;
		const crumbs = this.stack.map((x) => (x.kind === "list" ? x.slug : x.kind === "span" ? `${x.key.split("/").pop()} span` : x.kind === "session" ? "Tasks tree" : x.kind === "details" ? x.id : x.kind === "list-details" ? "list context" : x.title));
		const title = `Accordion${this.cache?.folding === false ? " (folding paused)" : ""} › ${this.stack[0].kind === "list" ? "Task lists › " : ""}${crumbs.join(" › ")}`;
		if (s.kind === "details" || s.kind === "list-details") {
			const list = this.list(s.slug);
			const lines = list ? (s.kind === "list-details" ? listDetailLines(list, t) : detailLines(list, s.id, data, this.groupsOf(`${s.slug}/${s.id}`))).flatMap((l) => hang(l, width)) : [t.fg("warning", this.invalidLists.includes(s.slug) ? ` "${s.slug}" is invalid; use tasks status for validation errors.` : ` "${s.slug}" no longer exists.`)];
			s.scroll = Math.max(0, Math.min(s.scroll, lines.length - height));
			const span = s.kind === "details" && data.src ? spanOf(data, `${s.slug}/${s.id}`) : undefined;
			const hints = [span ? "enter span" : "", "esc back", s.kind === "details" && this.groupsOf(`${s.slug}/${s.id}`).length ? "v record · u unfold" : "", s.kind === "details" ? "g list context" : "", "↑↓ scroll"].filter(Boolean).join(" · ");
			return frame(title, lines.slice(s.scroll, s.scroll + height), this.message, hints, width, t);
		}
		if (s.kind === "text") {
			const src = s.showAlt && s.alt ? s.alt : s.main;
			const lines = src.flatMap((l) => wrapTextWithAnsi(clean(l), Math.max(1, width - 1)).map((x) => ` ${x}`));
			s.scroll = Math.max(0, Math.min(s.scroll, lines.length - height));
			const pos = `${Math.min(lines.length, s.scroll + 1)}-${Math.min(lines.length, s.scroll + height)}/${lines.length}`;
			const hints = ["esc back", s.alt ? `v ${s.showAlt ? "back" : s.altLabel}` : "", "↑↓ pgup/pgdn scroll", pos].filter(Boolean).join(" · ");
			return frame(title, lines.slice(s.scroll, s.scroll + height), this.message, hints, width, t);
		}
		const nodes = this.nodes(s, data);
		const body = s.tree.render(nodes, width, height, (x) => t.fg("accent", x), (x) => t.fg("dim", x));
		if (!nodes.length) body.push(t.fg("dim", s.kind === "list" ? this.invalidLists.includes(s.slug) ? "   Invalid task list; use tasks status for validation errors." : this.list(s.slug) ? "   This list has no tasks." : "   This task list no longer exists." : data.src ? "   Nothing ran in this session yet." : "   No session context yet."));
		const filter = s.tree.filtering || s.tree.query ? ` ⌕ ${s.tree.query}${s.tree.filtering ? "█" : ""}` : "";
		const show = s.kind === "session" && s.show !== "all" ? ` · showing ${s.show}` : "";
		const status = this.message || `${s.tree.position()}${show}${filter}`;
		return frame(title, body, status, this.hints(s, width), width, t);
	}

	private hints(s: TreeScreen, width: number): string {
		if (s.kind === "list" && width < 60 && !s.tree.filtering) return "enter details · g context · ? · esc";
		if (s.tree.filtering) return "type to filter · enter keep · esc clear";
		const ref = s.tree.current?.node.data;
		const act = ref?.type === "fold" ? "u unfold/fold" : ref?.type === "step" || ref?.type === "user" ? "f fold · p pin" : ref?.type === "task" ? "u unfold/fold" : "";
		const enter = ref?.type === "task" ? (s.kind === "list" ? "enter details · i span" : "enter span") : ref?.type === "untracked" ? "→ expand" : ref ? "enter open" : "";
		const esc = this.stack.length > 1 || s.kind === "list" ? "esc back" : "esc close";
		// Most needed first: narrow widths cut from the end.
		return [enter, esc, act, "→← expand", "/ filter", s.kind === "list" ? "g list context · ? legend" : "", s.kind === "session" ? "t show" : ""].filter(Boolean).join(" · ");
	}

	handleInput(input: string): void {
		const k = this.keys;
		const cancel = k.matches(input, "tui.select.cancel") || matchesKey(input, "ctrl+c");
		const confirm = k.matches(input, "tui.select.confirm");
		const up = k.matches(input, "tui.select.up");
		const down = k.matches(input, "tui.select.down");
		const key = decodeKittyPrintable(input) ?? input;
		const s = this.top;
		if (matchesKey(input, "ctrl+c")) return this.done();
		if ("tree" in s && s.tree.filtering) {
			if (cancel) {
				s.tree.query = "";
				s.tree.filtering = false;
			} else if (confirm) s.tree.filtering = false;
			else if (matchesKey(input, "backspace")) s.tree.query = s.tree.query.slice(0, -1);
			else if (up) s.tree.move(-1);
			else if (down) s.tree.move(1);
			else if (key.length === 1 && key >= " " && key !== "\x7f") s.tree.query += key;
			return this.requestRender();
		}
		this.message = "";
		if (cancel) {
			if ("tree" in s && s.tree.query) s.tree.query = "";
			else if (this.stack.length > 1) this.stack.pop();
			else return this.done();
			return this.requestRender();
		}
		const page = Math.max(1, Math.min(30, this.rows() - 8) - 1);
		const scroll = (d: number) => {
			if (s.kind === "details" || s.kind === "list-details" || s.kind === "text") s.scroll = Math.max(0, s.scroll + d);
		};
		if (s.kind === "details" || s.kind === "list-details" || s.kind === "text") {
			if (up) scroll(-1);
			else if (down) scroll(1);
			else if (matchesKey(input, "pageUp")) scroll(-page);
			else if (matchesKey(input, "pageDown")) scroll(page);
			else if (s.kind === "text" && key === "v" && s.alt) {
				s.showAlt = !s.showAlt;
				s.scroll = 0;
			} else if (s.kind === "details") this.detailsKey(s, key, confirm);
			return this.requestRender();
		}
		const tree = s.tree;
		// Rows change with every open/close; rebuild them so a key never acts on a stale layout.
		tree.rows(this.nodes(s, this.data()));
		if (up) tree.move(-1);
		else if (down) tree.move(1);
		else if (matchesKey(input, "pageUp")) tree.move(-page);
		else if (matchesKey(input, "pageDown")) tree.move(page);
		else if (matchesKey(input, "right")) tree.right();
		else if (matchesKey(input, "left")) tree.left();
		else if (key === "/") tree.filtering = true;
		else if (key === "g" && s.kind === "list") this.stack.push({ kind: "list-details", slug: s.slug, scroll: 0 });
		else if (key === "?" && s.kind === "list") this.stack.push({ kind: "text", title: "task legend", main: ["▣ done    ☒ failed    ⊘ abandoned", "◐ partly done    ▶ doing    ⧗ blocked    ☐ todo", "≡ folded    · finished but raw    ! unfinished descendants", "g list context: goal, scoped pins and attachments", "p pins transcript blocks; scoped facts use tasks pin/unpin"], alt: null, altLabel: "", showAlt: false, scroll: 0 });
		else if (key === "t" && s.kind === "session") s.show = s.show === "all" ? "tasks" : s.show === "tasks" ? "untracked" : "all";
		else {
			const ref = tree.current?.node.data;
			if (ref) this.nodeKey(s, ref, key, confirm);
		}
		this.requestRender();
	}

	private noSpan(slug: string, id: string): string {
		const task = this.host.lists().find((l) => l.slug === slug)?.tasks.find((t) => t.id === id);
		return task && neverRan(task) ? "This task was never started, so it has no span." : "This task did not run in this session.";
	}

	private detailsKey(s: Extract<Screen, { kind: "details" }>, key: string, confirm: boolean): void {
		const data = this.data();
		const taskKey = `${s.slug}/${s.id}`;
		if (confirm) {
			if (data.src && spanOf(data, taskKey)) this.stack.push({ kind: "span", key: taskKey, tree: new TreeState() });
			else this.message = this.noSpan(s.slug, s.id);
		} else if (key === "v") {
			const groups = this.groupsOf(taskKey);
			if (!groups.length) this.message = "This task is not folded.";
			else this.pushTaskRecord(taskKey);
		} else if (key === "g") this.stack.push({ kind: "list-details", slug: s.slug, scroll: 0 });
		else if (key === "u" || key === "f") this.toggleTask(taskKey);
	}

	private nodeKey(s: TreeScreen, ref: ViewRef, key: string, confirm: boolean): void {
		const data = this.data();
		if (ref.type === "task") {
			if (confirm && s.kind === "list") this.stack.push({ kind: "details", slug: ref.slug, id: ref.id, scroll: 0 });
			else if ((confirm && s.kind !== "list") || key === "i") {
				if (data.src && spanOf(data, ref.key)) this.stack.push({ kind: "span", key: ref.key, tree: new TreeState() });
				else this.message = this.noSpan(ref.slug, ref.id);
			} else if (key === "d") this.stack.push({ kind: "details", slug: ref.slug, id: ref.id, scroll: 0 });
			else if (key === "u") this.toggleTask(ref.key);
			return;
		}
		if (ref.type === "untracked") {
			if (confirm) s.tree.toggle();
			return;
		}
		if (ref.type === "fold") {
			if (confirm) this.pushRecord([ref.groupId]);
			else if (key === "u") this.toggleGroups([ref.groupId]);
			return;
		}
		if (ref.type === "edge") {
			if (confirm && ref.edge === "finish") {
				const span = spanOf(data, ref.key);
				const r = span?.report;
				this.stack.push({ kind: "text", title: "report", main: [`outcome: ${r?.outcome ?? "–"}`, ...(r?.decisions ?? []).map((d) => `decision: ${d}`), ...(r?.open ?? []).map((o) => `open: ${o}`)], alt: null, altLabel: "", showAlt: false, scroll: 0 });
			} else if (confirm) this.message = "The span starts with this call.";
			return;
		}
		const ids = ref.type === "step" ? [ref.id, ...(ref.resultId ? [ref.resultId] : [])] : [ref.id];
		if (confirm) {
			if (ref.type === "user") this.pushUser(ref.id, data);
			else this.pushBlocks(ids, data);
		} else if (key === "f" || key === "p") this.toggleBlocks(ids, key);
	}

	private pushTaskRecord(key: string): void {
		const truth = this.host.truth();
		if (!truth) return;
		const refs = taskFoldRefs(truth, key).filter((r) => r.group.folded);
		this.pushRecord(refs.map((r) => r.group.id), refs.flatMap((r) => r.memberIds), key);
	}

	private pushRecord(groupIds: string[], memberIds?: readonly string[], taskKey?: string): void {
		const truth = this.host.truth();
		if (!truth) return;
		const groups = truth.groups.filter((g) => groupIds.includes(g.id));
		const main = groups.flatMap((g, i) => [...(i ? [""] : []), ...String(g.digest ?? "(default recap)").split("\n")]);
		const byId = new Map(truth.blocks.map((b) => [b.id, b]));
		const allowed = new Set(memberIds ?? groups.flatMap((g) => g.memberIds));
		const alt = truth.blocks.filter((b) => allowed.has(b.id)).flatMap(({ id }) => {
			const b = byId.get(id);
			return b ? [`── ${b.kind}${b.toolName ? ` ${b.toolName}` : ""} · ${b.id}`, ...b.text.split("\n")] : [];
		});
		this.stack.push({ kind: "text", title: taskKey ?? "fold", main: [...(taskKey ? [`Task ${taskKey} · ${foldCode(`t:${taskKey}`)}`, ""] : []), this.cache?.folding === false ? "Stored fold (folding paused):" : "As the agent sees it:", "", ...main], alt, altLabel: "original", showAlt: false, scroll: 0 });
	}

	private pushBlocks(ids: string[], data: ViewData): void {
		const blocks = ids.map((id) => data.src?.blocks.find((b) => b.id === id)).filter((b): b is TBlock => !!b);
		const main = blocks.flatMap((b, i) => [...(i ? [""] : []), `── ${b.kind}${b.toolName ? ` ${b.toolName}` : ""}${b.isError ? " · error" : ""} · ${formatCompactTokens(b.full)} tok`, ...b.text.split("\n")]);
		this.stack.push({ kind: "text", title: blocks[0]?.toolName ?? blocks[0]?.kind ?? "block", main, alt: null, altLabel: "", showAlt: false, scroll: 0 });
	}

	private pushUser(id: string, data: ViewData): void {
		const b = data.src?.blocks.find((x) => x.id === id);
		if (!b || !data.src) return;
		const v = this.host.verdict(id);
		const threshold = this.host.threshold();
		const verdict = !v
			? ["verdict: none (not classified while Taskfold was attached)"]
			: [
					`verdict: ${v.source}${v.loss != null ? ` · loss ${v.loss.toFixed(2)}${threshold != null ? ` (folds below ${threshold.toFixed(2)})` : ""}` : ""}${v.confidence != null ? ` · confidence ${v.confidence.toFixed(2)}` : ""}`,
					...Object.entries(v.answers ?? {}).map(([q, p]) => `  ${q}: ${p.toFixed(2)} (probability of yes)`),
					...(v.model ? [`model: ${v.model}${v.at ? ` · ${formatClock(v.at)}` : ""}`] : []),
				];
		const input = classifierInput(data.src, id);
		const shown = input ? ["", "classifier input:", ...Object.entries(input).flatMap(([k, val]) => [`  ${k}:`, ...(val ? val.split("\n").map((l) => `    ${l}`) : ["    (empty)"])])] : [];
		this.stack.push({ kind: "text", title: "user message", main: [...verdict, "", "message:", ...b.text.split("\n"), ...shown], alt: null, altLabel: "", showAlt: false, scroll: 0 });
	}

	private apply(ops: Op[]): void {
		if (!ops.length) return;
		if (!this.host.canSteer()) {
			this.message = "Read-only: another surface controls Accordion.";
			return;
		}
		this.message = "Applying…";
		void this.host.apply(ops).then(
			(m) => {
				this.message = m;
				this.requestRender();
			},
			(e) => {
				this.message = `Failed: ${e instanceof Error ? e.message : String(e)}`;
				this.requestRender();
			},
		);
	}

	private toggleGroups(groupIds: string[]): void {
		const truth = this.host.truth();
		const groups = truth?.groups.filter((g) => groupIds.includes(g.id)) ?? [];
		const fold = groups.some((g) => !g.folded);
		this.apply(groups.map((g) => ({ kind: fold ? "foldGroup" : "unfoldGroup", groupId: g.id }) as Op));
	}

	private toggleTask(key: string): void {
		const truth = this.host.truth();
		const refs = truth ? taskFoldRefs(truth, key) : [];
		if (!refs.length) {
			this.message = "This task has no fold yet; Taskfold folds it when the budget needs room.";
			return;
		}
		const unfold = refs.some((r) => r.group.folded);
		this.apply(refs.filter((r) => r.group.folded === unfold).map((r): Op => unfold
			? { kind: "unfoldGroup", groupId: r.group.id, ...(r.handleId ? { handleId: r.handleId } : {}) }
			: { kind: "foldGroup", groupId: r.group.id }));
	}

	private toggleBlocks(ids: string[], key: "f" | "p"): void {
		const truth = this.host.truth();
		const blocks = ids.map((id) => truth?.blocks.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b);
		if (!truth || !blocks.length) return;
		if (key === "p") {
			const pinned = blocks.every((b) => b.override === "pinned");
			return this.apply([{ kind: pinned ? "unpin" : "pin", ids }]);
		}
		const group = blocks.map((b) => truth.groupOf(b)).find((g) => g?.folded);
		if (group) {
			this.message = "Part of a fold: select the fold and press u.";
			return;
		}
		// A call folds through its result; user messages fold only inside a task record.
		const foldable = blocks.filter((b) => wireFoldable(b));
		if (!foldable.length) {
			this.message = blocks.some((b) => b.kind === "user") ? "User messages fold only inside a task record." : "Nothing here folds on its own.";
			return;
		}
		const folded = foldable.every((b) => truth.isFolded(b));
		this.apply([{ kind: folded ? "unfold" : "fold", ids: foldable.map((b) => b.id) }]);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}
