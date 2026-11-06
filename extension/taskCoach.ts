/*
 * taskCoach.ts — keeps the agent on the task protocol: counts tool work inside each task's span and
 * work done while no task is in progress, and words the reminders appended to tool results.
 * Pure state plus text; the extension feeds it tool results and the attached list.
 */
import { currentBlock, IDLE_REASONS, type BlockReason, type Task, type TaskList } from "./tasks";

/** Reminders start on the 3rd tool result in a row with no task in progress, then repeat every 8th. */
export const OUTSIDE_FIRST = 3;
export const OUTSIDE_EVERY = 8;

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
export function nextTask(list: TaskList): { task: Task; resume: boolean } | null {
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
	const todo = list.tasks.find((t) => t.status === "todo" && !waiting.some((w) => t.id.startsWith(`${w.id}.`)));
	return todo ? { task: todo, resume: false } : null;
}

/** Session entry recording each agent stop's `IdleVerdict` for the attached list. */
export const IDLE_ENTRY = "accordion.tasks.idle";

/** Where the agent stands when it stops: still working, legitimately waiting, or stopped early. */
export type IdleVerdict =
	| { state: "in-progress"; task: string }
	| { state: "waiting"; tasks: { id: string; reason: BlockReason }[] }
	| { state: "pending"; next: string }
	| { state: "finished" };

/**
 * Judge an agent's stop against its list. `in-progress` and `pending` (open work it could have
 * continued) are premature stops; `waiting` (every remaining task waits on the user or a third
 * party) and `finished` are allowed.
 */
export function idleVerdict(list: TaskList): IdleVerdict {
	const doing = innermostDoing(list);
	if (doing) return { state: "in-progress", task: doing.id };
	const next = nextTask(list);
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
	private outside = 0;
	/** `<list>/<id>` → tool results and assistant texts inside that task's span since this process saw it. */
	private readonly work = new Map<string, number>();

	/** The list this session works on; null when none is attached. */
	setList(list: TaskList | null): void {
		if (list?.slug !== this.list?.slug) this.outside = 0;
		this.list = list;
	}

	/** Tasks just started or resumed (with any auto-started parents). */
	started(slug: string, ids: readonly string[]): void {
		// A tool call batched with the start may report before it, and a resumed task keeps its work.
		for (const id of ids) if (!this.work.has(`${slug}/${id}`)) this.work.set(`${slug}/${id}`, 0);
		this.outside = 0;
	}

	private countWork(list: TaskList, current: Task): void {
		for (const id of [current.id, ...ancestors(current.id)]) {
			const key = `${list.slug}/${id}`;
			this.work.set(key, (this.work.get(key) ?? 0) + 1);
		}
	}

	/** An assistant message finished; its text counts as work of the task in progress when long enough. */
	assistantText(chars: number): void {
		const current = this.list && innermostDoing(this.list);
		if (current && chars > TEXT_WORK_CHARS) this.countWork(this.list!, current);
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
	toolResult(nested: boolean): string | null {
		const list = this.list;
		if (!list) return null;
		const current = innermostDoing(list);
		if (current) {
			this.outside = 0;
			this.countWork(list, current);
			return null;
		}
		const pick = nextTask(list);
		if (!pick || nested) return null;
		const next = pick.task;
		this.outside++;
		const due = this.outside === OUTSIDE_FIRST || (this.outside > OUTSIDE_FIRST && (this.outside - OUTSIDE_FIRST) % OUTSIDE_EVERY === 0);
		if (!due) return null;
		return `[accordion tasks] ${this.outside} tool calls in a row ran while no task of "${list.slug}" is in progress, so this work belongs to no task record. If it is part of a planned task, call tasks start {list: "${list.slug}", id: "<id>"} before continuing (${pick.resume ? `next: resume ${next.id} "${next.title}", which was waiting for ${currentBlock(next)?.on}` : `next to do: ${next.id} "${next.title}"`}); if it is new work, add a task for it first.`;
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
