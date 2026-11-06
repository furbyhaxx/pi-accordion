/*
 * taskfold.ts — fold completed task spans into structured task records.
 *
 * The agent marks its work with the `tasks` tool (registered by the extension while this conductor
 * is attached). A SPAN runs from a successful `tasks start <id>` call through the successful
 * `complete` / `fail` / `abandon` result of the same task. Once the context crosses HIGH·budget,
 * one epoch folds the oldest finished spans, outermost first, until the projection reaches
 * LOW·budget. Each folded span becomes a group whose summary is a fixed-shape record:
 *
 *   [task-record] <list>/<id> "<title>"  status: done
 *   outcome / decisions / open      ← agent-written, from the finishing call's `report`
 *   changed / verified              ← derived from the span's own tool calls
 *   children                        ← composed finished subtask records
 *
 * User messages inside a span stay verbatim unless a classifier scores that losing them costs the
 * later work nothing (approvals, status checks, step steering, consumed facts, harness notices).
 * Kept user messages split the span into several groups; the record rides on the last one. No
 * classifier (none reachable, or the host cannot run one) means every user message is kept.
 *
 * Cache economics: nothing is proposed below HIGH, and an epoch commits as ONE transaction, so the
 * prompt cache breaks once per epoch at the oldest folded span, never once per completed task.
 *
 * Folding proposes `group`, plus `ungroup` of absorbed child groups. Child handles remain recoverable
 * across group boundaries; an agent unfold reopens the selected task and recompiles its siblings.
 */
import type { ClassifierAnswer, ClassifierQuestion, Conductor, ConductorHost, HostEvent, ViewBlock } from "../../../core/conductor/contract";
import type { Op } from "../../../core/ops";
import { foldTag } from "../../../core/digest";
import { VerdictLedger } from "./verdicts";
import { collapsibleMessageKeys, messageKey } from "../../../core/groupShape";

export interface TaskfoldOptions {
	/** Start an epoch once live tokens reach `high · budget`. Default 0.8. */
	high?: number;
	/** An epoch stops once projected live tokens are at or below `low · budget`. Default 0.6. */
	low?: number;
	/** Fold a user message when the classifier's expected `loss` level (0–3) is below this. Default 0.3. */
	maxLoss?: number;
	/** User messages matching any of these are harness text and fold without a model call. */
	harnessPatterns?: readonly RegExp[];
	/** The newest finished top-level tasks that stay open; the working context of the next step. Default 1. */
	keepRecentTasks?: number;
}

export const TASKFOLD_DEFAULTS: Readonly<Required<TaskfoldOptions>> = {
	high: 0.8,
	low: 0.6,
	maxLoss: 0.3,
	keepRecentTasks: 1,
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
const RECORD_TAG = "[task-record]";
const PART_TAG = "[task-part]";
const ARCHIVE_TAG = "[task-archived]";
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
	/** Inclusive periods belonging to this task, separated by blocks and resumes. */
	intervals: { start: number; end: number }[];
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

/**
 * Every task span in `blocks`: finished spans in finishing order (innermost first when two end
 * together), then still-open spans running to the last block.
 */
export function scanTaskSpans<B extends SpanBlock>(blocks: readonly B[], textOf: (b: B) => string): TaskSpan[] {
	const resultIdx = new Map<string, number>();
	blocks.forEach((b, i) => {
		if (b.kind === "tool_result" && b.callId && b.toolName === "tasks") resultIdx.set(b.callId, i);
	});
	type State = { key: string; list: string; id: string; title: string; start: number; active: number | null; waiting: boolean; intervals: { start: number; end: number }[]; acceptanceCriteria?: string[]; pins?: TaskSpan["pins"] };
	const open = new Map<string, State>();
	const out: TaskSpan[] = [];
	const closeInterval = (s: State, end: number) => {
		if (s.active !== null) s.intervals.push({ start: s.active, end: Math.max(s.active, end) });
		s.active = null;
		s.waiting = false;
	};
	const finish = (s: State, status: Span["status"], report: TaskSpan["report"], end: number) => {
		closeInterval(s, end);
		open.delete(s.key);
		out.push({ key: s.key, list: s.list, id: s.id, title: s.title, status, report, acceptanceCriteria: s.acceptanceCriteria, pins: s.pins, start: s.start, end, intervals: s.intervals });
	};
	blocks.forEach((b, i) => {
		if (b.kind === "user") {
			for (const s of open.values()) if (s.waiting) closeInterval(s, i - 1);
		}
		if (b.kind !== "tool_call" || b.toolName !== "tasks" || !b.callId) return;
		const ri = resultIdx.get(b.callId);
		if (ri === undefined || blocks[ri].isError) return;
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
			if (Array.isArray(data.acceptanceCriteria) && data.acceptanceCriteria.every((v) => typeof v === "string")) s.acceptanceCriteria = data.acceptanceCriteria;
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
			const parents = lines.flatMap((line) => {
				const m = /^Also (?:started|resumed) parent (\S+) "(.*)" so its span/.exec(line);
				return m ? [{ id: m[1], title: m[2] }] : [];
			});
			const task = details?.task && typeof details.task === "object" ? details.task as { title?: unknown } : undefined;
			const title = typeof task?.title === "string" ? task.title : /^(?:Started|Resumed) \S+ "(.*)"\.$/.exec(lines[0] ?? "")?.[1] ?? "";
			const started = Array.isArray(details?.started) ? details.started.filter((x): x is string => typeof x === "string") : [...parents.map((p) => p.id), id];
			for (const startedId of started) {
				const skey = `${list}/${startedId}`;
				const existing = open.get(skey);
				if (existing) {
					if (existing.waiting) closeInterval(existing, i - 1);
					if (existing.active === null) existing.active = i;
				} else open.set(skey, { key: skey, list, id: startedId, title: startedId === id ? title : parents.find((p) => p.id === startedId)?.title ?? "", start: i, active: i, waiting: false, intervals: [] });
			}
			const startedTask = open.get(key);
			if (startedTask) updateMetadata(startedTask);
		} else if (action === "block") {
			for (const s of open.values()) if (s.key === key || key.startsWith(`${s.key}.`)) s.waiting = true;
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
					const state: State = { key: childKey, list, id: c.id, title: c.title, start: i, active: null, waiting: false, intervals: [] };
					updateMetadata(state, c);
					finish(state, "abandoned", c.report ?? {}, ri);
				}
			}
			const s = open.get(key);
			if (!s) return;
			const report = (args.report && typeof args.report === "object" ? args.report : {}) as TaskSpan["report"];
			updateMetadata(s);
			finish(s, FINISH[action], report, ri);
		}
	});
	for (const s of open.values()) {
		closeInterval(s, blocks.length - 1);
		out.push({ key: s.key, list: s.list, id: s.id, title: s.title, status: null, report: {}, acceptanceCriteria: s.acceptanceCriteria, pins: s.pins, start: s.start, end: blocks.length - 1, intervals: s.intervals });
	}
	return out;
}

/**
 * One step down the aging ladder for a record summary: level 1 keeps the head line and the outcome
 * on one line, level 2 keeps only the archive stub. Null when the summary is not a task record.
 */
export function ageRecord(summary: string, level: 1 | 2): string | null {
	const m = /^(\{#[0-9a-z]{6} FOLDED\}) \[task-(record|archived)\] (\S+) "(.*)"\s+status: (\w+)/.exec(summary);
	if (!m) return null;
	const [, tag, kind, key, title, status] = m;
	if (level === 1 && !/^outcome: /m.test(summary)) return summary;
	const tags = [...new Set(summary.match(/\{#[0-9a-z]{6} FOLDED\}/g) ?? [])].filter((t) => t !== tag);
	const suffix = tags.length ? ` · handles: ${tags.join(" ")}` : "";
	if (level === 2 || kind === "archived") return `${tag} ${ARCHIVE_TAG} ${key} "${title}" ${status}; recall the code for its record and transcript.${suffix}`;
	const outcome = /^outcome: (.*)$/m.exec(summary)?.[1];
	return `${tag} ${RECORD_TAG} ${key} "${title}"  status: ${status}${outcome ? ` · ${oneLine(outcome, 200)}` : ""}${suffix}`;
}

/** The `<list>/<id>` key of a Taskfold record or part summary, or null for any other summary. */
export function taskKeyOfSummary(summary: string | null | undefined): string | null {
	return typeof summary === "string" ? (/^\{#[0-9a-z]{6} FOLDED\} \[task-(?:record|part|archived)\] (\S+)/.exec(summary)?.[1] ?? null) : null;
}

/** One span's fold: its ops, the span key per group op, and how to restore absorbed child groups. */
interface Unit {
	ops: Op[];
	restore: Op[];
	saved: number;
}

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

function oneLine(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? t.slice(0, max - 1) + "…" : t;
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

export class TaskfoldConductor implements Conductor {
	readonly id = "taskfold";
	readonly label = "Taskfold";
	readonly description = "Folds finished task spans into structured task records; user steering folds when a classifier says so.";

	private readonly k: Required<TaskfoldOptions>;
	private host: ConductorHost | null = null;
	private off: (() => void) | null = null;
	private busy = false;
	private pending = false;
	private readonly agentOpen = new Set<string>();
	/** User block id → verdict; computed once and never recomputed, kept across resumes by the ledger. */
	private readonly verdicts: VerdictLedger;
	private readonly classifying = new Set<string>();
	private classifyFailures = 0;
	private epochs = 0;

	constructor(options: TaskfoldOptions = {}, verdicts: VerdictLedger = new VerdictLedger()) {
		this.k = { ...TASKFOLD_DEFAULTS, ...options };
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
		this.agentOpen.clear();
		this.classifying.clear();
		this.busy = false;
		this.pending = false;
	}

	private onEvent(e: HostEvent): void | Promise<void> {
		if (!this.host) return;
		switch (e.type) {
			case "resync":
				return this.evaluate();
			case "blocks-appended":
				this.classifyNew(e.blocks);
				return this.evaluate();
			case "turn-committed":
				return this.evaluate();
			case "state-changed": {
				const unfolded = e.changes.filter((c) => c.by === "agent" && c.what === "ungroup" && c.id && c.groupId);
				if (unfolded.length) return this.reconcileAgentUnfold(unfolded.map((c) => ({ id: c.id!, groupId: c.groupId! })));
				if (this.busy || e.changes.every((c) => c.by === "auto")) return;
				return this.evaluate();
			}
			default:
				return;
		}
	}

	private async reconcileAgentUnfold(changes: { id: string; groupId: string }[]): Promise<void> {
		const host = this.host;
		if (!host) return;
		const groups = host.groups();
		const owners = new Set<string>();
		for (const change of changes) {
			const carrier = groups.find((g) => g.handles?.some((h) => h.id === change.id));
			const owner = carrier ? taskKeyOfSummary(carrier.summary) : taskKeyOfSummary(groups.find((g) => g.id === change.groupId)?.summary);
			if (owner) owners.add(owner);
			if (change.id.startsWith("t:")) this.agentOpen.add(change.id.slice(2));
			else if (owner && carrier) {
				const ids = new Set(carrier.handles?.find((h) => h.id === change.id)?.memberIds ?? []);
				const blocks = host.blocks();
				const matching = this.spans(blocks).filter((s) => s.key.startsWith(`${owner}.`) && s.intervals.some((r) => blocks.slice(r.start, r.end + 1).some((b) => ids.has(b.id))));
				const leaves = matching.filter((s) => !matching.some((other) => other.key.startsWith(`${s.key}.`)));
				if (leaves.length) for (const s of leaves) this.agentOpen.add(s.key);
				else this.agentOpen.add(owner);
			} else if (owner) this.agentOpen.add(owner);
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
			void this.classifyOne(b.id, state);
		}
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

	private async classifyOne(id: string, state: Record<string, string>): Promise<void> {
		const host = this.host;
		if (!host?.classify) return;
		this.classifying.add(id);
		try {
			const res = await host.classify({ state, questions: USER_QUESTIONS });
			const a = res.answers.loss as ClassifierAnswer | undefined;
			const answers: Record<string, number> = {};
			for (const [k, v] of Object.entries(res.answers)) if (k !== "loss" && v?.type === "bool") answers[k] = v.probability;
			this.verdicts.set(
				id,
				a?.type === "score"
					? { loss: a.score, source: "classifier", confidence: a.confidence, answers, model: res.model, at: new Date().toISOString() }
					: { loss: null, source: "error" },
			);
		} catch {
			// Unclassified stays verbatim. Remember the failure so a broken classifier is visible.
			this.verdicts.set(id, { loss: null, source: "error" });
			this.classifyFailures++;
		} finally {
			this.classifying.delete(id);
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
		if (stats.budget <= 0 || stats.liveTokens < this.k.high * stats.budget) return;
		const plan = this.plan(host);
		if (!plan.length) {
			host.setStatus(`Over budget; no finished task span is foldable yet.`, { epochs: this.epochs, groups: this.groupKeys(host).size, level: "warning" });
			return;
		}
		return this.commit(host, plan);
	}

	private plan(host: ConductorHost, recompose?: ReadonlySet<string>): Unit[] {
		const blocks = host.blocks();
		const stats = host.stats();
		const spans = this.spans(blocks).filter((s) => ![...this.agentOpen].some((key) => s.key === key || s.key.startsWith(`${key}.`) || key.startsWith(`${s.key}.`)));
		const contains = (outer: Span, inner: Span) => inner.key.startsWith(`${outer.key}.`);
		// Outermost finished spans are the fold units; finished descendants fold inside them.
		const roots = spans.filter((s) => !spans.some((o) => contains(o, s))).sort((a, b) => a.start - b.start);
		const foldedKeys = new Set(this.groupKeys(host).values());
		// Oldest first: the newest finished work stays open longest, and the cache breaks once, early.
		const candidates = (recompose ? roots.filter((s) => [...recompose].some((key) => s.key.startsWith(`${key}.`))) : roots.slice(0, Math.max(0, roots.length - this.k.keepRecentTasks))).filter((s) => !foldedKeys.has(s.key));
		const units: Unit[] = [];
		let projected = stats.liveTokens;
		const target = this.k.low * stats.budget;
		const planned = new Set<string>();
		for (const span of candidates) {
			if (!recompose && projected <= target) break;
			const unit = this.unit(host, blocks, span, spans.filter((s) => contains(span, s)), planned);
			if (!unit) continue;
			units.push(unit);
			for (const op of unit.ops) if (op.kind === "group") for (const id of op.ids) planned.add(id);
			projected -= unit.saved;
		}
		// Folding every finished span was not enough: age the oldest records instead (see `ageRecord`).
		if (!recompose && projected > target) {
			const touched = new Set(units.flatMap((u) => u.ops.flatMap((op) => (op.kind === "group" ? op.ids : op.kind === "ungroup" ? [op.groupId] : []))));
			units.push(...this.ladder(host, blocks, projected - target, touched));
		}
		return units;
	}

	/**
	 * Shorten our oldest records until `need` tokens are freed: every full record becomes a one-line
	 * record first, oldest first, then one-line records become archive stubs. Groups keep their ids,
	 * so fold codes and `recall` of the raw span still work.
	 */
	private ladder(host: ConductorHost, blocks: readonly ViewBlock[], need: number, touched: ReadonlySet<string>): Unit[] {
		const pos = new Map(blocks.map((b, i) => [b.id, i]));
		const groupKeys = this.groupKeys(host);
		const ours = host
			.groups()
			.filter((g) => groupKeys.has(g.id) && g.folded && typeof g.summary === "string" && !touched.has(g.id) && !g.memberIds.some((id) => touched.has(id)))
			.sort((a, b) => (pos.get(a.memberIds[0]) ?? 0) - (pos.get(b.memberIds[0]) ?? 0))
			// The newest record keeps its full form: it is the work the next steps most likely build on.
			.slice(0, -1);
		const aged = new Map<string, string>();
		let freed = 0;
		for (const level of [1, 2] as const) {
			for (const g of ours) {
				if (freed >= need) break;
				const from = aged.get(g.id) ?? g.summary!;
				const next = ageRecord(from, level);
				const saved = next ? host.countTokens(from) - host.countTokens(next) : 0;
				if (!next || saved <= 0) continue;
				aged.set(g.id, next);
				freed += saved;
			}
		}
		return ours
			.filter((g) => aged.has(g.id))
			.map((g) => ({
				ops: [{ kind: "ungroup", groupId: g.id } as Op, { kind: "group", ids: g.memberIds.slice(), summary: aged.get(g.id)!, ...(g.handles ? { handles: g.handles.map((h) => ({ id: h.id, memberIds: [...h.memberIds] })) } : {}) } as Op],
				restore: [{ kind: "group", ids: g.memberIds.slice(), summary: g.summary!, ...(g.handles ? { handles: g.handles.map((h) => ({ id: h.id, memberIds: [...h.memberIds] })) } : {}) } as Op],
				saved: host.countTokens(g.summary!) - host.countTokens(aged.get(g.id)!),
			}));
	}

	/** The ops folding one span, or null when any part of it is not ours to fold right now. */
	private unit(host: ConductorHost, blocks: readonly ViewBlock[], span: Span, children: Span[], planned: ReadonlySet<string> = new Set()): Unit | null {
		// Groups of this span's subtasks are absorbed; any other group (a neighbour's record sharing a
		// boundary message, a foreign group) must stay outside the span.
		const childKey = (key: string | undefined) => !!key && key.startsWith(`${span.key}.`);
		const groupKeys = this.groupKeys(host);
		const groupOf = new Map<string, string>();
		for (const g of host.groups()) for (const id of g.memberIds) groupOf.set(id, g.id);
		const foreign = (b: ViewBlock) => {
			if (planned.has(b.id)) return true;
			const gid = groupOf.get(b.id);
			return !!gid && !childKey(groupKeys.get(gid));
		};
		const sameMsg = (i: number, j: number) => messageKey(blocks[i].id) === messageKey(blocks[j].id);
		let lo = span.start;
		let hi = span.end;
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
		while (hi >= lo && (foreign(blocks[hi]) || blocks[hi].protected || blocks[hi].held)) {
			hi--;
			while (hi >= lo && hi < blocks.length - 1 && sameMsg(hi + 1, hi)) hi--;
		}
		if (lo > hi) return null;
		const members = blocks.slice(lo, hi + 1);
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
			if (!childKey(groupKeys.get(g.id))) continue;
			const matching = viable.filter((r) => r.some((b) => g.memberIds.includes(b.id)));
			if (matching.length && (matching.length !== 1 || g.memberIds.some((id) => !matching[0].some((b) => b.id === id)))) excludedGroups.add(g.id);
		}
		if (excludedGroups.size) viable = makeRuns();
		if (!viable.length) return null;
		const memberIds = new Set(viable.flatMap((r) => r.map((b) => b.id)));
		const positions = new Map(blocks.map((b, i) => [b.id, i]));
		const ours = host.groups().filter((g) => childKey(groupKeys.get(g.id)) && !excludedGroups.has(g.id) && g.memberIds.some((id) => memberIds.has(id))).sort((a, b) => (positions.get(a.memberIds[0]) ?? 0) - (positions.get(b.memberIds[0]) ?? 0));

		const included = new Set(viable.flatMap((r) => r.map((b) => b.id)));
		const spanHandle = (task: Span) => ({ id: `t:${task.key}`, memberIds: blocks.filter((_b, i) => task.intervals.some((r) => r.start <= i && i <= r.end)).map((b) => b.id) });
		const covered = (h: { memberIds: string[] }) => h.memberIds.every((id) => included.has(id) || members.some((b) => b.id === id && b.kind === "user" && !this.folds(b)));
		const rootHandle = spanHandle(span);
		const handles = [...(covered(rootHandle) ? [rootHandle] : []), ...children.filter((child) => child.intervals.length > 0).map(spanHandle), ...ours.map((g) => ({ id: g.id, memberIds: g.memberIds.slice() })), ...ours.flatMap((g) => (g.handles ?? []).map((h) => ({ id: h.id, memberIds: [...h.memberIds] })))];
		const unique = [...new Map(handles.map((h) => [h.id, h])).values()];
		if (unique.some((h) => !covered(h))) return null;
		const aliases = unique.filter((h) => h.id.startsWith("g:")).map((h) => foldTag(h.id));
		const prior = new Map<string, string>();
		for (const g of ours) {
			const key = taskKeyOfSummary(g.summary);
			if (key && typeof g.summary === "string" && !g.summary.includes(PART_TAG)) prior.set(key, g.summary);
		}
		const body = this.record(span, blocks, children, covered(rootHandle), prior);
		const missingAliases = aliases.filter((tag) => !body.includes(tag));
		const record = `${body}${missingAliases.length ? `\nearlier handles: ${missingAliases.join(" ")}` : ""}`;
		const ops: Op[] = ours.map((g) => ({ kind: "ungroup", groupId: g.id }) as Op);
		const restore: Op[] = ours.map((g) => ({ kind: "group", ids: g.memberIds.slice(), summary: g.summary, ...(g.handles ? { handles: g.handles.map((h) => ({ id: h.id, memberIds: [...h.memberIds] })) } : {}) }) as Op);
		let saved = 0;
		viable.forEach((r, i) => {
			const gid = `g:${r[0].id}`;
			const last = i === viable.length - 1;
			const body = last ? record : `${PART_TAG} ${span.key} "${span.title}" part ${i + 1}/${viable.length}; the task record follows the kept message(s) below.`;
			const summary = `${foldTag(gid)} ${body}`;
			ops.push({ kind: "group", ids: r.map((b) => b.id), summary, ...(last && unique.length ? { handles: unique } : {}) });
			const collapsible = collapsibleMessageKeys(r, true);
			const current = r.reduce((n, b) => n + (collapsible.has(messageKey(b.id)) ? (b.liveTokens ?? (b.folded ? b.foldedTokens : b.tokens)) : 0), 0);
			saved += Math.max(0, current - host.countTokens(summary));
		});
		return { ops, restore, saved };
	}

	/** The fixed-shape record for a span, with descendant records kept intact. */
	record(span: Span, blocks: readonly ViewBlock[], children: readonly Span[], exposeHandle = true, prior: ReadonlyMap<string, string> = new Map()): string {
		const lines = [`${RECORD_TAG} ${span.key} "${span.title}"  status: ${span.status}`];
		if (exposeHandle) lines.push(`handle: ${foldTag(`t:${span.key}`)}`);
		const list = (name: string, items: readonly string[] | undefined) => {
			if (items?.length) lines.push(`${name}:`, ...items.map((x) => `  - ${x}`));
		};
		list("acceptance criteria", span.acceptanceCriteria);
		if (span.report.outcome) lines.push(`outcome: ${span.report.outcome}`);
		list("decisions", span.report.decisions);
		list("pins", span.pins?.map((p) => `${p.kind}: ${p.text} (${p.source})`));
		const inside = (s: Span, i: number) => s.intervals.some((r) => r.start <= i && i <= r.end);
		const own = blocks.filter((_b, i) => inside(span, i) && !children.some((c) => inside(c, i)));
		const { changed, verified } = recordFacts(own, (b) => this.textOf(b));
		if (changed.length) lines.push(`changed: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? `, +${changed.length - 20} more` : ""}`);
		list("verified", verified.slice(-5));
		list("open", span.report.open);
		const direct = children.filter((c) => !children.some((o) => o !== c && c.key.startsWith(`${o.key}.`)));
		if (direct.length) {
			lines.push("children:");
			for (const child of direct) {
				const descendants = children.filter((c) => c.key.startsWith(`${child.key}.`));
				const tag = foldTag(`t:${child.key}`);
				const existing = prior.get(child.key);
				const content = existing ? `${existing}${child.intervals.length && !existing.includes(tag) ? `\nhandle: ${tag}` : ""}` : `${child.intervals.length ? `${tag} ` : ""}${this.record(child, blocks, descendants, false, prior)}`;
				lines.push(...content.split("\n").map((line) => `  ${line}`));
			}
		}
		return lines.join("\n");
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
				for (const r of rs) {
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
				if (!failed) applied += unitApplied;
				if (unitApplied && !failed) saved += u.saved;
				if (failed) {
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
			const unclassified = this.classifyFailures ? `; ${this.classifyFailures} user message(s) unclassified, kept` : "";
			host.setStatus(rollbackFailed ? `Taskfold could not restore every group after a rejected fold; inspect the context.` : `Epoch ${this.epochs}: folded ${applied} task group(s), ~${saved} tokens${unclassified}.`, {
				epochs: this.epochs,
				groups: this.groupKeys(host).size,
				live_tokens: s.liveTokens,
				budget: s.budget,
				...(rollbackFailed ? { level: "error" } : this.classifyFailures ? { level: "warning" } : {}),
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
