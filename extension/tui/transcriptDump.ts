/*
 * transcriptDump.ts — the session's outgoing projection as a readable document.
 *
 * The projection is what `Truth.serializeWire` hands the model on the next `context` hook: every
 * block in order, except that a folded block rides as its digest and a folded group replaces its
 * whole run of messages with one summary. Taskfold's folded spans are groups whose summary is a
 * `[task-record]` line, so the document reads as the session's tasks with the folded ones standing
 * for their whole span.
 *
 * Five renderings of the same model — `tree` (default, for reading), `yaml`, `xml`, `md` (for
 * sharing) and `flat` (the literal wire order, no task structure). Body text is never truncated:
 * the point is inspecting what the agent actually holds.
 *
 * Pure over a `TranscriptSource` (the adapter the task views already use, calibrated tokens and
 * all), so the dump and the views can never disagree about what is folded.
 */
import type { TaskSpan } from "../../conductors/in-process/taskfold/taskfold";
import { scanTaskSpans } from "../../conductors/in-process/taskfold/taskfold";
import { messageKey } from "../../core/groupShape";
import type { TBlock, TGroup, Tokens, TranscriptSource } from "./taskTranscript";

export type DumpFormat = "tree" | "yaml" | "xml" | "md" | "flat";

/** Every format, in the order `--formats all` writes them. */
export const DUMP_FORMATS: readonly DumpFormat[] = ["tree", "yaml", "xml", "md", "flat"];

/** The file extension each format defaults to. */
export const FORMAT_EXTENSION: Readonly<Record<DumpFormat, string>> = {
	tree: ".txt",
	yaml: ".yaml",
	xml: ".xml",
	md: ".md",
	flat: ".log",
};

const EXTENSION_FORMAT: Readonly<Record<string, DumpFormat>> = {
	".txt": "tree",
	".yaml": "yaml",
	".yml": "yaml",
	".xml": "xml",
	".md": "md",
	".markdown": "md",
	".log": "flat",
};

/** A file's format from its extension, or null when the extension names none. */
export function formatOfPath(file: string): DumpFormat | null {
	const dot = file.lastIndexOf(".");
	if (dot <= file.lastIndexOf("/")) return null;
	return EXTENSION_FORMAT[file.slice(dot).toLowerCase()] ?? null;
}

/** `file` with its extension replaced by `format`'s. */
export function withExtension(file: string, format: DumpFormat): string {
	const dot = file.lastIndexOf(".");
	const slash = file.lastIndexOf("/");
	return (dot > slash ? file.slice(0, dot) : file) + FORMAT_EXTENSION[format];
}

/** `2025-11-06T09-56-12+0100`: ISO-ordered local time, colon-free for filesystems. */
export function dumpStamp(at: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const off = -at.getTimezoneOffset();
	const abs = Math.abs(off);
	return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}${off < 0 ? "-" : "+"}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/** `ses-<id>-taskfold-2025-11-06T09-56-12+0100.xml`. */
export function dumpFileName(sessionId: string, format: DumpFormat, at: Date): string {
	return `ses-${sessionId}-taskfold-${dumpStamp(at)}${FORMAT_EXTENSION[format]}`;
}

/** A `--format`/`--formats` value: a comma-separated list, or `all`. */
export function parseFormatSpec(spec: string): { formats: DumpFormat[] } | { error: string } {
	const names = spec.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
	if (!names.length) return { error: "Name at least one format." };
	if (names.includes("all")) {
		return names.length === 1 ? { formats: [...DUMP_FORMATS] } : { error: "`all` cannot be combined with other formats." };
	}
	const formats: DumpFormat[] = [];
	for (const name of names) {
		if (!(DUMP_FORMATS as readonly string[]).includes(name)) return { error: `Unknown format "${name}". Use ${DUMP_FORMATS.join(", ")} or all.` };
		if (!formats.includes(name as DumpFormat)) formats.push(name as DumpFormat);
	}
	return { formats };
}

/** One block on the wire: its own text, or the digest it rides as when folded alone. */
export interface DumpBlock {
	kind: "block";
	block: TBlock;
	/** The result paired with this `tool_call`, when both are in the same place on the wire. */
	result: TBlock | null;
	folded: boolean;
	code: string | null;
	/** The exact text the model receives for this node. */
	wire: string;
	tokens: Tokens;
}

/** One task span: a record when folded, its members when not. */
export interface DumpTask {
	kind: "task";
	span: TaskSpan;
	folded: boolean;
	code: string | null;
	/** The group summary — the whole span's wire text — when folded, else "". */
	wire: string;
	/** Whole messages the fold took off the wire (0 when unfolded). */
	elidedMessages: number;
	tokens: Tokens;
	children: DumpNode[];
}

export type DumpNode = DumpTask | DumpBlock;

export interface DumpDoc {
	meta: { sessionId: string; model: string };
	/** The harness prompt: always first on the wire, never foldable. */
	system: { tokens: number } | null;
	totals: { full: number; live: number; budget: number };
	generatedAt: string;
	/** Everything before the first task started. */
	orientation: DumpNode[];
	/** From the first task to the last: the tasks in order, with the work between them left in. */
	body: DumpNode[];
	/** Everything after the last task ended: the working tail. */
	tail: DumpNode[];
}

export interface DumpInput {
	source: TranscriptSource;
	meta: { sessionId: string; model: string };
	system: { tokens: number } | null;
	totals: { full: number; live: number; budget: number };
	generatedAt: Date;
}

const codeOf = (text: string): string | null => /^\{#([0-9a-z]{6}) FOLDED\}/.exec(text)?.[1] ?? null;

/** A folded span's group and the block positions it takes off the wire. */
interface Fold {
	group: TGroup;
	members: number[];
}
const sumLive = (nodes: readonly DumpNode[]): number => nodes.reduce((n, x) => n + x.tokens.live, 0);

interface ForestEntry {
	span: TaskSpan;
	children: ForestEntry[];
}

/** Spans nested by containment; siblings in transcript order. */
function forest(spans: readonly TaskSpan[]): ForestEntry[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
	const roots: ForestEntry[] = [];
	const stack: ForestEntry[] = [];
	for (const span of sorted) {
		while (stack.length && !(stack[stack.length - 1].span.start <= span.start && span.end <= stack[stack.length - 1].span.end)) stack.pop();
		const entry: ForestEntry = { span, children: [] };
		(stack.length ? stack[stack.length - 1].children : roots).push(entry);
		stack.push(entry);
	}
	return roots;
}

interface Index {
	source: TranscriptSource;
	groupOf: Map<string, TGroup>;
	resultOf: Map<string, number>;
	/** Block id → its position in the wire order. */
	at: Map<string, number>;
	/** Blocks a folded span takes off the wire, so no region prints them again. */
	covered: Set<number>;
}

function blocksOf(src: TranscriptSource, span: TaskSpan): readonly TBlock[] {
	return src.blocks.slice(span.start, span.end + 1);
}

/** The folded group covering the whole span, or null when the span rides raw. */
function spanGroup(ix: Index, span: TaskSpan): TGroup | null {
	const first = ix.groupOf.get(ix.source.blocks[span.start].id);
	if (!first?.folded) return null;
	return blocksOf(ix.source, span).every((b) => ix.groupOf.get(b.id)?.id === first.id) ? first : null;
}

/** Positions of a group's members: the span's own blocks, plus any earlier in its boundary message. */
function memberIndices(ix: Index, group: TGroup): number[] {
	const out: number[] = [];
	for (const id of group.memberIds) {
		const at = ix.at.get(id);
		if (at !== undefined) out.push(at);
	}
	return out;
}

function blockNode(ix: Index, block: TBlock, limit: number): DumpBlock {
	const folded = !!block.folded;
	const wire = folded ? (block.digest ?? block.text) : block.text;
	const ri = block.kind === "tool_call" && block.callId ? ix.resultOf.get(block.callId) : undefined;
	const result = ri !== undefined && ri <= limit ? ix.source.blocks[ri] : null;
	return {
		kind: "block",
		block,
		result,
		folded,
		code: folded ? codeOf(wire) : null,
		wire,
		tokens: { full: block.full + (result?.full ?? 0), live: block.live + (result?.live ?? 0) },
	};
}

function taskNode(ix: Index, entry: ForestEntry, folds: ReadonlyMap<TaskSpan, Fold | null>): DumpTask {
	const { span } = entry;
	const fold = folds.get(span) ?? null;
	const full = blocksOf(ix.source, span).reduce((n, b) => n + b.full, 0);
	if (fold) {
		const wire = fold.group.summary ?? "";
		// The group is what leaves the wire, so it — not the span's block range — decides both
		// numbers: Taskfold snaps a span outward to whole messages, so a member can sit just before
		// the `tasks start` call that opens the span.
		const messages = new Set(fold.group.memberIds.map((id) => messageKey(id))).size;
		const wireFull = fold.members.reduce((n, at) => n + ix.source.blocks[at].full, 0);
		return { kind: "task", span, folded: true, code: codeOf(wire), wire, elidedMessages: messages, tokens: { full: wireFull || full, live: fold.group.live }, children: [] };
	}
	const children: DumpNode[] = [];
	const consumed = new Set<number>();
	let k = 0;
	for (let i = span.start; i <= span.end; i++) {
		const child = entry.children[k];
		if (child && i === child.span.start) {
			children.push(taskNode(ix, child, folds));
			i = child.span.end;
			k++;
			continue;
		}
		if (consumed.has(i) || ix.covered.has(i)) continue;
		const block = ix.source.blocks[i];
		if (ix.groupOf.get(block.id)?.folded) continue;
		const node = blockNode(ix, block, span.end);
		if (node.result) consumed.add(ix.at.get(node.result.id) ?? -1);
		children.push(node);
	}
	return { kind: "task", span, folded: false, code: null, wire: "", elidedMessages: 0, tokens: { full, live: sumLive(children) }, children };
}

/**
 * Blocks `lo..hi` in wire order, with the top-level spans among them expanded into task nodes.
 * `consumed` is shared across the three regions, so every block lands exactly once: in a region,
 * inside a task, or elided into a record — never twice and never silently missing.
 */
function walkRegion(ix: Index, roots: readonly ForestEntry[], folds: ReadonlyMap<TaskSpan, Fold | null>, lo: number, hi: number, consumed: Set<number>): DumpNode[] {
	const out: DumpNode[] = [];
	const byStart = new Map<number, ForestEntry>();
	for (const root of roots) byStart.set(root.span.start, root);
	for (let i = lo; i <= hi; i++) {
		const root = byStart.get(i);
		if (root) {
			out.push(taskNode(ix, root, folds));
			i = root.span.end;
			continue;
		}
		if (consumed.has(i) || ix.covered.has(i)) continue;
		const block = ix.source.blocks[i];
		if (block.kind === "system" || ix.groupOf.get(block.id)?.folded) continue;
		const node = blockNode(ix, block, hi);
		if (node.result) consumed.add(ix.at.get(node.result.id) ?? -1);
		out.push(node);
	}
	return out;
}

/** Build the document: the session's spans as a task tree, with the regions around them. */
export function dumpDocument(input: DumpInput): DumpDoc {
	const { source } = input;
	const groupOf = new Map<string, TGroup>();
	for (const g of source.groups) for (const id of g.memberIds) groupOf.set(id, g);
	const resultOf = new Map<string, number>();
	const at = new Map<string, number>();
	source.blocks.forEach((b, i) => {
		at.set(b.id, i);
		if (b.kind === "tool_result" && b.callId) resultOf.set(b.callId, i);
	});
	const ix: Index = { source, groupOf, resultOf, at, covered: new Set() };
	const spans = scanTaskSpans(source.blocks, (b) => b.text);
	// Fold first: a covered member must be known before ANY region walks past it.
	const folds = new Map<TaskSpan, Fold | null>();
	for (const span of spans) {
		const group = spanGroup(ix, span);
		const fold = group ? { group, members: memberIndices(ix, group) } : null;
		folds.set(span, fold);
		if (fold) for (const member of fold.members) ix.covered.add(member);
	}
	const roots = forest(spans);
	const first = spans.length ? Math.min(...spans.map((s) => s.start)) : source.blocks.length;
	const last = spans.length ? Math.max(...spans.map((s) => s.end)) : -1;
	const consumed = new Set<number>();
	const walk = (lo: number, hi: number) => (lo <= hi ? walkRegion(ix, roots, folds, lo, hi, consumed) : []);
	return {
		meta: input.meta,
		system: input.system,
		totals: input.totals,
		generatedAt: dumpStamp(input.generatedAt),
		orientation: walk(0, Math.min(first, source.blocks.length) - 1),
		body: walk(first, last),
		tail: walk(last + 1, source.blocks.length - 1),
	};
}

/* ── shared helpers ─────────────────────────────────────────────────────────── */

const lines = (text: string) => text.split("\n");
const label = (n: DumpBlock) => (n.block.toolName ? `${n.block.kind} ${n.block.toolName}` : n.block.kind);
/** A human-authored digest carries no `{#code FOLDED}` tag, so it has no handle to report. */
const foldMark = (n: DumpNode): string => (n.code ? `FOLDED {#${n.code}}` : "FOLDED (no code)");
/** `text` as a literal block: every line prefixed, blank lines kept empty. */
function graft(out: string[], text: string, prefix: string): void {
	for (const line of lines(text)) out.push(line.length ? `${prefix}${line}` : "");
}

/* ── tree (the default) ────────────────────────────────────────────────────── */

export function renderTree(doc: DumpDoc): string {
	const out: string[] = [];
	out.push(`transcript · ${doc.meta.sessionId} · ${doc.meta.model}`);
	out.push(`live ${doc.totals.live} · full ${doc.totals.full} · budget ${doc.totals.budget} tok · generated ${doc.generatedAt}`);
	out.push("");
	const node = (n: DumpNode, pre: string, last: boolean): void => {
		const arm = `${pre}${last ? "└─ " : "├─ "}`;
		const pad = `${pre}${last ? "   " : "│  "}`;
		if (n.kind === "task") {
			const state = n.folded ? `FOLDED  ${n.tokens.full} → ${n.tokens.live} tok` : `open  ${n.tokens.live} tok`;
			out.push(`${arm}▣ ${n.span.key} "${n.span.title}"  ${n.span.status ?? "open"}  ·  ${state}`);
			if (n.folded) {
				graft(out, n.wire, `${pad}┆ `);
				out.push(`${pad}└─ ${n.elidedMessages} messages elided (not on the wire)`);
			} else n.children.forEach((c, i) => node(c, pad, i === n.children.length - 1));
			return;
		}
		const marks = [n.folded ? foldMark(n) : "", n.block.protected ? "protected" : ""].filter(Boolean).join(" · ");
		out.push(`${arm}${n.block.kind === "user" ? "●" : "·"} ${label(n)}  ·  ${n.tokens.live} tok${marks ? `  ·  ${marks}` : ""}`);
		graft(out, n.wire, `${pad}┆ `);
		if (n.result) graft(out, n.result.text, `${pad}┆ → `);
	};
	const section = (title: string, nodes: readonly DumpNode[], pre: string, last: boolean): void => {
		out.push(`${pre}${last ? "└─ " : "├─ "}${title}`);
		const pad = `${pre}${last ? "   " : "│  "}`;
		nodes.forEach((n, i) => node(n, pad, i === nodes.length - 1));
	};
	const items: ((pre: string, last: boolean) => void)[] = [
		(pre, last) => section(`system  ·  ${doc.system?.tokens ?? 0} tok  (bolted)`, [], pre, last),
		(pre, last) => section(`orientation  ·  ${sumLive(doc.orientation)} tok`, doc.orientation, pre, last),
		...doc.body.map((child) => (pre: string, last: boolean) => node(child, pre, last)),
		(pre, last) => section(`tail  ·  ${sumLive(doc.tail)} tok  (protected)`, doc.tail, pre, last),
	];
	items.forEach((item, i) => item("", i === items.length - 1));
	return out.join("\n");
}

/* ── flat: the wire in message order ───────────────────────────────────────── */

export function renderFlat(doc: DumpDoc): string {
	const out: string[] = [];
	out.push(`wire · ${doc.meta.sessionId} · ${doc.meta.model} · live ${doc.totals.live} / ${doc.totals.budget} tok · generated ${doc.generatedAt}`);
	out.push("");
	out.push(`${"system".padEnd(26)}${String(doc.system?.tokens ?? 0).padStart(7)} tok  bolted, always first`);
	const row = (name: string, tokens: number, text: string, note: string): void => {
		out.push(`${name.padEnd(26)}${String(tokens).padStart(7)} tok${note ? `  ${note}` : ""}`);
		graft(out, text, "    ");
	};
	const marksOf = (n: DumpBlock) => [n.folded ? foldMark(n) : "", n.block.protected ? "protected" : ""].filter(Boolean).join("  ");
	const region = (nodes: readonly DumpNode[]): void => {
		for (const n of nodes) {
			if (n.kind === "task") {
				if (n.folded) row("GROUP (task record)", n.tokens.live, n.wire, `${n.elidedMessages} messages elided`);
				else region(n.children);
				continue;
			}
			const turn = `${n.block.turn ?? 0}:`;
			row(`${turn}${label(n)}`, n.block.live, n.wire, marksOf(n));
			if (n.result) row(`${turn}tool_result${n.result.toolName ? ` ${n.result.toolName}` : ""}`, n.result.live, n.result.text, "");
		}
	};
	region(doc.orientation);
	region(doc.body);
	region(doc.tail);
	return out.join("\n");
}

/* ── yaml ──────────────────────────────────────────────────────────────────── */

export function renderYaml(doc: DumpDoc): string {
	const out: string[] = [];
	const block = (key: string, text: string, ind: number): void => {
		if (!text.length) {
			out.push(`${" ".repeat(ind)}${key}: ""`);
			return;
		}
		out.push(`${" ".repeat(ind)}${key}: |`);
		for (const line of lines(text)) out.push(line.length ? `${" ".repeat(ind + 2)}${line}` : "");
	};
	const quote = (s: string) => JSON.stringify(s);
	const node = (n: DumpNode, ind: number): void => {
		const pad = " ".repeat(ind);
		if (n.kind === "task") {
			const sp = n.span;
			const children = n.folded ? [] : n.children;
			out.push(`${pad}- task: ${quote(sp.key)}`);
			out.push(`${pad}  title: ${quote(sp.title)}`);
			out.push(`${pad}  status: ${sp.status ?? "open"}`);
			out.push(`${pad}  folded: ${n.folded}`);
			if (n.folded && n.code) out.push(`${pad}  code: ${n.code}`);
			out.push(`${pad}  tokens: { live: ${n.tokens.live}, full: ${n.tokens.full} }`);
			if (n.folded) {
				block("wire", n.wire, ind + 2);
				out.push(`${pad}  elided_messages: ${n.elidedMessages}`);
			} else if (children.length) {
				out.push(`${pad}  content:`);
				for (const c of children) node(c, ind + 4);
			}
			return;
		}
		const b = n.block;
		out.push(`${pad}- block: ${label(n)}`);
		out.push(`${pad}  id: ${quote(b.id)}`);
		out.push(`${pad}  turn: ${b.turn ?? 0}`);
		out.push(`${pad}  tokens: ${n.tokens.live}`);
		if (n.folded && n.code) out.push(`${pad}  code: ${n.code}`);
		if (b.protected) out.push(`${pad}  protected: true`);
		block("wire", n.wire, ind + 2);
		if (n.result) block("result", n.result.text, ind + 2);
	};
	out.push("transcript:");
	out.push(`  session: ${quote(doc.meta.sessionId)}`);
	out.push(`  model: ${quote(doc.meta.model)}`);
	out.push(`  generated_at: ${quote(doc.generatedAt)}`);
	out.push(`  tokens: { live: ${doc.totals.live}, full: ${doc.totals.full}, budget: ${doc.totals.budget} }`);
	out.push(`  system: { tokens: ${doc.system?.tokens ?? 0} }`);
	out.push("  orientation:");
	for (const n of doc.orientation) node(n, 4);
	if (!doc.orientation.length) out.push("    []");
	out.push("  body:");
	for (const n of doc.body) node(n, 4);
	if (!doc.body.length) out.push("    []");
	out.push("  tail:");
	for (const n of doc.tail) node(n, 4);
	if (!doc.tail.length) out.push("    []");
	return out.join("\n");
}

/* ── xml ───────────────────────────────────────────────────────────────────── */

/** CDATA keeps the text verbatim; `]]>` inside it is split across two sections. */
const cdata = (text: string) => `<![CDATA[${text.split("]]>").join("]]]]><![CDATA[>")}]]>`;
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderXml(doc: DumpDoc): string {
	const out: string[] = [];
	const ind = (n: number) => "  ".repeat(n);
	const node = (n: DumpNode, d: number): void => {
		if (n.kind === "task") {
			const sp = n.span;
			const attrs = [`key="${attr(sp.key)}"`, `title="${attr(sp.title)}"`, `status="${sp.status ?? "open"}"`, `tokens="${n.tokens.live}"`, `full="${n.tokens.full}"`];
			if (n.folded) {
				attrs.push(`folded="true"`);
				if (n.code) attrs.push(`code="${n.code}"`);
			}
			if (n.folded) {
				out.push(`${ind(d)}<task ${attrs.join(" ")}>`);
				out.push(`${ind(d + 1)}<summary>${cdata(n.wire)}</summary>`);
				out.push(`${ind(d + 1)}<elided messages="${n.elidedMessages}"/>`);
				out.push(`${ind(d)}</task>`);
				return;
			}
			if (!n.children.length) {
				out.push(`${ind(d)}<task ${attrs.join(" ")}/>`);
				return;
			}
			out.push(`${ind(d)}<task ${attrs.join(" ")}>`);
			for (const c of n.children) node(c, d + 1);
			out.push(`${ind(d)}</task>`);
			return;
		}
		const b = n.block;
		const attrs = [`kind="${b.kind}"`, `id="${attr(b.id)}"`, `turn="${b.turn ?? 0}"`, `tokens="${n.tokens.live}"`];
		if (n.block.toolName) attrs.push(`tool="${attr(n.block.toolName)}"`);
		if (n.folded) {
			attrs.push(`folded="true"`);
			if (n.code) attrs.push(`code="${n.code}"`);
		}
		if (b.protected) attrs.push(`protected="true"`);
		out.push(`${ind(d)}<block ${attrs.join(" ")}>${cdata(n.wire)}</block>`);
		if (n.result) out.push(`${ind(d)}<block kind="tool_result" id="${attr(n.result.id)}" paired="${attr(b.callId ?? "")}">${cdata(n.result.text)}</block>`);
	};
	out.push(`<?xml version="1.0" encoding="utf-8"?>`);
	out.push(`<transcript session="${attr(doc.meta.sessionId)}" model="${attr(doc.meta.model)}" generated="${attr(doc.generatedAt)}" live="${doc.totals.live}" full="${doc.totals.full}" budget="${doc.totals.budget}">`);
	out.push(`${ind(1)}<system tokens="${doc.system?.tokens ?? 0}"/>`);
	out.push(`${ind(1)}<orientation tokens="${sumLive(doc.orientation)}">`);
	for (const n of doc.orientation) node(n, 2);
	out.push(`${ind(1)}</orientation>`);
	for (const n of doc.body) node(n, 1);
	out.push(`${ind(1)}<tail tokens="${sumLive(doc.tail)}">`);
	for (const n of doc.tail) node(n, 2);
	out.push(`${ind(1)}</tail>`);
	out.push(`</transcript>`);
	return out.join("\n");
}

/* ── markdown ──────────────────────────────────────────────────────────────── */

export function renderMarkdown(doc: DumpDoc): string {
	const out: string[] = [];
	/** A fence longer than any run of backticks inside the block, so the text can never close it. */
	const fence = (text: string): string => {
		const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
		return "`".repeat(Math.max(3, longest + 1));
	};
	const block = (text: string): void => {
		const f = fence(text);
		out.push(`${f}text`);
		out.push(text);
		out.push(f);
	};
	const heading = (n: DumpNode, depth: number): void => {
		if (n.kind === "task") {
			const h = "#".repeat(Math.min(6, depth));
			const marks = n.folded ? [`**${foldMark(n)}**`, `${n.tokens.full} → ${n.tokens.live} tok`] : [`${n.tokens.live} tok`];
			out.push(`${h} ▣ ${n.span.key} — ${n.span.title} · ${n.span.status ?? "open"} · ${marks.join(" · ")}`);
			if (n.folded) {
				block(n.wire);
				out.push(`*${n.elidedMessages} messages inside this span are not on the wire.*`);
				return;
			}
			for (const c of n.children) heading(c, depth + 1);
			return;
		}
		const h = "#".repeat(Math.min(6, depth));
		const marks = [`${n.tokens.live} tok`];
		if (n.folded) marks.push(`**${foldMark(n)}**`);
		if (n.block.protected) marks.push("protected");
		out.push(`${h} ${label(n)} · ${marks.join(" · ")}`);
		block(n.wire);
		if (n.result) {
			out.push(`*result of \`${n.block.callId ?? ""}\`:*`);
			block(n.result.text);
		}
	};
	out.push(`# transcript · ${doc.meta.sessionId}`);
	out.push("");
	out.push(`\`${doc.meta.model}\` · live **${doc.totals.live}** · full ${doc.totals.full} · budget ${doc.totals.budget} tok · generated \`${doc.generatedAt}\``);
	out.push("");
	out.push(`## system · ${doc.system?.tokens ?? 0} tok`);
	out.push(`## orientation · ${sumLive(doc.orientation)} tok`);
	for (const n of doc.orientation) heading(n, 3);
	for (const n of doc.body) heading(n, 2);
	out.push(`## tail · ${sumLive(doc.tail)} tok`);
	for (const n of doc.tail) heading(n, 3);
	return out.join("\n");
}

/** Render the document in one format. */
export function renderDump(doc: DumpDoc, format: DumpFormat): string {
	switch (format) {
		case "tree":
			return renderTree(doc);
		case "flat":
			return renderFlat(doc);
		case "yaml":
			return renderYaml(doc);
		case "xml":
			return renderXml(doc);
		case "md":
			return renderMarkdown(doc);
	}
}
