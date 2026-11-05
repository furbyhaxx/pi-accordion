/*
 * tasks.ts — persistent, project-scoped task lists for the `tasks` tool.
 *
 * One list per file at `<project>/.pig/tasks/<slug>.json`. The file is the authority for structure,
 * status and claims; the session transcript only carries the tool calls and their results, which
 * is what the Taskfold conductor reads to find task spans.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type TaskStatus = "todo" | "doing" | "done" | "failed" | "abandoned";

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
	report?: TaskReport;
	updatedAt: string;
	/** When the task was started; absent for tasks never started (or written before timing existed). */
	startedAt?: string;
	/** When the task was completed, failed or abandoned. */
	endedAt?: string;
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
	createdAt: string;
	updatedAt: string;
	claim: TaskClaim | null;
	tasks: Task[];
}

/** A task as the agent writes it in `create` / `add`. */
export interface TaskInput {
	title: string;
	subtasks?: TaskInput[];
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

function flatten(inputs: unknown, prefix: string, startIndex: number, out: Task[], at: string): void {
	if (!Array.isArray(inputs)) throw new TaskError("tasks must be an array of { title, subtasks? }.");
	inputs.forEach((input, i) => {
		const id = prefix ? `${prefix}.${startIndex + i}` : String(startIndex + i);
		out.push({ id, title: cleanTitle((input as TaskInput)?.title), status: "todo", updatedAt: at });
		const subs = (input as TaskInput)?.subtasks;
		if (subs !== undefined) flatten(subs, id, 1, out, at);
	});
}

function parentOf(id: string): string | null {
	const dot = id.lastIndexOf(".");
	return dot < 0 ? null : id.slice(0, dot);
}

function isWithin(id: string, ancestor: string): boolean {
	return id === ancestor || id.startsWith(ancestor + ".");
}

/** Order ids numerically per segment, so `1.10` follows `1.9`. */
function compareIds(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? -1) - (pb[i] ?? -1);
		if (d) return d;
	}
	return 0;
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
		let parsed: TaskList;
		try {
			parsed = JSON.parse(raw) as TaskList;
		} catch {
			throw new TaskError(`Task list file ${path.relative(this.projectDir, file)} is not valid JSON; fix or remove it.`);
		}
		if (!parsed || parsed.slug !== slug || !Array.isArray(parsed.tasks)) throw new TaskError(`Task list file ${path.relative(this.projectDir, file)} is malformed.`);
		return parsed;
	}

	private write(list: TaskList): void {
		const file = this.file(list.slug);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		list.updatedAt = now();
		list.tasks.sort((a, b) => compareIds(a.id, b.id));
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
		fs.renameSync(tmp, file);
	}

	/** Every list in the project, newest first. Unreadable files are skipped. */
	lists(): TaskList[] {
		let names: string[];
		try {
			names = fs.readdirSync(tasksDir(this.projectDir));
		} catch {
			return [];
		}
		const out: TaskList[] = [];
		for (const n of names) {
			if (!n.endsWith(".json")) continue;
			try {
				out.push(this.read(n.slice(0, -5)));
			} catch {
				/* skip malformed */
			}
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	create(slug: string, title: string, tasks: unknown): TaskList {
		if (fs.existsSync(this.file(slug))) throw new TaskError(`Task list "${slug}" already exists. Use "claim" to work on it, or pick another slug.`);
		const at = now();
		const list: TaskList = { slug, title: cleanTitle(title), createdAt: at, updatedAt: at, claim: this.newClaim(), tasks: [] };
		flatten(tasks ?? [], "", 1, list.tasks, at);
		this.write(list);
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

	add(slug: string, parent: string | undefined, tasks: unknown): Task[] {
		const list = this.owned(slug);
		if (parent !== undefined) this.task(list, parent);
		const siblings = list.tasks.filter((t) => parentOf(t.id) === (parent ?? null)).length;
		const added: Task[] = [];
		flatten(tasks, parent ?? "", siblings + 1, added, now());
		list.tasks.push(...added);
		this.write(list);
		return added;
	}

	/**
	 * Start a task. Nesting is a stack: a task may start while its ancestors are open; starting a task
	 * outside the innermost open one is rejected, because the span boundaries would interleave.
	 */
	start(slug: string, id: string): { list: TaskList; task: Task } {
		const list = this.owned(slug);
		const task = this.task(list, id);
		if (task.status === "doing") throw new TaskError(`Task ${id} is already in progress.`);
		if (task.status !== "todo") throw new TaskError(`Task ${id} is ${task.status}. Add a follow-up task instead of restarting it.`);
		const open = list.tasks.filter((t) => t.status === "doing");
		const blocking = open.filter((t) => !isWithin(id, t.id));
		if (blocking.length)
			throw new TaskError(`Task ${blocking.map((t) => `${t.id} "${t.title}"`).join(", ")} is still in progress. Complete, fail or abandon it before starting ${id}, or start one of its subtasks.`);
		task.status = "doing";
		task.updatedAt = now();
		task.startedAt = task.updatedAt;
		this.write(list);
		return { list, task };
	}

	/** End a task as done, failed or abandoned. Open subtasks block it. */
	finish(slug: string, id: string, status: "done" | "failed" | "abandoned", report: unknown): { list: TaskList; task: Task } {
		const list = this.owned(slug);
		const task = this.task(list, id);
		if (task.status !== "doing") throw new TaskError(`Task ${id} is ${task.status}, not in progress. Start it first, or check "status".`);
		const openChildren = list.tasks.filter((t) => t.id !== id && isWithin(t.id, id) && t.status === "doing");
		if (openChildren.length) throw new TaskError(`Subtask ${openChildren.map((t) => t.id).join(", ")} of ${id} is still in progress. End it first.`);
		task.report = cleanReport(report);
		task.status = status;
		task.updatedAt = now();
		task.endedAt = task.updatedAt;
		this.write(list);
		return { list, task };
	}
}

const MARK: Record<TaskStatus, string> = { todo: "[ ]", doing: "[~]", done: "[x]", failed: "[!]", abandoned: "[-]" };

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
	const lines = [`${list.slug} — ${list.title}${list.claim ? `  (claimed ${list.claim.at})` : ""}`];
	for (const t of list.tasks) lines.push(`${"  ".repeat(t.id.split(".").length)}${MARK[t.status]} ${t.id} ${t.title}`);
	return lines.join("\n");
}

/** The tool's argument shape; every field but `action` depends on the action. */
export interface TasksArgs {
	action: "create" | "list" | "claim" | "release" | "add" | "status" | "start" | "complete" | "fail" | "abandon";
	list?: string;
	title?: string;
	tasks?: TaskInput[];
	parent?: string;
	id?: string;
	report?: TaskReport;
	force?: boolean;
}

/** Run one `tasks` tool call. Rejections throw `TaskError` with recovery guidance. */
export function runTasks(store: TaskStore, args: TasksArgs): string {
	const need = <K extends keyof TasksArgs>(k: K): NonNullable<TasksArgs[K]> => {
		const v = args[k];
		if (v === undefined || v === null || v === "") throw new TaskError(`Action "${args.action}" needs "${k}".`);
		return v as NonNullable<TasksArgs[K]>;
	};
	switch (args.action) {
		case "create": {
			const list = store.create(need("list"), need("title"), args.tasks ?? []);
			return `Created and claimed task list:\n${renderList(list)}`;
		}
		case "list": {
			const all = store.lists();
			if (!all.length) return "No task lists in this project yet.";
			return all.map((l) => `${l.slug} — ${l.title} (${l.tasks.filter((t) => t.status === "done").length}/${l.tasks.length} done${l.claim ? ", claimed" : ""})`).join("\n");
		}
		case "claim":
			return `Claimed:\n${renderList(store.claim(need("list"), args.force === true))}`;
		case "release":
			store.release(need("list"));
			return `Released "${args.list}".`;
		case "add": {
			const added = store.add(need("list"), args.parent, need("tasks"));
			return `Added ${added.map((t) => `${t.id} ${t.title}`).join(", ")}.`;
		}
		case "status":
			return renderList(store.read(need("list")));
		case "start": {
			const { task } = store.start(need("list"), need("id"));
			return `Started ${args.list}/${task.id} "${task.title}".`;
		}
		case "complete":
		case "fail":
		case "abandon": {
			const status = args.action === "complete" ? "done" : args.action === "fail" ? "failed" : "abandoned";
			const { task } = store.finish(need("list"), need("id"), status, args.report);
			return `${args.list}/${task.id} "${task.title}" is ${status}.`;
		}
		default:
			throw new TaskError(`Unknown action ${JSON.stringify((args as { action?: unknown }).action)}.`);
	}
}
