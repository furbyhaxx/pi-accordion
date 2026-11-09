/*
 * taskPins.ts — pins and attachments on task lists and tasks, and the context deliveries built from them.
 *
 * A pin is a verbatim quote (rule, convention, constraint, standard, fact) from a user message or a
 * file; an attachment names a part of a file by section, symbol or quote. Both live in the list
 * file, on the list or on a task, so they outlive the session. A delivery is what one `tasks`
 * result puts in front of the model; it is sent again only when the model can no longer see it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeQuote, refOf, resolveQuote, resolveSection, type Anchor, type AnchorState, type Resolution } from "./taskAnchors";
import { resolveSymbol, symbolLang } from "./taskSymbols";

import { NOTE_MAX, PIN_KINDS, PIN_TEXT_MAX } from "./taskSchema";

export type PinKind = (typeof PIN_KINDS)[number];

export interface Pin {
	/** `p<n>`, unique within the list. */
	id: string;
	kind: PinKind;
	text: string;
	/** `user`, `path`, `path:line` or `path:start-end`. */
	source: string;
	at: string;
}

export interface Attachment {
	/** `a<n>`, unique within the list. */
	id: string;
	/** Relative to the project directory. */
	path: string;
	/** What part of the file: a section, a symbol or a quote. Absent means the whole (short) file. */
	anchor?: Anchor;
	/** Legacy line range `N` or `N-M`; turned into a quote anchor the next time the attachment is delivered. */
	lines?: string;
	note?: string;
	/** sha256 prefix of the content when it was last delivered or attached; absent in a hand-written file. */
	hash?: string;
	at?: string;
}

/** Something that carries pins and attachments: a list or a task. */
export interface PinHolder {
	pins?: Pin[];
	attachments?: Attachment[];
}

export interface PinLimits {
	/** Characters of one pin's text. */
	textChars: number;
	/** Tokens of all list pins. */
	listTokens: number;
	/** Tokens of one task's pins. */
	taskTokens: number;
	/** Lines of one attachment. */
	maxLines: number;
	/** Characters of an attachment note. */
	noteChars: number;
	/** Absolute directories outside the project whose files may be attached and quoted. */
	roots: readonly string[];
}

export const PIN_LIMITS: Readonly<PinLimits> = { textChars: PIN_TEXT_MAX, listTokens: 2000, taskTokens: 1500, maxLines: 60, noteChars: NOTE_MAX, roots: [] };

export type AttachmentRender = "inline" | "reference";

/** A refused pin or attachment; the store reports it as a `TaskError` with the same code. */
export class PinError extends Error {
	// A plain field, not a parameter property: the skill's validator loads this file with Node's type stripping.
	readonly code: "invalid_args" | "not_found" | "cap_exceeded" | "quote_mismatch" | "invalid_transition";
	constructor(code: PinError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
/** Rough tokens; caps only need an estimate. */
export const pinTokens = (p: Pin) => Math.ceil((p.text.length + p.source.length + 24) / 4);

const LINES_RE = /^([1-9]\d*)(?:-([1-9]\d*))?$/;

/** `"12"` or `"12-20"` → range; null when malformed or reversed. */
export function parseLines(lines: string): { start: number; end: number } | null {
	const m = LINES_RE.exec(lines.trim());
	if (!m) return null;
	const start = Number(m[1]);
	const end = Number(m[2] ?? m[1]);
	return !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start ? null : { start, end };
}

function readLines(abs: string, shown: string): string[] {
	try {
		return fs.readFileSync(abs, "utf8").split("\n");
	} catch {
		throw new PinError("not_found", `Cannot read ${shown}.`);
	}
}

const within = (root: string, abs: string) => {
	const rel = path.relative(root, abs);
	return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * Inside the project or a configured root, so a committed list cannot make the agent read and send
 * arbitrary files. A relative path is project-relative; an absolute one is stored as written unless
 * it lies in the project.
 */
function projectPath(projectDir: string, p: string, roots: readonly string[] = []): { abs: string; rel: string } {
	const root = fs.realpathSync(projectDir);
	const requested = path.resolve(root, p);
	const inProject = within(root, requested);
	const real = roots.flatMap((r) => {
		try {
			return [fs.realpathSync(r)];
		} catch {
			return [];
		}
	});
	if (!inProject && !(path.isAbsolute(p) && [...roots, ...real].some((r) => within(r, requested))))
		throw new PinError("invalid_args", `"${p}" is outside the project; attach files inside it${roots.length ? ` or under ${roots.join(", ")}` : `, or add its directory to tasks.attachments.roots in ~/.accordion/config.json`}.`);
	let abs: string;
	try {
		abs = fs.realpathSync(requested);
	} catch {
		throw new PinError("not_found", `Cannot read ${p}.`);
	}
	const allowed = inProject ? within(root, abs) : real.some((r) => within(r, abs));
	if (!allowed) throw new PinError("invalid_args", `"${p}" resolves outside ${inProject ? "the project" : "its root"}.`);
	return { abs, rel: inProject ? path.relative(root, requested).split(path.sep).join("/") : path.normalize(requested) };
}

export interface PinContext {
	projectDir: string;
	/** Text of every user message in this session. */
	userTexts: readonly string[];
	limits: PinLimits;
	now: string;
}

/** Check one pin request against its source and build the pin. */
export function makePin(req: unknown, ctx: PinContext, id: string, existing: readonly Pin[]): Pin {
	const r = (req ?? {}) as Record<string, unknown>;
	const kind = r.kind as PinKind;
	if (!PIN_KINDS.includes(kind)) throw new PinError("invalid_args", `A pin's "kind" must be one of ${PIN_KINDS.join(", ")}.`);
	if (typeof r.text !== "string" || !r.text.trim()) throw new PinError("invalid_args", `A ${kind} pin needs "text": the exact words, quoted from its source.`);
	const text = r.text.trim();
	if (text.length > ctx.limits.textChars) throw new PinError("cap_exceeded", `The pin text is ${text.length} characters; keep it under ${ctx.limits.textChars}. Quote the sentence that matters, or pin several short quotes.`);
	if (typeof r.source !== "string" || !r.source.trim()) throw new PinError("invalid_args", `A ${kind} pin needs "source": "user" for the user's words, or "path", "path:line" or "path:start-end" for a file.`);
	const source = r.source.trim();
	const want = norm(text);
	if (source === "user") {
		if (!ctx.userTexts.some((u) => norm(u).includes(want))) throw new PinError("quote_mismatch", "That text does not appear in any user message of this session. Pin the user's exact words, not a paraphrase.");
	} else {
		const m = /^(.+?)(?::(\d+(?:-\d+)?))?$/.exec(source)!;
		const file = projectPath(ctx.projectDir, m[1], ctx.limits.roots);
		let lines = readLines(file.abs, file.rel);
		if (m[2]) {
			const range = parseLines(m[2]);
			if (!range || range.end > lines.length) throw new PinError("not_found", `"${source}": ${file.rel} has ${lines.length} lines; give a range inside it.`);
			lines = lines.slice(range.start - 1, range.end);
		}
		if (!norm(lines.join("\n")).includes(want)) throw new PinError("quote_mismatch", `That text does not appear in ${source}. Pin the exact words from the file, not a paraphrase.`);
	}
	const dup = existing.find((p) => norm(p.text) === want);
	if (dup) throw new PinError("invalid_transition", `That text is already pinned as ${dup.id}.`);
	return { id, kind, text, source, at: ctx.now };
}

const textOf = (abs: string, shown: string): string => {
	try {
		return fs.readFileSync(abs, "utf8");
	} catch {
		throw new PinError("not_found", `Cannot read ${shown}.`);
	}
};

/** Canonical name of what an attachment points at, e.g. `docs/auth.md#Token store > Interface`. */
export function attachmentRef(a: Pick<Attachment, "id" | "path" | "anchor" | "lines">): string {
	return a.anchor ? refOf(a.path, a.anchor, a.id) : `${a.path}${a.lines ? `:${a.lines}` : ""}`;
}

const ANCHOR_INPUTS = ["section", "symbol", "quote", "lines"] as const;

/** Where `n` lines of `text` start and end as character offsets. */
function lineSpan(text: string, first: number, last: number): { start: number; end: number } {
	const all = text.split("\n");
	const start = all.slice(0, first - 1).reduce((n, l) => n + l.length + 1, 0);
	return { start, end: start + all.slice(first - 1, last).join("\n").length };
}

const sameTarget = (a: Pick<Attachment, "path" | "anchor" | "lines">, b: Pick<Attachment, "path" | "anchor" | "lines">) =>
	a.path === b.path && (a.anchor && b.anchor ? ("quote" in a.anchor && "quote" in b.anchor ? a.anchor.quote.exact === b.anchor.quote.exact : JSON.stringify(a.anchor) === JSON.stringify(b.anchor)) : !a.anchor && !b.anchor && a.lines === b.lines);

/** Check one attachment request against the file and build the attachment. */
export function makeAttachment(req: unknown, ctx: PinContext, id: string, existing: readonly Attachment[]): Attachment {
	const r = (req ?? {}) as Record<string, unknown>;
	if (typeof r.path !== "string" || !r.path.trim()) throw new PinError("invalid_args", 'An attachment needs "path", e.g. "docs/spec.md", and usually a "section", "symbol" or "quote".');
	const ref = r.path.trim();
	const suffix = /^(.*):(\d+(?:-\d+)?)$/.exec(ref);
	const given = ANCHOR_INPUTS.filter((k) => r[k] !== undefined && r[k] !== null);
	if (suffix && given.length) throw new PinError("invalid_args", `Give the part of the file once: "${ANCHOR_INPUTS.join('", "')}" or a ":N-M" suffix on "path", not several.`);
	if (given.length > 1) throw new PinError("invalid_args", `Give exactly one of "${ANCHOR_INPUTS.join('", "')}", or none for the whole file.`);
	const file = projectPath(ctx.projectDir, suffix ? suffix[1] : ref, ctx.limits.roots);
	const text = textOf(file.abs, file.rel);
	const kind = suffix ? "lines" : given[0];
	const value = suffix ? suffix[2] : kind ? r[kind] : undefined;
	let anchor: Anchor | undefined;
	let content = text;
	if (kind === "section") {
		if (typeof value !== "string" || !value.trim()) throw new PinError("invalid_args", '"section" is a Markdown heading path, e.g. "Token store > Interface".');
		const section = value.split(">").map((x) => x.trim()).filter(Boolean).join(" > ");
		const found = resolveSection(text, section);
		if ("lost" in found) throw new PinError("not_found", `${file.rel} has no section "${section}" (or it is ambiguous).${found.candidates?.length ? ` Closest: ${found.candidates.join("; ")}.` : ""}`);
		anchor = { section };
		content = found.content;
	} else if (kind === "symbol") {
		if (typeof value !== "string" || !value.trim()) throw new PinError("invalid_args", '"symbol" is a declaration name, e.g. "TokenStore.get".');
		if (!symbolLang(file.rel)) throw new PinError("invalid_args", `Symbols resolve in .ts, .tsx, .js, .py and .rs files; anchor ${file.rel} with "section" or "quote" instead.`);
		const symbol = value.split(".").map((x) => x.trim()).filter(Boolean).join(".");
		const found = resolveSymbol(file.rel, text, symbol);
		if ("lost" in found) throw new PinError("not_found", `${file.rel} has no symbol "${symbol}".${found.candidates?.length ? ` Found here: ${found.candidates.join(", ")}.` : ""}`);
		anchor = { symbol };
		content = found.content;
	} else if (kind === "quote") {
		if (typeof value !== "string" || !value.trim()) throw new PinError("invalid_args", '"quote" is the exact text to attach, copied from the file.');
		const at = text.indexOf(value);
		if (at === -1) throw new PinError("quote_mismatch", `That text does not appear in ${file.rel}. Quote it exactly as written.`);
		const more = text.indexOf(value, at + 1);
		if (more !== -1) throw new PinError("invalid_args", `That text appears more than once in ${file.rel}; quote a longer, unique passage.`);
		anchor = { quote: makeQuote(text, at, at + value.length) };
		content = value;
	} else if (kind === "lines") {
		const range = typeof value === "string" ? parseLines(value) : typeof value === "number" ? parseLines(String(value)) : null;
		if (!range) throw new PinError("invalid_args", `"lines" must be "N" or "N-M", e.g. "120-140".`);
		const total = text.split("\n").length;
		if (range.end > total) throw new PinError("not_found", `${file.rel} has ${total} lines; ${range.start}-${range.end} is out of range.`);
		const span = lineSpan(text, range.start, range.end);
		anchor = { quote: makeQuote(text, span.start, span.end) };
		content = text.slice(span.start, span.end);
	}
	const size = content.split("\n").length;
	if (size > ctx.limits.maxLines)
		throw new PinError("cap_exceeded", `${file.rel} selects ${size} lines; attach at most ${ctx.limits.maxLines}. Anchor a smaller part: a "section", a "symbol" or a "quote".`);
	let note: string | undefined;
	if (r.note !== undefined && r.note !== null) {
		if (typeof r.note !== "string") throw new PinError("invalid_args", '"note" must be a string: why this is attached.');
		note = norm(r.note) || undefined;
		if (note && note.length > ctx.limits.noteChars) throw new PinError("invalid_args", `"note" is ${note.length} chars; keep it under ${ctx.limits.noteChars}.`);
	}
	const candidate = { id, path: file.rel, ...(anchor ? { anchor } : {}) };
	const dup = existing.find((a) => sameTarget(a, candidate));
	if (dup) throw new PinError("invalid_transition", `${attachmentRef(dup)} is already attached as ${dup.id}.`);
	return { ...candidate, ...(note ? { note } : {}), hash: hashOf(content), at: ctx.now };
}

/** Throws when `pins` exceed the holder's token cap. */
export function checkPinCap(pins: readonly Pin[], cap: number, owner: string): void {
	const tokens = pins.reduce((n, p) => n + pinTokens(p), 0);
	if (tokens > cap) throw new PinError("cap_exceeded", `Pins of ${owner} would take ${tokens} tokens; the limit is ${cap}. Unpin what no longer applies, or quote shorter.`);
}

/** The next free `<prefix><n>` id across the list and all its tasks. */
export function nextId(holders: readonly PinHolder[], prefix: "p" | "a"): (taken?: readonly string[]) => string {
	let n = 0;
	for (const h of holders) for (const x of prefix === "p" ? (h.pins ?? []) : (h.attachments ?? [])) n = Math.max(n, Number(/^\D+(\d+)$/.exec(x.id)?.[1] ?? 0));
	return () => `${prefix}${++n}`;
}

/** What an attachment resolves to now. `anchor` is set when the stored anchor should be replaced by it. */
export type AttachmentRead = { content: string; state?: AnchorState; anchor?: Anchor } | { lost: true; tooLarge?: boolean; candidates?: string[] };

/** The attachment's current content by its anchor, or why it cannot be read. Symbols need `warmSymbols` first. */
export function readAttachment(projectDir: string, a: Attachment, maxLines = PIN_LIMITS.maxLines, roots: readonly string[] = []): AttachmentRead {
	let text: string;
	try {
		text = fs.readFileSync(projectPath(projectDir, a.path, roots).abs, "utf8");
	} catch {
		return { lost: true };
	}
	let found: Resolution;
	let refreshed: Anchor | undefined;
	if (a.anchor && "section" in a.anchor) found = resolveSection(text, a.anchor.section);
	else if (a.anchor && "symbol" in a.anchor) found = resolveSymbol(a.path, text, a.anchor.symbol);
	else if (a.anchor) {
		found = resolveQuote(text, a.anchor.quote);
		if ("content" in found && (found.state || a.anchor.quote.start === undefined)) {
			const at = text.indexOf(found.content);
			refreshed = { quote: makeQuote(text, at, at + found.content.length) };
		}
	} else if (a.lines) {
		const range = parseLines(a.lines);
		if (!range || range.end > text.split("\n").length) return { lost: true };
		const span = lineSpan(text, range.start, range.end);
		found = { content: text.slice(span.start, span.end) };
		refreshed = { quote: makeQuote(text, span.start, span.end) };
	} else found = { content: text };
	if ("lost" in found) return found;
	if (found.content.split("\n").length > maxLines) return { lost: true, tooLarge: true };
	return { content: found.content, ...(found.state ? { state: found.state } : {}), ...(refreshed ? { anchor: refreshed } : {}) };
}

/** The pieces of a list task context is built from. */
/** A goal or criterion as the list stores and `start` delivers it. */
export interface ContextItem {
	id: string;
	text: string;
}

export interface ContextList extends PinHolder {
	goals?: readonly ContextItem[];
	tasks: readonly (PinHolder & { id: string; title: string; status: string; goals?: readonly ContextItem[]; acceptanceCriteria?: readonly ContextItem[] })[];
}

/** A pin as `start` delivers it. */
export type PinOut = Pick<Pin, "id" | "kind" | "text" | "source">;
/** An attachment as `start` delivers it (SPEC-0002 §3.3). */
export interface AttachmentOut {
	id: string;
	ref: string;
	note?: string;
	content?: string;
	/** `moved`/`fuzzy`: the quote was found elsewhere or approximately; `changed`: edited since last delivered; `lost`: gone; `too_large`: grew past the attachment cap. */
	state?: "changed" | "lost" | "moved" | "fuzzy" | "too_large";
	/** For `lost`: what exists nearby. */
	candidates?: string[];
}
/** List context: the goal and list-scoped facts. */
export interface ListContext {
	goals?: ContextItem[];
	pins?: PinOut[];
	attachments?: AttachmentOut[];
}
/** One task's context; `goals`, `criteria`, `pins` and `attachments` hold only what the model cannot already see. */
export interface TaskContext {
	id: string;
	title: string;
	goals?: ContextItem[];
	criteria?: ContextItem[];
	pins?: PinOut[];
	attachments?: AttachmentOut[];
}

/**
 * Delivery keys name what one result put in front of the model. A key embeds a hash of the
 * delivered text, so an edit makes the old delivery stop counting (SPEC-0002 §4.3).
 */
export const deliveryKey = {
	/** A goal or criterion: list-unique id plus a hash of its current text. */
	item: (item: ContextItem) => `item:${item.id}#${hashOf(item.text)}`,
	pin: (id: string) => `pin:${id}`,
	/** By id only: edits the agent makes to an attached file during its task never re-send the attachment. */
	attachment: (id: string) => `att:${id}`,
};

/**
 * Delivery keys the model can still see: those recorded on result blocks that are present and not
 * folded. Folded or absent (compacted, other branch) deliveries do not count, so their content is sent again.
 */
export function liveDeliveryKeys(blocks: Iterable<{ details?: unknown }>, folded: (b: { details?: unknown }) => boolean): Set<string> {
	const live = new Set<string>();
	for (const b of blocks) {
		const keys = b.details && typeof b.details === "object" ? (b.details as { delivered?: unknown }).delivered : undefined;
		if (!Array.isArray(keys) || folded(b)) continue;
		for (const k of keys) if (typeof k === "string") live.add(k);
	}
	return live;
}

/** What a context delivery contains, and the keys and attachment hashes it delivered. */
export interface Delivery {
	list?: ListContext;
	tasks: TaskContext[];
	delivered: string[];
	/** Attachment id → what is now in front of the model; the store records it so later changes are reported once. */
	seen: Record<string, { hash: string; anchor?: Anchor }>;
}

/**
 * The context of `taskIds` (outermost first) and of the list, minus what `live` says the model can
 * still see. List context is included only when `withList` is set.
 */
export function deliverContext(list: ContextList, taskIds: readonly string[], withList: boolean, live: (key: string) => boolean, projectDir: string, render: AttachmentRender, maxLines = PIN_LIMITS.maxLines, roots: readonly string[] = []): Delivery {
	const delivered: string[] = [];
	const seen: Record<string, { hash: string; anchor?: Anchor }> = {};
	const pinsOf = (pins: readonly Pin[] | undefined) =>
		(pins ?? []).flatMap((p) => {
			const key = deliveryKey.pin(p.id);
			if (live(key)) return [];
			delivered.push(key);
			return [{ id: p.id, kind: p.kind, text: p.text, source: p.source }];
		});
	const attachmentsOf = (atts: readonly Attachment[] | undefined) =>
		(atts ?? []).flatMap((a): AttachmentOut[] => {
			const key = deliveryKey.attachment(a.id);
			if (live(key)) return [];
			delivered.push(key);
			const read = readAttachment(projectDir, a, maxLines, roots);
			const base = { id: a.id, ref: attachmentRef(a), ...(a.note ? { note: a.note } : {}) };
			if ("lost" in read) return [{ ...base, state: read.tooLarge ? "too_large" : "lost", ...(read.candidates?.length ? { candidates: read.candidates } : {}) }];
			const hash = hashOf(read.content);
			seen[a.id] = { hash, ...(read.anchor ? { anchor: read.anchor } : {}) };
			const state = read.state ?? (a.hash && a.hash !== hash ? "changed" : undefined);
			return [{ ...base, ...(render === "inline" ? { content: read.content } : {}), ...(state ? { state } : {}) }];
		});
	const itemsOf = (items: readonly ContextItem[] | undefined) =>
		(items ?? []).flatMap((x) => {
			const key = deliveryKey.item(x);
			if (live(key)) return [];
			delivered.push(key);
			return [{ id: x.id, text: x.text }];
		});
	let listCtx: ListContext | undefined;
	if (withList) {
		const goals = itemsOf(list.goals);
		const pins = pinsOf(list.pins);
		const attachments = attachmentsOf(list.attachments);
		if (goals.length || pins.length || attachments.length) listCtx = { ...(goals.length ? { goals } : {}), ...(pins.length ? { pins } : {}), ...(attachments.length ? { attachments } : {}) };
	}
	const tasks = taskIds.flatMap((id): TaskContext[] => {
		const t = list.tasks.find((x) => x.id === id);
		if (!t) return [];
		const goals = itemsOf(t.goals);
		const criteria = itemsOf(t.acceptanceCriteria);
		const pins = pinsOf(t.pins);
		const attachments = attachmentsOf(t.attachments);
		return [{ id: t.id, title: t.title, ...(goals.length ? { goals } : {}), ...(criteria.length ? { criteria } : {}), ...(pins.length ? { pins } : {}), ...(attachments.length ? { attachments } : {}) }];
	});
	return { ...(listCtx ? { list: listCtx } : {}), tasks, delivered, seen };
}
