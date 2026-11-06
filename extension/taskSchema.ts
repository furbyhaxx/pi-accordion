/*
 * taskSchema.ts — the on-disk task list format (v2: a nested tree) and its validation.
 *
 * The store keeps a list flat in memory (`tasks` ordered by dotted id); files hold the tree. This
 * module converts between the two, migrates v1 files (flat, no goal) and reports every problem in
 * a hand-written file with the fix. It imports nothing, so `node` can load it directly for the
 * `accordion-task-lists` skill's validator script; keep it free of non-erasable TypeScript.
 */

export const TASK_STATUSES = ["todo", "doing", "blocked", "done", "failed", "abandoned"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Why a task cannot continue. */
export const BLOCK_REASONS = ["user-decision", "user-input", "third-party", "dependency"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const LIST_VERSION = 2;
export const SCHEMA_URL = "https://raw.githubusercontent.com/furbyhaxx/pi-accordion/feat/pi-native/extension/skills/accordion-task-lists/references/tasks.schema.json";
/** Deepest task id: `1.2.3.4`. */
export const MAX_DEPTH = 4;
export const TITLE_MAX = 200;
export const GOAL_MAX = 600;
export const CRITERIA_MAX = 3;
export const CRITERION_MAX = 120;

const FINISHED: readonly string[] = ["done", "failed", "abandoned"];

/** Keys a task may carry in a file, besides `subtasks`. */
export const TASK_KEYS = ["id", "title", "status", "acceptanceCriteria", "pins", "attachments", "report", "createdAt", "updatedAt", "startedAt", "endedAt", "autoClosed", "blocks", "supersededBy"] as const;
/** Keys a list file may carry, besides `tasks`. */
export const LIST_KEYS = ["$schema", "version", "slug", "title", "goal", "pins", "attachments", "createdAt", "updatedAt", "claim"] as const;

/** A task as the store holds it: flat, with its dotted id. */
export interface FlatTask {
	id: string;
	title: string;
	status: TaskStatus;
	[key: string]: unknown;
}

/** A list as the store holds it. `goal` is absent only on a migrated v1 list that has not been given one yet. */
export interface FlatList {
	slug: string;
	title: string;
	goal?: string;
	tasks: FlatTask[];
	[key: string]: unknown;
}

export type ParseResult = { ok: true; list: FlatList; migrated: boolean } | { ok: false; errors: string[] };

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
	if (!isObj(raw)) return { ok: false, errors: ["the file must hold one JSON object: { version: 2, slug, title, goal, tasks: [...] }"] };
	if (raw.version === undefined) return parseV1(raw, slug);
	const errors: string[] = [];
	if (raw.version !== LIST_VERSION) errors.push(`version: ${JSON.stringify(raw.version)} is not supported; use ${LIST_VERSION}`);
	for (const k of Object.keys(raw)) if (k !== "tasks" && !(LIST_KEYS as readonly string[]).includes(k)) errors.push(`${k}: unknown field; a list has ${[...LIST_KEYS, "tasks"].join(", ")}`);
	if (raw.slug !== slug) errors.push(`slug: ${JSON.stringify(raw.slug)} must equal the file name "${slug}"`);
	checkTitle(raw.title, "title", errors);
	if (raw.goal === undefined && !requireGoal) {
		/* the store gates new work on a goal */
	} else if (typeof raw.goal !== "string" || !raw.goal.trim()) errors.push('goal: required: the end state this whole list delivers, e.g. "All token access goes through TokenStore; npm test passes."');
	else if (raw.goal.trim().length > GOAL_MAX) errors.push(`goal: ${raw.goal.trim().length} chars; keep it under ${GOAL_MAX}`);
	if (raw.claim !== undefined && raw.claim !== null && !(isObj(raw.claim) && typeof raw.claim.session === "string" && typeof raw.claim.at === "string")) errors.push("claim: must be null or { session, at, name? }; leave it null in a hand-written file");
	checkReferences(raw, "list", errors);
	const tasks: FlatTask[] = [];
	if (!Array.isArray(raw.tasks)) errors.push("tasks: required: an array of { title, subtasks?, acceptanceCriteria? }");
	else walk(raw.tasks, "", "tasks", tasks, errors);
	checkStatusTree(tasks, errors);
	for (const [field, label] of [["pins", "pin"], ["attachments", "attachment"]] as const) {
		const seen = new Set<string>();
		for (const holder of [raw, ...tasks]) {
			const entries = holder[field];
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (!isObj(entry) || typeof entry.id !== "string") continue;
				if (seen.has(entry.id)) errors.push(`duplicate ${label} id ${entry.id}; ids must be unique within the list`);
				seen.add(entry.id);
			}
		}
	}
	if (errors.length) return { ok: false, errors };
	const list: FlatList = { ...withoutKeys(raw, ["$schema", "version", "tasks"]), slug, title: (raw.title as string).trim(), ...(typeof raw.goal === "string" ? { goal: raw.goal.trim() } : {}), tasks } as FlatList;
	return { ok: true, list, migrated: false };
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
	const ids = new Set(tasks.map((t) => t.id));
	for (const t of tasks) {
		const p = parentId(t.id);
		if (p !== null && !ids.has(p)) errors.push(`task ${t.id}: its parent ${p} is missing`);
	}
	if (errors.length) return { ok: false, errors };
	tasks.sort((a, b) => compareIds(a.id, b.id));
	const goal = typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : undefined;
	const rest = withoutKeys(raw, ["tasks", "goal"]);
	return { ok: true, list: { ...rest, slug, title: raw.title as string, ...(goal ? { goal } : {}), tasks } as FlatList, migrated: true };
}

function walk(nodes: unknown[], prefix: string, at: string, out: FlatTask[], errors: string[]): void {
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
		if (node.acceptanceCriteria !== undefined) checkCriteria(node.acceptanceCriteria, `${where}.acceptanceCriteria`, errors);
		checkReferences(node, where, errors);
		if (node.report !== undefined && !(isObj(node.report) && typeof node.report.outcome === "string")) errors.push(`${where}.report: must be { outcome, decisions?, open? }`);
		if (FINISHED.includes(status as string) && !isObj(node.report)) errors.push(`${where}: a ${String(status)} task needs a report { outcome }`);
		if (node.blocks !== undefined && !Array.isArray(node.blocks)) errors.push(`${where}.blocks: must be an array`);
		const task = { ...withoutKeys(node, ["subtasks", "id", "title", "status"]), id, title: typeof node.title === "string" ? node.title.trim() : "", status } as FlatTask;
		out.push(task);
		if (node.subtasks === undefined) return;
		if (!Array.isArray(node.subtasks)) errors.push(`${where}.subtasks: must be an array`);
		else if (node.subtasks.length && id.split(".").length >= MAX_DEPTH) errors.push(`${where}: subtasks would be deeper than ${MAX_DEPTH} levels; flatten the plan`);
		else walk(node.subtasks, id, `${where}.subtasks`, out, errors);
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
			if (!isObj(a) || typeof a.id !== "string" || !/^a[1-9]\d*$/.test(a.id) || typeof a.path !== "string" || !a.path.trim() || (a.lines !== undefined && (typeof a.lines !== "string" || !/^[1-9]\d*(?:-[1-9]\d*)?$/.test(a.lines))) || (a.note !== undefined && (typeof a.note !== "string" || a.note.length > 120)) || (a.hash !== undefined && typeof a.hash !== "string") || (a.at !== undefined && typeof a.at !== "string")) errors.push(`${where}.attachments[${i}]: invalid attachment`);
		});
	}
}

function checkTitle(v: unknown, where: string, errors: string[]): void {
	if (typeof v !== "string" || !v.trim()) errors.push(`${where}: required, a short non-empty title`);
	else if (v.trim().length > TITLE_MAX) errors.push(`${where}: ${v.trim().length} chars; keep it under ${TITLE_MAX} and put detail into subtasks`);
}

/** Problems with an `acceptanceCriteria` value, each prefixed with `where`. */
export function checkCriteria(v: unknown, where: string, errors: string[]): void {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
		errors.push(`${where}: must be 1–${CRITERIA_MAX} non-empty strings`);
		return;
	}
	if (v.length < 1 || v.length > CRITERIA_MAX) errors.push(`${where}: has ${v.length} items; give 1–${CRITERIA_MAX} checkable statements`);
	const long = (v as string[]).find((x) => x.trim().length > CRITERION_MAX);
	if (long) errors.push(`${where}: "${long.slice(0, 40)}…" is ${long.trim().length} chars; keep each under ${CRITERION_MAX}`);
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

/** The v2 file object for a flat list: tasks nested by id, `id`, `title`, `status` first in each task. */
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
	const { slug, title, goal, tasks: _tasks, ...rest } = list;
	return { $schema: SCHEMA_URL, version: LIST_VERSION, slug, title, ...(goal ? { goal } : {}), ...withoutKeys(rest, ["$schema", "version"]), tasks: (kids.get(null) ?? []).map(node) };
}
