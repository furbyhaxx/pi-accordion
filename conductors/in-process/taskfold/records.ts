/*
 * records.ts — the JSON carriers Taskfold puts on the wire (SPEC-0002 §6).
 *
 * A carrier is `{#code FOLDED} <one-line JSON>`. The tag is the only handle the model receives, so
 * every task code the agent may recall or unfold appears as a full tag inside the JSON (`recall`).
 * Pure: no Truth, no host.
 */

/** The status a finished task carries. */
export type FinishedStatus = "done" | "failed" | "abandoned";

/** A task's full record (SPEC-0002 §6.2). Key order is the wire order. */
export interface RecordObj {
	task: string;
	title: string;
	status: FinishedStatus;
	/** Fold tag of a child record; the root's code is the leading tag. */
	recall?: string;
	criteria?: string[];
	outcome?: string;
	decisions?: string[];
	open?: string[];
	pins?: { kind: string; text: string; source: string }[];
	/** User messages inside the task whose instructions went into the list: the opening words and where they landed. */
	user?: { said: string; ids: string[] }[];
	changed?: string[];
	verified?: string[];
	children?: (RecordObj | HistoryObj)[];
}

/** A finished task reduced to a few lines (SPEC-0002 §6.3). */
export interface HistoryObj {
	history: string;
	title: string;
	status: FinishedStatus;
	recall?: string;
	subtasks?: Partial<Record<FinishedStatus, number>>;
	outcome?: string;
	/** Verbatim pins of the task and its subtree: a constraint outlives its task. */
	pins?: RecordObj["pins"];
	/** Direct children: id without the list slug → fold tag. */
	children?: Record<string, string>;
}

const LEADING = /^(\{#[0-9a-z]{6} FOLDED\}) (\{.*\})$/s;
const HISTORY_OUTCOME_CHARS = 160;

/** Collapse whitespace and cut to `max` characters. */
export function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const isHistory = (x: RecordObj | HistoryObj): x is HistoryObj => "history" in x;

/** The wire text of a carrier. */
export function render(tag: string, obj: object): string {
	return `${tag} ${JSON.stringify(obj)}`;
}

/** The tag and parsed JSON of a carrier summary, or null when it is not one. */
export function parseCarrier(summary: string | null | undefined): { tag: string; obj: Record<string, unknown> } | null {
	if (typeof summary !== "string") return null;
	const m = LEADING.exec(summary);
	if (!m) return null;
	try {
		const obj: unknown = JSON.parse(m[2]);
		return obj && typeof obj === "object" && !Array.isArray(obj) ? { tag: m[1], obj: obj as Record<string, unknown> } : null;
	} catch {
		return null;
	}
}

/** The `<list>/<id>` key of a Taskfold record, history or part carrier, or `"untracked"`; null for any other summary. */
export function taskKeyOfSummary(summary: string | null | undefined): string | null {
	const c = parseCarrier(summary);
	if (!c) return null;
	for (const k of ["task", "history", "part"] as const) if (typeof c.obj[k] === "string") return c.obj[k] as string;
	return typeof c.obj.untracked === "string" ? "untracked" : null;
}

/** How a task carrier reads: a full record or a one-line history entry; null for parts, untracked runs and foreign summaries. */
export function recordForm(summary: string | null | undefined): "record" | "history" | null {
	const o = parseCarrier(summary)?.obj;
	return o?.history !== undefined ? "history" : o?.task !== undefined ? "record" : null;
}

/** True for a history carrier (the task's whole subtree is one short entry). */
export function isHistoryCarrier(summary: string | null | undefined): boolean {
	return parseCarrier(summary)?.obj.history !== undefined;
}

/** The marker on every run of a split span except the last, which carries the record. */
export function partCarrier(tag: string, key: string, index: number, of: number): string {
	return render(tag, { part: key, of: [index, of] });
}

/** An untracked-work carrier: a run outside every task span. */
export function untrackedCarrier(tag: string, label: string, changed: readonly string[], verified: readonly string[]): string {
	return render(tag, { untracked: label, ...(changed.length ? { changed: changed.slice(0, 20) } : {}), ...(verified.length ? { verified: verified.slice(-5) } : {}) });
}

/** Counts of finished descendants (not the node itself). */
function descendants(node: RecordObj | HistoryObj): Partial<Record<FinishedStatus, number>> {
	const out: Partial<Record<FinishedStatus, number>> = {};
	const add = (s: FinishedStatus, n = 1) => { out[s] = (out[s] ?? 0) + n; };
	if (isHistory(node)) {
		for (const [s, n] of Object.entries(node.subtasks ?? {})) add(s as FinishedStatus, n);
		return out;
	}
	for (const child of node.children ?? []) {
		add(child.status);
		for (const [s, n] of Object.entries(descendants(child))) add(s as FinishedStatus, n);
	}
	return out;
}

/** The local id a history lists a child under: the key without its list slug. */
const localId = (key: string): string => key.slice(key.indexOf("/") + 1);

function subtreePins(node: RecordObj | HistoryObj): NonNullable<RecordObj["pins"]> {
	const all = [...(node.pins ?? []), ...(isHistory(node) ? [] : (node.children ?? []).flatMap(subtreePins))];
	return [...new Map(all.map((p) => [`${p.kind}\u0000${p.text}`, p])).values()];
}

/** One task and its subtree as a history entry. A record's children become `children` codes; counts stay truthful. */
export function toHistory(node: RecordObj | HistoryObj): HistoryObj {
	if (isHistory(node)) return node;
	const counts = descendants(node);
	const direct = Object.fromEntries((node.children ?? []).flatMap((c) => (c.recall ? [[localId(isHistory(c) ? c.history : c.task), c.recall] as const] : [])));
	return {
		history: node.task,
		title: node.title,
		status: node.status,
		...(node.recall ? { recall: node.recall } : {}),
		...(Object.keys(counts).length ? { subtasks: counts } : {}),
		...(node.outcome ? { outcome: oneLine(node.outcome, HISTORY_OUTCOME_CHARS) } : {}),
		...(subtreePins(node).length ? { pins: subtreePins(node) } : {}),
		...(Object.keys(direct).length ? { children: direct } : {}),
	};
}

/** Replace the first of the deepest remaining full child records by its history entry. Returns false when none is left. */
export function shrinkDeepest(root: RecordObj): boolean {
	let best: { parent: RecordObj; index: number; depth: number } | null = null;
	const walk = (node: RecordObj, depth: number) => {
		(node.children ?? []).forEach((child, index) => {
			if (isHistory(child)) return;
			if (!best || depth > best.depth) best = { parent: node, index, depth };
			walk(child, depth + 1);
		});
	};
	walk(root, 1);
	const hit = best as { parent: RecordObj; index: number } | null;
	if (!hit) return false;
	hit.parent.children![hit.index] = toHistory(hit.parent.children![hit.index]);
	return true;
}

/** The record parsed from an earlier carrier of the same task, carrying its leading tag as `recall`; null for other shapes. */
export function priorEntry(summary: string): RecordObj | HistoryObj | null {
	const c = parseCarrier(summary);
	if (!c || typeof c.obj.part === "string" || typeof c.obj.untracked === "string") return null;
	if (typeof c.obj.task !== "string" && typeof c.obj.history !== "string") return null;
	const entries = Object.entries(c.obj).filter(([k]) => k !== "recall");
	return Object.fromEntries([...entries.slice(0, 3), ["recall", c.tag], ...entries.slice(3)]) as unknown as RecordObj | HistoryObj;
}

/** Every handle tag a carrier text shows. */
export function visibleTags(text: string): Set<string> {
	return new Set(text.match(/\{#[0-9a-z]{6} FOLDED\}/g) ?? []);
}
