import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskStore, runTasks, slugFor } from "../tasks";
import { resumeSituation, type AttachOutcome } from "../taskBinding";
import { ResumeDialog, TaskListsBrowser, listRowLine, type TaskListsHost } from "./taskLists";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, strikethrough: (t: string) => t };
const KEY: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
const keys = {
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
		create(title) {
			const slug = slugFor(title, new Set(mine.lists().map((l) => l.slug)));
			return { ok: true, list: mine.create(slug, title, []), message: `Created "${slug}".` };
		},
	};
	return { mine, other, host };
}

const type = (c: { handleInput(d: string): void }, ...input: string[]) => {
	for (const d of input) for (const ch of KEY[d] ? [KEY[d]] : [...d]) c.handleInput(ch);
};

describe("task list browser", () => {
	test("rows keep slug, progress and claim at every width", () => {
		const { mine, other } = project();
		runTasks(other, { action: "create", list: "auth-refactor", title: "Auth refactor", tasks: [{ title: "A" }, { title: "B" }] });
		const list = mine.read("auth-refactor");
		for (const w of [36, 57, 80, 140]) {
			const row = listRowLine(list, "s1", true, w, theme, Date.now());
			expect(visibleWidth(row)).toBeLessThanOrEqual(w);
			expect(row).toContain("auth-refactor");
		}
		expect(listRowLine(list, "s1", false, 140, theme, Date.now())).toContain('held · session s2 "Other work"');
	});

	test("manage mode attaches, takes over after confirmation, releases and creates", () => {
		const { mine, other, host } = project();
		runTasks(other, { action: "create", list: "held", title: "Held", tasks: [{ title: "A" }] });
		mine.create("free", "Free", []);
		mine.release("free");
		let closed: AttachOutcome | null | undefined;
		const b = new TaskListsBrowser(tui, theme, keys, host, "manage", (v) => (closed = v), () => 30);
		const select = (slug: string) => {
			for (let i = 0; i < 5; i++) type(b, "up");
			for (let i = 0; i < 5 && !b.render(100).some((l) => l.startsWith("›") && l.includes(` ${slug} `)); i++) type(b, "down");
		};
		select("free");
		type(b, "c");
		expect(mine.read("free").claim?.session).toBe("s1");
		select("held");
		type(b, "c");
		expect(b.render(100).join("\n")).toContain("Taking it over makes that session lose the claim");
		type(b, "enter");
		expect(mine.read("held").claim?.session).toBe("s1");
		type(b, "r");
		expect(mine.read("held").claim).toBeNull();
		type(b, "n", "My new list", "enter");
		expect(mine.read("my-new-list").claim?.session).toBe("s1");
		expect(closed).toBeUndefined();
		type(b, "esc");
		expect(closed).toBeNull();
	});

	test("pick mode closes with the attached or created list", () => {
		const { mine, host } = project();
		mine.create("other", "Other", []);
		mine.release("other");
		let picked: AttachOutcome | null | undefined;
		type(new TaskListsBrowser(tui, theme, keys, host, "pick", (v) => (picked = v), () => 30), "enter");
		expect(picked).toMatchObject({ kind: "replaced", list: { slug: "other" } });
		type(new TaskListsBrowser(tui, theme, keys, host, "pick", (v) => (picked = v), () => 30), "n", "Fresh", "enter");
		expect(picked).toMatchObject({ kind: "created", list: { slug: "fresh" } });
	});
});

describe("resume dialog", () => {
	test("a held list needs confirmation before it is taken over; Esc continues without", () => {
		const { mine, other } = project();
		runTasks(mine, { action: "create", list: "a", title: "A", tasks: [{ title: "One" }] });
		runTasks(other, { action: "claim", list: "a", force: true });
		const s = resumeSituation({ slug: "a", fingerprint: null, seenAt: new Date().toISOString() }, mine.lists(), "s1");
		let chosen: { choice: string; title?: string } | undefined;
		const d = new ResumeDialog(tui, theme, keys, s, (v) => (chosen = v));
		const text = d.render(120).join("\n");
		expect(text).toContain('currently claimed by session s2 "Other work"');
		expect(text).toContain('› Take over "a" from session s2 "Other work"');
		type(d, "enter");
		expect(chosen).toBeUndefined();
		type(d, "enter");
		expect(chosen).toEqual({ choice: "reclaim" });
		const d2 = new ResumeDialog(tui, theme, keys, s, (v) => (chosen = v));
		type(d2, "esc");
		expect(chosen).toEqual({ choice: "without" });
	});

	test("starting a new list asks for its title", () => {
		const { mine } = project();
		const s = resumeSituation({ slug: "gone", fingerprint: null, seenAt: new Date().toISOString() }, mine.lists(), "s1");
		let chosen: { choice: string; title?: string } | undefined;
		const d = new ResumeDialog(tui, theme, keys, s, (v) => (chosen = v));
		expect(d.render(80).join("\n")).toContain('"gone" no longer exists');
		type(d, "down", "enter", "Next steps", "enter");
		expect(chosen).toEqual({ choice: "create", title: "Next steps" });
	});
});
