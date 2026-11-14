/*
 * overview.ts — the panel's landing tab (SPEC-0001 §5.3).
 *
 * One screen that answers "how full is the context, what has folding saved, is the conductor
 * healthy, and where is the web UI" without leaving the frame. Numbers come from the same
 * breakdown the Context tab draws, so the two can never disagree.
 */
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { bindingHint, clean, fitSegments, rawHint } from "../chrome";
import { buildContextBreakdown, formatCompactTokens, renderCategoryBar } from "../map";
import { statusLevel } from "../status";
import { buildTaskTree, summarizeTasks } from "../taskTree";
import { foldedTaskIds, foldedTaskTokens } from "../taskWidget";
import { openCompactPreview } from "./compact";
import type { PanelTab, Shell } from "./types";
import type { TaskList } from "../../tasks";

/** `done/total` for one list, or null when it has no tasks. */
export function listProgress(list: TaskList): string | null {
	const tasks = list.tasks ?? [];
	if (!tasks.length) return null;
	const done = tasks.filter((t) => t.status === "done").length;
	return `${done}/${tasks.length}`;
}

/** The `source` column for the Pressure row, from the attached conductor's own high-water option. */
export function pressureText(opts: { folding: boolean; high: number | null; budget: number; threshold: string }): string {
	if (!opts.folding) return "folding off: pi compacts natively";
	const parts: string[] = [];
	if (opts.high !== null && opts.budget > 0) parts.push(`folds start at ${Math.round(opts.high * 100)}% (${formatCompactTokens(Math.round(opts.high * opts.budget))})`);
	parts.push(`pi auto-compact: accordion ${opts.threshold}`);
	return parts.join(" · ");
}

/** The Tasks row: `<title> <done>/<total> · ≡<folded> · <current id and title>`, parts that do not apply left out. */
export function tasksRowText(list: TaskList, folded: ReadonlySet<string>, now: number): string | null {
	const summary = summarizeTasks(buildTaskTree(list.tasks ?? []), folded, now);
	if (!summary.total) return null;
	const current = summary.current?.task;
	return [`${clean(list.title)} ${summary.done}/${summary.total}`, summary.folded > 0 ? `≡${summary.folded}` : "", current ? `${current.id} ${clean(current.title)}` : ""].filter(Boolean).join(" · ");
}

export function createOverviewTab(shell: Shell): PanelTab {
	const host = shell.host;
	/** Which row Enter opens; Tasks is selectable only while its row is shown. */
	let focus: "context" | "tasks" = "context";
	const line = (label: string, value: string, width: number, mark = " "): string => {
		const theme = shell.theme();
		return fitSegments([`${mark} ${theme.fg("muted", label.padEnd(10))}${value}`], width);
	};
	const wrapped = (text: string, width: number, max: number): string[] => {
		const room = Math.max(1, width - 2);
		const lines: string[] = [];
		let current = "";
		for (const word of clean(text).replace(/\s+/g, " ").trim().split(" ")) {
			if (!current) current = word;
			else if (visibleWidth(`${current} ${word}`) <= room) current += ` ${word}`;
			else {
				lines.push(current);
				current = word;
				if (lines.length === max) break;
			}
		}
		if (lines.length < max && current) lines.push(current);
		return lines.slice(0, max).map((l) => `  ${fitSegments([l], room)}`);
	};
	/** The list the Tasks row shows, with its row text. */
	const tasksRow = (truth: NonNullable<ReturnType<typeof host.truth>>): string | null => {
		const lists = host.tasks?.views.lists?.() ?? [];
		const list = lists.find((l) => listProgress(l)) ?? lists[0];
		if (!list) return null;
		return tasksRowText(list, foldedTaskIds(list, foldedTaskTokens(list, truth)), Date.now());
	};

	return {
		id: "overview",
		title: "Overview",
		view(width) {
			const theme = shell.theme();
			const truth = host.truth();
			const body: string[] = [];
			if (!truth) {
				body.push(theme.fg("dim", "  No session model yet."));
				return { body, crumbs: [], description: "The context is read once the session sends its first request.", hints: [], above: 0, below: 0 };
			}
			const bd = buildContextBreakdown(truth);
			const stats = truth.stats();
			body.push(...renderCategoryBar(truth, width, (text) => theme.fg("dim", text)));
			body.push("");
			if (bd.savedTokens > 0) {
				const folded = truth.blocks.filter((b) => truth.isFolded(b)).length;
				const tail = stats.protectTokens > 0 ? ` · tail ${formatCompactTokens(stats.protectTokens)} protected` : "";
				body.push(line("Saved", `−${formatCompactTokens(bd.savedTokens)} (${bd.savedPct}%) · ${folded} blocks folded · ${truth.groups.length} groups${tail}`, width));
			}
			const conductor = host.activeConductor();
			const options = conductor ? host.conductorOptions?.(conductor.id) : undefined;
			const high = typeof options?.["high"] === "number" ? (options["high"] as number) : null;
			body.push(line("Pressure", pressureText({ folding: host.folding(), high, budget: stats.budget, threshold: host.compactThreshold?.() ?? "pass" }), width));
			body.push("");
			const level = statusLevel(host.conductorStatus?.()?.metrics);
			const glyph = level === "error" ? theme.fg("error", "✗ error") : level === "warning" ? theme.fg("warning", "▲ warning") : theme.fg("success", "✓ healthy");
			body.push(line("Conductor", conductor ? `${clean(conductor.label).padEnd(18)} ${glyph}` : theme.fg("dim", "none attached"), width));
			const statusText = host.conductorStatus?.()?.text;
			if (conductor && statusText) body.push(...wrapped(statusText, width, 2));
			const tasksText = tasksRow(truth);
			if (!tasksText) focus = "context";
			else body.push(line("Tasks", focus === "tasks" ? theme.bold(tasksText) : tasksText, width, focus === "tasks" ? theme.fg("accent", "→") : " "));
			const web = host.webInfo?.();
			if (web?.url) {
				const clients = `${web.clients} client${web.clients === 1 ? "" : "s"}${web.doorPort ? ` · door ${web.doorPort}` : ""}`;
				body.push(line("Web UI", `${web.url}  ${theme.fg("dim", clients)}`, width));
			}
			return {
				body,
				crumbs: [],
				description: "The session's context, its savings and its conductor. Enter opens the timeline.",
				hints: [
					bindingHint(theme, shell.keys(), "tui.select.confirm", "enter", focus === "tasks" ? "tasks" : "context", 1),
					...(tasksText ? [rawHint(theme, "↑↓", "row", 5)] : []),
					rawHint(theme, "alt+c", "compact", 2),
					rawHint(theme, "alt+o", "folding on/off", 3),
					...(host.tasks ? [rawHint(theme, "alt+t", "tasks", 4)] : []),
				],
				above: 0,
				below: 0,
			};
		},
		key(data) {
			if (matchesKey(data, "return") || data === "\r") {
				shell.openTab?.(focus);
				return true;
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const truth = host.truth();
				if (!truth || !tasksRow(truth)) return false;
				focus = focus === "context" ? "tasks" : "context";
				return true;
			}
			if (matchesKey(data, "alt+o")) {
				void shell.send({ kind: "setFolding", value: !host.folding() });
				return true;
			}
			if (matchesKey(data, "alt+t") && host.tasks) {
				shell.openTab?.("tasks");
				return true;
			}
			if (matchesKey(data, "alt+c")) {
				openCompactPreview(shell);
				return true;
			}
			return false;
		},
		typing: () => false,
		query: () => null,
		setFilter() {},
		back: () => false,
		dirty: () => 0,
		discard() {},
		legend: () => [
			"Saved counts every folded block against its full size; the tail is never folded by a pass.",
			"Pressure names the attached conductor's high-water option and how pi's own compaction is handled.",
		],
	};
}
