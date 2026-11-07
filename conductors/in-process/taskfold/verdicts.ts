/*
 * verdicts.ts — Taskfold's user-message verdicts, kept for the session so a resume neither loses nor
 * re-bills them. A verdict is computed once per block; the extension persists durable ones as session
 * entries and seeds them back on session start.
 */

/** Where a verdict came from. `opening` is the session's first message, never sent to a classifier. */
export type VerdictSource = "classifier" | "harness" | "opening" | "error";

/** One user message's verdict: the classifier's expected loss (0–3), null when unknown. */
export interface Verdict {
	loss: number | null;
	source: VerdictSource;
	/** The classifier's confidence in `loss`. */
	confidence?: number;
	/** The supporting questions' probability of `true`, by question key. */
	answers?: Record<string, number>;
	/** The model that classified the message. */
	model?: string;
	/** When the verdict was made (ISO). */
	at?: string;
}

/** The session entry type a persisted verdict is stored under. */
export const VERDICT_ENTRY = "accordion.taskfold.verdict";
/** Session entry recording a task's handle-based unfold state. */
export const UNFOLD_ENTRY = "accordion.taskfold.unfold";

export interface TaskUnfoldState { count: number; open: boolean }

/** The latest unfold state for each task on the current session branch. */
export function unfoldStatesOf(entries: readonly unknown[]): Map<string, TaskUnfoldState> {
	const out = new Map<string, TaskUnfoldState>();
	for (const raw of entries) {
		const entry = raw as { type?: unknown; customType?: unknown; data?: { key?: unknown; count?: unknown; open?: unknown } };
		const data = entry?.data;
		if (entry?.type === "custom" && entry.customType === UNFOLD_ENTRY && typeof data?.key === "string" && Number.isSafeInteger(data.count) && (data.count as number) > 0 && typeof data.open === "boolean") out.set(data.key, { count: data.count as number, open: data.open });
	}
	return out;
}

const SOURCES: readonly VerdictSource[] = ["classifier", "harness", "opening", "error"];

/** Block ids that survive a reload (`u:<timestamp>`); positional ids are not persisted. */
const durable = (id: string) => /^[uars]:/.test(id);

/** The verdicts recorded in a session branch; the last record for a block wins. */
export function verdictsOf(entries: readonly unknown[]): Map<string, Verdict> {
	const out = new Map<string, Verdict>();
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== VERDICT_ENTRY) continue;
		const d = entry.data as { id?: unknown; loss?: unknown; source?: unknown; confidence?: unknown; answers?: unknown; model?: unknown; at?: unknown } | undefined;
		if (typeof d?.id !== "string" || !SOURCES.includes(d.source as VerdictSource)) continue;
		const answers: Record<string, number> = {};
		if (d.answers && typeof d.answers === "object") for (const [k, v] of Object.entries(d.answers)) if (typeof v === "number" && Number.isFinite(v)) answers[k] = v;
		out.set(d.id, {
			loss: typeof d.loss === "number" && Number.isFinite(d.loss) ? d.loss : null,
			source: d.source as VerdictSource,
			...(typeof d.confidence === "number" ? { confidence: d.confidence } : {}),
			...(Object.keys(answers).length ? { answers } : {}),
			...(typeof d.model === "string" ? { model: d.model } : {}),
			...(typeof d.at === "string" ? { at: d.at } : {}),
		});
	}
	return out;
}

/** The session's verdicts, shared by the attached Taskfold conductor and the task views. */
export class VerdictLedger {
	private verdicts = new Map<string, Verdict>();
	private persist: ((id: string, verdict: Verdict) => void) | null = null;
	private unfolds = new Map<string, TaskUnfoldState>();
	private persistUnfold: ((key: string, state: TaskUnfoldState) => void) | null = null;
	/** The attached conductor's `maxLoss`: a message folds when its loss is below this. */
	threshold: number | null = null;

	/** Start a session: seed its recorded verdicts and how to record new ones. */
	reset(seed: ReadonlyMap<string, Verdict>, persist: ((id: string, verdict: Verdict) => void) | null, unfolds: ReadonlyMap<string, TaskUnfoldState> = new Map(), persistUnfold: ((key: string, state: TaskUnfoldState) => void) | null = null): void {
		this.verdicts = new Map(seed);
		this.persist = persist;
		this.unfolds = new Map(unfolds);
		this.persistUnfold = persistUnfold;
	}

	unfoldStates(): ReadonlyMap<string, TaskUnfoldState> { return this.unfolds; }

	setUnfold(key: string, state: TaskUnfoldState): boolean {
		this.unfolds.set(key, state);
		try { this.persistUnfold?.(key, state); return true; } catch { return false; }
	}

	get(id: string): Verdict | undefined {
		return this.verdicts.get(id);
	}

	has(id: string): boolean {
		return this.verdicts.has(id);
	}

	/** Record a verdict once; a block that already has one keeps it. */
	set(id: string, verdict: Verdict): void {
		if (this.verdicts.has(id)) return;
		this.verdicts.set(id, verdict);
		// A failed call is not recorded: a later session may classify the message after all.
		if (verdict.source !== "error" && durable(id)) {
			try {
				this.persist?.(id, verdict);
			} catch {
				/* persistence is best-effort; the verdict holds for this process */
			}
		}
	}

	/** Whether a message with this verdict folds under the current threshold. */
	folds(verdict: Verdict | undefined, threshold = this.threshold): boolean {
		return verdict?.loss != null && threshold != null && verdict.loss < threshold;
	}
}

/** The process-wide ledger; one Pi session runs per extension process. */
export const taskfoldVerdicts = new VerdictLedger();
