/*
 * resultGuard.ts — no single tool result enters the context larger than a fixed size (SPEC-0003 §5).
 *
 * A result is clipped before it is first sent, so the model never saw it whole and the provider
 * cache is untouched. The clipped block stays recallable by its fold code. Pure planning.
 */
import type { Op } from "./ops";
import type { Truth } from "./truth";
import { foldCode, wireFoldable } from "./digest";
import { isRecallResult } from "./recallAccount";
import { recallStub } from "./recallExpiry";

/** Tokens of the original kept at each end of a clipped result. */
export const GUARD_KEEP_TOKENS = 1_500;
const CHARS_PER_TOKEN = 4;

/** Cut at a line break when one is close, so the kept text does not end mid-line. */
function head(text: string, chars: number): string {
	const cut = text.lastIndexOf("\n", chars);
	return text.slice(0, cut > chars * 0.8 ? cut : chars);
}

function tail(text: string, chars: number): string {
	const from = text.length - chars;
	const cut = text.indexOf("\n", from);
	return text.slice(cut >= 0 && cut < from + chars * 0.2 ? cut + 1 : from);
}

/** What a clipped result shows: both ends and how to reach the rest. */
export function clippedContent(text: string, tokens: number, code: string): string {
	const keep = GUARD_KEEP_TOKENS * CHARS_PER_TOKEN;
	const first = head(text, keep);
	const last = tail(text, keep);
	const hidden = Math.max(0, tokens - Math.ceil((first.length + last.length) / CHARS_PER_TOKEN));
	return `${first}\n[… ~${Math.round(hidden).toLocaleString("en-US")} of ~${Math.round(tokens).toLocaleString("en-US")} tokens clipped. Search the rest: recall({codes:["${code}"], query:"text"}) · read it in pages: recall({codes:["${code}.1"], page:1})]\n${last}`;
}

/**
 * The `replace` ops that clip every unsent tool result above `limitTokens`. An oversized recall
 * result (from a session written before recall was bounded) becomes its one-line stub instead.
 * `includeSent` also clips results the model already saw: the one pass over a loaded session.
 */
export function guardResults(truth: Truth, limitTokens: number, includeSent = false): Op[] {
	if (!(limitTokens > 0)) return [];
	const blocks = truth.blocks;
	const ops: Op[] = [];
	let calls: Map<string, (typeof blocks)[number]> | null = null;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i];
		// Everything at or below the sent frontier was seen whole; only carried-sent stragglers sit above it.
		if (!includeSent && b.order <= truth.sentThroughOrder) break;
		if (b.kind !== "tool_result" || b.tokens <= limitTokens || (!includeSent && truth.sent(b)) || b.override !== null || b.subst !== undefined || !wireFoldable(b) || truth.inFoldedGroup(b.id)) continue;
		if (isRecallResult(b)) {
			calls ??= new Map(blocks.flatMap((c) => (c.kind === "tool_call" && c.callId ? [[c.callId, c] as const] : [])));
			ops.push({ kind: "replace", id: b.id, content: recallStub(b.callId ? calls.get(b.callId) : undefined), recoverable: false });
		} else {
			ops.push({ kind: "replace", id: b.id, content: clippedContent(b.text, b.tokens, foldCode(b.id)), recoverable: true });
		}
	}
	return ops.reverse();
}
