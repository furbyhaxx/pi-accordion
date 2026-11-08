/*
 * taskAdoption.ts — one-time adoption of a session recorded before task events existed
 * (SPEC-0002 §14). Legacy sessions ran `tasks` inside codemode without leaving span events, so the
 * scan never saw those starts and finishes. Adoption replays every `tasks` call of the branch —
 * direct calls tracked for state, nested calls (`nestedCalls` on the outer result, full arguments)
 * turned into events — and reconciles with the list files. Persisted messages are never rewritten:
 * the derived events live in one `accordion.taskfold.adopted` entry and are overlaid on ingest.
 */
import { taskEventsIn, withTaskEvents, type TaskEvent, type TaskEventTask } from "../core/taskEvents";
import type { PiMessage } from "../core/wire";
import { parentId } from "./taskSchema";

export const ADOPTED_ENTRY = "accordion.taskfold.adopted";
/** Bump when derivation changes; an entry from an older version is re-derived. */
export const ADOPTION_VERSION = 1;

/** The fields of a list file task adoption reads. */
export interface AdoptionTask {
	id: string;
	title: string;
	status: string;
	report?: TaskEventTask["report"];
	acceptanceCriteria?: string[];
	pins?: TaskEventTask["pins"];
	endedAt?: string;
}

/** The persisted result of an adoption. */
export interface Adoption {
	version: number;
	/** `<message count>:<last tool call id>` of the branch it was derived from. */
	fingerprint: string;
	/** Events to overlay, by the model-issued tool call id whose result carries them. */
	events: Record<string, TaskEvent[]>;
	/** Counts for the dialog and the entry. */
	stats: { nested: number; reconciled: number; lists: string[] };
}

type Call = { action: string; list: string; id?: string; report?: TaskEventTask["report"] };

const FINISH: Record<string, "done" | "failed" | "abandoned"> = { complete: "done", fail: "failed", abandon: "abandoned" };

function callsOf(m: PiMessage): { id: string; name: string; args: unknown }[] {
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	return (m.content as unknown as { type: string; id?: string; name?: string; arguments?: unknown }[]).flatMap((p) => (p.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string" ? [{ id: p.id, name: p.name, args: p.arguments }] : []));
}

function nestedTasksCalls(m: PiMessage): Call[] {
	const nested = (m as { nestedCalls?: { calls?: unknown } }).nestedCalls?.calls;
	if (!Array.isArray(nested)) return [];
	return nested.flatMap((c: { name?: unknown; status?: unknown; arguments?: unknown }) => {
		const call = c.name === "tasks" && c.status === "ok" ? asCall(c.arguments) : null;
		return call ? [call] : [];
	});
}

function asCall(args: unknown): Call | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	if (typeof a.action !== "string" || typeof a.list !== "string") return null;
	return { action: a.action, list: a.list, ...(typeof a.id === "string" ? { id: a.id } : {}), ...(a.report && typeof a.report === "object" ? { report: a.report as Call["report"] } : {}) };
}

/** True when the branch has `tasks` work that predates task events and no adoption covers it. */
export function needsAdoption(messages: readonly PiMessage[], adoption: Adoption | null): boolean {
	if (adoption && adoption.version === ADOPTION_VERSION && adoption.fingerprint === fingerprintOf(messages)) return false;
	return messages.some((m) => m.role === "toolResult" && m.toolName !== "tasks" && !taskEventsIn(m.details).length && nestedTasksCalls(m).some((c) => c.action in FINISH || c.action === "start" || c.action === "block"));
}

/** Identifies the branch an adoption was derived for. */
export function fingerprintOf(messages: readonly PiMessage[]): string {
	let last = "";
	for (let i = messages.length - 1; i >= 0 && !last; i--) if (messages[i].role === "toolResult" && messages[i].toolCallId) last = messages[i].toolCallId!;
	return `${messages.length}:${last}`;
}

/**
 * Replay the branch's `tasks` calls and derive the events the scan is missing. `lists` maps a list
 * slug to its current tasks; a list that is not given is replayed from the calls alone.
 */
export function deriveAdoption(messages: readonly PiMessage[], lists: ReadonlyMap<string, readonly AdoptionTask[]>): Adoption {
	const byList = new Map([...lists].map(([slug, tasks]) => [slug, new Map(tasks.map((t) => [t.id, t]))]));
	const directArgs = new Map<string, Call>();
	const open = new Map<string, { list: string; id: string }>();
	const events: Record<string, TaskEvent[]> = {};
	let nested = 0;
	let reconciled = 0;
	const snap = (list: string, id: string, status: string, report?: TaskEventTask["report"]): TaskEventTask => {
		const t = byList.get(list)?.get(id);
		return {
			id,
			title: t?.title ?? id,
			status,
			...(report ?? t?.report ? { report: report ?? t?.report } : {}),
			...(t?.acceptanceCriteria?.length ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
			...(t?.pins?.length ? { pins: t.pins } : {}),
		};
	};
	const openDescendants = (list: string, id: string) => [...open.values()].filter((o) => o.list === list && o.id.startsWith(`${id}.`));
	// Mirrors the store: start opens the task and every ancestor not yet doing; fail/abandon
	// abandon the open subtasks; finishing removes the task.
	const apply = (c: Call): TaskEvent | null => {
		if (!c.id) return null;
		const key = `${c.list}/${c.id}`;
		if (c.action === "start") {
			const chain: string[] = [];
			for (let id: string | null = c.id; id; id = parentId(id)) chain.unshift(id);
			const started = chain.filter((id) => !open.has(`${c.list}/${id}`) || id === c.id);
			for (const id of started) open.set(`${c.list}/${id}`, { list: c.list, id });
			return { action: "start", list: c.list, id: c.id, task: snap(c.list, c.id, "doing"), started: started.map((id) => snap(c.list, id, "doing")) };
		}
		if (c.action === "block") return open.has(key) ? { action: "block", list: c.list, id: c.id } : null;
		const status = FINISH[c.action];
		if (!status) return null;
		const cascaded = status === "done" ? [] : openDescendants(c.list, c.id);
		for (const d of cascaded) open.delete(`${d.list}/${d.id}`);
		open.delete(key);
		return { action: c.action as TaskEvent["action"], list: c.list, id: c.id, task: snap(c.list, c.id, status, c.report), ...(cascaded.length ? { cascaded: cascaded.map((d) => snap(d.list, d.id, "abandoned")) } : {}) };
	};
	const results: { callId: string; at: number }[] = [];
	for (const m of messages) {
		for (const call of callsOf(m)) if (call.name === "tasks") {
			const c = asCall(call.args);
			if (c) directArgs.set(call.id, c);
		}
		if (m.role !== "toolResult" || !m.toolCallId) continue;
		// A direct tasks result keeps its legacy scan; events there would replace it.
		if (m.toolName !== "tasks") results.push({ callId: m.toolCallId, at: m.timestamp ?? 0 });
		if (m.toolName === "tasks") {
			const c = directArgs.get(m.toolCallId);
			if (!c || m.isError) continue;
			apply(c);
			const d = m.details && typeof m.details === "object" ? (m.details as { closed?: { id?: unknown }[] }) : null;
			for (const closed of d?.closed ?? []) if (typeof closed.id === "string") open.delete(`${c.list}/${closed.id}`);
			continue;
		}
		if (taskEventsIn(m.details).length) continue;
		const derived = nestedTasksCalls(m).flatMap((c) => apply(c) ?? []);
		if (!derived.length) continue;
		nested += derived.length;
		events[m.toolCallId] = derived;
	}
	// A task the list says is finished but the replay still holds open was closed by a call the
	// session does not show (another session, a hand edit, a failed nested report). Close it at the
	// first result after its end time, so the span stops holding everything after it.
	const opened = [...open.values()].sort((a, b) => b.id.split(".").length - a.id.split(".").length);
	for (const o of opened) {
		const t = byList.get(o.list)?.get(o.id);
		if (!t || !(t.status in { done: 1, failed: 1, abandoned: 1 })) continue;
		const endedAt = t.endedAt ? Date.parse(t.endedAt) : Number.NaN;
		const target = results.find((r) => Number.isFinite(endedAt) && r.at >= endedAt) ?? results[results.length - 1];
		if (!target) continue;
		const action = t.status === "done" ? "complete" : t.status === "failed" ? "fail" : "abandon";
		(events[target.callId] ??= []).push({ action, list: o.list, id: o.id, task: snap(o.list, o.id, t.status) });
		open.delete(`${o.list}/${o.id}`);
		reconciled++;
	}
	const used = new Set(Object.values(events).flatMap((evs) => evs.map((e) => e.list)));
	return { version: ADOPTION_VERSION, fingerprint: fingerprintOf(messages), events, stats: { nested, reconciled, lists: [...used].sort() } };
}

/** `messages` with adopted events overlaid on their results; untouched messages keep identity. */
export function applyAdoption<M extends PiMessage>(messages: readonly M[], adoption: Adoption | null): M[] {
	if (!adoption || !Object.keys(adoption.events).length) return messages as M[];
	return messages.map((m) => {
		const evs = m.role === "toolResult" && m.toolCallId && m.toolName !== "tasks" ? adoption.events[m.toolCallId] : undefined;
		if (!evs?.length || taskEventsIn(m.details).length) return m;
		// Host-tool details that cannot carry events are replaced: only `taskEvents` reach Truth anyway.
		return { ...m, details: withTaskEvents(m.details, evs) ?? { taskEvents: evs } } as M;
	});
}

/** The newest adoption entry on a branch, or null. */
export function adoptionOf(entries: readonly { type?: string; customType?: string; data?: unknown }[]): Adoption | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "custom" || e.customType !== ADOPTED_ENTRY) continue;
		const d = e.data as Partial<Adoption> | undefined;
		if (d && typeof d.version === "number" && typeof d.fingerprint === "string" && d.events && typeof d.events === "object") return d as Adoption;
	}
	return null;
}
