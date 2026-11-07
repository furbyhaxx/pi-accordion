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
import { scanTaskSpans, taskKeyOfSummary } from "../../conductors/in-process/taskfold/taskfold";
import { messageKey } from "../../core/groupShape";
import type { TaskList } from "../tasks";
import { spanBlocks, spanContains, taskForest, type TranscriptWorkingSet, type TaskBranch, type TBlock, type TGroup, type Tokens, type TranscriptSource } from "./taskTranscript";

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

/** One block on the wire, optionally paired with its immediately following result. */
export interface DumpBlock {
	kind: "block";
	block: TBlock;
	result: TBlock | null;
	resultWire: string | null;
	folded: boolean;
	code: string | null;
	wire: string;
	tokens: Tokens;
}

/** One actual collapsed run, independent of task ownership. */
export interface DumpGroup {
	kind: "group";
	group: TGroup;
	memberIds: readonly string[];
	wire: string;
	dropped: boolean;
	code: string | null;
	elidedMessages: number;
	tokens: Tokens;
}

/** A task-centred view over disjoint wire carriers. */
export interface DumpTask {
	kind: "task";
	span: TaskSpan;
	folded: boolean;
	code: string | null;
	wire: string;
	elidedMessages: number;
	tokens: Tokens;
	children: DumpNode[];
}

export type DumpLeaf = DumpBlock | DumpGroup;
export type DumpNode = DumpTask | DumpLeaf;

export interface DumpDoc {
	meta: { sessionId: string; model: string };
	system: { tokens: number } | null;
	totals: { full: number; live: number; budget: number };
	generatedAt: string;
	/** Inspection metadata, never counted as model-visible content. */
	metadata: { task_lists: readonly TaskList[]; list_issues: readonly string[]; groups: { id: string; memberIds: readonly string[]; handles?: TGroup["handles"]; folded: boolean }[]; block_details: { id: string; details: unknown }[] };
	workingSet: TranscriptWorkingSet | null;
	orientation: DumpNode[];
	body: DumpNode[];
	tail: DumpNode[];
	/** Actual carrier order, before task-centred rearrangement. */
	wire: DumpLeaf[];
}

export interface DumpInput {
	source: TranscriptSource;
	meta: { sessionId: string; model: string };
	system: { tokens: number } | null;
	totals: { full: number; live: number; budget: number };
	generatedAt: Date;
}

const codeOf = (text: string): string | null => /^\{#([0-9a-z]{6}) FOLDED\}/.exec(text)?.[1] ?? null;
const sumLive = (nodes: readonly DumpNode[]): number => nodes.reduce((n, x) => n + x.tokens.live, 0);
const sumTokens = (nodes: readonly { tokens: Tokens }[]): Tokens => nodes.reduce((n, x) => ({ full: n.full + x.tokens.full, live: n.live + x.tokens.live }), { full: 0, live: 0 });

/** Build the task view and flat wire from the same authoritative, disjoint carrier stream. */
export function dumpDocument(input: DumpInput): DumpDoc {
	const { source } = input;
	const at = new Map(source.blocks.map((b, i) => [b.id, i]));
	const blocks = new Map(source.blocks.map((b) => [b.id, b]));
	const spans = scanTaskSpans(source.blocks, (b) => b.text);
	const tasks = new Map<string, DumpTask>(spans.map((span) => [span.key, {
		kind: "task", span, folded: false, code: null, wire: "", elidedMessages: 0, tokens: { full: 0, live: 0 }, children: [],
	}]));
	const first = spans.length ? Math.min(...spans.map((s) => s.start)) : source.blocks.length;
	const last = spans.length ? Math.max(...spans.map((s) => s.end)) : -1;
	const position = new Map<DumpNode, number>();
	const raw: { node: DumpLeaf; owner: string | null; region: "orientation" | "body" | "tail" }[] = [];
	for (const carrier of source.projection) {
		const block = blocks.get(carrier.members[0].id)!;
		if (block.kind === "system") continue;
		const pos = at.get(block.id)!;
		let owner = spans.filter((s) => spanContains(s, pos)).sort((a, b) => b.key.length - a.key.length)[0]?.key ?? null;
		let node: DumpLeaf;
		const tokens = carrier.members.reduce((n, b) => ({ full: n.full + b.full, live: n.live + b.live }), { full: 0, live: 0 });
		if (carrier.groupId) {
			const group = source.groups.find((g) => g.id === carrier.groupId);
			if (!group) throw new Error(`Projection refers to missing group "${carrier.groupId}".`);
			const key = taskKeyOfSummary(group.summary);
			if (key && tasks.has(key)) owner = key;
			node = { kind: "group", group, memberIds: carrier.members.map((b) => b.id), wire: carrier.text ?? "", dropped: carrier.text === null,
				code: codeOf(carrier.text ?? ""), elidedMessages: new Set(carrier.members.map((b) => messageKey(b.id))).size, tokens };
		} else {
			node = { kind: "block", block, result: null, resultWire: null, folded: !!block.folded, code: block.folded ? codeOf(carrier.text ?? "") : null, wire: carrier.text ?? "", tokens };
		}
		position.set(node, pos);
		raw.push({ node, owner, region: pos < first ? "orientation" : spans.length && pos > last ? "tail" : spans.length ? "body" : "orientation" });
	}
	const entries: typeof raw = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i], next = raw[i + 1];
		if (entry.node.kind === "block" && entry.node.block.kind === "tool_call" && next?.node.kind === "block"
			&& next.node.block.kind === "tool_result" && next.node.block.callId === entry.node.block.callId
			&& next.owner === entry.owner && next.region === entry.region) {
			entry.node.result = next.node.block;
			entry.node.resultWire = next.node.wire;
			entry.node.tokens = sumTokens([entry.node, next.node]);
			i++;
		}
		entries.push(entry);
	}
	const orientation: DumpNode[] = [], body: DumpNode[] = [], tail: DumpNode[] = [];
	for (const { node, owner, region } of entries) {
		if (owner) tasks.get(owner)!.children.push(node);
		else ({ orientation, body, tail })[region].push(node);
	}
	const build = (branch: TaskBranch): DumpTask | null => {
		const task = tasks.get(branch.span.key)!;
		for (const child of branch.children) { const node = build(child); if (node) task.children.push(node); }
		task.children.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
		if (!task.children.length) return null;
		position.set(task, Math.min(...task.children.map((n) => position.get(n)!)));
		task.tokens = sumTokens(task.children);
		const only = task.children.length === 1 ? task.children[0] : undefined;
		if (only?.kind === "group" && !only.dropped && taskKeyOfSummary(only.group.summary) === task.span.key
			&& spanBlocks(source, task.span).every((b) => only.memberIds.includes(b.id))) {
			task.folded = true; task.code = only.code; task.wire = only.wire; task.elidedMessages = only.elidedMessages; task.children = [];
		}
		return task;
	};
	for (const branch of taskForest(spans)) { const node = build(branch); if (node) body.push(node); }
	body.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
	const workingSet = source.workingSet ?? null;
	const transient = workingSet?.applied ? workingSet.tokens : 0;
	const metadata = { task_lists: source.lists ?? [], list_issues: source.listIssues ?? [],
		groups: source.groups.map((g) => ({ id: g.id, memberIds: g.memberIds, ...(g.handles ? { handles: g.handles } : {}), folded: g.folded })),
		block_details: source.blocks.filter((b) => b.details !== undefined).map((b) => ({ id: b.id, details: b.details })) };
	return { meta: input.meta, system: input.system, totals: { ...input.totals, full: input.totals.full + transient, live: input.totals.live + transient }, generatedAt: dumpStamp(input.generatedAt),
		metadata, workingSet, orientation, body, tail, wire: entries.map((e) => e.node) };
}

/* ── shared helpers ─────────────────────────────────────────────────────────── */

const lines = (text: string) => text.split("\n");
const label = (n: DumpBlock) => (n.block.toolName ? `${n.block.kind} ${n.block.toolName}` : n.block.kind);
/** A human-authored digest carries no `{#code FOLDED}` tag, so it has no handle to report. */
const foldMark = (n: DumpNode): string => (n.code ? `FOLDED {#${n.code}}` : "FOLDED (no code)");
const hasMetadata = (doc: DumpDoc): boolean => Object.values(doc.metadata).some((xs) => xs.length > 0);
const workingSetLabel = (ws: TranscriptWorkingSet): string => `working set · transient, not persisted · ${ws.applied ? `appended to ${ws.targetRole}` : "cached, not appended to this snapshot"}`;
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
		if (n.kind === "group") {
			out.push(`${arm}≡ GROUP ${n.group.id} · ${n.tokens.full} → ${n.tokens.live} tok${n.dropped ? " · DROPPED (not sent)" : ""}`);
			graft(out, n.wire, `${pad}┆ `);
			out.push(`${pad}└─ ${n.elidedMessages} messages elided (not on the wire)`);
			return;
		}
		const marks = [n.folded ? foldMark(n) : "", n.block.protected ? "protected" : ""].filter(Boolean).join(" · ");
		out.push(`${arm}${n.block.kind === "user" ? "●" : "·"} ${label(n)}  ·  ${n.tokens.live} tok${marks ? `  ·  ${marks}` : ""}`);
		graft(out, n.wire, `${pad}┆ `);
		if (n.result) graft(out, n.resultWire ?? "", `${pad}┆ → `);
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
	if (doc.workingSet) items.push((pre, last) => {
		out.push(`${pre}${last ? "└─ " : "├─ "}${workingSetLabel(doc.workingSet!)} · ${doc.workingSet!.applied ? doc.workingSet!.tokens : 0} tok`);
		graft(out, doc.workingSet!.text, `${pre}${last ? "   " : "│  "}┆ `);
	});
	if (hasMetadata(doc)) items.push((pre, last) => {
		out.push(`${pre}${last ? "└─ " : "├─ "}metadata (not on wire)`);
		graft(out, JSON.stringify(doc.metadata, null, 2), `${pre}   `);
	});
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
	for (const n of doc.wire) {
		if (n.kind === "group") {
			const key = taskKeyOfSummary(n.group.summary);
			row(key && key !== "untracked" ? "GROUP (task record)" : "GROUP", n.tokens.live, n.wire, n.dropped ? "DROPPED (not sent)" : `${n.elidedMessages} messages elided`);
			continue;
		}
		const turn = `${n.block.turn ?? 0}:`;
		row(`${turn}${label(n)}`, n.block.live, n.wire, marksOf(n));
		if (n.result) row(`${turn}tool_result${n.result.toolName ? ` ${n.result.toolName}` : ""}`, n.result.live, n.resultWire ?? "", n.result.folded ? "FOLDED" : "");
	}
	if (doc.workingSet) row("WORKING SET", doc.workingSet.applied ? doc.workingSet.tokens : 0, doc.workingSet.text, workingSetLabel(doc.workingSet));
	if (hasMetadata(doc)) { out.push("metadata (not on wire)"); graft(out, JSON.stringify(doc.metadata, null, 2), "    "); }
	return out.join("\n");
}

/* ── yaml ──────────────────────────────────────────────────────────────────── */

export function renderYaml(doc: DumpDoc): string {
	const out: string[] = [];
	const block = (key: string, text: string, ind: number): void => {
		if (!text.trim().length) {
			out.push(`${" ".repeat(ind)}${key}: ${JSON.stringify(text)}`);
			return;
		}
		const chomp = text.endsWith("\n\n") ? "+" : text.endsWith("\n") ? "" : "-";
		out.push(`${" ".repeat(ind)}${key}: |2${chomp}`);
		const body = text.endsWith("\n") ? text.slice(0, -1) : text;
		for (const line of lines(body)) out.push(line.length ? `${" ".repeat(ind + 2)}${line}` : "");
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
		if (n.kind === "group") {
			out.push(`${pad}- group: ${quote(n.group.id)}`);
			out.push(`${pad}  tokens: { live: ${n.tokens.live}, full: ${n.tokens.full} }`);
			out.push(`${pad}  dropped: ${n.dropped}`);
			out.push(`${pad}  member_ids: ${JSON.stringify(n.memberIds)}`);
			if (n.code) out.push(`${pad}  code: ${n.code}`);
			block("wire", n.wire, ind + 2);
			out.push(`${pad}  elided_messages: ${n.elidedMessages}`);
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
		if (n.result) block("result", n.resultWire ?? "", ind + 2);
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
	if (doc.workingSet) {
		const ws = doc.workingSet;
		out.push("  working_set:");
		out.push(`    applied: ${ws.applied}`);
		out.push(`    target_role: ${JSON.stringify(ws.targetRole)}`);
		out.push(`    tokens: ${ws.applied ? ws.tokens : 0}`);
		out.push(`    available_tokens: ${ws.tokens}`);
		block("text", ws.text, 4);
	}
	if (hasMetadata(doc)) out.push(`  metadata: ${JSON.stringify(doc.metadata)}`);
	return `${out.join("\n")}\n`;
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
		if (n.kind === "group") {
			out.push(`${ind(d)}<group id="${attr(n.group.id)}" live="${n.tokens.live}" full="${n.tokens.full}" dropped="${n.dropped}" elided="${n.elidedMessages}">`);
			out.push(`${ind(d + 1)}<wire>${cdata(n.wire)}</wire>`);
			out.push(`${ind(d + 1)}<members>${cdata(JSON.stringify(n.memberIds))}</members>`);
			out.push(`${ind(d)}</group>`);
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
		if (n.result) out.push(`${ind(d)}<block kind="tool_result" id="${attr(n.result.id)}" paired="${attr(b.callId ?? "")}">${cdata(n.resultWire ?? "")}</block>`);
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
	if (doc.workingSet) {
		const ws = doc.workingSet;
		out.push(`${ind(1)}<working-set applied="${ws.applied}" target="${ws.targetRole ?? ""}" tokens="${ws.applied ? ws.tokens : 0}" available-tokens="${ws.tokens}">${cdata(ws.text)}</working-set>`);
	}
	if (hasMetadata(doc)) out.push(`${ind(1)}<metadata format="json">${cdata(JSON.stringify(doc.metadata))}</metadata>`);
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
		if (n.kind === "group") {
			out.push(`${"#".repeat(Math.min(6, depth))} GROUP ${n.group.id} · ${n.tokens.live} tok${n.dropped ? " · DROPPED (not sent)" : ""}`);
			block(n.wire);
			out.push(`*${n.elidedMessages} messages elided.*`);
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
			block(n.resultWire ?? "");
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
	if (doc.workingSet) { out.push(`## ${workingSetLabel(doc.workingSet)} · ${doc.workingSet.applied ? doc.workingSet.tokens : 0} tok`); block(doc.workingSet.text); }
	if (hasMetadata(doc)) { out.push("## metadata (not on wire)"); block(JSON.stringify(doc.metadata, null, 2)); }
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
