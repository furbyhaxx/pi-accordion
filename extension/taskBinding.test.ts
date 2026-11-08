import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BINDING_ENTRY, agentNotice, previousBinding, resumeSituation } from "./taskBinding";
import { TaskStore, runTasks, taskFingerprint } from "./tasks";

const call = (id: string, args: Record<string, unknown>, at: string) => ({
	type: "message",
	timestamp: at,
	message: { role: "assistant", content: [{ type: "toolCall", id, name: "tasks", arguments: args }] },
});
const result = (id: string, at: string, isError = false) => ({ type: "message", timestamp: at, message: { role: "toolResult", toolCallId: id, toolName: "tasks", isError } });
const binding = (slug: string | null, at: string, fingerprint?: string) => ({ type: "custom", customType: BINDING_ENTRY, timestamp: at, data: { slug, fingerprint } });

function project() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "binding-"));
	return { dir, mine: new TaskStore(dir, () => "s1", () => "Mine"), other: new TaskStore(dir, () => "s2", () => "Other work") };
}

describe("task list binding", () => {
	test("infers the attached list from tool calls when no binding entry exists", () => {
		const entries = [
			call("c1", { action: "create", list: "a", title: "A", goals: ["G"] }, "2026-11-05T08:00:00.000Z"),
			result("c1", "2026-11-05T08:00:00.010Z"),
			call("c2", { action: "claim", list: "b" }, "2026-11-05T08:01:00.000Z"),
			result("c2", "2026-11-05T08:01:00.010Z", true),
			call("c3", { action: "start", list: "a", id: "1" }, "2026-11-05T08:02:00.000Z"),
			result("c3", "2026-11-05T08:02:00.010Z"),
		];
		expect(previousBinding(entries)).toEqual({ slug: "a", fingerprint: null, seenAt: "2026-11-05T08:02:00.010Z" });
		const released = [...entries, call("c4", { action: "release", list: "a" }, "2026-11-05T08:03:00.000Z"), result("c4", "2026-11-05T08:03:00.010Z")];
		expect(previousBinding(released)).toBeNull();
	});

	test("a binding entry overrides earlier tool calls, including detaching", () => {
		const entries = [call("c1", { action: "create", list: "a", title: "A", goals: ["G"] }, "2026-11-05T08:00:00.000Z"), result("c1", "2026-11-05T08:00:00.010Z")];
		expect(previousBinding([...entries, binding("b", "2026-11-05T08:05:00.000Z", "1:x")])).toEqual({ slug: "b", fingerprint: "1:x", seenAt: "2026-11-05T08:05:00.000Z" });
		expect(previousBinding([...entries, binding(null, "2026-11-05T08:05:00.000Z")])).toBeNull();
	});

	test("a list released at shutdown and untouched since resumes as free and unchanged", () => {
		const { mine } = project();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		const prev = { slug: "a", fingerprint: taskFingerprint(mine.read("a")), seenAt: new Date().toISOString() };
		mine.release("a");
		const s = resumeSituation(prev, mine.lists(), "s1");
		expect(s).toMatchObject({ kind: "free", changed: false });
		expect(agentNotice(s, { kind: "reclaimed", list: mine.read("a") })).toBeNull();
	});

	test("a list another session took over and changed is reported with its holder", () => {
		const { mine, other } = project();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		const prev = { slug: "a", fingerprint: taskFingerprint(mine.read("a")), seenAt: new Date().toISOString() };
		runTasks(other, { action: "claim", list: "a", force: true });
		runTasks(other, { action: "start", list: "a", id: "1" });
		const s = resumeSituation(prev, mine.lists(), "s1");
		expect(s).toMatchObject({ kind: "held", changed: true });
		expect(agentNotice(s, { kind: "without" })).toBe(
			'Your previous task list "a" is now claimed by session s2 "Other work"; you cannot change it from this session. The user chose to continue without a task list; claim or create one only if the user asks.',
		);
		const reclaimed = agentNotice(s, { kind: "reclaimed", list: other.read("a") });
		expect(reclaimed).toContain("changed since you last used it");
		expect(reclaimed).toContain("[~] 1 One");
	});

	test("without a fingerprint, only task writes after the session's last call count as changes", () => {
		const { mine } = project();
		runTasks(mine, { action: "create", list: "a", title: "A", goals: ["G"], tasks: [{ title: "One" }] });
		const seenAt = new Date().toISOString();
		const prev = { slug: "a", fingerprint: null, seenAt };
		expect(resumeSituation(prev, mine.lists(), "s1")).toMatchObject({ kind: "mine", changed: false });
		const old = { slug: "a", fingerprint: null, seenAt: new Date(Date.now() - 60_000).toISOString() };
		expect(resumeSituation(old, mine.lists(), "s1")).toMatchObject({ changed: true });
	});

	test("a deleted list resumes as missing and the agent hears what replaced it", () => {
		const { mine } = project();
		const created = mine.create("b", "Bee", ["G"], []);
		const s = resumeSituation({ slug: "a", fingerprint: null, seenAt: new Date().toISOString() }, mine.lists(), "s1");
		expect(s).toEqual({ kind: "missing", slug: "a" });
		expect(agentNotice(s, { kind: "created", list: created })).toBe(
			'Your previous task list "a" no longer exists. The user started a new empty task list "b" ("Bee") for this session. Add its tasks with action "add" before starting work.',
		);
	});
});
