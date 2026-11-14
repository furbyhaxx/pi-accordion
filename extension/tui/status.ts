/** Footer status and alert policy for the active conductor, shared by the extension and the panel. */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth } from "./chrome";
import type { FoldTiming } from "../../core/conductor/contract";

/** How a conductor status should be presented. */
export type StatusLevel = "info" | "warning" | "error";

type Metrics = Readonly<Record<string, number | string | boolean>> | undefined;

/** A status's level from its `level` metric; anything else is plain information. */
export function statusLevel(metrics: Metrics): StatusLevel {
	const level = metrics?.["level"];
	return level === "warning" || level === "error" ? level : "info";
}

/** Inputs for the one-line footer status. */
export interface FooterState {
	folding: boolean;
	conductor: string | null;
	/** The conductor's registry id, used by the compact form. */
	conductorId?: string | null;
	/** Current Taskfold timing; absent for other conductors. */
	timing?: FoldTiming | null;
	statusText: string | null;
	level: StatusLevel;
	/** Live tokens and the budget they are measured against, when both are known. */
	usage?: { live: number; budget: number } | null;
}

/** `28%` when a budget is set, else null. */
export function usagePercent(usage: { live: number; budget: number } | null | undefined): string | null {
	if (!usage || !(usage.budget > 0)) return null;
	return `${Math.round((100 * usage.live) / usage.budget)}%`;
}

/** `✓`, `▲` or `✗` for a status level. */
export function levelGlyph(level: StatusLevel): string {
	return level === "error" ? "✗" : level === "warning" ? "▲" : "✓";
}

/**
 * The footer text, at most `max` columns wide: `accordion <usage%> · <conductor> · [timing] · <status>`.
 * Too wide: the status text goes first, then the timing, then the line becomes
 * `acc <usage%> · <conductor id> <✓|▲|✗>`. A warning or error level always shows its glyph.
 */
export function footerText(state: FooterState, max = 72): string {
	if (!state.folding) return "accordion off";
	const usage = usagePercent(state.usage);
	const degraded = state.level !== "info";
	const lead = `${degraded ? `${levelGlyph(state.level)} ` : ""}${usage ? `accordion ${usage}` : "accordion"}`;
	const status = state.statusText?.replace(/\s+/g, " ").trim();
	const base = [lead, state.conductor ?? "no conductor"];
	const tries = [[...base, ...(state.timing ? [state.timing] : []), ...(status ? [status] : [])], [...base, ...(state.timing ? [state.timing] : [])], base];
	for (const parts of tries) {
		const text = parts.join(" · ");
		if (visibleWidth(text) <= max) return text;
	}
	const compact = `${usage ? `acc ${usage}` : "acc"} · ${state.conductorId ?? state.conductor ?? "no conductor"} ${levelGlyph(state.level)}`;
	return cutToWidth(compact, max);
}

/**
 * Decides when a degraded status deserves a notification: when a conductor enters a warning or
 * error state, or escalates from warning to error. Status text alone changes on every epoch, so it
 * never re-triggers; only recovery to plain information re-arms the gate.
 */
export class AlertGate {
	private last: string | null = null;

	/** The message to notify now, or null. */
	next(conductor: string | null, text: string | null, level: StatusLevel): { text: string; level: "warning" | "error" } | null {
		if (level === "info" || !text) {
			this.last = null;
			return null;
		}
		const key = `${conductor ?? ""}|${level}`;
		if (key === this.last) return null;
		this.last = key;
		return { text: `${conductor ?? "Conductor"}: ${text}`, level };
	}
}
