import { ENTRIES } from "../../../core/conductor/registry";
import { FOLD_TIMINGS } from "../../../core/conductor/contract";
import type { SettingPath } from "../../settingsValidation";

export interface SettingsRow {
	path: SettingPath;
	section: string;
	label: string;
	description: string;
	kind: "toggle" | "choice" | "number" | "text" | "list" | "conductor" | "model";
	choices?: readonly string[];
	defaultValue?: number | boolean;
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
	{ section: "Taskfold", path: "taskfold.untracked.enabled", label: "Untracked folding", kind: "toggle", description: "Allow pressure folding of work outside task spans." },
	{ section: "Taskfold", path: "taskfold.untracked.minSteps", label: "Untracked min steps", kind: "number", description: "Minimum steps in an untracked fold." },
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
	{ section: "Web UI", path: "bindHost", label: "Web UI address", kind: "text", description: "Address the web UI listens on; non-loopback addresses may be reachable from the network." },
	{ section: "Web UI", path: "doorPort", label: "Web UI door port", kind: "number", description: "Fixed port shared by sessions; 0 disables it." },
	{ section: "Web UI", path: "customToken", label: "Web access token", kind: "text", description: "3–64 URL-safe characters; empty uses a generated token." },
];
