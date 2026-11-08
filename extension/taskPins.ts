/*
 * taskPins.ts — pins and attachments on task lists and tasks, and the working set built from them.
 *
 * A pin is a verbatim quote (rule, convention, constraint, standard, fact) from a user message or a
 * file; an attachment is a file line range. Both live in the list file, on the list or on a task,
 * so they outlive the session. The working set shows the goal, list pins and the pins, attachments
 * and acceptance criteria of the branch in progress at the end of every request.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PIN_KINDS = ["rule", "convention", "constraint", "standard", "fact"] as const;
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
	/** `N` or `N-M`; absent means the whole (short) file. */
	lines?: string;
	note?: string;
	/** sha256 prefix of the attached lines when attached; absent in a hand-written file. */
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
}

export const PIN_LIMITS: Readonly<PinLimits> = { textChars: 300, listTokens: 2000, taskTokens: 1500, maxLines: 60, noteChars: 120 };

export type AttachmentRender = "inline" | "reference";

/** A rejected pin or attachment: the message says what to do instead. */
/** A refused pin or attachment; the store reports it as a `TaskError` with the same code. */
export class PinError extends Error {
	constructor(readonly code: "invalid_args" | "not_found" | "cap_exceeded" | "quote_mismatch" | "invalid_transition", message: string) {
		super(message);
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

/** Inside the project, so a list never points at files outside it. */
function projectPath(projectDir: string, p: string): { abs: string; rel: string } {
	const root = fs.realpathSync(projectDir);
	const requested = path.resolve(root, p);
	const rel = path.relative(root, requested);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PinError("invalid_args", `"${p}" is outside the project; attach and quote files inside it.`);
	let abs: string;
	try {
		abs = fs.realpathSync(requested);
	} catch {
		throw new PinError("not_found", `Cannot read ${p}.`);
	}
	const resolved = path.relative(root, abs);
	if (!resolved || resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new PinError("invalid_args", `"${p}" resolves outside the project.`);
	return { abs, rel: rel.split(path.sep).join("/") };
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
		const file = projectPath(ctx.projectDir, m[1]);
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

/** Check one attachment request against the file and build the attachment. */
export function makeAttachment(req: unknown, ctx: PinContext, id: string, existing: readonly Attachment[]): Attachment {
	const r = (req ?? {}) as Record<string, unknown>;
	if (typeof r.path !== "string" || !r.path.trim()) throw new PinError("invalid_args", 'An attachment needs "path", e.g. "docs/spec.md", and usually "lines": "120-140".');
	const ref = r.path.trim();
	const match = /^(.*):(\d+(?:-\d+)?)$/.exec(ref);
	if (match && r.lines !== undefined) throw new PinError("invalid_args", 'Specify the line range in "path" or "lines", not both.');
	const file = projectPath(ctx.projectDir, match ? match[1] : ref);
	const all = readLines(file.abs, file.rel);
	let lines: string | undefined;
	let slice = all;
	const requestedLines = match ? match[2] : r.lines;
	if (requestedLines !== undefined) {
		const range = typeof requestedLines === "string" ? parseLines(requestedLines) : typeof requestedLines === "number" ? parseLines(String(requestedLines)) : null;
		if (!range) throw new PinError("invalid_args", `"lines" must be "N" or "N-M", e.g. "120-140".`);
		if (range.end > all.length) throw new PinError("not_found", `${file.rel} has ${all.length} lines; ${range.start}-${range.end} is out of range.`);
		slice = all.slice(range.start - 1, range.end);
		lines = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
	}
	if (slice.length > ctx.limits.maxLines)
		throw new PinError("cap_exceeded", `${file.rel}${lines ? `:${lines}` : ""} is ${slice.length} lines; attach at most ${ctx.limits.maxLines}. Attach the section the task needs, e.g. "lines": "120-140".`);
	let note: string | undefined;
	if (r.note !== undefined) {
		if (typeof r.note !== "string") throw new PinError("invalid_args", '"note" must be a string: why this is attached.');
		note = norm(r.note) || undefined;
		if (note && note.length > ctx.limits.noteChars) throw new PinError("invalid_args", `"note" is ${note.length} chars; keep it under ${ctx.limits.noteChars}.`);
	}
	const dup = existing.find((a) => a.path === file.rel && a.lines === lines);
	if (dup) throw new PinError("invalid_transition", `${file.rel}${lines ? `:${lines}` : ""} is already attached as ${dup.id}.`);
	return { id, path: file.rel, ...(lines ? { lines } : {}), ...(note ? { note } : {}), hash: hashOf(slice.join("\n")), at: ctx.now };
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

/** An attachment's current text, or null when the file or range can no longer be read. */
export function attachmentContent(projectDir: string, a: Attachment, maxLines = PIN_LIMITS.maxLines): string | null {
	let all: string[];
	try {
		all = fs.readFileSync(projectPath(projectDir, a.path).abs, "utf8").split("\n");
	} catch {
		return null;
	}
	const range = a.lines ? parseLines(a.lines) : { start: 1, end: all.length };
	if (!range || range.end > all.length || range.end - range.start + 1 > maxLines) return null;
	return all.slice(range.start - 1, range.end).join("\n");
}

/** The pieces of a list task context is built from. */
export interface ContextList extends PinHolder {
	goal?: string;
	tasks: readonly (PinHolder & { id: string; title: string; status: string; acceptanceCriteria?: string[] })[];
}

/** A pin as `start` delivers it. */
export type PinOut = Pick<Pin, "id" | "kind" | "text" | "source">;
/** An attachment as `start` delivers it (SPEC-0002 §3.3). */
export interface AttachmentOut {
	id: string;
	ref: string;
	note?: string;
	content?: string;
	state?: "changed" | "lost";
}
/** List context: the goal and list-scoped facts. */
export interface ListContext {
	goal?: string;
	pins?: PinOut[];
	attachments?: AttachmentOut[];
}
/** One task's context; `criteria`, `pins` and `attachments` hold only what the model cannot already see. */
export interface TaskContext {
	id: string;
	title: string;
	criteria?: string[];
	pins?: PinOut[];
	attachments?: AttachmentOut[];
}

/**
 * Delivery keys name what one result put in front of the model. A key embeds a hash of the
 * delivered text, so an edit makes the old delivery stop counting (SPEC-0002 §4.3).
 */
export const deliveryKey = {
	goal: (goal: string) => `goal#${hashOf(goal)}`,
	criteria: (taskId: string, criteria: readonly string[]) => `crit:${taskId}#${hashOf(criteria.join("\n"))}`,
	pin: (id: string) => `pin:${id}`,
	attachment: (id: string, content: string | null) => `att:${id}#${content === null ? "lost" : hashOf(content)}`,
};

/** What a context delivery contains, and the keys and attachment hashes it delivered. */
export interface Delivery {
	list?: ListContext;
	tasks: TaskContext[];
	delivered: string[];
	/** Attachment id → content hash now in front of the model; the store records it so later changes are reported once. */
	seen: Record<string, string>;
}

/**
 * The context of `taskIds` (outermost first) and of the list, minus what `live` says the model can
 * still see. List context is included only when `withList` is set.
 */
export function deliverContext(list: ContextList, taskIds: readonly string[], withList: boolean, live: (key: string) => boolean, projectDir: string, render: AttachmentRender, maxLines = PIN_LIMITS.maxLines): Delivery {
	const delivered: string[] = [];
	const seen: Record<string, string> = {};
	const pinsOf = (pins: readonly Pin[] | undefined) =>
		(pins ?? []).flatMap((p) => {
			const key = deliveryKey.pin(p.id);
			if (live(key)) return [];
			delivered.push(key);
			return [{ id: p.id, kind: p.kind, text: p.text, source: p.source }];
		});
	const attachmentsOf = (atts: readonly Attachment[] | undefined) =>
		(atts ?? []).flatMap((a): AttachmentOut[] => {
			const content = attachmentContent(projectDir, a, maxLines);
			const key = deliveryKey.attachment(a.id, content);
			if (live(key)) return [];
			delivered.push(key);
			const hash = content === null ? null : hashOf(content);
			if (hash) seen[a.id] = hash;
			const state = content === null ? "lost" : a.hash && a.hash !== hash ? "changed" : undefined;
			return [{
				id: a.id,
				ref: `${a.path}${a.lines ? `:${a.lines}` : ""}`,
				...(a.note ? { note: a.note } : {}),
				...(content !== null && render === "inline" ? { content } : {}),
				...(state ? { state } : {}),
			}];
		});
	let listCtx: ListContext | undefined;
	if (withList) {
		const goalKey = list.goal ? deliveryKey.goal(list.goal) : null;
		const goal = goalKey && !live(goalKey) ? list.goal : undefined;
		if (goal && goalKey) delivered.push(goalKey);
		const pins = pinsOf(list.pins);
		const attachments = attachmentsOf(list.attachments);
		if (goal || pins.length || attachments.length) listCtx = { ...(goal ? { goal } : {}), ...(pins.length ? { pins } : {}), ...(attachments.length ? { attachments } : {}) };
	}
	const tasks = taskIds.flatMap((id): TaskContext[] => {
		const t = list.tasks.find((x) => x.id === id);
		if (!t) return [];
		const critKey = t.acceptanceCriteria?.length ? deliveryKey.criteria(t.id, t.acceptanceCriteria) : null;
		const criteria = critKey && !live(critKey) ? t.acceptanceCriteria : undefined;
		if (criteria && critKey) delivered.push(critKey);
		const pins = pinsOf(t.pins);
		const attachments = attachmentsOf(t.attachments);
		return [{ id: t.id, title: t.title, ...(criteria ? { criteria } : {}), ...(pins.length ? { pins } : {}), ...(attachments.length ? { attachments } : {}) }];
	});
	return { ...(listCtx ? { list: listCtx } : {}), tasks, delivered, seen };
}
