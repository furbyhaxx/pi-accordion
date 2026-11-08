import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PIN_LIMITS } from "./taskPins";
import { applyRoutedOps, createRouting, extractionPrompt, parseExtraction, routingContext, type RoutedOp } from "./taskRouting";
import { TaskStore, runTasks } from "./tasks";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-"));
	const store = new TaskStore(dir, () => "s1");
	runTasks(store, { action: "create", list: "w", title: "W", goals: ["Ship the store"], tasks: [{ title: "Design", acceptanceCriteria: ["Reviewed"], subtasks: [{ title: "Draft" }] }, { title: "Build" }] });
	return { dir, store };
}
const apply = (store: TaskStore, ops: RoutedOp[], said: string) => applyRoutedOps(store, "w", ops, said, PIN_LIMITS);

describe("parseExtraction", () => {
	test("accepts a fenced reply and keeps valid operations", () => {
		const e = parseExtraction('```json\n{"class":"directive","ops":[{"op":"+","kind":"pin","target":"list","value":"Never touch vendor/","pinKind":"constraint"}]}\n```');
		expect(e.class).toBe("directive");
		expect(e.ops).toEqual([{ op: "+", kind: "pin", target: "list", value: "Never touch vendor/", pinKind: "constraint" }]);
		expect(e.rejected).toEqual([]);
	});

	test("rejects malformed operations by shape and keeps the rest", () => {
		const e = parseExtraction(JSON.stringify({ ops: [
			{ op: "+", kind: "pin", target: "list", value: "x" },
			{ op: "-", kind: "pin", target: "list" },
			{ op: "~", kind: "attach", target: "list", id: "a1", value: "x" },
			{ op: "+", kind: "goal", target: "1", value: "x" },
			{ op: "-", kind: "task", target: "list" },
			{ op: "+", kind: "task", target: "list", value: "Docs" },
		] }));
		expect(e.ops).toEqual([{ op: "+", kind: "task", target: "list", value: "Docs" }]);
		expect(e.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/pinKind/), expect.stringMatching(/needs its id/), expect.stringMatching(/cannot be edited/), expect.stringMatching(/target must be "list"/), expect.stringMatching(/needs its id as target/)]);
	});

	test("throws when the reply is not the expected object", () => {
		expect(() => parseExtraction("sure!")).toThrow(/did not return JSON/);
		expect(() => parseExtraction('{"class":"chat"}')).toThrow(/no "ops"/);
	});

	test("caps the operations taken from one message", () => {
		const ops = Array.from({ length: 15 }, (_, i) => ({ op: "+", kind: "task", target: "list", value: `T${i}` }));
		const e = parseExtraction(JSON.stringify({ ops }));
		expect(e.ops).toHaveLength(12);
		expect(e.rejected).toHaveLength(3);
	});
});

describe("applyRoutedOps", () => {
	test("adds goal, task, criterion and verbatim pin and reports the assigned ids", async () => {
		const { store } = fixture();
		const said = "Also support SSO. Never touch vendor/ and the login must be rate limited.";
		const out = await apply(store, [
			{ op: "+", kind: "goal", target: "list", value: "Support SSO" },
			{ op: "+", kind: "task", target: "2", value: "SSO adapter" },
			{ op: "+", kind: "criterion", target: "2", value: "SSO login works" },
			{ op: "+", kind: "pin", target: "list", value: "Never touch vendor/", pinKind: "constraint" },
		], said);
		expect(out.dropped).toEqual([]);
		expect(out.applied.map((a) => [a.kind, a.ref])).toEqual([["goal", "g2"], ["task", "2.1"], ["criterion", "c2"], ["pin", "p1"]]);
		const list = store.read("w");
		expect(list.goals?.map((g) => g.text)).toEqual(["Ship the store", "Support SSO"]);
		expect(list.pins?.[0]).toMatchObject({ text: "Never touch vendor/", source: "user" });
	});

	test("drops a pin that is not a quote of the message and a rename of a finished task, applying the rest", async () => {
		const { store } = fixture();
		runTasks(store, { action: "start", list: "w", id: "1" });
		runTasks(store, { action: "start", list: "w", id: "1.1" });
		runTasks(store, { action: "complete", list: "w", id: "1.1", report: { outcome: "x" } });
		const out = await apply(store, [
			{ op: "+", kind: "pin", target: "list", value: "Use TypeScript only", pinKind: "rule" },
			{ op: "~", kind: "task", target: "1.1", value: "Renamed" },
			{ op: "+", kind: "task", target: "list", value: "Docs" },
		], "Please add docs at the end.");
		expect(out.applied.map((a) => `${a.op}${a.kind}`)).toEqual(["+task"]);
		expect(out.dropped.map((d) => d.op.kind)).toEqual(["pin", "task"]);
		expect(out.dropped[0]!.reason).toMatch(/does not appear/);
		expect(store.read("w").tasks.map((t) => t.title)).toContain("Docs");
		expect(store.read("w").tasks.find((t) => t.id === "1.1")?.title).toBe("Draft");
	});

	test("drops operations on unknown ids instead of failing the batch", async () => {
		const { store } = fixture();
		const out = await apply(store, [
			{ op: "-", kind: "pin", target: "list", id: "p9" },
			{ op: "+", kind: "criterion", target: "9", value: "x" },
			{ op: "~", kind: "goal", target: "list", id: "g1", value: "Ship the store with SSO" },
		], "Ship the store with SSO");
		expect(out.dropped).toHaveLength(2);
		expect(out.applied.map((a) => a.ref)).toEqual(["g1"]);
		expect(store.read("w").goals?.[0]!.text).toBe("Ship the store with SSO");
	});

	test("drops a task and attaches a file by section", async () => {
		const { dir, store } = fixture();
		fs.writeFileSync(path.join(dir, "spec.md"), "# Spec\n\n## Interface\nget/set\n");
		const out = await apply(store, [
			{ op: "-", kind: "task", target: "2" },
			{ op: "+", kind: "attach", target: "1", value: "spec.md#Spec > Interface" },
		], "Drop the build, and use spec.md#Spec > Interface");
		expect(out.dropped).toEqual([]);
		expect(store.read("w").tasks.find((t) => t.id === "2")?.status).toBe("abandoned");
		expect(store.read("w").tasks.find((t) => t.id === "1")?.attachments?.[0]).toMatchObject({ path: "spec.md", anchor: { section: "Spec > Interface" } });
	});
});

describe("extraction context", () => {
	test("shows open tasks with item ids and finished tasks by title only", () => {
		const { store } = fixture();
		runTasks(store, { action: "start", list: "w", id: "1" });
		runTasks(store, { action: "start", list: "w", id: "1.1" });
		runTasks(store, { action: "complete", list: "w", id: "1.1", report: { outcome: "x" } });
		const ctx = routingContext(store.read("w")) as { doing: string[]; tasks: { id: string; criteria?: unknown; status: string }[] };
		expect(ctx.doing).toEqual(["1"]);
		expect(ctx.tasks.find((t) => t.id === "1.1")).toEqual({ id: "1.1", title: "Draft", status: "done" });
		expect(ctx.tasks.find((t) => t.id === "1")?.criteria).toEqual([{ id: "c1", text: "Reviewed" }]);
		expect(JSON.parse(extractionPrompt(store.read("w"), "last turn", "hello"))).toMatchObject({ agentLastTurn: "last turn", userMessage: "hello" });
	});
});

describe("createRouting", () => {
	test("prepares a prompt only with a list attached and applies a reply through the store", async () => {
		const { store } = fixture();
		let attached = true;
		const seen: string[] = [];
		const port = createRouting({
			attached: () => (attached ? { store, list: store.read("w") } : null),
			limits: () => PIN_LIMITS,
			applied: (slug, out) => seen.push(`${slug}:${out.applied.length}`),
		});
		const req = port.prepare("hello", "last turn");
		expect(req?.system).toContain("persistent task list");
		expect(JSON.parse(req!.prompt)).toMatchObject({ userMessage: "hello", agentLastTurn: "last turn" });
		const result = await port.apply('{"ops":[{"op":"+","kind":"pin","target":"list","value":"keep it small","pinKind":"rule"},{"op":"+","kind":"pin","target":"list","value":"made up","pinKind":"rule"}]}', "Please keep it small.");
		expect(result).toEqual({ ids: ["p1"], applied: 1, dropped: 1 });
		expect(seen).toEqual(["w:1"]);
		await expect(port.apply("not json", "x")).rejects.toThrow(/JSON/);
		attached = false;
		expect(port.prepare("hello", "")).toBeNull();
	});

	test("never ends a started task", async () => {
		const { store } = fixture();
		runTasks(store, { action: "start", list: "w", id: "2" });
		const out = await apply(store, [{ op: "-", kind: "task", target: "2" }], "drop the build");
		expect(out.applied).toEqual([]);
		expect(out.dropped[0]!.reason).toMatch(/agent ends started tasks/);
		expect(store.read("w").tasks.find((t) => t.id === "2")?.status).toBe("doing");
	});
});
