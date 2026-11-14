/*
 * taskViews.ts — the screens behind the panel's Tasks and Lists tabs: the project's lists, a list's
 * task tree, one task's details, one span's transcript (folds, kept user messages, steps), the whole
 * session by task, and a text viewer. Node building is pure (`*Nodes`); `TaskViews` holds the screen
 * stack and applies actions through the host, which enforces the controller lease.
 */
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { foldCode, wireFoldable } from "../../core/digest";
import type { ClampReason, Op } from "../../core/ops";
import type { Truth } from "../../core/truth";
import { recordFacts, staleSpans, type TaskSpan } from "../../conductors/in-process/taskfold/taskfold";
import type { Verdict } from "../../conductors/in-process/taskfold/verdicts";
import { blockLabel, claimState, type Task, type TaskList } from "../tasks";
import { holderLabel } from "../taskBinding";
import { attachmentRef, type PinHolder } from "../taskPins";
import { formatCompactTokens } from "./map";
import { bindingHint, type ChromeKeys, type ChromeTheme, type Hint, rawHint } from "./chrome";
import type { ConfirmSpec, TabView } from "./screens/types";
import { claimText, editText, formatAge, listRowLine, progressText, type TaskListsHost } from "./taskLists";
import { recordForm } from "../../conductors/in-process/taskfold/records";
import { classifierInput, sessionTranscript, spanBlocks, spanTokens, spanTokenIndex, taskFoldRefs, spanTranscript, transcriptSource, transcriptSpans, type TBlock, type TNode, type Tokens, type TranscriptSource } from "./taskTranscript";
import { buildTaskTree, glyphState, taskDuration, type TaskNode } from "./taskTree";
import { GLYPH, foldedTaskTokens, formatDuration, glyphColor, taskNote, taskParts, type FoldTokens, type WidgetTheme } from "./taskWidget";
import { TreeState, type TreeNode } from "./treeView";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
const firstLine = (text: string, max = 80) => {
	const t = clean(text.split("\n").find((l) => l.trim()) ?? "").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const tok = (t: Tokens) => (t.full === t.live ? formatCompactTokens(t.full) : `${formatCompactTokens(t.full)} → ${formatCompactTokens(t.live)}`);

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
	grouped: "part of a folded group; select the fold and use alt+f",
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
	/** `tasks.zombieSteps`; absent or 0 marks no task stale. */
	staleAfter?(): number;
	lists(): TaskList[];
	invalid?(): readonly string[];
	folding?(): boolean;
	/** Re-read the list files after this panel changed one. */
	rescan?(): void;
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
	charges?: ReadonlyMap<TaskSpan, Tokens>;
	/** Keys (`<list>/<id>`) of open tasks reported stale. */
	stale?: ReadonlySet<string>;
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
export function listNodes(list: TaskList, truth: Truth | null, data: ViewData, folds: ReadonlyMap<string, FoldTokens> = truth ? foldedTaskTokens(list, truth) : new Map(), durations?: ((now: number) => void)[]): TreeNode<ViewRef>[] {
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
		const stale = !!data.stale?.has(key);
		const meta = [
			stale ? t.fg("warning", "stale") : "",
			note ? t.fg(task.status === "blocked" ? "warning" : "dim", note) : "",
			n.children.length ? `${done}/${n.children.length}` : "",
			ms !== null ? formatDuration(ms) : "",
			own && own.complete !== false ? t.fg("muted", "≡") : inner.length ? t.fg("muted", `≡${inner.length}`) : "",
			task.autoClosed ? t.fg("dim", "closed automatically") : "",
			// the row drops meta from the end when narrow, so the stale flag leads
		].filter(Boolean);
		if (ms !== null && durations) {
			const at = (stale ? 1 : 0) + (note ? 1 : 0) + (n.children.length ? 1 : 0);
			durations.push((now) => { const elapsed = taskDuration(task, now); if (elapsed !== null) meta[at] = formatDuration(elapsed); });
		}
		return {
			key,
			label: taskLabel(task, glyphState(n), t),
			meta,
			right: span && data.src ? t.fg("muted", tok(data.charges?.get(span) ?? spanTokens(data.src, span))) : own ? t.fg("muted", tok(own)) : undefined,
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
				label: `${t.fg("muted", stepLetter(answer.kind))} ${firstLine(answer.text, 70)}`,
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
			const level = n.form ?? "fold";
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

/** The step marker of a non-call block: `A` reply, `H` thinking, `ext` extension message, `R` result. */
function stepLetter(kind: TBlock["kind"]): string {
	return kind === "text" ? "A" : kind === "thinking" ? "H" : kind === "custom" ? "ext" : "R";
}

function stepNode(b: TBlock, result: TBlock | null, data: ViewData, keyBase: string): TreeNode<ViewRef> {
	const t = data.theme;
	const failed = !!result?.isError;
	const label = b.kind === "tool_call" ? `${t.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${b.toolName ?? "tool"}  ${stepTarget(b)}` : `${t.fg("muted", stepLetter(b.kind))} ${firstLine(b.text, 60)}`;
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
		...(holder.attachments ?? []).flatMap((a) => detailField(theme, "Files", `${scope} · ${a.id} · ${attachmentRef(a)}${a.note ? ` · ${a.note}` : ""}\nhash ${a.hash ?? "not recorded"} · attached ${formatClock(a.at)}`)),
	];
}

/** One line per goal, labeled with its id, or "not set". */
function goalFields(theme: WidgetTheme, goals: readonly { id: string; text: string }[] | undefined, label = "Goals"): string[] {
	if (!goals?.length) return detailField(theme, label, "not set");
	return goals.flatMap((g, i) => detailField(theme, i ? "" : label, `${g.id} ${g.text}`));
}

/** A list's goals and scoped facts, available even before any task exists. */
export function listDetailLines(list: TaskList, theme: WidgetTheme): string[] {
	return [
		` ${theme.bold(clean(list.title))}`,
		...detailField(theme, "List", list.slug),
		...goalFields(theme, list.goals),
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
	const lines = [` ${taskLabel(task, glyphState(node), t)}`, ...goalFields(t, list.goals, "List goals")];
	if (task.goals?.length) lines.push(...goalFields(t, task.goals));
	lines.push(...items("Criteria", task.acceptanceCriteria?.map((c) => `${c.id} ${c.text}`)), ...holderLines(list, "list", t));
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
		const form = recordForm(g.summary);
		const pct = g.full > 0 ? ` (−${Math.round(((g.full - g.live) / g.full) * 100)}%)` : "";
		lines.push(...wrap("Fold", `${code ? `{#${code}}` : g.id} · ${form ?? "fold"} · ${g.members} blocks${g.handleId ? " · shared record" : ""} · ${formatCompactTokens(g.full)} → ${formatCompactTokens(g.live)}${pct}`));
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

/** What the screens need from the panel shell. */
export interface TaskViewsUi {
	theme(): WidgetTheme & ChromeTheme;
	keys(): ChromeKeys;
	/** Show a refusal (default) or a result until the next key. */
	say(text: string, level?: "info" | "warning" | "error"): void;
	confirm(spec: ConfirmSpec): void;
	update(): void;
}

type TreeScreen = { kind: "list"; slug: string; tree: TreeState<ViewRef> } | { kind: "span"; key: string; tree: TreeState<ViewRef> } | { kind: "session"; tree: TreeState<ViewRef>; show: "all" | "tasks" | "untracked" };
type ListsScreen = { kind: "lists"; slug: string | null; query: string; create: { title: string | null; input: { text: string } } | null };
type ScrollScreen = { kind: "details"; slug: string; id: string; scroll: number } | { kind: "list-details"; slug: string; scroll: number } | { kind: "text"; title: string; main: string[]; alt: string[] | null; altLabel: string; showAlt: boolean; scroll: number };
type Screen = TreeScreen | ListsScreen | ScrollScreen;

/** Where the screens open: the project's lists, one list, or this session by task. */
export type TaskViewsStart = { kind: "lists" } | { kind: "list"; slug: string } | { kind: "session" };

/** Legend lines for the help screen. */
export const TASK_LEGEND = [
	"▣ done    ☒ failed    ⊘ abandoned    ◐ partly done    ▶ doing    ⧗ blocked    ☐ todo",
	"≡ folded    · finished but raw    ! unfinished descendants",
	"Lists: ● attached to this session, ○ not. alt+a attaches, releases or takes over the selected list.",
	"alt+g shows a list's goals, claim, scoped pins and attachments.",
	"alt+p pins transcript blocks; scoped facts use the tasks tool's pin and unpin.",
	"A call folds through its result; user messages fold only inside a task record.",
	"alt+e expands or collapses the task widget above the editor by default.",
];

/** The task screens as one stack; the panel shell draws the frame and routes keys. */
export class TaskViews {
	private stack: Screen[];
	private stale = true;
	private rows = 10;
	private cache: { truth: Truth; rev: number; folding: boolean; steps: number; data: { src: TranscriptSource; spans: TaskSpan[]; stale: ReadonlySet<string>; charges: Map<TaskSpan, Tokens> } } | null = null;
	private listsSnapshot: TaskList[] = [];
	private invalidLists: readonly string[] = [];
	private byBlock = new Map<string, TBlock>();
	private foldCache = new Map<string, ReadonlyMap<string, FoldTokens>>();
	private recordCache = new Map<string, ReturnType<TaskViews["computeGroups"]>>();
	private nodeCache = new Map<string, { theme: WidgetTheme; nodes: TreeNode<ViewRef>[]; durations: ((now: number) => void)[] }>();
	private readonly unsubscribe: () => void;

	constructor(
		private readonly ui: TaskViewsUi,
		private readonly host: TaskViewsHost,
		start: TaskViewsStart,
		/** Store actions for the lists screen; without it lists are read-only. */
		private readonly listsHost: TaskListsHost | null = null,
	) {
		this.stack = [start.kind === "lists" ? { kind: "lists", slug: null, query: "", create: null } : start.kind === "list" ? { kind: "list", slug: start.slug, tree: new TreeState() } : { kind: "session", tree: new TreeState(), show: "all" }];
		this.unsubscribe = host.subscribe(() => {
			this.stale = true;
		});
	}

	private get top(): Screen {
		return this.stack[this.stack.length - 1];
	}

	/** Rebuild the cached transcript and list data once per change, never per frame. */
	private ensure(): void {
		if (this.stale) {
			this.stale = false;
			this.nodeCache.clear();
			const lists = this.host.lists(), previousLists = this.listsSnapshot;
			this.listsSnapshot = lists;
			this.invalidLists = this.host.invalid?.() ?? [];
			const truth = this.host.truth();
			const folding = this.host.folding?.() ?? true;
			const steps = this.host.staleAfter?.() ?? 0;
			const changed = !truth || this.cache?.truth !== truth || this.cache.rev !== truth.rev || this.cache.folding !== folding || this.cache.steps !== steps;
			if (!truth) {
				this.cache = null;
				this.byBlock.clear();
			} else if (changed) {
				const src = transcriptSource(truth, (id) => this.host.verdict(id), this.host.threshold(), { folding, lists, listIssues: this.invalidLists });
				const spans = transcriptSpans(src);
				const stale = new Set(steps > 0 ? staleSpans(spans, src.blocks, steps).map((s) => s.key) : []);
				this.cache = { truth, rev: truth.rev, folding, steps, data: { src, spans, stale, charges: spanTokenIndex(src, spans) } };
				this.byBlock = new Map(src.blocks.map((b) => [b.id, b]));
			}
			if (changed || lists !== previousLists) {
				this.foldCache.clear();
				this.recordCache.clear();
				this.nodeCache.clear();
			}
		}
		const truth = this.cache?.truth;
		for (const s of this.stack) {
			if (s.kind === "list" && truth && !this.foldCache.has(s.slug)) {
				const list = this.list(s.slug);
				if (list) this.foldCache.set(s.slug, foldedTaskTokens(list, truth));
			}
			if (s.kind === "details") {
				const key = `${s.slug}/${s.id}`;
				if (!this.recordCache.has(key)) this.recordCache.set(key, this.computeGroups(key));
			}
		}
	}

	private data(): ViewData {
		const src = this.cache ? { ...this.cache.data.src, lists: this.listsSnapshot, listIssues: this.invalidLists,
			verdict: (id: string) => this.host.verdict(id), threshold: this.host.threshold() } : null;
		return { src, spans: this.cache?.data.spans ?? [], charges: this.cache?.data.charges, stale: this.cache?.data.stale, theme: this.ui.theme(), now: Date.now() };
	}

	private list(slug: string): TaskList | undefined {
		return this.listsSnapshot.find((l) => l.slug === slug);
	}

	private nodes(s: TreeScreen, data: ViewData): TreeNode<ViewRef>[] {
		const key = s.kind === "list" ? `list:${s.slug}` : s.kind === "span" ? `span:${s.key}` : "session";
		let cached = this.nodeCache.get(key);
		if (!cached || cached.theme !== data.theme) {
			const durations: ((now: number) => void)[] = [];
			let nodes: TreeNode<ViewRef>[] = [];
			if (s.kind === "list") {
				const list = this.list(s.slug);
				if (list) nodes = listNodes(list, this.cache?.truth ?? null, data, this.foldCache.get(list.slug) ?? new Map(), durations);
			} else if (data.src) {
				if (s.kind === "span") {
					const span = spanOf(data, s.key);
					if (span) nodes = transcriptNodes(spanTranscript(data.src, span, data.spans, data.charges), data);
				} else nodes = transcriptNodes(sessionTranscript(data.src, data.spans, data.charges), data);
			}
			cached = { theme: data.theme, nodes, durations };
			this.nodeCache.set(key, cached);
		}
		for (const update of cached.durations) update(data.now);
		return s.kind === "session" && s.show !== "all"
			? cached.nodes.filter((n) => n.data && (s.show === "tasks" ? n.data.type === "task" : n.data.type === "untracked" && !n.data.answer))
			: cached.nodes;
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

	/** The lists a filter keeps, and the selected one among them. */
	private shownLists(s: ListsScreen): { lists: TaskList[]; index: number } {
		const q = s.query.trim().toLowerCase();
		const lists = q ? this.listsSnapshot.filter((l) => `${l.slug} ${l.title}`.toLowerCase().includes(q)) : this.listsSnapshot;
		const at = lists.findIndex((l) => l.slug === s.slug);
		const index = Math.max(0, at);
		s.slug = lists[index]?.slug ?? null;
		return { lists, index };
	}

	private crumb(s: Screen): string[] {
		switch (s.kind) {
			case "lists": return s.create ? ["New list"] : [];
			case "session": return [];
			case "list": return [s.slug];
			case "span": return [`${s.key.split("/").pop()} span`];
			case "details": return [s.id];
			case "list-details": return ["context"];
			case "text": return [s.title];
		}
	}

	/** The current screen for the frame's body of `rows` lines. */
	view(width: number, rows: number): TabView {
		this.ensure();
		this.rows = rows;
		const t = this.ui.theme();
		const keys = this.ui.keys();
		const data = this.data();
		const s = this.top;
		// The root screen is the tab itself; a list opened directly still names itself.
		const crumbs = this.stack.flatMap((x, i) => (i === 0 && x.kind === "list" ? [x.slug] : this.crumb(x)));
		const enter = (action: string, priority = 1) => bindingHint(t, keys, "tui.select.confirm", "enter", action, priority);
		if (s.kind === "lists") return { ...this.listsView(s, width, rows, enter), crumbs };
		if (s.kind === "details" || s.kind === "list-details") {
			const list = this.list(s.slug);
			const lines = list ? (s.kind === "list-details" ? listDetailLines(list, t) : detailLines(list, s.id, data, this.groupsOf(`${s.slug}/${s.id}`))).flatMap((l) => hang(l, width)) : [t.fg("warning", this.invalidLists.includes(s.slug) ? ` "${s.slug}" is invalid; use tasks status for validation errors.` : ` "${s.slug}" no longer exists.`)];
			s.scroll = Math.max(0, Math.min(s.scroll, lines.length - rows));
			const hints: Hint[] = [];
			if (s.kind === "details") {
				if (data.src && spanOf(data, `${s.slug}/${s.id}`)) hints.push(enter("span"));
				if (this.groupsOf(`${s.slug}/${s.id}`).length) hints.push(rawHint(t, "alt+v", "record", 2), rawHint(t, "alt+f", "unfold", 3));
				hints.push(rawHint(t, "alt+g", "list context", 5));
			}
			hints.push(rawHint(t, "↑↓", "scroll", 6));
			return { body: lines.slice(s.scroll, s.scroll + rows), crumbs, description: s.kind === "details" ? "Lifecycle, report and recorded facts of this task." : "The list's goals, claim, scoped pins and attachments.", hints, above: s.scroll, below: Math.max(0, lines.length - s.scroll - rows) };
		}
		if (s.kind === "text") {
			const src = s.showAlt && s.alt ? s.alt : s.main;
			const lines = src.flatMap((l) => wrapTextWithAnsi(clean(l), Math.max(1, width - 1)).map((x) => ` ${x}`));
			s.scroll = Math.max(0, Math.min(s.scroll, lines.length - rows));
			const hints = [...(s.alt ? [rawHint(t, "alt+v", s.showAlt ? "record" : s.altLabel, 2)] : []), rawHint(t, "↑↓", "scroll", 6)];
			return { body: lines.slice(s.scroll, s.scroll + rows), crumbs, description: s.alt ? `Showing ${s.showAlt ? `the ${s.altLabel}` : "the record"}; read-only.` : "Read-only text.", hints, above: s.scroll, below: Math.max(0, lines.length - s.scroll - rows) };
		}
		const nodes = this.nodes(s, data);
		const body = s.tree.render(nodes, width, rows, (x) => t.fg("accent", x), (x) => t.fg("dim", x));
		if (!nodes.length) body.push(t.fg("dim", s.tree.query ? "   Nothing matches the filter." : s.kind === "list" ? this.invalidLists.includes(s.slug) ? "   Invalid task list; use tasks status for validation errors." : this.list(s.slug) ? "   This list has no tasks." : "   This task list no longer exists." : data.src ? "   Nothing ran in this session yet." : "   No session context yet."));
		const ref = s.tree.current?.node.data;
		const show = s.kind === "session" && s.show !== "all" ? ` · showing ${s.show}` : "";
		return { body, crumbs, description: `${s.tree.position()}${show} · ${this.describe(s, ref)}`, hints: this.treeHints(s, ref, enter), ...s.tree.hidden(rows) };
	}

	private describe(s: TreeScreen, ref: ViewRef | undefined): string {
		if (!ref) return s.kind === "session" ? "This session's work by task." : "The tasks of this list.";
		switch (ref.type) {
			case "task": return s.kind === "list" ? "A task: its lifecycle, report and span." : "A task span: the work done while it was in progress.";
			case "fold": return "A folded record; open it to see what the agent sees.";
			case "user": return "A user message; open it for its verdict and text.";
			case "step": return "A step: a tool call with its result, or one assistant block.";
			case "untracked": return ref.answer ? "An assistant reply between tasks." : "Tool calls made while no task was in progress.";
			case "edge": return ref.edge === "start" ? "The call that started this task." : "The call that ended this task, with its report.";
		}
	}

	private treeHints(s: TreeScreen, ref: ViewRef | undefined, enter: (action: string, priority?: number) => Hint): Hint[] {
		const t = this.ui.theme();
		const hints: Hint[] = [];
		if (ref?.type === "task") hints.push(enter(s.kind === "list" ? "details" : "span"), rawHint(t, "alt+i", s.kind === "list" ? "span" : "details", 3), rawHint(t, "alt+f", "unfold/fold", 4));
		else if (ref?.type === "untracked") hints.push(enter("expand"));
		else if (ref?.type === "fold") hints.push(enter("record"), rawHint(t, "alt+f", "unfold/fold", 3));
		else if (ref?.type === "step" || ref?.type === "user") hints.push(enter("open"), rawHint(t, "alt+f", "fold", 3), rawHint(t, "alt+p", "pin", 4));
		else if (ref) hints.push(enter("open"));
		hints.push(rawHint(t, "←→", "collapse/expand", 7));
		if (s.kind === "list") hints.push(rawHint(t, "alt+g", "list context", 6));
		if (s.kind === "session") hints.push(rawHint(t, "alt+v", s.show === "all" ? "tasks only" : s.show === "tasks" ? "untracked only" : "show all", 6));
		return hints;
	}

	private listsView(s: ListsScreen, width: number, rows: number, enter: (action: string, priority?: number) => Hint): Omit<TabView, "crumbs"> {
		const t = this.ui.theme();
		const now = Date.now();
		if (s.create) {
			const body = [s.create.title === null ? `  Title: ${clean(s.create.input.text)}${t.fg("accent", "▏")}` : `  Goal: ${clean(s.create.input.text)}${t.fg("accent", "▏")}`, t.fg("dim", s.create.title === null ? "  The slug is derived from the title." : `  Title: ${clean(s.create.title)}`)];
			return { body, description: s.create.title === null ? "Name the new task list; it is attached to this session." : "One sentence: the end state the whole list delivers.", hints: [enter(s.create.title === null ? "next" : "create")], above: 0, below: 0 };
		}
		const session = this.listsHost?.session() ?? "";
		const { lists, index } = this.shownLists(s);
		const warning = this.invalidLists.length ? `▲ Invalid lists: ${this.invalidLists.map(clean).join(", ")} · tasks status <slug> shows why` : "";
		const listRows = Math.max(1, rows - (warning ? 1 : 0));
		const start = Math.max(0, Math.min(index - Math.floor(listRows / 2), lists.length - listRows));
		const slugWidth = Math.max(0, ...lists.map((l) => l.slug.length));
		const body = lists.length
			? lists.slice(start, start + listRows).map((l, i) => listRowLine(l, session, start + i === index, width, t, now, slugWidth))
			: [t.fg("dim", s.query ? "   No list matches the filter." : this.invalidLists.length ? "   No readable task lists." : "   No task lists in this project yet; alt+n starts one.")];
		if (warning) body.push(t.fg("warning", ` ${warning}`));
		const sel = lists[index];
		const state = sel ? claimState(sel, session, now) : null;
		const hints: Hint[] = [];
		if (sel) hints.push(enter("open"), rawHint(t, "alt+a", state === "mine" ? "release" : state === "held" ? "take over" : "attach", 2), rawHint(t, "alt+g", "context", 5));
		hints.push(rawHint(t, "alt+n", "new list", 3));
		const description = sel ? `${clean(sel.title)} · ${progressText(sel, t, true)} · ${claimText(sel, state!, t, now)}` : `${this.listsSnapshot.length} task list${this.listsSnapshot.length === 1 ? "" : "s"} in this project.`;
		return { body, description, hints, above: start, below: Math.max(0, lists.length - start - listRows) };
	}

	/** True while the new-list input is open: printable keys belong to it. */
	typing(): boolean {
		const s = this.top;
		return s.kind === "lists" && !!s.create;
	}

	/** The current filter, or null when the screen has none. */
	query(): string | null {
		const s = this.top;
		if (s.kind === "lists") return s.create ? null : s.query;
		return "tree" in s ? s.tree.query : null;
	}

	setFilter(query: string): void {
		const s = this.top;
		if (s.kind === "lists") s.query = query;
		else if ("tree" in s) s.tree.query = query;
	}

	/** Leave one level; false at the root. */
	back(): boolean {
		const s = this.top;
		if (s.kind === "lists" && s.create) {
			s.create = null;
			return true;
		}
		if (this.stack.length <= 1) return false;
		this.stack.pop();
		return true;
	}

	/** Handle a key the frame did not take; report whether it was used. */
	key(input: string): boolean {
		this.ensure();
		const used = this.route(input);
		this.ensure();
		return used;
	}

	private route(input: string): boolean {
		const k = this.ui.keys();
		const confirm = k.matches(input, "tui.select.confirm");
		const up = k.matches(input, "tui.select.up");
		const down = k.matches(input, "tui.select.down");
		const chord = (key: string) => matchesKey(input, `alt+${key}` as Parameters<typeof matchesKey>[1]);
		const s = this.top;
		const page = Math.max(1, this.rows - 1);
		const step = up ? -1 : down ? 1 : matchesKey(input, "pageUp") ? -page : matchesKey(input, "pageDown") ? page : 0;
		if (s.kind === "lists") return this.listsKey(s, input, confirm, step, chord);
		if (s.kind === "details" || s.kind === "list-details" || s.kind === "text") {
			if (step) s.scroll = Math.max(0, s.scroll + step);
			else if (s.kind === "text" && chord("v") && s.alt) {
				s.showAlt = !s.showAlt;
				s.scroll = 0;
			} else if (s.kind === "details") return this.detailsKey(s, confirm, chord);
			else return false;
			return true;
		}
		const tree = s.tree;
		// Rows change with every open/close; rebuild them so a key never acts on a stale layout.
		tree.rows(this.nodes(s, this.data()));
		if (step) tree.move(step);
		else if (matchesKey(input, "right")) tree.right();
		else if (matchesKey(input, "left")) tree.left();
		else if (chord("g") && s.kind === "list") this.stack.push({ kind: "list-details", slug: s.slug, scroll: 0 });
		else if (chord("v") && s.kind === "session") s.show = s.show === "all" ? "tasks" : s.show === "tasks" ? "untracked" : "all";
		else {
			const ref = tree.current?.node.data;
			return !!ref && this.nodeKey(s, ref, confirm, chord);
		}
		return true;
	}

	private listsKey(s: ListsScreen, input: string, confirm: boolean, step: number, chord: (key: string) => boolean): boolean {
		const host = this.listsHost;
		if (s.create) {
			const text = s.create.input.text.trim();
			if (!confirm) return editText(s.create.input, input);
			if (!text) return true;
			if (s.create.title === null) s.create = { title: text, input: { text: "" } };
			else if (host) {
				const r = host.create(s.create.title, text);
				this.ui.say(r.message, r.ok ? "info" : "warning");
				if (r.ok) {
					s.create = null;
					s.query = "";
					this.reload(s, r.list.slug);
				}
			}
			return true;
		}
		const { lists, index } = this.shownLists(s);
		const sel = lists[index];
		if (step) s.slug = lists[Math.max(0, Math.min(lists.length - 1, index + step))]?.slug ?? null;
		else if (confirm && sel) this.stack.push({ kind: "list", slug: sel.slug, tree: new TreeState() });
		else if (chord("g") && sel) this.stack.push({ kind: "list-details", slug: sel.slug, scroll: 0 });
		else if (chord("n") || chord("a")) {
			if (!host) this.ui.say("Task lists change only while a conductor provides the tasks tool (Taskfold).");
			else if (chord("n")) s.create = { title: null, input: { text: "" } };
			else if (sel) this.toggleClaim(s, sel, host);
		} else return false;
		return true;
	}

	private toggleClaim(s: ListsScreen, list: TaskList, host: TaskListsHost): void {
		const state = claimState(list, host.session());
		const done = (r: { ok: boolean; message: string }) => {
			this.ui.say(r.message, r.ok ? "info" : "warning");
			this.reload(s, list.slug);
		};
		if (state === "mine") return done(host.release(list.slug));
		if (state !== "held" || !list.claim) return done(host.attach(list.slug, false));
		this.ui.confirm({
			crumb: "Take over",
			title: `Take over "${list.slug}"?\nIt is claimed by ${holderLabel(list.claim)}, active ${formatAge(Date.now() - Date.parse(list.claim.at))} ago.\nThat session loses the claim: its agent can no longer change the list.`,
			options: [`Leave it with ${holderLabel(list.claim)}`, `Take over "${list.slug}"`],
			then: (choice) => {
				if (choice === 1) done(host.attach(list.slug, true));
			},
		});
	}

	/** Re-read the lists after this screen changed one, keeping `slug` selected. */
	private reload(s: ListsScreen, slug: string): void {
		this.host.rescan?.();
		this.stale = true;
		s.slug = slug;
		this.ui.update();
	}

	private noSpan(slug: string, id: string): string {
		const task = this.host.lists().find((l) => l.slug === slug)?.tasks.find((t) => t.id === id);
		return task && neverRan(task) ? "This task was never started, so it has no span." : "This task did not run in this session.";
	}

	private detailsKey(s: Extract<Screen, { kind: "details" }>, confirm: boolean, chord: (key: string) => boolean): boolean {
		const data = this.data();
		const taskKey = `${s.slug}/${s.id}`;
		if (confirm) {
			if (data.src && spanOf(data, taskKey)) this.stack.push({ kind: "span", key: taskKey, tree: new TreeState() });
			else this.ui.say(this.noSpan(s.slug, s.id));
		} else if (chord("v")) {
			const groups = this.groupsOf(taskKey);
			if (!groups.length) this.ui.say("This task is not folded.");
			else this.pushTaskRecord(taskKey);
		} else if (chord("g")) this.stack.push({ kind: "list-details", slug: s.slug, scroll: 0 });
		else if (chord("f")) this.toggleTask(taskKey);
		else return false;
		return true;
	}

	private nodeKey(s: TreeScreen, ref: ViewRef, confirm: boolean, chord: (key: string) => boolean): boolean {
		const data = this.data();
		const fold = chord("f");
		const openSpan = (key: string, slug: string, id: string) => {
			if (data.src && spanOf(data, key)) this.stack.push({ kind: "span", key, tree: new TreeState() });
			else this.ui.say(this.noSpan(slug, id));
		};
		if (ref.type === "task") {
			const details = () => this.stack.push({ kind: "details", slug: ref.slug, id: ref.id, scroll: 0 });
			if (confirm) s.kind === "list" ? details() : openSpan(ref.key, ref.slug, ref.id);
			else if (chord("i")) s.kind === "list" ? openSpan(ref.key, ref.slug, ref.id) : details();
			else if (fold) this.toggleTask(ref.key);
			else return false;
			return true;
		}
		if (ref.type === "untracked") {
			if (confirm) s.tree.toggle();
			return confirm;
		}
		if (ref.type === "fold") {
			if (confirm) this.pushRecord([ref.groupId]);
			else if (fold) this.toggleGroups([ref.groupId]);
			else return false;
			return true;
		}
		if (ref.type === "edge") {
			if (!confirm) return false;
			if (ref.edge === "finish") {
				const r = spanOf(data, ref.key)?.report;
				this.stack.push({ kind: "text", title: "report", main: [`outcome: ${r?.outcome ?? "–"}`, ...(r?.decisions ?? []).map((d) => `decision: ${d}`), ...(r?.open ?? []).map((o) => `open: ${o}`)], alt: null, altLabel: "", showAlt: false, scroll: 0 });
			} else this.ui.say("The span starts with this call.", "info");
			return true;
		}
		const ids = ref.type === "step" ? [ref.id, ...(ref.resultId ? [ref.resultId] : [])] : [ref.id];
		if (confirm) {
			if (ref.type === "user") this.pushUser(ref.id, data);
			else this.pushBlocks(ids, data);
		} else if (fold || chord("p")) this.toggleBlocks(ids, fold ? "f" : "p");
		else return false;
		return true;
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
					...(v.routed ? [`routed: ${v.routed.ids.length ? `its instructions went into ${v.routed.ids.join(", ")}` : "nothing in it changed the list"} · ${formatClock(v.routed.at)}`] : []),
				];
		const input = classifierInput(data.src, id);
		const shown = input ? ["", "classifier input:", ...Object.entries(input).flatMap(([k, val]) => [`  ${k}:`, ...(val ? val.split("\n").map((l) => `    ${l}`) : ["    (empty)"])])] : [];
		this.stack.push({ kind: "text", title: "user message", main: [...verdict, "", "message:", ...b.text.split("\n"), ...shown], alt: null, altLabel: "", showAlt: false, scroll: 0 });
	}

	private apply(ops: Op[]): void {
		if (!ops.length) return;
		if (!this.host.canSteer()) return this.ui.say("Read-only: another surface controls Accordion.");
		this.ui.say("Applying…", "info");
		void this.host.apply(ops).then(
			(m) => {
				this.stale = true;
				this.ui.say(m, m === "Applied." ? "info" : "warning");
			},
			(e) => this.ui.say(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error"),
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
		if (!refs.length) return this.ui.say("This task has no fold yet; Taskfold folds it when the budget needs room.");
		const unfold = refs.some((r) => r.group.folded);
		const selected = refs.filter((r) => r.group.folded === unfold);
		const selective = unfold && selected.some((r) => r.memberIds.length < r.group.memberIds.length);
		const ops = selected.map((r): Op => unfold
			? { kind: "unfoldGroup", groupId: r.group.id, ...(selective && r.handleId ? { handleId: r.handleId } : {}) }
			: { kind: "foldGroup", groupId: r.group.id });
		if (selective) ops.push({ kind: "unfold", ids: [...new Set(selected.flatMap((r) => r.memberIds))] });
		this.apply(ops);
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
		if (group) return this.ui.say("Part of a fold: select the fold and use alt+f.");
		// A call folds through its result; user messages fold only inside a task record.
		const foldable = blocks.filter((b) => wireFoldable(b));
		if (!foldable.length) return this.ui.say(blocks.some((b) => b.kind === "user") ? "User messages fold only inside a task record." : "Nothing here folds on its own.");
		const folded = foldable.every((b) => truth.isFolded(b));
		this.apply([{ kind: folded ? "unfold" : "fold", ids: foldable.map((b) => b.id) }]);
	}

	dispose(): void {
		this.unsubscribe();
	}
}
