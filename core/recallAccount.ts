/*
 * recallAccount.ts — how many tokens the agent's `recall` tool may add to the context right now.
 *
 * Recalled text is re-derivable, so it is bounded as one session-wide quantity instead of per call:
 * live recall results plus the calls of this turn that returned but are not in the log yet.
 */
import type { Block } from "./types";
import type { Truth } from "./truth";
import { estTokens } from "./tokens";
import { RECALL_TOOL, recallView, type RecallRequest, type RecallView } from "./recallView";

export interface RecallPolicy {
	/** Most tokens one call returns across all its codes. */
	callTokens: number;
	/** Most recalled tokens standing in the context at once. */
	liveTokens: number;
	/** Room kept free below the budget after a call; at most 2% of the budget. */
	margin: number;
	/** A grant below this is refused instead of returning a fragment; at most 2% of the budget. */
	minGrant: number;
}

export const RECALL_POLICY: RecallPolicy = { callTokens: 8_000, liveTokens: 24_000, margin: 4_000, minGrant: 1_000 };

/** Results below this (refusals, released stubs, "no match") are neither counted nor released. */
export const SMALL_RESULT_TOKENS = 200;
const SMALL_BUDGET_SHARE = 0.02;

export function isRecallResult(b: Block): boolean {
	return b.kind === "tool_result" && b.toolName === RECALL_TOOL;
}

export class RecallAccount {
	private readonly reserved = new Map<string, number>();

	/** `policy` is read on every call, so a settings change applies to the next one. */
	constructor(private readonly current: () => RecallPolicy = () => RECALL_POLICY) {}

	get policy(): RecallPolicy {
		return this.current();
	}

	/** Tokens of recalled text the context holds or is about to receive. */
	outstanding(truth: Truth): number {
		let n = this.pending(truth);
		for (const b of truth.blocks) {
			if (!isRecallResult(b) || truth.inFoldedGroup(b.id)) continue;
			const tokens = truth.effTokens(b);
			if (tokens >= SMALL_RESULT_TOKENS) n += tokens;
		}
		return n;
	}

	/** Tokens the next call may return; below `minGrant(truth)` the call must be refused. */
	grant(truth: Truth): number {
		const stats = truth.stats();
		const window = stats.budget > 0 ? stats.budget - stats.liveTokens - this.pending(truth) - Math.min(this.policy.margin, stats.budget * SMALL_BUDGET_SHARE) : Number.POSITIVE_INFINITY;
		return Math.max(0, Math.floor(Math.min(this.policy.callTokens, this.policy.liveTokens - this.outstanding(truth), window)));
	}

	minGrant(truth: Truth): number {
		const budget = truth.stats().budget;
		return budget > 0 ? Math.min(this.policy.minGrant, budget * SMALL_BUDGET_SHARE) : this.policy.minGrant;
	}

	/** Record what a call returned until its result block reaches the log. */
	reserve(callId: string, tokens: number): void {
		this.reserved.set(callId, tokens);
	}

	/** Drop a reservation when its call fails. */
	release(callId: string): void {
		this.reserved.delete(callId);
	}

	/** Forget reservations of calls that never produced a result block (an aborted turn). */
	reset(): void {
		this.reserved.clear();
	}

	private pending(truth: Truth): number {
		if (!this.reserved.size) return 0;
		const landed = new Set<string>();
		for (const b of truth.blocks) if (b.kind === "tool_result" && b.callId && this.reserved.has(b.callId)) landed.add(b.callId);
		for (const id of landed) this.reserved.delete(id);
		let n = 0;
		for (const tokens of this.reserved.values()) n += tokens;
		return n;
	}
}

/** The one-line answer of a call the account cannot serve. It never carries archive text. */
export function recallRefusal(outstanding: number, policy: RecallPolicy): string {
	return `Recall refused: ~${Math.round(outstanding).toLocaleString("en-US")} tokens of recalled text are already in your context (limit ${policy.liveTokens.toLocaleString("en-US")}) or the context is near its budget. Work with what you have recalled; note the facts you need, then continue. Earlier recall results are released as you go.`;
}

export interface RecallServed {
	text: string;
	/** Null when the account refused the call. */
	view: RecallView | null;
}

function availableGrant(truth: Truth, account: RecallAccount, makeRoom?: () => void): number {
	let grant = account.grant(truth);
	if (grant < account.minGrant(truth) && makeRoom) {
		makeRoom();
		grant = account.grant(truth);
	}
	return grant >= account.minGrant(truth) ? grant : 0;
}

function reserveText(account: RecallAccount, callId: string, text: string): void {
	account.reserve(callId, estTokens(text));
}

/** One `recall` call against the account: grant, render within the grant, reserve what was returned. */
export function serveRecall(truth: Truth, account: RecallAccount, callId: string, req: Omit<RecallRequest, "budgetChars">, makeRoom?: () => void): RecallServed {
	const attempt = (grant: number): RecallView | null => {
		if (!grant) return null;
		const view = recallView(truth, { ...req, budgetChars: account.policy.callTokens * CHARS_PER_TOKEN, grantChars: grant * CHARS_PER_TOKEN });
		return view.skipped.length && !view.items.length ? null : view;
	};
	let grant = availableGrant(truth, account);
	let view = attempt(grant);
	if (!view && makeRoom) {
		makeRoom();
		grant = availableGrant(truth, account);
		view = attempt(grant);
	}
	if (!view) return { text: recallRefusal(account.outstanding(truth), account.policy), view: null };
	reserveText(account, callId, view.text);
	return { text: view.text, view };
}

/** Reserve a grant before producing an asynchronous answer, then charge its actual size. */
export async function serveRecallAnswer(truth: Truth, account: RecallAccount, callId: string, produce: (grantTokens: number) => Promise<string>, makeRoom?: () => void): Promise<{ text: string; refused: boolean }> {
	const grant = availableGrant(truth, account, makeRoom);
	if (!grant) return { text: recallRefusal(account.outstanding(truth), account.policy), refused: true };
	account.reserve(callId, grant);
	try {
		const text = (await produce(grant)).slice(0, grant * CHARS_PER_TOKEN);
		reserveText(account, callId, text);
		return { text, refused: false };
	} catch (error) {
		account.release(callId);
		throw error;
	}
}

const CHARS_PER_TOKEN = 4;
