/*
 * taskLists.ts — the interactive task list surfaces: the project's list browser
 * (`/accordion tasks lists`) and the dialog that offers a resumed session its previous list back.
 * Rendering is pure; the components only hold selection and input state and call the host.
 */
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { claimState, type ClaimState, type TaskList } from "../tasks";
import { holderLabel, type AttachOutcome, type ResumeSituation } from "../taskBinding";
import { buildTaskTree, summarizeTasks } from "./taskTree";
import { formatDuration, renderTaskWidget, type WidgetTheme } from "./taskWidget";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
const ELLIPSIS = "…";

/** What the list surfaces need from the extension. Every action returns a message for the status line. */
export interface TaskListsHost {
	lists(): TaskList[];
	session(): string;
	/** Attach `slug` to this session (claiming it, `force` takes over a live foreign claim). */
	attach(slug: string, force: boolean): { ok: true; list: TaskList; message: string } | { ok: false; message: string };
	release(slug: string): { ok: boolean; message: string };
	/** Create and attach a new empty list titled `title`. */
	create(title: string): { ok: true; list: TaskList; message: string } | { ok: false; message: string };
}

interface Keys {
	matches(data: string, binding: string): boolean;
}

interface Tui {
	requestRender(): void;
}

type Done<T> = (value: T) => void;

/** `40s`, `12m`, `3h`, `2d` — coarse age of a timestamp. */
export function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

/** `▣ 5/20 · ▶ 3.4.1 Title`, `✓ 20/20`, `☐ 0/3` — progress and the task in progress. */
function progressText(list: TaskList, theme: WidgetTheme, withCurrent: boolean): string {
	const sum = summarizeTasks(buildTaskTree(list.tasks), new Set(), Date.now());
	if (!sum.total) return theme.fg("dim", "empty");
	const count = `${sum.done}/${sum.total}`;
	if (sum.allFinished) return theme.fg("success", `✓ ${count}`);
	const cur = sum.current?.task;
	const head = sum.done ? theme.fg("success", `▣ ${count}`) : theme.fg("dim", `☐ ${count}`);
	return cur && withCurrent ? `${head} ${theme.fg("warning", "▶")} ${theme.fg("muted", cur.id)} ${clean(cur.title)}` : head;
}

/** `this session`, `free`, `held · session 01a1aa4a "x" · 3m`, `stale · …` */
function claimText(list: TaskList, state: ClaimState, theme: WidgetTheme, now: number): string {
	if (state === "mine") return theme.fg("accent", "this session");
	if (state === "free" || !list.claim) return theme.fg("dim", "free");
	const who = `${holderLabel(list.claim)} · ${formatAge(now - Date.parse(list.claim.at))}`;
	return state === "held" ? theme.fg("warning", `held · ${who}`) : theme.fg("dim", `stale · ${who}`);
}

/** Pad or cut to exactly `w` columns. */
function cell(text: string, w: number): string {
	const t = truncateToWidth(text, w, ELLIPSIS);
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

/**
 * One browser row: identity, progress and claim survive; age and title drop first when narrow.
 * `slugWidth` aligns rows (the longest slug shown); the slug is cut only beyond 28 columns.
 */
export function listRowLine(list: TaskList, session: string, selected: boolean, width: number, theme: WidgetTheme, now: number, slugWidth = list.slug.length): string {
	const state = claimState(list, session, now);
	const mark = selected ? theme.fg("accent", "›") : " ";
	const dot = state === "mine" ? theme.fg("accent", "●") : theme.fg("dim", "○");
	const slugW = Math.min(28, slugWidth);
	const slug = selected ? theme.bold(cell(list.slug, slugW)) : cell(list.slug, slugW);
	const head = `${mark} ${dot} ${slug} ${cell(progressText(list, theme, false), 7)} `;
	const age = theme.fg("dim", ` · ${formatAge(now - Date.parse(list.updatedAt))}`);
	const title = theme.fg("dim", ` · ${clean(list.title)}`);
	const claim = claimText(list, state, theme, now);
	const short = state === "mine" ? theme.fg("accent", "yours") : state === "held" ? theme.fg("warning", "held") : theme.fg("dim", state);
	for (const tail of [claim + age + title, claim + age, claim, short]) if (visibleWidth(head + tail) <= width) return head + tail;
	return truncateToWidth(head + short, width, ELLIPSIS);
}

/** Frame lines around a body: rule, title, body, rule, status, hints. */
function frame(title: string, body: string[], status: string, hints: string, width: number, theme: WidgetTheme): string[] {
	const rule = theme.fg("dim", "─".repeat(Math.max(0, width)));
	return [
		rule,
		truncateToWidth(` ${theme.fg("accent", title)}`, width, ELLIPSIS),
		...body.map((l) => truncateToWidth(l, width, ELLIPSIS)),
		rule,
		truncateToWidth(status ? ` ${status}` : "", width, ELLIPSIS),
		truncateToWidth(` ${theme.fg("dim", hints)}`, width, ELLIPSIS),
	];
}

/** Line-editing for a short text field; returns true when the key was consumed. */
function editText(state: { text: string }, data: string, max = 120): boolean {
	if (matchesKey(data, "backspace")) {
		state.text = state.text.slice(0, -1);
		return true;
	}
	const key = decodeKittyPrintable(data) ?? data;
	if (key.length === 1 && key >= " " && key !== "\x7f" && state.text.length < max) {
		state.text += key;
		return true;
	}
	return false;
}

type BrowserMode = "manage" | "pick";

/**
 * The project's task lists. In `manage` mode the user browses, opens, attaches, releases and creates
 * lists until Esc. In `pick` mode attaching or creating a list closes the browser with that outcome.
 */
export class TaskListsBrowser {
	private lists: TaskList[] = [];
	private index = 0;
	private screen: "list" | "detail" | "confirm" | "create" = "list";
	private scroll = 0;
	private input = { text: "" };
	private message = "";

	constructor(
		private readonly tui: Tui,
		private readonly theme: WidgetTheme,
		private readonly keys: Keys,
		private readonly host: TaskListsHost,
		private readonly mode: BrowserMode,
		private readonly done: Done<AttachOutcome | null>,
		private readonly rows: () => number,
	) {
		this.reload();
	}

	private reload(): void {
		const slug = this.lists[this.index]?.slug;
		this.lists = this.host.lists();
		const at = slug ? this.lists.findIndex((l) => l.slug === slug) : -1;
		this.index = Math.max(0, Math.min(at >= 0 ? at : this.index, this.lists.length - 1));
	}

	private get selected(): TaskList | undefined {
		return this.lists[this.index];
	}

	render(width: number): string[] {
		const t = this.theme;
		const now = Date.now();
		const session = this.host.session();
		const bodyRows = Math.max(4, Math.min(18, this.rows() - 8));
		const sel = this.selected;
		if (this.screen === "create") {
			return frame("Accordion › Task lists › New list", [` Title: ${clean(this.input.text)}█`, t.fg("dim", " The slug is derived from the title.")], this.message, "type title · enter create · esc back", width, t);
		}
		if (this.screen === "confirm" && sel?.claim) {
			const body = [
				` ${t.fg("warning", "▲")} "${sel.slug}" is claimed by ${holderLabel(sel.claim)}, active ${formatAge(now - Date.parse(sel.claim.at))} ago.`,
				" Taking it over makes that session lose the claim: its agent can no longer change the list.",
			];
			return frame("Accordion › Task lists › Take over", body, this.message, "enter take over · esc back", width, t);
		}
		if (this.screen === "detail" && sel) {
			const tree = renderTaskWidget({ list: sel, folded: new Set(), tokens: null }, { expanded: true, maxRows: 500, toggles: new Map(), revealed: new Set() }, width, t, now, true).lines.slice(1);
			const head = [` ${clean(sel.title)}`, ` ${progressText(sel, t, true)} · ${claimText(sel, claimState(sel, session, now), t, now)}`];
			const room = Math.max(1, bodyRows - head.length);
			this.scroll = Math.max(0, Math.min(this.scroll, tree.length - room));
			const body = [...head, ...tree.slice(this.scroll, this.scroll + room)];
			return frame(`Accordion › Task lists › ${sel.slug}`, body, this.message, `↑↓ scroll · ${this.actionHints(sel)} · esc back`, width, t);
		}
		const start = Math.max(0, Math.min(this.index - Math.floor(bodyRows / 2), this.lists.length - bodyRows));
		const slugWidth = Math.max(0, ...this.lists.map((l) => l.slug.length));
		const body = this.lists.length
			? this.lists.slice(start, start + bodyRows).map((l, i) => listRowLine(l, session, start + i === this.index, width, t, now, slugWidth))
			: [t.fg("dim", "   No task lists in this project yet. Press n to start one.")];
		const count = `${this.lists.length} list${this.lists.length === 1 ? "" : "s"}`;
		const title = this.mode === "pick" ? "Accordion › Choose a task list" : "Accordion › Task lists";
		const hints = sel ? `↑↓ select · enter ${this.mode === "pick" ? "attach" : "open"} · ${this.actionHints(sel)} · n new · esc ${this.mode === "pick" ? "back" : "close"}` : "n new · esc close";
		return frame(`${title} · ${count}`, body, this.message, hints, width, t);
	}

	private actionHints(list: TaskList): string {
		const state = claimState(list, this.host.session());
		return state === "mine" ? "r release" : state === "held" ? "c take over" : "c attach";
	}

	handleInput(data: string): void {
		const k = this.keys;
		const cancel = k.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c");
		const confirm = k.matches(data, "tui.select.confirm");
		const up = k.matches(data, "tui.select.up");
		const down = k.matches(data, "tui.select.down");
		const key = decodeKittyPrintable(data) ?? data;
		if (this.screen === "create") {
			if (cancel) this.screen = "list";
			else if (confirm) {
				const r = this.host.create(this.input.text.trim());
				this.message = r.message;
				if (r.ok) {
					if (this.mode === "pick") return this.done({ kind: "created", list: r.list });
					this.reload();
					this.index = Math.max(0, this.lists.findIndex((l) => l.slug === r.list.slug));
					this.screen = "list";
				}
			} else editText(this.input, data);
			return this.tui.requestRender();
		}
		if (this.screen === "confirm") {
			if (cancel) this.screen = "list";
			else if (confirm) this.attach(true);
			return this.tui.requestRender();
		}
		this.message = "";
		const sel = this.selected;
		if (cancel) {
			if (this.screen === "detail") this.screen = "list";
			else return this.done(null);
		} else if (up) {
			if (this.screen === "detail") this.scroll = Math.max(0, this.scroll - 1);
			else this.index = Math.max(0, this.index - 1);
		} else if (down) {
			if (this.screen === "detail") this.scroll++;
			else this.index = Math.min(this.lists.length - 1, this.index + 1);
		} else if (key === "n") {
			this.input = { text: "" };
			this.screen = "create";
		} else if (sel && (key === "c" || (confirm && this.mode === "pick" && this.screen === "list"))) {
			if (claimState(sel, this.host.session()) === "held") this.screen = "confirm";
			else this.attach(false);
		} else if (sel && key === "r") {
			const r = this.host.release(sel.slug);
			this.message = r.message;
			this.reload();
		} else if (sel && confirm && this.screen === "list") {
			this.scroll = 0;
			this.screen = "detail";
		}
		this.tui.requestRender();
	}

	private attach(force: boolean): void {
		const sel = this.selected;
		if (!sel) return;
		const r = this.host.attach(sel.slug, force);
		this.message = r.message;
		if (r.ok && this.mode === "pick") return this.done({ kind: "replaced", list: r.list });
		this.screen = this.screen === "confirm" ? "list" : this.screen;
		this.reload();
	}

	invalidate(): void {}
}

/** The resume dialog's choices for a situation, in display order. */
export type ResumeChoice = "reclaim" | "pick" | "create" | "without";

export function resumeChoices(situation: ResumeSituation): ResumeChoice[] {
	return situation.kind === "missing" ? ["pick", "create", "without"] : ["reclaim", "pick", "create", "without"];
}

function choiceLabel(choice: ResumeChoice, situation: ResumeSituation): string {
	switch (choice) {
		case "reclaim":
			return situation.kind === "held" && situation.holder ? `Take over "${situation.slug}" from ${holderLabel(situation.holder)}` : `Reclaim "${situation.slug}"`;
		case "pick":
			return "Choose another list…";
		case "create":
			return "Start a new list…";
		case "without":
			return "Continue without a task list";
	}
}

/** The dialog's information lines about the previous list. */
export function resumeInfo(situation: ResumeSituation, theme: WidgetTheme, now: number): string[] {
	if (situation.kind === "missing") return [` ${theme.fg("warning", "▲")} "${situation.slug}" no longer exists in this project.`];
	const l = situation.list;
	const lines = [` ${theme.bold(situation.slug)} ${theme.fg("dim", `— ${clean(l.title)}`)}`, ` ${progressText(l, theme, true)} ${theme.fg("dim", `· updated ${formatAge(now - Date.parse(l.updatedAt))} ago`)}`];
	const sum = summarizeTasks(buildTaskTree(l.tasks), new Set(), now);
	if (sum.durationMs !== null) lines[1] += theme.fg("dim", ` · ${formatDuration(sum.durationMs)} worked`);
	if (situation.changed) lines.push(` ${theme.fg("warning", "▲ its tasks changed since this session last used it")}`);
	if (situation.kind === "held" && situation.holder)
		lines.push(` ${theme.fg("warning", `▲ currently claimed by ${holderLabel(situation.holder)}, active ${formatAge(now - Date.parse(situation.holder.at))} ago`)}`);
	if (situation.kind === "stale" && situation.holder) lines.push(` ${theme.fg("dim", `claimed by ${holderLabel(situation.holder)}, idle ${formatAge(now - Date.parse(situation.holder.at))}; free to reclaim`)}`);
	return lines;
}

/**
 * Offers a resumed session its previous task list and closes with the user's choice; the caller
 * carries it out and reopens the dialog with a message when it fails. Taking over a list another
 * session holds is confirmed here first.
 */
export class ResumeDialog {
	private index = 0;
	private confirming = false;
	private creating = false;
	private input = { text: "" };
	private readonly choices: ResumeChoice[];

	constructor(
		private readonly tui: Tui,
		private readonly theme: WidgetTheme,
		private readonly keys: Keys,
		private readonly situation: ResumeSituation,
		private readonly done: Done<{ choice: ResumeChoice; title?: string }>,
		/** Why the dialog is shown again, e.g. a reclaim that failed. */
		private message = "",
	) {
		this.choices = resumeChoices(situation);
	}

	render(width: number): string[] {
		const t = this.theme;
		const title = "Accordion › This session's task list";
		if (this.creating) return frame(`${title} › New list`, [` Title: ${clean(this.input.text)}█`], this.message, "type title · enter create · esc back", width, t);
		if (this.confirming && this.situation.kind === "held" && this.situation.holder) {
			const body = [` Take over "${this.situation.slug}" from ${holderLabel(this.situation.holder)}?`, " That session loses its claim; its agent can no longer change the list."];
			return frame(`${title} › Take over`, body, this.message, "enter take over · esc back", width, t);
		}
		const body = [
			` ${this.situation.kind === "missing" ? "The task list this session used is gone." : "Reattach the task list this session used before?"}`,
			...resumeInfo(this.situation, t, Date.now()),
			"",
			...this.choices.map((c, i) => (i === this.index ? `${t.fg("accent", "›")} ${t.bold(choiceLabel(c, this.situation))}` : `  ${choiceLabel(c, this.situation)}`)),
		];
		return frame(title, body, this.message, "↑↓ select · enter choose · esc continue without", width, t);
	}

	handleInput(data: string): void {
		const k = this.keys;
		const cancel = k.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c");
		const confirm = k.matches(data, "tui.select.confirm");
		if (this.creating) {
			if (cancel) this.creating = false;
			else if (confirm && this.input.text.trim()) return this.done({ choice: "create", title: this.input.text.trim() });
			else editText(this.input, data);
			return this.tui.requestRender();
		}
		if (this.confirming) {
			if (cancel) this.confirming = false;
			else if (confirm) return this.done({ choice: "reclaim" });
			return this.tui.requestRender();
		}
		if (cancel) return this.done({ choice: "without" });
		if (k.matches(data, "tui.select.up")) this.index = Math.max(0, this.index - 1);
		else if (k.matches(data, "tui.select.down")) this.index = Math.min(this.choices.length - 1, this.index + 1);
		else if (confirm) {
			const choice = this.choices[this.index];
			if (choice === "reclaim" && this.situation.kind === "held") this.confirming = true;
			else if (choice === "create") {
				this.input = { text: "" };
				this.creating = true;
			} else return this.done({ choice });
		}
		this.message = "";
		this.tui.requestRender();
	}

	invalidate(): void {}
}
