/** Content anchors for attachments (SPEC-0002 §4.2): name a part of a file by what it is, never by line number. */

/** A W3C TextQuoteSelector with a TextPositionSelector hint. */
export interface QuoteAnchor {
	exact: string;
	prefix: string;
	suffix: string;
	/** Character offset when the quote was taken; a hint only, never compared for equality. */
	start: number;
}

export type Anchor = { section: string } | { symbol: string } | { quote: QuoteAnchor };

/** How an anchor resolved. `moved` and `fuzzy` describe a quote; sections and symbols are structural. */
export type AnchorState = "moved" | "fuzzy";

export type Resolution = { content: string; state?: AnchorState } | { lost: true; candidates?: string[] };

const CONTEXT = 32;
const FUZZY_MIN = 0.8;
/** The window scan is quadratic in file size; larger files only match on prefix and suffix. */
const SCAN_LIMIT = 400_000;

export function makeQuote(text: string, start: number, end: number): QuoteAnchor {
	return { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), start };
}

/** Canonical text form: `path#Heading > Sub`, `path::Symbol.method`, `path@q:<id>`, or the bare path. */
export function refOf(path: string, anchor: Anchor | undefined, quoteId?: string): string {
	if (!anchor) return path;
	if ("section" in anchor) return `${path}#${anchor.section}`;
	if ("symbol" in anchor) return `${path}::${anchor.symbol}`;
	return `${path}@q:${quoteId ?? "?"}`;
}

interface Heading {
	level: number;
	title: string;
	/** Offset of the heading line start. */
	start: number;
}

const FENCE = /^ {0,3}(```|~~~)/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

function headings(text: string): Heading[] {
	const out: Heading[] = [];
	const lines = text.split("\n");
	let offset = 0;
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const f = FENCE.exec(line);
		if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
		else if (fence === null) {
			const atx = ATX.exec(line);
			if (atx) out.push({ level: atx[1].length, title: atx[2].trim(), start: offset });
			else if (i + 1 < lines.length && line.trim() && !/^\s/.test(line)) {
				const next = lines[i + 1];
				if (/^=+\s*$/.test(next)) out.push({ level: 1, title: line.trim(), start: offset });
				else if (/^-+\s*$/.test(next) && next.trim().length >= 2) out.push({ level: 2, title: line.trim(), start: offset });
			}
		}
		offset += line.length + 1;
	}
	return out;
}

/** Heading text with its ancestors, `A > B > C`, for every heading. */
function headingPaths(hs: readonly Heading[]): string[][] {
	const stack: Heading[] = [];
	return hs.map((h) => {
		while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
		stack.push(h);
		return stack.map((s) => s.title);
	});
}

/** The section named by a `>`-separated heading path, matched as a suffix of the full path. */
export function resolveSection(text: string, section: string): Resolution {
	const want = section.split(">").map((s) => s.trim()).filter(Boolean);
	if (!want.length) return { lost: true };
	const hs = headings(text);
	const paths = headingPaths(hs);
	const hits: number[] = [];
	for (let i = 0; i < hs.length; i++) {
		const p = paths[i];
		if (p.length >= want.length && want.every((w, k) => p[p.length - want.length + k] === w)) hits.push(i);
	}
	if (!hits.length) {
		const last = want[want.length - 1].toLowerCase();
		const candidates = hs.map((h, i) => ({ h, i })).filter(({ h }) => h.title.toLowerCase().includes(last) || last.includes(h.title.toLowerCase())).map(({ i }) => paths[i].join(" > "));
		return { lost: true, ...(candidates.length ? { candidates: candidates.slice(0, 5) } : {}) };
	}
	if (hits.length > 1) return { lost: true, candidates: hits.map((i) => paths[i].join(" > ")).slice(0, 5) };
	const i = hits[0];
	let end = text.length;
	for (let j = i + 1; j < hs.length; j++) {
		if (hs[j].level <= hs[i].level) {
			end = hs[j].start;
			break;
		}
	}
	return { content: text.slice(hs[i].start, end).replace(/\s+$/, "") };
}

function bigrams(s: string): Map<string, number> {
	const m = new Map<string, number>();
	for (let i = 0; i + 1 < s.length; i++) {
		const g = s.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return m;
}

/** Dice coefficient over character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const ga = bigrams(a);
	let shared = 0;
	const gb = bigrams(b);
	for (const [g, n] of gb) shared += Math.min(n, ga.get(g) ?? 0);
	return (2 * shared) / (a.length + b.length - 2);
}

function occurrences(text: string, needle: string): number[] {
	const out: number[] = [];
	if (!needle) return out;
	for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
	return out;
}

/** Locate a quote: exact where it was, exact elsewhere (`moved`), the closest similar text (`fuzzy`), or lost. */
export function resolveQuote(text: string, q: QuoteAnchor): Resolution {
	if (!q.exact) return { lost: true };
	if (text.startsWith(q.exact, q.start)) return { content: q.exact };
	if (occurrences(text, q.exact).length) return { content: q.exact, state: "moved" };
	return fuzzy(text, q);
}

function fuzzy(text: string, q: QuoteAnchor): Resolution {
	const room = q.exact.length * 2 + 64;
	const consider = (candidate: string): Resolution | null => (candidate && similarity(q.exact, candidate) >= FUZZY_MIN ? { content: candidate, state: "fuzzy" } : null);
	const afterPrefix = q.prefix ? occurrences(text, q.prefix) : [];
	const beforeSuffix = q.suffix ? occurrences(text, q.suffix) : [];
	for (const p of afterPrefix) {
		const from = p + q.prefix.length;
		const s = beforeSuffix.find((x) => x >= from && x - from <= room);
		const hit = consider(s !== undefined ? text.slice(from, s) : text.slice(from, from + q.exact.length));
		if (hit) return hit;
	}
	for (const s of beforeSuffix) {
		const hit = consider(text.slice(Math.max(0, s - q.exact.length), s));
		if (hit) return hit;
	}
	if (text.length > SCAN_LIMIT) return { lost: true };
	const lines = text.split("\n");
	const span = Math.max(1, q.exact.split("\n").length);
	let best: { score: number; content: string } | null = null;
	for (let i = 0; i + span <= lines.length; i++) {
		const content = lines.slice(i, i + span).join("\n");
		const score = similarity(q.exact, content);
		if (score >= FUZZY_MIN && (!best || score > best.score)) best = { score, content };
	}
	return best ? { content: best.content, state: "fuzzy" } : { lost: true };
}

/** Resolve a section or quote anchor against a file's text; symbols need the parser (`taskSymbols.ts`). */
export function resolveAnchor(text: string, anchor: Exclude<Anchor, { symbol: string }>): Resolution {
	return "section" in anchor ? resolveSection(text, anchor.section) : resolveQuote(text, anchor.quote);
}
