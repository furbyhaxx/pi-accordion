import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeAttachment, makePin, parseLines, PIN_LIMITS, readAttachment, workingSet } from "./taskPins";

const dirs: string[] = [];
function directory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-pins-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("a complete user message can be pinned as a durable constraint", () => {
	const projectDir = directory();
	const text = "Never modify vendor/.";
	const pin = makePin({ kind: "constraint", text, source: "user" }, { projectDir, userTexts: [text], limits: PIN_LIMITS, now: "now" }, "p1", []);
	expect(pin.text).toBe(text);
});

test("attachments accept path:line and path:start-end references", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	expect(makeAttachment({ path: "spec.md:2" }, ctx, "a1", [])).toMatchObject({ path: "spec.md", lines: "2" });
	expect(makeAttachment({ path: "spec.md:2-3" }, ctx, "a2", [])).toMatchObject({ path: "spec.md", lines: "2-3" });
	expect(() => makeAttachment({ path: "spec.md:2", lines: "3" }, ctx, "a3", [])).toThrow();
});

test("attachments cannot use a symlink to escape the project, including after attachment", () => {
	const projectDir = directory();
	const outside = directory();
	fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
	fs.symlinkSync(outside, path.join(projectDir, "link"));
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	expect(() => makeAttachment({ path: "link/secret.txt" }, ctx, "a1", [])).toThrow();
	expect(readAttachment(projectDir, { id: "a1", path: "link/secret.txt" }).text).toBeNull();
});

test("an attachment that grows beyond its limit is not injected", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "before");
	const attachment = makeAttachment({ path: "spec.md" }, { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" }, "a1", []);
	fs.writeFileSync(path.join(projectDir, "spec.md"), Array(61).fill("line").join("\n"));
	expect(readAttachment(projectDir, attachment)).toEqual({ text: null, changed: true });
});

test("working set includes the active branch and respects attachment rendering", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const attachment = makeAttachment({ path: "spec.md:2" }, ctx, "a1", []);
	const list = { slug: "w", title: "Work", goal: "Finish", tasks: [
		{ id: "1", title: "Parent", status: "doing", acceptanceCriteria: ["parent criterion"] },
		{ id: "1.1", title: "Current", status: "doing", attachments: [attachment] },
		{ id: "1.2", title: "Later", status: "todo", acceptanceCriteria: ["not active"] },
	] };
	const inline = workingSet(list, projectDir, "inline");
	expect(inline).toContain("parent criterion");
	expect(inline).toContain("spec.md:2");
	expect(inline).toContain("│ two");
	expect(inline).not.toContain("not active");
	expect(workingSet(list, projectDir, "reference")).not.toContain("│ two");
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\nchanged\nthree");
	expect(workingSet(list, projectDir, "inline")).toContain("changed since attached");
});

test("line ranges reject unsafe numeric values", () => {
	expect(parseLines("1-999999999999999999999999")).toBeNull();
});

