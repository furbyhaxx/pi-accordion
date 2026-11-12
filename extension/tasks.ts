/*
 * tasks.ts — persistent, project-scoped task lists for the `tasks` tool.
 *
 * One list per file at `<project>/.pig/tasks/<slug>.json`, stored as a nested tree (format and
 * validation in `taskSchema.ts`) and held flat in memory, ordered by dotted id. The file is the
 * authority for structure, status and claims; the session transcript only carries the tool calls
 * and their results, which is what the Taskfold conductor reads to find task spans. Ids of started
 * tasks never change: spans, records and folds refer to them. Only unstarted tasks renumber.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCK_REASONS, checkReport, checkTexts, compareIds, CRITERIA_MAX, CRITERION_MAX, GOAL_MAX, GOALS_MAX, parentId, parseListFile, REPORT_OUTCOME_MAX as OUTCOME_MAX, TITLE_MAX, TASK_GOAL_MAX, TASK_GOALS_MAX, toListFile, type BlockReason, type FlatList, type Item, type ItemPrefix, type ItemSeq, type TaskStatus } from "./taskSchema";
import type { Anchor } from "./taskAnchors";
import { attachmentRef, checkPinCap, makeAttachment, makePin, PIN_LIMITS, type Attachment, type Pin, type PinHolder, type PinLimits } from "./taskPins";

export { BLOCK_REASONS, type BlockReason, type TaskStatus };

/** Block reasons outside the agent's control: waiting on them justifies going idle. `dependency` does not. */
export const IDLE_REASONS: ReadonlySet<BlockReason> = new Set(["user-decision", "user-input", "third-party"]);

/** One period a task spent blocked. */
export interface TaskBlock {
	reason: BlockReason;
	detail: string;
	/** The task this one waits for (`dependency`), or the subtask a blocked parent waits for. */
	on?: string;
	at: string;
	/** When the task was resumed; absent while it is still blocked. */
	resumedAt?: string;
}

/** What the agent reports when a task ends; it becomes the agent-written part of the fold record. */
export interface TaskReport {
	outcome: string;
	decisions?: string[];
	open?: string[];
}

export interface Task {
	/** Dotted path within the list: `1`, `1.2`, `1.2.1`. */
	id: string;
	title: string;
	status: TaskStatus;
	/** What this subtree must achieve beyond its criteria. */
	goals?: Item[];
	/** Checkable statements that are true when the task is finished. */
	acceptanceCriteria?: Item[];
	pins?: Pin[];
	attachments?: Attachment[];
	report?: TaskReport;
	updatedAt: string;
	/** When the task was planned (absent on tasks planned before this was recorded). */
	createdAt?: string;
	/** When the task was started; absent for tasks never started (or written before timing existed). */
	startedAt?: string;
	/** When the task was completed, failed or abandoned. */
	endedAt?: string;
	/** Set when the store closed this parent itself because the agent moved on after its last subtask. */
	autoClosed?: boolean;
	/** Every period the task was blocked, oldest first; the last one is open while `status` is `blocked`. */
	blocks?: TaskBlock[];
	/** The task that replaces this abandoned one. */
	supersededBy?: string;
}

export interface TaskClaim {
	session: string;
	at: string;
	/** The claiming session's display name, when it had one. */
	name?: string;
}

export interface TaskList {
	slug: string;
	title: string;
	/** Together, the end state the whole list delivers. Absent or empty only on a migrated list that has not been given one. */
	goals?: Item[];
	/** The last number used per item id prefix, so removed ids are never reused. */
	seq: ItemSeq;
	pins?: Pin[];
	attachments?: Attachment[];
	createdAt: string;
	updatedAt: string;
	claim: TaskClaim | null;
	tasks: Task[];
}

/** A task as the agent writes it in `create` / `add`. */
export interface TaskInput {
	title: string;
	goals?: string[];
	acceptanceCriteria?: string[];
	pins?: unknown[];
	attachments?: unknown[];
	subtasks?: TaskInput[];
	/** For `add`: the id of an earlier task this one replaces; that task is abandoned if it is still open. */
	supersedes?: string;
}

/** A rejected call: the message tells the agent how to recover. */
/** Why a `tasks` call was refused (SPEC-0002 §3.2). */
export type TaskErrorCode = "invalid_args" | "not_found" | "invalid_file" | "no_goal" | "claimed_by_other" | "frozen" | "invalid_transition" | "open_subtasks" | "empty_span" | "cap_exceeded" | "quote_mismatch";

/** A refused `tasks` call; `message` says what went wrong and how to proceed. */
export class TaskError extends Error {
	constructor(readonly code: TaskErrorCode, message: string) {
		super(message);
	}

	/** The result text the model sees: `{"ok":false,"error":…,"message":…}`. */
	toResult(): string {
		return JSON.stringify({ ok: false, error: this.code, message: this.message });
	}
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BLOCK_DETAIL_MAX = 1024;
/** A claim not refreshed for this long may be taken over without `force`. */
export const CLAIM_STALE_MS = 30 * 60_000;

/** A list file may be a symlink to a file kept elsewhere, e.g. next to its plan; writes replace the target, never the link. */
function writeTarget(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		// A new list, or a link whose target does not exist yet.
	}
	try {
		return path.resolve(path.dirname(file), fs.readlinkSync(file));
	} catch {
		return file;
	}
}

export function tasksDir(projectDir: string): string {
	return path.join(projectDir, ".pig", "tasks");
}

function now(): string {
	return new Date().toISOString();
}

function assertSlug(slug: unknown): string {
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new TaskError("invalid_args", `Invalid list slug ${JSON.stringify(slug)}: use lowercase letters, digits and dashes, e.g. "auth-refactor".`);
	return slug;
}

function cleanTitle(title: unknown): string {
	if (typeof title !== "string" || !title.trim()) throw new TaskError("invalid_args", "Every task needs a non-empty title.");
	const t = title.trim().replace(/\s+/g, " ");
	if (t.length > TITLE_MAX) throw new TaskError("invalid_args", `Task title too long (${t.length} > ${TITLE_MAX} chars): "${t.slice(0, 60)}…". Keep titles short; put detail in subtasks.`);
	return t;
}

/** Validate a report against the record's field budget; over-budget reports are rejected, not cut. */
export function cleanReport(report: unknown): TaskReport {
	const errors: string[] = [];
	const clean = checkReport(report, "report", errors);
	if (errors.length) throw new TaskError("invalid_args", errors.join("; "));
	return clean;
}

/** Item texts as given in `create`/`add`/`update`: a non-empty array of strings within the limits. */
function cleanTexts(v: unknown, where: string, max: number, maxChars: number): string[] {
	const errors: string[] = [];
	checkTexts(v, where, max, maxChars, errors);
	if (errors.length) throw new TaskError("invalid_args", `${errors.join("; ")}.`);
	return (v as string[]).map((x) => x.trim().replace(/\s+/g, " "));
}

const GOALS_HINT = 'e.g. goals: ["All token access goes through TokenStore.", "npm test passes."]';
const listGoals = (v: unknown): string[] => {
	if (v === undefined || (Array.isArray(v) && !v.length)) throw new TaskError("invalid_args", `A list needs "goals": together the end state the whole list delivers, ${GOALS_HINT}.`);
	return cleanTexts(v, "goals", GOALS_MAX, GOAL_MAX);
};
const taskGoals = (v: unknown, title: string) => cleanTexts(v, `goals of "${title}"`, TASK_GOALS_MAX, TASK_GOAL_MAX);
const criteriaOf = (v: unknown, title: string) => cleanTexts(v, `acceptanceCriteria of "${title}"`, CRITERIA_MAX, CRITERION_MAX);

/**
 * The next free id for `prefix` in this list: above the recorded `seq` and every id present, so a
 * removed id is never handed out again. Advances `list.seq`.
 */
export function allocateId(list: Pick<TaskList, "seq" | "goals" | "pins" | "attachments" | "tasks">, prefix: ItemPrefix): string {
	let n = list.seq[prefix] ?? 0;
	const scan = (items: readonly { id: string }[] | undefined) => {
		for (const x of items ?? []) {
			const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id);
			if (m) n = Math.max(n, Number(m[1]));
		}
	};
	const field = { g: "goals", c: "acceptanceCriteria", p: "pins", a: "attachments" } as const;
	scan((list as Record<string, unknown>)[field[prefix]] as { id: string }[] | undefined);
	for (const t of list.tasks) scan(t[field[prefix]] as { id: string }[] | undefined);
	list.seq[prefix] = n + 1;
	return `${prefix}${n + 1}`;
}

/** Give new tasks' goals and criteria their ids, in document order, once the tasks have their positions. */
function assignItems(list: TaskList, nodes: readonly Node[]): void {
	for (const node of nodes) {
		for (const g of node.task.goals ?? []) if (!g.id) g.id = allocateId(list, "g");
		for (const c of node.task.acceptanceCriteria ?? []) if (!c.id) c.id = allocateId(list, "c");
		assignItems(list, node.kids);
	}
}

/** An `update` edit of goals or criteria: texts to add, ids to remove, id + new text to replace. */
export interface ItemEdit {
	add?: string[];
	remove?: string[];
	edit?: Item[];
}

/** Apply an `ItemEdit` to `items`; returns the new list and the ids assigned to added texts. */
function applyItemEdit(items: readonly Item[], raw: unknown, what: string, max: number, maxChars: number, alloc: () => string): { items: Item[]; added: string[] } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((k) => !["add", "remove", "edit"].includes(k)))
		throw new TaskError("invalid_args", `"${what}" takes { add?: [texts], remove?: [ids], edit?: [{ id, text }] }.`);
	const e = raw as Record<string, unknown>;
	let next = [...items];
	if (e.remove !== undefined && e.remove !== null) {
		if (!Array.isArray(e.remove) || e.remove.some((x) => typeof x !== "string")) throw new TaskError("invalid_args", `${what}.remove must be an array of ids.`);
		for (const id of e.remove as string[]) if (!next.some((x) => x.id === id)) throw new TaskError("not_found", `No ${what} item ${id}; present: ${next.map((x) => x.id).join(", ") || "none"}.`);
		next = next.filter((x) => !(e.remove as string[]).includes(x.id));
	}
	if (e.edit !== undefined && e.edit !== null) {
		if (!Array.isArray(e.edit)) throw new TaskError("invalid_args", `${what}.edit must be an array of { id, text }.`);
		for (const x of e.edit as unknown[]) {
			const item = x as Partial<Item>;
			const at = next.findIndex((y) => y.id === item?.id);
			if (at < 0) throw new TaskError("not_found", `No ${what} item ${String(item?.id)}; present: ${next.map((y) => y.id).join(", ") || "none"}.`);
			next[at] = { id: next[at]!.id, text: cleanTexts([item.text], `${what}.edit ${item.id}`, 1, maxChars)[0]! };
		}
	}
	const added: string[] = [];
	if (e.add !== undefined && e.add !== null) {
		for (const text of cleanTexts(e.add, `${what}.add`, max, maxChars)) {
			const id = alloc();
			next.push({ id, text });
			added.push(id);
		}
	}
	if (next.length > max) throw new TaskError("invalid_args", `${what} would have ${next.length} items; keep at most ${max}.`);
	return { items: next, added };
}

/** A task tree node; `kids` in sibling order. */
interface Node {
	task: Task;
	kids: Node[];
	input?: TaskInput;
}

function treeOf(tasks: readonly Task[]): Node[] {
	const roots: Node[] = [];
	const byId = new Map<string, Node>();
	for (const task of [...tasks].sort((a, b) => compareIds(a.id, b.id))) {
		const node: Node = { task, kids: [] };
		byId.set(task.id, node);
		const p = parentOf(task.id);
		(p === null ? roots : byId.get(p)!.kids).push(node);
	}
	return roots;
}

/** Build new task nodes from `create` / `add` input; `links` collects `[new task, superseded id]`. */
function nodesOf(inputs: unknown, at: string, links: [Task, string][]): Node[] {
	if (!Array.isArray(inputs)) throw new TaskError("invalid_args", "tasks must be an array of { title, acceptanceCriteria?, subtasks? }.");
	return inputs.map((raw) => {
		const input = raw as TaskInput;
		const title = cleanTitle(input?.title);
		const task: Task = { id: "", title, status: "todo", createdAt: at, updatedAt: at };
		// Item ids are assigned once the list is known (`assignItems`); texts are validated here.
		if (input.goals !== undefined && input.goals !== null) task.goals = taskGoals(input.goals, title).map((text) => ({ id: "", text }));
		if (input.acceptanceCriteria !== undefined && input.acceptanceCriteria !== null) task.acceptanceCriteria = criteriaOf(input.acceptanceCriteria, title).map((text) => ({ id: "", text }));
		const sup = input.supersedes;
		if (sup !== undefined) {
			if (typeof sup !== "string" || !sup.trim()) throw new TaskError("invalid_args", `"supersedes" of "${title}" must be a task id, e.g. "3.2".`);
			links.push([task, sup.trim()]);
		}
		return { task, input, kids: input.subtasks === undefined ? [] : nodesOf(input.subtasks, at, links) };
	});
}

/**
 * Give every task the id of its position and write the tree back into `list.tasks`. Refuses, before
 * anything is changed, a layout that would renumber a started task. Rewrites references to
 * renumbered tasks and returns the renamings.
 */
function renumber(list: TaskList, roots: Node[]): { from: string; to: string }[] {
	const ids = new Map<Task, string>();
	const assign = (nodes: Node[], prefix: string) =>
		nodes.forEach((n, i) => {
			const id = prefix ? `${prefix}.${i + 1}` : String(i + 1);
			ids.set(n.task, id);
			assign(n.kids, id);
		});
	assign(roots, "");
	for (const [t, id] of ids) {
		if (t.id && t.id !== id && t.status !== "todo")
			throw new TaskError("frozen", `This would renumber ${t.id} "${t.title}" (${t.status}) to ${id}. Ids of started tasks never change; place the new work after it instead.`);
	}
	const renamed = new Map<string, string>();
	for (const [t, id] of ids) if (t.id && t.id !== id) renamed.set(t.id, id);
	const map = (id: string) => renamed.get(id) ?? id;
	for (const [t, id] of ids) {
		t.id = id;
		if (t.supersededBy) t.supersededBy = map(t.supersededBy);
		for (const b of t.blocks ?? []) if (b.on) b.on = map(b.on);
	}
	list.tasks = [...ids.entries()].sort((a, b) => compareIds(a[1], b[1])).map(([t]) => t);
	return [...renamed].map(([from, to]) => ({ from, to }));
}

function findNode(roots: Node[], id: string): { node: Node; siblings: Node[] } | null {
	for (const n of roots) {
		if (n.task.id === id) return { node: n, siblings: roots };
		if (id.startsWith(n.task.id + ".")) return findNode(n.kids, id);
	}
	return null;
}

const parentOf = parentId;

function isWithin(id: string, ancestor: string): boolean {
	return id === ancestor || id.startsWith(ancestor + ".");
}

export class TaskStore {
	constructor(
		private readonly projectDir: string,
		private readonly session: () => string,
		private readonly sessionName: () => string | undefined = () => undefined,
	) {}

	/** The session this store acts for. */
	sessionId(): string {
		return this.session();
	}

	private newClaim(): TaskClaim {
		const name = this.sessionName()?.trim();
		return { session: this.session(), at: now(), ...(name ? { name } : {}) };
	}

	/**
	 * Records what the model has now seen of each attachment, so a later change is reported once
	 * (SPEC-0002 §4.2). A refreshed anchor replaces a legacy line range or a moved quote.
	 */
	recordSeen(slug: string, seen: Readonly<Record<string, { hash: string; anchor?: Anchor }>>): void {
		const list = this.read(slug);
		let changed = false;
		for (const h of [list, ...list.tasks])
			for (const a of h.attachments ?? []) {
				const now = seen[a.id];
				if (!now) continue;
				if (a.hash !== now.hash) {
					a.hash = now.hash;
					changed = true;
				}
				if (now.anchor) {
					a.anchor = now.anchor;
					delete a.lines;
					changed = true;
				}
			}
		if (changed) this.write(list);
	}

	/** Lists this session currently claims. */
	claimedBySession(): TaskList[] {
		return this.lists().filter((l) => l.claim?.session === this.session());
	}

	private file(slug: string): string {
		return path.join(tasksDir(this.projectDir), `${assertSlug(slug)}.json`);
	}

	read(slug: string): TaskList {
		const file = this.file(slug);
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new TaskError("not_found", `No task list "${slug}". Use action "list" to see existing lists, or "create" to make one.`);
			throw new TaskError("invalid_file", `Cannot read task list ${path.relative(this.projectDir, file)}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const rel = path.relative(this.projectDir, file);
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (err) {
			throw new TaskError("invalid_file", `Task list file ${rel} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it.`);
		}
		const parsed = parseListFile(json, slug, { requireGoal: false });
		if (!parsed.ok) throw new TaskError("invalid_file", `Task list file ${rel} is invalid:\n${parsed.errors.map((e) => `- ${e}`).join("\n")}\nFix the file; the format is in skill accordion-task-lists.`);
		const list = parsed.list as FlatList & Partial<TaskList>;
		// A hand-written file may leave out bookkeeping fields; the file's time stands in for them.
		const at = list.updatedAt ?? list.createdAt ?? fs.statSync(file).mtime.toISOString();
		list.createdAt ??= at;
		list.updatedAt ??= at;
		list.claim ??= null;
		for (const t of list.tasks) t.updatedAt ??= at;
		for (const holder of [list, ...list.tasks]) for (const p of holder.pins ?? []) p.at ??= at;
		if (parsed.migratedFrom) this.migratedFrom.set(file, parsed.migratedFrom);
		return list as TaskList;
	}

	/** Files read from an older version that have not been written as v3 yet: their first write keeps a copy. */
	private readonly migratedFrom = new Map<string, 1 | 2>();

	private write(list: TaskList): void {
		const link = this.file(list.slug);
		const file = writeTarget(link);
		list.updatedAt = now();
		const candidate = toListFile(list as unknown as FlatList);
		const checked = parseListFile(candidate, list.slug, { requireGoal: false });
		if (!checked.ok) throw new TaskError("invalid_file", `Cannot save task list "${list.slug}":\n${checked.errors.join("\n")}\nThe original file is unchanged.`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const from = this.migratedFrom.get(link);
		if (from) {
			const backup = link.replace(/\.json$/, `.v${from}.json`);
			if (!fs.existsSync(backup) && fs.existsSync(file)) fs.copyFileSync(file, backup);
			this.migratedFrom.delete(link);
		}
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2) + "\n");
		fs.renameSync(tmp, file);
	}

	/** Every list in the project, newest first. Unreadable files are skipped. */
	lists(): TaskList[] {
		return this.scan().lists;
	}

	/** Every list in the project, newest first, plus the slugs of files that fail to load. */
	scan(): { lists: TaskList[]; invalid: string[] } {
		let names: string[];
		try {
			names = fs.readdirSync(tasksDir(this.projectDir));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lists: [], invalid: [] };
			throw new TaskError("invalid_file", `Cannot read task lists: ${err instanceof Error ? err.message : String(err)}`);
		}
		const out: TaskList[] = [];
		const invalid: string[] = [];
		for (const n of names) {
			if (!n.endsWith(".json") || !SLUG_RE.test(n.slice(0, -5))) continue;
			try {
				out.push(this.read(n.slice(0, -5)));
			} catch {
				invalid.push(n.slice(0, -5));
			}
		}
		return { lists: out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), invalid: invalid.sort() };
	}

	/** Create and claim a list with its goals. */
	create(slug: string, title: string, goals: unknown, tasks: unknown, userTexts: readonly string[] = [], limits: PinLimits = PIN_LIMITS): TaskList {
		if (fs.existsSync(this.file(slug))) throw new TaskError("invalid_args", `Task list "${slug}" already exists. Use "claim" to work on it, or pick another slug.`);
		const at = now();
		const list: TaskList = { slug, title: cleanTitle(title), seq: {}, createdAt: at, updatedAt: at, claim: this.newClaim(), tasks: [] };
		list.goals = listGoals(goals).map((text) => ({ id: allocateId(list, "g"), text }));
		const links: [Task, string][] = [];
		const roots = nodesOf(tasks ?? [], at, links);
		if (links.length) throw new TaskError("invalid_args", '"supersedes" points at a task in the same list, so it only works with "add".');
		renumber(list, roots);
		assignItems(list, roots);
		this.prepareReferences(list, roots, userTexts, limits);
		this.write(list);
		return list;
	}

	/**
	 * Edit the list's title or goals (no `id`), or a task's title, goals or acceptance criteria.
	 * Goals and criteria take an `ItemEdit`; `added` holds the ids given to added items.
	 */
	update(slug: string, id: string | undefined, fields: { title?: unknown; goals?: unknown; acceptanceCriteria?: unknown }): { list: TaskList; task?: Task; changed: string[]; added: { goals?: string[]; criteria?: string[] } } {
		const list = this.owned(slug);
		const changed: string[] = [];
		const added: { goals?: string[]; criteria?: string[] } = {};
		const has = (v: unknown) => v !== undefined && v !== null;
		if (id === undefined) {
			if (has(fields.acceptanceCriteria)) throw new TaskError("invalid_args", '"acceptanceCriteria" belongs to a task; give its "id".');
			if (has(fields.title)) (list.title = cleanTitle(fields.title)), changed.push("title");
			if (has(fields.goals)) {
				const r = applyItemEdit(list.goals ?? [], fields.goals, "goals", GOALS_MAX, GOAL_MAX, () => allocateId(list, "g"));
				if (!r.items.length) throw new TaskError("invalid_args", `A list keeps at least one goal; add the replacement in the same call, ${GOALS_HINT}.`);
				list.goals = r.items;
				if (r.added.length) added.goals = r.added;
				changed.push("goals");
			}
			if (!changed.length) throw new TaskError("invalid_args", 'Nothing to update: give "title" or "goals".');
			this.write(list);
			return { list, changed, added };
		}
		const task = this.task(list, id);
		if (FINISHED.has(task.status)) throw new TaskError("frozen", `Task ${id} is ${task.status}; a finished task's title, goals and criteria stay as they were. Add a follow-up task instead.`);
		if (has(fields.title)) (task.title = cleanTitle(fields.title)), changed.push("title");
		if (has(fields.goals)) {
			const r = applyItemEdit(task.goals ?? [], fields.goals, `goals of ${id}`, TASK_GOALS_MAX, TASK_GOAL_MAX, () => allocateId(list, "g"));
			task.goals = r.items.length ? r.items : undefined;
			if (r.added.length) added.goals = r.added;
			changed.push("goals");
		}
		if (has(fields.acceptanceCriteria)) {
			const r = applyItemEdit(task.acceptanceCriteria ?? [], fields.acceptanceCriteria, `acceptanceCriteria of ${id}`, CRITERIA_MAX, CRITERION_MAX, () => allocateId(list, "c"));
			task.acceptanceCriteria = r.items.length ? r.items : undefined;
			if (r.added.length) added.criteria = r.added;
			changed.push("acceptanceCriteria");
		}
		if (!changed.length) throw new TaskError("invalid_args", 'Nothing to update: give "title", "goals" or "acceptanceCriteria".');
		task.updatedAt = now();
		this.write(list);
		return { list, task, changed, added };
	}

	private prepareReferences(list: TaskList, nodes: readonly Node[], userTexts: readonly string[], limits: PinLimits): void {
		const pinId = () => allocateId(list, "p");
		const attachmentId = () => allocateId(list, "a");
		const context = { projectDir: this.projectDir, userTexts, limits, now: now() };
		const visit = (node: Node) => {
			const input = node.input;
			if (input?.pins !== undefined) {
				if (!Array.isArray(input.pins)) throw new TaskError("invalid_args", 'Task "pins" must be an array.');
				const pins: Pin[] = [];
				for (const item of input.pins) pins.push(makePin(item, context, pinId(), pins));
				checkPinCap(pins, limits.taskTokens, node.task.id);
				node.task.pins = pins;
			}
			if (input?.attachments !== undefined) {
				if (!Array.isArray(input.attachments)) throw new TaskError("invalid_args", 'Task "attachments" must be an array.');
				const attachments: Attachment[] = [];
				for (const item of input.attachments) attachments.push(makeAttachment(item, context, attachmentId(), attachments));
				node.task.attachments = attachments;
			}
			for (const child of node.kids) visit(child);
		};
		for (const node of nodes) visit(node);
	}

	/** Add or remove pins or attachments on a list or task. All additions are validated before writing. */
	references(slug: string, id: string | undefined, action: "pin" | "unpin" | "attach" | "detach", items: unknown, userTexts: readonly string[] = [], limits: PinLimits = PIN_LIMITS): string[] {
		const list = this.owned(slug);
		const holder: PinHolder = id === undefined ? list : this.task(list, id);
		if (!Array.isArray(items) || !items.length) throw new TaskError("invalid_args", 'Give a non-empty "items" array.');
		if (action === "pin") {
			const fresh: Pin[] = [];
			const alloc = () => allocateId(list, "p");
			for (const item of items) fresh.push(makePin(item, { projectDir: this.projectDir, userTexts, limits, now: now() }, alloc(), [...(holder.pins ?? []), ...fresh]));
			checkPinCap([...(holder.pins ?? []), ...fresh], id === undefined ? limits.listTokens : limits.taskTokens, id ?? slug);
			holder.pins = [...(holder.pins ?? []), ...fresh];
			this.write(list);
			return fresh.map((p) => p.id);
		}
		if (action === "attach") {
			const fresh: Attachment[] = [];
			const alloc = () => allocateId(list, "a");
			for (const item of items) fresh.push(makeAttachment(item, { projectDir: this.projectDir, userTexts, limits, now: now() }, alloc(), [...(holder.attachments ?? []), ...fresh]));
			holder.attachments = [...(holder.attachments ?? []), ...fresh];
			this.write(list);
			return fresh.map((a) => a.id);
		}
		if (items.some((x) => typeof x !== "string")) throw new TaskError("invalid_args", 'Removal items must be pin or attachment ids.');
		const ids = items as string[];
		const present = action === "unpin" ? holder.pins ?? [] : holder.attachments ?? [];
		for (const key of ids) if (!present.some((p) => p.id === key)) throw new TaskError("not_found", `No ${action === "unpin" ? "pin" : "attachment"} ${key} in this scope.`);
		if (action === "unpin") holder.pins = (holder.pins ?? []).filter((p) => !ids.includes(p.id));
		else holder.attachments = (holder.attachments ?? []).filter((a) => !ids.includes(a.id));
		this.write(list);
		return ids;
	}

	/** A list that may grow or move on: it needs a goal first. */
	private planned(slug: string): TaskList {
		const list = this.owned(slug);
		if (!list.goals?.length)
			throw new TaskError("no_goal", `Task list "${slug}" has no goals yet. Set them first: tasks update {list: "${slug}", goals: {add: ["<the end state this list delivers>"]}}. Ending a running task works without them.`);
		return list;
	}

	/** Claim a list for this session. A live claim held by another session needs `force`. */
	claim(slug: string, force = false): TaskList {
		const list = this.read(slug);
		const held = list.claim;
		if (held && held.session !== this.session() && !force && claimState(list, this.session()) === "held")
			throw new TaskError("claimed_by_other", `Task list "${slug}" is claimed by another session (since ${held.at}). Ask the user before taking it over with force: true.`);
		list.claim = this.newClaim();
		this.write(list);
		return list;
	}

	/** Release a list owned by this session; reject unowned lists without changing them. */
	release(slug: string): void {
		const list = this.read(slug);
		if (list.claim?.session !== this.session()) throw new TaskError("invalid_transition", `Task list "${slug}" is not claimed by this session; nothing was released.`);
		list.claim = null;
		this.write(list);
	}

	/** Read a list this session holds, refreshing the claim. */
	private owned(slug: string): TaskList {
		const list = this.read(slug);
		if (list.claim?.session !== this.session()) throw new TaskError("invalid_transition", `Task list "${slug}" is not claimed by this session. Call "claim" first.`);
		list.claim.at = now();
		return list;
	}

	private task(list: TaskList, id: unknown): Task {
		const t = typeof id === "string" ? list.tasks.find((x) => x.id === id) : undefined;
		if (!t) throw new TaskError("not_found", `No task ${JSON.stringify(id)} in "${list.slug}". Use "status" to see task ids.`);
		return t;
	}

	/**
	 * Where new or moved tasks go: under `parent` (top level when absent), at the end or next to a
	 * sibling named by `before`/`after`. The anchor fixes the parent when `parent` is left out.
	 */
	private place(list: TaskList, roots: Node[], parent: string | undefined, before: unknown, after: unknown): { siblings: Node[]; index: number; parent: string | null } {
		if (before !== undefined && after !== undefined) throw new TaskError("invalid_args", 'Give "before" or "after", not both.');
		const anchor = before ?? after;
		if (anchor !== undefined) {
			const a = this.task(list, anchor);
			const p = parentOf(a.id);
			if (parent !== undefined && parent !== (p ?? "")) throw new TaskError("invalid_args", `Task ${a.id} is not a subtask of ${parent || "the top level"}; leave out "parent" to place next to ${a.id}.`);
			const hit = findNode(roots, a.id)!;
			return { siblings: hit.siblings, index: hit.siblings.indexOf(hit.node) + (after !== undefined ? 1 : 0), parent: p };
		}
		if (parent === undefined || parent === "") return { siblings: roots, index: roots.length, parent: null };
		const node = findNode(roots, this.task(list, parent).id)!.node;
		return { siblings: node.kids, index: node.kids.length, parent: node.task.id };
	}

	/** Add tasks; a task with `supersedes` replaces an earlier one, abandoning it if it is still open. */
	add(slug: string, parent: string | undefined, tasks: unknown, position: { before?: unknown; after?: unknown } = {}, userTexts: readonly string[] = [], limits: PinLimits = PIN_LIMITS): { added: Task[]; reused: Task[]; order: Task[]; superseded: Task[]; renumbered: { from: string; to: string }[] } {
		const list = this.planned(slug);
		const roots = treeOf(list.tasks);
		const at = now();
		const spot = this.place(list, roots, parent, position.before, position.after);
		if (spot.parent !== null && FINISHED.has(this.task(list, spot.parent).status))
			throw new TaskError("invalid_transition", `Task ${spot.parent} is ${this.task(list, spot.parent).status}; add the new work at the top level or under an open task.`);
		const links: [Task, string][] = [];
		const requested = nodesOf(tasks, at, links);
		// The user's message may have been routed into the list while the agent adds the same work: a bare
		// repeat of an unstarted sibling reuses it instead of creating a twin.
		const planned = new Set(links.map(([by]) => by));
		const key = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();
		const twins = new Map<Node, Task>();
		for (const n of requested) {
			if (n.kids.length || planned.has(n.task)) continue;
			const twin = spot.siblings.find((o) => o.task.status === "todo" && key(o.task.title) === key(n.task.title));
			if (twin) twins.set(n, twin.task);
		}
		const nodes = requested.filter((n) => !twins.has(n));
		const superseded: Task[] = [];
		const pairs: [Task, Task][] = [];
		for (const [by, old] of links) {
			const t = this.task(list, old);
			pairs.push([by, t]);
			if (t.status === "doing") throw new TaskError("invalid_transition", `Task ${old} is in progress; end it before a new task supersedes it.`);
			if (t.status === "done") throw new TaskError("invalid_transition", `Task ${old} is done; nothing to supersede. Add the new task without "supersedes".`);
			if (spot.parent !== null && isWithin(spot.parent, old)) throw new TaskError("invalid_transition", `Task ${old} contains the new task, so it cannot be superseded by it.`);
			superseded.push(t);
		}
		spot.siblings.splice(spot.index, 0, ...nodes);
		const renumbered = renumber(list, roots);
		assignItems(list, nodes);
		this.prepareReferences(list, nodes, userTexts, limits);
		for (const [by, oldTask] of pairs) {
			if (oldTask.status === "todo" || oldTask.status === "blocked") abandon(oldTask, { outcome: `Superseded by ${by.id}.` }, at);
			oldTask.supersededBy = by.id;
			oldTask.updatedAt = at;
		}
		const added: Task[] = [];
		const collect = (ns: Node[]) => ns.forEach((n) => (added.push(n.task), collect(n.kids)));
		collect(nodes);
		const order: Task[] = [];
		const inOrder = (n: Node): void => {
			order.push(n.task);
			n.kids.forEach(inOrder);
		};
		for (const n of requested) {
			const twin = twins.get(n);
			if (twin) order.push(twin);
			else inOrder(n);
		}
		this.write(list);
		return { added, reused: [...twins.values()], order, superseded, renumbered };
	}

	/** Move an unstarted task with its subtasks under another parent or next to a sibling. */
	move(slug: string, id: string, parent: string | undefined, position: { before?: unknown; after?: unknown }): { task: Task; renumbered: { from: string; to: string }[] } {
		const list = this.planned(slug);
		const task = this.task(list, id);
		const started = list.tasks.filter((t) => isWithin(t.id, id) && t.status !== "todo");
		if (started.length)
			throw new TaskError("frozen", `${started[0].id} has ${started[0].status === "doing" ? "started" : `been ${started[0].status}`}, so ${id} cannot move: ids of started tasks never change. To change the plan, add new work with tasks add {list: "${slug}", after: "${id}", tasks: [...]} or abandon what is no longer wanted.`);
		if (parent === undefined && position.before === undefined && position.after === undefined) throw new TaskError("invalid_args", 'Say where to move it: "parent", "before" or "after".');
		for (const target of [parent, position.before, position.after])
			if (typeof target === "string" && target && isWithin(target, id)) throw new TaskError("invalid_transition", `Task ${target} is inside ${id}; a task cannot move into its own subtree.`);
		const roots = treeOf(list.tasks);
		const from = findNode(roots, id)!;
		const spot = this.place(list, roots, parent, position.before, position.after);
		if (spot.parent !== null && FINISHED.has(this.task(list, spot.parent).status))
			throw new TaskError("invalid_transition", `Task ${spot.parent} is ${this.task(list, spot.parent).status}; move ${id} under an open task or to the top level.`);
		const index = from.siblings === spot.siblings && from.siblings.indexOf(from.node) < spot.index ? spot.index - 1 : spot.index;
		from.siblings.splice(from.siblings.indexOf(from.node), 1);
		spot.siblings.splice(index, 0, from.node);
		const renumbered = renumber(list, roots);
		if (!renumbered.length) throw new TaskError("invalid_transition", `Task ${id} is already there.`);
		task.updatedAt = now();
		this.write(list);
		return { task, renumbered };
	}

	/**
	 * Block a task in progress on something it waits for. Open ancestors with no other task in
	 * progress beneath them are blocked on it as well, so the agent may start other work.
	 */
	block(slug: string, id: string, reason: unknown, detail: unknown, on?: unknown): { task: Task; ancestors: Task[] } {
		const list = this.owned(slug);
		const task = this.task(list, id);
		if (!BLOCK_REASONS.includes(reason as BlockReason))
			throw new TaskError("invalid_args", `A block needs "reason": one of ${BLOCK_REASONS.map((r) => `"${r}"`).join(", ")}.`);
		if (typeof detail !== "string" || !detail.trim()) throw new TaskError("invalid_args", 'A block needs "detail": what exactly the task waits for, e.g. "the user must choose between Postgres and SQLite".');
		const text = detail.trim().replace(/\s+/g, " ");
		if (text.length > BLOCK_DETAIL_MAX) throw new TaskError("invalid_args", `"detail" is ${text.length} chars; use at most ${BLOCK_DETAIL_MAX}.`);
		if (task.status !== "doing") throw new TaskError("invalid_transition", `Task ${id} is ${task.status}; only a task in progress can be blocked.`);
		const inner = list.tasks.filter((t) => t.id !== id && isWithin(t.id, id) && t.status === "doing");
		if (inner.length) throw new TaskError("open_subtasks", `Subtask ${inner.map((t) => t.id).join(", ")} of ${id} is in progress. Block that subtask instead, or end it first.`);
		let dep: string | undefined;
		if (reason === "dependency") {
			if (typeof on !== "string" || !on.trim()) throw new TaskError("invalid_args", 'A "dependency" block needs "blockedBy": the id of the task this one waits for.');
			const target = this.task(list, on.trim());
			if (isWithin(target.id, id) || isWithin(id, target.id)) throw new TaskError("invalid_transition", `Task ${target.id} is ${isWithin(target.id, id) ? "inside" : "a parent of"} ${id}; a task cannot wait for its own branch.`);
			if (FINISHED.has(target.status)) throw new TaskError("invalid_transition", `Task ${target.id} is already ${target.status}; ${id} does not wait for it. Continue ${id}.`);
			dep = target.id;
		} else if (on !== undefined) throw new TaskError("invalid_args", '"blockedBy" only goes with reason "dependency".');
		const at = now();
		const put = (t: Task, b: TaskBlock) => {
			t.status = "blocked";
			t.updatedAt = at;
			(t.blocks ??= []).push(b);
		};
		put(task, { reason: reason as BlockReason, detail: text, ...(dep ? { on: dep } : {}), at });
		const ancestors: Task[] = [];
		for (let p = parentOf(id); p !== null; p = parentOf(p)) {
			const anc = list.tasks.find((t) => t.id === p);
			if (anc?.status !== "doing" || list.tasks.some((t) => t.id !== p && isWithin(t.id, p) && t.status === "doing")) break;
			put(anc, { reason: "dependency", detail: `subtask ${id} is blocked`, on: id, at });
			ancestors.push(anc);
		}
		this.write(list);
		return { task, ancestors };
	}

	/**
	 * Start a task. Nesting is a stack: unstarted ancestors start with it, so a parent's span covers
	 * its subtasks. Moving on from an open parent whose subtasks are all finished closes that parent
	 * with a report composed from its subtasks; an open task with unfinished subtasks still blocks.
	 */
	start(slug: string, id: string): StartResult {
		const list = this.planned(slug);
		const task = this.task(list, id);
		if (task.status === "doing") throw new TaskError("invalid_transition", `Task ${id} is already in progress.`);
		if (task.status !== "todo" && task.status !== "blocked")
			throw new TaskError("invalid_transition", `Task ${id} is ${task.status}. Add a follow-up task (with "supersedes": "${id}") instead of restarting it.`);
		const at = now();
		const autoClosed: Task[] = [];
		// Innermost first, so a closed child counts as finished when its parent is checked.
		const open = list.tasks.filter((t) => t.status === "doing" && !isWithin(id, t.id)).sort((a, b) => b.id.length - a.id.length);
		const blocking: Task[] = [];
		for (const t of open) {
			const kids = list.tasks.filter((c) => parentOf(c.id) === t.id);
			if (kids.length && kids.every((c) => FINISHED.has(c.status))) {
				closeFromChildren(t, kids, at);
				autoClosed.push(t);
			} else blocking.push(t);
		}
		if (blocking.length)
			throw new TaskError("open_subtasks",
				`Task ${blocking.map((t) => `${t.id} "${t.title}"`).join(", ")} is still in progress. Complete, fail or abandon it with a report before starting ${id}, or start one of its subtasks.`,
			);
		const started: Task[] = [];
		for (let p = parentOf(id); p !== null; p = parentOf(p)) {
			const anc = list.tasks.find((t) => t.id === p);
			if (anc?.status !== "todo" && anc?.status !== "blocked") continue;
			// A parent blocked on a subtask this start does not resume keeps its wait open: finishing a
			// sibling must not lift the parent's dependency while that subtask still waits.
			const wait = currentBlock(anc);
			const target = wait?.on ? list.tasks.find((t) => t.id === wait.on) : undefined;
			if (target && target.id !== id && !started.includes(target) && !FINISHED.has(target.status) && target.status === "blocked") continue;
			started.unshift(anc);
		}
		// Leaves run in list order. A parent never starts by itself — starting its next leaf starts it.
		const startable = startableTasks(list);
		if (!startable.some((t) => t.id === id)) {
			const call = startable[0] ? ` Call ${startCall(list, startable[0])}.` : "";
			if (childrenOf(list, id).length) throw new TaskError("invalid_transition", `Task ${id} is a parent; parents start with their next leaf.${call}`);
			const next = nextTaskOf(list);
			throw new TaskError("invalid_transition", `Task ${id} is not next: leaves start in list order.${call}${next ? ` Finish ${next.id} "${next.title}" first, or block it when it waits on something, or "move" this task ahead of it.` : ""}`);
		}
		started.push(task);
		const resumed = new Set<Task>();
		for (const t of started) {
			if (t.status === "blocked") {
				resumed.add(t);
				const open = t.blocks?.[t.blocks.length - 1];
				if (open && !open.resumedAt) open.resumedAt = at;
			} else t.startedAt = at;
			t.status = "doing";
			t.updatedAt = at;
		}
		this.write(list);
		return { list, task, autoStarted: started.slice(0, -1), autoClosed, resumed: started.filter((t) => resumed.has(t)) };
	}

	/**
	 * End a task as done, failed or abandoned. Subtasks in progress block it; `complete` also needs
	 * every subtask finished. Failing or abandoning a parent abandons its unstarted and blocked
	 * subtasks with it. Only `abandon` ends a task that is not in progress.
	 */
	finish(
		slug: string,
		id: string,
		status: "done" | "failed" | "abandoned",
		report: unknown,
		supersededBy?: unknown,
	): { list: TaskList; task: Task; parentReady?: Task; cascaded: Task[]; blockedParents: Task[] } {
		const list = this.owned(slug);
		const task = this.task(list, id);
		const verb = status === "done" ? "complete" : status === "failed" ? "fail" : "abandon";
		if (status === "abandoned" ? FINISHED.has(task.status) : task.status !== "doing") {
			if (task.status === "blocked") throw new TaskError("invalid_transition", `Task ${id} is blocked. Resume it with start before you ${verb} it, or abandon it.`);
			if (task.status === "todo") throw new TaskError("invalid_transition", `Task ${id} was never started. Start it first, or abandon it with a report if it is no longer needed.`);
			throw new TaskError("invalid_transition", `Task ${id} is ${task.status}, not in progress. Check "status".`);
		}
		const below = list.tasks.filter((t) => t.id !== id && isWithin(t.id, id));
		const openChildren = below.filter((t) => t.status === "doing");
		if (openChildren.length) throw new TaskError("open_subtasks", `Subtask ${openChildren.map((t) => t.id).join(", ")} of ${id} is still in progress. End it first.`);
		const unfinished = below.filter((t) => t.status === "todo" || t.status === "blocked");
		if (status === "done" && unfinished.length)
			throw new TaskError("open_subtasks", 
				`Subtask ${unfinished.map((t) => `${t.id} (${t.status === "todo" ? "not started" : "blocked"})`).join(", ")} of ${id} ${unfinished.length === 1 ? "is" : "are"} unfinished. Start and finish ${unfinished.length === 1 ? "it" : "them"}, or abandon ${unfinished.length === 1 ? "it" : "them"} with a report (and "supersededBy" when another task replaces ${unfinished.length === 1 ? "it" : "them"}) before completing ${id}.`,
			);
		let replacement: string | undefined;
		if (supersededBy !== undefined) {
			if (status !== "abandoned") throw new TaskError("invalid_args", '"supersededBy" only goes with "abandon".');
			if (typeof supersededBy !== "string" || !supersededBy.trim()) throw new TaskError("invalid_args", '"supersededBy" must be a task id, e.g. "9.3".');
			const by = this.task(list, supersededBy.trim());
			if (isWithin(by.id, id)) throw new TaskError("invalid_transition", `Task ${by.id} is part of ${id}, so it cannot replace it.`);
			replacement = by.id;
		}
		const clean = cleanReport(report);
		const at = now();
		if (status === "abandoned") abandon(task, clean, at);
		else {
			task.report = clean;
			task.status = status;
			task.updatedAt = at;
			task.endedAt = at;
		}
		if (replacement) task.supersededBy = replacement;
		const cascaded: Task[] = [];
		for (const t of unfinished) {
			abandon(t, { outcome: `Abandoned with its parent ${id} (${status}).` }, at);
			cascaded.push(t);
		}
		// Parents blocked only on this task stay blocked until the agent resumes them.
		const blockedParents = list.tasks.filter((t) => t.status === "blocked" && t.blocks?.[t.blocks.length - 1]?.on === id && isWithin(id, t.id));
		this.write(list);
		const parent = parentOf(id);
		const siblings = parent === null ? [] : list.tasks.filter((t) => parentOf(t.id) === parent);
		const parentTask = parent === null ? undefined : list.tasks.find((t) => t.id === parent);
		const parentReady = parentTask?.status === "doing" && siblings.every((t) => FINISHED.has(t.status)) ? parentTask : undefined;
		return { list, task, parentReady, cascaded, blockedParents };
	}
}

/** The task children of `id`, in list order. */
function childrenOf(list: TaskList, id: string | null): Task[] {
	return list.tasks.filter((t) => (id === null ? !t.id.includes(".") : parentOf(t.id) === id));
}

/**
 * The tasks a session may start right now: the list's next task (§3.4), plus resuming any blocked
 * leaf — ending a wait is what resuming is for. Takes must be recomputed after an auto-close.
 */
export function startableTasks(list: TaskList): Task[] {
	const out = new Map<string, Task>();
	const next = nextTaskOf(list);
	const nextTask = next ? list.tasks.find((t) => t.id === next.id) : undefined;
	if (nextTask) out.set(nextTask.id, nextTask);
	for (const t of list.tasks) {
		if (t.status !== "blocked" || childrenOf(list, t.id).length) continue;
		if (currentBlock(t)) out.set(t.id, t);
	}
	return [...out.values()];
}

/** How to name a start call in a refusal. */
function startCall(list: TaskList, t: Task): string {
	return `start { list: "${list.slug}", id: "${t.id}" }`;
}

const FINISHED: ReadonlySet<TaskStatus> = new Set(["done", "failed", "abandoned"]);

/** What `start` did besides starting the task. */
export interface StartResult {
	list: TaskList;
	task: Task;
	/** Ancestors that were not started yet and started with the task, outermost first. */
	autoStarted: Task[];
	/** Open parents whose subtasks were all finished and that closed because the agent moved on. */
	autoClosed: Task[];
	/** Blocked tasks this start resumed (the task itself and ancestors), outermost first. */
	resumed: Task[];
}

/** End a task as abandoned; a block it was in ends with it. */
function abandon(t: Task, report: TaskReport, at: string): void {
	const open = t.blocks?.[t.blocks.length - 1];
	if (t.status === "blocked" && open && !open.resumedAt) open.resumedAt = at;
	t.status = "abandoned";
	t.report = report;
	t.updatedAt = at;
	t.endedAt = at;
}

/** Close a parent from its finished subtasks: done when all are done, else failed. */
function closeFromChildren(t: Task, kids: readonly Task[], at: string): void {
	const failed = kids.filter((c) => c.status !== "done");
	const outcomes = kids.map((c) => `${c.id} ${c.status}${c.report?.outcome ? `: ${c.report.outcome}` : ""}`).join("; ");
	const outcome = `Closed automatically after its subtasks: ${outcomes}`;
	t.status = failed.length ? "failed" : "done";
	t.report = { outcome: outcome.length > OUTCOME_MAX ? `${outcome.slice(0, OUTCOME_MAX - 1)}…` : outcome };
	t.autoClosed = true;
	t.updatedAt = at;
	t.endedAt = at;
}

const MARK: Record<TaskStatus, string> = { todo: "[ ]", doing: "[~]", blocked: "[=]", done: "[x]", failed: "[!]", abandoned: "[-]" };

/** The block a blocked task is in, or null. */
export function currentBlock(t: Task): TaskBlock | null {
	const b = t.blocks?.[t.blocks.length - 1];
	return t.status === "blocked" && b && !b.resumedAt ? b : null;
}

/** `needs user decision`, `waits for 3.2`, … */
export function blockLabel(b: TaskBlock): string {
	return b.reason === "user-decision" ? "needs user decision" : b.reason === "user-input" ? "needs user input" : b.reason === "third-party" ? "waits on third party" : `waits for ${b.on ?? "another task"}`;
}

/** Who holds a list, from one session's point of view. A claim idle past `CLAIM_STALE_MS` is stale. */
export type ClaimState = "mine" | "free" | "stale" | "held";

export function claimState(list: TaskList, session: string, at = Date.now()): ClaimState {
	const c = list.claim;
	if (!c) return "free";
	if (c.session === session) return "mine";
	return at - Date.parse(c.at) < CLAIM_STALE_MS ? "held" : "stale";
}

/** Identifies a list's task content; it changes whenever a task is added, started or finished. */
export function taskFingerprint(list: TaskList): string {
	const h = crypto.createHash("sha256");
	for (const t of list.tasks) h.update(`${t.id}\0${t.status}\0${t.updatedAt}\0${t.title}\n`);
	return h.digest("hex").slice(0, 16);
}

/** A free slug derived from a title: `Auth refactor` → `auth-refactor`, then `-2`, `-3`, … when taken. */
export function slugFor(title: string, taken: ReadonlySet<string>): string {
	const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "tasks";
	let slug = SLUG_RE.test(base) ? base : `list-${base}`.slice(0, 48);
	for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 44)}-${n}`;
	return slug;
}

/** A compact outline of a list for tool results. */
export function renderList(list: TaskList): string {
	const lines = [`${list.slug} — ${list.title}${list.claim ? `  (claimed ${list.claim.at})` : ""}`, ...(list.goals?.length ? list.goals.map((g) => `goal ${g.id}: ${g.text}`) : [`goals: none yet — set them with update {list: "${list.slug}", goals: {add: [...]}}`])];
	for (const t of list.tasks) {
		const b = currentBlock(t);
		const note = b ? `  (blocked: ${blockLabel(b)} — ${b.detail})` : t.supersededBy ? `  (superseded by ${t.supersededBy})` : "";
		lines.push(`${"  ".repeat(t.id.split(".").length)}${MARK[t.status]} ${t.id} ${t.title}${note}`);
	}
	return lines.join("\n");
}

export const TASK_ACTIONS = ["create", "list", "claim", "release", "add", "update", "move", "pin", "unpin", "attach", "detach", "status", "start", "block", "complete", "fail", "abandon"] as const;

/** The tool's argument shape; every field but `action` depends on the action. */
export interface TasksArgs {
	action: (typeof TASK_ACTIONS)[number];
	list?: string;
	title?: string;
	/** For create: the goal texts; for update: an `ItemEdit` of the list's (no `id`) or a task's goals. */
	goals?: string[] | ItemEdit;
	/** For update: an `ItemEdit` of a task's acceptance criteria. */
	acceptanceCriteria?: ItemEdit;
	items?: unknown[];
	pins?: string[];
	attachments?: string[];
	tasks?: TaskInput[];
	parent?: string;
	/** For add and move: the sibling to place before. */
	before?: string;
	/** For add and move: the sibling to place after. */
	after?: string;
	id?: string;
	report?: TaskReport;
	force?: boolean;
	/** For block: why the task cannot continue. */
	reason?: BlockReason;
	/** For block: what exactly it waits for. */
	detail?: string;
	/** For block with reason "dependency": the task it waits for. */
	blockedBy?: string;
	/** For abandon: the task that replaces this one. */
	supersededBy?: string;
}

/** `{old: new}` for ids shifted by add or move. */
function renumberMap(renumbered: readonly { from: string; to: string }[]): Record<string, string> {
	return Object.fromEntries(renumbered.map((r) => [r.from, r.to]));
}

/** A task by id and title. */
export interface TaskRef {
	id: string;
	title: string;
}

/**
 * What a successful `tasks` call returns to the model (SPEC-0002 §3.4): only what the tool decided,
 * never an echo of what the agent wrote. Task context (`list`, `started`, `resumed`, `active`) is
 * filled in by the caller, which knows what the model can still see.
 */
export interface TaskResult {
	ok: true;
	list?: string | Record<string, unknown>;
	ids?: string[];
	/** Ids assigned to added goals: a flat list for the list's goals, keyed by task id for task goals. */
	goals?: string[] | Record<string, string[]>;
	/** Ids assigned to added criteria: a flat list for `update`, keyed by task id for `create`/`add`. */
	criteria?: string[] | Record<string, string[]>;
	lists?: Record<string, unknown>[];
	renumbered?: Record<string, string>;
	abandoned?: string[];
	superseded?: string[];
	pins?: string[];
	attachments?: { id: string; ref: string }[];
	started?: (TaskRef | Record<string, unknown> | string)[];
	resumed?: (TaskRef | Record<string, unknown> | string)[];
	active?: (TaskRef | Record<string, unknown> | string)[];
	closed?: { id: string; status: TaskStatus }[];
	alsoBlocked?: string[];
	parentReady?: string;
	resumable?: string[];
	cascaded?: string[];
	next?: TaskRef & { resume?: true };
	done?: number;
	total?: number;
	noGoal?: true;
	doing?: string[];
	blocked?: { id: string; reason: BlockReason; detail: string; on?: string }[];
}

/** Run one `tasks` call and return its JSON result text. Rejections throw `TaskError`. */
export function runTasks(store: TaskStore, args: TasksArgs): string {
	return JSON.stringify(runTasksTracked(store, args).result);
}

/** A `tasks` call's result plus the task ids it started, the one it finished and any renumbering, for span tracking and views. */
export function runTasksTracked(store: TaskStore, args: TasksArgs, userTexts: readonly string[] = [], limits: PinLimits = PIN_LIMITS): { result: TaskResult; started: string[]; resumed: string[]; finished: string | null; renumbered: Renumbering[]; closed: Task[]; cascaded: Task[] } {
	const track = { started: [] as string[], resumed: [] as string[], finished: null as string | null, renumbered: [] as Renumbering[], closed: [] as Task[], cascaded: [] as Task[] };
	const result = runAction(store, args, track, userTexts, limits);
	return { result, ...track };
}

/** Finished tasks over all tasks, and the state an agent re-orients by (SPEC-0002 §3.4 status). */
export function statusOf(list: TaskList): Pick<TaskResult, "done" | "total" | "noGoal" | "doing" | "blocked" | "next"> {
	const blocked = list.tasks.flatMap((t) => {
		const b = currentBlock(t);
		return b ? [{ id: t.id, reason: b.reason, detail: b.detail, ...(b.on ? { on: b.on } : {}) }] : [];
	});
	const doing = list.tasks.filter((t) => t.status === "doing").map((t) => t.id);
	const next = nextTaskOf(list);
	return {
		done: list.tasks.filter((t) => FINISHED.has(t.status)).length,
		total: list.tasks.length,
		...(list.goals?.length ? {} : { noGoal: true as const }),
		...(doing.length ? { doing } : {}),
		...(blocked.length ? { blocked } : {}),
		...(next ? { next } : {}),
	};
}

/**
 * The task to pick up next: a dependency-blocked task whose dependency finished (resume it), else
 * the first leaf-most `todo` task not inside a branch waiting on the user or a third party.
 */
export function nextTaskOf(list: TaskList): (TaskRef & { resume?: true }) | null {
	const finished = (id: string | undefined) => {
		const t = id ? list.tasks.find((x) => x.id === id) : undefined;
		return !!t && FINISHED.has(t.status);
	};
	const ready = list.tasks.find((t) => {
		const b = currentBlock(t);
		return b?.reason === "dependency" && finished(b.on) && !list.tasks.some((c) => c.id.startsWith(`${t.id}.`) && currentBlock(c));
	});
	if (ready) return { id: ready.id, title: ready.title, resume: true };
	const waiting = list.tasks.filter((t) => {
		const b = currentBlock(t);
		return b && IDLE_REASONS.has(b.reason);
	});
	const todo = list.tasks.find((t) => t.status === "todo" && !list.tasks.some((c) => c.id.startsWith(`${t.id}.`)) && !waiting.some((w) => t.id.startsWith(`${w.id}.`)));
	return todo ? { id: todo.id, title: todo.title } : null;
}

/** One task id that changed because unstarted tasks were inserted or moved. */
export interface Renumbering {
	from: string;
	to: string;
}

function runAction(store: TaskStore, args: TasksArgs, track: { started: string[]; resumed: string[]; finished: string | null; renumbered: Renumbering[]; closed: Task[]; cascaded: Task[] }, userTexts: readonly string[], limits: PinLimits): TaskResult {
	const need = <K extends keyof TasksArgs>(k: K): NonNullable<TasksArgs[K]> => {
		const v = args[k];
		if (v === undefined || v === null || v === "") throw new TaskError("invalid_args", `Action "${args.action}" needs "${k}".`);
		return v as NonNullable<TasksArgs[K]>;
	};
	const ok: TaskResult = { ok: true };
	if ((args as { goal?: unknown }).goal !== undefined)
		throw new TaskError("invalid_args", 'Lists and tasks take "goals", not "goal": create {goals: ["…"]}, update {goals: {add: ["…"], remove: ["g1"], edit: [{id: "g2", text: "…"}]}}.');
	switch (args.action) {
		case "create": {
			const list = store.create(need("list"), need("title"), args.goals, args.tasks ?? [], userTexts, limits);
			const criteria = Object.fromEntries(list.tasks.filter((t) => t.acceptanceCriteria?.length).map((t) => [t.id, t.acceptanceCriteria!.map((c) => c.id)]));
			return { ok: true, list: list.slug, ids: list.tasks.map((t) => t.id), goals: (list.goals ?? []).map((g) => g.id), ...(Object.keys(criteria).length ? { criteria } : {}) };
		}
		case "list": {
			const { lists: all, invalid } = store.scan();
			const session = store.sessionId();
			const lists: Record<string, unknown>[] = all.map((l) => ({
				list: l.slug,
				title: l.title,
				done: l.tasks.filter((t) => FINISHED.has(t.status)).length,
				total: l.tasks.length,
				...(l.claim ? { claim: l.claim.session === session ? "this" : "other" } : {}),
				...(l.goals?.length ? {} : { noGoal: true }),
			}));
			for (const slug of invalid) lists.push({ list: slug, invalid: true });
			return { ok: true, lists };
		}
		case "claim":
			return { ok: true, ...statusOf(store.claim(need("list"), args.force === true)) };
		case "release":
			store.release(need("list"));
			return ok;
		case "add": {
			const { added, reused, order, superseded, renumbered } = store.add(need("list"), args.parent, need("tasks"), { before: args.before, after: args.after }, userTexts, limits);
			track.renumbered = renumbered;
			const abandoned = superseded.filter((t) => t.status === "abandoned").map((t) => t.id);
			const kept = superseded.filter((t) => t.status !== "abandoned").map((t) => t.id);
			const criteria = Object.fromEntries(added.filter((t) => t.acceptanceCriteria?.length).map((t) => [t.id, t.acceptanceCriteria!.map((c) => c.id)]));
			const goals = Object.fromEntries(added.filter((t) => t.goals?.length).map((t) => [t.id, t.goals!.map((g) => g.id)]));
			return {
				ok: true,
				ids: order.map((t) => t.id),
				...(reused.length ? { existing: reused.map((t) => t.id) } : {}),
				...(Object.keys(goals).length ? { goals } : {}),
				...(Object.keys(criteria).length ? { criteria } : {}),
				...(renumbered.length ? { renumbered: renumberMap(renumbered) } : {}),
				...(abandoned.length ? { abandoned } : {}),
				...(kept.length ? { superseded: kept } : {}),
			};
		}
		case "move": {
			const { renumbered } = store.move(need("list"), need("id"), args.parent, { before: args.before, after: args.after });
			track.renumbered = renumbered;
			return { ok: true, renumbered: renumberMap(renumbered) };
		}
		case "update": {
			const { added } = store.update(need("list"), args.id, { title: args.title, goals: args.goals, acceptanceCriteria: args.acceptanceCriteria });
			return { ok: true, ...added };
		}
		case "pin":
		case "unpin":
		case "attach":
		case "detach": {
			const items = args.action === "unpin" ? need("pins") : args.action === "detach" ? need("attachments") : need("items");
			const ids = store.references(need("list"), args.id, args.action, items, userTexts, limits);
			if (args.action === "pin") return { ok: true, pins: ids };
			if (args.action === "attach") {
				const list = store.read(need("list"));
				const holder = args.id === undefined ? list : list.tasks.find((t) => t.id === args.id);
				const attachments = (holder?.attachments ?? []).filter((a) => ids.includes(a.id)).map((a) => ({ id: a.id, ref: attachmentRef(a) }));
				return { ok: true, attachments };
			}
			return ok;
		}
		case "block": {
			const { ancestors } = store.block(need("list"), need("id"), args.reason, args.detail, args.blockedBy);
			return ancestors.length ? { ok: true, alsoBlocked: ancestors.map((t) => t.id) } : ok;
		}
		case "status":
			return { ok: true, ...statusOf(store.read(need("list"))) };
		case "start": {
			const { task, autoStarted, autoClosed, resumed } = store.start(need("list"), need("id"));
			track.started = [...autoStarted.map((t) => t.id), task.id];
			track.resumed = resumed.map((t) => t.id);
			track.closed = autoClosed;
			const entering = [...autoStarted, task];
			const ref = (t: Task): TaskRef => ({ id: t.id, title: t.title });
			const fresh = entering.filter((t) => !resumed.includes(t));
			const again = entering.filter((t) => resumed.includes(t));
			return {
				ok: true,
				...(fresh.length ? { started: fresh.map(ref) } : {}),
				...(again.length ? { resumed: again.map(ref) } : {}),
				...(autoClosed.length ? { closed: autoClosed.map((t) => ({ id: t.id, status: t.status })) } : {}),
			};
		}
		case "complete":
		case "fail":
		case "abandon": {
			const status = args.action === "complete" ? "done" : args.action === "fail" ? "failed" : "abandoned";
			const { task, list, parentReady, cascaded, blockedParents } = store.finish(need("list"), need("id"), status, args.report, args.supersededBy);
			track.finished = task.id;
			track.cascaded = cascaded;
			const next = parentReady ? null : nextTaskOf(list);
			return {
				ok: true,
				...(parentReady ? { parentReady: parentReady.id } : {}),
				...(blockedParents.length ? { resumable: blockedParents.map((t) => t.id) } : {}),
				...(cascaded.length ? { cascaded: cascaded.map((t) => t.id) } : {}),
				...(next ? { next } : {}),
			};
		}
		default:
			throw new TaskError("invalid_args", `Unknown action ${JSON.stringify((args as { action?: unknown }).action)}.`);
	}
}
