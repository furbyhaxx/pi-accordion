import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attachmentContent, deliverContext, deliveryKey, makeAttachment, makePin, parseLines, PIN_LIMITS } from "./taskPins";

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
	expect(attachmentContent(projectDir, { id: "a1", path: "link/secret.txt" })).toBeNull();
});

test("an attachment that grows beyond its limit is not delivered", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "before");
	const attachment = makeAttachment({ path: "spec.md" }, { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" }, "a1", []);
	fs.writeFileSync(path.join(projectDir, "spec.md"), Array(61).fill("line").join("\n"));
	expect(attachmentContent(projectDir, attachment)).toBeNull();
});

test("start delivers the entering branch's context minus what the model can still see", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const attachment = makeAttachment({ path: "spec.md:2" }, ctx, "a1", []);
	const pin = { id: "p1", kind: "rule" as const, text: "Decimal only", source: "user", at: "now" };
	const list = { goal: "Finish", pins: [pin], tasks: [
		{ id: "1", title: "Parent", status: "doing", acceptanceCriteria: ["parent criterion"] },
		{ id: "1.1", title: "Current", status: "doing", attachments: [attachment] },
		{ id: "1.2", title: "Later", status: "todo", acceptanceCriteria: ["not active"] },
	] };
	const first = deliverContext(list, ["1", "1.1"], true, () => false, projectDir, "inline");
	expect(first.list).toEqual({ goal: "Finish", pins: [{ id: "p1", kind: "rule", text: "Decimal only", source: "user" }] });
	expect(first.tasks).toEqual([
		{ id: "1", title: "Parent", criteria: ["parent criterion"] },
		{ id: "1.1", title: "Current", attachments: [{ id: "a1", ref: "spec.md:2", content: "two" }] },
	]);
	// Everything the first delivery put in front of the model is live: nothing is sent again.
	const live = new Set(first.delivered);
	const again = deliverContext(list, ["1", "1.1"], true, (k) => live.has(k), projectDir, "inline");
	expect(again).toEqual({ tasks: [{ id: "1", title: "Parent" }, { id: "1.1", title: "Current" }], delivered: [], seen: {} });
	expect(deliverContext(list, ["1.1"], false, () => false, projectDir, "reference").tasks[0].attachments).toEqual([{ id: "a1", ref: "spec.md:2" }]);
	// A changed file has a new content key, so it is delivered again and marked changed.
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\nchanged\nthree");
	const changed = deliverContext(list, ["1.1"], false, (k) => live.has(k), projectDir, "inline");
	expect(changed.tasks[0].attachments).toEqual([{ id: "a1", ref: "spec.md:2", content: "changed", state: "changed" }]);
	expect(changed.delivered).toEqual([deliveryKey.attachment("a1", "changed")]);
});

test("line ranges reject unsafe numeric values", () => {
	expect(parseLines("1-999999999999999999999999")).toBeNull();
});

