import { scanTaskSpans, type TaskSpan } from "../conductors/in-process/taskfold/taskfold";
import type { Truth } from "../core/truth";

const scans = new WeakMap<Truth, { length: number; last: string | undefined; spans: readonly TaskSpan[] }>();

/** The task spans of a Truth's block log, scanned once per state of the log. Callers must not mutate the result. */
export function taskSpansOf(truth: Truth): readonly TaskSpan[] {
	const blocks = truth.blocks;
	const last = blocks.at(-1)?.id;
	const hit = scans.get(truth);
	if (hit && hit.length === blocks.length && hit.last === last) return hit.spans;
	const spans = scanTaskSpans(blocks, (b) => b.text);
	scans.set(truth, { length: blocks.length, last, spans });
	return spans;
}
