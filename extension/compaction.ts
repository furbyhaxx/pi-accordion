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
import { wireFoldable } from "../core/digest";

export type { CompactRecord, CompactStrategy, CompactTrigger } from "../core/protocol";

/** One compaction request. */
export interface CompactRequest {
	trigger: CompactTrigger;
	strategy: CompactStrategy;
	instructions?: string;
	dryRun?: boolean;
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

/** The `{#code FOLDED}` prefixes a bake must strip, since baked text can no longer be recalled. */
const FOLD_TAG = /\{#[0-9a-z]{6} FOLDED\}\s*/g;

/** Strip every fold tag from `text`. */
export function stripFoldTags(text: string): string {
	return text.replace(FOLD_TAG, "").trim();
}

/** Bake's summary: one section per turn, capped by dropping the oldest sections first (§7.5). */
export function buildBakeSummary(
	blocks: readonly Block[],
	opts: { instructions?: string; capTokens: number; countTokens?: (text: string) => number; contextWindow?: number | null } = { capTokens: 20_000 },
): string {
	const count = opts.countTokens ?? ((t: string) => Math.ceil(t.length / 4));
	const turns = new Map<number, Block[]>();
	for (const b of blocks) {
		const list = turns.get(b.turn);
		if (list) list.push(b);
		else turns.set(b.turn, [b]);
	}
	const sections = [...turns.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([turn, list]) => ({ turn, lines: sectionLines(turn, list) }));
	const header = [`[accordion-bake v1] ${blocks.length} messages`, opts.instructions ? `instructions: ${stripFoldTags(opts.instructions)}` : null].filter((l): l is string => !!l);
	let omitted = 0;
	const render = () => [...header, ...(omitted ? [`… ${omitted} earlier turns omitted`] : []), ...sections.map((s) => s.lines.join("\n"))].join("\n");
	let text = render();
	while (sections.length && count(text) > opts.capTokens) {
		sections.shift();
		omitted++;
		text = render();
	}
	return text;
}

function sectionLines(turn: number, list: readonly Block[]): string[] {
	const head = list.find((b) => b.kind === "user");
	const out = [`── turn ${turn}${head ? " · user" : ""}`];
	if (head) out.push(stripFoldTags(head.subst ?? head.text));
	for (const b of list) {
		if (b === head || b.kind === "user" || b.kind === "system") continue;
		out.push(`· ${b.kind}${b.toolName ? ` ${b.toolName}` : ""}: ${stripFoldTags(b.subst ?? b.text).slice(0, 300)}`);
	}
	return out;
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
		const cap = Math.min(20_000, Math.max(1_000, Math.floor(0.1 * (truth.stats().contextWindow || 200_000))));
		const summary = buildBakeSummary(truth.blocks, { capTokens: cap, instructions: req.instructions });
		return {
			record: { ...base, dryRun: true, strategy: req.strategy, after: before, durationMs: 0, folded: empty, undo: null, message: "Compaction preview." },
			projection: { pass: deps.conductorSaved(), aggressive: aggressiveProjection(truth), bake: Math.ceil(summary.length / 4), native: null },
		};
	}

	deps.armFolding();
	if (req.strategy === "pass") {
		if (!conductor) deps.attachDefault();
		const foldedBefore = foldedIds(truth);
		const settled = await deps.requestPass(req.instructions ? { instructions: req.instructions } : {});
		const after = truth.stats().liveTokens;
		if (after < before) {
			const newly = [...foldedIds(truth)].filter((id) => !foldedBefore.has(id));
			return {
				record: {
					...base, strategy: "pass", after, durationMs: deps.now() - started, folded: describe(truth, newly),
					undo: newly.length ? [{ kind: "unfold", ids: newly }] : null,
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
		const { folded } = applyAggressive(truth);
		const cap = Math.min(20_000, Math.max(1_000, Math.floor(0.1 * (truth.stats().contextWindow || 200_000))));
		const summary = buildBakeSummary(truth.blocks, {
			capTokens: cap,
			instructions: req.instructions,
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
function applyAggressive(truth: Truth): { folded: CompactRecord["folded"]; ids: string[] } {
	const targets = aggressiveTargets(truth);
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
