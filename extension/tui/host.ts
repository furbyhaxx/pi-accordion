import type { Truth } from "../../core/truth";
import type { ActiveConductorMeta, WireCommand } from "../../core/protocol";
import type { OpResult } from "../../core/ops";
import type { SessionEntry } from "../../app/src/lib/live/registry";
import type { AccordionSettings } from "../settings";

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
	webInfo?(): AccordionWebInfo;
	settings?(): AccordionSettings;
	updateSettings?(patch: Partial<AccordionSettings>): AccordionSettings | Promise<AccordionSettings>;
	regenerateToken?(): string;
	compactNow?(): { beforeTokens: number; afterTokens: number; message: string } | Promise<{ beforeTokens: number; afterTokens: number; message: string }>;
	listSessions?(): Promise<SessionEntry[]>;
	command(command: WireCommand): { results: OpResult[]; rev: number; refused?: "read-only" } | Promise<{ results: OpResult[]; rev: number; refused?: "read-only" }>;
	subscribe(listener: () => void): () => void;
}
