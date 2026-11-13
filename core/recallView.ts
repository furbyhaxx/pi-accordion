/*
 * recallView.ts — the bounded text the agent's `recall` tool returns.
 *
 * A fold can stand for hundreds of thousands of tokens, so recall never echoes a fold whole when it
 * would exceed one call's budget: it returns an index of addressable entries (`code.N`) and
 * subtask codes, pages of one entry, or excerpts matching a query. Pure over a `Truth`.
 */
import type { Block } from "./types";
import type { Truth } from "./truth";
import { foldCode } from "./digest";
import { blockLabel, resolveRecall } from "./agentView";
import { clip } from "./tokens";

/** Characters one recall call may return across all its codes (~8k tokens). */
export const RECALL_BUDGET_CHARS = 32_000;
const MIN_SECTION_CHARS = 2_000;
/** Reserved inside every call for the lines naming what was not shown. */
const NOTE_CHARS = 600;
const PREVIEW_CHARS = 100;
const EXCERPT_RADIUS = 160;
const MAX_EXCERPTS_PER_ENTRY = 5;
const MAX_QUERY_CHARS = 200;

export interface RecallRequest {
	codes: string[];
	/** Case-insensitive literal text to search for inside the recalled content. */
	query?: string;
	/** 1-based page of an index, an entry or a query result. */
	page?: number;
	/** The report of task `<list>/<id>`; without it a task code returns its entry index. */
	reportOf?: (taskKey: string) => TaskReport | null;
	/** Page size of one call; fixed for a session so paging is stable. */
	budgetChars?: number;
	/** What this call may return, at most `budgetChars`. */
	grantChars?: number;
}

/** A finished or open task as its own report; what a task code returns instead of transcript. */
export interface TaskReport {
	title: string;
	/** Null while the task is still open. */
	status: string | null;
	criteria?: string[];
	outcome?: string;
	decisions?: string[];
	open?: string[];
	changed?: string[];
	verified?: string[];
	/** Direct subtasks, in list order. */
	children?: { id: string; title: string; status: string | null; outcome?: string }[];
}

export interface RecallItem {
	/** The address as requested: `code` or `code.N`. */
	code: string;
	label: string;
	mode: "full" | "entry" | "index" | "query" | "report";
	/** Ids whose content (or excerpts of it) this result actually returned. */
	ids: string[];
}

export interface RecallView {
	text: string;
	items: RecallItem[];
	missing: string[];
	/** Addresses that exist but did not fit this call. */
	skipped: string[];
	/** True when budget or paging withheld content this call could have returned. */
	truncated: boolean;
}

interface Source {
	code: string;
	label: string;
	/** Members with text, in conversation order; entry `code.N` is `entries[N - 1]`. */
	entries: Block[];
	/** `<list>/<id>` when the code is a task handle. */
	taskKey?: string;
}

const ADDRESS = /^([0-9a-z]{6})(?:\.([1-9]\d*|entries))?$/i;
const CHILD_OUTCOME_CHARS = 160;
const COMPACT_ITEM_CHARS = 160;

export function recallView(truth: Truth, req: RecallRequest): RecallView {
	const budget = Math.max(MIN_SECTION_CHARS + NOTE_CHARS, req.budgetChars ?? RECALL_BUDGET_CHARS);
	const grant = Math.min(budget, Math.max(0, req.grantChars ?? budget));
	// Sections are paged against the fixed page size, never the grant, so page N means the same in any call.
	const pageSize = budget - NOTE_CHARS;
	const room = grant - NOTE_CHARS;
	const query = req.query?.trim().slice(0, MAX_QUERY_CHARS) || undefined;
	const page = Math.max(1, Math.floor(req.page ?? 1));
	const sections: string[] = [];
	const items: RecallItem[] = [];
	const missing: string[] = [];
	const skipped: string[] = [];
	let truncated = false;
	let used = 0;
	const place = (compact: boolean): void => {
		sections.length = items.length = missing.length = skipped.length = 0;
		truncated = false;
		used = 0;
		for (const address of req.codes) {
			const m = ADDRESS.exec(address);
			const source = m ? sourceOf(truth, m[1].toLowerCase()) : null;
			if (!m || !source) {
				missing.push(address);
				continue;
			}
			const suffix = m[2]?.toLowerCase();
			const section = render(truth, source, address, suffix === "entries" ? "entries" : suffix ? Number(suffix) : undefined, query, page, pageSize, req.reportOf, compact);
			if (!section) {
				missing.push(address);
				continue;
			}
			if (used + section.text.length + 2 > room) {
				skipped.push(address);
				continue;
			}
			sections.push(section.text);
			items.push(section.item);
			truncated ||= section.truncated;
			used += section.text.length + 2;
		}
	};
	place(false);
	// Many reports in one call: shorter reports for all beat full reports for some.
	if (skipped.length && items.some((i) => i.mode === "report")) place(true);
	const notes: string[] = [];
	if (skipped.length) {
		truncated = true;
		notes.push(`[budget reached] Not shown: ${skipped.map((c) => "#" + c).join(", ")}. Recall them in a separate call.`);
	}
	if (missing.length) notes.push(`No folded content for: ${missing.map((c) => "#" + c).join(", ")} (already full, not in this session's context, or no such entry).`);
	const note = notes.join("\n");
	if (note) sections.push(note.length > NOTE_CHARS - 2 ? `${note.slice(0, NOTE_CHARS - 3)}…` : note);
	return { text: sections.join("\n\n") || "Nothing to recall.", items, missing, skipped, truncated };
}

function sourceOf(truth: Truth, code: string): Source | null {
	const res = resolveRecall(truth, [code]);
	if (!res.restored.length) return null;
	// One code can match several carriers of the same task; each member is listed once.
	const ids = [...new Set(res.restored.flatMap((r) => r.ids))];
	const handle = truth.groups.flatMap((g) => g.handles ?? []).find((h) => h.id.startsWith("t:") && foldCode(h.id) === code);
	const entries = ids
		.map((id) => truth.get(id))
		.filter((b): b is Block => !!b && b.text.length > 0)
		.sort((a, b) => a.order - b.order);
	return { code, label: res.restored[0].label, entries, ...(handle ? { taskKey: handle.id.slice(2) } : {}) };
}

function render(
	truth: Truth,
	src: Source,
	address: string,
	target: number | "entries" | undefined,
	query: string | undefined,
	page: number,
	budget: number,
	reportOf: RecallRequest["reportOf"],
	compact: boolean,
): { text: string; item: RecallItem; truncated: boolean } | null {
	if (typeof target === "number") {
		const entry = src.entries[target - 1];
		if (!entry) return null;
		const label = `${blockLabel(entry)} · entry ${target} of #${src.code}`;
		if (query) return querySection(src, [[target, entry]], address, label, query, page, budget);
		return entrySection(entry, address, label, page, budget);
	}
	const numbered = src.entries.map((b, i) => [i + 1, b] as [number, Block]);
	if (query) return querySection(src, numbered, address, src.label, query, page, budget);
	if (target === "entries") return indexSection(truth, src, address, page, budget);
	// A task code returns its report, never its transcript.
	const report = src.taskKey ? reportOf?.(src.taskKey) : null;
	if (report) return reportSection(truth, src, report, budget, compact);
	const full = src.entries.map((b) => b.text).join("\n\n");
	const head = `[recalled ${src.label} (#${address})]\n`;
	if (head.length + full.length <= budget) {
		return { text: head + full, item: { code: address, label: src.label, mode: "full", ids: src.entries.map((b) => b.id) }, truncated: false };
	}
	return indexSection(truth, src, address, page, budget);
}

function reportSection(truth: Truth, src: Source, report: TaskReport, budget: number, compact: boolean) {
	const cut = (s: string) => (compact ? clip(s, COMPACT_ITEM_CHARS) : s.replace(/\s+/g, " ").trim());
	const list = (name: string, xs: string[] | undefined) => (xs?.length ? [`${name}:`, ...xs.map((x) => `- ${cut(x)}`)] : []);
	const codes = new Map(childHandles(truth, src.code, new Set(src.entries.map((b) => b.id))).map((c) => [c.id, c]));
	const list0 = src.taskKey!.slice(0, src.taskKey!.indexOf("/"));
	const total = src.entries.reduce((n, b) => n + b.tokens, 0);
	const lines = [
		`[report of task ${src.taskKey} (#${src.code}) · ${report.status ?? "open"} · ${src.entries.length} entries · ~${fmt(total)} tok of transcript, not shown]`,
		`title: ${cut(report.title)}`,
		...(report.outcome ? [`outcome: ${cut(report.outcome)}`] : []),
		...list("decisions", report.decisions),
		...list("open", report.open),
		...(compact ? [] : list("criteria", report.criteria)),
		...(report.changed?.length ? [`changed: ${report.changed.slice(0, compact ? 8 : 30).join(", ")}${report.changed.length > (compact ? 8 : 30) ? ` (+${report.changed.length - (compact ? 8 : 30)} more)` : ""}`] : []),
		...list("verified", report.verified?.slice(compact ? -3 : -8)),
	];
	if (report.children?.length) {
		lines.push("subtasks (recall a code for its report):");
		for (const c of report.children) {
			const h = codes.get(`t:${list0}/${c.id}`);
			const outcome = !compact && c.outcome ? ` — ${clip(c.outcome, CHILD_OUTCOME_CHARS)}` : "";
			lines.push(`  ${h ? `#${foldCode(h.id)}` : "(no code)"}  ${c.id} · ${c.status ?? "open"} · ${clip(c.title, 80)}${outcome}`);
		}
	}
	lines.push(`Exact values: recall({codes:["${src.code}"], query:"text"}) · entry list: recall({codes:["${src.code}.entries"]}) · one entry: recall({codes:["${src.code}.N"]})`);
	let text = lines.join("\n");
	const over = text.length > budget;
	if (over) text = `${text.slice(0, budget - 40)}\n[report cut at the call limit]`;
	return { text, item: { code: src.code, label: src.label, mode: "report" as const, ids: [] }, truncated: over };
}

function entrySection(entry: Block, address: string, label: string, page: number, budget: number) {
	const head = (p: number, n: number) => `[recalled ${label} (#${address})${n > 1 ? ` · page ${p}/${n}` : ""}]\n`;
	// Page size must not depend on the requested page, or page boundaries shift between calls.
	const size = budget - head(99_999, 99_999).length - 200;
	const pages = splitText(entry.text, size);
	const p = Math.min(page, pages.length);
	const more = p < pages.length ? `\n[continues: recall({codes:["${address}"], page:${p + 1}})]` : "";
	const past = page > pages.length ? `[page ${page} is past the end; showing the last page]\n` : "";
	return { text: past + head(p, pages.length) + pages[p - 1] + more, item: { code: address, label, mode: "entry" as const, ids: [entry.id] }, truncated: pages.length > 1 };
}

function indexSection(truth: Truth, src: Source, address: string, page: number, budget: number) {
	const memberIds = new Set(src.entries.map((b) => b.id));
	const children = childHandles(truth, src.code, memberIds);
	const covered = new Set(children.flatMap((c) => c.memberIds));
	const lines: string[] = [];
	if (children.length) {
		lines.push("Subtasks (recall a code to open its own index):");
		for (const c of children) lines.push(`  #${foldCode(c.id)}  ${c.id.replace(/^t:/, "")} · ${c.memberIds.length} entries · ~${fmt(tokensOf(truth, c.memberIds))} tok`);
		lines.push("Entries outside subtasks:");
	}
	src.entries.forEach((b, i) => {
		if (!covered.has(b.id)) lines.push(`  .${i + 1}  ${blockLabel(b)} · ~${fmt(b.tokens)} tok · ${preview(b.text)}`);
	});
	const total = src.entries.reduce((n, b) => n + b.tokens, 0);
	const head = [
		`[index of ${src.label} (#${address}) · ${src.entries.length} entries · ~${fmt(total)} tok — too large to return whole]`,
		`Read one entry: recall({codes:["${src.code}.N"]}) · search: recall({codes:["${src.code}"], query:"text"})`,
	].join("\n");
	const pages = splitLines(lines, budget - head.length - 160);
	const p = Math.min(page, pages.length);
	const nav = pages.length > 1 ? `\n[index page ${p}/${pages.length}${p < pages.length ? `; next: recall({codes:["${address}"], page:${p + 1}})` : ""}]` : "";
	return { text: `${head}\n${pages[p - 1]}${nav}`, item: { code: address, label: src.label, mode: "index" as const, ids: [] }, truncated: true };
}

function querySection(src: Source, entries: [number, Block][], address: string, label: string, query: string, page: number, budget: number) {
	const needle = query.toLowerCase();
	const hits: { no: number; block: Block; line: string }[] = [];
	let matches = 0;
	for (const [no, b] of entries) {
		const hay = b.text.toLowerCase();
		const at: number[] = [];
		for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) at.push(i);
		if (!at.length) continue;
		matches += at.length;
		const shown = at.slice(0, MAX_EXCERPTS_PER_ENTRY).map((i) => excerpt(b.text, i, needle.length));
		const extra = at.length > MAX_EXCERPTS_PER_ENTRY ? ` (+${at.length - MAX_EXCERPTS_PER_ENTRY} more)` : "";
		hits.push({ no, block: b, line: `  #${src.code}.${no}  ${blockLabel(b)}${extra}\n${shown.map((s) => `    …${s}…`).join("\n")}` });
	}
	if (!hits.length) {
		return { text: `[search #${address} for "${query}"] No match in ${entries.length} entries. Try a shorter literal term, or recall({codes:["${address}"]}) for the index.`, item: { code: address, label, mode: "query" as const, ids: [] }, truncated: false };
	}
	const head = `[search ${label} (#${address}) for "${query}" · ${matches} matches in ${hits.length} entries]\nRead a whole entry: recall({codes:["${src.code}.N"]})`;
	const size = budget - head.length - 200 - query.length;
	const pages = splitLines(hits.map((h) => (h.line.length > size ? h.line.slice(0, size) : h.line)), size);
	const p = Math.min(page, pages.length);
	const shownIds = hits.filter((h) => pages[p - 1].includes(`#${src.code}.${h.no} `)).map((h) => h.block.id);
	const nav = pages.length > 1 ? `\n[result page ${p}/${pages.length}${p < pages.length ? `; next: recall({codes:["${address}"], query:${JSON.stringify(query)}, page:${p + 1}})` : ""}]` : "";
	return { text: `${head}\n${pages[p - 1]}${nav}`, item: { code: address, label, mode: "query" as const, ids: shownIds }, truncated: pages.length > 1 };
}

/** Recallable handles strictly inside `memberIds`, keeping only the outermost ones. */
function childHandles(truth: Truth, code: string, memberIds: Set<string>): { id: string; memberIds: string[] }[] {
	const seen = new Map<string, string[]>();
	for (const g of truth.groups) {
		for (const h of g.handles ?? []) {
			if (seen.has(h.id) || foldCode(h.id) === code || h.memberIds.length >= memberIds.size) continue;
			if (!h.memberIds.every((id) => memberIds.has(id)) || !truth.canRecallHandle(g, h)) continue;
			seen.set(h.id, h.memberIds);
		}
	}
	const all = [...seen].map(([id, ids]) => ({ id, memberIds: ids, set: new Set(ids) }));
	const outer = all.filter((c) => !all.some((o) => o !== c && o.set.size > c.set.size && c.memberIds.every((id) => o.set.has(id))));
	const first = (ids: string[]) => truth.get(ids[0])?.order ?? 0;
	return outer.sort((a, b) => first(a.memberIds) - first(b.memberIds)).map(({ id, memberIds: ids }) => ({ id, memberIds: ids }));
}

function tokensOf(truth: Truth, ids: string[]): number {
	return ids.reduce((n, id) => n + (truth.get(id)?.tokens ?? 0), 0);
}

function splitText(text: string, size: number): string[] {
	const pages: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(text.length, i + size);
		if (end < text.length) {
			const nl = text.lastIndexOf("\n", end);
			if (nl > i + size * 0.8) end = nl + 1;
		}
		pages.push(text.slice(i, end));
		i = end;
	}
	return pages.length ? pages : [""];
}

function splitLines(lines: string[], size: number): string[] {
	const pages: string[] = [];
	let cur = "";
	for (const line of lines) {
		if (cur && cur.length + 1 + line.length > size) {
			pages.push(cur);
			cur = "";
		}
		cur = cur ? `${cur}\n${line}` : line;
	}
	pages.push(cur);
	return pages;
}

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return JSON.stringify(flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat);
}

function excerpt(text: string, at: number, len: number): string {
	return text
		.slice(Math.max(0, at - EXCERPT_RADIUS), at + len + EXCERPT_RADIUS)
		.replace(/\s+/g, " ")
		.trim();
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}
