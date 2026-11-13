/*
 * factLedger.ts — facts noted about a task when it is folded (SPEC-0003 §8).
 *
 * A side model lists values a later step may look up; a row is kept only when its value occurs
 * character for character in the block it cites. Rows never enter the standing context: `recall`
 * shows the ones a query matches. Pure: prompt, parsing, verification, matching and the store.
 */
import type { Block } from "./types";
import type { Term } from "./recallSearch";

export interface FactRow {
	key: string;
	value: string;
	unit?: string;
	/** The block the value was copied from. */
	blockId: string;
}

export const LEDGER_ENTRY = "accordion.recall.ledger";
export const LEDGER_OUTPUT_TOKENS = 4_000;
/** Tasks smaller than this are covered by their report. */
export const LEDGER_MIN_TOKENS = 2_000;

const CHARS_PER_TOKEN = 4;
const CHUNK_CHARS = 24_000 * CHARS_PER_TOKEN;
const MAX_CHUNKS = 4;
/** An entry longer than this is shown by its two ends; the check still runs against all of it. */
const ENTRY_CHARS = 6_000;
const ROWS_PER_CHUNK = 60;
const MAX_ROWS = 120;
const KEY_CHARS = 120;
const VALUE_CHARS = 300;
const UNIT_CHARS = 24;

export const LEDGER_SYSTEM = [
	"You read the numbered transcript of one finished task of a coding agent and list the facts a later step may need to look up:",
	"measured values, counts, identifiers (commit hashes, UUIDs, ids), paths and file names, ports, hosts, model names, versions, commands that mattered, errors with their message, and decisions with their reason.",
	"",
	'Output one JSON object and nothing else: {"rows":[{"key":"...","value":"...","unit":"...","entry":N}]}',
	'- "key": what the value is, in a few plain words, specific enough to find by search.',
	'- "value": copied character for character from entry N. Never paraphrase or reformat a value.',
	'- "unit": the unit or kind (count, bits, commit, path, port, ...), "" when none.',
	'- "entry": the number of the entry the value is copied from.',
	`- One fact per row. Skip narration, plans and anything without a concrete value. At most ${ROWS_PER_CHUNK} rows.`,
].join("\n");

export interface LedgerChunk {
	prompt: string;
	/** Entry number N in the prompt is `ids[N - 1]`. */
	ids: string[];
}

function shown(text: string): string {
	return text.length <= ENTRY_CHARS ? text : `${text.slice(0, ENTRY_CHARS / 2)}\n[…]\n${text.slice(-ENTRY_CHARS / 2)}`;
}

/** The task's entries as prompts of bounded size. Of a task too long for all of them, the first and the last parts are read. */
export function ledgerChunks(entries: readonly Block[]): { chunks: LedgerChunk[]; skipped: number } {
	const all: { text: string; ids: string[] }[] = [];
	let cur: { text: string; ids: string[] } = { text: "", ids: [] };
	for (const b of entries) {
		if (!b.text) continue;
		const body = shown(b.text);
		if (cur.ids.length && cur.text.length + body.length > CHUNK_CHARS) {
			all.push(cur);
			cur = { text: "", ids: [] };
		}
		cur.ids.push(b.id);
		cur.text += `--- entry ${cur.ids.length} [${b.kind}${b.toolName ? ` ${b.toolName}` : ""}]\n${body}\n`;
	}
	if (cur.ids.length) all.push(cur);
	const kept = all.length <= MAX_CHUNKS ? all : [all[0], ...all.slice(all.length - (MAX_CHUNKS - 1))];
	return { chunks: kept.map((c) => ({ prompt: `<transcript>\n${c.text}</transcript>`, ids: c.ids })), skipped: all.length - kept.length };
}

/** The first balanced JSON object in `reply`, or null. */
function firstObject(reply: string): unknown {
	const start = reply.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	for (let i = start; i < reply.length; i++) {
		const ch = reply[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			try {
				return JSON.parse(reply.slice(start, i + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * The rows of one reply that pass the check: the cited entry exists and contains the value
 * verbatim. Null when the reply holds no row list at all.
 */
export function verifiedRows(reply: string, chunk: LedgerChunk, textOf: (blockId: string) => string): FactRow[] | null {
	const rows = (firstObject(reply) as { rows?: unknown } | null)?.rows;
	if (!Array.isArray(rows)) return null;
	const out: FactRow[] = [];
	const seen = new Set<string>();
	for (const raw of rows.slice(0, ROWS_PER_CHUNK)) {
		const r = raw as { key?: unknown; value?: unknown; unit?: unknown; entry?: unknown };
		const key = typeof r?.key === "string" ? r.key.trim().replace(/\s+/g, " ") : "";
		const value = typeof r?.value === "string" ? r.value : typeof r?.value === "number" ? String(r.value) : "";
		const blockId = Number.isInteger(r?.entry) ? chunk.ids[(r.entry as number) - 1] : undefined;
		if (!key || !value.trim() || !blockId || key.length > KEY_CHARS || value.length > VALUE_CHARS) continue;
		if (!textOf(blockId).includes(value) || seen.has(`${key}\n${value}`)) continue;
		seen.add(`${key}\n${value}`);
		const unit = typeof r.unit === "string" ? r.unit.trim().slice(0, UNIT_CHARS) : "";
		out.push({ key, value, ...(unit ? { unit } : {}), blockId });
	}
	return out;
}

/** The rows every term of a query matches, in ledger order. */
export function matchFacts(rows: readonly FactRow[], terms: readonly Term[]): FactRow[] {
	return rows.filter((r) => {
		const text = `${r.key} ${r.value} ${r.unit ?? ""}`;
		const lower = text.toLowerCase();
		return terms.every((t) => t.find(text, lower).length > 0);
	});
}

/** The session's rows by task key `<list>/<id>`. A task with an empty list was read and had nothing to note. */
export class FactLedger {
	private byTask = new Map<string, FactRow[]>();
	private flat: FactRow[] | null = null;

	has(task: string): boolean {
		return this.byTask.has(task);
	}

	set(task: string, rows: FactRow[]): void {
		this.byTask.set(task, rows.slice(0, MAX_ROWS));
		this.flat = null;
	}

	all(): readonly FactRow[] {
		return (this.flat ??= [...this.byTask.values()].flat());
	}

	reset(tasks: Map<string, FactRow[]> = new Map()): void {
		this.byTask = tasks;
		this.flat = null;
	}
}

/** What one task's rows are stored as in the session log. */
export function ledgerData(task: string, rows: readonly FactRow[]): { task: string; rows: [string, string, string, string][] } {
	return { task, rows: rows.slice(0, MAX_ROWS).map((r) => [r.key, r.value, r.unit ?? "", r.blockId]) };
}

/** The ledger a session's entries hold; a later entry for a task replaces an earlier one. */
export function ledgerOf(entries: readonly unknown[]): Map<string, FactRow[]> {
	const out = new Map<string, FactRow[]>();
	for (const raw of entries) {
		const entry = raw as { type?: unknown; customType?: unknown; data?: { task?: unknown; rows?: unknown } };
		const data = entry?.data;
		if (entry?.type !== "custom" || entry.customType !== LEDGER_ENTRY || typeof data?.task !== "string" || !Array.isArray(data.rows)) continue;
		const rows: FactRow[] = [];
		for (const r of data.rows.slice(0, MAX_ROWS)) {
			if (!Array.isArray(r) || r.length < 4 || !r.every((x) => typeof x === "string") || !r[0] || !r[1] || !r[3]) continue;
			rows.push({ key: r[0], value: r[1], ...(r[2] ? { unit: r[2] } : {}), blockId: r[3] });
		}
		out.set(data.task, rows);
	}
	return out;
}
