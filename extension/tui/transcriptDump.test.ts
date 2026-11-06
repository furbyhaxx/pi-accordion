/*
 * transcriptDump.test.ts — the dump is a claim about what the wire carries, so every test pins the
 * parts a reader relies on: a folded span stands for its whole span (and says how many messages it
 * took off), an unfolded one keeps every block, body text is never shortened, and each format stays
 * parseable when the content fights it (`]]>` in XML, a fence in Markdown).
 */
import { describe, expect, it } from "bun:test";
import { foldTag } from "../../core/digest";
import type { TBlock, TGroup, TranscriptSource } from "./taskTranscript";
import {
	DUMP_FORMATS,
	dumpDocument,
	dumpFileName,
	formatOfPath,
	parseFormatSpec,
	renderDump,
	withExtension,
	type DumpFormat,
} from "./transcriptDump";

class Log {
	blocks: TBlock[] = [];
	private n = 0;
	private push(b: Omit<TBlock, "full" | "live">, tokens = 10): string {
		this.blocks.push({ ...b, full: tokens, live: tokens });
		return b.id;
	}
	user(text: string, tokens = 20): string {
		return this.push({ id: `u:${++this.n}`, kind: "user", text, turn: 1 }, tokens);
	}
	text(text: string, tokens = 20): string {
		return this.push({ id: `a:resp${++this.n}:p0`, kind: "text", text, turn: 1 }, tokens);
	}
	call(tool: string, args: Record<string, unknown>, out: string, tokens = 50): { call: string; result: string } {
		const c = `c${++this.n}`;
		this.push({ id: `a:resp${this.n}:p0`, kind: "thinking", text: `thinking about ${tool}`, turn: 2 }, 10);
		const call = this.push({ id: `a:resp${this.n}:p1`, kind: "tool_call", text: `${tool} ${JSON.stringify(args)}`, toolName: tool, callId: c, turn: 2 }, tokens);
		const result = this.push({ id: `r:${c}`, kind: "tool_result", text: out, toolName: tool, callId: c, turn: 2 }, tokens);
		return { call, result };
	}
	start(id: string, title: string) {
		return this.call("tasks", { action: "start", list: "l", id }, `Started l/${id} "${title}".`);
	}
	finish(id: string, outcome: string) {
		return this.call("tasks", { action: "complete", list: "l", id, report: { outcome } }, `l/${id} is done.`);
	}
	ids(from: string, to: string): string[] {
		const lo = this.blocks.findIndex((b) => b.id === from);
		const hi = this.blocks.findIndex((b) => b.id === to);
		return this.blocks.slice(lo, hi + 1).map((b) => b.id);
	}
	/** The block just before `id` — the same message's earlier part, as a group snap reaches it. */
	before(id: string): string {
		return this.blocks[this.blocks.findIndex((b) => b.id === id) - 1].id;
	}
}

/** One finished task: user, text, start, one work call, finish. */
function oneTask(): { log: Log; span: string[] } {
	const log = new Log();
	log.user("Do the thing", 30);
	log.text("On it.", 12);
	const start = log.start("1", "Parent");
	log.call("bash", { command: "ls" }, "a.txt", 60);
	const finish = log.finish("1", "listed the files");
	return { log, span: log.ids(start.call, finish.result) };
}

function folded(log: Log, span: string[], summary: string): TGroup {
	return { id: "g:span", memberIds: span, folded: true, summary, full: 400, live: 24 };
}

const source = (log: Log, groups: TGroup[] = []): TranscriptSource => ({ blocks: log.blocks, groups, verdict: () => undefined, threshold: null });

function doc(src: TranscriptSource, model = "test/model") {
	return dumpDocument({
		source: src,
		meta: { sessionId: "s-1", model },
		system: { tokens: 1000 },
		totals: { full: 1500, live: 900, budget: 800 },
		generatedAt: new Date(2025, 10, 6, 9, 56, 12),
	});
}

describe("transcript dump", () => {
	it("stands a folded span in as its record and counts the whole messages it removed", () => {
		const { log, span } = oneTask();
		const record = `${foldTag("g:span")} [task-record] l/1 "Parent"  status: done\noutcome: listed the files`;
		// Taskfold snaps a span outward to whole messages, so the group also holds the thinking block
		// that shares the `tasks start` call's message. That block is off the wire too.
		const members = [log.before(span[0]), ...span];
		const out = renderDump(doc(source(log, [folded(log, members, record)])), "tree");
		expect(out).toContain(`▣ l/1 "Parent"  done  ·  FOLDED  350 → 24 tok`);
		for (const line of record.split("\n")) expect(out).toContain(line);
		// start's message, start's result, work's message pair, finish's message pair: six on the wire.
		expect(out).toContain("6 messages elided (not on the wire)");
		expect(out).not.toContain("a.txt");
		expect(out).not.toContain("thinking about tasks");
		expect(out).toContain("├─ orientation  ·  42 tok");
	});

	it("keeps every block of an unfolded span and pairs each call with its result exactly once", () => {
		const { log } = oneTask();
		const out = renderDump(doc(source(log)), "tree");
		expect(out).toContain(`▣ l/1 "Parent"  done  ·  open  340 tok`);
		expect(out).toContain(`bash {"command":"ls"}`);
		expect(out.match(/a\.txt/g)).toHaveLength(1);
		expect(out).toContain("┆ → a.txt");
		expect(out).not.toContain("messages elided");
	});

	it("splits the regions before the first task and after the last into orientation and tail", () => {
		const { log } = oneTask();
		log.call("bash", { command: "tail -1 log" }, "last line", 40);
		const out = renderDump(doc(source(log)), "tree");
		const orientation = out.slice(0, out.indexOf("▣ l/1"));
		const plain = out.slice(out.indexOf("└─ tail"));
		expect(orientation).toContain("├─ orientation  ·  52 tok");
		expect(orientation).toContain("Do the thing");
		expect(orientation).not.toContain("bash");
		expect(plain).toContain("last line");
		expect(plain).toContain("tail -1 log");
	});

	it("accounts for every block exactly once, so no region drops or doubles the wire", () => {
		const log = new Log();
		log.user("before any task", 30);
		const first = log.start("1", "One");
		log.call("bash", { command: "ls" }, "a.txt", 60);
		const end = log.finish("1", "done");
		log.user("between the tasks", 22);
		log.text("on it", 8);
		const second = log.start("2", "Two");
		log.finish("2", "also done");
		log.call("bash", { command: "true" }, "", 12);
		const spanTwo = log.ids(second.call, log.blocks[log.blocks.length - 1].id);
		const group: TGroup = { id: "g:two", memberIds: spanTwo, folded: true, summary: `${foldTag("g:two")} [task-record] l/2 "Two"  status: done`, full: 300, live: 18 };
		const src = source(log, [group]);
		const body = doc(src);
		const inGroup = new Set(group.memberIds);
		const expected = log.blocks.filter((b) => !inGroup.has(b.id)).reduce((n, b) => n + b.live, 0) + group.live;
		const actual = [...body.orientation, ...body.body, ...body.tail].reduce((n, x) => n + x.tokens.live, 0);
		expect(actual).toBe(expected);
		// Work that happened between two tasks belongs to neither span, and must still be shown.
		expect(renderDump(body, "tree")).toContain("between the tasks");
		expect(renderDump(body, "flat")).toContain("between the tasks");
		expect(renderDump(body, "yaml")).toContain("between the tasks");
		expect(renderDump(body, "xml")).toContain("between the tasks");
		expect(renderDump(body, "md")).toContain("between the tasks");
	});

	it("writes body text whole, in every format", () => {
		const log = new Log();
		log.user(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
		const src = source(log);
		for (const format of DUMP_FORMATS) {
			const out = renderDump(doc(src), format);
			expect(out).not.toContain("…");
			expect(out).toContain("line 1");
			expect(out).toContain("line 40");
		}
	});

	it("keeps XML parseable when the content holds CDATA terminators and markup", () => {
		const log = new Log();
		log.user("a ]]> b <tag> & c");
		const out = renderDump(doc(source(log)), "xml");
		expect(out).toContain(`<![CDATA[a ]]]]><![CDATA[> b <tag> & c]]>`);
		expect(out).toContain(`session="s-1"`);
	});

	it("never lets Markdown body text close its own fence", () => {
		const log = new Log();
		log.user("before\n```\nblock\n```\nafter");
		const out = renderDump(doc(source(log)), "md");
		expect(out).toContain("````text");
		expect(out).toContain("````\n");
		const [, body] = out.split("````text");
		expect(body.split("\nafter\n")[0]).toContain("```");
	});

	it("prints one entry per wire block in flat order, with a folded span as one group row", () => {
		const { log, span } = oneTask();
		const record = `${foldTag("g:span")} [task-record] l/1 "Parent"  status: done`;
		const flat = renderDump(doc(source(log, [folded(log, span, record)])), "flat");
		const rows = flat.split("\n").filter((l) => /^\S/.test(l)).slice(1);
		expect(rows[0]).toStartWith("system");
		expect(rows.filter((r) => r.startsWith("GROUP (task record)"))).toHaveLength(1);
		expect(rows.filter((r) => r.startsWith("1:tool_call bash"))).toHaveLength(0);
		expect(flat).toContain(record);
	});

	it("names the default file after the session and local time, without a colon", () => {
		const at = new Date(2025, 10, 6, 9, 56, 12);
		for (const format of DUMP_FORMATS) {
			const name = dumpFileName("s-1", format, at);
			expect(name).toMatch(new RegExp(`^ses-s-1-taskfold-2025-11-06T09-56-12[+-]\\d{4}\\${format === "tree" ? ".txt" : format === "flat" ? ".log" : `.${format}`}$`));
		}
	});

	it("maps file names to formats, and replaces an extension when several formats share a stem", () => {
		expect(formatOfPath("a/b.md")).toBe("md");
		expect(formatOfPath("a/b.yml")).toBe("yaml");
		expect(formatOfPath("a/b.log")).toBe("flat");
		expect(formatOfPath("dump")).toBeNull();
		expect(formatOfPath("a.dir/dump")).toBeNull();
		expect(withExtension("out.xml", "yaml")).toBe("out.yaml");
		expect(withExtension("a.dir/dump", "md")).toBe("a.dir/dump.md");
	});

	it("parses a format list, expanding all and refusing the combinations it cannot honour", () => {
		const ok = (spec: string) => {
			const parsed = parseFormatSpec(spec);
			if ("error" in parsed) throw new Error(parsed.error);
			return parsed.formats;
		};
		expect(ok("all")).toEqual([...DUMP_FORMATS]);
		expect(ok("tree, yaml,tree")).toEqual(["tree", "yaml"]);
		expect(ok(" XML ")).toEqual(["xml"]);
		const bad = (spec: string): string => {
			const parsed = parseFormatSpec(spec);
			return "error" in parsed ? parsed.error : "";
		};
		expect(bad("html")).toContain(`Unknown format "html"`);
		expect(bad("all,tree")).toContain("cannot be combined");
		expect(bad(" , ")).toContain("Name at least one format");
	});

	it("reports a digest carrying no fold tag as untagged instead of inventing a code", () => {
		const log = new Log();
		const t = log.text("huge thinking", 500);
		const at = log.blocks.findIndex((b) => b.id === t);
		// A human digest is stored verbatim, untagged: the agent holds no handle for it.
		log.blocks[at] = { ...log.blocks[at], folded: true, digest: "my own words", live: 8 };
		const src = source(log);
		expect(renderDump(doc(src), "tree")).toContain("FOLDED (no code)");
		expect(renderDump(doc(src), "flat")).toContain("FOLDED (no code)");
		for (const format of ["xml", "yaml", "md"] as DumpFormat[]) expect(renderDump(doc(src), format)).not.toContain("null");
		expect(renderDump(doc(src), "md")).toContain("my own words");
	});

	it("marks a block folded on its own with the digest it rides as", () => {
		const log = new Log();
		const t = log.text("huge thinking", 500);
		const at = log.blocks.findIndex((b) => b.id === t);
		const tag = foldTag("x:1");
		log.blocks[at] = { ...log.blocks[at], folded: true, digest: `${tag} compressed`, live: 12 };
		for (const format of ["tree", "xml", "yaml", "md"] as DumpFormat[]) {
			expect(renderDump(doc(source(log)), format)).toContain("compressed");
		}
		const code = tag.slice(2, 8);
		expect(renderDump(doc(source(log)), "tree")).toContain(`FOLDED {#${code}}`);
		expect(renderDump(doc(source(log)), "xml")).toContain(`code="${code}"`);
	});
});
