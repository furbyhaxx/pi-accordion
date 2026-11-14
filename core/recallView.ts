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
import { blockLabel, recallIndex } from "./agentView";
import { clip } from "./tokens";
import { parseQuery, type Term } from "./recallSearch";
import { matchFacts, type FactRow } from "./factLedger";

/** Characters one recall call may return across all its codes (~8k tokens). */
export const RECALL_BUDGET_CHARS = 32_000;
const MIN_SECTION_CHARS = 2_000;
/** Reserved inside every call for the lines naming what was not shown. */
const NOTE_CHARS = 600;
const PREVIEW_CHARS = 100;
const EXCERPT_RADIUS = 160;
const MAX_EXCERPTS_PER_ENTRY = 5;
/** The agent tool this module serves; its own calls and results are copies and are not searched. */
export const RECALL_TOOL = "recall";
const MAX_QUERY_CHARS = 200;
const MAX_FACTS = 12;
const FACT_KEY_CHARS = 80;
const FACT_ABOUT_CHARS = 50;
const FACT_VALUE_CHARS = 200;

export interface RecallRequest {
	codes: string[];
	/** Case-insensitive literal text to search for inside the recalled content. */
	query?: string;
	/** 1-based page of an index, an entry or a query result. */
	page?: number;
	/** The report of task `<list>/<id>`; a task without one reads like any other fold. */
	reportOf?: (taskKey: string) => TaskReport | null;
	/** Page size of one call; fixed for a session so paging is stable. */
	budgetChars?: number;
	/** What this call may return, at most `budgetChars`. */
	grantChars?: number;
	/** The session's fact ledger; a search shows the rows it matches before transcript hits. */
	facts?: readonly FactRow[];
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
	/** Descendants in list order, with their transcript members. */
	children?: { id: string; title: string; status: string | null; outcome?: string; memberIds?: string[] }[];
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
	if (req.query && req.query.length > MAX_QUERY_CHARS) return { text: `Query exceeds the ${MAX_QUERY_CHARS}-character limit.`, items: [], missing: [], skipped: [], truncated: false };
	const query = req.query?.trim() || undefined;
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
			const section = render(truth, source, address, suffix === "entries" ? "entries" : suffix ? Number(suffix) : undefined, query, page, pageSize, req.reportOf, compact, req.facts);
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
	if (!req.codes.length && query) {
		const section = querySection(truth, archive(truth), { codes: [], label: "all folded content", itemCode: "*" }, query, page, pageSize, req.facts);
		if (section.text.length > room) return { text: "[budget reached] Not shown: search results for all folded content. Recall them in a separate call.", items: [], missing: [], skipped: ["*"], truncated: true };
		return { text: section.text, items: [section.item], missing: [], skipped: [], truncated: section.truncated };
	}
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
	const restored = recallIndex(truth).get(code);
	if (!restored?.length) return null;
	// One code can match several carriers of the same task; each member is listed once.
	const ids = [...new Set(restored.flatMap((r) => r.ids))];
	const handle = truth.groups.flatMap((g) => g.handles ?? []).find((h) => h.id.startsWith("t:") && foldCode(h.id) === code);
	const entries = ids
		.map((id) => truth.get(id))
		.filter((b): b is Block => !!b && b.text.length > 0)
		.sort((a, b) => a.order - b.order);
	return { code, label: restored[0].label, entries, ...(handle ? { taskKey: handle.id.slice(2) } : {}) };
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
	facts?: readonly FactRow[],
): { text: string; item: RecallItem; truncated: boolean } | null {
	if (typeof target === "number") {
		const entry = src.entries[target - 1];
		if (!entry) return null;
		const label = `${blockLabel(entry)} · entry ${target} of #${src.code}`;
		if (query) return querySection(truth, [{ address: `${src.code}.${target}`, block: entry }], { codes: [address], label, itemCode: address }, query, page, budget, facts);
		return entrySection(entry, address, label, page, budget);
	}
	if (query) return querySection(truth, src.entries.map((block, i) => ({ address: `${src.code}.${i + 1}`, block })), { codes: [address], label: src.label, itemCode: address }, query, page, budget, facts);
	if (target === "entries") return indexSection(truth, src, address, page, budget);
	// A task code returns its report, never its transcript.
	const report = src.taskKey ? reportOf?.(src.taskKey) : null;
	if (report) return reportSection(truth, src, report, page, budget, compact);
	const full = src.entries.map((b) => b.text).join("\n\n");
	const head = `[recalled ${src.label} (#${address})]\n`;
	if (head.length + full.length <= budget) {
		return { text: head + full, item: { code: address, label: src.label, mode: "full", ids: src.entries.map((b) => b.id) }, truncated: false };
	}
	return indexSection(truth, src, address, page, budget);
}

function reportSection(truth: Truth, src: Source, report: TaskReport, page: number, budget: number, compact: boolean) {
	const cut = (s: string) => (compact ? clip(s, COMPACT_ITEM_CHARS) : s.replace(/\s+/g, " ").trim());
	const list = (name: string, xs: string[] | undefined) => (xs?.length ? [`${name}:`, ...xs.map((x) => `- ${cut(x)}`)] : []);
	const codes = new Map(childHandles(truth, src.code, new Set(src.entries.map((b) => b.id)), false).map((c) => [c.id, c]));
	const positions = new Map(src.entries.map((b, i) => [b.id, i + 1]));
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
		lines.push("subtasks (recall a code for its report, or an entry in the shown range):");
		for (const c of report.children) {
			const h = codes.get(`t:${list0}/${c.id}`);
			const entries = (c.memberIds ?? []).flatMap((id) => positions.has(id) ? [positions.get(id)!] : []);
			const range = entries.length ? `#${src.code}.${Math.min(...entries)}-${Math.max(...entries)}` : "(no code)";
			const outcome = !compact && c.outcome ? ` — ${clip(c.outcome, CHILD_OUTCOME_CHARS)}` : "";
			const depth = c.id.split(".").length - src.taskKey!.slice(src.taskKey!.indexOf("/") + 1).split(".").length;
			lines.push(`${"  ".repeat(Math.max(1, depth))}${h ? `#${foldCode(h.id)}` : range}  ${c.id} · ${c.status ?? "open"} · ${clip(c.title, 80)}${outcome}`);
		}
	}
	lines.push(`Exact values: recall({codes:["${src.code}"], query:"text"}) · entry list: recall({codes:["${src.code}.entries"]}) · one entry: recall({codes:["${src.code}.N"]})`);
	const head = lines.shift()!;
	const size = budget - head.length - 200;
	const pages = splitText(lines.join("\n"), size);
	const p = Math.min(page, pages.length);
	const nav = pages.length > 1 ? `\n[report page ${p}/${pages.length}${p < pages.length ? `; next: recall({codes:["${src.code}"], page:${p + 1}})` : ""}]` : "";
	return { text: `${head}\n${pages[p - 1]}${nav}`, item: { code: src.code, label: src.label, mode: "report" as const, ids: [] }, truncated: pages.length > 1 };
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

/** One searchable entry and the address a hit prints for it. */
interface Candidate {
	address: string;
	block: Block;
	/** `<list>/<id>` of the task the address belongs to, shown on archive hits. */
	task?: string;
}

interface Scope {
	/** The `codes` of the follow-up call that pages this search; empty for the whole archive. */
	codes: string[];
	label: string;
	itemCode: string;
}

/** Ledger rows of the searched entries that the query matches, as lines; shown on the first page only. */
function factLines(candidates: Candidate[], terms: Term[], facts: readonly FactRow[] | undefined): { text: string; ids: string[] } {
	if (!facts?.length) return { text: "", ids: [] };
	const addressOf = new Map(candidates.map((c) => [c.block.id, c.address]));
	const rows = matchFacts(facts.filter((r) => addressOf.has(r.blockId)), terms);
	if (!rows.length) return { text: "", ids: [] };
	const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ");
	const lines = rows.slice(0, MAX_FACTS).map((r) => `  ${r.about ? `${cut(r.about, FACT_ABOUT_CHARS)} · ` : ""}${cut(r.key, FACT_KEY_CHARS)}: ${cut(r.value, FACT_VALUE_CHARS)}${r.unit ? ` (${r.unit})` : ""}  #${addressOf.get(r.blockId)}`);
	const more = rows.length > MAX_FACTS ? `\n  (+${rows.length - MAX_FACTS} more; narrow the query)` : "";
	return { text: `Facts noted when the task was folded (values copied from the entry named):\n${lines.join("\n")}${more}`, ids: [...new Set(rows.slice(0, MAX_FACTS).map((r) => r.blockId))] };
}

const lowerIndexes = new WeakMap<Truth, { rev: number; text: Map<string, string> }>();

function querySection(truth: Truth, candidates: Candidate[], scope: Scope, query: string, page: number, budget: number, ledger?: readonly FactRow[]) {
	const item = (ids: string[]): RecallItem => ({ code: scope.itemCode, label: scope.label, mode: "query", ids });
	const where = scope.codes.length ? `#${scope.codes.join(", #")}` : "all folded content";
	const parsed = parseQuery(query);
	if ("error" in parsed) return { text: `[search ${where} for ${JSON.stringify(query)}] ${parsed.error}`, item: item([]), truncated: false };
	const { terms } = parsed;
	let index = lowerIndexes.get(truth);
	if (!index || index.rev !== truth.rev) {
		index = { rev: truth.rev, text: new Map() };
		lowerIndexes.set(truth, index);
	}
	const found = candidates.map((c) => {
		let lower = index.text.get(c.block.id);
		if (lower === undefined) {
			lower = c.block.text.toLowerCase();
			index.text.set(c.block.id, lower);
		}
		return { c, per: terms.map((t) => t.find(c.block.text, lower)) };
	});
	let hits = found.filter((f) => f.per.every((m) => m.length));
	let partial: string | null = null;
	if (!hits.length && terms.length > 1) {
		// No entry has every term: fall back to the rarest term that occurs at all.
		const counts = terms.map((_, i) => found.filter((f) => f.per[i].length).length);
		const rarest = counts.reduce((best, n, i) => (n > 0 && (best < 0 || n < counts[best]) ? i : best), -1);
		if (rarest >= 0) {
			partial = terms[rarest].label;
			hits = found.filter((f) => f.per[rarest].length).map((f) => ({ c: f.c, per: [f.per[rarest]] }));
		}
	}
	const codesArg = scope.codes.length ? `codes:[${scope.codes.map((c) => `"${c}"`).join(",")}], ` : "";
	const facts = factLines(candidates, terms, ledger);
	if (!hits.length) {
		// The ledger names things in other words than the transcript does, so it can match alone.
		if (facts.text) return { text: `[search ${where} for ${JSON.stringify(query)} · no entry has the text itself]\n${facts.text}\nRead an entry: recall({codes:["<address>"]})`, item: item(facts.ids), truncated: false };
		return { text: `[search ${where} for ${JSON.stringify(query)}] No match in ${candidates.length} entries. Try fewer or shorter terms.`, item: item([]), truncated: false };
	}
	const matches = hits.reduce((n, h) => n + h.per.reduce((k, m) => k + m.length, 0), 0);
	const lines = hits.map((h) => {
		const single = h.per.length === 1;
		const shown = single ? h.per[0].slice(0, MAX_EXCERPTS_PER_ENTRY) : h.per.map((m) => m[0]);
		const extra = single && h.per[0].length > MAX_EXCERPTS_PER_ENTRY ? ` (+${h.per[0].length - MAX_EXCERPTS_PER_ENTRY} more)` : "";
		const excerpts = mergeExcerpts(h.c.block.text, shown);
		return `  #${h.c.address}  ${h.c.task ? `${h.c.task} · ` : ""}${blockLabel(h.c.block)}${extra}\n${excerpts.map((s) => `    …${s}…`).join("\n")}`;
	});
	const head = [
		`[search ${where} for ${JSON.stringify(query)} · ${matches} matches in ${hits.length} entries${partial ? ` · PARTIAL: no entry has every term, showing ${JSON.stringify(partial)} only` : ""}]`,
		`Read a whole entry: recall({codes:["<address>"]}), e.g. "${hits[0].c.address}"`,
	].join("\n");
	const size = budget - head.length - 200 - query.length - codesArg.length - facts.text.length;
	const pages = splitLines(lines.map((l) => (l.length > size ? l.slice(0, size) : l)), size);
	const p = Math.min(page, pages.length);
	const shownIds = hits.filter((h) => pages[p - 1].includes(`#${h.c.address} `)).map((h) => h.c.block.id);
	const nav = pages.length > 1 ? `\n[result page ${p}/${pages.length}${p < pages.length ? `; next: recall({${codesArg}query:${JSON.stringify(query)}, page:${p + 1}})` : ""}]` : "";
	const lead = p === 1 && facts.text ? `${facts.text}\n` : "";
	return { text: `${head}\n${lead}${pages[p - 1]}${nav}`, item: item(p === 1 ? [...new Set([...facts.ids, ...shownIds])] : shownIds), truncated: pages.length > 1 };
}

/** Excerpts around the matches, one per stretch of text: overlapping windows are joined. */
function mergeExcerpts(text: string, matches: { at: number; len: number }[]): string[] {
	const spans = matches.map((m) => [Math.max(0, m.at - EXCERPT_RADIUS), Math.min(text.length, m.at + Math.min(m.len, EXCERPT_RADIUS) + EXCERPT_RADIUS)] as [number, number]).sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const s of spans) {
		const last = merged[merged.length - 1];
		if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
		else merged.push([s[0], s[1]]);
	}
	return merged.map(([from, to]) => text.slice(from, to).replace(/\s+/g, " ").trim());
}

/**
 * Every agent-reachable folded entry once, newest first, addressed through the smallest fold that
 * holds it, so a hit names its task and the address opens the entry directly.
 */
function archive(truth: Truth): Candidate[] {
	const codes = new Set<string>();
	for (const g of truth.groups) {
		if (!g.folded) continue;
		codes.add(foldCode(g.id));
		for (const h of g.handles ?? []) codes.add(foldCode(h.id));
	}
	for (const b of truth.blocks) if (truth.isFolded(b) && !truth.groupOf(b)) codes.add(foldCode(b.id));
	const best = new Map<string, { c: Candidate; size: number }>();
	for (const code of codes) {
		const src = sourceOf(truth, code);
		if (!src) continue;
		src.entries.forEach((block, i) => {
			if (block.toolName === RECALL_TOOL) return;
			const prev = best.get(block.id);
			if (!prev || src.entries.length < prev.size) best.set(block.id, { c: { address: `${code}.${i + 1}`, block, ...(src.taskKey ? { task: src.taskKey } : {}) }, size: src.entries.length });
		});
	}
	return [...best.values()].map((v) => v.c).sort((a, b) => b.block.order - a.block.order);
}

/** Every recallable folded task with its entries, newest first. */
export function foldedTasks(truth: Truth): { code: string; task: string; entries: Block[] }[] {
	return foldedTaskCodes(truth).flatMap((code) => {
		const src = sourceOf(truth, code);
		return src?.taskKey ? [{ code, task: src.taskKey, entries: src.entries }] : [];
	});
}

/** The codes of every recallable folded task, newest first. */
export function foldedTaskCodes(truth: Truth): string[] {
	const first = new Map<string, number>();
	for (const g of truth.groups) {
		if (!g.folded) continue;
		for (const h of g.handles ?? []) {
			if (!h.id.startsWith("t:") || !truth.canRecallHandle(g, h)) continue;
			const order = truth.get(h.memberIds[0])?.order ?? 0;
			const code = foldCode(h.id);
			first.set(code, Math.max(first.get(code) ?? 0, order));
		}
	}
	return [...first].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

/** Recallable handles strictly inside `memberIds`, keeping only the outermost ones. */
function childHandles(truth: Truth, code: string, memberIds: Set<string>, outermost = true): { id: string; memberIds: string[] }[] {
	const seen = new Map<string, string[]>();
	for (const g of truth.groups) {
		for (const h of g.handles ?? []) {
			if (seen.has(h.id) || foldCode(h.id) === code || h.memberIds.length >= memberIds.size) continue;
			if (!h.memberIds.every((id) => memberIds.has(id)) || !truth.canRecallHandle(g, h)) continue;
			seen.set(h.id, h.memberIds);
		}
	}
	const all = [...seen].map(([id, ids]) => ({ id, memberIds: ids, set: new Set(ids) }));
	const outer = outermost ? all.filter((c) => !all.some((o) => o !== c && o.set.size > c.set.size && c.memberIds.every((id) => o.set.has(id)))) : all;
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

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}
