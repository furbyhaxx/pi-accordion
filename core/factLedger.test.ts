import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { FactLedger, LEDGER_ENTRY, ledgerChunks, ledgerData, ledgerOf, verifiedRows } from "./factLedger";
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

	it("shows a long entry by its two ends and reads the first and last parts of a task too long for four prompts", () => {
		const long = blk("r:big", "tool_result", 1, `HEAD-MARK ${"x".repeat(20_000)} TAIL-MARK`, "bash");
		const one = ledgerChunks([long]).chunks[0].prompt;
		expect(one).toContain("HEAD-MARK");
		expect(one).toContain("TAIL-MARK");
		expect(one.length).toBeLessThan(7_000);
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
		]);
		// "subvolume id" is the ledger's wording; the transcript only says `subvolid=324`.
		const byMeaning = recallView(truth, { codes: [], query: '"subvolume id"', facts: ledger.all() });
		expect(byMeaning.text).toContain(`Btrfs subvolume id: 324 (id)  #${CODE}.2`);
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
			{ type: "custom", customType: LEDGER_ENTRY, data: ledgerData("work/1", rows) },
		];
		const restored = ledgerOf(entries);
		expect(restored.get("work/1")).toEqual(rows);
		expect(restored.get("work/2")).toEqual([{ key: "k", value: "v", blockId: "r:c1" }]);
		expect(restored.has("work/9")).toBe(false);
		const ledger = new FactLedger();
		ledger.reset(restored);
		expect(ledger.has("work/1")).toBe(true);
		expect(ledger.all()).toHaveLength(3);
	});
});
