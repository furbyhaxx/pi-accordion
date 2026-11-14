/*
 * taskfold.ts — fold completed task spans into structured task records.
 *
 * The agent marks its work with the `tasks` tool (registered by the extension while this conductor
 * is attached). A SPAN runs from a successful `tasks start <id>` call through the successful
 * `complete` / `fail` / `abandon` result of the same task. The timing policy selects safe finished
 * spans, outermost first; pressure additionally triggers relief down to LOW·budget. Each span
 * becomes a group whose summary is a fixed-shape record:
 *
 *   {#code FOLDED} {"task":"<list>/<id>","title":…,"status":"done","outcome":…,"changed":[…],"children":[…]}
 *
 * `outcome` / `decisions` / `open` are agent-written (the finishing call's `report`); `changed` /
 * `verified` are derived from the span's own tool calls; `children` composes finished subtasks. A
 * finished top-level task becomes a one-line history entry instead (records.ts, SPEC-0002 §6.3).
 *
 * User messages stay verbatim unless routed into the list or classified as low loss. Kept
 * messages split the span into several groups; the record rides on the last one. Without a
 * classifier, unrouted messages stay verbatim.
 *
 * An epoch commits as one transaction. Eager timing shortens the rewritten suffix but cannot
 * guarantee that the provider already cached its unchanged prefix.
 *
 * Folding proposes `group`, plus `ungroup` of absorbed child groups. Child handles remain recoverable
 * across group boundaries; a handle-based unfold reopens the task and recompiles its siblings.
 */
import { isFoldTiming, type ClassifierAnswer, type ClassifierQuestion, type Conductor, type ConductorHost, type FoldTiming, type FoldingPolicy, type HostEvent, type ViewBlock } from "../../../core/conductor/contract";
import type { Op } from "../../../core/ops";
import { foldTag } from "../../../core/digest";
import { estTokens } from "../../../core/tokens";
import { cacheProfileFor } from "../../../core/cacheProfiles";
import { VerdictLedger } from "./verdicts";
import { RoutingParseError, taskfoldRouting, type RoutingPort } from "./routing";
import { criteriaTexts, taskEventsIn, type TaskEvent } from "../../../core/taskEvents";
import { collapsibleMessageKeys, messageKey } from "../../../core/groupShape";
import { KeelLiteConductor } from "../keel-lite/keel-lite";
import { isHistory, oneLine, parseCarrier, partCarrier, priorEntry, render, shrinkDeepest, stepsCarrier, stepsKeyOfSummary, taskKeyOfSummary, toHistory, untrackedCarrier, visibleTags, type HistoryObj, type RecordObj } from "./records";

export { taskKeyOfSummary };

export interface TaskfoldOptions {
	/** Start an epoch once live tokens reach `high · budget`. Default 0.8. */
	high?: number;
	/** An epoch stops once projected live tokens are at or below `low · budget`. Default 0.6. */
	low?: number;
	/** Fold a user message when the classifier's expected `loss` level (0–3) is below this. Default 0.3. */
	maxLoss?: number;
	/** User messages matching any of these are harness text and fold without a model call. */
	harnessPatterns?: readonly RegExp[];
	/** The newest finished top-level tasks that stay raw. Default 0: a finished task folds at the next request. */
	keepRecentTasks?: number;
	/** Fold eagerly, on a cold/expired cache or pressure (lazy), or only under pressure. Default eager. */
	timing?: FoldTiming;
	/** Keep the closing call/result raw around a report-free carrier. Default record. */
	leafForm?: "record" | "bracket";
	/** Raw token budget for descendant records; deepest children become history, own fields stay whole. */
	recordTokens?: number;
	/** Apply recoverable per-block pressure relief before folding untracked work. */
	floor?: boolean;
	/** Fold long runs outside task spans when pressure remains. */
	untracked?: { enabled: boolean; minSteps: number };
	/** Fold old finished steps inside still-open tasks when pressure remains, so one long task cannot fill the context. */
	steps?: { enabled: boolean; minSteps: number };
}

export const TASKFOLD_DEFAULTS: Readonly<Required<TaskfoldOptions>> = {
	high: 0.8,
	low: 0.6,
	maxLoss: 0.3,
	keepRecentTasks: 0,
	timing: "eager",
	leafForm: "record",
	recordTokens: 1500,
	floor: false,
	untracked: { enabled: true, minSteps: 8 },
	steps: { enabled: true, minSteps: 4 },
	harnessPatterns: [/^\s*<system-reminder>/i, /^\s*<system>/i, /^\s*<task-notification>/i, /^\s*<subagent[-_ ]result/i],
};

/** The classifier the questions and `maxLoss` are calibrated for (.project/analyses/taskfold-classifier/). */
export const TASKFOLD_CLASSIFIER = "openrouter/perplexity/pplx-decider-v1.2";

const CTX =
	"`message` is the newest user-role message in a coding-agent session. `session_goal` is the session's first user message, `previous_user_message` the user-role message before `message` (empty when it is `session_goal`), and `assistant_last_reply` the end of the assistant's reply that `message` answers. User-role messages come from the human, from a coordinating parent agent, or from the harness.";

/** `loss` decides; the other questions ride in the same call because they measurably sharpen it. Keep the wording: the threshold is calibrated on it. */
export const USER_QUESTIONS: Record<string, ClassifierQuestion> = {
	keep_goal: {
		type: "bool",
		instructions: `${CTX} Once the work in progress is finished, its transcript is replaced by a short summary of what was done. Must the text of \`message\` itself stay visible so the assistant can continue correctly? It must when \`message\` asks for work or an answer that nobody requested before it: a new task, an additional deliverable, a new question about the subject, or a new direction for \`session_goal\`. A go-ahead for something \`assistant_last_reply\` proposed is not new work; neither is a retry notice, a question whether requested work is done, or information the assistant asked for.`,
		criteria: {
			true: "`message` asks for a task, deliverable, direction or answer that was not requested or proposed before it.",
			false: "`message` approves, continues, reports on, checks the status of, or adjusts work that was already requested or proposed.",
		},
	},
	durable_rule: {
		type: "bool",
		instructions: `${CTX} Does \`message\` set a rule, constraint, preference or decision about the work that must keep holding after the current step is finished? Lasting content includes a prohibition, a priority order, a chosen option, an interface contract or a naming rule. An instruction about the current step only, such as finishing now or reporting when done, is not lasting.`,
		criteria: {
			true: "`message` states a rule, constraint, preference or decision that keeps applying to later work.",
			false: "`message` concerns only the current step, or states no rule at all.",
		},
	},
	overrule: {
		type: "bool",
		instructions: `${CTX} Does \`message\` reverse, replace or correct an earlier instruction, decision, assumption or result from the user or the assistant?`,
		criteria: { true: "`message` replaces or corrects something said or done earlier.", false: "`message` builds on what was said and done earlier without changing it." },
	},
	loss: {
		type: "score",
		instructions: `${CTX} How much would the assistant's later work suffer if it could no longer see \`message\` once the work in progress is summarized?`,
		criteria: [
			"Nothing is lost: `message` is an approval, retry notice, status check or instruction about the current step.",
			"A detail is lost that a summary of the finished work would already contain.",
			"A lasting rule, decision or correction is lost that the assistant must keep following.",
			"The task or question itself is lost, so the assistant would not know what it was asked to do.",
		],
	},
};
const MESSAGE_CHARS = 2000;
const GOAL_CHARS = 1500;
const NEIGHBOUR_CHARS = 600;
/** An extraction that has not answered by now is abandoned and the message stays raw. */
const ROUTE_TIMEOUT_MS = 45_000;
const ROUTE_MAX_OUTPUT_TOKENS = 1500;
/** Tool calls after a task's last own event, while other tasks moved, before it counts as stale (SPEC-0002 §5.3). */
export const ZOMBIE_STEPS = 40;
const FINISH: Record<string, "done" | "failed" | "abandoned"> = { complete: "done", fail: "failed", abandon: "abandoned" };
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch"]);
const CHECK_RE = /\b(test|tests|check|lint|build|tsc|typecheck|smoke|pytest|vitest|jest|cargo|clippy|just|make)\b/;

/** One task span, as indices into the scanned blocks. `status` is null while the task is still open. */
export interface TaskSpan {
	/** `<list>/<id>`, the key fold records carry. */
	key: string;
	list: string;
	id: string;
	title: string;
	status: "done" | "failed" | "abandoned" | null;
	report: { outcome?: string; decisions?: string[]; open?: string[] };
	acceptanceCriteria?: string[];
	pins?: { kind: string; text: string; source: string }[];
	start: number;
	/** The finishing result's index, or the last block for an open span. */
	end: number;
	/** Explicit finishing call; absent for automatically closed tasks. */
	closingCall?: number;
	/** Inclusive periods belonging to this task, separated by blocks and resumes. */
	intervals: { start: number; end: number }[];
	/** Index of the call that last started, resumed or blocked this task. */
	lastEvent: number;
}

/** One finished task span, as indices into `host.blocks()`. */
type Span = TaskSpan & { status: "done" | "failed" | "abandoned" };

/** The block fields span discovery reads; both conductor views and Truth blocks satisfy it. */
export interface SpanBlock {
	kind: string;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	details?: unknown;
}

/** Task refs (`{id, title}`) in a JSON `tasks start` result's `started`/`resumed`; empty for legacy prose results. */
function jsonRefs(text: string): { id: string; title: string }[] {
	if (!text.startsWith("{")) return [];
	try {
		const r = JSON.parse(text) as { started?: unknown; resumed?: unknown };
		return [r.started, r.resumed].flatMap((xs) => (Array.isArray(xs) ? xs : [])).flatMap((x) =>
			x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && typeof (x as { title?: unknown }).title === "string" ? [{ id: (x as { id: string }).id, title: (x as { title: string }).title }] : [],
		);
	} catch {
		return [];
	}
}

/**
 * Every task span in `blocks`: finished spans in finishing order (innermost first when two end
 * together), then still-open spans running to the last block.
 */
export function scanTaskSpans<B extends SpanBlock>(blocks: readonly B[], textOf: (b: B) => string): TaskSpan[] {
	const resultIdx = new Map<string, number>();
	blocks.forEach((b, i) => {
		if (b.kind === "tool_result" && b.callId) resultIdx.set(b.callId, i);
	});
	type State = { key: string; list: string; id: string; title: string; start: number; active: number | null; waiting: boolean; intervals: { start: number; end: number }[]; lastEvent: number; acceptanceCriteria?: string[]; pins?: TaskSpan["pins"] };
	const open = new Map<string, State>();
	const out: TaskSpan[] = [];
	const closeInterval = (s: State, end: number) => {
		if (s.active !== null) s.intervals.push({ start: s.active, end: Math.max(s.active, end) });
		s.active = null;
		s.waiting = false;
	};
	const finish = (s: State, status: Span["status"], report: TaskSpan["report"], end: number, closingCall?: number) => {
		closeInterval(s, end);
		open.delete(s.key);
		out.push({ key: s.key, list: s.list, id: s.id, title: s.title, status, report, acceptanceCriteria: s.acceptanceCriteria, pins: s.pins, start: s.start, end, ...(closingCall === undefined ? {} : { closingCall }), intervals: s.intervals, lastEvent: s.lastEvent });
	};
	const metadata = (s: State, source: unknown) => {
		if (!source || typeof source !== "object") return;
		const data = source as Record<string, unknown>;
		if (typeof data.title === "string" && data.title) s.title = data.title;
		const criteria = criteriaTexts(data.acceptanceCriteria);
		if (criteria) s.acceptanceCriteria = criteria;
		if (Array.isArray(data.pins) && data.pins.every((v) => v && typeof v.kind === "string" && typeof v.text === "string" && typeof v.source === "string")) s.pins = data.pins;
	};
	// One recorded execution (SPEC-0002 §5.3). `at` is where a start opens, `end` where a finish
	// closes: the call and result of the model-issued call that carried the event.
	const applyEvent = (ev: TaskEvent, at: number, end: number) => {
		const key = `${ev.list}/${ev.id}`;
		if (ev.action === "start") {
			for (const s of open.values()) if (s.waiting && !(key === s.key || key.startsWith(`${s.key}.`))) closeInterval(s, at - 1);
			for (const c of ev.closed ?? []) {
				const s = open.get(`${ev.list}/${c.id}`);
				if (!s || (c.status !== "done" && c.status !== "failed")) continue;
				metadata(s, c);
				finish(s, c.status, c.report ?? { outcome: "Closed automatically after its subtasks." }, Math.max(s.start, at - 1));
			}
			for (const t of ev.started ?? (ev.task ? [ev.task] : [])) {
				const skey = `${ev.list}/${t.id}`;
				const existing = open.get(skey);
				if (existing) {
					if (existing.waiting) closeInterval(existing, at - 1);
					if (existing.active === null) existing.active = at;
					existing.lastEvent = at;
					metadata(existing, t);
				} else {
					const state: State = { key: skey, list: ev.list, id: t.id, title: t.title, start: at, active: at, waiting: false, intervals: [], lastEvent: at };
					metadata(state, t);
					open.set(skey, state);
				}
			}
		} else if (ev.action === "block") {
			for (const s of open.values()) if (s.key === key || key.startsWith(`${s.key}.`)) {
				s.waiting = true;
				s.lastEvent = at;
			}
		} else {
			for (const c of ev.cascaded ?? []) {
				const childKey = `${ev.list}/${c.id}`;
				const s = open.get(childKey);
				const state: State = s ?? { key: childKey, list: ev.list, id: c.id, title: c.title, start: at, active: null, waiting: false, intervals: [], lastEvent: at };
				metadata(state, c);
				finish(state, "abandoned", c.report ?? {}, end);
			}
			const s = open.get(key);
			if (!s) return;
			metadata(s, ev.task);
			finish(s, FINISH[ev.action], ev.task?.report ?? {}, end, at);
		}
	};
	blocks.forEach((b, i) => {
		if (b.kind === "user") {
			for (const s of open.values()) if (s.waiting) closeInterval(s, i - 1);
		}
		if (b.kind !== "tool_call" || !b.callId) return;
		const ri = resultIdx.get(b.callId);
		if (ri === undefined) return;
		const events = taskEventsIn(blocks[ri].details);
		if (events.length) {
			// A start that follows a finish inside one call opens after that call, so the finished
			// task keeps the call that ended it and the next one does not overlap it.
			let at = i;
			for (const ev of events) {
				if (ev.action !== "start" && ev.action !== "block") at = ri + 1 < blocks.length ? ri + 1 : ri;
				applyEvent(ev, ev.action === "start" ? at : i, ri);
			}
			return;
		}
		if (b.toolName !== "tasks" || blocks[ri].isError) return;
		const args = parseCall(textOf(b));
		const action = typeof args?.action === "string" ? args.action : "";
		if (typeof args?.list !== "string" || typeof args?.id !== "string") return;
		const list = args.list;
		const id = args.id;
		const key = `${list}/${id}`;
		const details = blocks[ri].details && typeof blocks[ri].details === "object" ? blocks[ri].details as Record<string, unknown> : null;
		const taskDetails = details?.task && typeof details.task === "object" ? details.task as Record<string, unknown> : null;
		const updateMetadata = (s: State, source: unknown = taskDetails) => {
			if (!source || typeof source !== "object") return;
			const data = source as Record<string, unknown>;
			const criteria = criteriaTexts(data.acceptanceCriteria);
			if (criteria) s.acceptanceCriteria = criteria;
			if (Array.isArray(data.pins) && data.pins.every((v) => v && typeof v.kind === "string" && typeof v.text === "string" && typeof v.source === "string")) s.pins = data.pins;
		};
		if (action === "start") {
			for (const s of open.values()) if (s.waiting && !(key === s.key || key.startsWith(`${s.key}.`))) closeInterval(s, i - 1);
			const lines = textOf(blocks[ri]).split("\n");
			const closed = Array.isArray(details?.closed) ? details.closed : lines.flatMap((line) => {
				const m = /^Closed (\S+) "(.*)" as (done|failed) from its subtasks' reports/.exec(line);
				return m ? [{ id: m[1], title: m[2], status: m[3] }] : [];
			});
			for (const item of closed) {
				if (!item || typeof item !== "object") continue;
				const c = item as { id?: unknown; title?: unknown; status?: unknown; report?: TaskSpan["report"] };
				const s = typeof c.id === "string" ? open.get(`${list}/${c.id}`) : undefined;
				if (!s || (c.status !== "done" && c.status !== "failed")) continue;
				if (!s.title && typeof c.title === "string") s.title = c.title;
				updateMetadata(s, c);
				finish(s, c.status, c.report ?? { outcome: "Closed automatically after its subtasks." }, Math.max(s.start, i - 1));
			}
			const parents = [...jsonRefs(textOf(blocks[ri])), ...lines.flatMap((line) => {
				const m = /^Also (?:started|resumed) parent (\S+) "(.*)" so its span/.exec(line);
				return m ? [{ id: m[1], title: m[2] }] : [];
			})];
			const task = details?.task && typeof details.task === "object" ? details.task as { title?: unknown } : undefined;
			const title = typeof task?.title === "string" ? task.title : parents.find((p) => p.id === id)?.title ?? /^(?:Started|Resumed) \S+ "(.*)"\.$/.exec(lines[0] ?? "")?.[1] ?? "";
			const started = Array.isArray(details?.started) ? details.started.filter((x): x is string => typeof x === "string") : [...parents.map((p) => p.id), id];
			for (const startedId of started) {
				const skey = `${list}/${startedId}`;
				const existing = open.get(skey);
				if (existing) {
					if (existing.waiting) closeInterval(existing, i - 1);
					if (existing.active === null) existing.active = i;
					existing.lastEvent = i;
				} else open.set(skey, { key: skey, list, id: startedId, title: startedId === id ? title : parents.find((p) => p.id === startedId)?.title ?? "", start: i, active: i, waiting: false, intervals: [], lastEvent: i });
			}
			const startedTask = open.get(key);
			if (startedTask) updateMetadata(startedTask);
		} else if (action === "block") {
			for (const s of open.values()) if (s.key === key || key.startsWith(`${s.key}.`)) {
				s.waiting = true;
				s.lastEvent = i;
			}
		} else if (FINISH[action]) {
			const cascaded = Array.isArray(details?.cascaded) ? details.cascaded : textOf(blocks[ri]).split("\n").flatMap((line) => {
				const m = /^Also abandoned its unfinished subtasks? ([\d., ]+)\.$/.exec(line);
				return m ? m[1].split(", ").map((childId) => ({ id: childId })) : [];
			});
			for (const item of cascaded) {
				if (!item || typeof item !== "object") continue;
				const c = item as { id?: unknown; title?: unknown; report?: TaskSpan["report"] };
				if (typeof c.id !== "string") continue;
				const childKey = `${list}/${c.id}`;
				const s = open.get(childKey);
				if (s) {
					updateMetadata(s, c);
					finish(s, "abandoned", c.report ?? {}, ri);
				} else if (typeof c.title === "string") {
					const state: State = { key: childKey, list, id: c.id, title: c.title, start: i, active: null, waiting: false, intervals: [], lastEvent: i };
					updateMetadata(state, c);
					finish(state, "abandoned", c.report ?? {}, ri);
				}
			}
			const s = open.get(key);
			if (!s) return;
			const report = (args.report && typeof args.report === "object" ? args.report : {}) as TaskSpan["report"];
			updateMetadata(s);
			finish(s, FINISH[action], report, ri, i);
		}
	});
	for (const s of open.values()) {
		closeInterval(s, blocks.length - 1);
		out.push({ key: s.key, list: s.list, id: s.id, title: s.title, status: null, report: {}, acceptanceCriteria: s.acceptanceCriteria, pins: s.pins, start: s.start, end: blocks.length - 1, intervals: s.intervals, lastEvent: s.lastEvent });
	}
	return out;
}

/**
 * Open spans that look abandoned: at least `steps` tool calls ran after the task's own last event
 * while other tasks started or finished. Such a span blocks folding of everything inside it, so it
 * is reported instead of folded silently (SPEC-0002 §5.3).
 */
export function staleSpans<B extends SpanBlock>(spans: readonly TaskSpan[], blocks: readonly B[], steps: number): TaskSpan[] {
	return spans.filter((s) => {
		if (s.status !== null) return false;
		const others = spans.filter((o) => o.list === s.list && o.key !== s.key && !o.key.startsWith(`${s.key}.`));
		if (!others.some((o) => o.start > s.lastEvent || (o.status !== null && o.end > s.lastEvent))) return false;
		let calls = 0;
		for (let i = s.lastEvent + 1; i < blocks.length; i++) if (blocks[i].kind === "tool_call") calls++;
		return calls >= steps;
	});
}

const USER_SAID_CHARS = 120;

/** A record without its identity keys, for re-keying a child around `recall`. */
function rest(r: RecordObj): Omit<RecordObj, "task" | "title" | "status" | "recall"> {
	const { task: _t, title: _l, status: _s, recall: _r, ...tail } = r;
	return tail;
}

/** One span's fold: its ops, the span key per group op, and how to restore absorbed child groups. */
interface Unit {
	ops: Op[];
	restore: Op[];
	saved: number;
	key?: string;
	/** For a pressure floor: the open task spans whose content it folded. */
	floorSpans?: string[];
}

type UnitResult = Unit | { declined: string; deferred?: true };

function parseCall(text: string | null | undefined): Record<string, unknown> | null {
	const space = text?.indexOf(" ") ?? -1;
	if (space < 0) return null;
	try {
		const v = JSON.parse(text!.slice(space + 1));
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function taskCoverage(length: number, spans: readonly TaskSpan[]): { open: Uint8Array; finished: Uint8Array } {
	const openDiff = new Int32Array(length + 1);
	const finishedDiff = new Int32Array(length + 1);
	for (const span of spans) for (const interval of span.intervals) {
		const diff = span.status === null ? openDiff : finishedDiff;
		const start = Math.max(0, interval.start);
		const end = Math.min(length - 1, interval.end);
		if (start <= end) { diff[start]++; diff[end + 1]--; }
	}
	const open = new Uint8Array(length);
	const finished = new Uint8Array(length);
	let a = 0, b = 0;
	for (let i = 0; i < length; i++) { a += openDiff[i]; b += finishedDiff[i]; open[i] = Number(a > 0); finished[i] = Number(b > 0); }
	return { open, finished };
}

/** A block as `recordFacts` reads it. */
export interface FactBlock {
	kind: string;
	toolName?: string;
	callId?: string;
	isError?: boolean;
}

/** The record's deterministic fields from a span's own tool traffic: files edited and checks run. */
export function recordFacts<B extends FactBlock>(members: readonly B[], textOf: (b: B) => string): { changed: string[]; verified: string[] } {
	const results = new Map<string, B>();
	for (const b of members) if (b.kind === "tool_result" && b.callId) results.set(b.callId, b);
	const changed = new Set<string>();
	const verified: string[] = [];
	for (const b of members) {
		if (b.kind !== "tool_call") continue;
		const args = parseCall(textOf(b));
		if (EDIT_TOOLS.has(b.toolName ?? "") && typeof args?.path === "string") changed.add(args.path);
		if (b.toolName === "bash" && typeof args?.command === "string" && CHECK_RE.test(args.command)) {
			const r = b.callId ? results.get(b.callId) : undefined;
			const mark = !r ? "no result" : r.isError ? `failed: ${oneLine(textOf(r).split("\n").slice(-3).join(" "), 160)}` : "ok";
			verified.push(`\`${oneLine(args.command, 120)}\` → ${mark}`);
		}
	}
	return { changed: [...changed], verified };
}

/** First block index inside the user's protected-tail dial, which Truth stops enforcing while Taskfold holds `tail-size`. */
export function userTailFrom(blocks: readonly ViewBlock[], protectTokens: number): number {
	if (protectTokens <= 0) return blocks.length;
	let sum = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].kind === "system") return i + 1;
		sum += blocks[i].tokens;
		if (sum >= protectTokens) return i;
	}
	return 0;
}

/** First block index of the newest message. */
function finalMessageFrom(blocks: readonly ViewBlock[]): number {
	let i = blocks.length - 1;
	while (i > 0 && messageKey(blocks[i - 1].id) === messageKey(blocks[i].id)) i--;
	return Math.max(0, i);
}

export class TaskfoldConductor implements Conductor {
	readonly id = "taskfold";
	readonly label = "Taskfold";
	readonly description = "Folds finished task spans into structured task records; user steering folds when a classifier says so.";
	/** Finished tasks ignore the tail dial; pressure folds of open/untracked work still honor it. */
	readonly locks = ["tail-size"] as const;
	readonly tailTokens = 0;
	/** The first request after load or cache expiry waits for the epoch, so a fold lands before the wire leaves instead of one request late. */
	readonly holdWireUpToMs = 2_000;

	private readonly k: Required<TaskfoldOptions>;
	private host: ConductorHost | null = null;
	private off: (() => void) | null = null;
	private busy = false;
	private pending = false;
	/** User block id → verdict; computed once and never recomputed, kept across resumes by the ledger. */
	private readonly verdicts: VerdictLedger;
	private readonly classifying = new Set<string>();
	private readonly classifyQueue: { id: string; state: Record<string, string>; retries: number }[] = [];
	private classifierActive = 0;
	/** Messages routing was attempted for this process, and those whose extraction is in flight. */
	private readonly routeTried = new Set<string>();
	private readonly routing = new Set<string>();
	private classifyFailures = 0;
	/** Model-backed work is waiting for the one-time privacy consent. */
	private awaitingConsent = false;
	/** User blocks skipped while waiting for consent, drained on the first pass that may use a model. */
	private readonly consentQueue = new Set<string>();
	private epochs = 0;
	private rawWarning: string | null = null;
	/** The epoch currently committing, awaited by the wire-departing hold so the first request after load carries its folds. */
	private inflight: Promise<void> | null = null;
	private lastRequestAt: number | null = null;

	constructor(options: TaskfoldOptions = {}, verdicts: VerdictLedger = new VerdictLedger(), private readonly router: RoutingPort = taskfoldRouting, private readonly allowModel: () => boolean = () => true) {
		this.k = { ...TASKFOLD_DEFAULTS, ...options };
		const k = this.k;
		if (!Number.isFinite(k.high) || !Number.isFinite(k.low) || !(k.low > 0 && k.low < k.high && k.high <= 1)) throw new RangeError("taskfold: require 0 < low < high <= 1");
		if (!Number.isSafeInteger(k.keepRecentTasks) || k.keepRecentTasks < 0 || !Number.isSafeInteger(k.recordTokens) || k.recordTokens < 1) throw new RangeError("taskfold: invalid recent-task or record-token limit");
		if (!Number.isSafeInteger(k.untracked.minSteps) || k.untracked.minSteps < 1 || typeof k.untracked.enabled !== "boolean" || typeof k.floor !== "boolean") throw new RangeError("taskfold: invalid pressure-floor or untracked-work settings");
		if (!Number.isSafeInteger(k.steps.minSteps) || k.steps.minSteps < 1 || typeof k.steps.enabled !== "boolean") throw new RangeError("taskfold: invalid open-task step settings");
		if (!isFoldTiming(k.timing)) throw new RangeError("taskfold: invalid timing mode");
		this.verdicts = verdicts;
	}

	attach(host: ConductorHost): void {
		this.host = host;
		this.verdicts.threshold = this.k.maxLoss;
		this.off = host.on((e) => this.onEvent(e));
	}

	detach(): void {
		this.off?.();
		this.off = null;
		this.host?.setStatus(null);
		this.host = null;
		this.classifying.clear();
		this.classifyQueue.length = 0;
		this.classifierActive = 0;
		this.consentQueue.clear();
		this.routeTried.clear();
		this.routing.clear();
		this.busy = false;
		this.pending = false;
	}

	private onEvent(e: HostEvent): void | Promise<void> {
		if (!this.host) return;
		switch (e.type) {
			case "resync":
				// A resync is also how a gate that just opened reaches the messages it held back.
				this.classifyNew(this.host.blocks());
				return this.evaluate();
			case "wire-departing": {
				const host = this.host;
				this.evaluate();
				const sent = () => { if (this.host === host) this.lastRequestAt = Date.now(); };
				return this.inflight ? this.inflight.finally(sent) : sent();
			}
			case "blocks-appended":
				this.classifyNew(e.blocks);
				return this.evaluate();
			case "turn-committed":
				return this.evaluate();
			case "state-changed": {
				const unfolded = e.changes.filter((c) => c.by !== "auto" && c.what === "ungroup" && c.id && c.groupId);
				if (unfolded.length) return this.reconcileTaskUnfold(unfolded.map((c) => ({ id: c.id!, groupId: c.groupId! })));
				if (this.busy || e.changes.every((c) => c.by === "auto")) return;
				return this.evaluate();
			}
			default:
				return;
		}
	}

	private async reconcileTaskUnfold(changes: { id: string; groupId: string }[]): Promise<void> {
		const host = this.host;
		if (!host) return;
		const groups = host.groups();
		const owners = new Set<string>();
		const opened = new Set<string>();
		for (const change of changes) {
			const carrier = groups.find((g) => g.handles?.some((h) => h.id === change.id));
			const owner = carrier ? taskKeyOfSummary(carrier.summary) : taskKeyOfSummary(groups.find((g) => g.id === change.groupId)?.summary);
			if (owner) owners.add(owner);
			if (change.id.startsWith("t:")) opened.add(change.id.slice(2));
			else if (owner && carrier) {
				const ids = new Set(carrier.handles?.find((h) => h.id === change.id)?.memberIds ?? []);
				const blocks = host.blocks();
				const matching = this.spans(blocks).filter((s) => s.key.startsWith(`${owner}.`) && s.intervals.some((r) => blocks.slice(r.start, r.end + 1).some((b) => ids.has(b.id))));
				const leaves = matching.filter((s) => !matching.some((other) => other.key.startsWith(`${s.key}.`)));
				if (leaves.length) for (const s of leaves) opened.add(s.key);
				else opened.add(owner);
			} else if (owner) opened.add(owner);
		}
		for (const key of opened) {
			const count = (this.verdicts.unfoldStates().get(key)?.count ?? 0) + 1;
			if (!this.verdicts.setUnfold(key, { count, open: true })) host.setStatus("Taskfold could not persist the unfolded-task state.", { level: "warning" });
		}
		const ops: Op[] = groups.filter((g) => g.by === "auto" && owners.has(taskKeyOfSummary(g.summary) ?? "")).map((g) => ({ kind: "ungroup", groupId: g.id }));
		if (!ops.length) return;
		this.busy = true;
		try {
			const result = await host.propose({ baseRev: host.stats().rev, ops });
			if (result.results.some((r) => !r.applied)) host.setStatus("Could not recompose the unfolded task; its groups remain open.", { level: "warning" });
		} catch (error) {
			host.setStatus(`Could not recompose the unfolded task: ${error instanceof Error ? error.message : String(error)}`, { level: "warning" });
		} finally {
			this.busy = false;
			if (this.host === host) {
				const plan = this.plan(host, owners);
				if (plan.length) void this.commit(host, plan);
			}
		}
	}

	private groupKeys(host: ConductorHost): Map<string, string> {
		const keys = new Map<string, string>();
		for (const g of host.groups()) {
			const key = g.by === "auto" ? taskKeyOfSummary(g.summary) : null;
			if (key) keys.set(g.id, key);
		}
		return keys;
	}

	// ── user-message classification ─────────────────────────────────────────────────────────

	private classifyNew(blocks: readonly ViewBlock[]): void {
		// Without consent the deterministic tooling still runs; classification and routing wait, and
		// their messages stay unverdicted so a later consent picks them up instead of freezing them.
		if (!this.allowModel()) {
			for (const b of blocks) if (b.kind === "user" && !this.verdicts.has(b.id)) this.consentQueue.add(b.id);
			if (!this.awaitingConsent) {
				this.awaitingConsent = true;
				this.host?.setStatus("deterministic tooling active; classifier: awaiting consent.", {
					level: "warning",
					classifier: "awaiting consent",
				});
			}
			return;
		}
		if (this.awaitingConsent) {
			this.awaitingConsent = false;
			this.host?.setStatus(null);
		}
		if (this.consentQueue.size) {
			const all = this.host?.blocks() ?? [];
			const ids = new Set(this.consentQueue);
			this.consentQueue.clear();
			this.classifyBlocks(all.filter((b) => ids.has(b.id) && !this.verdicts.has(b.id)));
		}
		this.classifyBlocks(blocks);
	}

	private classifyBlocks(blocks: readonly ViewBlock[]): void {
		for (const b of blocks) {
			if (b.kind !== "user" || this.verdicts.has(b.id) || this.classifying.has(b.id)) continue;
			const text = this.textOf(b);
			if (this.k.harnessPatterns.some((re) => re.test(text))) {
				this.verdicts.set(b.id, { loss: 0, source: "harness" });
				continue;
			}
			const state = this.stateFor(b.id, text);
			if (!state) {
				this.verdicts.set(b.id, { loss: null, source: "opening" });
				continue;
			}
			// Only a message that has not reached the model yet is new; a resumed session's history is born sent.
			if (!b.sent) void this.routeOne(b.id, text);
			this.classifying.add(b.id);
			this.classifyQueue.push({ id: b.id, state, retries: 0 });
		}
		this.drainClassifiers();
	}

	/** The classifier's view of a user message, shaped like the calibration data; null for the session's opening message. */
	private stateFor(id: string, text: string): Record<string, string> | null {
		const all = this.host?.blocks() ?? [];
		const i = all.findIndex((b) => b.id === id);
		const users = all.slice(0, Math.max(0, i)).filter((b) => b.kind === "user");
		if (i < 0 || !users.length) return null;
		let j = i - 1;
		while (j >= 0 && all[j].kind !== "text") j--;
		const reply = j < 0 ? "" : all.filter((b) => b.kind === "text" && messageKey(b.id) === messageKey(all[j].id)).map((b) => this.textOf(b)).join("\n");
		return {
			session_goal: this.textOf(users[0]).slice(0, GOAL_CHARS),
			previous_user_message: users.length > 1 ? this.textOf(users[users.length - 1]).slice(0, NEIGHBOUR_CHARS) : "",
			assistant_last_reply: reply.slice(-NEIGHBOUR_CHARS),
			message: text.slice(0, MESSAGE_CHARS),
		};
	}

	/** The text of the assistant turn before block `id`, or "". */
	private lastReply(id: string): string {
		const all = this.host?.blocks() ?? [];
		let j = all.findIndex((b) => b.id === id) - 1;
		while (j >= 0 && all[j].kind !== "text") j--;
		return j < 0 ? "" : all.filter((b) => b.kind === "text" && messageKey(b.id) === messageKey(all[j].id)).map((b) => this.textOf(b)).join("\n");
	}

	/**
	 * Extract the message's durable content into the attached task list (SPEC-0002 §4.6). Runs off the
	 * request path; any failure leaves the message raw, which is today's behaviour.
	 */
	private async routeOne(id: string, text: string): Promise<void> {
		const host = this.host;
		const port = this.router.current;
		if (!host || !port || this.routeTried.has(id) || this.verdicts.get(id)?.routed) return;
		const request = port.prepare(text.slice(0, MESSAGE_CHARS * 4), this.lastReply(id).slice(-NEIGHBOUR_CHARS * 2));
		if (!request) return;
		this.routeTried.add(id);
		this.routing.add(id);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const reply = await host.complete({ system: request.system, prompt: request.prompt, maxOutputTokens: ROUTE_MAX_OUTPUT_TOKENS, signal: controller.signal });
				if (this.host !== host) return;
				if (reply.stopReason === "length") throw new Error("extraction truncated at the output limit");
				if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`extraction provider ${reply.stopReason}`);
				try {
					const result = await request.apply(reply.text, text);
					if (this.host !== host) return;
					if (result.applied || result.ids.length) this.verdicts.route(id, { ids: result.ids, at: new Date().toISOString() });
					break;
				} catch (error) {
					if (!(error instanceof RoutingParseError) || attempt > 0 || controller.signal.aborted) throw error;
					host.debug?.({ type: "route-retry", id, error: error.message });
				}
			}
		} catch (error) {
			if (this.host === host) host.setStatus(`Taskfold could not route a message into the task list: ${error instanceof Error ? error.message : String(error)}`, { level: "warning" });
		} finally {
			clearTimeout(timer);
			this.routing.delete(id);
		}
		// Either way the message's fate is settled: fold around it raw, or with its span.
		if (this.host === host) void this.evaluate();
	}

	private drainClassifiers(): void {
		while (this.host?.classify && this.classifierActive < 2 && this.classifyQueue.length) {
			const item = this.classifyQueue.shift()!;
			this.classifierActive++;
			void this.classifyOne(item);
		}
	}

	private async classifyOne(item: { id: string; state: Record<string, string>; retries: number }): Promise<void> {
		const { id, state } = item;
		const host = this.host;
		if (!host?.classify) return;
		let retry = false;
		try {
			const res = await host.classify({ state, questions: USER_QUESTIONS });
			if (this.host !== host) return;
			const a = res.answers.loss as ClassifierAnswer | undefined;
			const answers: Record<string, number> = {};
			for (const [k, v] of Object.entries(res.answers)) if (k !== "loss" && v?.type === "bool") answers[k] = v.probability;
			this.verdicts.set(
				id,
				a?.type === "score"
					? { loss: a.score, source: "classifier", confidence: a.confidence, answers, model: res.model, at: new Date().toISOString() }
					: { loss: null, source: "error" },
			);
		} catch (error) {
			if (this.host !== host) return;
			if (error instanceof Error && /^too many concurrent model calls in flight \(max \d+\)$/.test(error.message) && item.retries < 3) {
				item.retries++;
				this.classifyQueue.push(item);
				retry = true;
				return;
			}
			// Unclassified stays verbatim. Remember the failure so a broken classifier is visible.
			this.verdicts.set(id, { loss: null, source: "error" });
			this.classifyFailures++;
		} finally {
			if (this.host === host) {
				if (!retry) this.classifying.delete(id);
				this.classifierActive--;
				this.drainClassifiers();
			}
		}
		if (this.host === host) void this.evaluate();
	}

	private textOf(b: ViewBlock): string {
		return b.text ?? this.host?.textOf(b.id) ?? "";
	}

	private folds(b: ViewBlock): boolean {
		return this.verdicts.folds(this.verdicts.get(b.id), this.k.maxLoss);
	}

	// ── span discovery ──────────────────────────────────────────────────────────────────────

	/** Every finished task span in the log, innermost first when two end together. */
	spans(blocks: readonly ViewBlock[]): Span[] {
		return scanTaskSpans(blocks, (b) => this.textOf(b)).filter((s): s is Span => s.status !== null);
	}

	// ── planning ────────────────────────────────────────────────────────────────────────────

	private evaluate(): void | Promise<void> {
		const host = this.host;
		if (!host) return;
		if (this.busy) {
			this.pending = true;
			return;
		}
		const stats = host.stats();
		const pressure = stats.budget > 0 && stats.liveTokens >= this.k.high * stats.budget;
		const plan = this.plan(host, undefined, pressure);
		if (!plan.length) {
			if (!pressure) {
				if (this.rawWarning) host.setStatus(this.rawWarning, { level: "warning" });
				else if (!this.awaitingConsent) host.setStatus(`Epoch ${this.epochs}: no fold operations needed.`, {
					epochs: this.epochs, groups: this.groupKeys(host).size, live_tokens: stats.liveTokens, budget: stats.budget,
					...(this.classifyFailures ? { level: "warning" } : {}),
				});
				return;
			}
			const blocks = host.blocks();
			const scanned = scanTaskSpans(blocks, (b) => this.textOf(b));
			const stale = staleSpans(scanned, blocks, ZOMBIE_STEPS).map((s) => s.key);
			const open = scanned.filter((s) => s.status === null).map((s) => ({ span: s, tokens: blocks.reduce((n, b, i) => n + (s.intervals.some((r) => r.start <= i && i <= r.end) ? (b.liveTokens ?? (b.folded ? b.foldedTokens : b.tokens)) : 0), 0) })).sort((a, b) => b.tokens - a.tokens)[0];
			const holder = open ? `open task ${open.span.key} (~${open.tokens} tokens)` : "protected, held or otherwise ineligible context";
			host.setStatus(`Taskfold saturated: ${holder}; no safe fold is available.${stale.length ? ` Stale open task${stale.length > 1 ? "s" : ""}: ${stale.join(", ")}.` : ""}`, { epochs: this.epochs, groups: this.groupKeys(host).size, level: "error" });
			return;
		}
		const run = this.commit(host, plan).finally(() => { if (this.inflight === run) this.inflight = null; });
		this.inflight = run;
		return run;
	}

	private policy(host: ConductorHost): FoldingPolicy {
		return host.foldPolicy?.() ?? { timing: this.k.timing, cache: cacheProfileFor("*"), now: Date.now(), lastRequestAt: this.lastRequestAt };
	}

	/** Pressure relief runs in every mode; finished records obey the epoch's timing policy. */
	private plan(host: ConductorHost, recompose?: ReadonlySet<string>, pressure = true): Unit[] {
		const blocks = host.blocks();
		const stats = host.stats();
		const allSpans = this.spans(blocks);
		const contains = (outer: Span, inner: Span) => inner.key.startsWith(`${outer.key}.`);
		if (!recompose && pressure) {
			const allRoots = allSpans.filter((s) => !allSpans.some((o) => contains(o, s)));
			for (const [key, state] of this.verdicts.unfoldStates()) {
				const root = allRoots.find((s) => key === s.key || key.startsWith(`${s.key}.`));
				if (state.open && root && state.count === 1 && allRoots.filter((s) => s.end > root.end).length >= 2 && !this.verdicts.setUnfold(key, { ...state, open: false })) host.setStatus("Taskfold could not persist the unfolded-task state.", { level: "warning" });
			}
		}
		const open = [...this.verdicts.unfoldStates()].filter(([, state]) => state.open).map(([key]) => key);
		const spans = allSpans.filter((s) => !open.some((key) => s.key === key || s.key.startsWith(`${key}.`) || key.startsWith(`${s.key}.`)));
		// Outermost finished spans are the fold units; finished descendants fold inside them.
		const roots = spans.filter((s) => !spans.some((o) => contains(o, s))).sort((a, b) => a.start - b.start);
		const groupKeys = this.groupKeys(host);
		const foldedKeys = new Set(groupKeys.values());
		const foldedHandles = host.groups().flatMap((g) => {
			if (!groupKeys.has(g.id) || !g.folded || typeof g.summary !== "string") return [];
			const shown = visibleTags(g.summary);
			return (g.handles ?? []).filter((h) => h.id.startsWith("t:") && shown.has(foldTag(h.id))).map((h) => ({ key: h.id.slice(2), members: new Set(h.memberIds) }));
		});
		for (const span of spans) {
			if (foldedKeys.has(span.key)) continue;
			let last = span.end;
			if (this.k.leafForm === "bracket" && span.closingCall !== undefined) {
				last = span.closingCall;
				while (last > 0 && messageKey(blocks[last - 1].id) === messageKey(blocks[span.closingCall].id)) last--;
				last--;
			}
			if (!span.intervals.some((r) => r.start <= last)) continue;
			if (foldedHandles.some((h) => (span.key === h.key || span.key.startsWith(`${h.key}.`)) && span.intervals.every((r) => blocks.slice(r.start, Math.min(r.end, last) + 1).every((b) => h.members.has(b.id))))) foldedKeys.add(span.key);
		}
		const reasons = new Map<string, string>(allSpans.filter((s) => !spans.includes(s)).map((s) => [s.key, "unfolded-by-agent"]));
		const recent = new Set([...roots].sort((a, b) => b.end - a.end).slice(0, this.k.keepRecentTasks).map((s) => s.key));
		const candidates = recompose ? roots.filter((s) => [...recompose].some((key) => s.key.startsWith(`${key}.`))) : roots.filter((s) => !recent.has(s.key));
		const policy = this.policy(host);
		const cold = policy.lastRequestAt === null || policy.now - policy.lastRequestAt >= policy.cache.ttlMs;
		const timingAllows = policy.timing === "eager" || pressure || (policy.timing === "lazy" && cold);
		const units: Unit[] = [];
		let projected = stats.liveTokens;
		const target = this.k.low * stats.budget;
		const planned = new Set<string>();
		for (const span of roots) if (recent.has(span.key)) reasons.set(span.key, "keep-recent-tasks");
		const fold = (span: Span, eager = false): void => {
			if (!recompose && !eager && projected <= target) { reasons.set(span.key, "below-target"); return; }
			const descendants = spans.filter((s) => contains(span, s));
			const result: UnitResult = foldedKeys.has(span.key) ? { declined: "already-folded" } : this.unit(host, blocks, span, descendants, planned);
			if ("declined" in result) {
				reasons.set(span.key, result.declined);
				if (result.deferred && !pressure) return;
				for (const child of descendants.filter((s) => !descendants.some((o) => contains(o, s)))) fold(child, eager);
				return;
			}
			const unit = result;
			reasons.set(span.key, "planned");
			units.push(unit);
			for (const op of unit.ops) if (op.kind === "group") for (const id of op.ids) planned.add(id);
			projected -= unit.saved;
			// A finished descendant whose work lies outside the carrier (it ran while the parent was not open) folds on its own.
			for (const child of descendants.filter((s) => !descendants.some((o) => contains(o, s)))) {
				const outside = blocks.some((b, i) => child.intervals.some((r) => r.start <= i && i <= r.end) && !planned.has(b.id));
				if (outside && !foldedKeys.has(child.key)) fold(child, eager);
			}
		};
		for (const span of candidates) {
			if (!recompose && !timingAllows) reasons.set(span.key, `timing-${policy.timing}`);
			else fold(span, !recompose);
		}
		if (!recompose && pressure) {
			for (const span of roots.filter((s) => recent.has(s.key))) fold(span);
			const condensed = projected > target ? this.condense(host, blocks, projected - target, planned) : null;
			if (condensed) {
				units.push(condensed);
				for (const op of condensed.ops) if (op.kind === "group") for (const id of op.ids) planned.add(id);
				projected -= condensed.saved;
			}
			if (projected > target && this.k.floor) {
				for (const scope of ["open", "untracked"] as const) {
					if (projected <= target) break;
					const floor = this.floor(host, blocks, projected, target, planned, scope);
					if (!floor) continue;
					units.push(floor);
					for (const op of floor.ops) {
						if (op.kind === "fold") for (const id of op.ids) planned.add(id);
						else if (op.kind === "replace") planned.add(op.id);
					}
					projected -= floor.saved;
				}
			}
			if (projected > target && this.k.untracked.enabled) {
				const outside = this.untracked(host, blocks, projected - target, planned);
				units.push(...outside);
				for (const u of outside) { projected -= u.saved; for (const op of u.ops) if (op.kind === "group") for (const id of op.ids) planned.add(id); }
			}
			if (projected > target && this.k.steps.enabled) units.push(...this.steps(host, blocks, projected - target, planned));
		}
		const diagnostics = allSpans.map((span) => {
			const ancestor = allSpans.filter((s) => contains(s, span) && reasons.has(s.key)).sort((a, b) => b.key.length - a.key.length)[0];
			const reason = reasons.get(span.key) ?? (ancestor ? `ancestor:${reasons.get(ancestor.key)}` : "not-selected");
			const stepsSince = blocks.slice(span.end + 1).filter((b) => b.kind === "tool_result").length;
			return { key: span.key, reason, stepsSince };
		});
		const zombie = diagnostics.find((d) => d.stepsSince > ZOMBIE_STEPS && !d.reason.includes("planned") && !d.reason.includes("already-folded"));
		this.rawWarning = zombie ? `Taskfold: ${zombie.key} still raw after ${zombie.stepsSince} steps (${zombie.reason}).` : null;
		host.debug?.({ type: "epoch", pressure, timing: policy.timing, cold, cache: policy.cache, units: units.length, tasks: diagnostics });
		return units;
	}

	/** Pressure row of SPEC-0002 §8: folded records inside open roots become history entries, oldest first, until `need` tokens are freed. */
	private condense(host: ConductorHost, blocks: readonly ViewBlock[], need: number, planned: ReadonlySet<string>): Unit | null {
		const positions = new Map(blocks.map((b, i) => [b.id, i]));
		const ours = host.groups()
			.filter((g) => g.by === "auto" && g.folded && typeof g.summary === "string" && parseCarrier(g.summary)?.obj.task !== undefined && !g.memberIds.some((id) => planned.has(id)))
			.sort((a, b) => (positions.get(a.memberIds[0]) ?? 0) - (positions.get(b.memberIds[0]) ?? 0));
		const ops: Op[] = [];
		const restore: Op[] = [];
		let saved = 0;
		for (const g of ours) {
			if (saved >= need) break;
			const entry = priorEntry(g.summary as string);
			if (!entry || isHistory(entry)) continue;
			const { recall: tag, ...history } = toHistory(entry);
			const text = render(parseCarrier(g.summary)!.tag, history);
			const gain = host.countTokens(g.summary as string) - host.countTokens(text);
			if (gain <= 0 || !tag) continue;
			const handles = (g.handles ?? []).filter((h) => text.includes(foldTag(h.id))).map((h) => ({ id: h.id, memberIds: [...h.memberIds] }));
			ops.push({ kind: "ungroup", groupId: g.id }, { kind: "group", ids: g.memberIds.slice(), summary: text, role: "assistant", ...(handles.length ? { handles } : {}) });
			restore.push({ kind: "group", ids: g.memberIds.slice(), summary: g.summary, role: "assistant", ...(g.handles ? { handles: g.handles.map((h) => ({ id: h.id, memberIds: [...h.memberIds] })) } : {}) } as Op);
			saved += gain;
		}
		return ops.length ? { ops, restore, saved } : null;
	}

	/** The open spans a floor unit touched, so the coach can tell the agent its own span was shrunk. */
	private floorSpans(ops: readonly Op[], blocks: readonly ViewBlock[], spans: readonly TaskSpan[], positions: ReadonlyMap<string, number>, coverage: { open: Uint8Array }): string[] {
		const touched = new Set<string>();
		for (const op of ops) {
			const ids = op.kind === "fold" || op.kind === "group" ? op.ids : "id" in op ? [op.id] : [];
			for (const id of ids) {
				const i = positions.get(id);
				if (i === undefined || !coverage.open[i]) continue;
				const span = spans.find((s) => s.status === null && s.intervals.some((r) => r.start <= i && i <= r.end));
				if (span) touched.add(span.key);
			}
		}
		return [...touched];
	}

	private floor(host: ConductorHost, blocks: readonly ViewBlock[], live: number, target: number, planned: ReadonlySet<string>, scope: "open" | "untracked"): Unit | null {
		const spans = scanTaskSpans(blocks, (b) => this.textOf(b));
		const coverage = taskCoverage(blocks.length, spans);
		const positions = new Map(blocks.map((b, i) => [b.id, i]));
		const userTail = userTailFrom(blocks, host.stats().protectTokens);
		const documents = new Set<string>();
		for (const b of blocks) {
			if (b.kind !== "tool_call" || !b.callId || b.toolName !== "read") continue;
			const path = parseCall(this.textOf(b))?.path;
			if (typeof path === "string" && /\.(md|mdx|markdown|rst|txt|adoc)$/i.test(path)) documents.add(b.callId);
		}
		const mask = (b: ViewBlock): ViewBlock => {
			const i = positions.get(b.id) ?? -1;
			const allowed = i >= 0 && (scope === "open" ? !!coverage.open[i] && !coverage.finished[i] : !coverage.open[i] && !coverage.finished[i]);
			return !allowed || i >= userTail || planned.has(b.id) || (b.callId && documents.has(b.callId)) ? { ...b, held: true } : b;
		};
		const proxy: ConductorHost = {
			on: () => () => {}, get: (id) => { const b = host.get(id); return b ? mask(b) : undefined; },
			blocks: () => host.blocks().map(mask), groups: () => host.groups(), textOf: (id) => host.textOf(id),
			stats: () => host.stats(), systemPrompt: () => host.systemPrompt(), countTokens: (text) => host.countTokens(text),
			digestOf: (id) => host.digestOf(id), complete: (req) => host.complete(req), setStatus: () => {}, propose: (txn) => host.propose(txn),
		};
		const keel = new KeelLiteConductor({ high: this.k.high, low: this.k.low, maxRung: 5, groupSteps: false });
		keel.attach(proxy);
		try {
			const result = keel.planPressure(proxy, live, target);
			if (!result) return null;
			const touched = scope === "open" ? this.floorSpans(result.ops, blocks, spans, positions, coverage) : [];
			return { ops: result.ops, saved: result.saved, restore: [], ...(touched.length ? { floorSpans: touched } : {}) };
		} finally { keel.detach(); }
	}

	private untracked(host: ConductorHost, blocks: readonly ViewBlock[], need: number, planned: ReadonlySet<string>): Unit[] {
		const coverage = taskCoverage(blocks.length, scanTaskSpans(blocks, (b) => this.textOf(b)));
		return this.foldRuns(host, blocks, need, planned, this.k.untracked.minSteps, (i) => (!coverage.open[i] && !coverage.finished[i] ? "" : null), (tag, _key, members, label, facts) => untrackedCarrier(tag, label, facts.changed, facts.verified));
	}

	/**
	 * Old finished steps of still-open tasks, grouped per innermost open task. The task's start or
	 * resume message, user messages, document reads and the user's tail dial stay live; finished
	 * subtasks fold as their own records.
	 */
	private steps(host: ConductorHost, blocks: readonly ViewBlock[], need: number, planned: ReadonlySet<string>): Unit[] {
		const spans = scanTaskSpans(blocks, (b) => this.textOf(b));
		const open = spans.filter((s) => s.status === null).sort((a, b) => a.key.split(".").length - b.key.split(".").length || a.start - b.start);
		if (!open.length) return [];
		const coverage = taskCoverage(blocks.length, spans);
		const owner = new Array<string | undefined>(blocks.length);
		const anchors = new Set<string>();
		for (const s of open) {
			for (const r of s.intervals) for (let i = Math.max(0, r.start); i <= Math.min(blocks.length - 1, r.end); i++) owner[i] = s.key;
			for (const i of [s.start, s.lastEvent]) if (blocks[i]) anchors.add(messageKey(blocks[i].id));
		}
		return this.foldRuns(host, blocks, need, planned, this.k.steps.minSteps, (i) => (owner[i] !== undefined && !coverage.finished[i] && !anchors.has(messageKey(blocks[i].id)) ? owner[i]! : null), (tag, key, members, label, facts) => stepsCarrier(tag, key, label, new Set(members.filter((b) => b.kind === "tool_call" || b.kind === "text").map((b) => messageKey(b.id))).size, facts.changed, facts.verified));
	}

	/** Group maximal runs of whole messages sharing one non-null `ownerOf` key into recallable carriers, oldest first, until `need` is met. */
	private foldRuns(
		host: ConductorHost,
		blocks: readonly ViewBlock[],
		need: number,
		planned: ReadonlySet<string>,
		minSteps: number,
		ownerOf: (i: number) => string | null,
		carrierOf: (tag: string, key: string, members: ViewBlock[], label: string, facts: { changed: string[]; verified: string[] }) => string,
	): Unit[] {
		const occupied = new Set<string>(host.groups().flatMap((g) => [...g.memberIds]));
		const documentCalls = new Set<string>();
		for (const b of blocks) {
			if (b.kind !== "tool_call" || !b.callId || b.toolName !== "read") continue;
			const path = parseCall(this.textOf(b))?.path;
			if (typeof path === "string" && /\.(md|mdx|markdown|rst|txt|adoc)$/i.test(path)) documentCalls.add(b.callId);
		}
		const userTail = Math.min(userTailFrom(blocks, host.stats().protectTokens), finalMessageFrom(blocks));
		const eligible = (b: ViewBlock, i: number) => i < userTail && !b.protected && !b.held && b.kind !== "system" && b.kind !== "user" && !occupied.has(b.id) && !planned.has(b.id) && !(b.callId && documentCalls.has(b.callId));
		const runs: { key: string; members: ViewBlock[] }[] = [];
		let run: ViewBlock[] = [];
		let runKey: string | null = null;
		const flush = () => { if (run.length && runKey !== null) runs.push({ key: runKey, members: run }); run = []; runKey = null; };
		for (let i = 0; i < blocks.length;) {
			let end = i + 1;
			while (end < blocks.length && messageKey(blocks[end].id) === messageKey(blocks[i].id)) end++;
			const key = ownerOf(i);
			const ok = key !== null && blocks.slice(i, end).every((b, j) => eligible(b, i + j) && ownerOf(i + j) === key);
			if (!ok || key !== runKey) flush();
			if (ok) { run.push(...blocks.slice(i, end)); runKey = key; }
			i = end;
		}
		flush();
		const units: Unit[] = [];
		let saved = 0;
		for (const { key, members } of runs) {
			if (saved >= need) break;
			const steps = new Set(members.filter((b) => b.kind === "text" || b.kind === "thinking" || b.kind === "tool_call").map((b) => messageKey(b.id)));
			if (steps.size < minSteps) continue;
			const collapsible = collapsibleMessageKeys(members, true);
			if (!collapsible.size) continue;
			const firstText = members.find((b) => b.kind === "text");
			const label = firstText ? oneLine(this.textOf(firstText), 120) : key ? `Steps of ${key}` : "Work outside tasks";
			const summary = carrierOf(foldTag(`g:${members[0].id}`), key, members, label, recordFacts(members, (b) => this.textOf(b)));
			const current = members.reduce((n, b) => n + (collapsible.has(messageKey(b.id)) ? (b.liveTokens ?? (b.folded ? b.foldedTokens : b.tokens)) : 0), 0);
			const reclaimed = current - host.countTokens(summary);
			if (reclaimed <= 0) continue;
			units.push({ ops: [{ kind: "group", ids: members.map((b) => b.id), summary, role: "assistant" }], restore: [], saved: reclaimed });
			saved += reclaimed;
		}
		return units;
	}

	/** The ops folding one span, or null when any part of it is not ours to fold right now. */
	private unit(host: ConductorHost, blocks: readonly ViewBlock[], span: Span, children: Span[], planned: ReadonlySet<string> = new Set()): UnitResult {
		// Groups of this span's subtasks are absorbed; any other group (a neighbour's record sharing a
		// boundary message, a foreign group) must stay outside the span.
		const childKey = (key: string | undefined) => !!key && key.startsWith(`${span.key}.`);
		const groupKeys = this.groupKeys(host);
		// Step carriers folded while this span or a descendant was open are absorbed into its record.
		const stepsKeys = new Map(host.groups().flatMap((g) => { const k = g.by === "auto" ? stepsKeyOfSummary(g.summary) : null; return k ? [[g.id, k] as const] : []; }));
		const owns = (gid: string) => childKey(groupKeys.get(gid)) || ((k) => !!k && (k === span.key || k.startsWith(`${span.key}.`)))(stepsKeys.get(gid));
		const groupOf = new Map<string, string>();
		for (const g of host.groups()) for (const id of g.memberIds) groupOf.set(id, g.id);
		const foreign = (b: ViewBlock) => {
			if (planned.has(b.id)) return true;
			const gid = groupOf.get(b.id);
			return !!gid && !owns(gid);
		};
		if ([span, ...children].some((s) => {
			const end = blocks[s.end];
			const call = end?.callId ? blocks.find((b) => b.kind === "tool_call" && b.callId === end.callId) : undefined;
			const start = blocks[s.start];
			const result = start?.callId ? blocks.find((b) => b.kind === "tool_result" && b.callId === start.callId) : undefined;
			const heldByHuman = (b: ViewBlock | undefined) => !!b && (b.held || host.groups().some((g) => g.by !== "auto" && g.memberIds.includes(b.id)));
			return s.intervals.length > 0 && ([end, call].some((b) => b && (b.held || foreign(b))) || [start, result].some(heldByHuman));
		})) return { declined: "held-boundary" };
		const sameMsg = (i: number, j: number) => messageKey(blocks[i].id) === messageKey(blocks[j].id);
		let lo = span.start;
		const closingCall = this.k.leafForm === "bracket" ? span.closingCall : undefined;
		const bracket = closingCall !== undefined;
		let hi = closingCall === undefined ? span.end : closingCall - 1;
		while (closingCall !== undefined && hi >= lo && sameMsg(hi, closingCall)) hi--;
		if (hi < lo) return { declined: "no-whole-message" };
		// Snap outward to whole messages, exactly like Truth's group snap, so the group id is predictable.
		while (lo > 0 && sameMsg(lo - 1, lo)) lo--;
		while (hi < blocks.length - 1 && sameMsg(hi + 1, hi)) hi++;
		// A boundary message already inside another group (`complete A` and `start B` in one assistant
		// message) is left to that group: pull the edge in to the next whole message.
		while (lo <= hi && foreign(blocks[lo])) {
			lo++;
			while (lo <= hi && lo > 0 && sameMsg(lo - 1, lo)) lo++;
		}
		// The same holds for a trailing message that is protected or held, e.g. `complete A` batched
		// with B's work into the newest message: A's record ends before it.
		const snapHi = hi;
		while (hi >= lo && (foreign(blocks[hi]) || blocks[hi].protected || blocks[hi].held)) {
			hi--;
			while (hi >= lo && hi < blocks.length - 1 && sameMsg(hi + 1, hi)) hi--;
		}
		if (lo > hi) return { declined: "no-whole-message" };
		// A span whose own tail is still protected (only without the tail-size lock) folds once it leaves the tail: a folded span is never re-extended.
		if (blocks.slice(hi + 1, snapHi + 1).some((b, k) => b.protected && span.intervals.some((r) => r.start <= hi + 1 + k && hi + 1 + k <= r.end))) {
			return { declined: "protected-tail", deferred: true };
		}
		// A record never ends the request: the wire would end on an assistant carrier (prefill). The next appended step re-runs the epoch.
		if (finalMessageFrom(blocks) <= hi) {
			return { declined: "prefill-guard", deferred: true };
		}
		const members = blocks.slice(lo, hi + 1);
		// A fold is never re-extended, so a user message still being classified must settle first; its verdict re-runs the epoch.
		if (members.some((b) => b.kind === "user" && (this.classifying.has(b.id) || this.routing.has(b.id)))) {
			return { declined: "pending-classification-or-routing", deferred: true };
		}
		const allowed = new Set<number>();
		for (const interval of span.intervals) {
			let a = interval.start;
			let z = interval.end;
			while (a > 0 && sameMsg(a - 1, a)) a--;
			while (z < blocks.length - 1 && sameMsg(z + 1, z)) z++;
			for (let i = Math.max(lo, a); i <= Math.min(hi, z); i++) allowed.add(i);
		}
		const excludedGroups = new Set<string>();
		const makeRuns = (): ViewBlock[][] => {
			const runs: ViewBlock[][] = [];
			let run: ViewBlock[] = [];
			for (let i = lo; i <= hi; i++) {
				const b = blocks[i];
				const gid = groupOf.get(b.id);
				if (!allowed.has(i) || foreign(b) || (gid && excludedGroups.has(gid)) || b.protected || b.held || b.kind === "system" || (b.kind === "user" && !this.folds(b))) {
					if (run.length) runs.push(run);
					run = [];
				} else run.push(b);
			}
			if (run.length) runs.push(run);
			return runs.filter((r) => collapsibleMessageKeys(r, true).size > 0);
		};
		let viable = makeRuns();
		for (const g of host.groups()) {
			if (!owns(g.id)) continue;
			const matching = viable.filter((r) => r.some((b) => g.memberIds.includes(b.id)));
			if (matching.length && (matching.length !== 1 || g.memberIds.some((id) => !matching[0].some((b) => b.id === id)))) excludedGroups.add(g.id);
		}
		if (excludedGroups.size) viable = makeRuns();
		if (!viable.length) return { declined: "no-collapsible-run" };
		const memberIds = new Set(viable.flatMap((r) => r.map((b) => b.id)));
		const positions = new Map(blocks.map((b, i) => [b.id, i]));
		const ours = host.groups().filter((g) => owns(g.id) && !excludedGroups.has(g.id) && g.memberIds.some((id) => memberIds.has(id))).sort((a, b) => (positions.get(a.memberIds[0]) ?? 0) - (positions.get(b.memberIds[0]) ?? 0));

		const included = new Set(viable.flatMap((r) => r.map((b) => b.id)));
		const hidden = new Set(viable.flatMap((run) => {
			const keys = collapsibleMessageKeys(run, true);
			return run.filter((b) => keys.has(messageKey(b.id))).map((b) => b.id);
		}));
		const spanHandle = (task: Span) => ({ id: `t:${task.key}`, memberIds: blocks.filter((_b, i) => task.intervals.some((r) => r.start <= i && i <= r.end) && (!bracket || i <= hi)).map((b) => b.id) });
		const covered = (h: { memberIds: string[] }) => h.memberIds.every((id) => included.has(id) || members.some((b) => b.id === id && b.kind === "user" && !this.folds(b)));
		const rootHandle = spanHandle(span);
		const handles = [...ours.map((g) => ({ id: g.id, memberIds: g.memberIds.slice() })), ...ours.flatMap((g) => (g.handles ?? []).map((h) => ({ id: h.id, memberIds: [...h.memberIds] }))), ...(covered(rootHandle) ? [rootHandle] : []), ...children.filter((child) => child.intervals.length > 0).map(spanHandle)];
		const unique = [...new Map(handles.map((h) => [h.id, h])).values()];
		// A handle the carrier cannot fully own is dropped, not a veto: its child keeps a record without a recall code, or none when the carrier holds none of it.
		const usable = unique.filter((h) => h.memberIds.length > 0 && covered(h));
		const reach = new Map<string, "full" | "partial" | "none">();
		for (const child of children) {
			if (!child.intervals.length) continue;
			const h = spanHandle(child);
			reach.set(child.key, h.memberIds.length > 0 && covered(h) ? "full" : h.memberIds.some((id) => included.has(id)) ? "partial" : "none");
		}
		const prior = new Map<string, RecordObj | HistoryObj>();
		for (const g of ours) {
			const key = taskKeyOfSummary(g.summary);
			const entry = key && typeof g.summary === "string" ? priorEntry(g.summary) : null;
			if (key && entry) prior.set(key, entry);
		}
		// Preserve nested history reductions when rebuilding their ancestors.
		for (const entry of prior.values()) {
			if (isHistory(entry)) continue;
			for (const child of entry.children ?? []) {
				const key = isHistory(child) ? child.history : child.task;
				if (!prior.has(key)) prior.set(key, child);
			}
		}
		const rootCovered = covered(rootHandle);
		const lastRun = viable[viable.length - 1];
		const tag = rootCovered ? foldTag(`t:${span.key}`) : foldTag(`g:${lastRun[0].id}`);
		const entry = this.record(span, blocks, children, prior, included, reach, hidden);
		const isRoot = !span.id.includes(".");
		const carrier: RecordObj | HistoryObj = isRoot ? toHistory(entry) : entry;
		while (!isHistory(carrier) && estTokens(JSON.stringify(carrier.children ?? [])) > this.k.recordTokens) {
			if (!shrinkDeepest(carrier)) break;
		}
		const text = render(tag, carrier);
		const shown = visibleTags(text);
		const visible = usable.filter((h) => shown.has(foldTag(h.id)));
		const ops: Op[] = ours.map((g) => ({ kind: "ungroup", groupId: g.id }) as Op);
		const restore: Op[] = ours.map((g) => ({ kind: "group", ids: g.memberIds.slice(), summary: g.summary, ...(g.role ? { role: g.role } : {}), ...(g.handles ? { handles: g.handles.map((h) => ({ id: h.id, memberIds: [...h.memberIds] })) } : {}) }) as Op);
		let saved = 0;
		viable.forEach((r, i) => {
			const gid = `g:${r[0].id}`;
			const last = i === viable.length - 1;
			const summary = last ? text : partCarrier(foldTag(gid), span.key, i + 1, viable.length);
			ops.push({ kind: "group", ids: r.map((b) => b.id), summary, role: "assistant", ...(last && visible.length ? { handles: visible } : {}) });
			const collapsible = collapsibleMessageKeys(r, true);
			const current = r.reduce((n, b) => n + (collapsible.has(messageKey(b.id)) ? (b.liveTokens ?? (b.folded ? b.foldedTokens : b.tokens)) : 0), 0);
			saved += Math.max(0, current - host.countTokens(summary));
		});
		return { ops, restore, saved, key: span.key };
	}

	/** A span's record, omitting bracket reports whose closing calls remain visible. */
	record(span: Span, blocks: readonly ViewBlock[], children: readonly Span[], prior: ReadonlyMap<string, RecordObj | HistoryObj> = new Map(), included?: ReadonlySet<string>, reach?: ReadonlyMap<string, "full" | "partial" | "none">, hidden?: ReadonlySet<string>): RecordObj {
		const inside = (s: Span, i: number) => s.intervals.some((r) => r.start <= i && i <= r.end);
		const reportVisible = (task: Span) => this.k.leafForm === "bracket" && hidden && task.closingCall !== undefined && !hidden.has(blocks[task.closingCall].id);
		const own = blocks.filter((b, i) => (!included || included.has(b.id)) && inside(span, i) && !children.some((c) => inside(c, i)));
		const { changed, verified } = recordFacts(own, (b) => this.textOf(b));
		const user = own.flatMap((b) => {
			const ids = b.kind === "user" ? this.verdicts.get(b.id)?.routed?.ids : undefined;
			return ids?.length ? [{ said: oneLine(this.textOf(b), USER_SAID_CHARS), ids }] : [];
		});
		const direct = children.filter((c) => !children.some((o) => o !== c && c.key.startsWith(`${o.key}.`)) && reach?.get(c.key) !== "none");
		const entries = direct.map((child): RecordObj | HistoryObj => {
			const recallable = !reach || (reach.get(child.key) ?? "full") === "full";
			const previous = prior.get(child.key);
			if (previous && isHistory(previous)) {
				const existing = { ...previous, outcome: reportVisible(child) ? undefined : previous.outcome ?? child.report.outcome };
				if (!recallable) {
					delete existing.recall;
					return existing;
				}
				return !existing.recall && child.intervals.length ? { ...existing, recall: foldTag(`t:${child.key}`) } : existing;
			}
			const full = this.record(child, blocks, children.filter((c) => c.key.startsWith(`${child.key}.`)), prior, included, reach, hidden);
			return child.intervals.length && recallable ? { task: full.task, title: full.title, status: full.status, recall: foldTag(`t:${child.key}`), ...rest(full) } : full;
		});
		const { outcome, decisions, open } = reportVisible(span) ? {} : span.report;
		return {
			task: span.key,
			title: span.title,
			status: span.status,
			...(span.acceptanceCriteria?.length ? { criteria: span.acceptanceCriteria } : {}),
			...(outcome ? { outcome } : {}),
			...(decisions?.length ? { decisions } : {}),
			...(open?.length ? { open } : {}),
			...(span.pins?.length ? { pins: span.pins } : {}),
			...(user.length ? { user } : {}),
			...(changed.length ? { changed: changed.length > 20 ? [...changed.slice(0, 20), `+${changed.length - 20} more`] : changed } : {}),
			...(verified.length ? { verified: verified.slice(-5) } : {}),
			...(entries.length ? { children: entries } : {}),
		};
	}

	private async commit(host: ConductorHost, units: Unit[]): Promise<void> {
		this.busy = true;
		try {
			const ops = units.flatMap((u) => u.ops);
			const res = await host.propose({ baseRev: host.stats().rev, ops });
			if (this.host !== host) return;
			let at = 0;
			let applied = 0;
			let saved = 0;
			const undo: Op[] = [];
			const restore: Op[] = [];
			let rollbackFailed = false;
			for (const u of units) {
				const rs = res.results.slice(at, at + u.ops.length);
				at += u.ops.length;
				let unitApplied = 0;
				const appliedGroups: string[] = [];
				const removedGroups = new Set<string>();
				let failed = false;
				const isFloor = u.ops.every((op) => op.kind === "fold" || op.kind === "replace");
				for (const r of rs) {
					if (r.op.kind === "fold" || r.op.kind === "replace") {
						if (r.applied) unitApplied++;
						else failed = true;
						continue;
					}
					if (r.op.kind === "ungroup") {
						if (r.applied) removedGroups.add(r.op.groupId);
						else failed = true;
						continue;
					}
					if (r.op.kind !== "group") continue;
					if (!r.applied) {
						failed = true;
						continue;
					}
					const gid = r.detail ?? `g:${r.op.ids[0]}`;
					appliedGroups.push(gid);
					unitApplied++;
				}
				if (!failed || isFloor) applied += unitApplied;
				if (unitApplied && !failed) saved += u.saved;
				if (unitApplied && !failed) {
					const groups = u.ops.filter((op) => op.kind === "group");
					const changed = new Set(rs.filter(r => r.applied).flatMap(({ op }) => op.kind === "group" || op.kind === "fold" ? op.ids : op.kind === "replace" ? [op.id] : []));
					const firstChanged = host.blocks().findIndex(b => changed.has(b.id));
					const policy = this.policy(host);
					const rewrittenTokens = host.blocks().slice(Math.max(0, firstChanged)).reduce((n, b) => n + (b.liveTokens ?? (b.folded ? b.foldedTokens : b.tokens)), 0);
					host.debug?.({ type: "fold", task: u.key ?? null, carrierTokens: groups.reduce((n, op) => n + host.countTokens(op.summary ?? ""), 0),
						tokensRemoved: u.saved, firstChangedBlock: firstChanged, blocksBehindEnd: host.blocks().length - firstChanged - 1,
						timing: policy.timing, cache: policy.cache, rewrittenTokens, estimatedWriteInputUnits: rewrittenTokens * policy.cache.writeWeight });
				}
				if (failed && !isFloor) {
					undo.push(...appliedGroups.map((groupId) => ({ kind: "ungroup" as const, groupId })));
					restore.push(...u.restore.filter((op) => op.kind === "group" && removedGroups.has(`g:${op.ids[0]}`)));
				}
			}
			if (undo.length || restore.length) {
				const back = await host.propose({ baseRev: host.stats().rev, ops: [...undo, ...restore] });
				if (this.host !== host) return;
				rollbackFailed = back.results.some((r) => !r.applied);
			}
			this.epochs++;
			const s = host.stats();
			const unclassified = `${this.classifyFailures ? `; ${this.classifyFailures} user message(s) unclassified, kept` : ""}${this.rawWarning ? `; ${this.rawWarning}` : ""}`;
			const floorSpans = [...new Set(units.flatMap((u) => u.floorSpans ?? []))];
			host.setStatus(rollbackFailed ? `Taskfold could not restore every group after a rejected fold; inspect the context.` : `Epoch ${this.epochs}: applied ${applied} fold operation(s), ~${saved} tokens${unclassified}.`, {
				epochs: this.epochs,
				groups: this.groupKeys(host).size,
				...(floorSpans.length ? { floor: 1, floor_spans: floorSpans.join(",") } : {}),
				live_tokens: s.liveTokens,
				saved,
				budget: s.budget,
				...(rollbackFailed ? { level: "error" } : this.classifyFailures || this.rawWarning ? { level: "warning" } : {}),
			});
		} catch (error) {
			if (this.host === host) host.setStatus(`Taskfold could not commit its plan: ${error instanceof Error ? error.message : String(error)}`, { level: "error" });
		} finally {
			this.busy = false;
			if (this.pending && this.host === host) {
				this.pending = false;
				void this.evaluate();
			}
		}
	}
}
