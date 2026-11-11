import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeSource, type DialKind, formatTokens, parseTokens } from "../../dials";
import { type AccordionSettings, DEFAULT_SETTINGS, sanitizeBindHost, sanitizeCustomToken } from "../../settings";
import { bindingHint, clean, rawHint } from "../chrome";
import type { PanelTab, Shell } from "./types";

type GlobalKey = "debug" | "autoArm" | "defaultConductor" | "compactMode" | "bindHost" | "doorPort" | "customToken";
type Globals = Pick<AccordionSettings, GlobalKey>;
type RowId = "folding" | DialKind | GlobalKey;
interface Row {
	id: RowId;
	label: string;
	description: string;
}

const CONFIG_PATH = "~/.accordion/config.json";
const SESSION_ROWS: Row[] = [
	{ id: "folding", label: "Folding", description: "Armed: Accordion rewrites the outgoing context. Off: messages pass through untouched. Applies at once." },
	{ id: "budget", label: "Token budget", description: "Size this session folds toward, e.g. 200k, 1M or 85%. Applies at once; can also be saved as the model's default." },
	{ id: "protect", label: "Protected tail", description: "Newest tokens that stay unfolded, e.g. 20k. Applies at once; can also be saved as the model's default." },
];
const GLOBAL_ROWS: Row[] = [
	{ id: "autoArm", label: "Arm on startup", description: `Arm folding when a session starts. Stored in ${CONFIG_PATH}; applies to new sessions.` },
	{ id: "defaultConductor", label: "Default conductor", description: `Conductor attached when a session starts armed. Stored in ${CONFIG_PATH}.` },
	{ id: "compactMode", label: "/compact behavior", description: "What Pi's /compact does while folding is armed: accordion (one pass), suppress, or native." },
	{ id: "bindHost", label: "Web UI address", description: "Address the web UI listens on; 0.0.0.0 is reachable from the network." },
	{ id: "doorPort", label: "Web UI door port", description: "Fixed port shared by all sessions; 0 disables it." },
	{ id: "customToken", label: "Web access token", description: "3-64 URL-safe characters; empty uses a generated token." },
	{ id: "debug", label: "Debug log", description: "Private session diagnostics in ~/.accordion/debug/. /accordion debug on|off overrides this session." },
];
const COMPACT_MODES = ["accordion", "suppress", "native"] as const;
const isGlobal = (id: RowId): id is GlobalKey => GLOBAL_ROWS.some((row) => row.id === id);

/** Check typed text for a global field; returns the value to stage or the reason it is refused. */
function parseGlobal(id: "bindHost" | "doorPort" | "customToken", text: string): { value: string | number | null } | { error: string } {
	const trimmed = text.trim();
	if (id === "bindHost") return trimmed && sanitizeBindHost(trimmed) === trimmed ? { value: trimmed } : { error: "not a host name or address" };
	if (id === "doorPort") return /^\d{1,5}$/.test(trimmed) && Number(trimmed) <= 65535 ? { value: Number(trimmed) } : { error: "a port is 0-65535" };
	if (!trimmed) return { value: null };
	return sanitizeCustomToken(trimmed) === trimmed ? { value: trimmed } : { error: "use 3-64 of A-Z a-z 0-9 . _ ~ -" };
}

/** The Settings tab: session values apply at once, global values are staged and saved with ctrl+s. */
export function createSettingsTab(shell: Shell): PanelTab {
	const { host } = shell;
	const rows = [...SESSION_ROWS, ...GLOBAL_ROWS];
	let selected = 0;
	let top = 0;
	let staged: Partial<Globals> = {};
	let input: { row: Row; text: string } | null = null;

	const saved = (): Globals => host.settings?.() ?? DEFAULT_SETTINGS;
	const value = <K extends GlobalKey>(key: K): Globals[K] => (key in staged ? (staged[key] as Globals[K]) : saved()[key]);
	const stage = <K extends GlobalKey>(key: K, next: Globals[K]) => {
		if (next === saved()[key]) delete staged[key];
		else staged[key] = next;
	};
	const conductorIds = (): string[] => {
		const ids = [...host.conductors().map((entry) => entry.id).filter((id) => id !== "none"), "none"];
		return ids.includes(value("defaultConductor")) ? ids : [value("defaultConductor"), ...ids];
	};
	const cycle = (id: RowId, step: number): boolean => {
		if (id !== "defaultConductor" && id !== "compactMode") return false;
		const options: readonly string[] = id === "defaultConductor" ? conductorIds() : COMPACT_MODES;
		const next = options[(options.indexOf(value(id)) + step + options.length) % options.length];
		if (id === "defaultConductor") stage(id, next);
		else stage(id, next as AccordionSettings["compactMode"]);
		return true;
	};
	const stats = () => host.truth()?.stats();
	const dialNow = (kind: DialKind) => (kind === "budget" ? stats()?.budget : stats()?.protectTokens);

	const shown = (id: RowId): { value: string; source: string } => {
		const theme = shell.theme();
		if (id === "folding") return { value: host.folding() ? "[x] armed" : "[ ] off", source: "session" };
		if (id === "budget" || id === "protect") {
			const now = dialNow(id);
			const dials = host.dials?.();
			return { value: now === undefined ? "–" : formatTokens(now), source: dials ? describeSource(dials.sources[id]) : "session" };
		}
		const source = id in staged ? theme.fg("warning", "▲ staged") : theme.fg("dim", saved()[id] === DEFAULT_SETTINGS[id] ? "default" : "user");
		if (id === "autoArm" || id === "debug") return { value: value(id) ? "[x] on" : "[ ] off", source };
		if (id === "defaultConductor" || id === "compactMode") return { value: `‹ ${clean(value(id))} ›`, source };
		if (id === "customToken") return { value: value(id) === null ? `${clean(host.webInfo?.().token ?? "")} ${theme.fg("dim", "(generated)")}`.trim() : clean(value(id) ?? ""), source };
		return { value: clean(String(value(id))), source };
	};

	const applyDial = (kind: DialKind, amount: number) => {
		const model = host.dials?.()?.model ?? null;
		const apply = (asDefault: boolean) =>
			void shell.send({ kind: kind === "budget" ? "setBudget" : "setProtect", value: amount }).then(() => {
				if (asDefault && host.saveDialDefault) shell.say(host.saveDialDefault(kind, amount), "info");
			});
		if (!model || !host.saveDialDefault) return apply(false);
		shell.confirm({
			crumb: "Scope",
			title: `Where does ${formatTokens(amount)} apply?\nThis session: until the session ends or you change it.\nDefault: also stored in ${CONFIG_PATH} for ${model}.`,
			options: ["This session", `This session and default for ${model}`],
			then: (choice) => {
				if (choice !== null) apply(choice === 1);
			},
		});
	};

	const confirmInput = () => {
		if (!input) return;
		const { row, text } = input;
		if (row.id === "budget" || row.id === "protect") {
			const parsed = parseTokens(text, stats()?.contextWindow ?? null);
			if (typeof parsed !== "number") return shell.say(parsed.error);
			input = null;
			return applyDial(row.id, parsed);
		}
		if (row.id !== "bindHost" && row.id !== "doorPort" && row.id !== "customToken") return;
		const parsed = parseGlobal(row.id, text);
		if ("error" in parsed) return shell.say(parsed.error);
		if (row.id === "doorPort") stage(row.id, parsed.value as number);
		else if (row.id === "bindHost") stage(row.id, parsed.value as string);
		else stage(row.id, parsed.value as string | null);
		input = null;
	};

	const save = () => {
		const patch = { ...staged };
		const n = Object.keys(patch).length;
		if (!n) return shell.say("Nothing staged", "info");
		if (!host.updateSettings) return shell.say("Settings cannot be saved from this session");
		const update = host.updateSettings;
		void shell.run("Saving…", async () => {
			await update(patch);
			staged = {};
			return `Saved ${n} setting${n === 1 ? "" : "s"} to ${CONFIG_PATH}`;
		});
	};

	return {
		id: "settings",
		title: "Settings",
		view(width, bodyRows) {
			const theme = shell.theme();
			const keys = shell.keys();
			if (input) {
				const { row, text } = input;
				let check: string;
				if (!text && row.id !== "customToken") check = theme.fg("dim", row.id === "budget" || row.id === "protect" ? "e.g. 200k, 272k, 1M, 0.5M, 200000 or 85% of the context window" : row.description);
				else if (row.id === "budget" || row.id === "protect") {
					const parsed = parseTokens(text, stats()?.contextWindow ?? null);
					check = typeof parsed === "number" ? `= ${parsed.toLocaleString("en-US")} tokens` : `${theme.fg("error", "✗")} ${parsed.error}`;
				} else {
					const parsed = parseGlobal(row.id as "bindHost" | "doorPort" | "customToken", text);
					check = "error" in parsed ? `${theme.fg("error", "✗")} ${parsed.error}` : parsed.value === null ? theme.fg("dim", "empty: a generated token is used") : `${theme.fg("success", "✓")} valid`;
				}
				const now = shown(row.id);
				return {
					body: [`  ${theme.bold(row.label)}: ${clean(text)}${theme.fg("accent", "▏")}`, `  ${check}`, "", `  ${theme.fg("dim", `now ${now.value} · ${now.source}`)}`],
					crumbs: [row.label],
					description: row.description,
					hints: [bindingHint(theme, keys, "tui.select.confirm", "enter", isGlobal(row.id) ? "stage" : "apply", 1)],
					above: 0,
					below: 0,
				};
			}
			selected = Math.max(0, Math.min(selected, rows.length - 1));
			const labelWidth = width >= 57 ? 20 : 16;
			const line = (row: Row, index: number) => {
				const cell = shown(row.id);
				const label = truncateToWidth(row.label, labelWidth, "…");
				const head = `${index === selected ? theme.fg("accent", "→") : " "} ${index === selected ? theme.bold(label) : label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}  `;
				const val = truncateToWidth(cell.value, Math.max(0, width - visibleWidth(head)), "…");
				const gap = width - visibleWidth(head) - visibleWidth(val) - visibleWidth(cell.source);
				return gap >= 2 ? `${head}${val}${" ".repeat(gap)}${theme.fg("dim", cell.source)}` : `${head}${val}`;
			};
			const display = [
				theme.fg("muted", " This session · applies at once"),
				...SESSION_ROWS.map((row, i) => line(row, i)),
				theme.fg("muted", ` All sessions · ${CONFIG_PATH} · staged until saved`),
				...GLOBAL_ROWS.map((row, i) => line(row, SESSION_ROWS.length + i)),
			];
			const at = selected + (selected < SESSION_ROWS.length ? 1 : 2);
			// One row above the selection stays visible so a section title is never scrolled off alone.
			if (at - 1 < top) top = at - 1;
			if (at >= top + bodyRows) top = at - bodyRows + 1;
			top = Math.max(0, Math.min(top, display.length - bodyRows));
			const row = rows[selected];
			const web = host.webInfo?.();
			const webNote = row.id === "bindHost" || row.id === "doorPort" || row.id === "customToken" ? ` Browser URL: ${web?.url ?? "starting…"} (${web?.clients ?? 0} connected).` : "";
			const action = row.id === "defaultConductor" || row.id === "compactMode" ? "next value" : row.id === "folding" || row.id === "autoArm" || row.id === "debug" ? "toggle" : "edit";
			return {
				body: display.slice(top, top + bodyRows),
				crumbs: [],
				description: `${row.description}${webNote}`,
				hints: [
					bindingHint(theme, keys, "tui.select.confirm", "enter", action, 2),
					...(Object.keys(staged).length ? [rawHint(theme, "ctrl+s", "save", 1)] : []),
					...(row.id === "defaultConductor" || row.id === "compactMode" ? [rawHint(theme, "←→", "change", 3)] : []),
					...(isGlobal(row.id) ? [rawHint(theme, "alt+u", "default", 6)] : []),
					...(row.id === "customToken" ? [rawHint(theme, "alt+r", "new token", 5)] : []),
				],
				above: top,
				below: Math.max(0, display.length - top - bodyRows),
			};
		},
		key(data) {
			const keys = shell.keys();
			if (input) {
				if (matchesKey(data, "backspace")) input.text = [...input.text].slice(0, -1).join("");
				else if (matchesKey(data, "ctrl+u")) input.text = "";
				else if (keys.matches(data, "tui.select.confirm")) confirmInput();
				else {
					const text = decodeKittyPrintable(data) ?? data;
					if (text && !/[\x00-\x1f\x7f-\x9f]/.test(text) && input.text.length + text.length <= 64) input.text += text;
				}
				return true;
			}
			const row = rows[selected];
			if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
			else if (keys.matches(data, "tui.select.down")) selected = Math.min(rows.length - 1, selected + 1);
			else if (matchesKey(data, "ctrl+s")) save();
			else if (matchesKey(data, "left")) return cycle(row.id, -1);
			else if (matchesKey(data, "right")) return cycle(row.id, 1);
			else if (matchesKey(data, "alt+u")) {
				if (isGlobal(row.id)) stage(row.id, DEFAULT_SETTINGS[row.id] as never);
				else shell.say("A session value has no stored default to return to");
			} else if (matchesKey(data, "alt+r") && row.id === "customToken") {
				if (!host.regenerateToken) return true;
				const regenerate = host.regenerateToken;
				shell.confirm({
					crumb: "New token",
					title: "Generate a new web access token?\nOpen browser tabs must reconnect with the new URL.\nThis applies at once and is not staged.",
					options: ["Keep token", "Generate new token"],
					then: (choice) => {
						if (choice !== 1) return;
						delete staged.customToken;
						shell.say(`New token: ${regenerate()}`, "info");
					},
				});
			} else if (keys.matches(data, "tui.select.confirm")) {
				if (row.id === "folding") void shell.send({ kind: "setFolding", value: !host.folding() });
				else if (row.id === "autoArm" || row.id === "debug") stage(row.id, !value(row.id));
				else if (!cycle(row.id, 1)) input = { row, text: row.id === "budget" || row.id === "protect" ? "" : String(value(row.id as GlobalKey) ?? "") };
			} else return false;
			return true;
		},
		typing: () => input !== null,
		query: () => null,
		setFilter() {},
		back() {
			if (!input) return false;
			input = null;
			return true;
		},
		dirty: () => Object.keys(staged).length,
		discard() {
			staged = {};
		},
		legend: () => [
			"[x] / [ ] toggles, ‹ value › is changed with Left and Right, ▲ staged marks a value not saved yet.",
			"The right column says where a value comes from: session, default, user (your config file) or staged.",
			`Session values apply at once. Values for all sessions are staged and written to ${CONFIG_PATH} with ctrl+s.`,
			"Environment variables and --accordion-* flags override the file; such values are shown as they apply now.",
		],
	};
}
