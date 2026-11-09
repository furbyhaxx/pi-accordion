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

/** Characters one recall call may return across all its codes (~8k tokens). */
export const RECALL_BUDGET_CHARS = 32_000;
/** Below this remaining budget the next code is not rendered at all. */
const MIN_SECTION_CHARS = 2_000;
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
	budgetChars?: number;
}

export interface RecallItem {
	/** The address as requested: `code` or `code.N`. */
	code: string;
	label: string;
	mode: "full" | "entry" | "index" | "query";
	/** Ids whose content (or excerpts of it) this result actually returned. */
	ids: string[];
}

export interface RecallView {
	text: string;
	items: RecallItem[];
	missing: string[];
	/** True when budget or paging withheld content this call could have returned. */
	truncated: boolean;
}

interface Source {
	code: string;
	label: string;
	/** Members with text, in conversation order; entry `code.N` is `entries[N - 1]`. */
	entries: Block[];
}

const ADDRESS = /^([0-9a-z]{6})(?:\.([1-9]\d*))?$/i;

export function recallView(truth: Truth, req: RecallRequest): RecallView {
	const budget = Math.max(MIN_SECTION_CHARS, req.budgetChars ?? RECALL_BUDGET_CHARS);
	const query = req.query?.trim().slice(0, MAX_QUERY_CHARS) || undefined;
	const page = Math.max(1, Math.floor(req.page ?? 1));
	const sections: string[] = [];
	const items: RecallItem[] = [];
	const missing: string[] = [];
	const skipped: string[] = [];
	let truncated = false;
	let used = 0;
	for (const address of req.codes) {
		const m = ADDRESS.exec(address);
		const source = m ? sourceOf(truth, m[1].toLowerCase()) : null;
		if (!m || !source) {
			missing.push(address);
			continue;
		}
		if (budget - used < MIN_SECTION_CHARS) {
			skipped.push(address);
			continue;
		}
		const entryNo = m[2] ? Number(m[2]) : undefined;
		// Every section is paged against the full budget so page N means the same in any call.
		const section = render(truth, source, address, entryNo, query, page, budget);
		if (!section) {
			missing.push(address);
			continue;
		}
		if (used + section.text.length > budget) {
			skipped.push(address);
			continue;
		}
		sections.push(section.text);
		items.push(section.item);
		truncated ||= section.truncated;
		used += section.text.length;
	}
	if (skipped.length) {
		truncated = true;
		sections.push(`[budget reached] Not shown: ${skipped.map((c) => "#" + c).join(", ")}. Recall them in a separate call.`);
	}
	if (missing.length) sections.push(`No folded content for: ${missing.map((c) => "#" + c).join(", ")} (already full, not in this session's context, or no such entry).`);
	return { text: sections.join("\n\n") || "Nothing to recall.", items, missing, truncated };
}

function sourceOf(truth: Truth, code: string): Source | null {
	const res = resolveRecall(truth, [code]);
	if (!res.restored.length) return null;
	// One code can match several carriers of the same task; each member is listed once.
	const ids = [...new Set(res.restored.flatMap((r) => r.ids))];
	const entries = ids
		.map((id) => truth.get(id))
		.filter((b): b is Block => !!b && b.text.length > 0)
		.sort((a, b) => a.order - b.order);
	return { code, label: res.restored[0].label, entries };
}

function render(truth: Truth, src: Source, address: string, entryNo: number | undefined, query: string | undefined, page: number, budget: number): { text: string; item: RecallItem; truncated: boolean } | null {
	if (entryNo !== undefined) {
		const entry = src.entries[entryNo - 1];
		if (!entry) return null;
		const label = `${blockLabel(entry)} · entry ${entryNo} of #${src.code}`;
		if (query) return querySection(src, [[entryNo, entry]], address, label, query, page, budget);
		return entrySection(entry, address, label, page, budget);
	}
	const numbered = src.entries.map((b, i) => [i + 1, b] as [number, Block]);
	if (query) return querySection(src, numbered, address, src.label, query, page, budget);
	const full = src.entries.map((b) => b.text).join("\n\n");
	const head = `[recalled ${src.label} (#${address})]\n`;
	if (head.length + full.length <= budget) {
		return { text: head + full, item: { code: address, label: src.label, mode: "full", ids: src.entries.map((b) => b.id) }, truncated: false };
	}
	return indexSection(truth, src, address, page, budget);
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
