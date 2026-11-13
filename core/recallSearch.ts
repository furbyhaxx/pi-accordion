/*
 * recallSearch.ts — the query language of `recall` (SPEC-0003): terms, phrases and one regex.
 *
 * Pure text matching; which entries are searched and how hits are rendered is `recallView.ts`.
 */

export interface Term {
	/** The term as the agent wrote it, for headers and excerpts. */
	label: string;
	/** Every match start and length in `text`, in order; empty when the term does not occur. */
	find(text: string, lower: string): { at: number; len: number }[];
}

export type ParsedQuery = { terms: Term[] } | { error: string };

const MAX_REGEX_CHARS = 120;
const MAX_TERMS = 8;
/** Matches kept per term and entry; counting stops there. */
const MAX_MATCHES = 50;
/** A quantified group that itself contains a quantifier backtracks exponentially on a near miss. */
const NESTED_QUANTIFIER = /\([^()]*[+*}][^()]*\)\s*[+*{]/;

function literal(word: string): Term {
	const needle = word.toLowerCase();
	return {
		label: word,
		find(_text, lower) {
			const out: { at: number; len: number }[] = [];
			for (let i = lower.indexOf(needle); i >= 0 && out.length < MAX_MATCHES; i = lower.indexOf(needle, i + needle.length)) out.push({ at: i, len: needle.length });
			return out;
		},
	};
}

function regex(source: string, flags: string): Term | string {
	if (source.length > MAX_REGEX_CHARS) return `The pattern is longer than ${MAX_REGEX_CHARS} characters.`;
	if (NESTED_QUANTIFIER.test(source)) return "The pattern repeats a group that itself contains a repetition; write it without the nested repetition.";
	let re: RegExp;
	try {
		re = new RegExp(source, `g${flags.includes("i") ? "i" : ""}${flags.includes("s") ? "s" : ""}m`);
	} catch (e) {
		return `Invalid pattern: ${e instanceof Error ? e.message : String(e)}`;
	}
	return {
		label: `/${source}/${flags}`,
		find(text) {
			const out: { at: number; len: number }[] = [];
			re.lastIndex = 0;
			for (let m = re.exec(text); m && out.length < MAX_MATCHES; m = re.exec(text)) {
				out.push({ at: m.index, len: m[0].length });
				if (!m[0].length) re.lastIndex++;
			}
			return out;
		},
	};
}

/**
 * `/re/` or `/re/i` as the whole query is one regular expression. Otherwise the query is
 * whitespace-separated terms that must all occur in one entry, case-insensitive; `"a phrase"` keeps
 * its spaces.
 */
export function parseQuery(query: string): ParsedQuery {
	const q = query.trim();
	const re = /^\/(.+)\/([a-z]*)$/s.exec(q);
	if (re) {
		const term = regex(re[1], re[2]);
		return typeof term === "string" ? { error: term } : { terms: [term] };
	}
	const words = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((w) => w.length > 0);
	const unique = [...new Map(words.map((w) => [w.toLowerCase(), w])).values()].slice(0, MAX_TERMS);
	return unique.length ? { terms: unique.map(literal) } : { error: "The query is empty." };
}
