import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Truth } from "../../core/truth";
import type { Block } from "../../core/types";
import type { ActiveConductorMeta, WireCommand } from "../../core/protocol";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AccordionTuiHost } from "./host";
import { openAccordionPanel } from "./panel";

function block(id: string, order: number): Block {
	return { id, order, kind: "text", turn: 1, text: `content ${id}`, tokens: 20, override: null, autoFolded: false, by: null };
}

function setup(delayed = false) {
	const truth = new Truth({ meta: { format: "pi", title: "test", cwd: "", model: "" }, blocks: [block("a", 0), block("b", 1)], lineCount: 0, skipped: 0 });
	const commands: WireCommand[] = [];
	let listener = () => {};
	let disposed = false;
	let refuse = false;
	let steering = true;
	let renders = 0;
	let resolveCommand = () => {};
	const conductor: ActiveConductorMeta = { id: "exclusive", label: "Exclusive", locks: ["human-steering"], tailTokens: 0, holdWireUpToMs: 0, remote: false, readiness: { state: "ready" } };
	const host: AccordionTuiHost = {
		truth: () => truth, folding: () => false,
		conductors: () => [conductor],
		activeConductor: () => null,
		canSteer: () => steering,
		command: (cmd) => {
			commands.push(cmd);
			const result = refuse ? { results: [], rev: truth.rev, refused: "read-only" as const } : cmd.kind === "ops" ? truth.apply(cmd.ops, "you") : { results: [], rev: truth.rev };
			return delayed ? new Promise((resolve) => { resolveCommand = () => resolve(result); }) : result;
		},
		subscribe: (fn) => { listener = fn; return () => { disposed = true; }; },
	};
	let component: { handleInput(data: string): void; render(width: number): string[]; dispose?(): void } | undefined;
	let finish = () => {};
	const ctx = { mode: "tui", hasUI: true, ui: { custom: (factory: Function) => new Promise<void>((resolve) => {
		finish = resolve;
		component = factory({ terminal: { rows: 24 }, requestRender() { renders++; } }, { fg: (_: string, value: string) => value, bold: (value: string) => value }, { matches: (data: string, action: string) => ({ "tui.select.up": "up", "tui.select.down": "down", "tui.select.cancel": "esc", "tui.select.confirm": "enter" } as Record<string, string>)[action] === data }, resolve);
	}) } } as unknown as ExtensionContext;
	const opening = openAccordionPanel(ctx, host);
	if (!component) throw new Error("panel did not open");
	return { truth, conductor, commands, panel: component, opening, close: () => { component?.dispose?.(); finish(); }, update: () => listener(), setRefuse: () => { refuse = true; }, loseControl: () => { steering = false; listener(); }, disposed: () => disposed, renders: () => renders, resolveCommand: () => resolveCommand() };
}

describe("accordion panel", () => {
	test("targets selected block and displays protected refusal", async () => {
		const s = setup();
		s.panel.handleInput("down");
		s.panel.handleInput("\u001b[102;1u");
		await Promise.resolve();
		expect(s.commands).toEqual([{ kind: "ops", ops: [{ kind: "fold", ids: ["b"] }] }]);
		expect(s.panel.render(100).join("\n")).toContain("Refused: b: protected");
		s.close(); await s.opening;
		expect(s.disposed()).toBe(true);
	});

	test("requires explicit consent naming exclusive locks", async () => {
		const s = setup();
		s.panel.handleInput("c");
		s.panel.handleInput("down");
		s.panel.handleInput("enter");
		expect(s.commands).toEqual([]);
		expect(s.panel.render(100).join("\n")).toContain("human-steering");
		s.panel.handleInput("enter");
		expect(s.commands).toEqual([{ kind: "selectConductor", id: "exclusive" }]);
		s.close(); await s.opening;
	});

	test("creates a group from the selected contiguous range", async () => {
		const s = setup();
		s.truth.setProtect(0);
		s.panel.handleInput("r"); s.panel.handleInput("down"); s.panel.handleInput("g");
		await Promise.resolve();
		expect(s.commands).toEqual([{ kind: "ops", ops: [{ kind: "group", ids: ["a", "b"] }] }]);
		expect(s.truth.groups).toHaveLength(1);
		s.panel.handleInput("x");
		expect(s.commands[1]).toEqual({ kind: "ops", ops: [{ kind: "unfoldGroup", groupId: s.truth.groups[0].id }] });
		s.close(); await s.opening;
	});

	test("inspects original and folded digest separately", async () => {
		const s = setup();
		s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.panel.handleInput("enter");
		expect(s.panel.render(100).join("\n")).toContain("content a");
		s.panel.handleInput("v");
		expect(s.panel.render(100).join("\n")).toContain("FOLDED");
		s.close(); await s.opening;
	});

	test("does not attach when the requested locks change after consent is shown", async () => {
		const s = setup();
		s.panel.handleInput("c"); s.panel.handleInput("down"); s.panel.handleInput("enter");
		s.conductor.locks.push("tail-size");
		s.panel.handleInput("enter");
		expect(s.commands).toEqual([]);
		expect(s.panel.render(100).join("\n")).toContain("locks changed");
		s.close(); await s.opening;
	});

	test("renders bounded and sanitized text and responds to host updates", async () => {
		const s = setup();
		s.truth.blocks[0].text = "wide 界 \u001b]0;unsafe\u0007 text";
		for (const width of [20, 36, 57, 80, 140]) {
			const lines = s.panel.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.join("")).not.toContain("\u001b]");
			expect(lines.join("")).not.toContain("\u0007");
		}
		const before = s.renders(); s.update();
		expect(s.renders()).toBe(before + 1);
		s.close(); await s.opening;
	});

	test("does not open custom UI in headless mode", async () => {
		const s = setup();
		let called = false;
		const ctx = { mode: "rpc", hasUI: true, ui: { custom: () => { called = true; } } } as unknown as ExtensionContext;
		await openAccordionPanel(ctx, { truth: () => s.truth } as AccordionTuiHost);
		expect(called).toBe(false);
		s.close(); await s.opening;
	});

	test("awaits asynchronous command results and blocks concurrent mutations", async () => {
		const s = setup(true);
		s.setRefuse();
		s.panel.handleInput("o"); s.panel.handleInput("o");
		expect(s.commands).toHaveLength(1);
		expect(s.panel.render(100).join("\n")).toContain("pending");
		s.resolveCommand(); await Promise.resolve();
		expect(s.panel.render(100).join("\n")).toContain("read-only");
		s.close(); await s.opening;
	});

	test("ignores a delayed response after disposal", async () => {
		const s = setup(true);
		s.panel.handleInput("o");
		s.close(); await s.opening;
		const before = s.renders();
		s.resolveCommand(); await Promise.resolve();
		expect(s.renders()).toBe(before);
		expect(s.disposed()).toBe(true);
	});

	test("reports loss of controller ownership before another command", async () => {
		const s = setup();
		s.loseControl();
		expect(s.panel.render(100).join("\n")).toContain("READ-ONLY");
		expect(s.commands).toEqual([]);
		s.close(); await s.opening;
	});

	test("surfaces loss of control for non-op commands", async () => {
		const s = setup(); s.setRefuse();
		s.panel.handleInput("o");
		await Promise.resolve();
		expect(s.panel.render(120).join("\n")).toContain("read-only");
		expect(s.panel.render(120).join("\n")).toContain("reopen /accordion");
		s.panel.handleInput("down");
		expect(s.panel.render(36).join("\n")).toContain("reopen /accordion");
		s.close(); await s.opening;
	});
});
