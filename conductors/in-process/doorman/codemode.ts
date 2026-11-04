/*
 * conductors/in-process/doorman/codemode.ts
 *
 * Per-section compaction of a codemode tool_result, shared by doorman, keel-lite and triptych.
 * A codemode run batches several tool calls into one result, so compressing it as one text cuts
 * whole sections; this rewrites each printed section on its own: code-file reads become skeletons,
 * long sections keep their head and tail, short sections stay verbatim. Pure and deterministic.
 */

import { parseCodemodeResult, renderCodemode, type CodemodeSection } from "../../../core/codemode";
import { classifyCodemodeRead } from "./classify";

export interface CodemodeCompactOptions {
	/** Skeleton text for a classified code read, or null to leave the section to trimming. */
	skeleton?: (path: string | undefined, source: string) => string | null;
	/** Head/tail trim of long sections; omit to keep non-code sections verbatim. */
	trim?: { headLines: number; tailLines: number; lineChars: number };
}

export interface CodemodeCompaction {
	/** The replacement text, without a fold tag (the engine adds it). */
	content: string;
	sections: number;
	skeletons: number;
	trims: number;
}

/** Head and tail of a long section around an elision marker; null when nothing would be cut. */
export function trimSection(text: string, opts: NonNullable<CodemodeCompactOptions["trim"]>): string | null {
	const lines = text.replace(/\s+$/, "").split("\n");
	const clip = (l: string) => (l.length > opts.lineChars ? `${l.slice(0, opts.lineChars)}…` : l);
	const clipped = lines.some((l) => l.length > opts.lineChars);
	if (lines.length <= opts.headLines + opts.tailLines) return clipped ? lines.map(clip).join("\n") : null;
	const elided = lines.length - opts.headLines - opts.tailLines;
	return [...lines.slice(0, opts.headLines).map(clip), `… ${elided} lines elided …`, ...lines.slice(lines.length - opts.tailLines).map(clip)].join("\n");
}

/** Rewrite a codemode result section by section; null when no section would change. */
export function compactCodemode(resultText: string | undefined, callText: string | undefined, opts: CodemodeCompactOptions): CodemodeCompaction | null {
	const out = parseCodemodeResult(resultText, callText);
	if (!out || out.sections.length === 0) return null;
	let skeletons = 0;
	let trims = 0;
	const body = (s: CodemodeSection): string => {
		if (!s.failed && opts.skeleton) {
			const info = classifyCodemodeRead(s.call?.tool, s.call?.path, s.text);
			const sk = info ? opts.skeleton(info.path, info.source) : null;
			if (sk !== null) {
				skeletons++;
				return sk;
			}
		}
		const trimmed = opts.trim ? trimSection(s.text, opts.trim) : null;
		if (trimmed === null) return s.text;
		trims++;
		return trimmed;
	};
	const rendered = renderCodemode(out, body);
	if (skeletons === 0 && trims === 0) return null;
	const n = out.sections.length;
	const parts = [skeletons ? `${skeletons} skeletonized` : "", trims ? `${trims} trimmed` : ""].filter(Boolean).join(" · ");
	const header = `⟨codemode · ${n} section${n === 1 ? "" : "s"} · ${parts} · recall for the full output⟩`;
	return { content: `${header}\n${rendered}`, sections: n, skeletons, trims };
}
