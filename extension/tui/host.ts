import type { Truth } from "../../core/truth";
import type { ActiveConductorMeta, WireCommand } from "../../core/protocol";
import type { OpResult } from "../../core/ops";

export interface AccordionTuiHost {
	truth(): Truth | null;
	folding(): boolean;
	conductors(): ActiveConductorMeta[];
	activeConductor(): ActiveConductorMeta | null;
	command(command: WireCommand): { results: OpResult[]; rev: number };
	subscribe(listener: () => void): () => void;
}
