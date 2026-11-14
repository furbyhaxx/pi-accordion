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
	});

	test("fits the footer by dropping status, then timing, then compacting; level glyph stays", () => {
		const state = { folding: true, conductor: "Thermocline", conductorId: "thermocline", timing: "lazy" as const, statusText: "HOLD 82% · 12 folded · 3 strata · probe off (age fallback)", level: "warning" as const, usage: { live: 82000, budget: 100000 } };
		expect(footerText(state, 140)).toBe("▲ accordion 82% · Thermocline · lazy · HOLD 82% · 12 folded · 3 strata · probe off (age fallback)");
		expect(footerText(state, 80)).toBe("▲ accordion 82% · Thermocline · lazy");
		expect(footerText(state, 57)).toBe("▲ accordion 82% · Thermocline · lazy");
		expect(footerText(state, 36)).toBe("▲ accordion 82% · Thermocline · lazy");
		expect(footerText(state, 30)).toBe("▲ accordion 82% · Thermocline");
		expect(footerText(state, 24)).toBe("acc 82% · thermocline ▲");
		expect(footerText({ ...state, level: "info", statusText: null, timing: null, conductor: "Taskfold", conductorId: "taskfold", usage: { live: 28000, budget: 100000 } }, 23)).toBe("acc 28% · taskfold ✓");
		expect(footerText({ ...state, level: "error" }, 12)).toBe("acc 82% · t…");
		expect(footerText({ ...state, usage: null, level: "error" }, 20)).toBe("acc · thermocline ✗");
	});

	test("measures display width and never splits a character", () => {
		const state = { folding: true, conductor: "Taskfold", statusText: "任务 😀😀😀😀😀", level: "info" as const };
		expect(footerText(state, 40)).toBe("accordion · Taskfold · 任务 😀😀😀😀😀");
		expect(footerText(state, 22)).toBe("accordion · Taskfold");
		expect(footerText(state, 11)).toBe("acc · Task…");
		expect(footerText({ ...state, conductor: "😀😀😀😀😀😀😀😀" }, 9)).toBe("acc · 😀…");
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
