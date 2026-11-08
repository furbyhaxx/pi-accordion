/*
 * taskSession.ts — a session's relationship to its task list: offering the previous list back on
 * resume, recording which list is attached, and queueing the notes the agent must get when the
 * attachment changed outside its own tool calls.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { BINDING_ENTRY, agentNotice, attachedNotice, previousBinding, releasedNotice, resumeSituation, type AttachOutcome, type BindingRecord, type ResumeSituation } from "./taskBinding";
import { changedNotice, listDelta, routedNotice, waitingNotice } from "./taskNotices";
import type { AppliedOp } from "./taskRouting";
import { TaskError, slugFor, taskFingerprint, type TaskList, type TaskStore } from "./tasks";
import { ResumeDialog, TASK_SCREEN_OPTIONS, TaskListsBrowser, type ListDrillDown, type ResumeChoice, type TaskListsHost } from "./tui/taskLists";

/** The custom message type that carries task list notes to the agent. */
export const NOTICE_MESSAGE = "accordion.tasks.notice";

/** The subset of Pi's UI the task list dialogs need. */
export interface TaskSessionUi {
	custom<T>(factory: (tui: any, theme: any, keys: any, done: (value: T) => void) => any, options?: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T>;
}

export interface TaskSessionDeps {
	store(): TaskStore;
	session(): string;
	/** Whether the attached conductor provides the `tasks` tool. */
	enabled(): boolean;
	appendEntry(type: string, data: BindingRecord): void;
	/** The task widget re-reads its list. */
	changed(): void;
}

/** Why a session started, as Pi reports it. */
export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The list a session works on among those it claims: one in progress, else the latest updated. */
export function attachedList(claimed: readonly TaskList[]): TaskList | null {
	return claimed.find((l) => l.tasks.some((t) => t.status === "doing")) ?? [...claimed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export class TaskSession {
	private recorded: BindingRecord | null = null;
	private notices: string[] = [];
	/** The attached list as the agent last knew it: after its own call, or after the last note about it. */
	private seen: TaskList | null = null;
	private resume: Promise<void> | null = null;
	private disposed = false;

	constructor(private readonly deps: TaskSessionDeps) {}

	/**
	 * Read the session's previous list from `entries` (its branch) and settle it: silently when the
	 * outcome is obvious, otherwise through the resume dialog on `ui`. A new session has nothing to settle.
	 */
	start(entries: readonly unknown[], reason: StartReason, ui: TaskSessionUi | null): void {
		const prev = reason === "new" ? null : previousBinding(entries);
		this.recorded = prev ? { slug: prev.slug, ...(prev.fingerprint ? { fingerprint: prev.fingerprint } : {}) } : null;
		if (!prev || !this.deps.enabled()) return;
		let situation: ResumeSituation;
		try {
			situation = resumeSituation(prev, this.deps.store().lists(), this.deps.session());
		} catch {
			return;
		}
		if (situation.kind === "mine") return this.settle(situation, { kind: "reclaimed", list: situation.list });
		if ((situation.kind === "free" || situation.kind === "stale") && (!ui || (reason === "reload" && !situation.changed))) {
			const r = this.attach(situation.slug, false);
			return this.settle(situation, r.ok ? { kind: "reclaimed", list: r.list } : { kind: "without" });
		}
		if (!ui) return this.settle(situation, { kind: "without" });
		// After the handler returns, so the dialog opens on a ready UI.
		this.resume = new Promise<void>((resolve) => setTimeout(resolve, 0))
			.then(() => this.dialog(ui, situation))
			.catch(() => this.settle(situation, { kind: "without" }));
	}

	private async dialog(ui: TaskSessionUi, situation: ResumeSituation): Promise<void> {
		let message = "";
		while (!this.disposed) {
			const r = await ui.custom<{ choice: ResumeChoice; title?: string; goal?: string }>((tui, theme, keys, done) => new ResumeDialog(tui, theme, keys, situation, done, message));
			if (this.disposed) return;
			const choice = r?.choice ?? "without";
			if (choice === "without") return this.settle(situation, { kind: "without" });
			if (choice === "pick") {
				const picked = await this.browse(ui, "pick");
				if (picked) return this.settle(situation, picked);
				continue;
			}
			const res = choice === "reclaim" ? this.attach(situation.slug, situation.kind === "held") : this.create(r.title ?? "", r.goal ?? "");
			if (res.ok) return this.settle(situation, { kind: choice === "reclaim" ? "reclaimed" : "created", list: res.list });
			message = res.message;
		}
	}

	private settle(situation: ResumeSituation, outcome: AttachOutcome): void {
		const note = agentNotice(situation, outcome);
		if (note) this.notices.push(note);
		this.markSeen();
		this.record();
		this.deps.changed();
	}

	/**
	 * Open the list browser; in `pick` mode resolve with the list the user attached or created.
	 * `openList` adds the drill-down screens behind Enter in `manage` mode.
	 */
	async browse(ui: TaskSessionUi, mode: "manage" | "pick", openList?: (tui: any, theme: any, keys: any, slug: string, close: () => void) => ListDrillDown): Promise<AttachOutcome | null> {
		const host = mode === "manage" ? this.noticingHost() : this.host();
		const outcome = await ui.custom<AttachOutcome | null>(
			(tui, theme, keys, done) =>
				new TaskListsBrowser(tui, theme, keys, host, mode, done, () => tui?.terminal?.rows ?? 30, mode === "manage" && openList ? (slug, close) => openList(tui, theme, keys, slug, close) : undefined),
			TASK_SCREEN_OPTIONS,
		);
		this.deps.changed();
		return outcome;
	}

	/** Store actions for the dialogs; attaching releases this session's other lists. */
	host(): TaskListsHost {
		return {
			lists: () => this.deps.store().lists(),
			invalid: () => this.deps.store().scan().invalid,
			session: () => this.deps.session(),
			attach: (slug, force) => this.attach(slug, force),
			release: (slug) => {
				try {
					this.deps.store().release(slug);
					return { ok: true, message: `Released "${slug}".` };
				} catch (e) {
					return { ok: false, message: errorText(e) };
				} finally {
					this.record();
					this.deps.changed();
				}
			},
			create: (title, goal) => this.create(title, goal),
		};
	}

	/** `host()` that also tells the agent about every attachment change the user makes. */
	private noticingHost(): TaskListsHost {
		const base = this.host();
		return {
			...base,
			attach: (slug, force) => {
				const before = this.recorded;
				const r = base.attach(slug, force);
				if (r.ok && !(before?.slug === slug && before.fingerprint === taskFingerprint(r.list))) this.notices.push(attachedNotice({ kind: "replaced", list: r.list }));
				return r;
			},
			release: (slug) => {
				const wasAttached = this.recorded?.slug === slug;
				const r = base.release(slug);
				if (r.ok && wasAttached) this.notices.push(releasedNotice(slug));
				return r;
			},
			create: (title, goal) => {
				const r = base.create(title, goal);
				if (r.ok) this.notices.push(attachedNotice({ kind: "created", list: r.list }));
				return r;
			},
		};
	}

	private attach(slug: string, force: boolean): { ok: true; list: TaskList; message: string } | { ok: false; message: string } {
		const store = this.deps.store();
		try {
			const list = store.claim(slug, force);
			const others = store.claimedBySession().filter((l) => l.slug !== slug);
			for (const o of others) store.release(o.slug);
			this.record();
			this.deps.changed();
			return { ok: true, list, message: `Attached "${slug}"${others.length ? `; released ${others.map((o) => `"${o.slug}"`).join(", ")}` : ""}.` };
		} catch (e) {
			return { ok: false, message: errorText(e) };
		}
	}

	private create(title: string, goal: string): { ok: true; list: TaskList; message: string } | { ok: false; message: string } {
		const store = this.deps.store();
		try {
			if (!title.trim()) throw new TaskError("invalid_args", "A task list needs a title.");
			const slug = slugFor(title, new Set(store.lists().map((l) => l.slug)));
			const list = store.create(slug, title, [goal], []);
			for (const o of store.claimedBySession().filter((l) => l.slug !== slug)) store.release(o.slug);
			this.record();
			this.deps.changed();
			return { ok: true, list, message: `Created and attached "${slug}".` };
		} catch (e) {
			return { ok: false, message: errorText(e) };
		}
	}

	/** Append a binding entry when the attached list or its tasks changed since the last one. */
	record(): void {
		let list: TaskList | null;
		try {
			list = attachedList(this.deps.store().claimedBySession());
		} catch {
			return;
		}
		const next: BindingRecord = list ? { slug: list.slug, fingerprint: taskFingerprint(list) } : { slug: null };
		const prev = this.recorded;
		if (prev ? prev.slug === next.slug && prev.fingerprint === next.fingerprint : next.slug === null) return;
		this.recorded = next;
		this.deps.appendEntry(BINDING_ENTRY, next);
	}

	/** The agent just wrote to its list, or was told its current state: later edits are changes it has not seen. */
	markSeen(): void {
		try {
			this.seen = attachedList(this.deps.store().claimedBySession());
		} catch {
			this.seen = null;
		}
	}

	/** List changes taken from a user message: queue the note and treat the resulting state as seen. */
	noteRouted(slug: string, applied: readonly AppliedOp[]): void {
		if (!applied.length) return;
		this.notices.push(routedNotice(slug, applied));
		this.markSeen();
	}

	/** Put back a note that could not be delivered, so the next prompt still carries it. */
	requeue(text: string): void {
		this.notices.unshift(text);
	}

	/** The change note for edits made since the agent last saw its list, or null. Moves `seen` forward. */
	private changeNote(): string | null {
		let list: TaskList | null;
		try {
			list = attachedList(this.deps.store().claimedBySession());
		} catch {
			return null;
		}
		const before = this.seen;
		this.seen = list;
		if (!list || !before || before.slug !== list.slug) return null;
		const delta = listDelta(before, list);
		return delta ? changedNotice(list.slug, delta) : null;
	}

	/**
	 * The notes waiting for the agent, or null when none. With `prompt` (a new user prompt starts) a task
	 * waiting on the user is named too, after any open resume dialog is answered; between tool calls only
	 * changes are returned.
	 */
	async takeNotice(prompt = true): Promise<string | null> {
		if (prompt && this.resume) await this.resume;
		if (prompt) this.resume = null;
		if (this.deps.enabled()) {
			const change = this.changeNote();
			if (change) this.notices.push(change);
			if (prompt) {
				const list = attachedList(this.deps.store().claimedBySession());
				const waiting = list ? waitingNotice(list) : null;
				if (waiting) this.notices.push(waiting);
			}
		}
		if (!this.notices.length) return null;
		const text = this.notices.join("\n\n");
		this.notices = [];
		return text;
	}

	dispose(): void {
		this.disposed = true;
	}
}
