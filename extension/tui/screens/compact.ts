import { formatTokens } from "../../dials";
import type { Shell } from "./types";

const STRATEGIES = ["pass", "aggressive", "bake", "native"] as const;

/** The `alt+c` preview (SPEC-0001 §7.6): strategies with their projections and an optional instructions line. */
export function openCompactPreview(shell: Shell): void {
	const { host } = shell;
	const compact = host.compact?.bind(host);
	if (!compact) return shell.say("Compaction is not available on this host");
	const preview = host.compactPreview?.() ?? null;
	const saved = (n: number | null, unknown: string) => (n === null ? unknown : n > 0 ? `−${formatTokens(n)}` : "nothing");
	const summary = (n: number | null) => (n === null ? "unknown" : `≈ ${formatTokens(n)} summary`);
	shell.confirm({
		crumb: "Compact",
		title: [
			"Compact the context now?",
			`pass         Taskfold decides              ${saved(preview?.pass ?? null, "conductor decides")}`,
			`aggressive   fold every eligible block     ${saved(preview?.aggressive ?? null, "unknown")}`,
			`bake         permanent summary, no recall  ${summary(preview?.bake ?? null)}`,
			`native       pi summarizes (model call)    unknown`,
		].join("\n"),
		options: [...STRATEGIES],
		input: "instructions",
		then: (choice, text) => {
			const strategy = choice === null ? undefined : STRATEGIES[choice];
			if (!strategy) return;
			const instructions = text.trim() || undefined;
			void shell.run(`Compacting (${strategy})…`, async () => (await compact(strategy, instructions)).message);
		},
	});
}
