import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PIN_LIMITS } from "./taskPins";
import { applyRoutedOps, createRouting, extractionPrompt, parseExtraction, routingContext, type RoutedOp } from "./taskRouting";
import { TaskStore, runTasks } from "./tasks";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-"));
	dirs.push(dir);
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

	test("takes the first balanced object from prose without treating quoted braces as structure", () => {
		const object = { ops: [{ op: "+", kind: "goal", target: "list", value: 'Keep {braces}, "quotes" and \\paths' }] };
		const result = parseExtraction(`Here is the extraction:\n\`\`\`json\n${JSON.stringify(object)}\n\`\`\`\nDone. {"ops":[]}`);
		expect(result.ops[0]?.value).toBe(object.ops[0].value);
		expect(() => parseExtraction('Reply: {"ops":[{"value":"unterminated}')).toThrow(/did not return JSON/);
		expect(() => parseExtraction('Reply: {oops} then {"ops":[]}')).toThrow(/did not return JSON/);
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


	test("reuses identical goals and criteria, including facts added while extraction was running", async () => {
		const { store } = fixture();
		const out = await apply(store, [
			{ op: "+", kind: "goal", target: "list", value: "Ship the store" },
			{ op: "+", kind: "criterion", target: "1", value: "Reviewed" },
			{ op: "+", kind: "goal", target: "list", value: "Support SSO" },
			{ op: "+", kind: "goal", target: "list", value: "Support SSO" },
		], "Ship the store. Support SSO.");
		expect(store.read("w").goals?.map((g) => g.text)).toEqual(["Ship the store", "Support SSO"]);
		expect(store.read("w").tasks[0].acceptanceCriteria).toHaveLength(1);
		expect(out.applied.map((o) => o.ref)).toEqual(["g2"]);
		expect(out.retained.map((o) => o.ref)).toEqual(["g1", "c1", "g2"]);
		expect(out.dropped).toEqual([]);

		let notices = 0;
		const port = createRouting({ attached: () => ({ store, list: store.read("w") }), limits: () => PIN_LIMITS, applied: () => { notices++; }, dropped: () => {} });
		const request = port.prepare("Also support passkeys", "")!;
		runTasks(store, { action: "update", list: "w", goals: { add: ["Support passkeys"] } });
		const result = await request.apply('{"ops":[{"op":"+","kind":"goal","target":"list","value":"Support passkeys"}]}', "Also support passkeys");
		expect(result).toEqual({ ids: ["g3"], applied: 0, dropped: 0 });
		expect(store.read("w").goals).toHaveLength(3);
		expect(notices).toBe(0);
	});
	test("drops a pin that is not a quote of the message and a rename of a finished task, applying the rest", async () => {
		const { store } = fixture();
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
		const lost: string[] = [];
		const port = createRouting({
			attached: () => (attached ? { store, list: store.read("w") } : null),
			limits: () => PIN_LIMITS,
			applied: (slug, out) => seen.push(`${slug}:${out.applied.length}`),
			dropped: (slug, dropped) => lost.push(...dropped.map((d) => `${slug}:${d.op.kind}:${d.reason}`)),
		});
		const req = port.prepare("Please keep it small.", "last turn");
		expect(req?.system).toContain("persistent task list");
		expect(JSON.parse(req!.prompt)).toMatchObject({ userMessage: "Please keep it small.", agentLastTurn: "last turn" });
		const result = await req!.apply('{"ops":[{"op":"+","kind":"pin","target":"list","value":"keep it small","pinKind":"rule"},{"op":"+","kind":"pin","target":"list","value":"made up","pinKind":"rule"}]}', "Please keep it small.");
		expect(result).toEqual({ ids: ["p1"], applied: 1, dropped: 1 });
		expect(seen).toEqual(["w:1"]);
		expect(lost).toHaveLength(1);
		expect(lost[0]).toMatch(/^w:pin:.*does not appear/);
		// A reply whose every operation is refused changes nothing, and is still reported.
		await req!.apply('{"ops":[{"op":"+","kind":"criterion","target":"9","value":"x"}]}', "Please keep it small.");
		expect(seen).toEqual(["w:1"]);
		expect(lost).toHaveLength(2);
		await expect(req!.apply("not json", "x")).rejects.toThrow(/JSON/);
		attached = false;
		expect(port.prepare("hello", "")).toBeNull();
	});

	test("does not apply an in-flight reply to a replacement list or session", async () => {
		for (const replacement of ["list", "store", "detached"] as const) {
			const { store } = fixture();
			let attached: { store: TaskStore; list: ReturnType<TaskStore["read"]> } | null = { store, list: store.read("w") };
			const port = createRouting({ attached: () => attached, limits: () => PIN_LIMITS, applied: () => {}, dropped: () => {} });
			const request = port.prepare("Keep the API stable", "")!;
			if (replacement === "list") {
				runTasks(store, { action: "create", list: "next", title: "Next", goals: ["Next goal"], tasks: [] });
				attached = { store, list: store.read("next") };
			} else if (replacement === "store") {
				const next = fixture();
				attached = { store: next.store, list: next.store.read("w") };
			} else attached = null;
			await expect(request.apply('{"ops":[{"op":"+","kind":"goal","target":"list","value":"Keep the API stable"}]}', "Keep the API stable")).rejects.toThrow(/list changed/);
			expect(store.read("w").goals?.map((g) => g.text)).toEqual(["Ship the store"]);
			if (attached) expect(attached.store.read(attached.list.slug).goals).toHaveLength(1);
		}
	});

	test("checks the binding after asynchronous grammar warming and before any writes", async () => {
		const { store } = fixture();
		let attached = true;
		const port = createRouting({ attached: () => attached ? { store, list: store.read("w") } : null, limits: () => PIN_LIMITS, applied: () => {}, dropped: () => {} });
		const request = port.prepare("Keep the API stable", "")!;
		const pending = request.apply('{"ops":[{"op":"+","kind":"goal","target":"list","value":"Keep the API stable"}]}', "Keep the API stable");
		attached = false;
		await expect(pending).rejects.toThrow(/list changed/);
		expect(store.read("w").goals).toHaveLength(1);
	});

	test("never ends a started task", async () => {
		const { store } = fixture();
		// "Build" only becomes next once the draft leaf is done, so start it there.
		runTasks(store, { action: "start", list: "w", id: "1.1" });
		runTasks(store, { action: "complete", list: "w", id: "1.1", report: { outcome: "x" } });
		runTasks(store, { action: "start", list: "w", id: "2" });
		const out = await apply(store, [{ op: "-", kind: "task", target: "2" }], "drop the build");
		expect(out.applied).toEqual([]);
		expect(out.dropped[0]!.reason).toMatch(/agent ends started tasks/);
		expect(store.read("w").tasks.find((t) => t.id === "2")?.status).toBe("doing");
	});
});
