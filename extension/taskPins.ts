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
export class PinError extends Error {}

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
		throw new PinError(`Cannot read ${shown}.`);
	}
}

/** Inside the project, so a list never points at files outside it. */
function projectPath(projectDir: string, p: string): { abs: string; rel: string } {
	const root = fs.realpathSync(projectDir);
	const requested = path.resolve(root, p);
	const rel = path.relative(root, requested);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PinError(`"${p}" is outside the project; attach and quote files inside it.`);
	let abs: string;
	try {
		abs = fs.realpathSync(requested);
	} catch {
		throw new PinError(`Cannot read ${p}.`);
	}
	const resolved = path.relative(root, abs);
	if (!resolved || resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new PinError(`"${p}" resolves outside the project.`);
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
	if (!PIN_KINDS.includes(kind)) throw new PinError(`A pin's "kind" must be one of ${PIN_KINDS.join(", ")}.`);
	if (typeof r.text !== "string" || !r.text.trim()) throw new PinError(`A ${kind} pin needs "text": the exact words, quoted from its source.`);
	const text = r.text.trim();
	if (text.length > ctx.limits.textChars) throw new PinError(`The pin text is ${text.length} characters; keep it under ${ctx.limits.textChars}. Quote the sentence that matters, or pin several short quotes.`);
	if (typeof r.source !== "string" || !r.source.trim()) throw new PinError(`A ${kind} pin needs "source": "user" for the user's words, or "path", "path:line" or "path:start-end" for a file.`);
	const source = r.source.trim();
	const want = norm(text);
	if (source === "user") {
		if (!ctx.userTexts.some((u) => norm(u).includes(want))) throw new PinError("That text does not appear in any user message of this session. Pin the user's exact words, not a paraphrase.");
	} else {
		const m = /^(.+?)(?::(\d+(?:-\d+)?))?$/.exec(source)!;
		const file = projectPath(ctx.projectDir, m[1]);
		let lines = readLines(file.abs, file.rel);
		if (m[2]) {
			const range = parseLines(m[2]);
			if (!range || range.end > lines.length) throw new PinError(`"${source}": ${file.rel} has ${lines.length} lines; give a range inside it.`);
			lines = lines.slice(range.start - 1, range.end);
		}
		if (!norm(lines.join("\n")).includes(want)) throw new PinError(`That text does not appear in ${source}. Pin the exact words from the file, not a paraphrase.`);
	}
	const dup = existing.find((p) => norm(p.text) === want);
	if (dup) throw new PinError(`That text is already pinned as ${dup.id}.`);
	return { id, kind, text, source, at: ctx.now };
}

/** Check one attachment request against the file and build the attachment. */
export function makeAttachment(req: unknown, ctx: PinContext, id: string, existing: readonly Attachment[]): Attachment {
	const r = (req ?? {}) as Record<string, unknown>;
	if (typeof r.path !== "string" || !r.path.trim()) throw new PinError('An attachment needs "path", e.g. "docs/spec.md", and usually "lines": "120-140".');
	const ref = r.path.trim();
	const match = /^(.*):(\d+(?:-\d+)?)$/.exec(ref);
	if (match && r.lines !== undefined) throw new PinError('Specify the line range in "path" or "lines", not both.');
	const file = projectPath(ctx.projectDir, match ? match[1] : ref);
	const all = readLines(file.abs, file.rel);
	let lines: string | undefined;
	let slice = all;
	const requestedLines = match ? match[2] : r.lines;
	if (requestedLines !== undefined) {
		const range = typeof requestedLines === "string" ? parseLines(requestedLines) : typeof requestedLines === "number" ? parseLines(String(requestedLines)) : null;
		if (!range) throw new PinError(`"lines" must be "N" or "N-M", e.g. "120-140".`);
		if (range.end > all.length) throw new PinError(`${file.rel} has ${all.length} lines; ${range.start}-${range.end} is out of range.`);
		slice = all.slice(range.start - 1, range.end);
		lines = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
	}
	if (slice.length > ctx.limits.maxLines)
		throw new PinError(`${file.rel}${lines ? `:${lines}` : ""} is ${slice.length} lines; attach at most ${ctx.limits.maxLines}. Attach the section the task needs, e.g. "lines": "120-140".`);
	let note: string | undefined;
	if (r.note !== undefined) {
		if (typeof r.note !== "string") throw new PinError('"note" must be a string: why this is attached.');
		note = norm(r.note) || undefined;
		if (note && note.length > ctx.limits.noteChars) throw new PinError(`"note" is ${note.length} chars; keep it under ${ctx.limits.noteChars}.`);
	}
	const dup = existing.find((a) => a.path === file.rel && a.lines === lines);
	if (dup) throw new PinError(`${file.rel}${lines ? `:${lines}` : ""} is already attached as ${dup.id}.`);
	return { id, path: file.rel, ...(lines ? { lines } : {}), ...(note ? { note } : {}), hash: hashOf(slice.join("\n")), at: ctx.now };
}

/** Throws when `pins` exceed the holder's token cap. */
export function checkPinCap(pins: readonly Pin[], cap: number, owner: string): void {
	const tokens = pins.reduce((n, p) => n + pinTokens(p), 0);
	if (tokens > cap) throw new PinError(`Pins of ${owner} would take ${tokens} tokens; the limit is ${cap}. Unpin what no longer applies, or quote shorter.`);
}

/** The next free `<prefix><n>` id across the list and all its tasks. */
export function nextId(holders: readonly PinHolder[], prefix: "p" | "a"): (taken?: readonly string[]) => string {
	let n = 0;
	for (const h of holders) for (const x of prefix === "p" ? (h.pins ?? []) : (h.attachments ?? [])) n = Math.max(n, Number(/^\D+(\d+)$/.exec(x.id)?.[1] ?? 0));
	return () => `${prefix}${++n}`;
}

/** An attachment's current lines and whether they changed since it was attached. */
export function readAttachment(projectDir: string, a: Attachment, maxLines = PIN_LIMITS.maxLines): { text: string | null; changed: boolean } {
	let all: string[];
	try {
		all = fs.readFileSync(projectPath(projectDir, a.path).abs, "utf8").split("\n");
	} catch {
		return { text: null, changed: true };
	}
	const range = a.lines ? parseLines(a.lines) : { start: 1, end: all.length };
	if (!range || range.end > all.length || range.end - range.start + 1 > maxLines) return { text: null, changed: true };
	const slice = all.slice(range.start - 1, range.end);
	const text = slice.map((l, i) => `${String(range.start + i).padStart(4)} │ ${l}`).join("\n");
	return { text, changed: !!a.hash && hashOf(slice.join("\n")) !== a.hash };
}

/** The pieces of a list the working set reads. */
export interface WorkingSetList extends PinHolder {
	slug: string;
	title: string;
	goal?: string;
	tasks: readonly (PinHolder & { id: string; title: string; status: string; acceptanceCriteria?: string[] })[];
}

/** The task context `start` and `claim` deliver: goal, list pins, and the doing branch's pins, attachments and criteria. */
export function workingSet(list: WorkingSetList, projectDir: string, render: AttachmentRender, maxLines = PIN_LIMITS.maxLines): string {
	const out = [`[tasks] ${list.slug} — ${list.title}`, list.goal ? `goal: ${list.goal}` : `goal: none yet — set it with tasks update {list: "${list.slug}", goal}`];
	const pinLines = (pins: readonly Pin[] | undefined, indent: string) => (pins ?? []).map((p) => `${indent}pin ${p.id} ${p.kind}: ${p.text} (${p.source})`);
	const attachLines = (atts: readonly Attachment[] | undefined, indent: string) =>
		(atts ?? []).flatMap((a) => {
			const where = `${a.path}${a.lines ? `:${a.lines}` : ""}`;
			const { text, changed } = readAttachment(projectDir, a, maxLines);
			const head = `${indent}attached ${a.id} ${where}${a.note ? ` — ${a.note}` : ""}${text === null ? " (unreadable)" : changed ? " (changed since attached)" : ""}`;
			return render === "inline" && text !== null ? [head, ...text.split("\n").map((l) => `${indent}  ${l}`)] : [head];
		});
	out.push(...pinLines(list.pins, ""), ...attachLines(list.attachments, ""));
	const doing = list.tasks.filter((t) => t.status === "doing");
	const inner = doing.find((t) => !doing.some((o) => o.id.startsWith(`${t.id}.`)));
	if (inner) {
		const branch = list.tasks.filter((t) => inner.id === t.id || inner.id.startsWith(`${t.id}.`));
		for (const t of branch) {
			const own = [
				...(t.acceptanceCriteria?.length ? [`  acceptance criteria:`, ...t.acceptanceCriteria.map((c) => `    - ${c}`)] : []),
				...pinLines(t.pins, "  "),
				...attachLines(t.attachments, "  "),
			];
			if (t === inner || own.length) out.push(`${t === inner ? "doing" : "within"} ${t.id} "${t.title}"`, ...own);
		}
	}
	return out.join("\n");
}
