/*
 * recallExpiry.ts — recall results leave the context once they have been used (SPEC-0003 §4).
 *
 * Recalled text is a copy of content the session still holds, so replacing an old result by a line
 * that names the call loses nothing. Pure planning: the caller applies the ops in one transaction.
 */
import type { Block } from "./types";
import type { Op } from "./ops";
import type { Truth } from "./truth";
import { messageKey } from "./groupShape";
import { estTokens } from "./tokens";
import { isRecallResult, RECALL_TOOL, SMALL_RESULT_TOKENS } from "./recallAccount";

const STUB_QUERY_CHARS = 80;

export interface ExpiryRequest {
	/** Assistant messages that must follow a result before it counts as used. */
	keepSteps: number;
	/** With no used result, also release the results of earlier prompts, however recent. */
	earlierPrompts?: boolean;
}

function callArgs(call: Block | undefined): Record<string, unknown> {
	const space = call?.text.indexOf(" ") ?? -1;
	if (!call || space < 0) return {};
	try {
		const v: unknown = JSON.parse(call.text.slice(space + 1));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The line that replaces a released result: the call to repeat, nothing of what it returned. */
export function recallStub(call: Block | undefined): string {
	const args = callArgs(call);
	const codes = Array.isArray(args.codes) ? args.codes.map((c) => `#${String(c).trim().replace(/^#/, "")}`).slice(0, 12) : [];
	const query = typeof args.query === "string" && args.query.trim() ? ` query ${JSON.stringify(args.query.trim().slice(0, STUB_QUERY_CHARS))}` : "";
	const page = typeof args.page === "number" && args.page > 1 ? ` page ${args.page}` : "";
	const ask = typeof args.ask === "string" && args.ask.trim() ? ` ask ${JSON.stringify(args.ask.trim().slice(0, STUB_QUERY_CHARS))}` : "";
	const what = `${codes.join(" ")}${query}${page}${ask}`.trim();
	return `[recall${what ? ` of ${what}` : ""} released to free context; run it again if you still need it]`;
}

/** The `replace` ops that release recall results; empty when nothing qualifies. */
export function expireRecall(truth: Truth, req: ExpiryRequest): Op[] {
	const blocks = truth.blocks;
	const calls = new Map<string, Block>();
	// later[i]: assistant messages after block i; promptAfter[i]: a user message follows block i.
	const later = new Array<number>(blocks.length).fill(0);
	const promptAfter = new Array<boolean>(blocks.length).fill(false);
	let messages = 0;
	let lastKey = "";
	let user = false;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i];
		later[i] = messages;
		promptAfter[i] = user;
		if (b.kind === "user") user = true;
		else if (b.kind === "tool_call" || b.kind === "text" || b.kind === "thinking") {
			const key = messageKey(b.id);
			if (key !== lastKey) messages++;
			lastKey = key;
			if (b.kind === "tool_call" && b.toolName === RECALL_TOOL && b.callId) calls.set(b.callId, b);
		}
	}
	const live = blocks.flatMap((b, i) => (isRecallResult(b) && b.override === null && b.subst === undefined && !truth.inFoldedGroup(b.id) && b.tokens >= SMALL_RESULT_TOKENS ? [i] : []));
	let chosen = live.filter((i) => later[i] >= req.keepSteps);
	if (!chosen.length && req.earlierPrompts) chosen = live.filter((i) => promptAfter[i]);
	return chosen.flatMap((i) => {
		const b = blocks[i];
		const content = recallStub(b.callId ? calls.get(b.callId) : undefined);
		return estTokens(content) < b.tokens ? [{ kind: "replace" as const, id: b.id, content, recoverable: false }] : [];
	});
}
