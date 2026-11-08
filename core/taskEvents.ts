/*
 * taskEvents.ts — what a `tasks` execution did to task spans, recorded on the tool result the model
 * issued. A `tasks` call made inside another tool (codemode's `ctx.executeTool`) leaves no block of
 * its own, so its event is queued under the outer call and merged into that result's `details`
 * (SPEC-0002 §5.3). Pure and framework-free: the extension writes events, the span scan reads them.
 */

/** Snapshot of a task the span scan needs for its record. */
export interface TaskEventTask {
	id: string;
	title: string;
	status: string;
	report?: { outcome?: string; decisions?: string[]; open?: string[] };
	acceptanceCriteria?: string[];
	pins?: { kind: string; text: string; source: string }[];
}

/** One lifecycle `tasks` execution, in the order it ran. */
export interface TaskEvent {
	action: "start" | "block" | "complete" | "fail" | "abandon";
	list: string;
	id: string;
	/** The task the action named, after it ran. */
	task?: TaskEventTask;
	/** Tasks that entered doing: the named task and auto-started or resumed ancestors, outermost first. */
	started?: TaskEventTask[];
	/** Ancestors closed automatically. */
	closed?: TaskEventTask[];
	/** Subtasks abandoned with their parent. */
	cascaded?: TaskEventTask[];
}

export const TASK_EVENT_ACTIONS: ReadonlySet<string> = new Set(["start", "block", "complete", "fail", "abandon"]);

/** The model-issued call a tool call id belongs to: nested ids are `<outer>/<n>[/<m>…]`. */
export function outerCallId(toolCallId: string): string {
	const slash = toolCallId.indexOf("/");
	return slash < 0 ? toolCallId : toolCallId.slice(0, slash);
}

/** Events of nested `tasks` calls, held until their outer call's result is finalized. */
export class TaskEventQueue {
	private readonly pending = new Map<string, TaskEvent[]>();

	/** Queue `event` when `toolCallId` is nested; returns false for a model-issued call. */
	queue(toolCallId: string, event: TaskEvent): boolean {
		const outer = outerCallId(toolCallId);
		if (outer === toolCallId) return false;
		const list = this.pending.get(outer);
		if (list) list.push(event);
		else this.pending.set(outer, [event]);
		return true;
	}

	/** Remove and return the events queued under a model-issued call. */
	take(toolCallId: string): TaskEvent[] {
		const events = this.pending.get(toolCallId) ?? [];
		this.pending.delete(toolCallId);
		return events;
	}

	/** Drop everything, e.g. when the session changes or a turn ends without the outer result. */
	clear(): void {
		this.pending.clear();
	}
}

/** `details` with `events` appended to its `taskEvents`; null when `details` cannot carry them. */
export function withTaskEvents(details: unknown, events: readonly TaskEvent[]): Record<string, unknown> | null {
	if (!events.length) return null;
	if (details === undefined || details === null) return { taskEvents: [...events] };
	if (typeof details !== "object" || Array.isArray(details)) return null;
	const prior = (details as { taskEvents?: unknown }).taskEvents;
	return { ...(details as Record<string, unknown>), taskEvents: [...(Array.isArray(prior) ? prior : []), ...events] };
}

/** The task events recorded on a tool result's `details`, validated loosely. */
export function taskEventsIn(details: unknown): TaskEvent[] {
	const raw = details && typeof details === "object" ? (details as { taskEvents?: unknown }).taskEvents : undefined;
	if (!Array.isArray(raw)) return [];
	return raw.filter((e): e is TaskEvent => !!e && typeof e === "object" && TASK_EVENT_ACTIONS.has((e as TaskEvent).action) && typeof (e as TaskEvent).list === "string" && typeof (e as TaskEvent).id === "string");
}
