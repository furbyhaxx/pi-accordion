import type { Truth } from "../../core/truth";
import type { ActiveConductorMeta, WireCommand } from "../../core/protocol";
import type { OpResult } from "../../core/ops";
import type { SessionEntry } from "../../app/src/lib/live/registry";
import type { SettingsSnapshot, SettingsSaveResult } from "../settingsStore";
import type { SettingsPatch } from "../settingsValidation";
import type { NumericDialKind, ResolvedDials } from "../dials";
import type { TaskTabsHost } from "./screens/tasks";

export interface AccordionWebInfo {
	url: string | null;
	bindHost: string;
	port: number;
	doorPort: number | null;
	token: string;
	clients: number;
}

export interface AccordionConductorStatus {
	text: string | null;
	metrics?: Record<string, number | string | boolean>;
}

export interface AccordionTuiHost {
	truth(): Truth | null;
	sessionLabel?(): string;
	sessionId?(): string;
	folding(): boolean;
	conductors(): ActiveConductorMeta[];
	activeConductor(): ActiveConductorMeta | null;
	conductorStatus?(): AccordionConductorStatus | null;
	canSteer?(): boolean;
	controlMessage?(): string | null;
	supportsConditionalOps?(): boolean;
	/** The session's thinking level; the panel's rules take the editor border color for it. */
	thinkingLevel?(): string | null;
	webInfo?(): AccordionWebInfo;
	settings?(): SettingsSnapshot;
	updateSettings?(patch: SettingsPatch, baseRev: string): SettingsSaveResult | Promise<SettingsSaveResult>;
	regenerateToken?(): string | Promise<string>;
	/** Budget and tail as resolved for this session's model, with where each value comes from. */
	dials?(): (ResolvedDials & { model: string | null }) | null;
	/** Save a budget or tail as the default for this session's model; returns a status message. */
	saveDialDefault?(kind: NumericDialKind, value: number): string | Promise<string>;
	compactNow?(): { beforeTokens: number; afterTokens: number; message: string } | Promise<{ beforeTokens: number; afterTokens: number; message: string }>;
	listSessions?(): Promise<SessionEntry[]>;
	/** Task data for the Tasks and Lists tabs; absent for a remote session. */
	tasks?: TaskTabsHost;
	command(command: WireCommand): { results: OpResult[]; rev: number; refused?: "read-only" } | Promise<{ results: OpResult[]; rev: number; refused?: "read-only" }>;
	subscribe(listener: () => void): () => void;
}
