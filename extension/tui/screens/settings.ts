import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeSource, type NumericDialKind, formatTokens, parseTokens } from "../../dials";
import { DEFAULT_SETTINGS } from "../../settings";
import { settingParts, validateSetting, type SettingPath, type SettingsPatch } from "../../settingsValidation";
import { bindingHint, clean, rawHint } from "../chrome";
import type { PanelTab, Shell } from "./types";
import { modelDefaultRows, SETTINGS_ROWS, type SettingsRow } from "./settingsRows";

interface SessionRow {
	id: "folding" | NumericDialKind;
	label: string;
	description: string;
}
type Row = SessionRow | SettingsRow;
interface PickerItem { value: string | undefined; label: string; description: string }
interface Picker { row: SettingsRow; items: PickerItem[]; filter: string; selected: number }
const CONFIG_PATH = "~/.accordion/config.json";
const SESSION_ROWS: SessionRow[] = [
	{ id: "folding", label: "Folding", description: "Armed: Accordion rewrites the outgoing context. Off: messages pass through untouched. Applies at once." },
	{ id: "budget", label: "Token budget", description: "Size this session folds toward, e.g. 200k, 1M or 85%. Applies at once; can also be saved as the model's default." },
	{ id: "protect", label: "Protected tail", description: "Newest tokens that stay unfolded, e.g. 20k. Applies at once; can also be saved as the model's default." },
];
const isGlobal = (row: Row): row is SettingsRow => "path" in row;

function settingValue(settings: unknown, path: SettingPath): unknown {
	return settingParts(path)?.reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, settings);
}

function parseInput(row: SettingsRow, text: string): { value: unknown } | { error: string } {
	const trimmed = text.trim();
	if (row.kind === "add-pattern") {
		const result = validateSetting(`modelDefaults.${trimmed}.budget`, undefined);
		return result.ok ? { value: trimmed } : { error: "enter *, provider/* or provider/model" };
	}
	let value: unknown = trimmed;
	if (row.kind === "number") {
		if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return { error: "enter a number" };
		value = Number(trimmed);
	} else if (row.kind === "list") {
		try { value = JSON.parse(trimmed); } catch { return { error: "enter a JSON array of directories" }; }
	} else if (row.path === "customToken" && !trimmed) value = null;
	else if (row.path.startsWith("modelDefaults.") && !trimmed) value = undefined;
	const result = validateSetting(row.path, value);
	return result.ok ? { value } : { error: result.error };
}

/** The Settings tab: session values apply at once, global values are staged and saved with ctrl+s. */
export function createSettingsTab(shell: Shell): PanelTab {
	const { host } = shell;
	let rows: Row[] = [];
	let selected = 0;
	let top = 0;
	let staged: SettingsPatch = {};
	let baseRev = "";
	let input: { row: Row; text: string } | null = null;
	let picker: Picker | null = null;
	const newPatterns = new Set<string>();
	const rebuildRows = () => {
		const previous = rows[selected];
		const settings = host.settings?.().settings ?? DEFAULT_SETTINGS;
		const patterns = new Set([...Object.keys(settings.modelDefaults), ...newPatterns]);
		for (const path of Object.keys(staged)) {
			const parts = settingParts(path);
			if (parts?.[0] === "modelDefaults") patterns.add(parts[1]);
		}
		const firstCompaction = SETTINGS_ROWS.findIndex((row) => row.section === "Compaction");
		rows = [...SESSION_ROWS, ...SETTINGS_ROWS.slice(0, firstCompaction), ...modelDefaultRows([...patterns].sort()), ...SETTINGS_ROWS.slice(firstCompaction)];
		if (previous) {
			const index = rows.findIndex((row) => isGlobal(row) && isGlobal(previous) ? row.path === previous.path && row.kind === previous.kind : !isGlobal(row) && !isGlobal(previous) && row.id === previous.id);
			if (index >= 0) selected = index;
		}
	};
	rebuildRows();

	const saved = (row: SettingsRow): unknown => settingValue(host.settings?.().settings ?? DEFAULT_SETTINGS, row.path);
	const defaultValue = (row: SettingsRow): unknown => row.defaultValue ?? settingValue(DEFAULT_SETTINGS, row.path);
	const value = (row: SettingsRow): unknown => (Object.hasOwn(staged, row.path) ? staged[row.path] : saved(row)) ?? defaultValue(row);
	const locked = (row: SettingsRow) => {
		const source = host.settings?.().sources[row.path];
		return source === "env" || source === "flag" ? source : null;
	};
	const stage = (row: SettingsRow, next: unknown) => {
		const source = locked(row);
		if (source) return shell.say(`${row.path} is ${source} · locked; remove the override first`);
		const valid = validateSetting(row.path, next);
		if (!valid.ok) return shell.say(valid.error);
		if (!Object.keys(staged).length) baseRev = host.settings?.().rev ?? "";
		if (JSON.stringify(next) === JSON.stringify(saved(row))) delete staged[row.path];
		else staged[row.path] = next;
	};
	const options = (row: SettingsRow): readonly (string | undefined)[] => {
		if (row.kind !== "conductor") return row.choices ?? [];
		const ids = [...host.conductors().map((entry) => entry.id).filter((id) => id !== "none" && validateSetting(row.path, id).ok), "none"];
		const current = value(row);
		return typeof current === "string" && !ids.includes(current) ? [current, ...ids] : ids;
	};
	const cycle = (row: Row, step: number): boolean => {
		if (!isGlobal(row) || row.kind !== "choice" && row.kind !== "conductor") return false;
		const choices = options(row);
		if (!choices.length) return true;
		const current = value(row);
		const index = choices.indexOf(typeof current === "string" ? current : undefined);
		stage(row, choices[((index < 0 ? 0 : index) + step + choices.length) % choices.length]);
		return true;
	};
	const filtered = () => picker?.items.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(picker!.filter.toLowerCase())) ?? [];
	const openPicker = (row: SettingsRow) => {
		const show = (items: PickerItem[]) => {
			const current = value(row);
			picker = { row, items, filter: "", selected: Math.max(0, items.findIndex((item) => item.value === current)) };
		};
		if (row.kind === "conductor") {
			show([
				{ value: "none", label: "None", description: "No conductor attached on startup." },
				...host.conductors().filter((entry) => entry.id !== "none" && validateSetting(row.path, entry.id).ok).map((entry) => ({
					value: entry.id, label: `${entry.label} · ${entry.id}`,
					description: entry.readiness.state === "ready" ? "Ready" : `Unavailable: ${entry.readiness.reason}`,
				})),
			]);
			return;
		}
		if (!host.models) return shell.say("Available models are not exposed by this session");
		const type = row.path.endsWith(".classifier") ? "classifier" : "chat";
		void shell.run("Loading models…", async () => {
			const models = await host.models!(type);
			const items: PickerItem[] = [{ value: undefined, label: "Use default", description: "Remove this model override." }];
			if (type === "chat") items.push({ value: "current", label: "Current session model", description: "Resolve to the session's chat model at call time." });
			items.push(...models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, description: model.name })));
			show(items);
			return "";
		});
	};
	const stats = () => host.truth()?.stats();
	const dialNow = (kind: NumericDialKind) => kind === "budget" ? stats()?.budget : stats()?.protectTokens;
	const shown = (row: Row): { value: string; source: string } => {
		const theme = shell.theme();
		if (!isGlobal(row)) {
			if (row.id === "folding") return { value: host.folding() ? "[x] armed" : "[ ] off", source: theme.fg("dim", "session") };
			const now = dialNow(row.id);
			const dials = host.dials?.();
			return { value: now === undefined ? "–" : formatTokens(now), source: theme.fg("dim", dials ? describeSource(dials.sources[row.id]) : "session") };
		}
		const configured = host.settings?.().sources[row.path];
		const source = Object.hasOwn(staged, row.path) ? theme.fg("warning", "▲ staged") : theme.fg("dim", locked(row) ? `${locked(row)} · locked` : configured === "file" ? "user" : configured ?? "default");
		const current = value(row);
		if (row.kind === "toggle") return { value: current ? "[x] on" : "[ ] off", source };
		if (row.kind === "add-pattern") return { value: "›", source: "" };
		if (row.kind === "choice" || row.kind === "conductor") return { value: `‹ ${clean(String(current ?? "inherited"))} ›`, source };
		if (row.kind === "model") return { value: clean(String(current ?? "default")), source };
		if (row.path === "customToken") return { value: current === null ? `${clean(host.webInfo?.().token ?? "")} ${theme.fg("dim", "(generated)")}`.trim() : clean(String(current)), source };
		return { value: clean(row.kind === "list" ? JSON.stringify(current) : String(current ?? "")), source };
	};

	const applyDial = (kind: NumericDialKind, amount: number) => {
		const model = host.dials?.()?.model ?? null;
		const apply = (asDefault: boolean) => void shell.send({ kind: kind === "budget" ? "setBudget" : "setProtect", value: amount }).then(async () => {
			if (asDefault && host.saveDialDefault) await shell.run("Saving default…", async () => {
				if (host.dials?.()?.model !== model) throw new Error("Model changed; retry the edit");
				return await host.saveDialDefault!(kind, amount);
			});
		});
		if (!model || !host.saveDialDefault) return apply(false);
		shell.confirm({
			crumb: "Scope", title: `Where does ${formatTokens(amount)} apply?\nThis session: until the session ends or you change it.\nDefault: also stored in ${CONFIG_PATH} for ${model}.`,
			options: ["This session", `This session and default for ${model}`], then: (choice) => { if (choice !== null) apply(choice === 1); },
		});
	};
	const confirmInput = () => {
		if (!input) return;
		const { row, text } = input;
		if (!isGlobal(row)) {
			if (row.id === "folding") return;
			const parsed = parseTokens(text, stats()?.contextWindow ?? null);
			if (typeof parsed !== "number") return shell.say(parsed.error);
			input = null;
			return applyDial(row.id, parsed);
		}
		const parsed = parseInput(row, text);
		if ("error" in parsed) return shell.say(parsed.error);
		if (row.kind === "add-pattern") {
			newPatterns.add(parsed.value as string);
			rebuildRows();
			selected = rows.findIndex((candidate) => isGlobal(candidate) && candidate.kind !== "add-pattern" && candidate.path === `modelDefaults.${parsed.value}.budget`);
			input = null;
			return;
		}
		stage(row, parsed.value);
		input = null;
	};
	const save = () => {
		const n = Object.keys(staged).length;
		if (!n) return shell.say("Nothing staged", "info");
		if (!host.updateSettings) return shell.say("Settings cannot be saved from this session");
		const update = host.updateSettings;
		void shell.run("Saving…", async () => {
			const result = await update({ ...staged }, baseRev);
			if (!result.ok) throw new Error(result.error);
			staged = {};
			newPatterns.clear();
			return `Saved ${n} setting${n === 1 ? "" : "s"} to ${CONFIG_PATH}`;
		});
	};

	return {
		id: "settings", title: "Settings",
		view(width, bodyRows) {
			const theme = shell.theme(), keys = shell.keys();
			if (picker) {
				const items = filtered();
				picker.selected = Math.max(0, Math.min(picker.selected, items.length - 1));
				const top = Math.max(0, Math.min(picker.selected - bodyRows + 1, items.length - bodyRows));
				const body = items.slice(top, top + bodyRows).map((item, i) => truncateToWidth(`${i + top === picker!.selected ? theme.fg("accent", "→") : " "} ${clean(item.label)}  ${theme.fg("dim", clean(item.description))}`, width, "…"));
				return { body: body.length ? body : [theme.fg("dim", "  No matching choices")], crumbs: [picker.row.label], description: items[picker.selected]?.description ?? "Type to filter choices.",
					hints: [bindingHint(theme, keys, "tui.select.confirm", "enter", "select", 1)], above: top, below: Math.max(0, items.length - top - bodyRows) };
			}
			if (input) {
				const { row, text } = input;
				const parsed = isGlobal(row) ? parseInput(row, text) : row.id === "folding" ? { error: "not editable" } : parseTokens(text, stats()?.contextWindow ?? null);
				const check = typeof parsed === "number" ? `= ${parsed.toLocaleString("en-US")} tokens` : "error" in parsed ? `${theme.fg("error", "✗")} ${parsed.error}` : `${theme.fg("success", "✓")} valid`;
				const now = shown(row);
				return { body: [`  ${theme.bold(row.label)}: ${clean(text)}${theme.fg("accent", "▏")}`, `  ${check}`, "", `  ${theme.fg("dim", `now ${now.value} · ${now.source}`)}`], crumbs: [row.label], description: row.description,
					hints: [bindingHint(theme, keys, "tui.select.confirm", "enter", isGlobal(row) ? "stage" : "apply", 1)], above: 0, below: 0 };
			}
			rebuildRows();
			selected = Math.max(0, Math.min(selected, rows.length - 1));
			const labelWidth = width >= 57 ? 20 : 16;
			const display: string[] = [];
			let section = "", at = 0;
			for (const [index, row] of rows.entries()) {
				const nextSection = isGlobal(row) ? row.section : "This session · applies at once";
				if (nextSection !== section) { section = nextSection; display.push(theme.fg("muted", ` ${clean(section)}`)); }
				if (index === selected) at = display.length;
				const cell = shown(row), label = truncateToWidth(row.label, labelWidth, "…");
				const head = `${index === selected ? theme.fg("accent", "→") : " "} ${index === selected ? theme.bold(label) : label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}  `;
				const val = truncateToWidth(cell.value, Math.max(0, width - visibleWidth(head)), "…");
				const gap = width - visibleWidth(head) - visibleWidth(val) - visibleWidth(cell.source);
				display.push(gap >= 2 ? `${head}${val}${" ".repeat(gap)}${cell.source}` : `${head}${val}`);
			}
			if (at - 1 < top) top = at - 1;
			if (at >= top + bodyRows) top = at - bodyRows + 1;
			top = Math.max(0, Math.min(top, display.length - bodyRows));
			const row = rows[selected], web = host.webInfo?.();
			const webNote = isGlobal(row) && ["bindHost", "doorPort", "customToken"].includes(row.path) ? ` Browser URL: ${web?.url ?? "starting…"} (${web?.clients ?? 0} connected).` : "";
			const action = !isGlobal(row) ? row.id === "folding" ? "toggle" : "edit" : row.kind === "choice" ? "next value" : row.kind === "toggle" ? "toggle" : row.kind === "conductor" || row.kind === "model" ? "choose" : "edit";
			return { body: display.slice(top, top + bodyRows), crumbs: [], description: `${row.description}${webNote}`,
				hints: [bindingHint(theme, keys, "tui.select.confirm", "enter", action, 2), ...(Object.keys(staged).length ? [rawHint(theme, "ctrl+s", "save", 1)] : []),
					...(isGlobal(row) && (row.kind === "choice" || row.kind === "conductor") ? [rawHint(theme, "←→", "change", 3)] : []),
					...(isGlobal(row) && row.kind !== "add-pattern" ? [rawHint(theme, "alt+u", "default", 6)] : []), ...(isGlobal(row) && row.path === "customToken" && row.kind !== "add-pattern" ? [rawHint(theme, "alt+r", "new token", 5)] : [])],
				above: top, below: Math.max(0, display.length - top - bodyRows) };
		},
		key(data) {
			const keys = shell.keys();
			if (picker) {
				const items = filtered();
				if (keys.matches(data, "tui.select.up")) picker.selected = Math.max(0, picker.selected - 1);
				else if (keys.matches(data, "tui.select.down")) picker.selected = Math.min(Math.max(0, items.length - 1), picker.selected + 1);
				else if (keys.matches(data, "tui.select.confirm")) {
					const item = items[picker.selected], row = picker.row;
					if (item) { picker = null; stage(row, item.value); }
				} else return false;
				return true;
			}
			if (input) {
				if (matchesKey(data, "backspace")) input.text = [...input.text].slice(0, -1).join("");
				else if (matchesKey(data, "ctrl+u")) input.text = "";
				else if (keys.matches(data, "tui.select.confirm")) confirmInput();
				else { const text = decodeKittyPrintable(data) ?? data; if (text && !/[\x00-\x1f\x7f-\x9f]/.test(text) && input.text.length + text.length <= 4096) input.text += text; }
				return true;
			}
			const row = rows[selected];
			if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
			else if (keys.matches(data, "tui.select.down")) selected = Math.min(rows.length - 1, selected + 1);
			else if (matchesKey(data, "ctrl+s")) save();
			else if (matchesKey(data, "left")) return cycle(row, -1);
			else if (matchesKey(data, "right")) return cycle(row, 1);
			else if (matchesKey(data, "alt+u")) {
				if (isGlobal(row) && row.kind !== "add-pattern") stage(row, row.defaultValue !== undefined ? undefined : defaultValue(row));
				else shell.say("A session value has no stored default to return to");
			} else if (matchesKey(data, "alt+r") && isGlobal(row) && row.path === "customToken") {
				if (!host.regenerateToken) return true;
				const regenerate = host.regenerateToken;
				shell.confirm({ crumb: "New token", title: "Generate a new web access token?\nUse the new URL for browser access; existing connections stay open.\nThis applies at once and is not staged.",
					options: ["Keep token", "Generate new token"], then: (choice) => { if (choice !== 1) return; void shell.run("Generating token…", async () => {
						await regenerate(); delete staged.customToken; return "New token generated; reconnect using the Web UI URL";
					}); } });
			} else if (keys.matches(data, "tui.select.confirm")) {
				if (!isGlobal(row) && row.id === "folding") void shell.send({ kind: "setFolding", value: !host.folding() });
				else if (isGlobal(row) && locked(row)) shell.say(`${row.path} is ${locked(row)} · locked; remove the override first`);
				else if (isGlobal(row) && row.kind === "toggle") stage(row, !value(row));
				else if (isGlobal(row) && (row.kind === "conductor" || row.kind === "model")) openPicker(row);
				else if (!cycle(row, 1)) input = { row, text: !isGlobal(row) || row.kind === "add-pattern" ? "" : row.kind === "list" ? JSON.stringify(value(row)) : String(value(row) ?? "") };
			} else return false;
			return true;
		},
		typing: () => input !== null, query: () => picker?.filter ?? null,
		setFilter(query) { if (picker) { picker.filter = query; picker.selected = 0; } },
		back() { if (input) { input = null; return true; } if (picker) { picker = null; return true; } return false; },
		dirty: () => Object.keys(staged).length, discard() { staged = {}; newPatterns.clear(); },
		legend: () => [
			"[x] / [ ] toggles, ‹ value › is changed with Left and Right, ▲ staged marks a value not saved yet.",
			"The right column says where a value comes from: session, default, user (your config file) or staged.",
			`Session values apply at once. Values for all sessions are staged and written to ${CONFIG_PATH} with ctrl+s.`,
			"Environment variables and --accordion-* flags override the file; such values are shown as they apply now.",
		],
	};
}
