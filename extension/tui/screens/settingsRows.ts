import { ENTRIES } from "../../../core/conductor/registry";
import { FOLD_TIMINGS } from "../../../core/conductor/contract";
import type { SettingPath } from "../../settingsValidation";

export interface SettingsRow {
	path: SettingPath;
	section: string;
	label: string;
	description: string;
	kind: "toggle" | "choice" | "number" | "text" | "list" | "conductor" | "model" | "add-pattern" | "privacy";
	/** For `add-pattern`: the map a new key is created in. */
	addPrefix?: "modelDefaults" | "calibration.priors";
	choices?: readonly (string | undefined)[];
	defaultValue?: number | boolean;
}

/** Calibration priors, one editable row per pattern plus an inline way to add one. */
export function calibrationPriorRows(patterns: readonly string[]): SettingsRow[] {
	return [
		{ section: "Calibration", path: "calibration.priors.*", label: "Add prior pattern…", kind: "add-pattern", addPrefix: "calibration.priors",
			description: "Add a model, family, provider or * pattern; then set its multiplier." },
		...patterns.map((pattern): SettingsRow => ({
			section: `Calibration · ${pattern}`, path: `calibration.priors.${pattern}`, label: "Prior multiplier", kind: "number",
			description: `Estimate multiplier for ${pattern} until a provider receipt lands.`,
		})),
	];
}

export function modelDefaultRows(patterns: readonly string[]): SettingsRow[] {
	return [
		{ section: "Budget & tail", path: "modelDefaults.*.budget", label: "Add model pattern…", kind: "add-pattern", description: "Add *, provider/* or provider/model; then set its budget, protected tail or fold timing." },
		...patterns.flatMap((pattern): SettingsRow[] => [
			{ section: `Budget & tail · ${pattern}`, path: `modelDefaults.${pattern}.budget`, label: "Default budget", kind: "text", description: `Budget for ${pattern}; empty removes this value.` },
			{ section: `Budget & tail · ${pattern}`, path: `modelDefaults.${pattern}.protect`, label: "Default tail", kind: "text", description: `Protected tail for ${pattern}; empty removes this value.` },
			{ section: `Budget & tail · ${pattern}`, path: `modelDefaults.${pattern}.timing`, label: "Default timing", kind: "choice", choices: [undefined, ...FOLD_TIMINGS], description: `Taskfold timing for ${pattern}; inherited falls back to the global setting.` },
		]),
	];
}

export function modelRouteRows(conductors: readonly { id: string; label: string }[]): SettingsRow[] {
	return conductors.flatMap(({ id, label }): SettingsRow[] => [
		{ section: `Models · ${label}`, path: `models.conductors.${id}.chat`, label: "Chat override", kind: "model", description: `Chat model for ${label}; unset uses the default route.` },
		{ section: `Models · ${label}`, path: `models.conductors.${id}.classifier`, label: "Classifier override", kind: "model", description: `Classifier model for ${label}; unset uses the default route.` },
	]);
}

export function privacyRows(keys: readonly string[]): SettingsRow[] {
	return keys.map((key) => ({ section: "Privacy", path: `privacyConsent.${key}`, label: key, kind: "privacy",
		description: `Consent ${key} is stored. Revoking it applies immediately and can detach an affected conductor.` }));
}

export const SETTINGS_ROWS: readonly SettingsRow[] = [
	{ section: "Defaults · all sessions", path: "autoArm", label: "Arm on startup", kind: "toggle", description: "Arm folding when a new session starts." },
	{ section: "Defaults · all sessions", path: "defaultConductor", label: "Default conductor", kind: "conductor", description: "Conductor attached when a session starts armed." },
	{ section: "Defaults · all sessions", path: "debug", label: "Debug log", kind: "toggle", description: "Write private session diagnostics; the session override takes precedence." },
	{ section: "Compaction", path: "compact.manual", label: "/compact behavior", kind: "choice", choices: ["pass", "aggressive", "bake", "native"], description: "Strategy for manual compaction when folding is armed." },
	{ section: "Compaction", path: "compact.threshold", label: "Threshold compact", kind: "choice", choices: ["pass", "native"], description: "Strategy for threshold-triggered compaction." },
	{ section: "Compaction", path: "compact.onSaturated", label: "When saturated", kind: "choice", choices: ["native", "bake", "warn"], description: "What to do if Accordion cannot reduce the context enough." },
	{ section: "Models", path: "models.defaults.chat", label: "Chat model", kind: "model", description: "Default model for out-of-band chat; unset uses the session model." },
	{ section: "Models", path: "models.defaults.classifier", label: "Classifier model", kind: "model", description: "Default classifier for structured out-of-band calls." },
	{ section: "Taskfold", path: "taskfold.timing", label: "Task fold timing", kind: "choice", choices: FOLD_TIMINGS, description: "Choose eager, cold-cache or pressure-triggered task folding." },
	{ section: "Taskfold", path: "taskfold.leafForm", label: "Leaf form", kind: "choice", choices: ["record", "bracket"], description: "Choose task record or recoverable bracket folds." },
	{ section: "Taskfold", path: "taskfold.recordTokens", label: "Record token limit", kind: "number", description: "Maximum estimated tokens in a task record." },
	{ section: "Taskfold", path: "taskfold.floor", label: "Pressure floor", kind: "toggle", description: "Allow the opt-in pressure floor for open and untracked work." },
	{ section: "Taskfold", path: "taskfold.untracked.enabled", label: "Untracked folding", kind: "toggle", description: "Allow folding of work outside task spans." },
	{ section: "Taskfold", path: "taskfold.untracked.minTokens", label: "Untracked min tokens", kind: "number", description: "Minimum tokens reclaimed by a warm-cache untracked fold." },
	{ section: "Taskfold", path: "taskfold.steps.enabled", label: "Open task folding", kind: "toggle", description: "Allow pressure folding of steps within an open task." },
	{ section: "Taskfold", path: "taskfold.steps.minSteps", label: "Open task min steps", kind: "number", description: "Minimum steps in an open-task fold." },
	...ENTRIES.flatMap((entry): SettingsRow[] => (entry.options ?? []).map((option) => ({
		section: `Conductor: ${entry.label}`, path: `conductorOptions.${entry.id}.${option.key}`,
		label: option.label, description: option.description, kind: option.type === "boolean" ? "toggle" : "number", defaultValue: option.default,
	}))),
	{ section: "Task widget", path: "taskWidget.mode", label: "Widget mode", kind: "choice", choices: ["auto", "off"], description: "Show the task widget automatically, or keep it off." },
	{ section: "Task widget", path: "taskWidget.expanded", label: "Widget expanded", kind: "toggle", description: "Initial expanded state for new sessions." },
	{ section: "Task widget", path: "taskWidget.maxRows", label: "Widget max rows", kind: "number", description: "Maximum expanded widget height; applies immediately." },
	{ section: "Task widget", path: "taskWidget.toggleKey", label: "Widget shortcut", kind: "text", description: "Key binding used to toggle the widget; applies at the next Pi start." },
	{ section: "Tasks", path: "tasks.adopt", label: "Resume adoption", kind: "choice", choices: ["auto", "ask", "off"], description: "How sessions adopt a task list on resume." },
	{ section: "Tasks", path: "tasks.attachments.render", label: "Attachment render", kind: "choice", choices: ["inline", "reference"], description: "How task attachments are delivered." },
	{ section: "Tasks", path: "tasks.attachments.maxLines", label: "Attachment max lines", kind: "number", description: "Maximum lines in a resolved attachment." },
	{ section: "Tasks", path: "tasks.attachments.roots", label: "Attachment roots", kind: "list", description: "JSON array of allowed absolute directories outside the project." },
	{ section: "Tasks", path: "tasks.pins.listTokens", label: "List pin tokens", kind: "number", description: "Token budget for list-level pins." },
	{ section: "Tasks", path: "tasks.pins.taskTokens", label: "Task pin tokens", kind: "number", description: "Token budget for task-level pins." },
	{ section: "Tasks", path: "tasks.enforce", label: "Enforcement", kind: "choice", choices: ["coach", "gate", "off"], description: "Remind (coach), refuse calls outside the protocol (gate), or observe only (off)." },
	{ section: "Tasks", path: "tasks.orientationCalls", label: "Orientation calls", kind: "number", description: "Non-exempt tool calls allowed before the first task starts." },
	{ section: "Tasks", path: "tasks.gateFailOpenAfter", label: "Gate fail-open", kind: "number", description: "Consecutive refusals before the gate stops blocking; it always says when it does." },
	{ section: "Tasks", path: "tasks.stopOnBlock", label: "Stop on block", kind: "toggle", description: "A block ends the run; off lets later leaves run while the blocked interval stays closed." },
	{ section: "Tasks", path: "tasks.resumeOnStop", label: "Resume on stop", kind: "toggle", description: "Offer at most one follow-up after a stop, never after an abort." },
	{ section: "Tasks", path: "tasks.bootstrapNote", label: "Bootstrap note", kind: "toggle", description: "Point a fresh session at its claimed list once, from the first prompt." },
	{ section: "Tasks", path: "tasks.largeLeaf.budgetShare", label: "Large leaf budget share", kind: "number", description: "Fraction of the budget after which a leaf is reminded to split." },
	{ section: "Tasks", path: "tasks.largeLeaf.toolResults", label: "Large leaf tool results", kind: "number", description: "Tool results inside one leaf that trigger the reminder." },
	{ section: "Tasks", path: "tasks.largeLeaf.repeatEvery", label: "Large leaf repeat", kind: "number", description: "Tool results between repeats of the reminder." },
	{ section: "Tasks", path: "tasks.acceptanceCriteria.required", label: "Criteria required", kind: "toggle", description: "Leaves need checkable acceptance criteria." },
	{ section: "Tasks", path: "tasks.acceptanceCriteria.min", label: "Criteria minimum", kind: "number", description: "Fewest criteria a leaf may carry." },
	{ section: "Tasks", path: "tasks.acceptanceCriteria.max", label: "Criteria maximum", kind: "number", description: "Most criteria a leaf may carry." },
	{ section: "Tasks", path: "tasks.acceptanceCriteria.maxChars", label: "Criteria max chars", kind: "number", description: "Longest single criterion." },
	{ section: "Recall", path: "recall.ledger.maxCalls", label: "Fact extraction calls", kind: "number", description: "Maximum fact extraction model calls per session process." },
	{ section: "Web UI", path: "bindHost", label: "Web UI address", kind: "text", description: "Address the web UI listens on; non-loopback addresses may be reachable from the network." },
	{ section: "Web UI", path: "doorPort", label: "Web UI door port", kind: "number", description: "Fixed port shared by sessions; 0 disables it." },
	{ section: "Web UI", path: "customToken", label: "Web access token", kind: "text", description: "3–64 URL-safe characters; empty uses a generated token." },
	{ section: "Calibration", path: "calibration.minRatio", label: "Minimum ratio", kind: "number", description: "Receipts below this multiple of the estimate are treated as a bad pairing and do not move the multiplier." },
	{ section: "Calibration", path: "calibration.maxRatio", label: "Maximum ratio", kind: "text", description: "Optional ceiling; empty means none, because CJK and emoji content legitimately reaches high ratios." },
	{ section: "Calibration", path: "calibration.dedupeCacheWrite", label: "De-duplicate cache writes", kind: "toggle", description: "Drop the cache write Anthropic reports again as input on a cache epoch's first request." },
];
