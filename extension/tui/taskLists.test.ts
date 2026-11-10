import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskStore, runTasks, slugFor } from "../tasks";
import { resumeSituation } from "../taskBinding";
import type { ConfirmSpec } from "./screens/types";
import { ResumeDialog, listRowLine, type TaskListsHost } from "./taskLists";
import { TaskViews, type TaskViewsHost } from "./taskViews";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, strikethrough: (t: string) => t };
const KEY: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
const keys = {
	getKeys: () => [],
	matches(data: string, binding: string) {
		return (
			(binding === "tui.select.up" && data === KEY.up) ||
			(binding === "tui.select.down" && data === KEY.down) ||
			(binding === "tui.select.confirm" && data === KEY.enter) ||
			(binding === "tui.select.cancel" && data === KEY.esc)
		);
	},
};
const tui = { requestRender() {} };

function project() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lists-"));
	const mine = new TaskStore(dir, () => "s1", () => "Mine");
	const other = new TaskStore(dir, () => "s2", () => "Other work");
	const host: TaskListsHost = {
		lists: () => mine.lists(),
		session: () => "s1",
		attach(slug, force) {
			try {
				return { ok: true, list: mine.claim(slug, force), message: `Attached "${slug}".` };
			} catch (e) {
				return { ok: false, message: (e as Error).message };
			}
		},
		release(slug) {
			mine.release(slug);
			return { ok: true, message: `Released "${slug}".` };
		},
		create(title, goal) {
			const slug = slugFor(title, new Set(mine.lists().map((l) => l.slug)));
			return { ok: true, list: mine.create(slug, title, [goal], []), message: `Created "${slug}".` };
		},
	};
	return { mine, other, host };
}

const type = (c: { handleInput(d: string): void }, ...input: string[]) => {
	for (const d of input) for (const ch of KEY[d] ? [KEY[d]] : [...d]) c.handleInput(ch);
};

function open(host: TaskListsHost, extra: Partial<TaskViewsHost> = {}) {
	const said: string[] = [];
	let modal: ConfirmSpec | null = null;
	const views: TaskViewsHost = { truth: () => null, verdict: () => undefined, threshold: () => null, lists: () => host.lists(), canSteer: () => true, apply: async () => "", subscribe: () => () => {}, ...extra };
	const v = new TaskViews({ theme: () => theme, keys: () => keys, say: (t) => void said.push(t), confirm: (spec) => void (modal = spec), update() {} }, views, { kind: "lists" }, host);
	const press = (...input: string[]) => {
		for (const d of input) for (const ch of KEY[d] ? [KEY[d]] : d.startsWith("alt+") ? [`\x1b${d.slice(4)}`] : [...d]) ch === KEY.esc ? v.back() : v.key(ch);
	};
	return { v, said, press, modal: () => modal, body: (width = 100, rows = 12) => v.view(width, rows).body };
}

describe("lists tab", () => {
	test("invalid files stay visible and scanning happens only on reload", () => {
		const { host } = project();
		let scans = 0;
		const l = open(host, { invalid: () => { scans++; return ["broken"]; } });
		for (const width of [36, 57, 80, 140]) {
			const text = l.body(width).join("\n");
			expect(text).toContain("Invalid lists: broken");
			expect(text).not.toContain("No task lists in this project yet");
		}
		expect(scans).toBe(1);
		l.v.dispose();
	});

	test("the body never exceeds its rows and the selection stays visible", () => {
		const { mine, host } = project();
		for (let i = 0; i < 9; i++) mine.create(`list-${i}`, `List ${i}`, ["Short terminal goal"], []);
		const l = open(host, { invalid: () => ["broken"] });
		for (let i = 0; i < 6; i++) l.press("down");
		const view = l.v.view(80, 4);
		expect(view.body.length).toBeLessThanOrEqual(4);
		expect(view.body.some((line) => line.startsWith("→"))).toBe(true);
		expect(view.above + view.below).toBe(9 - 3);
		l.v.dispose();
	});

	test("rows keep slug, progress and claim at every width", () => {
		const { mine, other } = project();
		runTasks(other, { action: "create", list: "auth-refactor", title: "Auth refactor", goals: ["G"], tasks: [{ title: "A" }, { title: "B" }] });
		const list = mine.read("auth-refactor");
		for (const w of [36, 57, 80, 140]) {
			const row = listRowLine(list, "s1", true, w, theme, Date.now());
			expect(visibleWidth(row)).toBeLessThanOrEqual(w);
			expect(row).toContain("auth-refactor");
		}
		expect(listRowLine(list, "s1", false, 140, theme, Date.now())).toContain('held · session s2 "Other work"');
	});

	test("attaches, takes over only after choosing it, releases and creates", () => {
		const { mine, other, host } = project();
		runTasks(other, { action: "create", list: "held", title: "Held", goals: ["G"], tasks: [{ title: "A" }] });
		mine.create("free", "Free", ["G"], []);
		mine.release("free");
		const l = open(host);
		const select = (slug: string) => {
			for (let i = 0; i < 5; i++) l.press("up");
			for (let i = 0; i < 5 && !l.body().some((row) => row.startsWith("→") && row.includes(` ${slug} `)); i++) l.press("down");
		};
		select("free");
		l.press("alt+t");
		expect(mine.read("free").claim?.session).toBe("s1");
		select("held");
		l.press("alt+t");
		expect(mine.read("held").claim?.session).toBe("s2");
		expect(l.modal()?.options[0]).toStartWith("Leave it with");
		expect(l.modal()?.title).toContain("That session loses the claim");
		l.modal()!.then(0);
		expect(mine.read("held").claim?.session).toBe("s2");
		l.modal()!.then(1);
		expect(mine.read("held").claim?.session).toBe("s1");
		l.press("alt+t");
		expect(mine.read("held").claim).toBeNull();
		l.press("alt+n");
		expect(l.v.typing()).toBe(true);
		l.press("My new list", "enter");
		expect(l.body().join("\n")).toContain("Goal:");
		l.press("Deliver changes", "enter");
		expect(l.v.typing()).toBe(false);
		expect(mine.read("my-new-list").claim?.session).toBe("s1");
		expect(mine.read("my-new-list").goals).toEqual([{ id: "g1", text: "Deliver changes" }]);
		expect(l.body().some((row) => row.startsWith("→") && row.includes(" my-new-list "))).toBe(true);
		l.v.dispose();
	});

	test("typing filters the lists and enter opens the selected one", () => {
		const { mine, host } = project();
		mine.create("alpha", "Alpha", ["G"], []);
		mine.create("beta", "Beta", ["G"], []);
		const l = open(host);
		l.v.setFilter("bet");
		expect(l.body().join("\n")).not.toContain("alpha");
		l.press("enter");
		expect(l.v.view(100, 12).crumbs).toEqual(["beta"]);
		expect(l.v.back()).toBe(true);
		expect(l.v.back()).toBe(false);
		l.v.dispose();
	});
});

describe("resume dialog", () => {
	test("a held list needs confirmation before it is taken over; Esc continues without", () => {
		const { mine, other } = project();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		runTasks(other, { action: "claim", list: "a", force: true });
		const s = resumeSituation({ slug: "a", fingerprint: null, seenAt: new Date().toISOString() }, mine.lists(), "s1");
		let chosen: { choice: string; title?: string } | undefined;
		const d = new ResumeDialog(tui, theme, keys, s, (v) => (chosen = v));
		const text = d.render(120).join("\n");
		expect(text).toContain('currently claimed by session s2 "Other work"');
		expect(text).toContain('→ Take over "a" from session s2 "Other work"');
		type(d, "enter");
		expect(chosen).toBeUndefined();
		expect(d.render(120).join("\n")).toContain('→ Leave it with session s2 "Other work"');
		type(d, "enter");
		expect(chosen).toBeUndefined();
		type(d, "enter", "down", "enter");
		expect(chosen).toEqual({ choice: "reclaim" });
		const d2 = new ResumeDialog(tui, theme, keys, s, (v) => (chosen = v));
		type(d2, "esc");
		expect(chosen).toEqual({ choice: "without" });
	});

	test("starting a new list asks for its title and goal", () => {
		const { mine } = project();
		const s = resumeSituation({ slug: "gone", fingerprint: null, seenAt: new Date().toISOString() }, mine.lists(), "s1");
		let chosen: { choice: string; title?: string; goal?: string } | undefined;
		const d = new ResumeDialog(tui, theme, keys, s, (v) => (chosen = v));
		expect(d.render(80).join("\n")).toContain('"gone" no longer exists');
		type(d, "down", "enter", "Next steps", "enter");
		expect(d.render(80).join("\n")).toContain("Goal:");
		type(d, "Finish work", "enter");
		expect(chosen).toEqual({ choice: "create", title: "Next steps", goal: "Finish work" });
	});
});
