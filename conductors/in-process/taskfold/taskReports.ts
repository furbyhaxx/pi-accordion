/*
 * taskReports.ts — a task's report read from the session log, for `recall` (SPEC-0003).
 *
 * The report is what the agent wrote when it finished the task plus the facts Taskfold derives from
 * the task's own tool traffic. Pure: reads blocks, changes nothing.
 */
import type { Truth } from "../../../core/truth";
import type { TaskReport } from "../../../core/recallView";
import { recordFacts, scanTaskSpans, type TaskSpan } from "./taskfold";

const idOrder = (a: string, b: string): number => {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
	return 0;
};

/** A lookup from `<list>/<id>` to that task's report, scanning the log once on first use. */
export function taskReports(truth: Truth): (taskKey: string) => TaskReport | null {
	let spans: Map<string, TaskSpan> | null = null;
	return (taskKey) => {
		const blocks = truth.blocks;
		if (!spans) {
			spans = new Map();
			// A task that was resumed has several spans; the last one carries the final report.
			for (const s of scanTaskSpans(blocks, (b) => b.text)) spans.set(s.key, s);
		}
		const span = spans.get(taskKey);
		if (!span) return null;
		const members = span.intervals.flatMap((iv) => blocks.slice(iv.start, iv.end + 1));
		const facts = recordFacts(members, (b) => b.text);
		const children = [...spans.values()]
			.filter((s) => s.list === span.list && s.id.startsWith(`${span.id}.`) && !s.id.slice(span.id.length + 1).includes("."))
			.sort((a, b) => idOrder(a.id, b.id))
			.map((s) => ({ id: s.id, title: s.title, status: s.status, ...(s.report.outcome ? { outcome: s.report.outcome } : {}) }));
		return {
			title: span.title,
			status: span.status,
			...(span.acceptanceCriteria?.length ? { criteria: span.acceptanceCriteria } : {}),
			...(span.report.outcome ? { outcome: span.report.outcome } : {}),
			...(span.report.decisions?.length ? { decisions: span.report.decisions } : {}),
			...(span.report.open?.length ? { open: span.report.open } : {}),
			...(facts.changed.length ? { changed: facts.changed } : {}),
			...(facts.verified.length ? { verified: facts.verified } : {}),
			...(children.length ? { children } : {}),
		};
	};
}
