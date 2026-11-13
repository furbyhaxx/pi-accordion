/*
 * compactCard.ts — the compaction result card (SPEC-0001 §7.6) as plain lines.
 *
 * Pure: the Pi entry renderer and the tests both render from here, so the card a human sees in the
 * transcript and the card under test cannot drift apart.
 */
import type { BlockKind } from "../core/types";
import { formatTokens } from "./dials";
import type { CompactRecord } from "./compaction";

/** The card's first line: outcome, strategy and conductor. */
export function compactCardTitle(record: CompactRecord): string {
	const conductor = record.conductor ? ` (${record.conductor})` : "";
	const seconds = `${(record.durationMs / 1000).toFixed(1)}s`;
	return `✓ accordion compact · ${record.strategy}${conductor} · ${seconds}`;
}

/** A 26-cell usage bar for `tokens` against `full`. */
export function usageBar(tokens: number, full: number, width = 26): string {
	const filled = full > 0 ? Math.max(0, Math.min(width, Math.round((width * tokens) / full))) : 0;
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

const KIND_LABEL: Record<BlockKind, string> = {
	system: "system prompts",
	user: "user messages",
	text: "assistant texts",
	thinking: "thinking blocks",
	tool_call: "tool calls",
	tool_result: "tool results",
};

/** The folded-breakdown line, kinds largest first. */
export function foldedLine(record: CompactRecord): string {
	const parts = Object.entries(record.folded.byKind)
		.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
		.filter(([, n]) => (n ?? 0) > 0)
		.map(([kind, n]) => `${n} ${KIND_LABEL[kind as BlockKind] ?? kind}`);
	if (record.folded.groups) parts.push(`${record.folded.groups} groups`);
	return parts.length ? `folded ${parts.join(" · ")}` : "folded nothing";
}

/** Every line of the card, in order. */
export function compactCardLines(record: CompactRecord, full = record.before): string[] {
	const saved = Math.max(0, record.before - record.after);
	const percent = record.before > 0 ? Math.round((100 * saved) / record.before) : 0;
	return [
		compactCardTitle(record),
		`before ${usageBar(record.before, full)} ${formatTokens(record.before)}`,
		`after  ${usageBar(record.after, full)} ${formatTokens(record.after)}   −${formatTokens(saved)} (${percent}%)`,
		foldedLine(record),
		record.undo ? `/accordion compact undo · /accordion to inspect` : `/accordion to inspect`,
	];
}
