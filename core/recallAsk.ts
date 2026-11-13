/*
 * recallAsk.ts — `recall({ask})`: a side model answers a question over a bounded selection of folded
 * content and cites the addresses it used (SPEC-0003 §7). Pure: material, prompt and citation check;
 * the host runs the completion.
 */
import type { Truth } from "./truth";
import { foldedTaskCodes, recallView, type RecallRequest } from "./recallView";

const CHARS_PER_TOKEN = 4;
/** Share of the material given to task reports; the rest goes to search hits. */
const REPORT_SHARE = 1 / 3;
const MAX_TERMS = 8;
const MAX_QUERY_CHARS = 200;
export const ASK_ANSWER_TOKENS = 800;

const STOPWORDS = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its may me my no not of on or our should so than that the their then there these they this to was we were what when where which who why will with would you your about after before any all each".split(" "));

export interface AskRequest {
	question: string;
	codes: string[];
	/** Search text chosen by the caller; derived from the question when absent. */
	query?: string;
	reportOf?: RecallRequest["reportOf"];
	facts?: RecallRequest["facts"];
	inputTokens: number;
}

export interface AskMaterial {
	/** Empty when nothing folded matches. */
	text: string;
	/** Search hits alone: what the caller gets when no answer can be produced. */
	hits: string;
	/** Every address the material shows; the only citations an answer may keep. */
	addresses: Set<string>;
	ids: string[];
}

/** The question's distinctive words as one alternation, longest first. */
export function questionQuery(question: string): string | undefined {
	const words = [...new Set((question.toLowerCase().match(/[a-z0-9_][a-z0-9_.:/-]{2,}/g) ?? []).map((w) => w.replace(/[.:/-]+$/, "")).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
	words.sort((a, b) => b.length - a.length);
	const picked: string[] = [];
	let chars = 4;
	for (const w of words) {
		const escaped = w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		if (picked.length >= MAX_TERMS || chars + escaped.length + 1 > MAX_QUERY_CHARS) break;
		picked.push(escaped);
		chars += escaped.length + 1;
	}
	return picked.length ? `/${picked.join("|")}/` : undefined;
}

/** Reports of the named (or all) folded tasks plus search hits, within `inputTokens`. Never a transcript. */
export function askMaterial(truth: Truth, req: AskRequest): AskMaterial {
	const total = Math.max(2_000, req.inputTokens) * CHARS_PER_TOKEN;
	const reportChars = Math.floor(total * REPORT_SHARE);
	const reportCodes = req.codes.length ? req.codes.filter((c) => !c.includes(".")) : foldedTaskCodes(truth);
	const reports = reportCodes.length ? recallView(truth, { codes: reportCodes, reportOf: req.reportOf, budgetChars: reportChars }) : null;
	const query = req.query?.trim() || questionQuery(req.question);
	const found = query ? recallView(truth, { codes: req.codes, query, facts: req.facts, budgetChars: total - reportChars }) : null;
	// A search without a match still renders a section; it is not material.
	const hits = found?.items.some((i) => i.ids.length) ? found.text : "";
	const parts = [reports?.items.length ? reports.text : "", hits].filter((t) => t.length > 0);
	const text = parts.join("\n\n");
	const addresses = new Set<string>();
	for (const m of text.matchAll(/#([0-9a-z]{6}(?:\.\d+)?)\b/g)) addresses.add(m[1]);
	return { text, hits, addresses, ids: [...new Set([...(reports?.items ?? []), ...(found?.items ?? [])].flatMap((i) => i.ids))] };
}

export const ASK_SYSTEM = [
	"You answer one question about the earlier work of a coding agent, using only the material given.",
	"The material holds task reports and excerpts of the session; every piece is labelled with an address like #3f9a2c or #3f9a2c.12.",
	"Rules:",
	"- State only what the material says. Copy numbers, paths, names and error texts exactly.",
	"- After each statement, cite the address it comes from in square brackets, e.g. [3f9a2c.12].",
	"- If the material does not answer the question, say what is missing in one sentence.",
	"- At most 250 words. No preamble, no advice.",
].join("\n");

export function askPrompt(question: string, material: string): string {
	return `<material>\n${material}\n</material>\n\nQuestion: ${question.trim()}`;
}

/** Remove citations of addresses the material never showed; the answer says how many were removed. */
export function checkCitations(answer: string, addresses: Set<string>): { text: string; cited: string[]; removed: number } {
	const cited = new Set<string>();
	let removed = 0;
	const text = answer
		.replace(/\[([^\][]*)\]/g, (whole, inner: string) => {
			const refs = inner.split(/[,;\s]+/).filter(Boolean).map((r) => r.replace(/^#/, ""));
			if (!refs.length || !refs.every((r) => /^[0-9a-z]{6}(?:\.\d+)?$/i.test(r))) return whole;
			const kept = refs.map((r) => r.toLowerCase()).filter((r) => addresses.has(r));
			removed += refs.length - kept.length;
			for (const r of kept) cited.add(r);
			return kept.length ? `[${kept.join(", ")}]` : "";
		})
		.replace(/[ \t]+([.,;])/g, "$1")
		.replace(/[ \t]+$/gm, "")
		.trim();
	return { text, cited: [...cited], removed };
}

/** The tool result of an answered question. */
export function askAnswer(question: string, answer: string, addresses: Set<string>): { text: string; cited: string[] } {
	const checked = checkCitations(answer, addresses);
	const notes: string[] = [];
	if (checked.removed) notes.push(`${checked.removed} citation(s) removed: they named addresses that were not in the material.`);
	if (!checked.cited.length) notes.push("This answer cites no source; verify it before relying on it.");
	else notes.push(`Read a cited entry with recall({codes:["${checked.cited[0]}"]}).`);
	return { text: `[answer from folded context, written by a side model — check cited entries for anything critical]\nQ: ${question.trim()}\n\n${checked.text}\n\n[${notes.join(" ")}]`, cited: checked.cited };
}

/** The tool result when no answer could be produced: the closest material instead, within `grantTokens`. */
export function askFallback(reason: string, material: AskMaterial, grantTokens: number): string {
	const head = `[no answer: ${reason}. Closest folded content instead:]\n`;
	const body = material.hits || material.text;
	if (!body) return `[no answer: ${reason}. Nothing folded matches the question's terms; try recall({query:"…"}) with other words.]`;
	const room = Math.max(0, grantTokens * CHARS_PER_TOKEN - head.length - 40);
	return head + (body.length > room ? `${body.slice(0, room)}\n[… cut to fit]` : body);
}
