/*
 * taskBinding.ts — which task list a session was working on, and what the agent must hear when that
 * changes outside its own tool calls (a resume, or the user attaching lists from the UI).
 *
 * The session file is the memory: `accordion.tasks.binding` custom entries record every attachment
 * change. Sessions recorded before those entries existed fall back to their `tasks` tool calls.
 */
import { claimState, currentBlock, nextTaskOf, taskFingerprint, type TaskClaim, type TaskList } from "./tasks";

/** Custom entry type recording the list this session has attached (`slug: null` = none). */
export const BINDING_ENTRY = "accordion.tasks.binding";

/** The data of a binding entry. */
export interface BindingRecord {
	slug: string | null;
	/** `taskFingerprint` of the list when it was attached or last seen. */
	fingerprint?: string;
}

/** The list a session last had attached, as recorded in its history. */
export interface PreviousBinding {
	slug: string;
	/** Exact content fingerprint when recorded by a binding entry; null when inferred from tool calls. */
	fingerprint: string | null;
	/** When the session last saw the list (ISO). */
	seenAt: string;
}

/** Tool actions that leave the calling session holding the list. */
const HOLDING = new Set(["create", "claim", "add", "start", "block", "complete", "fail", "abandon"]);
/** Task timestamps within this window after the session's own last call are its own writes. */
const OWN_WRITE_SLACK_MS = 2000;

interface EntryLike {
	type?: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
}

/** The list attached at the end of `entries` (a session branch, oldest first), or null. */
export function previousBinding(entries: readonly unknown[]): PreviousBinding | null {
	let current: PreviousBinding | null = null;
	const calls = new Map<string, Record<string, unknown>>();
	for (const raw of entries) {
		const e = raw as EntryLike;
		const at = typeof e.timestamp === "string" ? e.timestamp : new Date(0).toISOString();
		if (e.type === "custom" && e.customType === BINDING_ENTRY) {
			const d = (e.data ?? {}) as BindingRecord;
			current = typeof d.slug === "string" && d.slug ? { slug: d.slug, fingerprint: typeof d.fingerprint === "string" ? d.fingerprint : null, seenAt: at } : null;
			continue;
		}
		const m = e.type === "message" ? e.message : undefined;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const part of m.content as { type?: string; name?: string; id?: string; arguments?: unknown }[]) {
				if (part?.type === "toolCall" && part.name === "tasks" && typeof part.id === "string" && part.arguments && typeof part.arguments === "object") calls.set(part.id, part.arguments as Record<string, unknown>);
			}
		} else if (m?.role === "toolResult" && m.toolName === "tasks" && !m.isError && typeof m.toolCallId === "string") {
			const args = calls.get(m.toolCallId);
			const slug = typeof args?.list === "string" ? args.list : null;
			const action = typeof args?.action === "string" ? args.action : "";
			if (!slug) continue;
			if (HOLDING.has(action)) current = { slug, fingerprint: null, seenAt: at };
			else if (action === "release" && current?.slug === slug) current = null;
		}
	}
	return current;
}

/** Did the list's tasks change since the session last saw them? */
export function changedSince(prev: PreviousBinding, list: TaskList): boolean {
	if (prev.fingerprint !== null) return taskFingerprint(list) !== prev.fingerprint;
	const seen = Date.parse(prev.seenAt) + OWN_WRITE_SLACK_MS;
	return list.tasks.some((t) => Date.parse(t.updatedAt) > seen);
}

/** Where the previously attached list stands now. */
export type ResumeSituation =
	| { kind: "mine" | "free" | "stale" | "held"; slug: string; list: TaskList; changed: boolean; changedIds: string[]; holder: TaskClaim | null }
	| { kind: "missing"; slug: string };

export function resumeSituation(prev: PreviousBinding, lists: readonly TaskList[], session: string, at = Date.now()): ResumeSituation {
	const list = lists.find((l) => l.slug === prev.slug);
	if (!list) return { kind: "missing", slug: prev.slug };
	const threshold = Date.parse(prev.seenAt) + (prev.fingerprint === null ? OWN_WRITE_SLACK_MS : 0);
	const changedIds = list.tasks.filter((task) => Date.parse(task.updatedAt) > threshold).map((task) => task.id);
	return { kind: claimState(list, session, at), slug: prev.slug, list, changed: changedSince(prev, list), changedIds, holder: list.claim };
}

/** What became of the session's attachment. */
export type AttachOutcome =
	| { kind: "reclaimed"; list: TaskList }
	| { kind: "replaced"; list: TaskList }
	| { kind: "created"; list: TaskList }
	| { kind: "without" };

/** `ses 01a1aa4a "Auth work"` — how a claiming session is named to people and to the agent. */
export function holderLabel(claim: TaskClaim): string {
	return `session ${claim.session.slice(0, 8)}${claim.name ? ` "${claim.name}"` : ""}`;
}

function renderOrientation(list: TaskList): string {
	const counts = { todo: 0, doing: 0, blocked: 0, done: 0, failed: 0, abandoned: 0 };
	for (const task of list.tasks) counts[task.status]++;
	const next = nextTaskOf(list);
	const doing = list.tasks.filter((task) => task.status === "doing");
	const active = doing.find((task) => !doing.some((child) => child.id.startsWith(`${task.id}.`))) ?? next;
	const branch = active ? list.tasks.filter((task) => task.id === active.id || active.id.startsWith(`${task.id}.`)) : [];
	const blocked = list.tasks.filter((task) => task.status === "blocked");
	const lines = [
		`Status: ${Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(", ")}`,
		`Active branch: ${branch.length ? branch.map((task) => `${task.status === "doing" ? "[~] " : ""}${task.id} ${task.title}`).join(" > ") : "none"}`,
		`Blocked: ${blocked.length ? blocked.slice(0, 10).map((task) => {
			const block = currentBlock(task);
			return `${task.id} ${block ? `${block.reason} — ${block.detail}` : "blocked"}`;
		}).join("; ") + (blocked.length > 10 ? `; +${blocked.length - 10} more` : "") : "none"}`,
		`Next: ${next ? `${next.id} ${next.title}` : "none"}`,
	];
	return lines.join("\n");
}

/**
 * The note the agent gets on its next prompt, or null when nothing it relies on changed: a reclaimed,
 * unchanged list needs no note.
 */
export function agentNotice(situation: ResumeSituation, outcome: AttachOutcome): string | null {
	const slug = situation.slug;
	const changed = situation.kind !== "missing" && situation.changed;
	if (outcome.kind === "reclaimed") {
		if (outcome.list.slug !== slug) return attachedNotice(outcome);
		if (!changed) return null;
		const ids = situation.changedIds;
		const changedLine = ids.length ? `${ids.slice(0, 20).join(", ")}${ids.length > 20 ? `, +${ids.length - 20} more` : ""}` : "a task was removed, or edited without a new timestamp";
		return `Task list "${slug}" is attached to this session again, but its tasks changed since you last used it. Current state:\n${renderOrientation(outcome.list)}\nChanged: ${changedLine}\nWhole list: tasks status`;
	}
	const why =
		situation.kind === "missing"
			? `Your previous task list "${slug}" no longer exists.`
			: situation.kind === "held" && situation.holder
				? `Your previous task list "${slug}" is now claimed by ${holderLabel(situation.holder)}; you cannot change it from this session.`
				: `Your previous task list "${slug}" is no longer attached to this session.`;
	return `${why} ${attachedNotice(outcome)}`;
}

/** The note for an attachment change the user made, independent of any previous list. */
export function attachedNotice(outcome: AttachOutcome): string {
	switch (outcome.kind) {
		case "reclaimed":
		case "replaced":
			return `The user attached task list "${outcome.list.slug}" to this session. Current state:\n${renderOrientation(outcome.list)}\nWhole list: tasks status`;
		case "created":
			return `The user started a new empty task list "${outcome.list.slug}" ("${outcome.list.title}") for this session. Add its tasks with action "add" before starting work.`;
		case "without":
			return `The user chose to continue without a task list; claim or create one only if the user asks.`;
	}
}

/** The note for the user releasing the attached list. */
export function releasedNotice(slug: string): string {
	return `The user released task list "${slug}"; it is no longer attached to this session. Claim or create a list only if the user asks.`;
}

/**
 * The one-time note for a session that has the `tasks` tool but no list yet: orientation is free,
 * but multi-step work belongs in a list, and the agent should say so before spending its budget.
 */
export function bootstrapNotice(): string {
	return [
		"[accordion tasks] No task list is attached to this session.",
		"Orientation comes first: read the request and the files it names. Before you change anything for multi-step work, create or claim a list (tasks create {list, title, goals, tasks: [{title, acceptanceCriteria}]}), start its first leaf, and end each task right after its last tool call.",
		"A one-step errand that needs no tracking can stay list-free; say so and continue.",
	].join("\n");
}

/**
 * The one follow-up a premature stop earns: continue the open work, end the task honestly, or block
 * it with the reason. Worded as an offer so the agent picks, instead of a nudge it has to obey.
 */
export function stopFollowUp(verdict: { state: "in-progress"; task: string } | { state: "pending"; next: string }): string {
	const open =
		verdict.state === "in-progress"
			? `Task ${verdict.task} is still in progress, but the run ended.`
			: `Task ${verdict.next} is next, but the run ended before it started.`;
	return [
		`[accordion tasks] ${open}`,
		"Pick one and act on it now:",
		verdict.state === "in-progress" ? `- continue the work, then tasks complete {list, id: "${verdict.task}"} with its report` : `- tasks start {list, id: "${verdict.next}"} and do it`,
		"- if the task is done, end it honestly (complete, fail or abandon, each with a report)",
		'- if it cannot continue, tasks block {reason: "user-decision"|"user-input"|"third-party", detail: "<what you need>"} and tell the user',
	].join("\n");
}

/**
 * The reminder that a leaf has grown past what one span should carry: the agent decides whether to
 * end it (and open the next), never the engine. Repeats only when its size doubles.
 */
export function largeLeafReminder(
	slug: string,
	task: { id: string; title: string },
	size: { results: number; tokens: number; share: number | null; first: boolean },
): string {
	const measured = size.share === null ? `${size.results} tool results` : `${size.tokens} tokens and ${size.results} tool results`;
	return [
		`[accordion tasks] Task ${task.id} "${task.title}" of "${slug}" has grown to ${measured}${size.share === null ? "" : ` (${Math.round(size.share)} is its configured share of the budget)`}.`,
		size.first ? "This span is getting too large to finish cleanly in one record." : "It is still open.",
		`Consider ending it where the last verifiable outcome lands: tasks complete {list: "${slug}", id: "${task.id}", report: {…}} and start the next task, or add one with tasks add if the remaining work was not planned.`,
		"If it genuinely needs more room, keep going; the reminder repeats only when the leaf doubles in size.",
	].join("\n");
}

/**
 * The note for a pressure fold that shrank the agent's own leaf. It says what happened and offers
 * the same choice as the size tap, because the agent's next step depends on whether the span is done.
 */
export function floorFoldNote(task: { slug: string; id: string; title: string }): string {
	return [
		`[accordion tasks] Taskfold folded part of the span of ${task.id} "${task.title}" of "${task.slug}" to stay inside the budget.`,
		`The content is still recoverable (its {#… FOLDED} tags), but this leaf has now outgrown its span: finish the verifiable part and tasks complete {list: "${task.slug}", id: "${task.id}", report: {…}}, then start or add the next task.`,
	].join("\n");
}

/** The note for a context that is over its fold threshold with nothing left to fold. */
export function saturationNote(holder: { slug: string; id: string; tokens: number } | null): string {
	return [
		"[accordion tasks] The context is above its fold threshold and nothing more can be folded.",
		...(holder ? [
			`Open task ${holder.id} of "${holder.slug}" holds about ${Math.round(holder.tokens / 100) * 100} tokens and cannot fold while it is open.`,
			`Finish its verifiable part with tasks complete {list: "${holder.slug}", id: "${holder.id}", report: {…}} and continue in a new task (tasks add if it was not planned). The record keeps the outcome; the content stays reachable with recall.`,
		] : [
			"What remains is recent work, user messages and content the user holds open. Keep new tool output small, and tell the user that /accordion compact frees room.",
		]),
	].join("\n");
}
