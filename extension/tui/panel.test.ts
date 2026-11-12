import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Truth } from "../../core/truth";
import { foldTag } from "../../core/digest";
import type { Block } from "../../core/types";
import type { ActiveConductorMeta, WireCommand } from "../../core/protocol";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { AccordionTuiHost } from "./host";
import { CHROME_ROWS } from "./chrome";
import { openAccordionPanel, type PanelTabId } from "./panel";
import type { TaskTabsHost } from "./screens/tasks";
import type { TaskList } from "../tasks";
import { DEFAULT_SETTINGS } from "../settings";
import { settingPaths, validateSettingsPatch, type SettingsPatch } from "../settingsValidation";
import type { SettingsSaveResult, SettingsSnapshot } from "../settingsStore";

function block(id: string, order: number): Block {
	return { id, order, kind: "text", turn: 1, text: `content ${id}`, tokens: 20, override: null, autoFolded: false, by: null };
}

const BINDINGS: Record<string, string> = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.cancel": "escape", "tui.select.confirm": "enter", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown" };
const K = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z", f1: "\x1bOP", ctrlS: "\x13", ctrlC: "\x03", backspace: "\x7f", alt: (key: string) => `\x1b${key}` };
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup(delayed = false, start?: PanelTabId, tasks?: TaskTabsHost, terminalRows = 24) {
	const truth = new Truth({ meta: { format: "pi", title: "test", cwd: "", model: "" }, blocks: [block("a", 0), block("b", 1)], lineCount: 0, skipped: 0 });
	const commands: WireCommand[] = [];
	let currentTruth: Truth | null = truth;
	let listener = () => {};
	let disposed = false;
	let refuse = false;
	let steering = true;
	let renders = 0;
	let resolveCommand = () => {};
	let settingsRevision = 0;
	let settingsError: string | null = null;
	const saveRevisions: string[] = [];
	const sources = Object.fromEntries(settingPaths(DEFAULT_SETTINGS).map(name => [name, "default"])) as SettingsSnapshot["sources"];
	let settingsState = {
		...DEFAULT_SETTINGS,
		autoArm: true,
		defaultConductor: "keel-lite",
		bindHost: "127.0.0.1",
		doorPort: 24317,
		customToken: null as string | null,
	};
	let tokenState = "kave4ton";
	const conductor: ActiveConductorMeta = { id: "exclusive", label: "Exclusive", locks: ["human-steering"], tailTokens: 0, holdWireUpToMs: 0, remote: false, readiness: { state: "ready" } };
	const host: AccordionTuiHost = {
		truth: () => currentTruth, folding: () => false,
		conductors: () => [conductor, { ...conductor, id: "taskfold", label: "Taskfold" }],
		activeConductor: () => null,
		canSteer: () => steering,
		settings: () => ({ settings: settingsState, sources, rev: String(settingsRevision) }),
		updateSettings: (patch, baseRev): SettingsSaveResult => {
			saveRevisions.push(baseRev);
			if (settingsError) return { ok: false, error: settingsError, conflict: true };
			const { "taskfold.timing": timing, "compact.manual": manual, ...globals } = patch;
			Object.assign(settingsState, globals);
			if (timing === "eager" || timing === "lazy" || timing === "pressure") settingsState.taskfold = { ...settingsState.taskfold, timing };
			if (manual === "pass" || manual === "native" || manual === "bake" || manual === "aggressive") settingsState.compact = { ...settingsState.compact, manual };
			if (typeof patch.customToken === "string") tokenState = patch.customToken;
			settingsRevision++;
			return { ok: true, snapshot: { settings: settingsState, sources, rev: String(settingsRevision) } };
		},
		regenerateToken: () => {
			tokenState = "mira7pex";
			settingsState = { ...settingsState, customToken: null };
			return tokenState;
		},
		webInfo: () => ({
			url: `http://${settingsState.bindHost}:${settingsState.doorPort}/?token=${tokenState}`,
			bindHost: settingsState.bindHost,
			port: 41234,
			doorPort: settingsState.doorPort,
			token: tokenState,
			clients: 1,
		}),
		compactNow: () => ({ beforeTokens: 40, afterTokens: 20, message: "Accordion compacted context: 40 → 20 tok (−20 tok)" }),
		command: (cmd) => {
			commands.push(cmd);
			const result = refuse ? { results: [], rev: truth.rev, refused: "read-only" as const } : cmd.kind === "ops" ? truth.apply(cmd.ops, "you") : { results: [], rev: truth.rev };
			return delayed ? new Promise((resolve) => { resolveCommand = () => resolve(result); }) : result;
		},
		subscribe: (fn) => { listener = fn; return () => { disposed = true; }; },
		...(tasks ? { tasks } : {}),
	};
	let component: { handleInput(data: string): void; render(width: number): string[]; dispose?(): void } | undefined;
	let finish = () => {};
	let editorResult: string | undefined = "edited digest";
	let editorPrefill = "";
	let editorHook = () => {};
	let confirmResult = true;
	let confirmations: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: { custom: (factory: Function) => new Promise<unknown>((resolve) => {
		finish = () => { component?.dispose?.(); resolve(undefined); };
		component = factory({ terminal: { rows: terminalRows }, requestRender() { renders++; } }, { fg: (_: string, value: string) => value, bold: (value: string) => value, inverse: (value: string) => value }, { matches: (data: string, action: string) => matchesKey(data, BINDINGS[action] as Parameters<typeof matchesKey>[1]), getKeys: (action: string) => [BINDINGS[action]] }, (value: unknown) => { component?.dispose?.(); resolve(value); });
	}), editor: async (_title: string, prefill: string) => { editorPrefill = prefill; editorHook(); return editorResult; }, confirm: async (title: string, message: string) => { confirmations.push(`${title} ${message}`); return confirmResult; } } } as unknown as ExtensionContext;
	const opening = openAccordionPanel(ctx, host, start);
	if (!component) throw new Error("panel did not open");
	return { host, saveRevisions, failSettings: (message: string | null) => { settingsError = message; }, externalSettings: (patch: SettingsPatch) => { host.updateSettings!(patch, String(settingsRevision)); listener(); }, truth, conductor, commands, settings: () => settingsState, screen: (width = 100) => component!.render(width).join("\n"), cursor: (width = 100) => component!.render(width).find((line) => line.trimStart().startsWith("→")) ?? "", get panel() { if (!component) throw new Error("panel unavailable"); return component; }, opening, close: () => finish(), setEditor: (value: string | undefined) => { editorResult = value; }, onEditor: (fn: () => void) => { editorHook = fn; }, changeSession: () => { currentTruth = null; }, setConfirm: (value: boolean) => { confirmResult = value; }, confirmations: () => confirmations, editorPrefill: () => editorPrefill, update: () => listener(), setRefuse: () => { refuse = true; }, loseControl: () => { steering = false; listener(); }, disposed: () => disposed, renders: () => renders, resolveCommand: () => resolveCommand() };
}

function selectSetting(s: ReturnType<typeof setup>, label: string) {
	for (let i = 0; i < 100; i++) {
		if (s.cursor().includes(label)) return;
		s.panel.handleInput(K.down);
	}
	throw new Error(`Setting not found: ${label}`);
}

describe("accordion panel", () => {
	test("edits a folded block and retains its selection", async () => {
		const s = setup();
		s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["b"] }], "you");
		s.panel.handleInput(K.alt("v")); s.panel.handleInput(K.down); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.editorPrefill()).toContain("FOLDED");
		expect(s.commands).toEqual([{ kind: "ops", ops: [{ kind: "fold", ids: ["b"], digest: "edited digest" }], baseRev: expect.any(Number) }]);
		expect(s.cursor()).toContain(" b ");
		s.close(); await s.opening;
	});

	test("cancel leaves the digest untouched and keeps selection", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["b"] }], "you");
		s.setEditor(undefined); s.panel.handleInput(K.alt("v")); s.panel.handleInput(K.down); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.commands).toEqual([]);
		expect(s.cursor()).toContain(" b ");
		s.close(); await s.opening;
	});

	test("refuses an edit when truth changes while the editor is open", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.onEditor(() => s.truth.setBudget(1234)); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.commands).toEqual([]);
		expect(s.screen()).toContain("changed while editing; retry");
		s.onEditor(() => {}); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.editorPrefill()).toBe("edited digest");
		s.close(); await s.opening;
	});

	test("refuses an edit when the session disappears during editing", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.onEditor(s.changeSession); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.commands).toEqual([]);
		expect(s.screen()).toContain("changed while editing; retry");
		s.close(); await s.opening;
	});

	test("does not author an unchanged generated digest", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.setEditor(s.truth.digestOf(s.truth.blocks[0])); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.commands).toEqual([]);
		expect(s.screen()).toContain("No changes");
		s.close(); await s.opening;
	});

	test("uses the empty digest sentinel and restores the block default", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.setEditor("  "); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.commands[0]).toEqual({ kind: "ops", ops: [{ kind: "fold", ids: ["a"], digest: "{empty}" }], baseRev: expect.any(Number) });
		s.panel.handleInput(K.alt("r"));
		await tick();
		expect(s.commands[1]).toEqual({ kind: "ops", ops: [{ kind: "fold", ids: ["a"] }], baseRev: expect.any(Number) });
		expect(s.truth.digestOf(s.truth.blocks[0])).toContain("FOLDED");
		s.close(); await s.opening;
	});

	test("confirms a tag-only group drop and restores its default", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "group", ids: ["a", "b"] }], "you");
		const group = s.truth.groups[0];
		s.setEditor(foldTag(group.id));
		s.setConfirm(false); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.confirmations()[0]).toContain("removes group messages");
		expect(s.commands).toEqual([]);
		s.setConfirm(true); s.panel.handleInput(K.alt("e"));
		await tick(6);
		expect(s.commands[0]).toEqual({ kind: "ops", ops: [{ kind: "ungroup", groupId: group.id }, { kind: "group", ids: ["a", "b"], summary: null }], baseRev: expect.any(Number) });
		expect(s.truth.groups[0].digest).toBeNull();
		s.panel.handleInput(K.alt("r"));
		await tick();
		expect(s.commands[1]).toEqual({ kind: "ops", ops: [{ kind: "ungroup", groupId: group.id }, { kind: "group", ids: ["a", "b"] }], baseRev: expect.any(Number) });
		expect(s.truth.groupSummary(s.truth.groups[0])).toContain("FOLDED");
		s.close(); await s.opening;
	});

	test("awaits an asynchronous digest command and reports refusal", async () => {
		const s = setup(true); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.setRefuse(); s.panel.handleInput(K.alt("e"));
		await tick(3);
		expect(s.commands).toHaveLength(1);
		s.resolveCommand();
		await tick();
		expect(s.screen()).toContain("read-only");
		s.close(); await s.opening;
	});

	test("surfaces a lock clamp on a digest edit", async () => {
		const s = setup(); s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "auto");
		s.truth.setLocks(["human-steering"], "conductor"); s.panel.handleInput(K.alt("e"));
		await tick();
		expect(s.screen()).toContain("locked");
		s.close(); await s.opening;
	});

	test("navigates the context map and switches to the list", async () => {
		const s = setup();
		expect(s.screen(36)).toContain("[A1P]");
		s.panel.handleInput(K.right);
		expect(s.screen(36)).toContain("[A1P]");
		s.panel.handleInput(K.alt("f"));
		await tick(1);
		expect(s.commands[0]).toEqual({ kind: "ops", ops: [{ kind: "fold", ids: ["b"] }] });
		s.panel.handleInput(K.alt("v"));
		expect(s.cursor()).toContain(" b ");
		s.close(); await s.opening;
	});

	test("targets selected block and displays protected refusal", async () => {
		const s = setup();
		s.panel.handleInput(K.alt("v")); s.panel.handleInput(K.down);
		s.panel.handleInput(K.alt("f"));
		await tick(1);
		expect(s.commands).toEqual([{ kind: "ops", ops: [{ kind: "fold", ids: ["b"] }] }]);
		expect(s.screen()).toContain("▲ Refused: b: protected");
		s.close(); await s.opening;
		expect(s.disposed()).toBe(true);
	});

	test("requires explicit consent naming exclusive locks, with the safe choice first", async () => {
		const s = setup();
		s.panel.handleInput(K.tab); s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		expect(s.commands).toEqual([]);
		expect(s.screen()).toContain("human-steering");
		expect(s.cursor()).toContain("Cancel");
		s.panel.handleInput(K.enter);
		expect(s.commands).toEqual([]);
		s.panel.handleInput(K.enter); s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		expect(s.commands).toEqual([{ kind: "selectConductor", id: "exclusive" }]);
		s.close(); await s.opening;
	});

	test("creates a group from the selected range and asks before deleting it", async () => {
		const s = setup();
		s.truth.setProtect(0);
		s.panel.handleInput(K.alt("v")); s.panel.handleInput(K.alt("m")); s.panel.handleInput(K.down); s.panel.handleInput(K.alt("n"));
		await tick(1);
		expect(s.commands).toEqual([{ kind: "ops", ops: [{ kind: "group", ids: ["a", "b"] }] }]);
		expect(s.truth.groups).toHaveLength(1);
		const groupId = s.truth.groups[0].id;
		s.panel.handleInput(K.alt("g"));
		await tick(1);
		expect(s.commands[1]).toEqual({ kind: "ops", ops: [{ kind: "unfoldGroup", groupId }] });
		s.panel.handleInput(K.alt("d"));
		expect(s.cursor()).toContain("Keep group");
		s.panel.handleInput(K.enter);
		expect(s.commands).toHaveLength(2);
		s.panel.handleInput(K.alt("d")); s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		await tick(1);
		expect(s.commands[2]).toEqual({ kind: "ops", ops: [{ kind: "ungroup", groupId }] });
		s.close(); await s.opening;
	});

	test("inspects original and folded digest separately", async () => {
		const s = setup();
		s.truth.setProtect(0);
		s.truth.apply([{ kind: "fold", ids: ["a"] }], "you");
		s.panel.handleInput(K.enter);
		expect(s.screen()).toContain("content a");
		expect(s.screen()).toContain("Context › Inspector");
		s.panel.handleInput(K.alt("v"));
		expect(s.screen()).toContain("FOLDED");
		s.panel.handleInput(K.esc);
		expect(s.screen()).not.toContain("Inspector");
		s.close(); await s.opening;
	});

	test("inspects the group summary for a grouped block", async () => {
		const s = setup();
		s.truth.setProtect(0);
		s.truth.apply([{ kind: "group", ids: ["a", "b"], summary: "group summary" }], "you");
		s.panel.handleInput(K.enter); s.panel.handleInput(K.alt("v"));
		expect(s.screen()).toContain("Group summary: group summary");
		s.close(); await s.opening;
	});

	test("does not attach when the requested locks change after consent is shown", async () => {
		const s = setup(false, "conductors");
		s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		s.conductor.locks.push("tail-size");
		s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		expect(s.commands).toEqual([]);
		expect(s.screen()).toContain("locks changed");
		s.close(); await s.opening;
	});

	test("every screen keeps one height and fits every width, with sanitized text", async () => {
		const s = setup();
		s.truth.blocks[0].text = "wide 界 \u001b]0;unsafe\u0007 text";
		const height = s.panel.render(80).length;
		expect(height).toBe(12 + CHROME_ROWS);
		const check = () => {
			for (const width of [20, 36, 57, 80, 140]) {
				const lines = s.panel.render(width);
				expect(lines).toHaveLength(height);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.join("")).not.toContain("\u001b]");
				expect(lines.join("")).not.toContain("\u0007");
			}
		};
		// map, list, filtered list, inspector, help, conductors, consent, settings, editor, staged
		for (const key of [K.alt("v"), "w", K.enter, K.f1, K.f1, K.esc, K.esc, K.tab, K.down, K.enter, K.esc, K.tab, K.down, K.enter, "272k", K.esc, K.down, K.down, K.enter]) {
			check();
			s.panel.handleInput(key);
		}
		check();
		expect(s.screen()).toContain("▲ 1 staged");
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
		s.panel.handleInput(K.alt("o")); s.panel.handleInput(K.alt("o"));
		expect(s.commands).toHaveLength(1);
		expect(s.screen()).toContain("pending");
		s.resolveCommand(); await tick(1);
		expect(s.screen()).toContain("read-only");
		s.close(); await s.opening;
	});

	test("ignores a delayed response after disposal", async () => {
		const s = setup(true);
		s.panel.handleInput(K.alt("o"));
		s.close(); await s.opening;
		const before = s.renders();
		s.resolveCommand(); await tick(1);
		expect(s.renders()).toBe(before);
		expect(s.disposed()).toBe(true);
	});

	test("reports loss of controller ownership before another command", async () => {
		const s = setup();
		s.loseControl();
		expect(s.screen()).toContain("READ-ONLY");
		expect(s.commands).toEqual([]);
		s.close(); await s.opening;
	});

	test("surfaces loss of control for non-op commands", async () => {
		const s = setup(); s.setRefuse();
		s.panel.handleInput(K.alt("o"));
		await tick(1);
		expect(s.screen(120)).toContain("read-only");
		expect(s.screen(120)).toContain("reopen /accordion");
		s.panel.handleInput(K.down);
		expect(s.screen(36)).toContain("reopen /accordion");
		s.close(); await s.opening;
	});

	test("compacts with a chord", async () => {
		const s = setup();
		s.panel.handleInput(K.alt("c"));
		await tick(2);
		expect(s.screen()).toContain("Accordion compacted context: 40 → 20 tok");
		s.close(); await s.opening;
	});

	test("typing filters the block list and esc clears the filter before closing", async () => {
		const s = setup();
		for (const ch of "content b") s.panel.handleInput(ch);
		expect(s.screen()).toContain("⌕ content b");
		expect(s.cursor()).toContain(" b ");
		expect(s.screen()).not.toContain("content a");
		s.panel.handleInput(K.backspace);
		expect(s.screen()).toContain("content a");
		s.panel.handleInput(K.esc);
		expect(s.screen()).toContain("Type to filter");
		let closed = false;
		void s.opening.then(() => { closed = true; });
		s.panel.handleInput(K.esc);
		await tick();
		expect(closed).toBe(true);
	});

	test("tab and shift+tab switch tabs; left and right too outside the map", async () => {
		const s = setup();
		const crumb = () => s.panel.render(100)[0];
		expect(crumb()).toContain("Accordion › Context");
		s.panel.handleInput(K.tab);
		expect(crumb()).toContain("Accordion › Conductors");
		s.panel.handleInput(K.right);
		expect(crumb()).toContain("Accordion › Settings");
		s.panel.handleInput(K.shiftTab); s.panel.handleInput(K.left);
		expect(crumb()).toContain("Accordion › Context");
		s.close(); await s.opening;
	});

	test("a printable key never acts on any screen", async () => {
		const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
		const reach: Record<string, string[]> = {
			map: [], list: [K.alt("v")], inspector: [K.enter], help: [K.f1],
			conductors: [K.tab], consent: [K.tab, K.down, K.enter],
			settings: [K.tab, K.tab], confirm: [K.tab, K.tab], timing: [K.tab, K.tab],
		};
		for (const [name, path] of Object.entries(reach)) {
			const s = setup();
			s.truth.setProtect(0);
			for (const key of path) s.panel.handleInput(key);
			if (name === "confirm") { selectSetting(s, "Web access token"); s.panel.handleInput(K.alt("r")); }
			if (name === "timing") selectSetting(s, "Task fold timing");
			const rule = s.panel.render(100)[0];
			for (const key of printable) s.panel.handleInput(key);
			await tick();
			expect([name, s.commands]).toEqual([name, []]);
			expect([name, s.settings()]).toEqual([name, DEFAULT_SETTINGS]);
			expect([name, s.truth.groups.length, s.truth.blocks.some((b) => b.override)]).toEqual([name, 0, false]);
			expect(s.panel.render(100)[0].replace(/ · ▲.*$/, "")).toBe(rule.replace(/ · ▲.*$/, ""));
			s.close(); await s.opening;
		}
	});

	test("global timing cycles, stays staged, preserves other taskfold settings and resets to default", async () => {
		const s = setup(false, "settings");
		const before = { ...s.settings().taskfold, high: 0.9 };
		s.settings().taskfold = before;
		selectSetting(s, "Task fold timing");
		expect(s.cursor()).toContain("Task fold timing");
		s.panel.handleInput(K.right);
		expect(s.settings().taskfold.timing).toBe("eager");
		expect(s.cursor()).toContain("lazy");
		const height = s.panel.render(80).length;
		for (const width of [36, 57, 80, 140]) {
			const lines = s.panel.render(width);
			expect(lines).toHaveLength(height);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		}
		s.panel.handleInput(K.ctrlS); await tick();
		expect(s.settings().taskfold).toEqual({ ...before, timing: "lazy" });
		s.panel.handleInput(K.right);
		expect(s.cursor()).toContain("pressure");
		s.panel.handleInput(K.alt("u"));
		expect(s.cursor()).toContain("eager");
		s.panel.handleInput(K.ctrlS); await tick();
		expect(s.settings().taskfold).toEqual(before);
		expect(s.commands).toEqual([]);
		s.close(); await s.opening;
	});

	test("task tabs: printable keys never act, every line fits, the height stays fixed", async () => {
		const at = new Date().toISOString();
		const list: TaskList = { slug: "plan", title: "Plan", createdAt: at, updatedAt: at, claim: null, goals: [{ id: "g1", text: "Ship it" }],
			tasks: [{ id: "1", title: "First", status: "done", createdAt: at, startedAt: at, endedAt: at, updatedAt: at, report: { outcome: "ok" } }, { id: "2", title: "Second", status: "todo", createdAt: at, updatedAt: at }] };
		const acted: string[] = [];
		const act = (name: string) => { acted.push(name); return { ok: false as const, message: name }; };
		const tasks = (truth: () => Truth | null): TaskTabsHost => ({
			views: { truth, verdict: () => undefined, threshold: () => null, lists: () => [list], canSteer: () => true, apply: async () => { acted.push("apply"); return "Applied."; }, subscribe: () => () => {} },
			lists: { lists: () => [list], session: () => "s1", attach: () => act("attach"), release: () => act("release"), create: () => act("create") },
		});
		const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
		const reach: Record<string, string[]> = { tasks: [K.tab], lists: [K.tab, K.tab], tree: [K.tab, K.tab, K.enter], details: [K.tab, K.tab, K.enter, K.enter], context: [K.tab, K.tab, K.alt("g")] };
		for (const [name, path] of Object.entries(reach)) {
			let truth: Truth | null = null;
			const s = setup(false, undefined, tasks(() => truth));
			truth = s.truth;
			const height = s.panel.render(100).length;
			for (const key of path) s.panel.handleInput(key);
			expect([name, s.screen()]).toEqual([name, expect.stringContaining("❱ Tasks ❱ Lists ❱")]);
			for (const width of [36, 57, 80, 140]) {
				const lines = s.panel.render(width);
				expect([name, width, lines.length]).toEqual([name, width, height]);
				expect([name, width, lines.every((line) => visibleWidth(line) <= width)]).toEqual([name, width, true]);
			}
			const crumbs = s.panel.render(100)[0].split("──")[1];
			for (const key of printable) s.panel.handleInput(key);
			await tick();
			expect([name, acted, s.commands]).toEqual([name, [], []]);
			expect([name, s.panel.render(100)[0].split("──")[1]]).toEqual([name, crumbs]);
			s.panel.handleInput(K.esc);
			s.close(); await s.opening;
		}
		const s = setup(false, "lists", tasks(() => null));
		expect(s.screen()).toContain("→ ○ plan");
		s.panel.handleInput(K.alt("n"));
		for (const key of "New one") s.panel.handleInput(key);
		expect(s.screen()).toContain("Title: New one");
		expect(acted).toEqual([]);
		s.panel.handleInput(K.esc);
		expect(s.screen()).toContain("→ ○ plan");
		s.panel.handleInput(K.alt("a"));
		expect(acted).toEqual(["attach"]);
		s.close(); await s.opening;
	});

	test("global settings are staged, saved with ctrl+s, and a dirty close asks first", async () => {
		const s = setup(false, "settings");
		for (const key of [K.down, K.down, K.down, K.enter]) s.panel.handleInput(key);
		expect(s.settings().autoArm).toBe(true);
		expect(s.cursor()).toContain("[ ] off");
		expect(s.cursor()).toContain("▲ staged");
		s.panel.handleInput(K.down); s.panel.handleInput(K.right);
		expect(s.cursor()).toContain("‹ taskfold ›");
		expect(s.screen()).toContain("▲ 2 staged");
		s.panel.handleInput(K.esc);
		expect(s.cursor()).toContain("Keep editing");
		s.panel.handleInput(K.enter);
		s.panel.handleInput(K.ctrlS);
		await tick();
		expect(s.settings()).toMatchObject({ autoArm: false, defaultConductor: "taskfold" });
		expect(s.screen()).toContain("Saved 2 settings");
		expect(s.screen()).not.toContain("▲");
		s.panel.handleInput(K.alt("u"));
		expect(s.cursor()).toContain("‹ keel-lite ›");
		s.panel.handleInput(K.esc); s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		await s.opening;
		expect(s.settings().defaultConductor).toBe("taskfold");
	});

	test("retains staged edits and their original revision when a save conflicts", async () => {
		const s = setup(false, "settings");
		for (let i = 0; i < 3; i++) s.panel.handleInput(K.down);
		s.panel.handleInput(K.enter);
		s.externalSettings({ debug: true });
		s.failSettings("autoArm: changed on disk; reload before saving");
		s.panel.handleInput(K.ctrlS); await tick();
		expect(s.saveRevisions.at(-1)).toBe("0");
		expect(s.screen()).toContain("changed on disk");
		expect(s.screen()).toContain("▲ 1 staged");
		expect(s.settings().autoArm).toBe(true);
		s.failSettings(null);
		s.panel.handleInput(K.ctrlS); await tick();
		expect(s.saveRevisions.at(-1)).toBe("0");
		expect(s.settings()).toMatchObject({ autoArm: false, debug: true });
		expect(s.screen()).not.toContain("▲ 1 staged");
		s.close(); await s.opening;
	});

	test("shows override locks and refuses toggles, cycling and resets", async () => {
		const s = setup(false, "settings");
		const snapshot = s.host.settings!();
		snapshot.sources.autoArm = "env";
		snapshot.sources.defaultConductor = "flag";
		for (let i = 0; i < 3; i++) s.panel.handleInput(K.down);
		expect(s.cursor()).toContain("env · locked");
		s.panel.handleInput(K.enter); s.panel.handleInput(K.alt("u"));
		s.panel.handleInput(K.down);
		expect(s.cursor()).toContain("flag · locked");
		s.panel.handleInput(K.right); s.panel.handleInput(K.alt("u"));
		s.panel.handleInput(K.ctrlS); await tick();
		expect(s.saveRevisions).toEqual([]);
		expect(s.settings()).toMatchObject({ autoArm: true, defaultConductor: "keel-lite" });
		expect(s.screen()).not.toContain("▲ 1 staged");
		s.close(); await s.opening;
	});

	test("conductor watermarks validate before staging and together at save", async () => {
		const s = setup(false, "settings");
		const patches: SettingsPatch[] = [];
		s.host.updateSettings = (patch) => {
			patches.push(patch);
			const result = validateSettingsPatch(patch, s.settings());
			return result.ok ? { ok: true, snapshot: s.host.settings!() } : result;
		};
		selectSetting(s, "High water");
		s.panel.handleInput(K.enter); s.panel.handleInput("\x15"); s.panel.handleInput("2");
		expect(s.screen()).toContain("✗ conductorOptions.taskfold.high");
		s.panel.handleInput(K.enter);
		expect(s.screen()).toContain("✗ conductorOptions.taskfold.high");
		s.panel.handleInput("\x15"); s.panel.handleInput("0.85"); s.panel.handleInput(K.enter);
		selectSetting(s, "Low water");
		s.panel.handleInput(K.enter); s.panel.handleInput("\x15"); s.panel.handleInput("0.9"); s.panel.handleInput(K.enter);
		s.panel.handleInput(K.ctrlS); await tick();
		expect(s.screen()).toContain("must be less than conductorOptions.taskfold.high");
		expect(s.screen()).toContain("▲ 2 staged");
		s.panel.handleInput(K.enter); s.panel.handleInput("\x15"); s.panel.handleInput("0.5"); s.panel.handleInput(K.enter);
		s.panel.handleInput(K.ctrlS); await tick();
		expect(patches.at(-1)).toEqual({ "conductorOptions.taskfold.high": 0.85, "conductorOptions.taskfold.low": 0.5 });
		expect(s.screen()).toContain("Saved 2 settings");
		s.close(); await s.opening;
	});

	test("resetting a conductor option removes its override instead of persisting the default", async () => {
		const s = setup(false, "settings");
		s.settings().conductorOptions = { taskfold: { high: 0.9 } };
		let saved: SettingsPatch | undefined;
		s.host.updateSettings = (patch) => { saved = patch; return { ok: true, snapshot: s.host.settings!() }; };
		selectSetting(s, "High water");
		expect(s.cursor()).toContain("0.9");
		s.panel.handleInput(K.alt("u"));
		expect(s.cursor()).toContain("0.8");
		s.panel.handleInput(K.ctrlS); await tick();
		expect(saved).toEqual({ "conductorOptions.taskfold.high": undefined });
		s.close(); await s.opening;
	});

	test("a failed asynchronous regeneration preserves a staged token", async () => {
		const s = setup(false, "settings");
		s.host.regenerateToken = async () => { throw new Error("token write refused"); };
		selectSetting(s, "Web access token");
		s.panel.handleInput(K.enter); s.panel.handleInput("staged-token"); s.panel.handleInput(K.enter);
		s.panel.handleInput(K.alt("r")); s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		await tick();
		expect(s.screen()).toContain("token write refused");
		expect(s.cursor()).toContain("staged-token");
		expect(s.screen()).toContain("▲ 1 staged");
		s.close(); await s.opening;
	});

	test("typed settings are validated before they are staged", async () => {
		const s = setup(false, "settings");
		selectSetting(s, "Web UI address");
		s.panel.handleInput(K.enter);
		expect(s.panel.render(100)[0]).toContain("Settings › Web UI address");
		for (let i = 0; i < 9; i++) s.panel.handleInput(K.backspace);
		for (const ch of "bad host") s.panel.handleInput(ch);
		expect(s.screen()).toContain("✗ bindHost: must be an IP address or hostname");
		s.panel.handleInput(K.enter);
		expect(s.panel.render(100)[0]).toContain("Web UI address");
		for (let i = 0; i < 8; i++) s.panel.handleInput(K.backspace);
		for (const ch of "0.0.0.0") s.panel.handleInput(ch);
		s.panel.handleInput(K.enter);
		expect(s.cursor()).toContain("0.0.0.0");
		expect(s.settings().bindHost).toBe("127.0.0.1");
		s.panel.handleInput(K.ctrlS);
		await tick();
		expect(s.settings().bindHost).toBe("0.0.0.0");
		s.close(); await s.opening;
	});

	test.each([24, 16])("a new token needs visible confirmation with %i terminal rows", async (terminalRows) => {
		const s = setup(false, "settings", undefined, terminalRows);
		selectSetting(s, "Web access token");
		expect(s.cursor()).toContain("kave4ton");
		s.panel.handleInput(K.alt("r"));
		expect(s.screen(36)).toContain("Generate a new web access token?");
		expect(s.screen(36)).toContain("Generate new token");
		expect(s.cursor()).toContain("Keep token");
		s.panel.handleInput(K.enter);
		expect(s.cursor()).toContain("kave4ton");
		s.panel.handleInput(K.alt("r")); s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		expect(s.cursor()).toContain("mira7pex");
		s.close(); await s.opening;
	});

	test("a budget applies to the session at once", async () => {
		const s = setup(false, "settings");
		s.panel.handleInput(K.down); s.panel.handleInput(K.enter);
		for (const ch of "1234") s.panel.handleInput(ch);
		expect(s.screen()).toContain("= 1,234 tokens");
		s.panel.handleInput(K.enter);
		await tick(1);
		expect(s.commands).toEqual([{ kind: "setBudget", value: 1234 }]);
		s.close(); await s.opening;
	});
});
