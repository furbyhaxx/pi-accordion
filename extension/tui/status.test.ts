import { describe, expect, test } from "bun:test";
import { AlertGate, footerText, statusLevel } from "./status.ts";

describe("conductor status presentation", () => {
	test("reads the level metric and renders a bounded footer", () => {
		expect(statusLevel({ level: "warning" })).toBe("warning");
		expect(statusLevel({ level: "loud" })).toBe("info");
		expect(statusLevel(undefined)).toBe("info");
		expect(footerText({ folding: false, conductor: "Keel-lite", statusText: "epoch 3", level: "info" })).toBe("accordion off");
		expect(footerText({ folding: true, conductor: null, statusText: null, level: "info" })).toBe("accordion · no conductor");
		expect(footerText({ folding: true, conductor: "Taskfold", timing: "lazy", statusText: "held", level: "info" })).toBe("accordion · Taskfold · lazy · held");
		expect(footerText({ folding: true, conductor: "Taskfold", statusText: null, level: "info", usage: { live: 28000, budget: 100000 } })).toBe("accordion 28% · Taskfold");
		expect(footerText({ folding: true, conductor: "Taskfold", statusText: null, level: "info", usage: { live: 10, budget: 0 } })).toBe("accordion · Taskfold");
		expect(footerText({ folding: false, conductor: "Taskfold", timing: "pressure", statusText: null, level: "info" })).toBe("accordion off");
		const long = footerText({ folding: true, conductor: "Thermocline", statusText: "HOLD 82% · 12 folded · 3 strata\n· probe off (age fallback)", level: "warning" }, 40);
		expect(long).toHaveLength(40);
		expect(long.endsWith("…")).toBe(true);
	});

	test("alerts once per degraded episode and on escalation, not on changing text", () => {
		const gate = new AlertGate();
		expect(gate.next("Thermocline", "HOLD 81% · probe off", "warning")).toEqual({ text: "Thermocline: HOLD 81% · probe off", level: "warning" });
		expect(gate.next("Thermocline", "HOLD 84% · probe off", "warning")).toBeNull();
		expect(gate.next("Thermocline", "process exited", "error")?.level).toBe("error");
		expect(gate.next("Thermocline", "HOLD 70%", "info")).toBeNull();
		expect(gate.next("Thermocline", "HOLD 85% · probe off", "warning")).not.toBeNull();
	});
});
