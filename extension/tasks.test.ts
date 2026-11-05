import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CLAIM_STALE_MS, TaskError, TaskStore, claimState, runTasks, slugFor, taskFingerprint } from "./tasks";

function store(session = "s1", dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"))) {
	return { dir, s: new TaskStore(dir, () => session) };
}

const report = { outcome: "Done." };

describe("tasks", () => {
	test("create persists a nested list under .pig/tasks and claims it", () => {
		const { dir, s } = store();
		runTasks(s, { action: "create", list: "auth", title: "Auth", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		const saved = JSON.parse(fs.readFileSync(path.join(dir, ".pig", "tasks", "auth.json"), "utf8"));
		expect(saved.tasks.map((t: { id: string }) => t.id)).toEqual(["1", "1.1", "1.2", "2"]);
		expect(saved.claim.session).toBe("s1");
	});

	test("only the innermost open branch may start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "start", list: "w", id: "2" })).toThrow(/still in progress/);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report })).toThrow(/Subtask 1.1/);
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		runTasks(s, { action: "complete", list: "w", id: "1", report });
		expect(runTasks(s, { action: "start", list: "w", id: "2" })).toContain("Started");
		const [one, , two] = s.read("w").tasks;
		expect(Date.parse(one.endedAt!)).toBeGreaterThanOrEqual(Date.parse(one.startedAt!));
		expect(two.startedAt).toBeString();
		expect(two.endedAt).toBeUndefined();
	});

	test("finishing requires a report within budget", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1" })).toThrow(TaskError);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report: { outcome: "x".repeat(601) } })).toThrow(/under 600/);
		expect(runTasks(s, { action: "fail", list: "w", id: "1", report: { outcome: "Blocked on API.", open: ["need key"] } })).toContain("failed");
	});

	test("another session's live claim blocks writes until forced", () => {
		const { dir, s } = store("s1");
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }] });
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "start", list: "w", id: "1" })).toThrow(/not claimed by this session/);
		expect(() => runTasks(other, { action: "claim", list: "w" })).toThrow(/claimed by another session/);
		runTasks(other, { action: "claim", list: "w", force: true });
		expect(runTasks(other, { action: "start", list: "w", id: "1" })).toContain("Started");
	});

	test("release rejects a foreign or absent claim without reporting success", () => {
		const { dir, s } = store();
		s.create("w", "W", []);
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
		expect(s.read("w").claim?.session).toBe("s1");
		expect(runTasks(s, { action: "release", list: "w" })).toBe('Released "w".');
		expect(s.read("w").claim).toBeNull();
		expect(() => runTasks(s, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
	});

	test("add numbers new tasks after existing siblings", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }] });
		expect(runTasks(s, { action: "add", list: "w", parent: "1", tasks: [{ title: "A2" }] })).toContain("1.2 A2");
		expect(runTasks(s, { action: "add", list: "w", tasks: [{ title: "B" }] })).toContain("2 B");
	});

	test("rejects path-like slugs", () => {
		const { s } = store();
		expect(() => runTasks(s, { action: "create", list: "../x", title: "X" })).toThrow(/Invalid list slug/);
	});

	test("claims carry the session name, and claim state ages from held to stale", () => {
		const { dir } = store();
		const s = new TaskStore(dir, () => "s1", () => "Auth work");
		const list = s.create("w", "W", [{ title: "A" }]);
		expect(list.claim).toMatchObject({ session: "s1", name: "Auth work" });
		const at = Date.parse(list.claim!.at);
		expect(claimState(list, "s1", at)).toBe("mine");
		expect(claimState(list, "s2", at + 1000)).toBe("held");
		expect(claimState(list, "s2", at + CLAIM_STALE_MS + 1)).toBe("stale");
		s.release("w");
		expect(claimState(s.read("w"), "s2")).toBe("free");
	});

	test("the fingerprint changes on task changes, not on claim changes", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }] });
		const before = taskFingerprint(s.read("w"));
		s.release("w");
		s.claim("w");
		expect(taskFingerprint(s.read("w"))).toBe(before);
		runTasks(s, { action: "add", list: "w", tasks: [{ title: "B" }] });
		expect(taskFingerprint(s.read("w"))).not.toBe(before);
	});

	test("slugFor derives a valid, unused slug", () => {
		expect(slugFor("Auth Refactor!", new Set())).toBe("auth-refactor");
		expect(slugFor("Auth Refactor", new Set(["auth-refactor", "auth-refactor-2"]))).toBe("auth-refactor-3");
		expect(slugFor("???", new Set())).toBe("tasks");
	});
});
