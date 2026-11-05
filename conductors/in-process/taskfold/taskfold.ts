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
 *   children                        ← one line per finished subtask
 *
 * User messages inside a span stay verbatim unless a classifier scores that losing them costs the
 * later work nothing (approvals, status checks, step steering, consumed facts, harness notices).
 * Kept user messages split the span into several groups; the record rides on the last one. No
 * classifier (none reachable, or the host cannot run one) means every user message is kept.
 *
 * Cache economics: nothing is proposed below HIGH, and an epoch commits as ONE transaction, so the
 * prompt cache breaks once per epoch at the oldest folded span, never once per completed task.
 *
 * Monotone like keel-lite: it only proposes `group`, plus `ungroup` of its own child groups in the
 * same transaction that groups their parent. Every record carries its group's `{#code FOLDED}` tag,
 * so `recall`/`unfold` return the raw span.
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
	start: number;
	/** The finishing result's index, or the last block for an open span. */
	end: number;
}

/** One finished task span, as indices into `host.blocks()`. */
type Span = TaskSpan & { status: "done" | "failed" | "abandoned" };

/** The block fields span discovery reads; both conductor views and Truth blocks satisfy it. */
export interface SpanBlock {
	kind: string;
	toolName?: string;
	callId?: string;
	isError?: boolean;
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
	const open = new Map<string, { start: number; title: string; list: string; id: string }>();
	const out: TaskSpan[] = [];
	blocks.forEach((b, i) => {
		if (b.kind !== "tool_call" || b.toolName !== "tasks" || !b.callId) return;
		const ri = resultIdx.get(b.callId);
		if (ri === undefined || blocks[ri].isError) return;
		const args = parseCall(textOf(b));
		const action = typeof args?.action === "string" ? args.action : "";
		if (typeof args?.list !== "string" || typeof args?.id !== "string") return;
		const key = `${args.list}/${args.id}`;
		if (action === "start") {
			const lines = textOf(blocks[ri]).split("\n");
			// Parents the store closed because this start moved on: their span ends just before this call.
			for (const line of lines) {
				const m = /^Closed (\S+) "(.*)" as (done|failed) from its subtasks' reports/.exec(line);
				const ckey = m ? `${args.list}/${m[1]}` : "";
				const s = m ? open.get(ckey) : undefined;
				if (!m || !s) continue;
				open.delete(ckey);
				out.push({ key: ckey, list: args.list, id: m[1], title: s.title || m[2], status: m[3] as "done" | "failed", report: { outcome: "Closed automatically after its subtasks." }, start: s.start, end: Math.max(s.start, i - 1) });
			}
			for (const line of lines) {
				const m = /^Also started parent (\S+) "(.*)" so its span/.exec(line);
				if (m) open.set(`${args.list}/${m[1]}`, { start: i, title: m[2], list: args.list, id: m[1] });
			}
			const title = /^Started \S+ "(.*)"\.$/.exec(lines[0] ?? "")?.[1] ?? "";
			open.set(key, { start: i, title, list: args.list, id: args.id });
		} else if (FINISH[action]) {
			const s = open.get(key);
			if (!s) return;
			open.delete(key);
			const report = (args.report && typeof args.report === "object" ? args.report : {}) as TaskSpan["report"];
			out.push({ key, list: args.list, id: args.id, title: s.title, status: FINISH[action], report, start: s.start, end: ri });
		}
	});
	for (const [key, s] of open) out.push({ key, list: s.list, id: s.id, title: s.title, status: null, report: {}, start: s.start, end: blocks.length - 1 });
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
	if (level === 1 && !summary.includes("\n")) return summary;
	if (level === 2 || kind === "archived") return `${tag} ${ARCHIVE_TAG} ${key} "${title}" ${status}; recall the code for its record and transcript.`;
	const outcome = /^outcome: (.*)$/m.exec(summary)?.[1];
	return `${tag} ${RECORD_TAG} ${key} "${title}"  status: ${status}${outcome ? ` · ${oneLine(outcome, 200)}` : ""}`;
}

/** The `<list>/<id>` key of a Taskfold record or part summary, or null for any other summary. */
export function taskKeyOfSummary(summary: string | null | undefined): string | null {
	return typeof summary === "string" ? (/^\{#[0-9a-z]{6} FOLDED\} \[task-(?:record|part|archived)\] (\S+)/.exec(summary)?.[1] ?? null) : null;
}

/** One span's fold: its ops, the span key per group op, and how to restore absorbed child groups. */
interface Unit {
	ops: Op[];
	keys: string[];
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

export class TaskfoldConductor implements Conductor {
	readonly id = "taskfold";
	readonly label = "Taskfold";
	readonly description = "Folds finished task spans into structured task records; user steering folds when a classifier says so.";

	private readonly k: Required<TaskfoldOptions>;
	private host: ConductorHost | null = null;
	private off: (() => void) | null = null;
	private busy = false;
	private pending = false;
	/** Our groups: group id → span key (`<list>/<id>`). */
	private readonly ownGroups = new Map<string, string>();
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
		this.adoptGroups(host);
		this.off = host.on((e) => this.onEvent(e));
	}

	detach(): void {
		this.off?.();
		this.off = null;
		this.host?.setStatus(null);
		this.host = null;
		this.ownGroups.clear();
		this.classifying.clear();
		this.busy = false;
		this.pending = false;
	}

	private onEvent(e: HostEvent): void | Promise<void> {
		if (!this.host) return;
		switch (e.type) {
			case "resync":
				this.adoptGroups(this.host);
				return this.evaluate();
			case "blocks-appended":
				this.classifyNew(e.blocks);
				return this.evaluate();
			case "turn-committed":
				return this.evaluate();
			case "state-changed":
				if (this.busy || e.changes.every((c) => c.by === "auto")) return;
				return this.evaluate();
			default:
				return;
		}
	}

	/** Groups an earlier attach of this conductor created are ours: their summary says so. */
	private adoptGroups(host: ConductorHost): void {
		this.ownGroups.clear();
		for (const g of host.groups()) {
			if (g.by !== "auto") continue;
			const key = taskKeyOfSummary(g.summary);
			if (key) this.ownGroups.set(g.id, key);
		}
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
			this.verdicts.set(id, a?.type === "score" ? { loss: a.score, source: "classifier" } : { loss: null, source: "error" });
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
			host.setStatus(`Over budget; no finished task span is foldable yet.`, { epochs: this.epochs, groups: this.ownGroups.size, level: "warning" });
			return;
		}
		return this.commit(host, plan);
	}

	private plan(host: ConductorHost): Unit[] {
		const blocks = host.blocks();
		const stats = host.stats();
		const spans = this.spans(blocks);
		const contains = (outer: Span, inner: Span) => outer !== inner && outer.start <= inner.start && inner.end <= outer.end;
		// Outermost finished spans are the fold units; finished descendants fold inside them.
		const roots = spans.filter((s) => !spans.some((o) => contains(o, s))).sort((a, b) => a.start - b.start);
		const foldedKeys = new Set(this.ownGroups.values());
		// Oldest first: the newest finished work stays open longest, and the cache breaks once, early.
		const candidates = roots.slice(0, Math.max(0, roots.length - this.k.keepRecentTasks)).filter((s) => !foldedKeys.has(s.key));
		const units: Unit[] = [];
		let projected = stats.liveTokens;
		const target = this.k.low * stats.budget;
		const planned = new Set<string>();
		for (const span of candidates) {
			if (projected <= target) break;
			const unit = this.unit(host, blocks, span, spans.filter((s) => contains(span, s)), planned);
			if (!unit) continue;
			units.push(unit);
			for (const op of unit.ops) if (op.kind === "group") for (const id of op.ids) planned.add(id);
			projected -= unit.saved;
		}
		// Folding every finished span was not enough: age the oldest records instead (see `ageRecord`).
		if (projected > target) {
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
		const ours = host
			.groups()
			.filter((g) => this.ownGroups.has(g.id) && g.folded && typeof g.summary === "string" && !touched.has(g.id) && !g.memberIds.some((id) => touched.has(id)))
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
				ops: [{ kind: "ungroup", groupId: g.id } as Op, { kind: "group", ids: g.memberIds.slice(), summary: aged.get(g.id)! } as Op],
				keys: [this.ownGroups.get(g.id)!],
				restore: [{ kind: "group", ids: g.memberIds.slice(), summary: g.summary! } as Op],
				saved: host.countTokens(g.summary!) - host.countTokens(aged.get(g.id)!),
			}));
	}

	/** The ops folding one span, or null when any part of it is not ours to fold right now. */
	private unit(host: ConductorHost, blocks: readonly ViewBlock[], span: Span, children: Span[], planned: ReadonlySet<string> = new Set()): Unit | null {
		// Groups of this span's subtasks are absorbed; any other group (a neighbour's record sharing a
		// boundary message, a foreign group) must stay outside the span.
		const childKey = (key: string | undefined) => !!key && key.startsWith(`${span.key}.`);
		const groupOf = new Map<string, string>();
		for (const g of host.groups()) for (const id of g.memberIds) groupOf.set(id, g.id);
		const foreign = (b: ViewBlock) => {
			if (planned.has(b.id)) return true;
			const gid = groupOf.get(b.id);
			return !!gid && !childKey(this.ownGroups.get(gid));
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
		while (hi >= lo && foreign(blocks[hi])) {
			hi--;
			while (hi >= lo && hi < blocks.length - 1 && sameMsg(hi + 1, hi)) hi--;
		}
		if (lo > hi) return null;
		const members = blocks.slice(lo, hi + 1);
		if (members.some((b) => b.protected || b.held || b.kind === "system" || foreign(b))) return null;

		const memberIds = new Set(members.map((m) => m.id));
		const ours = host.groups().filter((g) => this.ownGroups.has(g.id) && g.memberIds.some((id) => memberIds.has(id)));
		const oursIds = new Set(ours.flatMap((g) => g.memberIds));

		const runs: ViewBlock[][] = [];
		let run: ViewBlock[] = [];
		for (const b of members) {
			if (b.kind === "user" && !this.folds(b)) {
				if (run.length) runs.push(run);
				run = [];
				continue;
			}
			run.push(b);
		}
		if (run.length) runs.push(run);
		const viable = runs.filter((r) => collapsibleMessageKeys(r, true).size > 0);
		if (!viable.length) return null;

		const record = this.record(span, members, children);
		const ops: Op[] = ours.map((g) => ({ kind: "ungroup", groupId: g.id }) as Op);
		const restore: Op[] = ours.map((g) => ({ kind: "group", ids: g.memberIds.slice(), summary: g.summary }) as Op);
		let saved = 0;
		viable.forEach((r, i) => {
			const gid = `g:${r[0].id}`;
			const last = i === viable.length - 1;
			const body = last ? record : `${PART_TAG} ${span.key} "${span.title}" part ${i + 1}/${viable.length}; the task record follows the kept message(s) below.`;
			const summary = `${foldTag(gid)} ${body}`;
			ops.push({ kind: "group", ids: r.map((b) => b.id), summary });
			const full = r.reduce((n, b) => n + (oursIds.has(b.id) ? b.foldedTokens : b.tokens), 0);
			saved += Math.max(0, full - host.countTokens(summary));
		});
		return { ops, keys: viable.map(() => span.key), restore, saved };
	}

	/** The fixed-shape record for a span. Deterministic fields come from the span's own tool traffic. */
	record(span: Span, members: readonly ViewBlock[], children: readonly Span[]): string {
		const lines = [`${RECORD_TAG} ${span.key} "${span.title}"  status: ${span.status}`];
		if (span.report.outcome) lines.push(`outcome: ${oneLine(span.report.outcome, 600)}`);
		const list = (name: string, items: readonly string[] | undefined) => {
			if (items?.length) lines.push(`${name}:`, ...items.map((x) => `  - ${oneLine(x, 240)}`));
		};
		list("decisions", span.report.decisions);

		const results = new Map<string, ViewBlock>();
		for (const b of members) if (b.kind === "tool_result" && b.callId) results.set(b.callId, b);
		const changed = new Set<string>();
		const verified: string[] = [];
		for (const b of members) {
			if (b.kind !== "tool_call") continue;
			const args = parseCall(this.textOf(b));
			if (EDIT_TOOLS.has(b.toolName ?? "") && typeof args?.path === "string") changed.add(args.path);
			if (b.toolName === "bash" && typeof args?.command === "string" && CHECK_RE.test(args.command)) {
				const r = b.callId ? results.get(b.callId) : undefined;
				const mark = !r ? "no result" : r.isError ? `failed: ${oneLine(this.textOf(r).split("\n").slice(-3).join(" "), 160)}` : "ok";
				verified.push(`\`${oneLine(args.command, 120)}\` → ${mark}`);
			}
		}
		if (changed.size) lines.push(`changed: ${[...changed].slice(0, 20).join(", ")}${changed.size > 20 ? `, +${changed.size - 20} more` : ""}`);
		list("verified", verified.slice(-5));
		list("open", span.report.open);
		const direct = children.filter((c) => !children.some((o) => o !== c && o.start <= c.start && c.end <= o.end));
		list(
			"children",
			direct.map((c) => `${c.id} "${c.title}" ${c.status}${c.report.outcome ? `: ${c.report.outcome}` : ""}`),
		);
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
			const restore: Op[] = [];
			const restoreKeys: string[] = [];
			for (const u of units) {
				const rs = res.results.slice(at, at + u.ops.length);
				at += u.ops.length;
				let gi = 0;
				let unitApplied = 0;
				let failed = false;
				for (const r of rs) {
					if (r.op.kind === "ungroup") {
						if (r.applied) this.ownGroups.delete(r.op.groupId);
						continue;
					}
					if (r.op.kind !== "group") continue;
					const key = u.keys[gi++];
					if (!r.applied) {
						failed = true;
						continue;
					}
					this.ownGroups.set(r.detail ?? `g:${r.op.ids[0]}`, key);
					unitApplied++;
				}
				applied += unitApplied;
				if (unitApplied && !failed) saved += u.saved;
				// A parent that did not fold must not leave its children unfolded: put their groups back.
				if (failed && u.restore.length) {
					restore.push(...u.restore);
					for (const op of u.restore) if (op.kind === "group") restoreKeys.push(taskKeyOfSummary(op.summary) ?? "");
				}
			}
			if (restore.length) {
				const back = await host.propose({ baseRev: host.stats().rev, ops: restore });
				if (this.host !== host) return;
				back.results.forEach((r, i) => {
					if (r.applied && r.op.kind === "group") this.ownGroups.set(r.detail ?? `g:${r.op.ids[0]}`, restoreKeys[i]);
				});
			}
			this.epochs++;
			const s = host.stats();
			const unclassified = this.classifyFailures ? `; ${this.classifyFailures} user message(s) unclassified, kept` : "";
			host.setStatus(`Epoch ${this.epochs}: folded ${applied} task group(s), ~${saved} tokens${unclassified}.`, {
				epochs: this.epochs,
				groups: this.ownGroups.size,
				live_tokens: s.liveTokens,
				budget: s.budget,
				...(this.classifyFailures ? { level: "warning" } : {}),
			});
		} catch {
			/* a rejected propose leaves state unchanged; the next event re-plans */
		} finally {
			this.busy = false;
			if (this.pending && this.host === host) {
				this.pending = false;
				void this.evaluate();
			}
		}
	}
}
