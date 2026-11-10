import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BINDING_ENTRY, type BindingRecord } from "./taskBinding";
import { TaskSession, type TaskSessionUi } from "./taskSession";
import { TaskStore, runTasks, runTasksTracked, taskFingerprint } from "./tasks";

const KEY: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
const keys = { matches: (d: string, b: string) => KEY[{ "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "esc" }[b] ?? ""] === d };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, strikethrough: (t: string) => t };

/** A UI whose dialogs are driven by the test: `screen()` renders the open one, `press()` types. */
function fakeUi() {
	let current: { render(w: number): string[]; handleInput(d: string): void } | null = null;
	const opened: Array<() => void> = [];
	const asked: { title: string; options: string[] }[] = [];
	const answers: Array<(options: string[]) => string | undefined> = [];
	const ui: TaskSessionUi = {
		custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: T) => void) => any) {
			return new Promise<T>((resolve) => {
				current = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keys, (v: T) => {
					current = null;
					resolve(v);
				});
				opened.splice(0).forEach((f) => f());
			});
		},
		async select(title: string, options: string[]) {
			asked.push({ title, options });
			return answers.shift()?.(options);
		},
		async input() {
			return undefined;
		},
	};
	const next = () => new Promise<void>((r) => (current ? r() : opened.push(r)));
	return {
		ui,
		asked,
		answers,
		async screen() {
			await next();
			return current!.render(100).join("\n");
		},
		async press(...input: string[]) {
			await next();
			for (const d of input) for (const ch of KEY[d] ? [KEY[d]] : [...d]) current?.handleInput(ch);
			await Promise.resolve();
		},
	};
}

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasksession-"));
	const mine = new TaskStore(dir, () => "s1", () => "Mine");
	const other = new TaskStore(dir, () => "s2", () => "Other work");
	const appended: BindingRecord[] = [];
	const ts = new TaskSession({ store: () => mine, session: () => "s1", enabled: () => true, appendEntry: (_t, d) => appended.push(d), changed: () => {} });
	return { mine, other, ts, appended };
}

describe("task session", () => {
	test("browser creation stores the entered goal and refuses an empty goal", () => {
		const { mine, ts } = setup();
		const invalid = ts.host().create("Empty", "");
		expect(invalid.ok).toBe(false);
		const created = ts.host().create("Plan", "Ship the implementation");
		expect(created.ok).toBe(true);
		expect(mine.read("plan").goals).toEqual([{ id: "g1", text: "Ship the implementation" }]);
	});

	test("names a task that awaits the user on the next prompt only", async () => {
		const { mine, ts } = setup();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "Review" }] });
		runTasks(mine, { action: "start", list: "a", id: "1" });
		runTasks(mine, { action: "block", list: "a", id: "1", reason: "user-input", detail: "Which option?" });
		expect(await ts.takeNotice(false)).toBeNull();
		expect(JSON.parse((await ts.takeNotice())!)).toEqual({ tasks: "a", waiting: [{ id: "1", reason: "user-input", detail: "Which option?" }] });
		runTasks(mine, { action: "start", list: "a", id: "1" });
		ts.markSeen();
		expect(await ts.takeNotice()).toBeNull();
	});

	test("tells the agent once about edits it did not make, and never about its own", async () => {
		const { mine, other, ts } = setup();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }, { title: "Two" }] });
		ts.markSeen();
		runTasks(mine, { action: "start", list: "a", id: "1" });
		runTasksTracked(mine, { action: "pin", list: "a", items: [{ kind: "rule", text: "agent pin", source: "user" }] }, ["agent pin"]);
		ts.markSeen();
		expect(await ts.takeNotice(false)).toBeNull();
		runTasks(other, { action: "claim", list: "a", force: true });
		runTasks(other, { action: "update", list: "a", goals: { add: ["Also SSO"] } });
		runTasks(other, { action: "update", list: "a", id: "1", acceptanceCriteria: { add: ["Reviewed"] } });
		runTasks(mine, { action: "claim", list: "a", force: true });
		expect(JSON.parse((await ts.takeNotice(false))!)).toEqual({ tasks: "a", changed: { goals: { added: [{ id: "g2", text: "Also SSO" }] }, within: { "1": { criteria: { added: [{ id: "c1", text: "Reviewed" }] } } } } });
		expect(await ts.takeNotice(false)).toBeNull();
	});

	test("queues a routed-message note once and treats the new state as seen", async () => {
		const { mine, ts } = setup();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		ts.markSeen();
		runTasksTracked(mine, { action: "pin", list: "a", items: [{ kind: "constraint", text: "Never touch vendor/", source: "user" }] }, ["Never touch vendor/"]);
		ts.noteRouted("a", [{ op: "+", kind: "pin", target: "list", value: "Never touch vendor/", pinKind: "constraint", ref: "p1" }]);
		expect(JSON.parse((await ts.takeNotice(false))!)).toEqual({ tasks: "a", changed: { by: "user-message", ops: [{ op: "+", kind: "pin", target: "list", ref: "p1", text: "Never touch vendor/" }] } });
		expect(await ts.takeNotice(false)).toBeNull();
	});

	test("a reload silently reclaims a free, unchanged list and tells the agent nothing", async () => {
		const s = setup();
		runTasks(s.mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		const fp = taskFingerprint(s.mine.read("a"));
		s.mine.release("a");
		s.ts.start([{ type: "custom", customType: BINDING_ENTRY, timestamp: new Date().toISOString(), data: { slug: "a", fingerprint: fp } }], "reload", fakeUi().ui);
		expect(s.mine.read("a").claim?.session).toBe("s1");
		expect(await s.ts.takeNotice()).toBeNull();
	});

	test("resuming offers the previous list; reclaiming a changed list tells the agent its state", async () => {
		const s = setup();
		runTasks(s.mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }, { title: "Two" }] });
		const fp = taskFingerprint(s.mine.read("a"));
		s.mine.release("a");
		runTasks(s.other, { action: "claim", list: "a" });
		runTasks(s.other, { action: "start", list: "a", id: "1" });
		s.other.release("a");
		const appended: BindingRecord[] = [];
		const ts = new TaskSession({ store: () => s.mine, session: () => "s1", enabled: () => true, appendEntry: (_t, d) => appended.push(d), changed: () => {} });
		const ui = fakeUi();
		ts.start([{ type: "custom", customType: BINDING_ENTRY, timestamp: new Date().toISOString(), data: { slug: "a", fingerprint: fp } }], "resume", ui.ui);
		const screen = await ui.screen();
		expect(screen).toContain("Reattach the task list this session used before?");
		expect(screen).toContain("its tasks changed since this session last used it");
		await ui.press("enter");
		const note = await ts.takeNotice();
		expect(note).toContain('Task list "a" is attached to this session again, but its tasks changed');
		expect(note).toContain("[~] 1 One");
		expect(s.mine.read("a").claim?.session).toBe("s1");
		expect(appended.at(-1)).toEqual({ slug: "a", fingerprint: taskFingerprint(s.mine.read("a")) });
	});

	test("a list held elsewhere: choosing another list tells the agent who holds the old one", async () => {
		const s = setup();
		runTasks(s.mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		s.mine.release("a");
		runTasks(s.other, { action: "claim", list: "a" });
		s.mine.create("b", "Bee", ["G"], []);
		s.mine.release("b");
		const ts = new TaskSession({ store: () => s.mine, session: () => "s1", enabled: () => true, appendEntry: () => {}, changed: () => {} });
		const ui = fakeUi();
		ts.start([{ type: "custom", customType: BINDING_ENTRY, timestamp: new Date().toISOString(), data: { slug: "a" } }], "resume", ui.ui);
		ui.answers.push((options) => options.find((o) => o.startsWith("b ·")));
		await ui.press("down", "enter");
		await new Promise((r) => setTimeout(r, 0));
		expect(ui.asked[0].title).toBe("Attach which task list?");
		expect(ui.asked[0].options.at(-1)).toBe("Start a new list…");
		const note = await ts.takeNotice();
		expect(note).toStartWith('Your previous task list "a" is now claimed by session s2 "Other work"; you cannot change it from this session. The user attached task list "b"');
		expect(s.mine.read("b").claim?.session).toBe("s1");
		expect(s.mine.read("a").claim?.session).toBe("s2");
	});

	test("without a terminal, a held list is left alone and the agent is told", async () => {
		const s = setup();
		runTasks(s.mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		runTasks(s.other, { action: "claim", list: "a", force: true });
		const ts = new TaskSession({ store: () => s.mine, session: () => "s1", enabled: () => true, appendEntry: () => {}, changed: () => {} });
		ts.start([{ type: "custom", customType: BINDING_ENTRY, timestamp: new Date().toISOString(), data: { slug: "a" } }], "startup", null);
		expect(await ts.takeNotice()).toContain('is now claimed by session s2 "Other work"');
	});

	test("records binding entries only when the attached list or its tasks change", () => {
		const { mine, ts, appended } = setup();
		ts.start([], "new", null);
		ts.record();
		expect(appended).toEqual([]);
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		ts.record();
		ts.record();
		expect(appended.map((r) => r.slug)).toEqual(["a"]);
		runTasks(mine, { action: "release", list: "a" });
		ts.record();
		expect(appended.at(-1)).toEqual({ slug: null });
	});
});
