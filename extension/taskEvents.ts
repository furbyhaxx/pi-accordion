/*
 * taskEvents.ts — builds the span event of one `tasks` execution from the store's view
 * (SPEC-0002 §5.3). Transport and parsing live in `core/taskEvents.ts`.
 */
import { criteriaTexts, TASK_EVENT_ACTIONS, type TaskEvent, type TaskEventTask } from "../core/taskEvents";
import type { Task, TaskList } from "./tasks";

function snapshot(t: Task): TaskEventTask {
	const acceptanceCriteria = criteriaTexts(t.acceptanceCriteria);
	return {
		id: t.id,
		title: t.title,
		status: t.status,
		...(t.report ? { report: t.report } : {}),
		...(acceptanceCriteria ? { acceptanceCriteria } : {}),
		...(t.pins?.length ? { pins: t.pins } : {}),
	};
}

/** The event of one successful `tasks` execution, or null for actions that do not touch spans. */
export function taskEventOf(args: { action: string; list?: string; id?: string }, list: TaskList | null, run: { started: readonly string[]; closed: readonly Task[]; cascaded: readonly Task[] }): TaskEvent | null {
	if (!TASK_EVENT_ACTIONS.has(args.action) || !args.list || !args.id) return null;
	const byId = new Map((list?.tasks ?? []).map((t) => [t.id, t]));
	const task = byId.get(args.id);
	const started = run.started.flatMap((id) => {
		const t = byId.get(id);
		return t ? [snapshot(t)] : [];
	});
	return {
		action: args.action as TaskEvent["action"],
		list: args.list,
		id: args.id,
		...(task ? { task: snapshot(task) } : {}),
		...(started.length ? { started } : {}),
		...(run.closed.length ? { closed: run.closed.map(snapshot) } : {}),
		...(run.cascaded.length ? { cascaded: run.cascaded.map(snapshot) } : {}),
	};
}
