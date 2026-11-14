import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { FactLedger, LEDGER_ENTRY, ledgerChunks, ledgerData, ledgerOf, ownLedgerEntries, verifiedRows } from "./factLedger";
import { foldedTasks, recallView } from "./recallView";
import type { Block } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };
const TASK = "t:work/1";
const CODE = foldCode(TASK);

function blk(id: string, kind: Block["kind"], order: number, text: string, toolName?: string): Block {
	return { id, kind, turn: 1, order, text, tokens: Math.ceil(text.length / 4), override: null, autoFolded: false, by: null, ...(toolName ? { toolName } : {}) };
}

/** A folded task: a mount command, its output with the subvolume id, a commit. */
function session(): Truth {
	const blocks = [
		blk("u:0", "user", 0, "Provision the volume."),
		blk("a:r1:p0", "tool_call", 1, 'bash {"command":"findmnt /mnt/data"}', "bash"),
		blk("r:c1", "tool_result", 2, "/mnt/data /dev/nvme1n1p1[/@data] btrfs rw,noatime,subvolid=324,subvol=/@data", "bash"),
		blk("r:c2", "tool_result", 3, `[main 4dd3d08] feat(storage): add @data\n${"log line\n".repeat(2000)}`, "bash"),
		blk("u:9", "user", 4, "Next."),
	];
	const t = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 });
	t.setProtect(0);
	const ids = ["a:r1:p0", "r:c1", "r:c2"];
	expect(t.apply([{ kind: "group", ids, summary: `${foldTag(TASK)} volume provisioned`, handles: [{ id: TASK, memberIds: ids }] }], "auto").results[0].applied).toBe(true);
	return t;
}

describe("fact ledger", () => {
	it("omits entries of ledgered descendants, but not siblings or unledgered children", () => {
		const own = blk("own", "text", 1, "parent");
		const child = blk("child", "text", 2, "child value");
		const sibling = blk("sibling", "text", 3, "sibling value");
		const other = blk("other", "text", 4, "unledgered");
		const folded = [
			{ task: "work/1.2", entries: [child] },
			{ task: "work/10.2", entries: [sibling] },
			{ task: "work/1.3", entries: [other] },
		];
		const ledger = new FactLedger();
		ledger.set("work/1.2", []);
		ledger.set("work/10.2", []);
		const entries = ownLedgerEntries("work/1", [own, child, sibling, other], folded, ledger);
		expect(entries.map((b) => b.id)).toEqual(["own", "sibling", "other"]);
		expect(ledgerChunks(entries).chunks[0].prompt).not.toContain("child value");
	});

	it("keeps a row only when its value is verbatim in the entry it cites", () => {
		const truth = session();
		const [task] = foldedTasks(truth);
		expect(task).toMatchObject({ code: CODE, task: "work/1" });
		const { chunks, skipped } = ledgerChunks(task.entries);
		expect(skipped).toBe(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].prompt).toContain("--- entry 2 [tool_result bash]");
		const reply = `Here you go:\n${JSON.stringify({ rows: [
			{ key: "Btrfs subvolume id", value: "324", unit: "id", entry: 2 },
			{ key: "storage commit", value: "4dd3d08", unit: "commit", entry: 3 },
			{ key: "storage commit", value: "4dd3d08", unit: "commit", entry: 3 },
			{ key: "subvolume id reformatted", value: "subvolid 324", unit: "", entry: 2 },
			{ key: "commit cited from the wrong entry", value: "4dd3d08", unit: "", entry: 2 },
			{ key: "entry out of range", value: "324", unit: "", entry: 9 },
			{ key: "", value: "324", entry: 2 },
		] })}`;
		const rows = verifiedRows(reply, chunks[0], (id) => truth.get(id)?.text ?? "");
		expect(rows).toEqual([
			{ key: "Btrfs subvolume id", value: "324", unit: "id", blockId: "r:c1" },
			{ key: "storage commit", value: "4dd3d08", unit: "commit", blockId: "r:c2" },
		]);
		expect(verifiedRows("I could not find any facts.", chunks[0], () => "")).toBeNull();
		expect(verifiedRows('{"rows":[]}', chunks[0], () => "")).toEqual([]);
	});

	it("shows every entry whole, continues a long one as parts, skips task-tool entries and reads the first and last parts of a task too long for four prompts", () => {
		const long = blk("r:big", "tool_result", 1, `HEAD-MARK ${"x".repeat(60_000)} MIDDLE-MARK ${"x".repeat(60_000)} TAIL-MARK`, "bash");
		const tasks = blk("r:tasks", "tool_result", 2, '{"ok":true,"started":[{"id":"3"}]}', "tasks");
		const one = ledgerChunks([long, tasks]).chunks;
		expect(one.map((c) => c.prompt).join("")).toContain("MIDDLE-MARK");
		expect(one.flatMap((c) => c.ids)).toEqual(["r:big", "r:big", "r:big"]);
		expect(one[0].prompt).toContain("--- entry 1 [tool_result bash] (part 1 of 3)");
		expect(one.map((c) => c.prompt).join("")).not.toContain('"started"');
		// A value from a later part verifies against the whole block.
		const last = one[one.length - 1];
		expect(verifiedRows(JSON.stringify({ rows: [{ key: "marker", value: "MIDDLE-MARK", unit: "", entry: last.ids.length }] }), last, () => long.text)).toHaveLength(1);
		const many = Array.from({ length: 120 }, (_, i) => blk(`r:${i}`, "tool_result", i, `entry-${i} ${"y".repeat(5_900)}`, "bash"));
		const { chunks, skipped } = ledgerChunks(many);
		expect(chunks).toHaveLength(4);
		expect(skipped).toBeGreaterThan(0);
		expect(chunks[0].ids[0]).toBe("r:0");
		expect(chunks[3].ids.at(-1)).toBe("r:119");
		for (const c of chunks) expect(c.prompt.length).toBeLessThanOrEqual(24_000 * 4 + 100);
	});

	it("recall shows matching rows before hits, and alone when the transcript has other words", () => {
		const truth = session();
		const ledger = new FactLedger();
		ledger.set("work/1", [
			{ key: "Btrfs subvolume id", value: "324", unit: "id", blockId: "r:c1" },
			{ key: "storage commit", value: "4dd3d08", unit: "commit", blockId: "r:c2" },
		], "Provision volume");
		// "subvolume id" is the ledger's wording; the transcript only says `subvolid=324`.
		const byMeaning = recallView(truth, { codes: [], query: '"subvolume id"', facts: ledger.all() });
		expect(byMeaning.text).toContain(`Provision volume · Btrfs subvolume id: 324 (id)  #${CODE}.2`);
		// The task's title counts as part of each of its rows.
		expect(recallView(truth, { codes: [], query: "provision commit", facts: ledger.all() }).text).toContain("storage commit: 4dd3d08");
		expect(byMeaning.items[0].ids).toEqual(["r:c1"]);
		const both = recallView(truth, { codes: [CODE], query: "4dd3d08", facts: ledger.all() });
		expect(both.text.indexOf("storage commit: 4dd3d08")).toBeGreaterThan(0);
		expect(both.text.indexOf("storage commit: 4dd3d08")).toBeLessThan(both.text.indexOf(`#${CODE}.3  `));
		expect(recallView(truth, { codes: [], query: '"subvolume id"' }).text).toContain("No match");
		// A row of a block outside the searched fold is not shown.
		expect(recallView(truth, { codes: [`${CODE}.3`], query: '"subvolume id"', facts: ledger.all() }).text).toContain("No match");
	});

	it("round-trips through session entries; a later entry for a task replaces the earlier one", () => {
		const rows = [{ key: "port", value: "7880", unit: "port", blockId: "r:c1" }, { key: "path", value: "a/b.ts", blockId: "r:c2" }];
		const entries = [
			{ type: "custom", customType: LEDGER_ENTRY, data: ledgerData("work/1", [rows[0]]) },
			{ type: "custom", customType: "other", data: ledgerData("work/9", rows) },
			{ type: "custom", customType: LEDGER_ENTRY, data: { task: "work/2", rows: [["k", "", "", "r:c1"], "junk", ["k", "v", "", "r:c1"]] } },
			{ type: "custom", customType: LEDGER_ENTRY, data: ledgerData("work/1", rows, "Serve") },
		];
		const restored = ledgerOf(entries);
		expect(restored.get("work/1")).toEqual(rows.map((r) => ({ ...r, about: "Serve" })));
		expect(restored.get("work/2")).toEqual([{ key: "k", value: "v", blockId: "r:c1" }]);
		expect(restored.has("work/9")).toBe(false);
		const ledger = new FactLedger();
		ledger.reset(restored);
		expect(ledger.has("work/1")).toBe(true);
		expect(ledger.all()).toHaveLength(3);
	});
});
