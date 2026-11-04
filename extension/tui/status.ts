/** Footer status and alert policy for the active conductor, shared by the extension and the panel. */

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
	statusText: string | null;
	level: StatusLevel;
}

/** The footer text, trimmed to `max` columns: `accordion · <conductor> · <status>`. */
export function footerText(state: FooterState, max = 72): string {
	if (!state.folding) return "accordion off";
	const parts = ["accordion", state.conductor ?? "no conductor"];
	const status = state.statusText?.replace(/\s+/g, " ").trim();
	if (status) parts.push(status);
	const text = parts.join(" · ");
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
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
