import type { Truth } from "../../core/truth";
import type { ActiveConductorMeta, WireCommand } from "../../core/protocol";
import type { OpResult } from "../../core/ops";

export interface AccordionTuiHost {
	truth(): Truth | null;
	sessionLabel?(): string;
	folding(): boolean;
	conductors(): ActiveConductorMeta[];
	activeConductor(): ActiveConductorMeta | null;
	canSteer?(): boolean;
	controlMessage?(): string | null;
	command(command: WireCommand): { results: OpResult[]; rev: number; refused?: "read-only" } | Promise<{ results: OpResult[]; rev: number; refused?: "read-only" }>;
	subscribe(listener: () => void): () => void;
}
