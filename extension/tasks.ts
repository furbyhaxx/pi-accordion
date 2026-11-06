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
import { BLOCK_REASONS, checkCriteria, compareIds, GOAL_MAX, MAX_DEPTH, parentId, parseListFile, toListFile, type BlockReason, type FlatList, type TaskStatus } from "./taskSchema";

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
	/** Checkable statements that are true when the task is finished. */
	acceptanceCriteria?: string[];
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
	/** The end state the whole list delivers. Absent only on a list migrated from v1 that has not been given one. */
	goal?: string;
	createdAt: string;
	updatedAt: string;
	claim: TaskClaim | null;
	tasks: Task[];
}

/** A task as the agent writes it in `create` / `add`. */
export interface TaskInput {
	title: string;
	acceptanceCriteria?: string[];
	subtasks?: TaskInput[];
	/** For `add`: the id of an earlier task this one replaces; that task is abandoned if it is still open. */
	supersedes?: string;
}

/** A rejected call: the message tells the agent how to recover. */
export class TaskError extends Error {}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TITLE_MAX = 200;
const OUTCOME_MAX = 600;
const ITEM_MAX = 240;
const ITEMS_MAX = 8;
/** A claim not refreshed for this long may be taken over without `force`. */
export const CLAIM_STALE_MS = 30 * 60_000;

export function tasksDir(projectDir: string): string {
	return path.join(projectDir, ".pig", "tasks");
}

function now(): string {
	return new Date().toISOString();
}

function assertSlug(slug: unknown): string {
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new TaskError(`Invalid list slug ${JSON.stringify(slug)}: use lowercase letters, digits and dashes, e.g. "auth-refactor".`);
	return slug;
}

function cleanTitle(title: unknown): string {
	if (typeof title !== "string" || !title.trim()) throw new TaskError("Every task needs a non-empty title.");
	const t = title.trim().replace(/\s+/g, " ");
	if (t.length > TITLE_MAX) throw new TaskError(`Task title too long (${t.length} > ${TITLE_MAX} chars): "${t.slice(0, 60)}…". Keep titles short; put detail in subtasks.`);
	return t;
}

/** Validate a report against the record's field budget; over-budget reports are rejected, not cut. */
export function cleanReport(report: unknown): TaskReport {
	if (!report || typeof report !== "object") throw new TaskError('A report is required: { outcome: "what was achieved", decisions?: ["choice — reason"], open?: ["unresolved item"] }.');
	const r = report as Record<string, unknown>;
	if (typeof r.outcome !== "string" || !r.outcome.trim()) throw new TaskError("report.outcome is required: one or two sentences on what this task achieved.");
	const outcome = r.outcome.trim();
	if (outcome.length > OUTCOME_MAX) throw new TaskError(`report.outcome is ${outcome.length} chars; keep it under ${OUTCOME_MAX}. Move detail into decisions or open.`);
	const list = (name: string, v: unknown): string[] | undefined => {
		if (v === undefined) return undefined;
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new TaskError(`report.${name} must be an array of strings.`);
		const items = (v as string[]).map((x) => x.trim()).filter(Boolean);
		if (items.length > ITEMS_MAX) throw new TaskError(`report.${name} has ${items.length} items; keep at most ${ITEMS_MAX}, the ones a later step needs.`);
		const long = items.find((x) => x.length > ITEM_MAX);
		if (long) throw new TaskError(`A report.${name} item is ${long.length} chars; keep each under ${ITEM_MAX}: "${long.slice(0, 60)}…".`);
		return items.length ? items : undefined;
	};
	const decisions = list("decisions", r.decisions);
	const open = list("open", r.open);
	return { outcome, ...(decisions ? { decisions } : {}), ...(open ? { open } : {}) };
}

function cleanGoal(goal: unknown): string {
	if (typeof goal !== "string" || !goal.trim()) throw new TaskError('A list needs a "goal": the end state the whole list delivers, e.g. "All token access goes through TokenStore; npm test passes."');
	const g = goal.trim().replace(/\s+/g, " ");
	if (g.length > GOAL_MAX) throw new TaskError(`"goal" is ${g.length} chars; keep it under ${GOAL_MAX}.`);
	return g;
}

function cleanCriteria(v: unknown, title: string): string[] {
	const errors: string[] = [];
	checkCriteria(v, `acceptanceCriteria of "${title}"`, errors);
	if (errors.length) throw new TaskError(`${errors[0]}.`);
	return (v as string[]).map((x) => x.trim().replace(/\s+/g, " "));
}

/** A task tree node; `kids` in sibling order. */
interface Node {
	task: Task;
	kids: Node[];
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
function nodesOf(inputs: unknown, depth: number, at: string, links: [Task, string][]): Node[] {
	if (!Array.isArray(inputs)) throw new TaskError("tasks must be an array of { title, acceptanceCriteria?, subtasks? }.");
	return inputs.map((raw) => {
		const input = raw as TaskInput;
		const title = cleanTitle(input?.title);
		if (depth > MAX_DEPTH) throw new TaskError(`"${title}" would be nested deeper than ${MAX_DEPTH} levels; flatten the plan.`);
		const task: Task = { id: "", title, status: "todo", createdAt: at, updatedAt: at };
		if (input.acceptanceCriteria !== undefined) task.acceptanceCriteria = cleanCriteria(input.acceptanceCriteria, title);
		const sup = input.supersedes;
		if (sup !== undefined) {
			if (typeof sup !== "string" || !sup.trim()) throw new TaskError(`"supersedes" of "${title}" must be a task id, e.g. "3.2".`);
			links.push([task, sup.trim()]);
		}
		return { task, kids: input.subtasks === undefined ? [] : nodesOf(input.subtasks, depth + 1, at, links) };
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
			throw new TaskError(`This would renumber ${t.id} "${t.title}" (${t.status}) to ${id}. Ids of started tasks never change; place the new work after it instead.`);
		if (id.split(".").length > MAX_DEPTH) throw new TaskError(`This would nest ${t.title} deeper than ${MAX_DEPTH} levels (${id}).`);
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

	private newClaim(): TaskClaim {
		const name = this.sessionName()?.trim();
		return { session: this.session(), at: now(), ...(name ? { name } : {}) };
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
		} catch {
			throw new TaskError(`No task list "${slug}". Use action "list" to see existing lists, or "create" to make one.`);
		}
		const rel = path.relative(this.projectDir, file);
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (err) {
			throw new TaskError(`Task list file ${rel} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it.`);
		}
		const parsed = parseListFile(json, slug, { requireGoal: false });
		if (!parsed.ok) throw new TaskError(`Task list file ${rel} is invalid:\n${parsed.errors.map((e) => `- ${e}`).join("\n")}\nFix the file; the format is in skill accordion-task-lists.`);
		const list = parsed.list as FlatList & Partial<TaskList>;
		// A hand-written file may leave out bookkeeping fields; the file's time stands in for them.
		const at = list.updatedAt ?? list.createdAt ?? fs.statSync(file).mtime.toISOString();
		list.createdAt ??= at;
		list.updatedAt ??= at;
		list.claim ??= null;
		for (const t of list.tasks) t.updatedAt ??= at;
		return list as TaskList;
	}

	private write(list: TaskList): void {
		const file = this.file(list.slug);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		list.updatedAt = now();
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(toListFile(list as unknown as FlatList), null, 2) + "\n");
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
		} catch {
			return { lists: [], invalid: [] };
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

	/** Create and claim a list. A list made without a goal (from the UI) gets one before work starts. */
	create(slug: string, title: string, goal: string | undefined, tasks: unknown): TaskList {
		if (fs.existsSync(this.file(slug))) throw new TaskError(`Task list "${slug}" already exists. Use "claim" to work on it, or pick another slug.`);
		const at = now();
		const list: TaskList = { slug, title: cleanTitle(title), ...(goal === undefined ? {} : { goal: cleanGoal(goal) }), createdAt: at, updatedAt: at, claim: this.newClaim(), tasks: [] };
		const links: [Task, string][] = [];
		const roots = nodesOf(tasks ?? [], 1, at, links);
		if (links.length) throw new TaskError('"supersedes" points at a task in the same list, so it only works with "add".');
		renumber(list, roots);
		this.write(list);
		return list;
	}

	/** Edit the list's title or goal (no `id`), or a task's title or acceptance criteria. */
	update(slug: string, id: string | undefined, fields: { title?: unknown; goal?: unknown; acceptanceCriteria?: unknown }): { list: TaskList; task?: Task; changed: string[] } {
		const list = this.owned(slug);
		const changed: string[] = [];
		if (id === undefined) {
			if (fields.acceptanceCriteria !== undefined) throw new TaskError('"acceptanceCriteria" belongs to a task; give its "id".');
			if (fields.title !== undefined) (list.title = cleanTitle(fields.title)), changed.push("title");
			if (fields.goal !== undefined) (list.goal = cleanGoal(fields.goal)), changed.push("goal");
		} else {
			const task = this.task(list, id);
			if (fields.goal !== undefined) throw new TaskError('"goal" belongs to the list; leave out "id".');
			if (FINISHED.has(task.status)) throw new TaskError(`Task ${id} is ${task.status}; a finished task's title and criteria stay as they were. Add a follow-up task instead.`);
			if (fields.title !== undefined) (task.title = cleanTitle(fields.title)), changed.push("title");
			if (fields.acceptanceCriteria !== undefined) (task.acceptanceCriteria = cleanCriteria(fields.acceptanceCriteria, task.title)), changed.push("acceptanceCriteria");
			if (changed.length) task.updatedAt = now();
			if (!changed.length) throw new TaskError('Nothing to update: give "title" or "acceptanceCriteria".');
			this.write(list);
			return { list, task, changed };
		}
		if (!changed.length) throw new TaskError('Nothing to update: give "title" or "goal".');
		this.write(list);
		return { list, changed };
	}

	/** A list that may grow or move on: it needs a goal first. */
	private planned(slug: string): TaskList {
		const list = this.owned(slug);
		if (!list.goal)
			throw new TaskError(`Task list "${slug}" has no goal yet. Set one first: tasks update {list: "${slug}", goal: "<the end state this list delivers>"}. Ending a running task works without it.`);
		return list;
	}

	/** Claim a list for this session. A live claim held by another session needs `force`. */
	claim(slug: string, force = false): TaskList {
		const list = this.read(slug);
		const held = list.claim;
		if (held && held.session !== this.session() && !force && claimState(list, this.session()) === "held")
			throw new TaskError(`Task list "${slug}" is claimed by another session (since ${held.at}). Ask the user before taking it over with force: true.`);
		list.claim = this.newClaim();
		this.write(list);
		return list;
	}

	/** Release a list owned by this session; reject unowned lists without changing them. */
	release(slug: string): void {
		const list = this.read(slug);
		if (list.claim?.session !== this.session()) throw new TaskError(`Task list "${slug}" is not claimed by this session; nothing was released.`);
		list.claim = null;
		this.write(list);
	}

	/** Read a list this session holds, refreshing the claim. */
	private owned(slug: string): TaskList {
		const list = this.read(slug);
		if (list.claim?.session !== this.session()) throw new TaskError(`Task list "${slug}" is not claimed by this session. Call "claim" first.`);
		list.claim.at = now();
		return list;
	}

	private task(list: TaskList, id: unknown): Task {
		const t = typeof id === "string" ? list.tasks.find((x) => x.id === id) : undefined;
		if (!t) throw new TaskError(`No task ${JSON.stringify(id)} in "${list.slug}". Use "status" to see task ids.`);
		return t;
	}

	/**
	 * Where new or moved tasks go: under `parent` (top level when absent), at the end or next to a
	 * sibling named by `before`/`after`. The anchor fixes the parent when `parent` is left out.
	 */
	private place(list: TaskList, roots: Node[], parent: string | undefined, before: unknown, after: unknown): { siblings: Node[]; index: number; parent: string | null } {
		if (before !== undefined && after !== undefined) throw new TaskError('Give "before" or "after", not both.');
		const anchor = before ?? after;
		if (anchor !== undefined) {
			const a = this.task(list, anchor);
			const p = parentOf(a.id);
			if (parent !== undefined && parent !== (p ?? "")) throw new TaskError(`Task ${a.id} is not a subtask of ${parent || "the top level"}; leave out "parent" to place next to ${a.id}.`);
			const hit = findNode(roots, a.id)!;
			return { siblings: hit.siblings, index: hit.siblings.indexOf(hit.node) + (after !== undefined ? 1 : 0), parent: p };
		}
		if (parent === undefined || parent === "") return { siblings: roots, index: roots.length, parent: null };
		const node = findNode(roots, this.task(list, parent).id)!.node;
		return { siblings: node.kids, index: node.kids.length, parent: node.task.id };
	}

	/** Add tasks; a task with `supersedes` replaces an earlier one, abandoning it if it is still open. */
	add(slug: string, parent: string | undefined, tasks: unknown, position: { before?: unknown; after?: unknown } = {}): { added: Task[]; superseded: Task[]; renumbered: { from: string; to: string }[] } {
		const list = this.planned(slug);
		const roots = treeOf(list.tasks);
		const at = now();
		const spot = this.place(list, roots, parent, position.before, position.after);
		if (spot.parent !== null && FINISHED.has(this.task(list, spot.parent).status))
			throw new TaskError(`Task ${spot.parent} is ${this.task(list, spot.parent).status}; add the new work at the top level or under an open task.`);
		const links: [Task, string][] = [];
		const nodes = nodesOf(tasks, (spot.parent?.split(".").length ?? 0) + 1, at, links);
		const superseded: Task[] = [];
		const pairs: [Task, Task][] = [];
		for (const [by, old] of links) {
			const t = this.task(list, old);
			pairs.push([by, t]);
			if (t.status === "doing") throw new TaskError(`Task ${old} is in progress; end it before a new task supersedes it.`);
			if (t.status === "done") throw new TaskError(`Task ${old} is done; nothing to supersede. Add the new task without "supersedes".`);
			if (spot.parent !== null && isWithin(spot.parent, old)) throw new TaskError(`Task ${old} contains the new task, so it cannot be superseded by it.`);
			superseded.push(t);
		}
		spot.siblings.splice(spot.index, 0, ...nodes);
		const renumbered = renumber(list, roots);
		for (const [by, oldTask] of pairs) {
			if (oldTask.status === "todo" || oldTask.status === "blocked") abandon(oldTask, { outcome: `Superseded by ${by.id}.` }, at);
			oldTask.supersededBy = by.id;
			oldTask.updatedAt = at;
		}
		const added: Task[] = [];
		const collect = (ns: Node[]) => ns.forEach((n) => (added.push(n.task), collect(n.kids)));
		collect(nodes);
		this.write(list);
		return { added, superseded, renumbered };
	}

	/** Move an unstarted task with its subtasks under another parent or next to a sibling. */
	move(slug: string, id: string, parent: string | undefined, position: { before?: unknown; after?: unknown }): { task: Task; renumbered: { from: string; to: string }[] } {
		const list = this.planned(slug);
		const task = this.task(list, id);
		const started = list.tasks.filter((t) => isWithin(t.id, id) && t.status !== "todo");
		if (started.length)
			throw new TaskError(`${started[0].id} has ${started[0].status === "doing" ? "started" : `been ${started[0].status}`}, so ${id} cannot move: ids of started tasks never change. To change the plan, add new work with tasks add {list: "${slug}", after: "${id}", tasks: [...]} or abandon what is no longer wanted.`);
		if (parent === undefined && position.before === undefined && position.after === undefined) throw new TaskError('Say where to move it: "parent", "before" or "after".');
		for (const target of [parent, position.before, position.after])
			if (typeof target === "string" && target && isWithin(target, id)) throw new TaskError(`Task ${target} is inside ${id}; a task cannot move into its own subtree.`);
		const roots = treeOf(list.tasks);
		const from = findNode(roots, id)!;
		const spot = this.place(list, roots, parent, position.before, position.after);
		if (spot.parent !== null && FINISHED.has(this.task(list, spot.parent).status))
			throw new TaskError(`Task ${spot.parent} is ${this.task(list, spot.parent).status}; move ${id} under an open task or to the top level.`);
		const index = from.siblings === spot.siblings && from.siblings.indexOf(from.node) < spot.index ? spot.index - 1 : spot.index;
		from.siblings.splice(from.siblings.indexOf(from.node), 1);
		spot.siblings.splice(index, 0, from.node);
		const renumbered = renumber(list, roots);
		if (!renumbered.length) throw new TaskError(`Task ${id} is already there.`);
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
			throw new TaskError(`A block needs "reason": one of ${BLOCK_REASONS.map((r) => `"${r}"`).join(", ")}.`);
		if (typeof detail !== "string" || !detail.trim()) throw new TaskError('A block needs "detail": what exactly the task waits for, e.g. "the user must choose between Postgres and SQLite".');
		const text = detail.trim().replace(/\s+/g, " ");
		if (text.length > ITEM_MAX) throw new TaskError(`"detail" is ${text.length} chars; keep it under ${ITEM_MAX}.`);
		if (task.status !== "doing") throw new TaskError(`Task ${id} is ${task.status}; only a task in progress can be blocked.`);
		const inner = list.tasks.filter((t) => t.id !== id && isWithin(t.id, id) && t.status === "doing");
		if (inner.length) throw new TaskError(`Subtask ${inner.map((t) => t.id).join(", ")} of ${id} is in progress. Block that subtask instead, or end it first.`);
		let dep: string | undefined;
		if (reason === "dependency") {
			if (typeof on !== "string" || !on.trim()) throw new TaskError('A "dependency" block needs "blockedBy": the id of the task this one waits for.');
			const target = this.task(list, on.trim());
			if (isWithin(target.id, id) || isWithin(id, target.id)) throw new TaskError(`Task ${target.id} is ${isWithin(target.id, id) ? "inside" : "a parent of"} ${id}; a task cannot wait for its own branch.`);
			if (FINISHED.has(target.status)) throw new TaskError(`Task ${target.id} is already ${target.status}; ${id} does not wait for it. Continue ${id}.`);
			dep = target.id;
		} else if (on !== undefined) throw new TaskError('"blockedBy" only goes with reason "dependency".');
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
		if (task.status === "doing") throw new TaskError(`Task ${id} is already in progress.`);
		if (task.status !== "todo" && task.status !== "blocked")
			throw new TaskError(`Task ${id} is ${task.status}. Add a follow-up task (with "supersedes": "${id}") instead of restarting it.`);
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
			throw new TaskError(
				`Task ${blocking.map((t) => `${t.id} "${t.title}"`).join(", ")} is still in progress. Complete, fail or abandon it with a report before starting ${id}, or start one of its subtasks.`,
			);
		const started: Task[] = [];
		for (let p = parentOf(id); p !== null; p = parentOf(p)) {
			const anc = list.tasks.find((t) => t.id === p);
			if (anc?.status === "todo" || anc?.status === "blocked") started.unshift(anc);
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
			if (task.status === "blocked") throw new TaskError(`Task ${id} is blocked. Resume it with start before you ${verb} it, or abandon it.`);
			if (task.status === "todo") throw new TaskError(`Task ${id} was never started. Start it first, or abandon it with a report if it is no longer needed.`);
			throw new TaskError(`Task ${id} is ${task.status}, not in progress. Check "status".`);
		}
		const below = list.tasks.filter((t) => t.id !== id && isWithin(t.id, id));
		const openChildren = below.filter((t) => t.status === "doing");
		if (openChildren.length) throw new TaskError(`Subtask ${openChildren.map((t) => t.id).join(", ")} of ${id} is still in progress. End it first.`);
		const unfinished = below.filter((t) => t.status === "todo" || t.status === "blocked");
		if (status === "done" && unfinished.length)
			throw new TaskError(
				`Subtask ${unfinished.map((t) => `${t.id} (${t.status === "todo" ? "not started" : "blocked"})`).join(", ")} of ${id} ${unfinished.length === 1 ? "is" : "are"} unfinished. Start and finish ${unfinished.length === 1 ? "it" : "them"}, or abandon ${unfinished.length === 1 ? "it" : "them"} with a report (and "supersededBy" when another task replaces ${unfinished.length === 1 ? "it" : "them"}) before completing ${id}.`,
			);
		let replacement: string | undefined;
		if (supersededBy !== undefined) {
			if (status !== "abandoned") throw new TaskError('"supersededBy" only goes with "abandon".');
			if (typeof supersededBy !== "string" || !supersededBy.trim()) throw new TaskError('"supersededBy" must be a task id, e.g. "9.3".');
			const by = this.task(list, supersededBy.trim());
			if (isWithin(by.id, id)) throw new TaskError(`Task ${by.id} is part of ${id}, so it cannot replace it.`);
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
	const lines = [`${list.slug} — ${list.title}${list.claim ? `  (claimed ${list.claim.at})` : ""}`, list.goal ? `goal: ${list.goal}` : `goal: none yet — set it with update {list: "${list.slug}", goal}`];
	for (const t of list.tasks) {
		const b = currentBlock(t);
		const note = b ? `  (blocked: ${blockLabel(b)} — ${b.detail})` : t.supersededBy ? `  (superseded by ${t.supersededBy})` : "";
		lines.push(`${"  ".repeat(t.id.split(".").length)}${MARK[t.status]} ${t.id} ${t.title}${note}`);
	}
	return lines.join("\n");
}

export const TASK_ACTIONS = ["create", "list", "claim", "release", "add", "update", "move", "status", "start", "block", "complete", "fail", "abandon"] as const;

/** The tool's argument shape; every field but `action` depends on the action. */
export interface TasksArgs {
	action: (typeof TASK_ACTIONS)[number];
	list?: string;
	title?: string;
	/** For create and update: the end state the whole list delivers. */
	goal?: string;
	/** For update: a task's new acceptance criteria. */
	acceptanceCriteria?: string[];
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

function renumberLine(renumbered: readonly { from: string; to: string }[]): string {
	return `Renumbered: ${renumbered.map((r) => `${r.from} → ${r.to}`).join(", ")}. Use the new ids from now on.`;
}

/** Run one `tasks` tool call. Rejections throw `TaskError` with recovery guidance. */
export function runTasks(store: TaskStore, args: TasksArgs): string {
	return runTasksTracked(store, args).text;
}

/** A `tasks` call's text plus the task ids it started, the one it finished and any renumbering, for span tracking and views. */
export function runTasksTracked(store: TaskStore, args: TasksArgs): { text: string; started: string[]; finished: string | null; renumbered: Renumbering[] } {
	let started: string[] = [];
	let finished: string | null = null;
	let renumbered: Renumbering[] = [];
	const text = runAction(store, args, (ids) => (started = ids), (id) => (finished = id), (r) => (renumbered = r));
	return { text, started, finished, renumbered };
}

/** One task id that changed because unstarted tasks were inserted or moved. */
export interface Renumbering {
	from: string;
	to: string;
}

function runAction(store: TaskStore, args: TasksArgs, onStart: (ids: string[]) => void, onFinish: (id: string) => void, onRenumber: (r: Renumbering[]) => void): string {
	const need = <K extends keyof TasksArgs>(k: K): NonNullable<TasksArgs[K]> => {
		const v = args[k];
		if (v === undefined || v === null || v === "") throw new TaskError(`Action "${args.action}" needs "${k}".`);
		return v as NonNullable<TasksArgs[K]>;
	};
	switch (args.action) {
		case "create": {
			const list = store.create(need("list"), need("title"), cleanGoal(args.goal), args.tasks ?? []);
			return `Created and claimed task list:\n${renderList(list)}`;
		}
		case "list": {
			const { lists: all, invalid } = store.scan();
			if (!all.length && !invalid.length) return "No task lists in this project yet.";
			const lines = all.map((l) => `${l.slug} — ${l.title} (${l.tasks.filter((t) => t.status === "done").length}/${l.tasks.length} done${l.claim ? ", claimed" : ""}${l.goal ? "" : ", no goal"})`);
			for (const slug of invalid) lines.push(`${slug} — invalid file; "status" shows what to fix`);
			return lines.join("\n");
		}
		case "claim":
			return `Claimed:\n${renderList(store.claim(need("list"), args.force === true))}`;
		case "release":
			store.release(need("list"));
			return `Released "${args.list}".`;
		case "add": {
			const { added, superseded, renumbered } = store.add(need("list"), args.parent, need("tasks"), { before: args.before, after: args.after });
			onRenumber(renumbered);
			const lines = [`Added ${added.map((t) => `${t.id} ${t.title}`).join(", ")}.`];
			for (const t of superseded) lines.push(`${t.id} "${t.title}" is superseded by ${t.supersededBy}${t.report?.outcome?.startsWith("Superseded by") ? " and was abandoned" : ""}.`);
			if (renumbered.length) lines.push(renumberLine(renumbered));
			return lines.join("\n");
		}
		case "move": {
			const { task, renumbered } = store.move(need("list"), need("id"), args.parent, { before: args.before, after: args.after });
			onRenumber(renumbered);
			return `Moved ${args.id} "${task.title}" to ${task.id}.\n${renumberLine(renumbered)}`;
		}
		case "update": {
			const { list, task, changed } = store.update(need("list"), args.id, { title: args.title, goal: args.goal, acceptanceCriteria: args.acceptanceCriteria });
			return `Updated ${changed.join(" and ")} of ${task ? `${list.slug}/${task.id} "${task.title}"` : `list "${list.slug}"`}.`;
		}
		case "block": {
			const { task, ancestors } = store.block(need("list"), need("id"), args.reason, args.detail, args.blockedBy);
			const b = currentBlock(task)!;
			const lines = [`Blocked ${args.list}/${task.id} "${task.title}": ${blockLabel(b)} — ${b.detail}.`];
			for (const t of ancestors) lines.push(`Also blocked parent ${t.id} "${t.title}" until ${task.id} resumes.`);
			lines.push(
				IDLE_REASONS.has(b.reason)
					? `Tell the user exactly what you need, then continue with another task that does not depend on it, or stop if none is left. Resume with start ${task.id} once it is resolved.`
					: `Work on ${b.on} now; resume with start ${task.id} once it is finished.`,
			);
			return lines.join("\n");
		}
		case "status":
			return renderList(store.read(need("list")));
		case "start": {
			const { task, autoStarted, autoClosed, resumed } = store.start(need("list"), need("id"));
			onStart([...autoStarted.map((t) => t.id), task.id]);
			const was = (t: Task) => resumed.includes(t);
			const lines = [`${was(task) ? "Resumed" : "Started"} ${args.list}/${task.id} "${task.title}".`];
			for (const t of autoStarted) lines.push(`Also ${was(t) ? "resumed" : "started"} parent ${t.id} "${t.title}" so its span covers this subtask.`);
			for (const t of autoClosed)
				lines.push(`Closed ${t.id} "${t.title}" as ${t.status} from its subtasks' reports, because you moved on without completing it. Complete a parent with its own report right after its last subtask.`);
			return lines.join("\n");
		}
		case "complete":
		case "fail":
		case "abandon": {
			const status = args.action === "complete" ? "done" : args.action === "fail" ? "failed" : "abandoned";
			const { task, parentReady, cascaded, blockedParents } = store.finish(need("list"), need("id"), status, args.report, args.supersededBy);
			onFinish(task.id);
			const lines = [`${args.list}/${task.id} "${task.title}" is ${status}${task.supersededBy && args.action === "abandon" ? `, superseded by ${task.supersededBy}` : ""}.`];
			if (cascaded.length) lines.push(`Also abandoned its unfinished subtask${cascaded.length === 1 ? "" : "s"} ${cascaded.map((t) => t.id).join(", ")}.`);
			for (const t of blockedParents) lines.push(`Parent ${t.id} "${t.title}" was blocked on ${task.id}; resume it with start ${t.id}, or abandon it.`);
			if (parentReady) lines.push(`All subtasks of ${parentReady.id} "${parentReady.title}" are finished: complete ${parentReady.id} now with its own report, or add more subtasks to it.`);
			return lines.join("\n");
		}
		default:
			throw new TaskError(`Unknown action ${JSON.stringify((args as { action?: unknown }).action)}.`);
	}
}
