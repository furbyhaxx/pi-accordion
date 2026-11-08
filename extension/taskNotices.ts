/*
 * taskNotices.ts — the notes the agent gets about task list changes it did not make (SPEC-0002 §4.4).
 * Pure: `listDelta` compares two list states, the `*Notice` builders return the one-line JSON that is
 * appended once as a custom message. Nothing here reads files or sends anything.
 */
import { attachmentRef, type Attachment, type Pin } from "./taskPins";
import type { Item } from "./taskSchema";
import { currentBlock, type TaskList } from "./tasks";
import type { AppliedOp } from "./taskRouting";

const MAX_ENTRIES = 20;
const SAID_CHARS = 100;

interface ItemDelta {
	added?: Item[];
	removed?: string[];
	edited?: Item[];
}

/** What changed in one scope (the list, or one task). */
interface ScopeDelta {
	goals?: ItemDelta;
	criteria?: ItemDelta;
	pins?: { added?: { id: string; kind: string; text: string }[]; removed?: string[] };
	attachments?: { added?: { id: string; ref: string }[]; removed?: string[] };
}

/** Changes made outside the agent's own tool calls. Task entries are keyed by task id. */
export interface ListDelta extends ScopeDelta {
	tasks?: {
		added?: { id: string; title: string }[];
		removed?: string[];
		changed?: { id: string; title?: string; status?: string }[];
	};
	within?: Record<string, ScopeDelta>;
	more?: number;
}

const byId = <T extends { id: string }>(xs: readonly T[] | undefined) => new Map((xs ?? []).map((x) => [x.id, x]));
const empty = (o: object) => Object.keys(o).length === 0;
const pick = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>));
const some = <T>(xs: T[]): T[] | undefined => (xs.length ? xs : undefined);
const nonEmpty = <T extends object>(o: T): T | undefined => (empty(o) ? undefined : o);

function itemDelta(before: readonly Item[] | undefined, after: readonly Item[] | undefined): ItemDelta | undefined {
	const was = byId(before);
	const now = byId(after);
	const added = [...now.values()].filter((i) => !was.has(i.id)).map(({ id, text }) => ({ id, text }));
	const removed = [...was.keys()].filter((id) => !now.has(id));
	const edited = [...now.values()].filter((i) => was.has(i.id) && was.get(i.id)!.text !== i.text).map(({ id, text }) => ({ id, text }));
	return nonEmpty({ ...pick("added", some(added)), ...pick("removed", some(removed)), ...pick("edited", some(edited)) });
}

const attachmentKey = (a: Attachment) => `${a.id}\0${attachmentRef(a)}`;

function scopeDelta(before: { goals?: Item[]; acceptanceCriteria?: Item[]; pins?: Pin[]; attachments?: Attachment[] } | undefined, after: { goals?: Item[]; acceptanceCriteria?: Item[]; pins?: Pin[]; attachments?: Attachment[] }): ScopeDelta | undefined {
	const goals = itemDelta(before?.goals, after.goals);
	const criteria = itemDelta(before?.acceptanceCriteria, after.acceptanceCriteria);
	const wasPins = byId(before?.pins);
	const nowPins = byId(after.pins);
	const pinsAdded = [...nowPins.values()].filter((p) => !wasPins.has(p.id)).map(({ id, kind, text }) => ({ id, kind, text }));
	const pinsRemoved = [...wasPins.keys()].filter((id) => !nowPins.has(id));
	const wasAtt = new Map((before?.attachments ?? []).map((a) => [attachmentKey(a), a]));
	const nowAtt = new Map((after.attachments ?? []).map((a) => [attachmentKey(a), a]));
	const attAdded = [...nowAtt.entries()].filter(([k]) => !wasAtt.has(k)).map(([, a]) => ({ id: a.id, ref: attachmentRef(a) }));
	const attRemoved = [...wasAtt.values()].filter((a) => !nowAtt.has(attachmentKey(a)) && !(after.attachments ?? []).some((n) => n.id === a.id)).map((a) => a.id);
	return nonEmpty({
		...pick("goals", goals),
		...pick("criteria", criteria),
		...pick("pins", nonEmpty({ ...pick("added", some(pinsAdded)), ...pick("removed", some(pinsRemoved)) })),
		...pick("attachments", nonEmpty({ ...pick("added", some(attAdded)), ...pick("removed", some(attRemoved)) })),
	});
}

/** The `doing` leaf's id and those of its ancestors: the branch whose context the agent is living with. */
function doingBranch(list: TaskList): Set<string> {
	const doing = list.tasks.filter((t) => t.status === "doing");
	const branch = new Set<string>();
	for (const t of doing) for (const o of list.tasks) if (t.id === o.id || t.id.startsWith(`${o.id}.`)) branch.add(o.id);
	return branch;
}

/**
 * What the user (or another session) changed between `before` and `after` that the agent relies on:
 * the list's goals, pins and attachments, the context of the `doing` branch, and tasks that appeared,
 * vanished, were renamed or changed status. Null when nothing relevant changed.
 */
export function listDelta(before: TaskList, after: TaskList): ListDelta | null {
	const out: ListDelta = { ...scopeDelta(before, after) };
	let entries = 0;
	const room = <T>(xs: T[]): T[] => {
		const kept = xs.slice(0, Math.max(0, MAX_ENTRIES - entries));
		entries += kept.length;
		if (kept.length < xs.length) out.more = (out.more ?? 0) + xs.length - kept.length;
		return kept;
	};
	const was = byId(before.tasks);
	const now = byId(after.tasks);
	const added = room([...now.values()].filter((t) => !was.has(t.id)).map(({ id, title }) => ({ id, title })));
	const removed = room([...was.keys()].filter((id) => !now.has(id)));
	const changed = room(
		[...now.values()]
			.filter((t) => was.has(t.id) && (was.get(t.id)!.title !== t.title || was.get(t.id)!.status !== t.status))
			.map((t) => ({ id: t.id, ...(was.get(t.id)!.title !== t.title ? { title: t.title } : {}), ...(was.get(t.id)!.status !== t.status ? { status: t.status } : {}) })),
	);
	const tasks = nonEmpty({ ...pick("added", some(added)), ...pick("removed", some(removed)), ...pick("changed", some(changed)) });
	if (tasks) out.tasks = tasks;
	const within: Record<string, ScopeDelta> = {};
	for (const id of doingBranch(after)) {
		const t = now.get(id)!;
		const d = scopeDelta(was.get(id), t);
		if (d) within[id] = d;
	}
	if (!empty(within)) out.within = within;
	return empty(out) ? null : out;
}

const line = (value: unknown) => JSON.stringify(value);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `{"tasks":"auth","changed":{…}}` for a change the user made outside the agent's calls. */
export function changedNotice(slug: string, delta: ListDelta): string {
	return line({ tasks: slug, changed: delta });
}

/** `{"tasks":"auth","changed":{"by":"user-message","ops":[…]}}` for list changes taken from a user message. */
export function routedNotice(slug: string, applied: readonly AppliedOp[]): string {
	const ops = applied.map((o) => ({
		op: o.op,
		kind: o.kind,
		target: o.target,
		...(o.ref ? { ref: o.ref } : {}),
		...(o.value ? { text: short(o.value, SAID_CHARS) } : {}),
	}));
	return line({ tasks: slug, changed: { by: "user-message", ops } });
}

/** `{"tasks":"auth","waiting":[…]}` when a task waits on the user; null when none does. */
export function waitingNotice(list: TaskList): string | null {
	const waiting = list.tasks.flatMap((t) => {
		const block = currentBlock(t);
		return block?.reason === "user-decision" || block?.reason === "user-input" ? [{ id: t.id, reason: block.reason, ...(block.detail ? { detail: block.detail } : {}) }] : [];
	});
	return waiting.length ? line({ tasks: list.slug, waiting }) : null;
}
