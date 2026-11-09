import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attachmentRef, deliverContext, deliveryKey, liveDeliveryKeys, makeAttachment, makePin, parseLines, PIN_LIMITS, readAttachment } from "./taskPins";
import { warmSymbols } from "./taskSymbols";

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

test("line input is stored as a quote of those lines, never as line numbers", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const byPath = makeAttachment({ path: "spec.md:2-3" }, ctx, "a1", []);
	const byField = makeAttachment({ path: "spec.md", lines: "2" }, ctx, "a2", []);
	expect(byPath).toMatchObject({ path: "spec.md", anchor: { quote: { exact: "two\nthree", prefix: "one\n", suffix: "" } } });
	expect(byPath.lines).toBeUndefined();
	expect(attachmentRef(byField)).toBe("spec.md@q:a2");
	expect(readAttachment(projectDir, byPath)).toEqual({ content: "two\nthree" });
	expect(() => makeAttachment({ path: "spec.md:2", lines: "3" }, ctx, "a3", [])).toThrow(/once/);
	expect(() => makeAttachment({ path: "spec.md", lines: "2", quote: "two" }, ctx, "a3", [])).toThrow(/exactly one/);
	expect(() => makeAttachment({ path: "spec.md:9" }, ctx, "a3", [])).toThrow(/out of range/);
});

test("a section anchor follows its heading and ignores edits elsewhere", () => {
	const projectDir = directory();
	const file = path.join(projectDir, "auth.md");
	fs.writeFileSync(file, "# Auth\n\n## Token store\n\n### Interface\n\nget and set\n\n## Rollout\n\nlater\n");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const a = makeAttachment({ path: "auth.md", section: "Token store > Interface" }, ctx, "a1", []);
	expect(attachmentRef(a)).toBe("auth.md#Token store > Interface");
	expect(readAttachment(projectDir, a)).toEqual({ content: "### Interface\n\nget and set" });
	expect(() => makeAttachment({ path: "auth.md", section: "Token store > Interface" }, ctx, "a3", [a])).toThrow(/already attached as a1/);
	// Lines are added above and a sibling section is rewritten; the section's content is what it is.
	fs.writeFileSync(file, "intro\nmore intro\n# Auth\n\n## Token store\n\n### Interface\n\nget and set\n\n## Rollout\n\nrewritten\n");
	expect(readAttachment(projectDir, a)).toEqual({ content: "### Interface\n\nget and set" });
	fs.writeFileSync(file, "# Auth\n\n## Token store\n\nrenamed away\n");
	expect(readAttachment(projectDir, a)).toMatchObject({ lost: true });
	expect(() => makeAttachment({ path: "auth.md", section: "Nope" }, ctx, "a2", [])).toThrow(/no section/);
});

test("a symbol anchor resolves the declaration wherever it moves", async () => {
	const projectDir = directory();
	const file = path.join(projectDir, "store.ts");
	fs.writeFileSync(file, "export class TokenStore {\n\tget(key: string) { return key; }\n\tset(key: string) { return key; }\n}\n");
	await warmSymbols(["store.ts"]);
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const a = makeAttachment({ path: "store.ts", symbol: "TokenStore.get" }, ctx, "a1", []);
	expect(attachmentRef(a)).toBe("store.ts::TokenStore.get");
	expect(readAttachment(projectDir, a)).toEqual({ content: "get(key: string) { return key; }" });
	fs.writeFileSync(file, "// header\n// more\nexport class TokenStore {\n\tset(key: string) { return key; }\n\tget(key: string) { return key; }\n}\n");
	expect(readAttachment(projectDir, a)).toEqual({ content: "get(key: string) { return key; }" });
	fs.writeFileSync(file, "export class TokenStore {}\n");
	expect(readAttachment(projectDir, a)).toMatchObject({ lost: true });
	fs.writeFileSync(path.join(projectDir, "notes.md"), "# x\n");
	expect(() => makeAttachment({ path: "notes.md", symbol: "x" }, ctx, "a2", [])).toThrow(/Symbols resolve/);
});

test("a quote anchor reports moved text and a refreshed anchor, and is lost when gone", () => {
	const projectDir = directory();
	const file = path.join(projectDir, "spec.md");
	fs.writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const a = makeAttachment({ path: "spec.md", quote: "gamma" }, ctx, "a1", []);
	expect(readAttachment(projectDir, a)).toEqual({ content: "gamma" });
	fs.writeFileSync(file, "new first line\nanother\nalpha\nbeta\ngamma\ndelta\n");
	const moved = readAttachment(projectDir, a);
	expect(moved).toMatchObject({ content: "gamma", state: "moved", anchor: { quote: { exact: "gamma" } } });
	fs.writeFileSync(file, "nothing alike\n");
	expect(readAttachment(projectDir, a)).toMatchObject({ lost: true });
	expect(() => makeAttachment({ path: "spec.md", quote: "not there" }, ctx, "a2", [])).toThrow(/does not appear/);
	fs.writeFileSync(file, "same\nsame\n");
	expect(() => makeAttachment({ path: "spec.md", quote: "same" }, ctx, "a2", [])).toThrow(/more than once/);
});

test("a hand-written quote with only exact text resolves without a state and gains its context", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "plan.md"), "# Do\n\n1. Producer kind\n2. Ledger\n");
	const read = readAttachment(projectDir, { id: "a1", path: "plan.md", anchor: { quote: { exact: "2. Ledger" } } });
	expect(read).toEqual({ content: "2. Ledger", anchor: { quote: { exact: "2. Ledger", prefix: "# Do\n\n1. Producer kind\n", suffix: "\n", start: 23 } } });
});

test("an anchor target larger than the cap is refused with a hint to anchor a smaller part", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "big.md"), `# Big\n\n${Array(70).fill("line").join("\n")}\n`);
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	expect(() => makeAttachment({ path: "big.md", section: "Big" }, ctx, "a1", [])).toThrow(/quote/);
});

test("a legacy line-range attachment is read by its lines and offers a quote anchor", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree");
	const legacy = { id: "a1", path: "spec.md", lines: "2-3" };
	expect(readAttachment(projectDir, legacy)).toMatchObject({ content: "two\nthree", anchor: { quote: { exact: "two\nthree" } } });
	expect(readAttachment(projectDir, { ...legacy, lines: "9" })).toMatchObject({ lost: true });
});

test("attachments cannot use a symlink to escape the project, including after attachment", () => {
	const projectDir = directory();
	const outside = directory();
	fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
	fs.symlinkSync(outside, path.join(projectDir, "link"));
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	expect(() => makeAttachment({ path: "link/secret.txt" }, ctx, "a1", [])).toThrow();
	expect(readAttachment(projectDir, { id: "a1", path: "link/secret.txt" })).toMatchObject({ lost: true });
});

test("files under a configured root can be attached and quoted by absolute path; others stay refused", () => {
	const projectDir = directory();
	const kb = directory();
	const other = directory();
	fs.writeFileSync(path.join(kb, "ARTICLE.md"), "# KB\n\n## Findings\n\nQueues must never drop frames silently.\n");
	fs.writeFileSync(path.join(other, "secret.txt"), "secret");
	const file = path.join(kb, "ARTICLE.md");
	const ctx = { projectDir, userTexts: [], limits: { ...PIN_LIMITS, roots: [kb] }, now: "now" };
	const a = makeAttachment({ path: file, section: "Findings" }, ctx, "a1", []);
	expect(a.path).toBe(path.normalize(file));
	expect(readAttachment(projectDir, a, 60, [kb])).toEqual({ content: "## Findings\n\nQueues must never drop frames silently." });
	expect(readAttachment(projectDir, a)).toMatchObject({ lost: true });
	expect(makePin({ kind: "fact", text: "Queues must never drop frames silently.", source: `${file}:5` }, ctx, "p1", []).source).toBe(`${file}:5`);
	expect(() => makeAttachment({ path: path.join(other, "secret.txt") }, ctx, "a2", [])).toThrow(/outside the project/);
	expect(() => makeAttachment({ path: path.join(kb, "..", path.basename(other), "secret.txt") }, ctx, "a2", [])).toThrow(/outside the project/);
	expect(() => makeAttachment({ path: file }, { ...ctx, limits: PIN_LIMITS }, "a2", [])).toThrow(/tasks\.attachments\.roots/);
});

test("an attachment that grows beyond its limit is not delivered", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "before");
	const attachment = makeAttachment({ path: "spec.md" }, { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" }, "a1", []);
	fs.writeFileSync(path.join(projectDir, "spec.md"), Array(61).fill("line").join("\n"));
	expect(readAttachment(projectDir, attachment)).toMatchObject({ lost: true, tooLarge: true });
});

test("start delivers the entering branch's context minus what the model can still see", () => {
	const projectDir = directory();
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree");
	const ctx = { projectDir, userTexts: [], limits: PIN_LIMITS, now: "now" };
	const attachment = makeAttachment({ path: "spec.md", quote: "two" }, ctx, "a1", []);
	const pin = { id: "p1", kind: "rule" as const, text: "Decimal only", source: "user", at: "now" };
	const list = { goals: [{ id: "g1", text: "Finish" }, { id: "g2", text: "Tests pass" }], pins: [pin], tasks: [
		{ id: "1", title: "Parent", status: "doing", goals: [{ id: "g3", text: "Parent ships" }], acceptanceCriteria: [{ id: "c1", text: "parent criterion" }] },
		{ id: "1.1", title: "Current", status: "doing", attachments: [attachment] },
		{ id: "1.2", title: "Later", status: "todo", acceptanceCriteria: [{ id: "c2", text: "not active" }] },
	] };
	const first = deliverContext(list, ["1", "1.1"], true, () => false, projectDir, "inline");
	expect(first.list).toEqual({ goals: [{ id: "g1", text: "Finish" }, { id: "g2", text: "Tests pass" }], pins: [{ id: "p1", kind: "rule", text: "Decimal only", source: "user" }] });
	expect(first.tasks).toEqual([
		{ id: "1", title: "Parent", goals: [{ id: "g3", text: "Parent ships" }], criteria: [{ id: "c1", text: "parent criterion" }] },
		{ id: "1.1", title: "Current", attachments: [{ id: "a1", ref: "spec.md@q:a1", content: "two" }] },
	]);
	// Everything the first delivery put in front of the model is live: nothing is sent again.
	const live = new Set(first.delivered);
	const again = deliverContext(list, ["1", "1.1"], true, (k) => live.has(k), projectDir, "inline");
	expect(again).toEqual({ tasks: [{ id: "1", title: "Parent" }, { id: "1.1", title: "Current" }], delivered: [], seen: {} });
	expect(deliverContext(list, ["1.1"], false, () => false, projectDir, "reference").tasks[0].attachments).toEqual([{ id: "a1", ref: "spec.md@q:a1" }]);
	// An edited goal has a new key, so only it is delivered again; its siblings stay live.
	const edited = { ...list, goals: [list.goals[0]!, { id: "g2", text: "Tests pass and lint is clean" }] };
	expect(deliverContext(edited, [], true, (k) => live.has(k), projectDir, "inline").list).toEqual({ goals: [{ id: "g2", text: "Tests pass and lint is clean" }] });
	// The agent's own edits to a file whose attachment is still in front of the model are never re-sent.
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\ntwo\nthree\nfour");
	expect(deliverContext(list, ["1.1"], false, (k) => live.has(k), projectDir, "inline").tasks[0].attachments).toBeUndefined();
	// A file that changed before its attachment was delivered is delivered with its current text and marked changed.
	fs.writeFileSync(path.join(projectDir, "spec.md"), "one\nchanged\nthree");
	const edited2 = { ...list, tasks: [list.tasks[0]!, { ...list.tasks[1]!, attachments: [{ ...attachment, anchor: undefined, lines: "2" }] }, list.tasks[2]!] };
	const changed = deliverContext(edited2, ["1.1"], false, () => false, projectDir, "inline");
	expect(changed.tasks[0].attachments).toEqual([{ id: "a1", ref: "spec.md:2", content: "changed", state: "changed" }]);
	expect(changed.delivered).toEqual([deliveryKey.attachment("a1")]);
	expect(changed.seen.a1?.anchor).toMatchObject({ quote: { exact: "changed" } });
});

test("line ranges reject unsafe numeric values", () => {
	expect(parseLines("1-999999999999999999999999")).toBeNull();
});


test("only deliveries on unfolded result blocks are live", () => {
	const shown = { details: { delivered: ["w/goal#a", "w/pin:p1"] } };
	const hidden = { details: { delivered: ["w/crit:1#b"] } };
	const unrelated = { details: { action: "status" } };
	expect([...liveDeliveryKeys([shown, hidden, unrelated, {}], (b) => b === hidden)]).toEqual(["w/goal#a", "w/pin:p1"]);
});
