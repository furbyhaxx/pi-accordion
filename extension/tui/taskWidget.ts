/*
 * taskWidget.ts — the Taskfold task list above the editor: a two-line summary that expands into the
 * task tree. Pure rendering (`renderTaskWidget`) is separate from the live component and its
 * controller so it can be tested without a terminal.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Truth } from "../../core/truth";
import { staleSpans, taskKeyOfSummary } from "../../conductors/in-process/taskfold/taskfold";
import { taskSpansOf } from "../taskSpans";
import { blockLabel, currentBlock, type Task, type TaskList } from "../tasks";
import type { TaskWidgetSettings } from "../settings";
import { fitSegments, sgrBold } from "./chrome";
import { formatCompactTokens } from "./map";
import { spanContains, taskFoldRefs } from "./taskTranscript";
import { buildTaskTree, isFinished, layoutTaskTree, summarizeTasks, taskDuration, type TaskGlyphState, type TaskNode, type TaskRow } from "./taskTree";

/** The theme subset the widget draws with. */
export interface WidgetTheme {
	fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

/** The widget's theme over the host's: colours from the host, bold and strikethrough as plain SGR because Pi's chalk-based styles can emit nothing. */
export function widgetTheme(host: WidgetTheme): WidgetTheme {
	return { fg: (color, text) => host.fg(color, text), bold: sgrBold, strikethrough: (text) => `\x1b[9m${text}\x1b[29m` };
}

/** What the widget shows: one list, which of its tasks are folded, and the tokens its spans take. */
export interface TaskWidgetModel {
	list: TaskList;
	folded: ReadonlySet<string>;
	/** Tokens of each folded task's own group(s), at full size and as sent; subtasks folded inside a parent have none. */
	foldTokens?: ReadonlyMap<string, FoldTokens>;
	/** Ids of this list's open tasks that went `zombieSteps` tool calls without a task event while other tasks ran. */
	stale?: ReadonlySet<string>;
	/** Tokens of this session's task spans at full size and as currently sent; null without spans. */
	tokens: { full: number; live: number } | null;
}

/** Per-session presentation state, kept across widget re-creation. */
export interface TaskWidgetView {
	expanded: boolean;
	maxRows: number;
	toggles: Map<string, boolean>;
	revealed: Set<string>;
	showLegend?: boolean;
	/** Key that toggles the widget; named in the row that ends revealing. */
	toggleKey?: string;
}

/** Hidden siblings one click reveals, and the most a view keeps revealed. */
export const REVEAL_STEP = 10;
export const REVEAL_CAP = 30;

/** A folded span's size before and after folding. */
export interface FoldTokens {
	full: number;
	live: number;
	/** False when only part of this task remains folded. */
	complete?: boolean;
}

/** What a click on a rendered line does. */
export type TaskWidgetHit = { kind: "header" } | { kind: "toggle"; id: string; open: boolean } | { kind: "reveal"; ids: string[] } | null;

const ELLIPSIS = "…";
export const GLYPH: Record<TaskGlyphState, string> = { todo: "☐", active: "▶", partial: "◐", blocked: "⧗", done: "▣", failed: "☒", abandoned: "⊘" };

/** `45s`, `5m 12s`, `2h 05m`. */
export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function headerLine(model: TaskWidgetModel, view: TaskWidgetView, width: number, theme: WidgetTheme, now: number, glyph: string): string {
	const roots = buildTaskTree(model.list.tasks);
	const sum = summarizeTasks(roots, model.folded, now);
	const sep = theme.fg("dim", " · ");
	const label = `${theme.fg("accent", glyph)} ${theme.bold("Tasks")}`;
	const counts = ` ${sum.done}/${sum.total}`;
	const title = clean(model.list.title || model.list.slug);
	const suffix = [
		sum.folded ? `${sep}${theme.fg("muted", `≡${sum.folded}`)}` : "",
		sum.durationMs !== null ? `${sep}${formatDuration(sum.durationMs)}` : "",
		model.tokens ? `${sep}${theme.fg("muted", `${formatCompactTokens(model.tokens.full)} → ${formatCompactTokens(model.tokens.live)} tok`)}` : "",
	].filter(Boolean);
	const titleRoom = width - visibleWidth(label + counts + suffix.join("")) - 1;
	const titlePart = titleRoom >= 8 ? ` ${truncateToWidth(title, titleRoom, ELLIPSIS)}` : "";
	return fitSegments(
		[`${label}${titlePart}${counts}`, ...suffix],
		width,
	);
}

/**
 * `<left><title><meta>`: the most complete meta variant that leaves the whole title visible wins.
 * When none does, the last (shortest) variant stays if the title keeps 8 columns; the title is
 * shortened, never the left part.
 */
function fitRow(left: string, title: string, metas: string[], width: number): string {
	const titleWidth = visibleWidth(title);
	for (const meta of metas) if (width - visibleWidth(left) - visibleWidth(meta) >= titleWidth) return left + title + meta;
	const last = metas[metas.length - 1] ?? "";
	const meta = width - visibleWidth(left) - visibleWidth(last) >= 8 ? last : "";
	const room = width - visibleWidth(left) - visibleWidth(meta);
	return truncateToWidth(left + truncateToWidth(title, Math.max(1, room), ELLIPSIS) + meta, width, ELLIPSIS);
}

export function glyphColor(state: TaskGlyphState, blinkOn: boolean): "dim" | "success" | "error" | "warning" | "text" {
	if (state === "done") return "success";
	if (state === "failed") return "error";
	if (state === "todo" || state === "abandoned") return "dim";
	if (state === "active") return blinkOn ? "warning" : "text";
	return "warning";
}

/**
 * `<glyph> <id> ` and the styled title: not started dims both, abandoned strikes both through
 * (the glyph stays plain so it reads).
 */
export function taskParts(task: Task, state: TaskGlyphState, theme: WidgetTheme, blinkOn = true, fold = ""): { head: string; title: string } {
	const glyph = theme.fg(glyphColor(state, blinkOn), GLYPH[state]) + fold;
	const title = clean(task.title);
	if (state === "abandoned") return { head: `${glyph} ${theme.fg("dim", theme.strikethrough(task.id))}${theme.fg("dim", theme.strikethrough(" "))}`, title: theme.fg("dim", theme.strikethrough(title)) };
	const dim = state === "todo";
	return { head: `${glyph} ${theme.fg(dim ? "dim" : "muted", task.id)} `, title: dim ? theme.fg("dim", title) : title };
}

/** What a blocked or superseded task waits for or was replaced by, for the end of its row; empty otherwise. */
export function taskNote(task: Task): string {
	const b = currentBlock(task);
	if (b) return blockLabel(b);
	return task.supersededBy ? `→ ${task.supersededBy}` : "";
}

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

/** The row's trailing `stale` flag, in the elapsed-time position and separator. */
export const staleFlag = (theme: WidgetTheme): string => theme.fg("warning", " · stale");

const arrow = (f: FoldTokens) => `${formatCompactTokens(f.full)}→${formatCompactTokens(f.live)}`;

/** Folded tasks among `ids` and their subtasks that own a group, with their summed tokens. */
function foldsWithin(ids: readonly string[], folds: ReadonlyMap<string, FoldTokens> | undefined, self: boolean): { count: number; tokens: FoldTokens } {
	const tokens = { full: 0, live: 0 };
	let count = 0;
	for (const [id, f] of folds ?? []) {
		if (!ids.some((x) => (self && id === x) || id.startsWith(`${x}.`))) continue;
		count++;
		tokens.full += f.full;
		tokens.live += f.live;
	}
	return { count, tokens };
}

function leafCounts(node: TaskNode): { done: number; failed: number; abandoned: number; pending: number } {
	const counts = { done: 0, failed: 0, abandoned: 0, pending: 0 };
	const visit = (n: TaskNode) => {
		if (n.children.length) { n.children.forEach(visit); return; }
		if (n.task.status === "done" || n.task.status === "failed" || n.task.status === "abandoned") counts[n.task.status]++;
		else counts.pending++;
	};
	node.children.forEach(visit);
	return counts;
}

function taskRowLine(row: Extract<TaskRow, { kind: "task" }>, width: number, theme: WidgetTheme, blinkOn: boolean, folds: ReadonlyMap<string, FoldTokens> | undefined, stale: boolean): string {
	const t = row.node.task;
	const counts = leafCounts(row.node);
	const inconsistent = isFinished(t) && counts.pending > 0;
	const fold = inconsistent ? theme.fg("warning", "!") : row.folded ? theme.fg("muted", "≡") : isFinished(t) ? theme.fg("dim", "·") : " ";
	const { head, title } = taskParts(t, row.state, theme, blinkOn, fold);
	const left = `  ${theme.fg("dim", row.prefix)}${head}`;
	const note = taskNote(t);
	const noteText = note ? theme.fg(row.state === "blocked" ? "warning" : "dim", ` · ${note}`) : "";
	const duration = noteText + (row.durationMs !== null ? theme.fg("dim", ` · ${formatDuration(row.durationMs)}`) : "");
	const own = folds?.get(t.id);
	const inner = !row.folded && !row.open && row.node.children.length ? foldsWithin([t.id], folds, false) : null;
	const progress = row.progress ? [counts.done ? `${counts.done}✓` : "", counts.failed ? `${counts.failed}☒` : "", counts.abandoned ? `${counts.abandoned}⊘` : "", counts.pending ? `${counts.pending}☐` : ""].filter(Boolean).join(" ") : "";
	const parts = [progress, row.folded ? (own ? arrow(own) : "") : inner?.count ? `${inner.count}≡ · ${arrow(inner.tokens)}` : ""].filter(Boolean);
	const short = [progress, inner?.count ? `${inner.count}≡` : ""].filter(Boolean);
	const marker = parts.length ? theme.fg("muted", ` (${parts.join(" · ")})`) : "";
	const shortMarker = short.length ? theme.fg("muted", ` (${short.join(" · ")})`) : "";
	if (!stale) return fitRow(left, title, [duration + marker, noteText + marker, noteText + shortMarker, shortMarker], width);
	const flag = staleFlag(theme);
	return fitRow(left, title, [duration + flag + marker, noteText + flag + marker, noteText + flag + shortMarker, flag + shortMarker, shortMarker], width);
}

function hiddenRowLine(row: Extract<TaskRow, { kind: "hidden" }>, width: number, theme: WidgetTheme, folds: ReadonlyMap<string, FoldTokens> | undefined, capped: string | null): string {
	if (capped !== null) return truncateToWidth(`  ${theme.fg("dim", row.prefix)} ${theme.fg("dim", `… ${row.count} more · ${capped} Tasks`)}`, width, ELLIPSIS);
	const parts = [`… ${row.count} ${row.finished ? "finished" : "upcoming"}`, row.durationMs !== null ? formatDuration(row.durationMs) : ""].filter(Boolean).join(" · ");
	const within = foldsWithin(row.ids, folds, true);
	const folded = row.folded ? ` (${row.folded}≡${within.count ? ` · ${arrow(within.tokens)}` : ""})` : "";
	return truncateToWidth(`  ${theme.fg("dim", row.prefix)} ${theme.fg("dim", parts + folded)}`, width, ELLIPSIS);
}

/** The widget's lines at `width`, with the click action of each line. */
export function renderTaskWidget(model: TaskWidgetModel, view: TaskWidgetView, width: number, theme: WidgetTheme, now: number, blinkOn: boolean): { lines: string[]; hits: TaskWidgetHit[] } {
	const roots = buildTaskTree(model.list.tasks);
	const sum = summarizeTasks(roots, model.folded, now);
	if (!view.expanded) {
		if (sum.allFinished) return { lines: [headerLine(model, view, width, theme, now, "►")], hits: [{ kind: "header" }] };
		const lines = [headerLine(model, view, width, theme, now, "▲")];
		const cur = sum.current ?? sum.blocked ?? sum.next;
		if (cur) {
			const d = sum.current ? taskDuration(cur.task, now) : null;
			const waiting = !sum.current && cur === sum.blocked;
			const lead = sum.current ? "" : waiting ? `${theme.fg("warning", GLYPH.blocked)} ` : theme.fg("dim", "next ");
			const left = `  ${theme.fg("dim", "⎿")} ${lead}${theme.fg("muted", cur.task.id)} `;
			let meta = waiting ? [theme.fg("warning", ` · ${taskNote(cur.task)}`)] : d !== null ? [theme.fg("dim", ` · ${formatDuration(d)}`)] : [];
			if (model.stale?.has(cur.task.id)) {
				const flag = staleFlag(theme);
				meta = meta.length ? [meta[0] + flag, flag, meta[0]] : [flag];
			}
			lines.push(fitRow(left, clean(cur.task.title), meta, width));
		}
		return { lines, hits: lines.map(() => ({ kind: "header" }) as const) };
	}
	const rows = layoutTaskTree(roots, { maxRows: Math.max(1, view.maxRows), now, folded: model.folded, toggles: view.toggles, revealed: view.revealed });
	const lines = [headerLine(model, view, width, theme, now, "▼")];
	const hits: TaskWidgetHit[] = [{ kind: "header" }];
	if (view.showLegend) {
		lines.push(truncateToWidth(theme.fg("dim", "  ≡ folded · raw ! inconsistent · ▣ done ☒ failed ⊘ abandoned ◐ partly done ▶ doing ⧗ blocked ☐ todo"), width, ELLIPSIS));
		hits.push(null);
	}
	for (const row of rows) {
		if (row.kind === "hidden") {
			const capped = view.revealed.size >= REVEAL_CAP;
			lines.push(hiddenRowLine(row, width, theme, model.foldTokens, capped ? (view.toggleKey ?? "alt+t") : null));
			hits.push(capped ? null : { kind: "reveal", ids: row.ids });
		} else {
			lines.push(taskRowLine(row, width, theme, blinkOn, model.foldTokens, !!model.stale?.has(row.node.task.id)));
			hits.push(row.node.children.length ? { kind: "toggle", id: row.node.task.id, open: row.open } : null);
		}
	}
	return { lines, hits };
}

/** Apply a click to the view; returns whether anything changed. */
export function applyTaskWidgetHit(view: TaskWidgetView, hit: TaskWidgetHit): boolean {
	if (!hit) return false;
	if (hit.kind === "header") view.expanded = !view.expanded;
	else if (hit.kind === "toggle") view.toggles.set(hit.id, !hit.open);
	else {
		const before = view.revealed.size;
		const room = Math.min(REVEAL_STEP, REVEAL_CAP - before);
		for (const id of hit.ids) {
			if (view.revealed.size - before >= room) break;
			view.revealed.add(id);
		}
		return view.revealed.size > before;
	}
	return true;
}

/** Tasks with actual complete fold coverage; ancestry alone never proves a child is folded. */
export function foldedTaskIds(list: TaskList, folds: ReadonlyMap<string, FoldTokens>): Set<string> {
	const covered = new Set([...folds.entries()].filter(([, f]) => f.complete !== false).map(([id]) => id));
	const out = new Set<string>();
	for (const t of list.tasks) {
		const ran = t.status !== "todo" && !(t.status === "abandoned" && !t.startedAt && !t.blocks?.length);
		if (ran && covered.has(t.id)) out.add(t.id);
	}
	return out;
}

/** Tokens of each of `list`'s tasks that owns folded Taskfold groups, summed over its parts. */
export function foldedTaskTokens(list: TaskList, truth: Truth): Map<string, FoldTokens> {
	const spans = taskSpansOf(truth);
	const out = new Map<string, FoldTokens>();
	const charges = new Map(truth.projectContext().flatMap((p) => p.members.map((b) => [b.id, b] as const)));
	for (const task of list.tasks) {
		const key = `${list.slug}/${task.id}`;
		const refs = taskFoldRefs(truth, key);
		const folded = refs.filter((r) => r.group.folded);
		if (!folded.length) continue;
		const ids = new Set(folded.flatMap((r) => taskKeyOfSummary(r.group.digest) === key ? r.group.memberIds : r.memberIds));
		const tokens = [...ids].reduce((n, id) => ({ full: n.full + charges.get(id)!.full, live: n.live + charges.get(id)!.live }), { full: 0, live: 0 });
		const span = [...spans].reverse().find((s) => s.key === key);
		const scope = span ? truth.blocks.filter((_b, i) => spanContains(span, i)) : refs.flatMap((r) => r.memberIds.map((id) => truth.get(id)!));
		const complete = scope.filter((b) => b.kind !== "user").every((b) => truth.isFolded(b));
		out.set(task.id, { ...tokens, complete });
	}
	return out;
}

/** Exact additive charges of this list's intervals and the carriers snapped around them. */
export function taskSpanTokens(list: TaskList, truth: Truth): { full: number; live: number } | null {
	const allSpans = taskSpansOf(truth);
	const spans = allSpans.filter((s) => s.list === list.slug);
	if (!spans.length) return null;
	const covered = new Set(truth.blocks.filter((_b, i) => spans.some((s) => spanContains(s, i))).map((b) => b.id));
	let full = 0, live = 0;
	for (const carrier of truth.projectContext()) {
		if (!carrier.members.some((b) => covered.has(b.id))) continue;
		for (const b of carrier.members) { full += b.full; live += b.live; }
	}
	return { full, live };
}

/** The list a session shows: the one with work in progress, else the most recently updated. */
export function pickTaskList(lists: readonly TaskList[], session: string): TaskList | null {
	const mine = lists.filter((l) => l.claim?.session === session && l.tasks.length);
	return mine.find((l) => l.tasks.some((t) => t.status === "doing")) ?? mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

interface WidgetTui {
	requestRender(): void;
}

/** The live widget: renders the controller's model, blinks the running task, handles clicks. */
export class TaskWidgetComponent {
	private hits: TaskWidgetHit[] = [];
	private blinkOn = true;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly tui: WidgetTui,
		private readonly theme: WidgetTheme,
		private readonly model: () => TaskWidgetModel | null,
		private readonly view: TaskWidgetView,
		private readonly onExpanded: (expanded: boolean) => void = () => {},
		private readonly problem: () => string | null = () => null,
	) {
		this.timer = setInterval(() => {
			const m = this.model();
			if (!m?.list.tasks.some((t) => t.status === "doing")) return;
			this.blinkOn = !this.blinkOn;
			this.tui.requestRender();
		}, 1000);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		const m = this.model();
		const problem = this.problem();
		const warning = problem ? [truncateToWidth(this.theme.fg("warning", `▲ Tasks: ${clean(problem)}`), width, ELLIPSIS)] : [];
		if (!m) {
			this.hits = [];
			return warning;
		}
		const out = renderTaskWidget(m, this.view, width, this.theme, Date.now(), this.blinkOn);
		this.hits = [...warning.map(() => null), ...out.hits];
		return [...warning, ...out.lines];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.hits[event.y] ?? null;
		if (!applyTaskWidgetHit(this.view, hit)) return undefined;
		if (hit?.kind === "header") this.onExpanded(this.view.expanded);
		this.tui.requestRender();
		return { handled: true };
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

/** What the controller needs from the extension. */
export interface TaskWidgetDeps {
	/** All task lists of the current project; IO, called only on reload. */
	lists(): TaskList[];
	/** Readable and invalid lists together; IO, called only on reload. */
	scan?(): { lists: TaskList[]; invalid: string[] };
	session(): string | null;
	truth(): Truth | null;
	/** Whether the attached conductor provides the `tasks` tool. */
	enabled(): boolean;
	settings(): TaskWidgetSettings;
	/** `tasks.zombieSteps`: tool calls without a task event after which an open task is stale; absent or 0 marks none. */
	staleAfter?(): number;
	/** The user expanded or collapsed the tree; the state is remembered for later sessions. */
	saveExpanded(expanded: boolean): void;
}

interface WidgetUi {
	setWidget(key: string, content: ((tui: WidgetTui, theme: WidgetTheme) => TaskWidgetComponent) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

const WIDGET_KEY = "accordion-tasks";

/**
 * Shows the session's task list above the editor while it is relevant, and keeps the expand state
 * and click toggles for the session. List files are read only on `reload`, never while rendering.
 */
export class TaskWidgetController {
	private ui: WidgetUi | null = null;
	private list: TaskList | null = null;
	private problem: string | null = null;
	private installed: TaskWidgetComponent | null = null;
	private installing = false;
	private hidden = false;
	private readonly suspensions = new Set<symbol>();
	private legendSeen = false;
	private view: TaskWidgetView;
	private cache: { key: string; model: TaskWidgetModel } | null = null;

	constructor(private readonly deps: TaskWidgetDeps) {
		this.view = this.freshView();
	}

	private freshView(): TaskWidgetView {
		const s = this.deps.settings();
		const showLegend = s.expanded && !this.legendSeen;
		return { expanded: s.expanded, maxRows: s.maxRows, toggles: new Map(), revealed: new Set(), showLegend, toggleKey: s.toggleKey };
	}

	/** Bind to a new session's UI; `ui` is null without an interactive terminal. */
	attach(ui: WidgetUi | null): void {
		this.detach();
		this.ui = ui;
		this.hidden = false;
		this.view = this.freshView();
		this.reload();
	}

	/** Re-read the task lists, then show, hide or redraw. */
	reload(): void {
		const session = this.ui ? this.deps.session() : null;
		this.problem = null;
		try {
			const scan = session ? this.deps.scan?.() : undefined;
			this.list = session ? pickTaskList(scan?.lists ?? this.deps.lists(), session) : null;
			if (scan?.invalid.length) this.problem = `Invalid lists: ${scan.invalid.join(", ")}; use tasks status for errors.`;
		} catch (err) {
			this.list = null;
			this.problem = err instanceof Error ? err.message : String(err);
		}
		this.cache = null;
		this.sync();
	}

	/** Show, hide or redraw for the current state; cheap, safe to call on every change. */
	sync(): void {
		this.view.maxRows = this.deps.settings().maxRows;
		this.view.toggleKey = this.deps.settings().toggleKey;
		const want = !!this.ui && !this.hidden && this.suspensions.size === 0 && (!!this.list || !!this.problem) && this.deps.settings().mode === "auto" && this.deps.enabled();
		if (want && !this.installed && !this.installing) {
			if (this.view.showLegend) this.legendSeen = true;
			this.installing = true;
			try {
				this.ui!.setWidget(
					WIDGET_KEY,
					(tui, theme) => {
						this.installed?.dispose();
						this.installed = new TaskWidgetComponent(tui, widgetTheme(theme), () => this.model(), this.view, (expanded) => { this.updateLegend(expanded); this.deps.saveExpanded(expanded); }, () => this.problem);
						return this.installed;
					},
					{ placement: "aboveEditor" },
				);
			} catch {
				/* widgets are optional */
			} finally {
				this.installing = false;
			}
		} else if (!want && this.installed) this.remove();
		else this.installed?.requestRender();
	}

	private updateLegend(expanded: boolean): void {
		this.view.showLegend = expanded && !this.legendSeen;
		if (this.view.showLegend) this.legendSeen = true;
	}

	/** Temporarily remove the widget, returning a session-safe, idempotent release. */
	suspend(): () => void {
		const token = Symbol();
		this.suspensions.add(token);
		this.sync();
		return () => { if (this.suspensions.delete(token)) this.sync(); };
	}

	/** Expand or collapse; shows the widget again if it was hidden. */
	toggle(): void {
		if (this.hidden) this.hidden = false;
		else {
			this.view.expanded = !this.view.expanded;
			this.updateLegend(this.view.expanded);
			this.deps.saveExpanded(this.view.expanded);
		}
		this.sync();
	}

	/** Whether the tree is expanded (the panel's alt+e toggles this default). */
	isExpanded(): boolean {
		return this.view.expanded;
	}

	setExpanded(expanded: boolean): void {
		this.hidden = false;
		if (this.view.expanded !== expanded) this.deps.saveExpanded(expanded);
		if (this.view.expanded !== expanded) this.updateLegend(expanded);
		this.view.expanded = expanded;
		this.sync();
	}

	/** Hide for the rest of this session (until toggled or shown again). */
	hide(): void {
		this.hidden = true;
		this.sync();
	}

	/** Why the widget is not showing, or null when it is. */
	reason(): string | null {
		if (!this.ui) return "the task widget needs the interactive terminal";
		if (this.deps.settings().mode === "off") return 'the task widget is off ("taskWidget.mode" in ~/.accordion/config.json)';
		if (!this.deps.enabled()) return "attach the Taskfold conductor to track tasks";
		if (this.problem && !this.list) return this.problem;
		if (!this.list) return "this session holds no task list yet";
		if (this.hidden) return "the task widget is hidden in this session";
		if (this.suspensions.size) return "the task widget is suspended while task inspection is open";
		return null;
	}

	detach(): void {
		this.remove();
		this.ui = null;
		this.suspensions.clear();
		this.list = null;
		this.problem = null;
		this.cache = null;
	}

	private remove(): void {
		const ui = this.ui;
		this.installed?.dispose();
		this.installed = null;
		try {
			ui?.setWidget(WIDGET_KEY, undefined);
		} catch {
			/* UI may be gone during shutdown */
		}
	}

	private model(): TaskWidgetModel | null {
		const list = this.list;
		if (!list) return null;
		const truth = this.deps.truth();
		const steps = this.deps.staleAfter?.() ?? 0;
		const key = `${list.slug}|${list.updatedAt}|${truth?.rev ?? -1}|${truth?.blocks.length ?? 0}|${steps}`;
		if (this.cache?.key === key) return this.cache.model;
		const foldTokens = truth ? foldedTaskTokens(list, truth) : new Map<string, FoldTokens>();
		const stale = truth && steps > 0 ? new Set(staleSpans(taskSpansOf(truth), truth.blocks, steps).filter((s) => s.list === list.slug).map((s) => s.id)) : new Set<string>();
		const model: TaskWidgetModel = { list, folded: foldedTaskIds(list, foldTokens), foldTokens, stale, tokens: truth ? taskSpanTokens(list, truth) : null };
		this.cache = { key, model };
		return model;
	}
}
