/*
 * taskLists.ts — task list rows for the panel's Lists tab, and the dialog that offers a resumed
 * session its previous list back. Rendering is pure; the dialog only holds selection and input state.
 */
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { claimState, type ClaimState, type TaskList } from "../tasks";
import { holderLabel, type ResumeSituation } from "../taskBinding";
import { buildTaskTree, summarizeTasks } from "./taskTree";
import { formatDuration, type WidgetTheme } from "./taskWidget";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
const ELLIPSIS = "…";

/** What the list surfaces need from the extension. Every action returns a message for the status line. */
export interface TaskListsHost {
	lists(): TaskList[];
	/** Invalid list slugs, read only when the browser reloads. */
	invalid?(): readonly string[];
	session(): string;
	/** Attach `slug` to this session (claiming it, `force` takes over a live foreign claim). */
	attach(slug: string, force: boolean): { ok: true; list: TaskList; message: string } | { ok: false; message: string };
	release(slug: string): { ok: boolean; message: string };
	/** Create and attach a new empty list with its goal. */
	create(title: string, goal: string): { ok: true; list: TaskList; message: string } | { ok: false; message: string };
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
export function progressText(list: TaskList, theme: WidgetTheme, withCurrent: boolean): string {
	const sum = summarizeTasks(buildTaskTree(list.tasks), new Set(), Date.now());
	if (!sum.total) return theme.fg("dim", "empty");
	const count = `${sum.done}/${sum.total}`;
	if (sum.allFinished) return theme.fg("success", `✓ ${count}`);
	const cur = sum.current?.task;
	const head = sum.done ? theme.fg("success", `▣ ${count}`) : theme.fg("dim", `☐ ${count}`);
	return cur && withCurrent ? `${head} ${theme.fg("warning", "▶")} ${theme.fg("muted", cur.id)} ${clean(cur.title)}` : head;
}

/** `this session`, `free`, `held · session 01a1aa4a "x" · 3m`, `stale · …` */
export function claimText(list: TaskList, state: ClaimState, theme: WidgetTheme, now: number): string {
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
	const mark = selected ? theme.fg("accent", "→") : " ";
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
export function frame(title: string, body: string[], status: string, hints: string, width: number, theme: WidgetTheme): string[] {
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
export function editText(state: { text: string }, data: string, max = 120): boolean {
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
	private confirmIndex = 0;
	private creating = false;
	private createTitle = "";
	private input = { text: "" };
	private readonly choices: ResumeChoice[];

	constructor(
		private readonly tui: Tui,
		private readonly theme: WidgetTheme,
		private readonly keys: Keys,
		private readonly situation: ResumeSituation,
		private readonly done: Done<{ choice: ResumeChoice; title?: string; goal?: string }>,
		/** Why the dialog is shown again, e.g. a reclaim that failed. */
		private message = "",
	) {
		this.choices = resumeChoices(situation);
	}

	render(width: number): string[] {
		const t = this.theme;
		const title = "Accordion › This session's task list";
		if (this.creating) return frame(`${title} › New list`, [this.createTitle ? ` Goal: ${clean(this.input.text)}█` : ` Title: ${clean(this.input.text)}█`], this.message, this.createTitle ? "type goal · enter create · esc back" : "type title · enter next · esc back", width, t);
		if (this.confirming && this.situation.kind === "held" && this.situation.holder) {
			const options = [`Leave it with ${holderLabel(this.situation.holder)}`, `Take over "${this.situation.slug}"`];
			const body = [` Take over "${this.situation.slug}" from ${holderLabel(this.situation.holder)}?`, " That session loses its claim; its agent can no longer change the list.", "", ...options.map((o, i) => (i === this.confirmIndex ? `${t.fg("accent", "→")} ${t.bold(o)}` : `  ${o}`))];
			return frame(`${title} › Take over`, body, this.message, "↑↓ select · enter choose · esc back", width, t);
		}
		const body = [
			` ${this.situation.kind === "missing" ? "The task list this session used is gone." : "Reattach the task list this session used before?"}`,
			...resumeInfo(this.situation, t, Date.now()),
			"",
			...this.choices.map((c, i) => (i === this.index ? `${t.fg("accent", "→")} ${t.bold(choiceLabel(c, this.situation))}` : `  ${choiceLabel(c, this.situation)}`)),
		];
		return frame(title, body, this.message, "↑↓ select · enter choose · esc continue without", width, t);
	}

	handleInput(data: string): void {
		const k = this.keys;
		const cancel = k.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c");
		const confirm = k.matches(data, "tui.select.confirm");
		if (this.creating) {
			if (cancel) this.creating = false;
			else if (confirm && this.input.text.trim() && !this.createTitle) { this.createTitle = this.input.text.trim(); this.input.text = ""; }
			else if (confirm && this.input.text.trim()) return this.done({ choice: "create", title: this.createTitle, goal: this.input.text.trim() });
			else editText(this.input, data);
			return this.tui.requestRender();
		}
		if (this.confirming) {
			if (cancel || (confirm && this.confirmIndex === 0)) this.confirming = false;
			else if (confirm) return this.done({ choice: "reclaim" });
			else if (k.matches(data, "tui.select.up") || k.matches(data, "tui.select.down")) this.confirmIndex = 1 - this.confirmIndex;
			return this.tui.requestRender();
		}
		if (cancel) return this.done({ choice: "without" });
		if (k.matches(data, "tui.select.up")) this.index = Math.max(0, this.index - 1);
		else if (k.matches(data, "tui.select.down")) this.index = Math.min(this.choices.length - 1, this.index + 1);
		else if (confirm) {
			const choice = this.choices[this.index];
			if (choice === "reclaim" && this.situation.kind === "held") {
				this.confirming = true;
				this.confirmIndex = 0;
			}
			else if (choice === "create") {
				this.createTitle = "";
				this.input = { text: "" };
				this.creating = true;
			} else return this.done({ choice });
		}
		this.message = "";
		this.tui.requestRender();
	}

	invalidate(): void {}
}
