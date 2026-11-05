/*
 * taskWidget.ts — the Taskfold task list above the editor: a two-line summary that expands into the
 * task tree. Pure rendering (`renderTaskWidget`) is separate from the live component and its
 * controller so it can be tested without a terminal.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Truth } from "../../core/truth";
import { scanTaskSpans, taskKeyOfSummary } from "../../conductors/in-process/taskfold/taskfold";
import { blockLabel, currentBlock, type Task, type TaskList } from "../tasks";
import type { TaskWidgetSettings } from "../settings";
import { formatCompactTokens } from "./map";
import { buildTaskTree, layoutTaskTree, summarizeTasks, taskDuration, type TaskGlyphState, type TaskRow } from "./taskTree";

/** The theme subset the widget draws with. */
export interface WidgetTheme {
	fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

/** What the widget shows: one list, which of its tasks are folded, and the tokens its spans take. */
export interface TaskWidgetModel {
	list: TaskList;
	folded: ReadonlySet<string>;
	/** Tokens of each folded task's own group(s), at full size and as sent; subtasks folded inside a parent have none. */
	foldTokens?: ReadonlyMap<string, FoldTokens>;
	/** Tokens of this session's task spans at full size and as currently sent; null without spans. */
	tokens: { full: number; live: number } | null;
}

/** Per-session presentation state, kept across widget re-creation. */
export interface TaskWidgetView {
	expanded: boolean;
	maxRows: number;
	toggles: Map<string, boolean>;
	revealed: Set<string>;
}

/** A folded span's size before and after folding. */
export interface FoldTokens {
	full: number;
	live: number;
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

/** Keep leading segments that fit `width`; the first one is always kept, truncated if it must be. */
function fitSegments(segments: string[], width: number): string {
	let out = segments[0] ?? "";
	for (const seg of segments.slice(1)) {
		if (visibleWidth(out + seg) > width) break;
		out += seg;
	}
	return truncateToWidth(out, Math.max(0, width), ELLIPSIS);
}

function headerLine(model: TaskWidgetModel, view: TaskWidgetView, width: number, theme: WidgetTheme, now: number, glyph: string): string {
	const roots = buildTaskTree(model.list.tasks);
	const sum = summarizeTasks(roots, model.folded, now);
	const sep = theme.fg("dim", " · ");
	return fitSegments(
		[
			`${theme.fg("accent", glyph)} ${theme.bold("Tasks")} ${sum.done}/${sum.total}`,
			sum.folded ? theme.fg("muted", ` (≡${sum.folded})`) : "",
			sum.durationMs !== null ? `${sep}${formatDuration(sum.durationMs)}` : "",
			model.tokens ? `${sep}${theme.fg("muted", `${formatCompactTokens(model.tokens.full)} → ${formatCompactTokens(model.tokens.live)} tok`)}` : "",
		].filter(Boolean),
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
export function taskParts(task: Task, state: TaskGlyphState, theme: WidgetTheme, blinkOn = true): { head: string; title: string } {
	const glyph = theme.fg(glyphColor(state, blinkOn), GLYPH[state]);
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

const arrow = (f: FoldTokens) => `${formatCompactTokens(f.full)} → ${formatCompactTokens(f.live)}`;

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

function taskRowLine(row: Extract<TaskRow, { kind: "task" }>, width: number, theme: WidgetTheme, blinkOn: boolean, folds: ReadonlyMap<string, FoldTokens> | undefined): string {
	const t = row.node.task;
	const { head, title } = taskParts(t, row.state, theme, blinkOn);
	const left = `  ${theme.fg("dim", row.prefix)}${head}`;
	const note = taskNote(t);
	const noteText = note ? theme.fg(row.state === "blocked" ? "warning" : "dim", ` · ${note}`) : "";
	const duration = noteText + (row.durationMs !== null ? theme.fg("dim", ` · ${formatDuration(row.durationMs)}`) : "");
	const own = folds?.get(t.id);
	const inner = !row.folded && !row.open && row.node.children.length ? foldsWithin([t.id], folds, false) : null;
	const progress = row.progress ? `${row.progress.done}/${row.progress.total}` : "";
	const parts = [progress, row.folded ? (own ? `fold ${arrow(own)}` : "fold") : inner?.count ? `${inner.count} folded · ${arrow(inner.tokens)}` : ""].filter(Boolean);
	const short = [progress, row.folded ? "fold" : inner?.count ? `${inner.count} folded` : ""].filter(Boolean);
	const marker = parts.length ? theme.fg("muted", ` (${parts.join(" · ")})`) : "";
	const shortMarker = short.length ? theme.fg("muted", ` (${short.join(" · ")})`) : "";
	return fitRow(left, title, [duration + marker, noteText + marker, noteText + shortMarker, shortMarker], width);
}

function hiddenRowLine(row: Extract<TaskRow, { kind: "hidden" }>, width: number, theme: WidgetTheme, folds: ReadonlyMap<string, FoldTokens> | undefined): string {
	const parts = [`… ${row.count} hidden`, row.durationMs !== null ? formatDuration(row.durationMs) : ""].filter(Boolean).join(" · ");
	const within = foldsWithin(row.ids, folds, true);
	const folded = row.folded ? ` (${row.folded} folded${within.count ? ` · ${arrow(within.tokens)}` : ""})` : "";
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
			const meta = waiting ? [theme.fg("warning", ` · ${taskNote(cur.task)}`)] : d !== null ? [theme.fg("dim", ` · ${formatDuration(d)}`)] : [];
			lines.push(fitRow(left, clean(cur.task.title), meta, width));
		}
		return { lines, hits: lines.map(() => ({ kind: "header" }) as const) };
	}
	const rows = layoutTaskTree(roots, { maxRows: Math.max(1, view.maxRows), now, folded: model.folded, toggles: view.toggles, revealed: view.revealed });
	const lines = [headerLine(model, view, width, theme, now, "▼")];
	const hits: TaskWidgetHit[] = [{ kind: "header" }];
	for (const row of rows) {
		if (row.kind === "hidden") {
			lines.push(hiddenRowLine(row, width, theme, model.foldTokens));
			hits.push({ kind: "reveal", ids: row.ids });
		} else {
			lines.push(taskRowLine(row, width, theme, blinkOn, model.foldTokens));
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
	else for (const id of hit.ids) view.revealed.add(id);
	return true;
}

/**
 * Ids of `list`'s tasks inside a folded group: the group owners in `folds` and their subtasks that
 * ran. A subtask never started has no work in the fold, so it is not counted as folded.
 */
export function foldedTaskIds(list: TaskList, folds: ReadonlyMap<string, FoldTokens>): Set<string> {
	const roots = [...folds.keys()];
	const out = new Set<string>();
	for (const t of list.tasks) {
		const ran = t.status !== "todo" && !(t.status === "abandoned" && !t.startedAt && !t.blocks?.length);
		if (roots.some((r) => t.id === r || (ran && t.id.startsWith(`${r}.`)))) out.add(t.id);
	}
	return out;
}

/** Tokens of each of `list`'s tasks that owns folded Taskfold groups, summed over its parts. */
export function foldedTaskTokens(list: TaskList, truth: Truth): Map<string, FoldTokens> {
	const out = new Map<string, FoldTokens>();
	for (const g of truth.groups) {
		if (!g.folded) continue;
		const key = taskKeyOfSummary(g.digest);
		if (!key?.startsWith(`${list.slug}/`)) continue;
		const id = key.slice(list.slug.length + 1);
		const f = out.get(id) ?? { full: 0, live: 0 };
		f.full += truth.calibratedGroupFullTokens(g);
		f.live += truth.calibratedGroupLiveTokens(g);
		out.set(id, f);
	}
	return out;
}

/** Tokens of this session's spans for `list`: at full size, and as sent now (folded groups at their summary). */
export function taskSpanTokens(list: TaskList, truth: Truth): { full: number; live: number } | null {
	const blocks = truth.blocks;
	const spans = scanTaskSpans(blocks, (b) => b.text).filter((s) => s.list === list.slug);
	if (!spans.length) return null;
	const covered = new Set<number>();
	for (const s of spans) for (let i = s.start; i <= s.end; i++) covered.add(i);
	let full = 0;
	let live = 0;
	const seenGroups = new Set<string>();
	for (const i of covered) {
		const b = blocks[i];
		const g = truth.groupOf(b);
		if (g?.folded) {
			if (seenGroups.has(g.id)) continue;
			seenGroups.add(g.id);
			full += truth.calibratedGroupFullTokens(g);
			live += truth.calibratedGroupLiveTokens(g);
		} else {
			full += truth.calBlockTokens(b, b.tokens);
			live += truth.calBlockTokens(b, truth.effTokens(b));
		}
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
		if (!m) {
			this.hits = [];
			return [];
		}
		const out = renderTaskWidget(m, this.view, width, this.theme, Date.now(), this.blinkOn);
		this.hits = out.hits;
		return out.lines;
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
	session(): string | null;
	truth(): Truth | null;
	/** Whether the attached conductor provides the `tasks` tool. */
	enabled(): boolean;
	settings(): TaskWidgetSettings;
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
	private installed: TaskWidgetComponent | null = null;
	private installing = false;
	private hidden = false;
	private view: TaskWidgetView;
	private cache: { key: string; model: TaskWidgetModel } | null = null;

	constructor(private readonly deps: TaskWidgetDeps) {
		this.view = this.freshView();
	}

	private freshView(): TaskWidgetView {
		const s = this.deps.settings();
		return { expanded: s.expanded, maxRows: s.maxRows, toggles: new Map(), revealed: new Set() };
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
		try {
			this.list = session ? pickTaskList(this.deps.lists(), session) : null;
		} catch {
			this.list = null;
		}
		this.cache = null;
		this.sync();
	}

	/** Show, hide or redraw for the current state; cheap, safe to call on every change. */
	sync(): void {
		const want = !!this.ui && !this.hidden && !!this.list && this.deps.settings().mode === "auto" && this.deps.enabled();
		if (want && !this.installed && !this.installing) {
			this.installing = true;
			try {
				this.ui!.setWidget(
					WIDGET_KEY,
					(tui, theme) => {
						this.installed?.dispose();
						this.installed = new TaskWidgetComponent(tui, theme, () => this.model(), this.view, (expanded) => this.deps.saveExpanded(expanded));
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

	/** Expand or collapse; shows the widget again if it was hidden. */
	toggle(): void {
		if (this.hidden) this.hidden = false;
		else {
			this.view.expanded = !this.view.expanded;
			this.deps.saveExpanded(this.view.expanded);
		}
		this.sync();
	}

	setExpanded(expanded: boolean): void {
		this.hidden = false;
		if (this.view.expanded !== expanded) this.deps.saveExpanded(expanded);
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
		if (!this.list) return "this session holds no task list yet";
		if (this.hidden) return "the task widget is hidden in this session";
		return null;
	}

	detach(): void {
		this.remove();
		this.ui = null;
		this.list = null;
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
		const key = `${list.slug}|${list.updatedAt}|${truth?.rev ?? -1}|${truth?.blocks.length ?? 0}`;
		if (this.cache?.key === key) return this.cache.model;
		const foldTokens = truth ? foldedTaskTokens(list, truth) : new Map<string, FoldTokens>();
		const model: TaskWidgetModel = { list, folded: foldedTaskIds(list, foldTokens), foldTokens, tokens: truth ? taskSpanTokens(list, truth) : null };
		this.cache = { key, model };
		return model;
	}
}
