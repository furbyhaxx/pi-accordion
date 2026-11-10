import { backgroundAnsi, type Color, colorToRgb, foregroundAnsi, rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Lines of the dashboard frame around the body: three rules, tab bar, search, blank, description, hints. */
export const CHROME_ROWS = 8;
const MAX_BODY_ROWS = 14;
const MIN_BODY_ROWS = 3;
// Rows Pi keeps around a panel that replaces the editor: a spacer above, footer and status below.
const HOST_ROWS = 4;
const ELLIPSIS = "…";
const TAB_SEPARATOR = "❱";

/** The part of Pi's theme the frame uses; everything past `fg` and `bold` is optional so a reduced theme still renders. */
export interface ChromeTheme {
	fg(token: string, text: string): string;
	bold(text: string): string;
	inverse?(text: string): string;
	getBgAnsi?(token: string): string;
	getFgAnsi?(token: string): string;
	getColorMode?(): "256color" | "truecolor";
	colors?: Readonly<Record<string, Color>>;
	getThinkingBorderColor?(level: never): (text: string) => string;
}

/** Key lookup against the user's bindings. */
export interface ChromeKeys {
	matches(data: string, binding: string): boolean;
	getKeys?(binding: string): readonly string[];
}

/** One key hint; the lowest priority number survives longest. */
export interface Hint {
	text: string;
	priority: number;
}

/** Painters for the frame's rules and tab chips. */
export interface Chrome {
	rule(text: string): string;
	tab(title: string, active: boolean): string;
}

/** Remove control characters and bidi overrides from untrusted text. */
export const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

/** Body height for a terminal: fixed while the panel is open, recomputed only on resize. */
export function bodyRowsFor(terminalRows: number): number {
	return Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, terminalRows - CHROME_ROWS - HOST_ROWS));
}

/** Keep leading segments that fit `width`; the first one is always kept, truncated if it must be. */
export function fitSegments(segments: string[], width: number): string {
	let out = segments[0] ?? "";
	for (const seg of segments.slice(1)) {
		if (visibleWidth(out + seg) > width) break;
		out += seg;
	}
	return truncateToWidth(out, Math.max(0, width), ELLIPSIS);
}

function contrast(color: Color): Color {
	const linear = (channel: number) => {
		const v = channel / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const { r, g, b } = colorToRgb(color);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) > 0.179 ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
}

/** Build the painters for a theme and the session's thinking level. */
export function makeChrome(theme: ChromeTheme, level: string | null): Chrome {
	const mode = theme.getColorMode?.() ?? "256color";
	const accent = theme.colors?.accent;
	const activeOpen = accent ? `${foregroundAnsi(contrast(accent), mode)}${backgroundAnsi(accent, mode)}\x1b[1m` : "";
	let grey = "";
	try {
		grey = theme.getBgAnsi?.("selectedBg") ?? "";
	} catch {
		grey = "";
	}
	if (grey === "\x1b[49m") grey = "";
	let paintRule: ((text: string) => string) | null = null;
	if (level && theme.getThinkingBorderColor) {
		try {
			paintRule = theme.getThinkingBorderColor(level as never);
		} catch {
			paintRule = null;
		}
	}
	return {
		rule: (text) => (text ? (paintRule ? paintRule(text) : theme.fg("border", text)) : text),
		tab: (title, active) => {
			const label = ` ${title} `;
			if (active) {
				if (activeOpen) return `${activeOpen}${label}\x1b[22m\x1b[39m\x1b[49m`;
				return theme.bold(theme.inverse ? theme.inverse(label) : label);
			}
			return grey ? `${grey}${theme.fg("muted", label)}\x1b[49m` : theme.fg("muted", label);
		},
	};
}

/** `── left ───── mid ───── right ──`; mid goes first, then right, then left is cut. */
export function ruleLine(width: number, paint: (text: string) => string, left = "", mid = "", right = ""): string {
	const w = Math.max(0, Math.floor(width));
	if (w === 0) return "";
	const cell = (text: string) => (text ? ` ${text} ` : "");
	const fixed = (l: string, m: string, r: string) => 4 + visibleWidth(cell(l)) + visibleWidth(cell(m)) + visibleWidth(cell(r));
	if (mid && fixed(left, mid, right) > w) mid = "";
	if (right && fixed(left, mid, right) > w) right = "";
	if (left && fixed(left, "", "") > w) left = truncateToWidth(left, Math.max(0, w - 6), ELLIPSIS);
	const fill = w - fixed(left, mid, right);
	if (fill < 0) return paint("─".repeat(w));
	const dash = (n: number) => paint("─".repeat(n));
	const before = mid ? Math.floor(fill / 2) : fill;
	return `${dash(2)}${cell(left)}${dash(before)}${cell(mid)}${dash(fill - before)}${cell(right)}${dash(2)}`;
}

/** Join breadcrumb levels with `›`, dropping the earliest first; the last level always survives. */
export function crumbText(theme: ChromeTheme, levels: string[], max: number): string {
	const render = (ls: string[], cut: boolean) => {
		const parts = ls.map((l, i) => (i === ls.length - 1 ? theme.bold(clean(l)) : theme.fg("muted", clean(l))));
		return `${cut ? theme.fg("dim", "… › ") : ""}${parts.join(theme.fg("dim", " › "))}`;
	};
	for (let start = 0; start < levels.length; start++) {
		const out = render(levels.slice(start), start > 0);
		if (visibleWidth(out) <= max) return out;
	}
	return truncateToWidth(render(levels.slice(-1), false), Math.max(0, max), ELLIPSIS);
}

/** The chip bar, scrolled so the active tab is visible, with `n/N` when tabs are cut. */
export function tabBar(chrome: Chrome, theme: ChromeTheme, width: number, titles: string[], active: number): string {
	const chips = titles.map((title, i) => `${TAB_SEPARATOR}${chrome.tab(title, i === active)}`);
	const build = (lo: number, hi: number) => ` ${lo > 0 ? theme.fg("dim", ELLIPSIS) : ""}${chips.slice(lo, hi + 1).join("")}${hi < chips.length - 1 ? theme.fg("dim", ELLIPSIS) : ""}`;
	const count = ` ${active + 1}/${chips.length}`;
	const all = build(0, chips.length - 1);
	if (visibleWidth(all) <= width) return all;
	// The counter's room is reserved up front so a cut bar always says where it is.
	const room = width - count.length;
	let lo = active;
	let hi = active;
	for (let grew = true; grew; ) {
		grew = false;
		if (lo > 0 && visibleWidth(build(lo - 1, hi)) <= room) {
			lo--;
			grew = true;
		}
		if (hi < chips.length - 1 && visibleWidth(build(lo, hi + 1)) <= room) {
			hi++;
			grew = true;
		}
	}
	return truncateToWidth(`${build(lo, hi)}${theme.fg("dim", count)}`, Math.max(0, width), ELLIPSIS);
}

/** The filter line: always present so nothing shifts; empty of text when the screen has no filter. */
export function searchLine(theme: ChromeTheme, width: number, query: string, filterable: boolean): string {
	const line = !filterable ? theme.fg("dim", " ⌕") : query ? ` ⌕ ${clean(query)}${theme.fg("accent", "▏")}` : theme.fg("dim", " ⌕ Type to filter…");
	return truncateToWidth(line, Math.max(0, width), ELLIPSIS);
}

/** Join hints in display order, dropping the highest priority number first until the row fits. */
export function hintRow(theme: ChromeTheme, width: number, hints: Hint[]): string {
	const keep = hints.map(() => true);
	const render = () => ` ${hints.filter((_, i) => keep[i]).map((h) => h.text).join(theme.fg("dim", " · "))}`;
	while (visibleWidth(render()) > width) {
		let drop = -1;
		for (let i = 0; i < hints.length; i++) if (keep[i] && hints[i].priority > 0 && (drop < 0 || hints[i].priority >= hints[drop].priority)) drop = i;
		if (drop < 0) break;
		keep[drop] = false;
	}
	return truncateToWidth(render(), Math.max(0, width), ELLIPSIS);
}

const KEY_NAMES: Record<string, string> = { escape: "esc", return: "enter", pageUp: "pgup", pageDown: "pgdn" };

/** A key as the user sees it. */
export function keyLabel(key: string): string {
	return key.split("+").map((part) => KEY_NAMES[part] ?? part).join("+");
}

/** A hint for a configurable action, labelled from the user's binding. */
export function bindingHint(theme: ChromeTheme, keys: ChromeKeys, binding: string, fallback: string, action: string, priority: number): Hint {
	return rawHint(theme, keys.getKeys?.(binding)?.[0] ?? fallback, action, priority);
}

/** A hint for a fixed panel key. */
export function rawHint(theme: ChromeTheme, key: string, action: string, priority: number): Hint {
	return { text: `${theme.fg("dim", keyLabel(key))} ${theme.fg("muted", action)}`, priority };
}

/** Everything one frame shows. `body` lines are already styled; the frame cuts them to the width. */
export interface FrameSpec {
	width: number;
	theme: ChromeTheme;
	chrome: Chrome;
	/** Breadcrumb levels, root first. */
	crumbs: string[];
	/** Right side of the top rule, most important first. */
	state: string[];
	above: number;
	below: number;
	tabs: string[];
	active: number;
	query: string;
	filterable: boolean;
	body: string[];
	bodyRows: number;
	description: string;
	/** A transient result or warning; replaces the description while set. */
	message: string;
	messageLevel: "info" | "warning" | "error";
	hints: Hint[];
}

/** Render the nine-line frame; the result always has `bodyRows + CHROME_ROWS` lines, each within `width`. */
export function renderFrame(spec: FrameSpec): string[] {
	const { theme, chrome } = spec;
	const w = Math.max(0, Math.floor(spec.width));
	const dim = (text: string) => theme.fg("dim", text);
	const crumbs = crumbText(theme, spec.crumbs, Math.max(8, Math.floor(w / 2)));
	const room = Math.max(0, w - visibleWidth(crumbs) - 10);
	// A state segment is shown whole or not at all: a cut number or word would mislead.
	const state = spec.state.length && visibleWidth(spec.state[0]) <= room ? fitSegments(spec.state.map((s, i) => (i ? dim(" · ") : "") + s), room) : "";
	const body = spec.body.slice(0, spec.bodyRows).map((line) => truncateToWidth(line, w, ELLIPSIS));
	while (body.length < spec.bodyRows) body.push("");
	const text = clean(spec.message);
	const info = !spec.message ? dim(clean(spec.description)) : spec.messageLevel === "info" ? text : theme.fg(spec.messageLevel, `${spec.messageLevel === "error" ? "✗" : "▲"} ${text}`);
	return [
		ruleLine(w, chrome.rule, crumbs, spec.above > 0 ? dim(`↑ ${spec.above} more`) : "", state),
		tabBar(chrome, theme, w, spec.tabs, spec.active),
		searchLine(theme, w, spec.query, spec.filterable),
		"",
		...body,
		ruleLine(w, chrome.rule),
		truncateToWidth(` ${info}`, w, ELLIPSIS),
		hintRow(theme, w, spec.hints),
		ruleLine(w, chrome.rule, "", spec.below > 0 ? dim(`↓ ${spec.below} more`) : ""),
	];
}
