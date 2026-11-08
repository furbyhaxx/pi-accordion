/*
 * taskSchema.ts — the on-disk task list format (v3: a nested tree with goal and criterion items) and its validation.
 *
 * The store keeps a list flat in memory (`tasks` ordered by dotted id); files hold the tree. This
 * module converts between the two, migrates v1 (flat, one goal string) and v2 (one goal string,
 * string criteria) files, and reports every problem in
 * a hand-written file with the fix. It imports nothing, so `node` can load it directly for the
 * `accordion-task-lists` skill's validator script; keep it free of non-erasable TypeScript.
 */

export const TASK_STATUSES = ["todo", "doing", "blocked", "done", "failed", "abandoned"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Why a task cannot continue. */
export const BLOCK_REASONS = ["user-decision", "user-input", "third-party", "dependency"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const LIST_VERSION = 3;
export const SCHEMA_URL = "https://raw.githubusercontent.com/furbyhaxx/pi-accordion/feat/pi-native/extension/skills/accordion-task-lists/references/tasks.schema.json";
export const TITLE_MAX = 200;
export const GOAL_MAX = 600;
export const GOALS_MAX = 5;
export const TASK_GOAL_MAX = 300;
export const TASK_GOALS_MAX = 3;
export const CRITERIA_MAX = 8;
export const CRITERION_MAX = 120;

/** A goal or acceptance criterion: text with a list-unique id the agent and records refer to. */
export interface Item {
	id: string;
	text: string;
}
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** An attachment anchor is exactly one of a section path, a symbol or a quote with its context. */
function validAnchor(a: unknown): boolean {
	if (!isObj(a)) return false;
	const keys = Object.keys(a);
	if (keys.length !== 1) return false;
	if (keys[0] === "section" || keys[0] === "symbol") return isText(a[keys[0]]);
	const q = a.quote;
	return keys[0] === "quote" && isObj(q) && isText(q.exact) && typeof q.prefix === "string" && typeof q.suffix === "string" && typeof q.start === "number" && Number.isInteger(q.start) && q.start >= 0;
}

/** Item id prefixes: goals, criteria, pins, attachments. */
export const ITEM_PREFIXES = ["g", "c", "p", "a"] as const;
export type ItemPrefix = (typeof ITEM_PREFIXES)[number];
/** The last number used per item prefix; ids are never reused after removal. */
export type ItemSeq = Partial<Record<ItemPrefix, number>>;

const FINISHED: readonly string[] = ["done", "failed", "abandoned"];

/** Keys a task may carry in a file, besides `subtasks`. */
export const TASK_KEYS = ["id", "title", "status", "goals", "acceptanceCriteria", "pins", "attachments", "report", "createdAt", "updatedAt", "startedAt", "endedAt", "autoClosed", "blocks", "supersededBy"] as const;
/** Keys a list file may carry, besides `tasks`. */
export const LIST_KEYS = ["$schema", "version", "slug", "title", "goals", "seq", "pins", "attachments", "createdAt", "updatedAt", "claim"] as const;

/** A task as the store holds it: flat, with its dotted id. */
export interface FlatTask {
	id: string;
	title: string;
	status: TaskStatus;
	[key: string]: unknown;
}

/** A list as the store holds it. `goals` is absent or empty only on a migrated list that has not been given one yet. */
export interface FlatList {
	slug: string;
	title: string;
	goals?: Item[];
	seq: ItemSeq;
	tasks: FlatTask[];
	[key: string]: unknown;
}

/** `migratedFrom` names the file version the list was converted from (1 or 2); absent for a v3 file. */
export type ParseResult = { ok: true; list: FlatList; migratedFrom?: 1 | 2 } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Order ids numerically per segment, so `1.10` follows `1.9`. */
export function compareIds(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? -1) - (pb[i] ?? -1);
		if (d) return d;
	}
	return 0;
}

export function parentId(id: string): string | null {
	const dot = id.lastIndexOf(".");
	return dot < 0 ? null : id.slice(0, dot);
}

/**
 * Validate a parsed list file and return the flat list. `slug` is the file's name; a v1 file is
 * migrated in memory (the caller writes v2 on its next write). The store loads lists without a
 * goal (`requireGoal: false`, from v1 or the UI) and refuses new work on them instead; authoring
 * checks require it.
 */
export function parseListFile(raw: unknown, slug: string, options: { requireGoal?: boolean } = {}): ParseResult {
	const requireGoal = options.requireGoal ?? true;
	if (!isObj(raw)) return { ok: false, errors: ["the file must hold one JSON object: { version: 3, slug, title, goals, tasks: [...] }"] };
	if (raw.version === undefined) return parseV1(raw, slug);
	if (raw.version === 2) {
		const upgraded = upgradeV2(raw);
		const parsed = parseListFile(upgraded, slug, options);
		return parsed.ok ? { ...parsed, migratedFrom: 2 } : parsed;
	}
	const errors: string[] = [];
	if (raw.version !== LIST_VERSION) errors.push(`version: ${JSON.stringify(raw.version)} is not supported; use ${LIST_VERSION}`);
	for (const k of Object.keys(raw)) if (k !== "tasks" && !(LIST_KEYS as readonly string[]).includes(k)) errors.push(`${k}: unknown field; a list has ${[...LIST_KEYS, "tasks"].join(", ")}`);
	if (raw.slug !== slug) errors.push(`slug: ${JSON.stringify(raw.slug)} must equal the file name "${slug}"`);
	checkTitle(raw.title, "title", errors);
	const ids = new IdAllocator(raw.seq, errors);
	const goals = raw.goals === undefined && !requireGoal ? undefined : checkItems(raw.goals, "goals", "g", requireGoal ? 1 : 0, GOALS_MAX, GOAL_MAX, ids, errors, 'the end state this whole list delivers, e.g. ["All token access goes through TokenStore.", "npm test passes."]');
	if (raw.claim !== undefined && raw.claim !== null && !(isObj(raw.claim) && typeof raw.claim.session === "string" && typeof raw.claim.at === "string")) errors.push("claim: must be null or { session, at, name? }; leave it null in a hand-written file");
	checkReferences(raw, "list", errors);
	const tasks: FlatTask[] = [];
	if (!Array.isArray(raw.tasks)) errors.push("tasks: required: an array of { title, subtasks?, acceptanceCriteria? }");
	else walk(raw.tasks, "", "tasks", tasks, errors, ids);
	checkStatusTree(tasks, errors);
	for (const [field, prefix] of [["pins", "p"], ["attachments", "a"]] as const)
		for (const holder of [raw, ...tasks]) {
			const entries = holder[field];
			if (Array.isArray(entries)) for (const entry of entries) if (isObj(entry) && typeof entry.id === "string") ids.claim(prefix, entry.id, field);
		}
	ids.assign();
	if (errors.length) return { ok: false, errors };
	const list: FlatList = { ...withoutKeys(raw, ["$schema", "version", "tasks", "goals", "seq"]), slug, title: (raw.title as string).trim(), ...(goals ? { goals } : {}), seq: ids.seq, tasks } as FlatList;
	return { ok: true, list };
}

/** A v2 file as v3: one goal string becomes the goal list, string criteria become items without ids. */
function upgradeV2(raw: Record<string, unknown>): Record<string, unknown> {
	const task = (node: unknown): unknown => {
		if (!isObj(node)) return node;
		return { ...node, ...(Array.isArray(node.subtasks) ? { subtasks: node.subtasks.map(task) } : {}) };
	};
	const { goal, ...rest } = raw;
	return { ...rest, version: LIST_VERSION, ...(typeof goal === "string" && goal.trim() ? { goals: [goal] } : goal === undefined ? {} : { goals: [goal] }), tasks: Array.isArray(raw.tasks) ? raw.tasks.map(task) : raw.tasks };
}

/**
 * Assigns list-unique item ids. Explicit ids are claimed first, then authored plain strings get the
 * next free number per prefix, above both every claimed id and the file's recorded `seq`.
 */
class IdAllocator {
	readonly seq: ItemSeq = {};
	private readonly taken = new Set<string>();
	private readonly pending: { prefix: ItemPrefix; item: Item }[] = [];
	private readonly errors: string[];
	constructor(seq: unknown, errors: string[]) {
		this.errors = errors;
		if (seq === undefined) return;
		if (!isObj(seq) || Object.entries(seq).some(([k, v]) => !(ITEM_PREFIXES as readonly string[]).includes(k) || !Number.isInteger(v) || (v as number) < 0)) {
			errors.push('seq: must be { g?, c?, p?, a? } with non-negative integers; remove it to let the store recompute it');
			return;
		}
		Object.assign(this.seq, seq);
	}
	claim(prefix: ItemPrefix, id: string, where: string): void {
		const n = new RegExp(`^${prefix}([1-9]\\d*)$`).exec(id)?.[1];
		if (!n) this.errors.push(`${where}: id ${JSON.stringify(id)} must look like ${prefix}1, ${prefix}2, …; omit it to let the store assign one`);
		else if (this.taken.has(id)) this.errors.push(`duplicate id ${id}; item ids must be unique within the list`);
		else {
			this.taken.add(id);
			this.seq[prefix] = Math.max(this.seq[prefix] ?? 0, Number(n));
		}
	}
	later(prefix: ItemPrefix, item: Item): void {
		this.pending.push({ prefix, item });
	}
	assign(): void {
		for (const { prefix, item } of this.pending) item.id = `${prefix}${(this.seq[prefix] = (this.seq[prefix] ?? 0) + 1)}`;
	}
}

/** Validated items from authored strings or `{id?, text}` objects; ids are assigned by `ids.assign()`. */
function checkItems(v: unknown, where: string, prefix: ItemPrefix, min: number, max: number, maxChars: number, ids: IdAllocator, errors: string[], hint: string): Item[] | undefined {
	if (v === undefined && min === 0) return undefined;
	if (!Array.isArray(v)) {
		errors.push(`${where}: required: ${hint}`);
		return undefined;
	}
	if (v.length < min || v.length > max) errors.push(`${where}: has ${v.length} items; give ${min}–${max}`);
	const items: Item[] = [];
	v.forEach((x: unknown, i: number) => {
		const text = typeof x === "string" ? x : isObj(x) && typeof x.text === "string" ? x.text : null;
		if (text === null || !text.trim() || (isObj(x) && Object.keys(x).some((k) => k !== "id" && k !== "text"))) {
			errors.push(`${where}[${i}]: must be a non-empty string or { id?, text }`);
			return;
		}
		if (text.trim().length > maxChars) errors.push(`${where}[${i}]: "${text.trim().slice(0, 40)}…" is ${text.trim().length} chars; keep it under ${maxChars}`);
		const item: Item = { id: "", text: text.trim() };
		if (isObj(x) && x.id !== undefined) {
			if (typeof x.id !== "string") errors.push(`${where}[${i}].id: must be a string`);
			else {
				ids.claim(prefix, x.id, `${where}[${i}]`);
				item.id = x.id;
			}
		} else ids.later(prefix, item);
		items.push(item);
	});
	return items;
}

function parseV1(raw: Record<string, unknown>, slug: string): ParseResult {
	const errors: string[] = [];
	if (raw.slug !== slug) errors.push(`slug: ${JSON.stringify(raw.slug)} must equal the file name "${slug}"`);
	if (typeof raw.title !== "string") errors.push("title: required");
	if (!Array.isArray(raw.tasks)) errors.push("tasks: required");
	const tasks: FlatTask[] = [];
	if (Array.isArray(raw.tasks))
		raw.tasks.forEach((t, i) => {
			if (!isObj(t) || typeof t.id !== "string" || !/^[1-9]\d*(\.[1-9]\d*)*$/.test(t.id) || typeof t.title !== "string" || !(TASK_STATUSES as readonly string[]).includes(t.status as string))
				errors.push(`tasks[${i}]: a v1 task needs a dotted id, a title and a status`);
			else tasks.push({ ...t } as FlatTask);
		});
	const known = new Set(tasks.map((t) => t.id));
	for (const t of tasks) {
		const p = parentId(t.id);
		if (p !== null && !known.has(p)) errors.push(`task ${t.id}: its parent ${p} is missing`);
	}
	if (errors.length) return { ok: false, errors };
	tasks.sort((a, b) => compareIds(a.id, b.id));
	const ids = new IdAllocator(undefined, errors);
	for (const t of tasks) {
		if (Array.isArray(t.acceptanceCriteria)) t.acceptanceCriteria = (t.acceptanceCriteria as unknown[]).filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => {
			const item: Item = { id: "", text: c.trim() };
			ids.later("c", item);
			return item;
		});
		for (const [field, prefix] of [["pins", "p"], ["attachments", "a"]] as const) {
			const entries = t[field];
			if (Array.isArray(entries)) for (const e of entries) if (isObj(e) && typeof e.id === "string") ids.claim(prefix, e.id, `task ${t.id}.${field}`);
		}
	}
	const goal = typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : undefined;
	const goals = goal ? [{ id: "", text: goal }] : undefined;
	if (goals) ids.later("g", goals[0]);
	ids.assign();
	if (errors.length) return { ok: false, errors };
	const rest = withoutKeys(raw, ["tasks", "goal"]);
	return { ok: true, list: { ...rest, slug, title: raw.title as string, ...(goals ? { goals } : {}), seq: ids.seq, tasks } as FlatList, migratedFrom: 1 };
}

function walk(nodes: unknown[], prefix: string, at: string, out: FlatTask[], errors: string[], ids: IdAllocator): void {
	nodes.forEach((node, i) => {
		const where = `${at}[${i}]`;
		const id = prefix ? `${prefix}.${i + 1}` : String(i + 1);
		if (!isObj(node)) {
			errors.push(`${where}: must be an object { title, subtasks?, acceptanceCriteria? }`);
			return;
		}
		for (const k of Object.keys(node)) if (k !== "subtasks" && !(TASK_KEYS as readonly string[]).includes(k)) errors.push(`${where}.${k}: unknown field; a task has ${[...TASK_KEYS, "subtasks"].join(", ")}`);
		if (node.id !== undefined && node.id !== id) errors.push(`${where}: id ${JSON.stringify(node.id)} does not match its position ${id}; remove the id or move the task`);
		checkTitle(node.title, `${where}.title`, errors);
		const status = node.status ?? "todo";
		if (!(TASK_STATUSES as readonly string[]).includes(status as string)) errors.push(`${where}.status: ${JSON.stringify(node.status)} is not one of ${TASK_STATUSES.join(", ")}`);
		const goals = checkItems(node.goals, `${where}.goals`, "g", 0, TASK_GOALS_MAX, TASK_GOAL_MAX, ids, errors, "");
		const criteria = checkItems(node.acceptanceCriteria, `${where}.acceptanceCriteria`, "c", 0, CRITERIA_MAX, CRITERION_MAX, ids, errors, "");
		checkReferences(node, where, errors);
		if (node.report !== undefined && !(isObj(node.report) && typeof node.report.outcome === "string")) errors.push(`${where}.report: must be { outcome, decisions?, open? }`);
		if (FINISHED.includes(status as string) && !isObj(node.report)) errors.push(`${where}: a ${String(status)} task needs a report { outcome }`);
		if (node.blocks !== undefined && !Array.isArray(node.blocks)) errors.push(`${where}.blocks: must be an array`);
		const task = { ...withoutKeys(node, ["subtasks", "id", "title", "status", "goals", "acceptanceCriteria"]), id, title: typeof node.title === "string" ? node.title.trim() : "", status, ...(goals?.length ? { goals } : {}), ...(criteria?.length ? { acceptanceCriteria: criteria } : {}) } as FlatTask;
		out.push(task);
		if (node.subtasks === undefined) return;
		if (!Array.isArray(node.subtasks)) errors.push(`${where}.subtasks: must be an array`);
		else walk(node.subtasks, id, `${where}.subtasks`, out, errors, ids);
	});
}

function checkReferences(node: Record<string, unknown>, where: string, errors: string[]): void {
	if (node.pins !== undefined) {
		if (!Array.isArray(node.pins)) errors.push(`${where}.pins: must be an array`);
		else node.pins.forEach((p: unknown, i: number) => {
			if (!isObj(p) || typeof p.id !== "string" || !/^p[1-9]\d*$/.test(p.id) || !["rule", "convention", "constraint", "standard", "fact"].includes(String(p.kind)) || typeof p.text !== "string" || !p.text.trim() || p.text.length > 300 || typeof p.source !== "string" || !p.source.trim() || typeof p.at !== "string") errors.push(`${where}.pins[${i}]: invalid pin`);
		});
	}
	if (node.attachments !== undefined) {
		if (!Array.isArray(node.attachments)) errors.push(`${where}.attachments: must be an array`);
		else node.attachments.forEach((a: unknown, i: number) => {
			if (!isObj(a) || typeof a.id !== "string" || !/^a[1-9]\d*$/.test(a.id) || typeof a.path !== "string" || !a.path.trim() || (a.lines !== undefined && (typeof a.lines !== "string" || !/^[1-9]\d*(?:-[1-9]\d*)?$/.test(a.lines))) || (a.anchor !== undefined && !validAnchor(a.anchor)) || (a.note !== undefined && (typeof a.note !== "string" || a.note.length > 120)) || (a.hash !== undefined && typeof a.hash !== "string") || (a.at !== undefined && typeof a.at !== "string")) errors.push(`${where}.attachments[${i}]: invalid attachment`);
		});
	}
}

function checkTitle(v: unknown, where: string, errors: string[]): void {
	if (typeof v !== "string" || !v.trim()) errors.push(`${where}: required, a short non-empty title`);
	else if (v.trim().length > TITLE_MAX) errors.push(`${where}: ${v.trim().length} chars; keep it under ${TITLE_MAX} and put detail into subtasks`);
}

/** Problems with authored item texts (goals or criteria given to the tool), each prefixed with `where`. */
export function checkTexts(v: unknown, where: string, max: number, maxChars: number, errors: string[]): void {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
		errors.push(`${where}: must be 1–${max} non-empty strings`);
		return;
	}
	if (v.length < 1 || v.length > max) errors.push(`${where}: has ${v.length} items; give 1–${max}`);
	const long = (v as string[]).find((x) => x.trim().length > maxChars);
	if (long) errors.push(`${where}: "${long.slice(0, 40)}…" is ${long.trim().length} chars; keep each under ${maxChars}`);
}

/** Problems with an authored `acceptanceCriteria` value. */
export function checkCriteria(v: unknown, where: string, errors: string[]): void {
	checkTexts(v, where, CRITERIA_MAX, CRITERION_MAX, errors);
}

/** A started task's ancestors must have started too; an unfinished task cannot sit under a finished parent unless the parent failed or was abandoned. */
function checkStatusTree(tasks: readonly FlatTask[], errors: string[]): void {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	for (const t of tasks) {
		const p = parentId(t.id);
		const parent = p === null ? undefined : byId.get(p);
		if (!parent) continue;
		if (t.status !== "todo" && parent.status === "todo") errors.push(`task ${t.id} is ${t.status} but its parent ${parent.id} is todo; a parent starts with its first subtask`);
		if (parent.status === "done" && !FINISHED.includes(t.status)) errors.push(`task ${t.id} is ${t.status} but its parent ${parent.id} is done; finish or abandon it, or reopen the parent`);
	}
}

function withoutKeys(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
	return out;
}

/** The v3 file object for a flat list: tasks nested by id, `id`, `title`, `status` first in each task. */
export function toListFile(list: FlatList): Record<string, unknown> {
	const sorted = [...list.tasks].sort((a, b) => compareIds(a.id, b.id));
	const kids = new Map<string | null, FlatTask[]>();
	for (const t of sorted) {
		const p = parentId(t.id);
		const arr = kids.get(p);
		if (arr) arr.push(t);
		else kids.set(p, [t]);
	}
	const node = (t: FlatTask): Record<string, unknown> => {
		const { id, title, status, ...rest } = t;
		const subs = kids.get(id);
		return { id, title, status, ...rest, ...(subs?.length ? { subtasks: subs.map(node) } : {}) };
	};
	const { slug, title, goals, seq, tasks: _tasks, ...rest } = list;
	return { $schema: SCHEMA_URL, version: LIST_VERSION, slug, title, ...(goals?.length ? { goals } : {}), seq, ...withoutKeys(rest, ["$schema", "version"]), tasks: (kids.get(null) ?? []).map(node) };
}
