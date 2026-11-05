/*
 * dials.ts — the session's budget and protected tail: human token amounts ("200k", "1M", "85%"),
 * per-model defaults from config.json, and the values the user set in this session, remembered in
 * the session file per model so a resume or a model switch restores them.
 */

/** Session entry type recording a budget or tail the user set, with the model it was set for. */
export const DIALS_ENTRY = "accordion.dials";

/** Protected tail when neither the session nor a default sets one. */
export const DEFAULT_PROTECT_TOKENS = 20_000;

/** A model default: amounts as written in config.json (`"200k"`, `"85%"`, `200000`). */
export interface ModelDials {
	budget?: string;
	protect?: string;
}

/** `provider/model`, `provider/*` or `*` → defaults. */
export type ModelDefaults = Record<string, ModelDials>;

/** One `accordion.dials` entry. */
export interface DialsRecord {
	model: string;
	budget?: number;
	protect?: number;
}

export type DialKind = "budget" | "protect";

/** Where a resolved value came from. */
export type DialSource = { kind: "session" } | { kind: "default"; key: string } | { kind: "window" } | { kind: "builtin" };

export interface ResolvedDials {
	budget: number | null;
	protect: number;
	sources: Record<DialKind, DialSource>;
}

const UNITS: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000 };

/**
 * Parse a token amount: `200000`, `200k`, `1M`, `0.5M`, `1_000k`, or `85%` of `window`.
 * Returns an error message for anything else, and for a percentage without a known window.
 */
export function parseTokens(text: string, window: number | null): number | { error: string } {
	const t = text.trim().toLowerCase().replace(/[_,\s]/g, "");
	const pct = /^(\d+(?:\.\d+)?)%$/.exec(t);
	if (pct) {
		const p = Number(pct[1]);
		if (!(p > 0 && p <= 100)) return { error: `"${text}": a percentage must be above 0 and at most 100` };
		if (!window) return { error: `"${text}": the model's context window is not known yet` };
		return Math.round((window * p) / 100);
	}
	const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
	if (!m) return { error: `"${text}" is not a token amount; use e.g. 200k, 1M, 0.5M, 200000 or 85%` };
	const n = Math.round(Number(m[1]) * UNITS[m[2] ?? ""]);
	return Number.isSafeInteger(n) ? n : { error: `"${text}" is too large` };
}

/** `200k`, `1M`, `1.5M`, `272k`, `12.5k`, `900`: the shortest exact form `parseTokens` reads back. */
export function formatTokens(n: number): string {
	if (n >= 1_000_000 && n % 10_000 === 0) return `${n / 1_000_000}M`;
	if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}k`;
	return String(n);
}

/** A config key is `*`, `provider/*` or `provider/model-id` (the id may contain `/`). */
export function isModelPattern(key: string): boolean {
	return key === "*" || /^[^/\s*]+\/(\*|[^\s*]+)$/.test(key);
}

/** The keys that apply to `model` (`provider/model-id`), most specific first. */
function patternsFor(model: string): string[] {
	const slash = model.indexOf("/");
	return slash > 0 ? [model, `${model.slice(0, slash)}/*`, "*"] : ["*"];
}

/** Keep valid keys and amounts; amounts must parse (percentages are checked against a window later). */
export function sanitizeModelDefaults(value: unknown): ModelDefaults {
	const out: ModelDefaults = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [rawKey, rawDials] of Object.entries(value)) {
		const key = rawKey.trim();
		if (!isModelPattern(key) || !rawDials || typeof rawDials !== "object" || Array.isArray(rawDials)) continue;
		const dials: ModelDials = {};
		for (const kind of ["budget", "protect"] as const) {
			const v = (rawDials as Record<string, unknown>)[kind];
			const text = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
			if (text && typeof parseTokens(text, 1_000_000) === "number") dials[kind] = text;
		}
		if (dials.budget !== undefined || dials.protect !== undefined) out[key] = dials;
	}
	return out;
}

/** The last value per dial the user set in this session for `model`. */
export function sessionDials(records: readonly DialsRecord[], model: string): Partial<Record<DialKind, number>> {
	const out: Partial<Record<DialKind, number>> = {};
	for (const r of records) {
		if (r.model !== model) continue;
		if (typeof r.budget === "number") out.budget = r.budget;
		if (typeof r.protect === "number") out.protect = r.protect;
	}
	return out;
}

/** `accordion.dials` records from session entries, oldest first. */
export function dialsRecordsOf(entries: readonly unknown[]): DialsRecord[] {
	const out: DialsRecord[] = [];
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== DIALS_ENTRY) continue;
		const d = entry.data as Partial<DialsRecord> | undefined;
		if (typeof d?.model !== "string") continue;
		out.push({ model: d.model, ...(typeof d.budget === "number" ? { budget: d.budget } : {}), ...(typeof d.protect === "number" ? { protect: d.protect } : {}) });
	}
	return out;
}

/**
 * The budget and tail for `model`: this session's last value for that model, else the most specific
 * model default, else the context window (budget) or the built-in 20k (tail). The budget never
 * exceeds the window; it is null only when neither a value nor a window is known.
 */
export function resolveDials(model: string, window: number | null, records: readonly DialsRecord[], defaults: ModelDefaults): ResolvedDials {
	const session = sessionDials(records, model);
	const keys = patternsFor(model);
	const fromDefault = (kind: DialKind): { value: number; key: string } | null => {
		for (const key of keys) {
			const text = defaults[key]?.[kind];
			if (text === undefined) continue;
			const v = parseTokens(text, window);
			if (typeof v === "number") return { value: v, key };
		}
		return null;
	};
	const clamp = (n: number) => (window ? Math.min(n, window) : n);
	let budget: number | null;
	let budgetSource: DialSource;
	const db = fromDefault("budget");
	if (session.budget !== undefined) [budget, budgetSource] = [clamp(session.budget), { kind: "session" }];
	else if (db) [budget, budgetSource] = [clamp(db.value), { kind: "default", key: db.key }];
	else [budget, budgetSource] = [window, { kind: "window" }];
	let protect: number;
	let protectSource: DialSource;
	const dp = fromDefault("protect");
	if (session.protect !== undefined) [protect, protectSource] = [session.protect, { kind: "session" }];
	else if (dp) [protect, protectSource] = [dp.value, { kind: "default", key: dp.key }];
	else [protect, protectSource] = [DEFAULT_PROTECT_TOKENS, { kind: "builtin" }];
	return { budget, protect, sources: { budget: budgetSource, protect: protectSource } };
}

/** `session`, `default claude/*`, `model window`, `built-in`. */
export function describeSource(s: DialSource): string {
	return s.kind === "session" ? "set in this session" : s.kind === "default" ? `default ${s.key}` : s.kind === "window" ? "model window" : "built-in";
}
