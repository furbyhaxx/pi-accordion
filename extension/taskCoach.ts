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

export class TaskCoach {
	private list: TaskList | null = null;
	private outside = 0;
	/** `<list>/<id>` → tool results inside that task's span since this session saw it start. */
	private readonly work = new Map<string, number>();

	/** The list this session works on; null when none is attached. */
	setList(list: TaskList | null): void {
		if (list?.slug !== this.list?.slug) this.outside = 0;
		this.list = list;
	}

	/** Tasks just started (with any auto-started parents): their spans begin empty. */
	started(slug: string, ids: readonly string[]): void {
		for (const id of ids) this.work.set(`${slug}/${id}`, 0);
		this.outside = 0;
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
			for (const id of [current.id, ...ancestors(current.id)]) {
				const key = `${list.slug}/${id}`;
				if (this.work.has(key)) this.work.set(key, this.work.get(key)! + 1);
			}
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

	/** The note for finishing a task whose span had no tool work, or null (also when its start was not seen). */
	finished(slug: string, id: string): string | null {
		const n = this.work.get(`${slug}/${id}`);
		this.work.delete(`${slug}/${id}`);
		if (n !== 0) return null;
		return `Note: no tool work ran between starting and finishing ${id}, so its record has nothing to summarize and its time is 0s. Start a task before its first tool call and finish it after its last one.`;
	}
}
