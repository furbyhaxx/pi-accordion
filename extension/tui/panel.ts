import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WireCommand } from "../../core/protocol";
import type { Op, OpResult } from "../../core/ops";
import { EMPTY_DIGEST, stripFoldTags } from "../../core/digest";
import { bindingHint, bodyRowsFor, type Chrome, type ChromeKeys, type ChromeTheme, clean, type Hint, makeChrome, rawHint, renderFrame } from "./chrome";
import type { AccordionTuiHost } from "./host";
import { formatCompactTokens } from "./map";
import { createConductorsTab } from "./screens/conductors";
import { createContextTab } from "./screens/context";
import { createOverviewTab } from "./screens/overview";
import { createSettingsTab } from "./screens/settings";
import { createListsTab, createTasksTab } from "./screens/tasks";
import type { ConfirmSpec, DigestAction, PanelTab, Shell } from "./screens/types";
import { statusLevel } from "./status";

/** The tabs of the panel, in bar order. */
export type PanelTabId = "overview" | "context" | "tasks" | "lists" | "conductors" | "settings";

type Level = "info" | "warning" | "error";
interface Note {
	text: string;
	level: Level;
}

function commandNote(result: { results: OpResult[]; refused?: "read-only" }): Note {
	if (result.refused === "read-only") return { text: "read-only: close and reopen /accordion to request control again", level: "warning" };
	const failures = result.results.flatMap((item) =>
		item.perId?.some((entry) => entry.reason)
			? item.perId.filter((entry) => entry.reason).map((entry) => `${entry.id}: ${entry.reason}`)
			: item.clamped
				? [item.clamped]
				: [],
	);
	return failures.length ? { text: `Refused: ${failures.join(", ")}`, level: "warning" } : { text: "Command sent", level: "info" };
}

/** Printable text, as opposed to a key sequence. */
function typed(data: string): string | null {
	const text = decodeKittyPrintable(data) ?? data;
	return text && !/[\x00-\x1f\x7f-\x9f]/.test(text) ? text : null;
}

/** Open the current session's interactive context panel in Pi's TUI. */
export async function openAccordionPanel(ctx: ExtensionContext, host: AccordionTuiHost, start: PanelTabId = "overview"): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	let theme: ChromeTheme = { fg: (_token, text) => text, bold: (text) => text };
	let keys: ChromeKeys = { matches: () => false };
	let chrome: { theme: ChromeTheme; level: string | null; value: Chrome } | null = null;
	let live = false;
	let requestRender = () => {};
	let leave: (action?: DigestAction) => void = () => {};
	let note: Note = { text: "", level: "info" };
	const failed = (what: string, error: unknown): Note => ({ text: `${what}: ${error instanceof Error ? error.message : String(error)}`, level: "error" });
	let pending = false;
	let readOnly = host.canSteer ? !host.canSteer() : false;
	let help = false;
	let helpTop = 0;
	let modal: (ConfirmSpec & { selected: number }) | null = null;
	let sizedFor = 0;
	let bodyRows = 0;
	const digestDrafts = new Map<string, string>();

	const update = () => {
		if (!live) return;
		if (host.canSteer && !host.canSteer()) readOnly = true;
		requestRender();
	};
	const shell: Shell = {
		host,
		theme: () => theme,
		keys: () => keys,
		readOnly: () => readOnly || (!!host.canSteer && !host.canSteer()),
		say: (text, level = "warning") => {
			note = { text, level };
			update();
		},
		send: async (command: WireCommand) => {
			if (pending) return shell.say("Command pending", "info");
			pending = true;
			shell.say("Command pending", "info");
			const from = leave;
			try {
				const result = await host.command(command);
				if (leave !== from || !live) return;
				if (result.refused === "read-only") readOnly = true;
				note = commandNote(result);
			} catch (error) {
				if (leave === from && live) note = failed("Command failed", error);
			} finally {
				pending = false;
				update();
			}
		},
		run: async (started, action) => {
			if (pending) return shell.say("Command pending", "info");
			pending = true;
			shell.say(started, "info");
			const from = leave;
			try {
				const text = await action();
				if (leave === from && live) note = { text, level: "info" };
			} catch (error) {
				if (leave === from && live) note = failed("Failed", error);
			} finally {
				pending = false;
				update();
			}
		},
		openTab: (id) => {
			const at = tabs.findIndex((tab) => tab.id === id);
			if (at >= 0) active = at;
		},
		confirm: (spec) => {
			modal = { ...spec, selected: 0 };
			update();
		},
		editDigest: (action) => leave(action),
		update,
	};
	const tabs: PanelTab[] = [createOverviewTab(shell), createContextTab(shell), ...(host.tasks ? [createTasksTab(shell, host.tasks), ...(host.tasks.lists ? [createListsTab(shell, host.tasks)] : [])] : []), createConductorsTab(shell), createSettingsTab(shell)];
	let active = Math.max(0, tabs.findIndex((tab) => tab.id === start));
	const staged = () => tabs.reduce((n, tab) => n + tab.dirty(), 0);

	const close = () => {
		const n = staged();
		if (!n) return leave();
		shell.confirm({
			crumb: "Discard",
			title: `Discard ${n} staged setting${n === 1 ? "" : "s"}?\nStaged values are lost; saved values are unchanged.`,
			options: ["Keep editing", "Discard changes"],
			then: (choice) => {
				if (choice !== 1) return;
				for (const tab of tabs) tab.discard();
				leave();
			},
		});
	};

	const state = (): string[] => {
		const stats = host.truth()?.stats();
		const conductor = host.activeConductor();
		const level = statusLevel(host.conductorStatus?.()?.metrics);
		const n = staged();
		return [
			shell.readOnly() ? theme.fg("warning", "READ-ONLY") : "",
			n ? theme.fg("warning", `▲ ${n} staged`) : "",
			stats ? theme.fg("dim", `${formatCompactTokens(stats.liveTokens)}/${formatCompactTokens(stats.budget)} tok`) : "",
			host.folding() ? theme.fg("accent", "● folding") : theme.fg("dim", "○ folding off"),
			conductor ? theme.fg(level === "info" ? "dim" : level, `${clean(conductor.label)} ${level === "error" ? "✗" : level === "warning" ? "▲" : "✓"}`) : theme.fg("dim", "no conductor"),
		].filter(Boolean);
	};

	const frameHints = (own: Hint[], filterable: boolean, drilled: boolean): Hint[] => [
		...own,
		rawHint(theme, "tab", "next tab", 20),
		...(filterable ? [{ text: theme.fg("muted", "type to filter"), priority: 21 }] : []),
		rawHint(theme, "f1", "help", 1),
		bindingHint(theme, keys, "tui.select.cancel", "escape", drilled ? "back" : "close", 0),
	];

	const render = (width: number, terminalRows: number): string[] => {
		if (sizedFor !== terminalRows || !bodyRows) {
			sizedFor = terminalRows;
			bodyRows = bodyRowsFor(terminalRows);
		}
		const level = host.thinkingLevel?.() ?? null;
		if (!chrome || chrome.theme !== theme || chrome.level !== level) chrome = { theme, level, value: makeChrome(theme, level) };
		const tab = tabs[active];
		const view = tab.view(width, bodyRows);
		const query = tab.query();
		const shown: Note = note.text ? note : { text: shell.readOnly() ? (host.controlMessage?.() ?? "") : "", level: "warning" };
		const base = { width, theme, chrome: chrome.value, state: state(), tabs: tabs.map((t) => t.title), active, bodyRows, message: shown.text, messageLevel: shown.level };
		const readOnlyNote = shell.readOnly() ? "read-only · reopen /accordion · " : "";
		if (modal) {
			const [question, ...facts] = modal.title.split("\n");
			const selected = modal.selected;
			const choiceRows = Math.min(modal.options.length, bodyRows - 1);
			const first = Math.max(0, Math.min(selected - choiceRows + 1, modal.options.length - choiceRows));
			const details = [...facts.map((fact) => `  ${theme.fg("muted", clean(fact))}`), ""].slice(0, bodyRows - choiceRows - 1);
			const choices = modal.options.slice(first, first + choiceRows).map((option, i) => (first + i === selected ? ` ${theme.fg("accent", "→")} ${theme.bold(clean(option))}` : `   ${clean(option)}`));
			return renderFrame({
				...base, crumbs: ["Accordion", tab.title, modal.crumb], above: first, below: modal.options.length - first - choiceRows, query: "", filterable: false,
				body: [`  ${theme.bold(clean(question))}`, ...details, ...choices],
				description: details.length < facts.length ? facts.slice(details.length).join(" ") : "The first choice is the safe one.",
				hints: [rawHint(theme, "↑↓", "move", 1), bindingHint(theme, keys, "tui.select.confirm", "enter", "choose", 1), bindingHint(theme, keys, "tui.select.cancel", "escape", "cancel", 0)],
			});
		}
		if (help) {
			const all = [...frameHints(view.hints, query !== null, view.crumbs.length > 0).map((hint) => `  ${hint.text}`), "", ...tab.legend().flatMap((row) => wrapTextWithAnsi(`  ${clean(row)}`, Math.max(1, width)))];
			helpTop = Math.max(0, Math.min(helpTop, all.length - bodyRows));
			return renderFrame({
				...base, crumbs: ["Accordion", tab.title, "Help"], above: helpTop, below: Math.max(0, all.length - helpTop - bodyRows), query: "", filterable: false,
				body: all.slice(helpTop, helpTop + bodyRows), description: "Keys and legend for this tab; staged edits are kept.",
				hints: [rawHint(theme, "↑↓", "scroll", 1), rawHint(theme, "f1", "back", 0), bindingHint(theme, keys, "tui.select.cancel", "escape", "back", 0)],
			});
		}
		return renderFrame({
			...base, crumbs: ["Accordion", tab.title, ...view.crumbs], above: view.above, below: view.below, query: query ?? "", filterable: query !== null,
			body: view.body, description: `${readOnlyNote}${view.description}`, hints: frameHints(view.hints, query !== null, view.crumbs.length > 0),
		});
	};

	const input = (data: string): void => {
		const cancel = keys.matches(data, "tui.select.cancel");
		if (matchesKey(data, "ctrl+c")) {
			modal = null;
			return close();
		}
		if (modal) {
			const m = modal;
			if (keys.matches(data, "tui.select.up")) m.selected = (m.selected + m.options.length - 1) % m.options.length;
			else if (keys.matches(data, "tui.select.down") || matchesKey(data, "tab")) m.selected = (m.selected + 1) % m.options.length;
			else if (keys.matches(data, "tui.select.confirm") || cancel) {
				modal = null;
				m.then(cancel ? null : m.selected);
			}
			return update();
		}
		if (pending && !cancel) return shell.say("Command pending", "info");
		note = { text: "", level: "info" };
		const tab = tabs[active];
		const text = typed(data);
		const query = tab.query();
		const switchTab = (step: number) => {
			active = (active + step + tabs.length) % tabs.length;
		};
		if (matchesKey(data, "f1")) {
			help = !help;
			helpTop = 0;
		} else if (help) {
			if (cancel) help = false;
			else if (keys.matches(data, "tui.select.up")) helpTop = Math.max(0, helpTop - 1);
			else if (keys.matches(data, "tui.select.down")) helpTop++;
			else if (keys.matches(data, "tui.select.pageUp")) helpTop = Math.max(0, helpTop - Math.max(1, bodyRows - 1));
			else if (keys.matches(data, "tui.select.pageDown")) helpTop += Math.max(1, bodyRows - 1);
		} else if (tab.typing()) {
			if (cancel) tab.back();
			else tab.key(data);
		} else if (matchesKey(data, "tab")) switchTab(1);
		else if (matchesKey(data, "shift+tab")) switchTab(-1);
		else if (text !== null) {
			// A printable key never acts: it types into the filter, or does nothing.
			if (query !== null) tab.setFilter(query + text);
		} else if (query !== null && matchesKey(data, "backspace")) tab.setFilter([...query].slice(0, -1).join(""));
		else if (query !== null && matchesKey(data, "ctrl+u")) tab.setFilter("");
		else if (tab.key(data)) {
			// used by the tab
		} else if (cancel) {
			if (query) tab.setFilter("");
			else if (!tab.back()) return close();
		} else if (matchesKey(data, "left")) switchTab(-1);
		else if (matchesKey(data, "right")) switchTab(1);
		update();
	};

	try {
		await loop();
	} finally {
		for (const tab of tabs) tab.dispose?.();
	}

	async function loop(): Promise<void> {
	while (true) {
		const action = await ctx.ui.custom<DigestAction | undefined>((tui, uiTheme, uiKeys, done) => {
			theme = uiTheme as unknown as ChromeTheme;
			keys = uiKeys as unknown as ChromeKeys;
			live = true;
			let disposed = false;
			requestRender = () => tui.requestRender();
			leave = (result) => done(result);
			const unsubscribe = host.subscribe(update);
			return {
				render: (width: number) => render(width, tui.terminal.rows),
				handleInput: input,
				invalidate() {},
				dispose() {
					if (disposed) return;
					disposed = true;
					live = false;
					unsubscribe();
				},
			};
		});
		if (!action) return;
		const draftKey = action.groupId ? `group:${action.groupId}` : `block:${action.blockId}`;
		let draft: string | undefined;
		if (action.kind === "edit") {
			draft = await ctx.ui.editor("Edit digest · human text cannot be unfolded by the agent", digestDrafts.get(draftKey) ?? action.text);
			if (draft === undefined) {
				note = { text: "Edit cancelled", level: "info" };
				continue;
			}
			if (draft === action.text) {
				digestDrafts.delete(draftKey);
				note = { text: "No changes", level: "info" };
				continue;
			}
			digestDrafts.set(draftKey, draft);
			if (action.groupId && !stripFoldTags(draft.trim()).trim()) {
				const confirmed = await ctx.ui.confirm("Drop group content?", "An empty summary removes group messages from the wire where safe; tool-pair and role safety may retain content. Continue?");
				if (!confirmed) {
					note = { text: "Edit cancelled", level: "info" };
					continue;
				}
			}
		}
		const truth = host.truth();
		const block = truth?.blocks.find((item) => item.id === action.blockId);
		const group = block && truth?.groupOf(block);
		if (
			truth !== action.truth ||
			truth?.rev !== action.rev ||
			!block ||
			(action.groupId ? group?.id !== action.groupId || !group.folded || group.memberIds.join("\0") !== action.members?.join("\0") : !!group?.folded || !truth.isFolded(block))
		) {
			note = { text: "Context changed while editing; retry", level: "warning" };
			continue;
		}
		if (host.canSteer && !host.canSteer()) {
			readOnly = true;
			note = { text: "read-only: cannot edit digest", level: "warning" };
			continue;
		}
		const text = draft === undefined ? undefined : stripFoldTags(draft.trim()).trim();
		const ops: Op[] =
			action.groupId && action.members
				? [{ kind: "ungroup", groupId: action.groupId }, { kind: "group", ids: [action.members[0], action.members[action.members.length - 1]], ...(text === undefined ? {} : { summary: text || null }) }]
				: [{ kind: "fold", ids: [action.blockId], ...(text === undefined ? {} : { digest: text || EMPTY_DIGEST }) }];
		try {
			const result = await host.command({ kind: "ops", ops, baseRev: action.rev });
			if (result.refused === "read-only") readOnly = true;
			if (!result.refused && result.results.every((item) => item.applied && !item.clamped)) digestDrafts.delete(draftKey);
			note = commandNote(result);
		} catch (error) {
			note = failed("Command failed", error);
		}
	}
}
}
