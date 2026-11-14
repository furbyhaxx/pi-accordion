/*
 * compaction.ts — one explicit compaction pass, with the four strategies of SPEC-0001 §7.2.
 *
 * Every entry point (/compact, the threshold, overflow, /accordion compact, the panel) funnels
 * through `runCompaction`. The module is pure against an injected host seam so strategies, undo
 * records and the bake summary are testable without Pi; the caller owns appending the result card
 * and returning Pi's compaction payload.
 */
import type { Op } from "../core/ops";
import type { CompactRecord, CompactStrategy, CompactTrigger } from "../core/protocol";
import type { Block, BlockKind, Group } from "../core/types";
import type { Truth } from "../core/truth";
import { digest, wireFoldable } from "../core/digest";
import { messageKey } from "../core/groupShape";
import { parseCarrier } from "../conductors/in-process/taskfold/records";
import { contentFingerprint, messageInfo, type PiMessage } from "../core/wire";

export type { CompactRecord, CompactStrategy, CompactTrigger } from "../core/protocol";

/** One compaction request. */
export interface CompactRequest {
	trigger: CompactTrigger;
	strategy: CompactStrategy;
	instructions?: string;
	dryRun?: boolean;
	/** Exact source range supplied by Pi for bake. */
	bakeBlocks?: readonly Block[];
	previousSummary?: string;
}

/** The pass's view of the session; every field is owned by the extension. */
export interface CompactDeps {
	truth(): Truth | null;
	folding(): boolean;
	/** Arms folding; a pass cannot relieve anything while folding is off. */
	armFolding(): void;
	/** The attached conductor's id and label, if any. */
	conductor(): { id: string; label: string } | null;
	/** Attaches the configured default conductor when none is attached. */
	attachDefault(): void;
	/** Fires one compaction pass and reports whether it settled. */
	requestPass(opts: { instructions?: string }): Promise<"settled" | "timeout" | "no-conductor">;
	/** The tokens the attached conductor last reported freeing, when it reports one. */
	conductorSaved(): number | null;
	now(): number;
	id(): string;
}

/** The result of a pass, plus Pi's payload when the strategy bakes. */
export interface CompactOutcome {
	record: CompactRecord;
	/** Present for `bake`: the summary Pi stores in place of the summarized messages. */
	bake?: { summary: string; estimatedTokensAfter: number };
	/** Estimated token figures for a dry run. */
	projection?: { pass: number | null; aggressive: number; bake: number; native: null };
}

/** Blocks an `aggressive` pass may fold: unprotected, unfolded, unheld, ungrouped, and smaller folded. */
export function aggressiveTargets(truth: Truth): string[] {
	return truth.blocks
		.filter((b) => !truth.isProtected(b) && !truth.isFolded(b) && !truth.held(b) && !truth.groupOf(b) && wireFoldable(b) && truth.foldedTokensOf(b) < b.tokens)
		.map((b) => b.id);
}

/** Tokens an `aggressive` pass would free, without applying it. */
export function aggressiveProjection(truth: Truth): number {
	return aggressiveTargets(truth).reduce((saved, id) => {
		const b = truth.get(id);
		return b ? saved + (b.tokens - truth.foldedTokensOf(b)) : saved;
	}, 0);
}

/** Whether a pass still needs the configured saturation fallback. */
export function needsSaturationFallback(trigger: CompactTrigger, before: number, after: number, window: number, reserve: number): boolean {
	if (trigger === "overflow") return after >= before;
	return trigger === "threshold" && window > 0 && after > window - reserve;
}

/** Resolve Pi's summarized messages to the exact durable blocks in the current Truth. */
export function bakeMessageBlocks(truth: Truth, messages: readonly PiMessage[], current: readonly PiMessage[]): Block[] | null {
	const sources = new Map<string, number>();
	for (const message of current) {
		const info = messageInfo(message, 0);
		if (info.hasNonDurable || !info.ids.length) continue;
		for (const id of info.ids) {
			if (sources.has(id)) return null;
			sources.set(id, contentFingerprint(message));
		}
	}
	const ids = new Set<string>();
	for (const message of messages) {
		const info = messageInfo(message, 0);
		if (info.hasNonDurable || !info.ids.length) return null;
		const fingerprint = contentFingerprint(message);
		for (const id of info.ids) {
			if (ids.has(id) || sources.get(id) !== fingerprint || !truth.get(id)) return null;
			ids.add(id);
		}
	}
	for (const group of truth.groups) {
		if (group.folded && group.memberIds.some((id) => ids.has(id)) && group.memberIds.some((id) => !ids.has(id))) return null;
	}
	return truth.blocks.filter((block) => ids.has(block.id));
}

/** The `{#code FOLDED}` prefixes a bake must strip, since baked text can no longer be recalled. */
const FOLD_TAG = /\{#[0-9a-z]{6} FOLDED\}\s*/g;

/** Strip every fold tag from `text`. */
export function stripFoldTags(text: string): string {
	return text.replace(FOLD_TAG, "").trim();
}

/** Bake's summary: one section per turn, capped by dropping the oldest sections first (§7.5). */
export function buildBakeSummary(
	blocks: readonly Block[],
	opts: { instructions?: string; previousSummary?: string; capTokens: number; countTokens?: (text: string) => number; contextWindow?: number | null; truth?: Truth } = { capTokens: 20_000 },
): string {
	const count = opts.countTokens ?? ((t: string) => Math.ceil(t.length / 4));
	const turns = new Map<number, string[]>();
	const seenGroups = new Set<string>();
	for (const b of blocks) {
		if (b.kind === "system") continue;
		const lines = turns.get(b.turn) ?? [];
		turns.set(b.turn, lines);
		const group = opts.truth?.groupOf(b);
		if (group?.folded) {
			if (seenGroups.has(group.id)) continue;
			seenGroups.add(group.id);
			const summary = opts.truth!.groupSummary(group);
			const carrier = parseCarrier(summary)?.obj;
			const key = carrier?.task ?? carrier?.history ?? carrier?.part;
			const label = typeof key === "string"
				? `── task ${key}${typeof carrier?.title === "string" ? ` "${carrier.title}"` : ""}${typeof carrier?.status === "string" ? ` ${carrier.status}` : ""}`
				: "── folded group";
			lines.push(label, stripFoldTags(summary));
		} else if (b.kind === "user") {
			lines.push(`── turn ${b.turn} · user`, stripFoldTags(b.subst ?? b.text));
		} else {
			lines.push(`── turn ${b.turn} · results`, stripFoldTags(opts.truth?.isFolded(b) ? (b.subst ?? digest(b)) : digest(b)));
		}
	}
	const sections = [...turns.values()].filter((lines) => lines.length);
	const before = blocks.reduce((sum, b) => sum + b.tokens, 0);
	const messages = new Set(blocks.map((b) => messageKey(b.id))).size;
	const cap = Math.min(opts.capTokens, 20_000, opts.contextWindow ? Math.floor(opts.contextWindow * 0.1) : 20_000);
	let omitted = 0;
	const render = () => {
		let after = 0;
		let text = "";
		for (;;) {
			text = [`[accordion-bake v1] ${messages} messages · ${before} → ${after} tok`, ...(opts.instructions ? [`instructions: ${stripFoldTags(opts.instructions)}`] : []), ...(opts.previousSummary ? ["── previous summary", opts.previousSummary] : []), ...(omitted ? [`… ${omitted} earlier turns omitted`] : []), ...sections.map((s) => s.join("\n"))].join("\n");
			const next = count(text);
			if (next === after) return text;
			after = next;
		}
	};
	let text = render();
	while (sections.length && count(text) > cap) {
		sections.shift();
		omitted++;
		text = render();
	}
	return text;
}

/** Run one compaction pass. */
export async function runCompaction(req: CompactRequest, deps: CompactDeps): Promise<CompactOutcome> {
	const started = deps.now();
	const truth = deps.truth();
	const before = truth ? truth.stats().liveTokens : 0;
	const conductor = deps.conductor();
	const base = { id: deps.id(), at: started, trigger: req.trigger, conductor: conductor?.id ?? null, before };
	const empty = { blocks: 0, groups: 0, byKind: {} };
	if (!truth) return { record: { ...base, strategy: req.strategy, after: before, durationMs: 0, folded: empty, undo: null, message: "No context to compact." } };
	if (req.dryRun) {
		const cap = Math.min(20_000, Math.floor(0.1 * (truth.stats().contextWindow || 200_000)));
		const summary = buildBakeSummary(truth.blocks, { capTokens: cap, instructions: req.instructions, truth });
		return {
			record: { ...base, dryRun: true, strategy: req.strategy, after: before, durationMs: 0, folded: empty, undo: null, message: "Compaction preview." },
			projection: { pass: deps.conductorSaved(), aggressive: aggressiveProjection(truth), bake: Math.ceil(summary.length / 4), native: null },
		};
	}

	deps.armFolding();
	if (req.strategy === "pass") {
		if (!conductor) deps.attachDefault();
		const foldedBefore = foldedIds(truth);
		const groupsBefore = new Set(truth.groups.map((group) => group.id));
		const settled = await deps.requestPass(req.instructions ? { instructions: req.instructions } : {});
		const after = truth.stats().liveTokens;
		if (after < before) {
			const groups = truth.groups.filter((group) => !groupsBefore.has(group.id));
			const groupMembers = new Set(groups.flatMap((group) => group.memberIds));
			const newly = [...foldedIds(truth)].filter((id) => !foldedBefore.has(id) && !groupMembers.has(id));
			const folded = describe(truth, newly);
			folded.groups = groups.length;
			const undo: Op[] = [...groups.map((group): Op => ({ kind: "ungroup", groupId: group.id })), ...(newly.length ? [{ kind: "unfold" as const, ids: newly }] : [])];
			return {
				record: {
					...base, strategy: "pass", after, durationMs: deps.now() - started, folded,
					undo: undo.length ? undo : null,
					message: `conductor freed ${before - after} tok${settled === "timeout" ? " before the pass timed out" : ""}`,
				},
			};
		}
		// Nothing came back: fall through to aggressive, and say the strategy actually used.
		const { folded, ids } = applyAggressive(truth);
		return {
			record: {
				...base, strategy: "aggressive", after: truth.stats().liveTokens, durationMs: deps.now() - started, folded,
				undo: ids.length ? [{ kind: "unfold", ids }] : null,
				message: "conductor freed nothing; folded all eligible blocks",
			},
		};
	}
	if (req.strategy === "aggressive") {
		const { folded, ids } = applyAggressive(truth);
		return {
			record: { ...base, strategy: "aggressive", after: truth.stats().liveTokens, durationMs: deps.now() - started, folded, undo: ids.length ? [{ kind: "unfold", ids }] : null, message: `folded ${folded.blocks} block(s)` },
		};
	}
	if (req.strategy === "bake") {
		const range = req.bakeBlocks ?? truth.blocks;
		const rangeIds = new Set(range.map((b) => b.id));
		const { folded } = applyAggressive(truth, rangeIds);
		const cap = Math.min(20_000, Math.floor(0.1 * (truth.stats().contextWindow || 200_000)));
		const summary = buildBakeSummary(range, {
			capTokens: cap,
			instructions: req.instructions,
			previousSummary: req.previousSummary,
			truth,
			countTokens: (t) => Math.ceil(t.length / 4),
		});
		return {
			record: { ...base, strategy: "bake", after: truth.stats().liveTokens, durationMs: deps.now() - started, folded, undo: null, message: "baked a permanent summary" },
			bake: { summary, estimatedTokensAfter: Math.ceil(summary.length / 4) },
		};
	}
	return {
		record: { ...base, strategy: "native", after: truth.stats().liveTokens, durationMs: deps.now() - started, folded: empty, undo: null, message: "pi summarizes (model call)" },
	};
}

/** Fold every eligible block and report what was actually applied. */
function applyAggressive(truth: Truth, range?: ReadonlySet<string>): { folded: CompactRecord["folded"]; ids: string[] } {
	const targets = range ? aggressiveTargets(truth).filter((id) => range.has(id)) : aggressiveTargets(truth);
	if (!targets.length) return { folded: { blocks: 0, groups: 0, byKind: {} }, ids: [] };
	const result = truth.apply([{ kind: "fold", ids: targets }], "auto");
	const ids = result.results.filter((r) => r.applied && r.op.kind === "fold").flatMap((r) => (r.op.kind === "fold" ? r.op.ids : []));
	return { folded: describe(truth, ids), ids };
}

/** Ids currently folded, for diffing a conductor's pass. */
function foldedIds(truth: Truth): Set<string> {
	return new Set(truth.blocks.filter((b) => truth.isFolded(b)).map((b) => b.id));
}

/** Fold counts for `ids`, by kind. */
function describe(truth: Truth, ids: readonly string[]): CompactRecord["folded"] {
	const byKind: Partial<Record<BlockKind, number>> = {};
	for (const id of ids) {
		const b = truth.get(id);
		if (b) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
	}
	return { blocks: ids.length, groups: 0, byKind };
}

/** Undo one record against the current Truth; ids no longer folded are skipped and reported. */
export function applyUndo(truth: Truth, undo: readonly Op[]): { restored: number; skipped: number } {
	let restored = 0;
	let skipped = 0;
	for (const op of undo) {
		if (op.kind === "unfold") {
			const live = op.ids.filter((id) => {
				const b = truth.get(id);
				if (b && truth.isFolded(b)) return true;
				skipped++;
				return false;
			});
			if (!live.length) continue;
			const result = truth.apply([{ kind: "unfold", ids: live }], "you");
			if (result.results.some((r) => r.applied)) restored += live.length;
			continue;
		}
		if (op.kind === "ungroup") {
			const g = truth.groups.find((x: Group) => x.id === op.groupId);
			if (!g) {
				skipped++;
				continue;
			}
			const result = truth.apply([op], "you");
			restored += result.results.filter((r) => r.applied).length;
		}
	}
	return { restored, skipped };
}
