/*
 * pins.ts — excerpts the agent pins so they stay in view while their scope is active: rules,
 * conventions, constraints and facts quoted verbatim from a source, and file line ranges. Pins are
 * kept in the session as `accordion.pins` entries; the working set is rebuilt from them each turn
 * and sent as one message at the end of the context, so the cached prefix never changes for them.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, TaskList } from "./tasks";

export const PIN_ENTRY = "accordion.pins";
export const PIN_KINDS = ["rule", "convention", "constraint", "fact", "file"] as const;
export type PinKind = (typeof PIN_KINDS)[number];

/** Limits that keep pins small; checked on every `pin`. */
export interface PinLimits {
	/** Characters of one text pin. */
	textChars: number;
	/** Lines of one file pin. */
	fileLines: number;
	/** Tokens of all session pins. */
	sessionTokens: number;
	/** Tokens of one task's pins. */
	taskTokens: number;
}

export const PIN_LIMITS: Readonly<PinLimits> = { textChars: 300, fileLines: 30, sessionTokens: 2000, taskTokens: 1500 };

export interface Pin {
	id: string;
	kind: PinKind;
	/** `session`, or `<list>/<taskId>`. */
	scope: string;
	/** The pinned text: the quote, or the file lines as resolved. */
	text: string;
	/** Where a text pin was quoted from: `user`, `path` or `path:line`. */
	source?: string;
	/** A file pin's range; `path` is absolute. */
	file?: { path: string; display: string; start: number; end: number; hash: string };
	/** Set when the pinned lines changed in the file and the text is the new content. */
	changed?: boolean;
	at: string;
}

export type PinEvent = { op: "pin"; pin: Pin } | { op: "unpin"; id: string } | { op: "update"; pin: Pin };

export class PinError extends Error {}

/** The current pins from session entries, in pin order. */
export function pinsOf(entries: readonly unknown[]): Pin[] {
	const out = new Map<string, Pin>();
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: PinEvent };
		if (entry?.type !== "custom" || entry.customType !== PIN_ENTRY || !entry.data) continue;
		const d = entry.data;
		if (d.op === "pin" || d.op === "update") out.set(d.pin.id, d.pin);
		else if (d.op === "unpin") out.delete(d.id);
	}
	return [...out.values()];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Rough tokens: the working set is small, a char estimate is enough to enforce caps. */
export const pinTokens = (p: Pin) => Math.ceil((p.text.length + (p.source?.length ?? 0) + 24) / 4);
const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

/** A pin request as the agent sends it. */
export interface PinRequest {
	kind?: unknown;
	text?: unknown;
	source?: unknown;
	ref?: unknown;
}

export interface PinContext {
	cwd: string;
	/** Text of every user message so far. */
	userTexts: readonly string[];
	existing: readonly Pin[];
	scope: string;
	limits?: PinLimits;
	now?: string;
}

function readLines(abs: string): string[] {
	try {
		return fs.readFileSync(abs, "utf8").split("\n");
	} catch {
		throw new PinError(`Cannot read ${abs}.`);
	}
}

function numbered(lines: readonly string[], start: number): string {
	return lines.map((l, i) => `${String(start + i).padStart(4)} │ ${l}`).join("\n");
}

/** `path:12-20` → absolute path, display path and range. */
function parseRef(ref: string, cwd: string): { abs: string; display: string; start: number; end: number } {
	const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref.trim());
	if (!m) throw new PinError(`"${ref}" is not a file range. Use "path/to/file:start-end", e.g. "src/config.py:12-18".`);
	const start = Number(m[2]);
	const end = Number(m[3] ?? m[2]);
	if (start < 1 || end < start) throw new PinError(`"${ref}": the range must run from line 1 or later, start before end.`);
	const abs = path.resolve(cwd, m[1]);
	return { abs, display: path.relative(cwd, abs) || m[1], start, end };
}

/**
 * Check one pin request and build the pin. Text pins must appear verbatim (whitespace aside) in
 * their source; file pins are resolved now. Throws `PinError` with what to do instead.
 */
export function makePin(req: PinRequest, ctx: PinContext, id: string): Pin {
	const limits = ctx.limits ?? PIN_LIMITS;
	const kind = req.kind as PinKind;
	if (!PIN_KINDS.includes(kind)) throw new PinError(`"kind" must be one of ${PIN_KINDS.join(", ")}.`);
	const at = ctx.now ?? new Date().toISOString();
	if (kind === "file") {
		if (typeof req.ref !== "string") throw new PinError('A file pin needs "ref": "path:start-end".');
		const r = parseRef(req.ref, ctx.cwd);
		const lines = readLines(r.abs);
		if (r.end > lines.length) throw new PinError(`${r.display} has ${lines.length} lines; ${r.start}-${r.end} is out of range.`);
		const n = r.end - r.start + 1;
		if (n > limits.fileLines)
			throw new PinError(`${r.display}:${r.start}-${r.end} is ${n} lines; pin at most ${limits.fileLines}. Pin only the lines you will need again (the definition, the limit, the signature), not the file.`);
		const slice = lines.slice(r.start - 1, r.end);
		const dup = ctx.existing.find((p) => p.file && p.file.path === r.abs && p.file.start <= r.start && r.end <= p.file.end);
		if (dup) throw new PinError(`${r.display}:${r.start}-${r.end} is already pinned as ${dup.id}.`);
		return { id, kind, scope: ctx.scope, text: numbered(slice, r.start), file: { path: r.abs, display: r.display, start: r.start, end: r.end, hash: hashOf(slice.join("\n")) }, at };
	}
	if (typeof req.text !== "string" || !req.text.trim()) throw new PinError(`A ${kind} pin needs "text": the exact words, quoted from its source.`);
	const text = req.text.trim();
	if (text.length > limits.textChars) throw new PinError(`The text is ${text.length} characters; pin at most ${limits.textChars}. Quote the one sentence that matters, or pin several short quotes.`);
	if (typeof req.source !== "string" || !req.source.trim()) throw new PinError(`A ${kind} pin needs "source": "user" for the user's words, or "path" / "path:line" for a file.`);
	const source = req.source.trim();
	const want = norm(text);
	if (source === "user") {
		if (ctx.userTexts.some((u) => norm(u) === want)) throw new PinError("That is a whole user message; user messages already stay in context verbatim. Pin only a part of one when it must stay in view.");
		if (!ctx.userTexts.some((u) => norm(u).includes(want))) throw new PinError("That text does not appear in any user message. Pin the user's exact words, not a paraphrase.");
	} else {
		const m = /^(.+?)(?::(\d+))?$/.exec(source)!;
		const abs = path.resolve(ctx.cwd, m[1]);
		const content = norm(readLines(abs).join("\n"));
		if (!content.includes(want)) throw new PinError(`That text does not appear in ${m[1]}. Pin the exact words from the file, not a paraphrase or summary.`);
	}
	const dup = ctx.existing.find((p) => !p.file && norm(p.text) === want);
	if (dup) throw new PinError(`That text is already pinned as ${dup.id}.`);
	return { id, kind, scope: ctx.scope, text, source, at };
}

/** Check that adding `added` keeps every scope within its token cap; throws `PinError` otherwise. */
export function checkCaps(existing: readonly Pin[], added: readonly Pin[], limits: PinLimits = PIN_LIMITS): void {
	const by = new Map<string, number>();
	for (const p of [...existing, ...added]) by.set(p.scope, (by.get(p.scope) ?? 0) + pinTokens(p));
	for (const [scope, tokens] of by) {
		const cap = scope === "session" ? limits.sessionTokens : limits.taskTokens;
		if (tokens > cap && added.some((p) => p.scope === scope))
			throw new PinError(`Pins for ${scope === "session" ? "the session" : `task ${scope}`} would take ${tokens} tokens; the limit is ${cap}. Unpin what you no longer need, or pin shorter excerpts.`);
	}
}

/** Session pins plus pins of the innermost task in progress and its ancestors. */
export function activePins(pins: readonly Pin[], list: TaskList | null): Pin[] {
	const doing = list?.tasks.filter((t) => t.status === "doing") ?? [];
	const inner = doing.find((t) => !doing.some((o) => o.id.startsWith(`${t.id}.`)));
	const open = new Set<string>();
	if (list && inner) for (let id: string | null = inner.id; id; id = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : null) open.add(`${list.slug}/${id}`);
	return pins.filter((p) => p.scope === "session" || open.has(p.scope));
}

/**
 * Re-read a file pin. Returns the updated pin when its lines changed (re-anchored when the same
 * lines moved, else the new content of the range marked changed), or null when nothing changed.
 */
export function refreshFilePin(p: Pin): Pin | null {
	if (!p.file) return null;
	let lines: string[];
	try {
		lines = fs.readFileSync(p.file.path, "utf8").split("\n");
	} catch {
		return p.changed && p.text.startsWith("(file gone)") ? null : { ...p, changed: true, text: `(file gone)\n${p.text}` };
	}
	const { start, end } = p.file;
	const slice = lines.slice(start - 1, end);
	if (hashOf(slice.join("\n")) === p.file.hash) return null;
	const old = p.text.split("\n").map((l) => l.replace(/^\s*\d+ │ /, ""));
	const n = old.length;
	for (let i = 0; i + n <= lines.length; i++) {
		if (lines.slice(i, i + n).join("\n") === old.join("\n")) {
			return { ...p, changed: false, text: numbered(old, i + 1), file: { ...p.file, start: i + 1, end: i + n } };
		}
	}
	const now = lines.slice(start - 1, Math.min(end, lines.length));
	return { ...p, changed: true, text: numbered(now, start), file: { ...p.file, hash: hashOf(now.join("\n")) } };
}

function label(scope: string, tasks: readonly Task[]): string {
	if (scope === "session") return "session";
	const id = scope.slice(scope.indexOf("/") + 1);
	const t = tasks.find((x) => x.id === id);
	return t ? `${id} ${t.title}` : id;
}

/** The working-set message text, or null when nothing is pinned in scope. */
export function workingSet(active: readonly Pin[], list: TaskList | null): string | null {
	if (!active.length) return null;
	const out = ["[pinned — excerpts you pinned with tasks pin; they stay in view while their scope is active]"];
	const scopes = [...new Set(active.map((p) => p.scope))];
	for (const scope of scopes) {
		out.push(`[${label(scope, list?.tasks ?? [])}]`);
		for (const p of active.filter((x) => x.scope === scope)) {
			if (p.file) out.push(`  ${p.id} file ${p.file.display}:${p.file.start}-${p.file.end}${p.changed ? " (changed since pinned)" : ""}`, ...p.text.split("\n").map((l) => `    ${l}`));
			else out.push(`  ${p.id} ${p.kind} (${p.source}) ${p.text}`);
		}
	}
	return out.join("\n");
}
