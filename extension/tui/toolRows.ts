/*
 * toolRows.ts — one-line transcript rows for Accordion's agent tools (`tasks`, `unfold`, `recall`):
 *
 *   ✓ tasks start 3.2 Watch config.json
 *   ✗ tasks start 4 · Task 3 "Settings sync" is still in progress…
 *
 * The line builders are pure; `toolRowRenderers` adapts them to Pi's self-shell tool renderers.
 */
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { blockLabel, type Renumbering, type TaskBlock, type TaskList, type TaskStatus } from "../tasks";
import { taskDuration } from "./taskTree";
import { formatDuration, type WidgetTheme } from "./taskWidget";

/** What a successful `tasks` call reports for its row. */
export interface TasksDetails {
	action: string;
	list?: string;
	task?: {
		id: string;
		title: string;
		status: TaskStatus;
		startedAt?: string;
		endedAt?: string;
		report?: { outcome: string; decisions?: string[]; open?: string[] };
		blocks?: TaskBlock[];
		supersededBy?: string;
	};
	/** Done / total tasks in the list after the call. */
	progress?: { done: number; total: number };
	/** Tasks added by `add`, or created by `create`. */
	added?: number;
	/** Lists in the project, for `list`. */
	lists?: number;
	/** Ids that changed because `add` inserted or `move` moved unstarted tasks. */
	renumbered?: Renumbering[];
}

/** The structured row data for a finished `tasks` call, read back from the list it touched. */
export function tasksDetails(args: { action: string; list?: string; id?: string }, list: TaskList | null, added?: number, lists?: number, renumbered: readonly Renumbering[] = []): TasksDetails {
	const id = renumbered.find((r) => r.from === args.id)?.to ?? args.id;
	const task = id && list ? list.tasks.find((t) => t.id === id) : undefined;
	return {
		action: args.action,
		...(args.list ? { list: args.list } : {}),
		...(task
			? {
					task: {
						id: task.id,
						title: task.title,
						status: task.status,
						startedAt: task.startedAt,
						endedAt: task.endedAt,
						report: task.report,
						...(task.blocks?.length ? { blocks: task.blocks } : {}),
						...(task.supersededBy ? { supersededBy: task.supersededBy } : {}),
					},
				}
			: {}),
		...(list ? { progress: { done: list.tasks.filter((t) => t.status === "done").length, total: list.tasks.length } } : {}),
		...(added === undefined ? {} : { added }),
		...(lists === undefined ? {} : { lists }),
		...(renumbered.length ? { renumbered: [...renumbered] } : {}),
	};
}

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function textOf(content: readonly { type: string; text?: string }[] | undefined): string {
	return (content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

const TASK_ACTIONS = ["start", "block", "complete", "fail", "abandon"];

/** `tasks <action> <target>` for a call, from its arguments alone. */
function tasksTarget(args: Args): string {
	const action = str(args.action);
	const list = str(args.list);
	if (action === "list") return "list";
	if (action === "add") return `add ${list}${str(args.parent) ? ` ${str(args.parent)}` : ""}`;
	if (TASK_ACTIONS.includes(action) || action === "move") return `${action} ${str(args.id) || list}`;
	if (action === "update") return `update ${str(args.id) || list}`;
	return `${action}${list ? ` ${list}` : ""}`;
}

/** The row for a `tasks` call: pending, succeeded or failed. */
export function tasksRow(theme: WidgetTheme, args: Args, state: "pending" | "ok" | "error", details: TasksDetails | undefined, resultText: string, expanded: boolean): string[] {
	const glyph = state === "pending" ? theme.fg("dim", "…") : state === "ok" ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const head = `${glyph} ${theme.bold("tasks")} ${theme.fg("accent", tasksTarget(args))}`;
	if (state === "pending") return [head];
	if (state === "error") {
		const lines = [`${head}${theme.fg("dim", " · ")}${theme.fg("error", firstLine(resultText))}`];
		if (expanded) lines.push(...resultText.split("\n").slice(1).filter(Boolean).map((l) => theme.fg("dim", `  ${l}`)));
		return lines;
	}
	const action = str(args.action);
	const task = details?.task;
	const taskAction = TASK_ACTIONS.includes(action);
	// Rows from before details were recorded still carry the title in the result text.
	const title = taskAction ? (task?.title ?? /"(.*)"/.exec(firstLine(resultText))?.[1] ?? "") : action === "create" ? str(args.title) : "";
	const sep = theme.fg("dim", " · ");
	const extra: string[] = [];
	if (task && (action === "complete" || action === "fail" || action === "abandon")) {
		if (task.status !== "done") extra.push(theme.fg(task.status === "failed" ? "error" : "warning", task.status));
		if (task.supersededBy && action === "abandon") extra.push(theme.fg("dim", `→ ${task.supersededBy}`));
		const ms = task.endedAt ? taskDuration({ ...task, updatedAt: task.endedAt }, Date.parse(task.endedAt)) : null;
		if (task.startedAt && ms !== null) extra.push(theme.fg("dim", formatDuration(ms)));
	}
	const block = task?.blocks?.[task.blocks.length - 1];
	if (action === "block" && block) extra.push(theme.fg("warning", blockLabel(block)));
	if (action === "start" && block?.resumedAt) extra.push(theme.fg("dim", "resumed"));
	if (action === "create" && details?.progress) extra.push(theme.fg("dim", plural(details.progress.total, "task")));
	if (action === "add" && details?.added !== undefined) extra.push(theme.fg("dim", `+${plural(details.added, "task")}`));
	if ((action === "claim" || action === "status") && details?.progress) extra.push(theme.fg("dim", `${details.progress.done}/${details.progress.total} done`));
	if (action === "list" && details?.lists !== undefined) extra.push(theme.fg("dim", plural(details.lists, "list")));
	if (action === "move" && task) extra.push(theme.fg("dim", `→ ${task.id} ${task.title}`));
	if (details?.renumbered?.length && action !== "move") extra.push(theme.fg("dim", `renumbered ${details.renumbered.length}`));
	const titled = title ? ` ${title}` : "";
	const lines = [`${head}${titled}${extra.length ? sep + extra.join(sep) : ""}`];
	if (!expanded) return lines;
	const report = task?.report;
	if (action === "block" && block) lines.push(`  ${theme.fg("muted", "waits on")} ${block.detail}`);
	else if (report && action !== "start") {
		lines.push(`  ${theme.fg("muted", "outcome")}  ${report.outcome}`);
		for (const d of report.decisions ?? []) lines.push(`  ${theme.fg("muted", "decision")} ${d}`);
		for (const o of report.open ?? []) lines.push(`  ${theme.fg("muted", "open")}     ${o}`);
	} else if (action === "create" || action === "status" || action === "claim" || action === "list") {
		lines.push(...resultText.split("\n").slice(action === "list" ? 0 : 1).map((l) => theme.fg("dim", `  ${l}`)));
	}
	return lines;
}

/** The row for an `unfold` / `recall` call: the codes and what came back. */
export function foldToolRow(theme: WidgetTheme, tool: "unfold" | "recall", args: Args, state: "pending" | "ok" | "error", details: { restored?: unknown[]; missing?: unknown[] } | undefined, resultText: string, expanded: boolean): string[] {
	const codes = Array.isArray(args.codes) ? args.codes.map((c) => `#${String(c).trim()}`).join(" ") : "";
	const restored = details?.restored?.length ?? 0;
	const missing = details?.missing?.length ?? 0;
	const failed = state === "error" || (state === "ok" && details !== undefined && restored === 0);
	const glyph = state === "pending" ? theme.fg("dim", "…") : failed ? theme.fg("error", "✗") : missing ? theme.fg("warning", "▲") : theme.fg("success", "✓");
	const head = `${glyph} ${theme.bold(tool)} ${theme.fg("accent", codes)}`;
	if (state === "pending") return [head];
	const sep = theme.fg("dim", " · ");
	const facts = details
		? [restored ? `${restored} ${tool === "unfold" ? "unfolded" : "recalled"}` : "", missing ? theme.fg("warning", `${missing} not found`) : ""].filter(Boolean)
		: [firstLine(resultText)];
	const lines = [`${head}${facts.length ? sep + facts.join(sep) : ""}`];
	if (expanded) lines.push(...resultText.split("\n").map((l) => theme.fg("dim", `  ${l}`)));
	return lines;
}

/** The transcript row for a task list note sent to the agent: its first sentence, all of it expanded. */
export function noticeRow(theme: WidgetTheme, content: string, expanded: boolean): Text {
	const head = `${theme.fg("warning", "▲")} ${theme.bold("tasks")} ${theme.fg("dim", "note to the agent ·")} ${firstLine(content)}`;
	return new Lines(expanded ? [head, ...content.split("\n").map((l) => theme.fg("dim", `  ${l}`))] : [head], 1);
}

/** A Text that cuts its lines to the width instead of wrapping them; the row is one line by design. */
class Lines extends Text {
	constructor(private readonly rows: string[], private readonly pad: number) {
		super(rows.join("\n"), pad, 0);
	}
	override render(width: number): string[] {
		const inner = Math.max(1, width - this.pad);
		return this.rows.map((r) => " ".repeat(this.pad) + truncateToWidth(r, inner, "…"));
	}
}

interface RenderContext {
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	outputPad?: number;
}
interface ToolResultLike {
	content: readonly { type: string; text?: string }[];
	details?: unknown;
}

/** Pi tool-definition renderers that draw a row with `build`. */
export function toolRowRenderers(build: (theme: WidgetTheme, args: Args, state: "pending" | "ok" | "error", details: unknown, text: string, expanded: boolean) => string[]) {
	const empty = () => new Text("", 0, 0);
	return {
		renderShell: "self" as const,
		renderCall(args: Args, theme: WidgetTheme, ctx: RenderContext) {
			return ctx.isPartial ? new Lines(build(theme, args ?? {}, "pending", undefined, "", false), ctx.outputPad ?? 1) : empty();
		},
		renderResult(result: ToolResultLike, opts: { expanded: boolean; isPartial: boolean }, theme: WidgetTheme, ctx: RenderContext & { args: Args }) {
			if (opts.isPartial) return empty();
			const state = ctx.isError ? "error" : "ok";
			return new Lines(build(theme, ctx.args ?? {}, state, result.details, textOf(result.content), opts.expanded), ctx.outputPad ?? 1);
		},
	};
}
