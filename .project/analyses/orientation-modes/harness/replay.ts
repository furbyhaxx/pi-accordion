/*
 * replay.ts — rebuild a recorded pi session's outgoing context under each orientation arm.
 *
 * The session's active branch is linearized exactly like the extension does (`linearize` →
 * `wireToBlock`), a Truth is built at a cut point, Taskfold is attached with the arm's options and
 * one turn is committed. `serializeWire` then yields what the model would have received. No model
 * calls: the session's recorded classifier verdicts are replayed; without them user messages stay.
 */
import fs from "node:fs";
import { linearize, wireToBlock } from "../../../../core/wire";
import { TestHost } from "../../../../core/conductor/testhost";
import { ORIENTATION_DEFAULTS, TaskfoldConductor, orientationSpan, scanTaskSpans, type OrientationOptions } from "../../../../conductors/in-process/taskfold/taskfold";
import { VerdictLedger, verdictsOf } from "../../../../conductors/in-process/taskfold/verdicts";
import type { PiMessage } from "../../../../core/wire";

export interface Arm {
	id: string;
	orientation: OrientationOptions;
	/** Simulate the agent passing a brief: it is added to the session's `tasks create`/`claim` call. */
	brief?: boolean;
}

/** A copy of `messages` with `brief` added to the first `tasks create` or `claim` call. */
export function withBrief(messages: readonly PiMessage[], brief: string): PiMessage[] {
	let done = false;
	return messages.map((m) => {
		if (done || m.role !== "assistant" || !Array.isArray(m.content)) return m;
		const content = m.content.map((p: { type: string; name?: string; arguments?: Record<string, unknown> }) => {
			if (done || p.type !== "toolCall" || p.name !== "tasks" || (p.arguments?.action !== "create" && p.arguments?.action !== "claim")) return p;
			done = true;
			return { ...p, arguments: { ...p.arguments, brief } };
		});
		return { ...m, content } as PiMessage;
	});
}

/** A–C arms that a replay can measure; D changes agent behaviour and needs live runs. */
const O = ORIENTATION_DEFAULTS;
export const ARMS: Arm[] = [
	{ id: "A", orientation: { ...O } },
	{ id: "C", orientation: { ...O, fold: "typed" } },
	{ id: "C-rules-fold", orientation: { ...O, fold: "typed", rules: "fold" } },
	{ id: "C+brief", orientation: { ...O, fold: "typed" }, brief: true },
];

/** Round 3: Keel rungs on orientation (K), on everything outside finished spans (K+), plus birth skeletons (K+D). */
export const KEEL_ARMS: Arm[] = [
	{ id: "A", orientation: { ...O } },
	{ id: "K", orientation: { ...O, thin: "orientation" } },
	{ id: "K+", orientation: { ...O, thin: "open" } },
	{ id: "K+D", orientation: { ...O, thin: "open", birthSkeleton: true } },
];

export interface Session {
	file: string;
	entries: unknown[];
	messages: PiMessage[];
}

/** The active branch of a session file: from the last entry back along `parentId`. */
export function loadSession(file: string): Session {
	const all = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { id?: string; parentId?: string | null; type?: string; message?: unknown });
	const byId = new Map(all.filter((e) => e.id).map((e) => [e.id!, e]));
	const leaf = [...all].reverse().find((e) => e.id && e.type !== "session");
	const branch: typeof all = [];
	for (let e = leaf; e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.push(e);
	branch.reverse();
	const messages = branch.filter((e) => e.type === "message" && e.message).map((e) => e.message as PiMessage);
	return { file, entries: branch, messages };
}

const textOf = (b: { text: string }) => b.text;

/**
 * Message counts at which to cut: after the first finished task span (of any depth), and after
 * the `n`-th one, so orientation is measured early and once more work followed it.
 */
export function cutPoints(s: Session, later = 4): number[] {
	const blocks = linearize(s.messages).map(wireToBlock);
	// The message each block came from: a block's position in the full linearization equals its
	// position in the linearization of the messages up to and including its own.
	const msgOfBlock: number[] = [];
	for (let i = 0, n = 0; i < s.messages.length; i++) {
		const upTo = linearize(s.messages.slice(i, i + 1), n).length;
		for (let k = 0; k < upTo; k++) msgOfBlock.push(i);
		n += upTo;
	}
	const finished = scanTaskSpans(blocks, textOf)
		.filter((x) => x.status !== null)
		.sort((a, b) => a.end - b.end);
	const at = (i: number) => (finished[i] ? msgOfBlock[finished[i].end] + 1 : null);
	return [at(0), at(later - 1)].filter((n): n is number => n !== null);
}

export interface ReplayResult {
	arm: string;
	/** Tokens of the full and of the serialized (sent) context, Truth's estimates. */
	fullTokens: number;
	liveTokens: number;
	/** Index of the first block whose sent form differs from the raw one: where the prompt cache breaks. */
	cacheBreakAt: number | null;
	orientationTokens: number;
	groups: { key: string | null; members: number; summary: string }[];
	wire: PiMessage[];
}

/** Rebuild the context at `cut` messages under `arm`, with the budget at `budgetFactor` of the full size. */
export async function replay(s: Session, cut: number, arm: Arm, budgetFactor: number, brief?: string): Promise<ReplayResult> {
	const messages = arm.brief && brief ? withBrief(s.messages.slice(0, cut), brief) : s.messages.slice(0, cut);
	const blocks = linearize(messages).map(wireToBlock);
	const host = new TestHost({ meta: { format: "pi", title: "replay", cwd: "", model: "replay" }, blocks, lineCount: 0, skipped: 0 });
	host.truth.wireAttached = true;
	host.setProtect(20_000);
	const full = host.stats().liveTokens;
	host.setBudget(Math.ceil(full * budgetFactor));
	const ledger = new VerdictLedger();
	ledger.reset(verdictsOf(s.entries), null);
	const c = new TaskfoldConductor({ orientation: arm.orientation }, ledger);
	c.attach(host);
	// Birth skeletons act when a fresh result departs; a replay has everything fresh at once.
	if (arm.orientation.birthSkeleton) await host.departWire();
	await host.commitTurn();
	// The thinning conductors run after Taskfold's own pass settles.
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	const wire = host.truth.serializeWire(messages);
	const view = host.blocks();
	const o = orientationSpan(view, textOf, scanTaskSpans(view, textOf), arm.orientation.agentTask);
	let orientationTokens = 0;
	if (o) for (let i = o.span.start; i <= o.span.end; i++) orientationTokens += view[i].tokens;
	const firstChanged = view.findIndex((b) => b.folded || b.grouped);
	c.detach();
	return {
		arm: arm.id,
		fullTokens: full,
		liveTokens: host.stats().liveTokens,
		cacheBreakAt: firstChanged < 0 ? null : firstChanged,
		orientationTokens,
		groups: host.groups().filter((g) => g.folded).map((g) => ({ key: /\] (\S+)/.exec(g.summary ?? "")?.[1] ?? null, members: g.memberIds.length, summary: g.summary ?? "" })),
		wire,
	};
}
