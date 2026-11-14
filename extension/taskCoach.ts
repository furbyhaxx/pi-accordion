/*
 * taskCoach.ts — keeps the agent on the task protocol: counts tool work inside each task's span and
 * work done while no task is in progress, and words the reminders appended to tool results.
 * Pure state plus text; the extension feeds it tool results and the attached list.
 */
import { charsToTokens } from "../core/tokens";
import { currentBlock, IDLE_REASONS, type Task, type TaskBlock, type TaskList } from "./tasks";
import { floorFoldNote, largeLeafReminder, saturationNote } from "./taskBinding";

/**
 * Calls allowed before coaching starts. Orientation — reading the request, the specs, the code —
 * is real work that may need no task yet, so the count is a configuration value, not a guess.
 */
export const DEFAULT_ORIENTATION_CALLS = 10;

/** Tool results that must pass before the agent is told about saturation again. */
const SATURATION_NOTE_GAP = 50;

/** When a leaf is large enough to be worth ending: a share of the budget or a count of tool results. */
export interface LargeLeafTap {
	budgetShare: number;
	toolResults: number;
}

/** `coach` reminds, `gate` refuses with the repair, `off` says nothing. */
export type EnforceMode = "coach" | "gate" | "off";

/** The coach's configuration; the extension re-reads it from settings on every call. */
export interface CoachPolicy {
	orientationCalls: number;
	enforce: EnforceMode;
	/** Consecutive refusals before the gate first opens for 50 calls. */
	gateFailOpenAfter: number;
	/** A blocked task stops the run, so nothing else can be named as next. */
	stopOnBlock: boolean;
	largeLeaf: LargeLeafTap;
	/** Effective budget in tokens for this model; the share is measured against it. */
	budget: number | null;
}

/** What the gate decided about one call: block it, and/or report that it gave up. */
export interface CallDecision {
	refuse?: string;
	/** The gate opened after `gateFailOpenAfter` refusals; the extension notifies once. */
	opened?: boolean;
}

function ancestors(id: string): string[] {
	const out: string[] = [];
	for (let i = id.lastIndexOf("."); i > 0; i = id.lastIndexOf(".", i - 1)) out.push(id.slice(0, i));
	return out;
}

function innermostDoing(list: TaskList): Task | null {
	const doing = list.tasks.filter((t) => t.status === "doing");
	return doing.find((t) => !doing.some((o) => o.id.startsWith(`${t.id}.`))) ?? null;
}

/**
 * The task the agent should pick up next: a task blocked on a dependency that has since finished
 * (resume it), else the first task not started outside a branch blocked on something it cannot fix.
 */
export function nextTask(list: TaskList, stopOnBlock = true): { task: Task; resume: boolean } | null {
	const finished = (id: string | undefined) => {
		const t = id ? list.tasks.find((x) => x.id === id) : undefined;
		return !!t && (t.status === "done" || t.status === "failed" || t.status === "abandoned");
	};
	const ready = list.tasks.find((t) => {
		const b = currentBlock(t);
		return b?.reason === "dependency" && finished(b.on) && !list.tasks.some((c) => c.id.startsWith(`${t.id}.`) && currentBlock(c));
	});
	if (ready) return { task: ready, resume: true };
	const waiting = list.tasks.filter((t) => {
		const b = currentBlock(t);
		return b && IDLE_REASONS.has(b.reason);
	});
	// With stopOnBlock the store refuses to start anything else while a task waits, so naming one
	// here would send the agent into a refusal loop; the run is stopped until the task resumes.
	if (stopOnBlock && waiting.length) return null;
	const todo = list.tasks.find((t) => t.status === "todo" && !waiting.some((w) => t.id.startsWith(`${w.id}.`)));
	return todo ? { task: todo, resume: false } : null;
}

/** Session entry recording each agent stop's `IdleVerdict` for the attached list. */
export const IDLE_ENTRY = "accordion.tasks.idle";

/** Where the agent stands when it stops: still working, legitimately waiting, or stopped early. */
export type IdleVerdict =
	| { state: "in-progress"; task: string }
	| { state: "waiting"; tasks: { id: string; reason: TaskBlock["reason"] }[] }
	| { state: "pending"; next: string }
	| { state: "finished" };

/**
 * Judge an agent's stop against its list. `in-progress` and `pending` (open work it could have
 * continued) are premature stops; `waiting` (every remaining task waits on the user or a third
 * party) and `finished` are allowed.
 */
export function idleVerdict(list: TaskList, stopOnBlock = true): IdleVerdict {
	const doing = innermostDoing(list);
	if (doing) return { state: "in-progress", task: doing.id };
	const next = nextTask(list, stopOnBlock);
	if (next) return { state: "pending", next: next.task.id };
	const waiting = list.tasks.flatMap((t) => {
		const b = currentBlock(t);
		return b && IDLE_REASONS.has(b.reason) && !list.tasks.some((c) => c.id.startsWith(`${t.id}.`) && currentBlock(c)) ? [{ id: t.id, reason: b.reason }] : [];
	});
	return waiting.length ? { state: "waiting", tasks: waiting } : { state: "finished" };
}

/** Assistant text longer than this inside a span counts as work, e.g. an analysis answered in prose. */
export const TEXT_WORK_CHARS = 40;

export class TaskCoach {
	private list: TaskList | null = null;
	private policy: CoachPolicy = {
		orientationCalls: DEFAULT_ORIENTATION_CALLS,
		enforce: "coach",
		gateFailOpenAfter: 3,
		stopOnBlock: true,
		largeLeaf: { budgetShare: 0.15, toolResults: 25 },
		budget: null,
	};
	/** Non-exempt calls since the last user prompt. */
	private calls = 0;
	private refusals = 0;
	private opened = false;
	private openCalls = 0;
	private untracked = 0;
	private lastReminder = 0;
	private reminderInterval = 0;
	/** `<list>/<id>` → tool results and assistant texts inside that task's span since this process saw it. */
	private readonly work = new Map<string, number>();
	private readonly spanTokens = new Map<string, number>();
	private readonly tapped = new Map<string, { results: number; tokens: number }>();
	/** A pressure fold that touched the current leaf, waiting for the next tool result to carry it. */
	private floorNote: { task: string; slug: string; id: string; title: string } | null = null;
	private saturated = false;
	private saturationHolder: { slug: string; id: string; tokens: number } | null | undefined = undefined;
	/** Tool results since the last saturation note: a session that keeps tipping in and out of saturation is not told each time. */
	private sinceSaturationNote = Infinity;

	/** The list this session works on; null when none is attached. */
	setList(list: TaskList | null): void {
		this.list = list;
	}

	setPolicy(policy: CoachPolicy): void {
		this.policy = policy;
	}

	/** A new user prompt starts a fresh run: the orientation allowance and the reminders reset. */
	userPrompt(): void {
		this.calls = 0;
		this.refusals = 0;
		this.opened = false;
		this.openCalls = 0;
		this.untracked = 0;
		this.lastReminder = 0;
		this.reminderInterval = 0;
	}

	/** Tasks just started or resumed (with any auto-started parents). */
	started(slug: string, ids: readonly string[]): void {
		// A tool call batched with the start may report before it, and a resumed task keeps its work.
		for (const id of ids) if (!this.work.has(`${slug}/${id}`)) this.work.set(`${slug}/${id}`, 0);
		this.calls = 0;
	}

	/**
	 * A non-exempt tool call is about to run. Nested calls count as work but are never refused, so a
	 * blocking decision always belongs to an outer call the model can see.
	 */
	callStarted(nested: boolean): CallDecision {
		this.calls++;
		const policy = this.policy;
		if (policy.enforce !== "gate") return {};
		const list = this.list;
		if (list && innermostDoing(list)) return {};
		if (this.calls <= policy.orientationCalls) return {};
		if (this.opened) {
			if (this.openCalls < 50 || nested) {
				this.openCalls++;
				return {};
			}
			this.openCalls = 0;
			return { refuse: list ? noLeafRefusal(list, this.calls) : noListRefusal(this.calls) };
		}
		if (nested) return {};
		if (this.refusals >= policy.gateFailOpenAfter) {
			this.opened = true;
			this.openCalls = 1;
			return { opened: true };
		}
		this.refusals++;
		return { refuse: list ? noLeafRefusal(list, this.calls) : noListRefusal(this.calls) };
	}

	private countWork(list: TaskList, current: Task, tokens = 0): void {
		for (const id of [current.id, ...ancestors(current.id)]) {
			const key = `${list.slug}/${id}`;
			this.work.set(key, (this.work.get(key) ?? 0) + 1);
			if (tokens) this.spanTokens.set(key, (this.spanTokens.get(key) ?? 0) + tokens);
		}
	}

	/** Remind when a leaf crosses a size threshold and when either measure doubles. */
	private largeLeafNote(list: TaskList, current: Task): string | null {
		const tap = this.policy.largeLeaf;
		const key = `${list.slug}/${current.id}`;
		const results = this.work.get(key) ?? 0;
		const tokens = this.spanTokens.get(key) ?? 0;
		const share = this.policy.budget ? this.policy.budget * tap.budgetShare : null;
		const over = results >= tap.toolResults || (share !== null && tokens >= share);
		const last = this.tapped.get(key);
		if (over && (last === undefined || results >= last.results * 2 || (last.tokens > 0 && tokens >= last.tokens * 2))) {
			this.tapped.set(key, { results, tokens });
			return largeLeafReminder(list.slug, current, { results, tokens, share, first: last === undefined });
		}
		return null;
	}

	/** An assistant message finished; its text counts as work of the task in progress when long enough. */
	assistantText(chars: number): void {
		const current = this.list && innermostDoing(this.list);
		if (current && chars > TEXT_WORK_CHARS) this.countWork(this.list!, current, charsToTokens(chars));
	}

	private resetUntracked(): void {
		this.untracked = 0;
		this.lastReminder = 0;
		this.reminderInterval = 0;
	}

	/**
	 * Taskfold folded content inside one of these spans to relieve pressure (keys are `<list>/<id>`
	 * with subtask ids dotted, e.g. `backlog-completion/3.9.2`). If the agent's own leaf was shrunk,
	 * it is told once, because from its side the content simply vanished.
	 */
	floorTap(spans: readonly string[]): void {
		const current = this.list && innermostDoing(this.list);
		if (!current || !this.list) return;
		const key = `${this.list.slug}/${current.id}`;
		if (!spans.some((span) => span === key || span.startsWith(`${key}.`))) return;
		this.floorNote = { task: key, slug: this.list.slug, id: current.id, title: current.title };
	}

	/**
	 * Taskfold reports nothing foldable is left, or that the episode ended. The agent is told once
	 * per episode, and at most once per `SATURATION_NOTE_GAP` tool results.
	 */
	saturationTap(holder: { task: string; tokens: number } | null | undefined): void {
		if (holder === undefined) {
			this.saturated = false;
			this.saturationHolder = undefined;
			return;
		}
		if (this.saturated) return;
		this.saturated = true;
		if (this.sinceSaturationNote < SATURATION_NOTE_GAP) return;
		if (holder === null) {
			this.saturationHolder = null;
		} else {
			const slash = holder.task.indexOf("/");
			this.saturationHolder = { slug: holder.task.slice(0, slash), id: holder.task.slice(slash + 1), tokens: holder.tokens };
		}
	}

	private takeSaturation(): { slug: string; id: string; tokens: number } | null | undefined {
		const holder = this.saturationHolder;
		this.saturationHolder = undefined;
		if (holder !== undefined) this.sinceSaturationNote = 0;
		return holder;
	}

	/** Work counted inside a task's span, or undefined when this process did not see it start. */
	spanWork(slug: string, id: string): number | undefined {
		return this.work.get(`${slug}/${id}`);
	}

	/** A task ended: forget its count. */
	finished(slug: string, id: string): void {
		this.work.delete(`${slug}/${id}`);
	}

	/**
	 * A non-`tasks` tool result. Returns the reminder to append, or null. Nested calls (issued by
	 * another tool) count as work but never carry a reminder of their own.
	 */
	toolResult(nested: boolean, chars = 0): string | null {
		const list = this.list;
		const current = list && innermostDoing(list);
		this.sinceSaturationNote++;
		if (list && current) {
			this.resetUntracked();
			this.countWork(list, current, charsToTokens(chars));
			if (nested || this.policy.enforce === "off") return null;
			const floor = this.floorNote;
			this.floorNote = null;
			const saturation = this.takeSaturation();
			return [saturation !== undefined && saturationNote(saturation), floor && floorFoldNote(floor), this.largeLeafNote(list, current)].filter(Boolean).join("\n\n") || null;
		}
		this.untracked++;
		if (nested || this.policy.enforce === "off") return null;
		const floor = this.floorNote;
		this.floorNote = null;
		const saturation = this.takeSaturation();
		const notes = [saturation !== undefined && saturationNote(saturation), floor && floorFoldNote(floor)].filter(Boolean).join("\n\n");
		if (notes) return notes;
		if (this.policy.enforce !== "coach" || this.calls <= this.policy.orientationCalls) return null;
		const pick = list ? nextTask(list, this.policy.stopOnBlock) : null;
		if (list && !pick) return null;
		if (this.reminderInterval && this.untracked - this.lastReminder < this.reminderInterval) return null;
		const first = this.reminderInterval === 0;
		this.lastReminder = this.untracked;
		this.reminderInterval = first ? 25 : Math.min(this.reminderInterval * 2, 200);
		if (!first) {
			const repair = list && pick
				? `Start ${pick.resume ? "or resume " : ""}${pick.task.id} "${pick.task.title}" with tasks start {list: "${list.slug}", id: "${pick.task.id}"}.`
				: "Create or claim a list with tasks create or tasks claim.";
			return `[accordion tasks] Still untracked: ${this.untracked} tool results without a task. ${repair}`;
		}
		if (!list || !pick) return noListReminder(this.calls);
		const next = pick.task;
		return `[accordion tasks] ${this.calls} tool calls ran while no task of "${list.slug}" is in progress, so this work belongs to no task record. If it is part of a planned task, call tasks start {list: "${list.slug}", id: "<id>"} before continuing (${pick.resume ? `next: resume ${next.id} "${next.title}", which was waiting for ${currentBlock(next)?.on}` : `next to do: ${next.id} "${next.title}"`}); if it is new work, add a task for it first.`;
	}
}

/**
 * The refusal for completing or failing a task whose span holds no work. `previous` is the task that
 * finished last, where the work may have gone instead.
 */
export function emptySpanRefusal(slug: string, id: string, previous: string | null): string {
	return [
		`Nothing ran inside ${id} since tasks start. Start a task before its first tool call and end it after its last.`,
		`If this task needs the user's approval or choice before it can finish, block ${id} {reason: "user-decision", detail: "<what the user must decide>"} before replying; resume it when the answer resolves the block.`,
		previous ? `If the work ran in the task before it, abandon ${id} {supersededBy: "${previous}"} with a report.` : `If the task is not needed, abandon ${id} with a report.`,
	].join("\n");
}

/** The reminder for work that belongs to no list at all. */
export function noListReminder(calls: number): string {
	return `[accordion tasks] ${calls} tool calls ran with no task list attached, so this work belongs to no record. If it is more than a one-step errand, create or claim a list before continuing: tasks create {list: "<slug>", title: "<title>", goals: ["<end state>"], tasks: [{title: "<first outcome>", acceptanceCriteria: ["<checkable statement>"]}]}.`;
}

/** The refusal for work that belongs to no list at all, naming the exact call that repairs it. */
export function noListRefusal(calls: number): string {
	return `[accordion tasks] Blocked: ${calls} tool calls ran with no task list attached, so this work would belong to no record. Create or claim a list first — tasks create {list: "<slug>", title: "<title>", goals: ["<end state>"], tasks: [{title: "<first outcome>", acceptanceCriteria: ["<checkable statement>"]}]} — or, if this really is a one-step errand, say so and use tasks.enforce off for this session.`;
}

/** The refusal for a list that exists while no leaf is in progress. */
export function noLeafRefusal(list: TaskList, calls: number): string {
	const pick = nextTask(list);
	if (!pick) return `[accordion tasks] Blocked: every task of "${list.slug}" is finished, failed or abandoned. Add the next task before continuing — tasks add {list: "${list.slug}", tasks: [{title: "<next outcome>", acceptanceCriteria: ["<checkable statement>"]}]}.`;
	const next = pick.task;
	const why = pick.resume ? `resume ${next.id} "${next.title}", which was waiting for ${currentBlock(next)?.on}` : `start ${next.id} "${next.title}"`;
	return `[accordion tasks] Blocked: ${calls} tool calls ran while no task of "${list.slug}" is in progress. Repair it with tasks start {list: "${list.slug}", id: "${next.id}"} (${why}) before running more work.`;
}
