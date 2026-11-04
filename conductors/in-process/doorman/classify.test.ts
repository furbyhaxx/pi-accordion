/*
 * classify.test.ts — a pinning subset of the deleted `app/src/lib/engine/classify.test.ts`
 * (ADR 0016, git rev dc037bc), ported to lock down that the VERBATIM port in `classify.ts`
 * still gates exactly like the original: accepts a real TS/Python code read, rejects a
 * data-extension (JSON) read and a grep dump. Not exhaustive — see the original for the
 * full reject-gate matrix (directory targets, follow streams, piped/chained/multi-file
 * commands, no-extension JSON/YAML, …); this file exists to pin the port, not re-litigate it.
 */
import { describe, it, expect } from "vitest";
import { parseCodemodeResult } from "../../../core/codemode";
import { classifyCodeRead, classifyCodemodeRead } from "./classify";
import { compactCodemode } from "./codemode";
import type { ViewBlock } from "../../../core/conductor/contract";

// ───────────────────────── builders (ported from the reference test file) ─────────────────

let nextId = 0;
function freshId(prefix: string): string {
	return `${prefix}${nextId++}`;
}

/** Build a tool_call ViewBlock. `text` is "<name> <JSON args>". */
function call(toolName: string, args: Record<string, unknown>): ViewBlock {
	const id = freshId("call:");
	return {
		id,
		kind: "tool_call",
		turn: 0,
		order: 0,
		tokens: 10,
		foldedTokens: 10,
		toolName,
		callId: id,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		sent: false,
		text: `${toolName} ${JSON.stringify(args)}`,
	};
}

/** Build a tool_result ViewBlock linked to `c` (or standalone if `c` is undefined). */
function result(output: string, opts: { toolName?: string; callId?: string; isError?: boolean; tokens?: number } = {}): ViewBlock {
	const tokens = opts.tokens ?? Math.ceil(output.length / 4);
	return {
		id: freshId("res:"),
		kind: "tool_result",
		turn: 0,
		order: 1,
		tokens,
		foldedTokens: tokens,
		toolName: opts.toolName ?? "tool",
		callId: opts.callId,
		isError: opts.isError,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		sent: false,
		text: output,
	};
}

/** Pair a call + result and return { res, map } ready for classifyCodeRead. */
function pair(c: ViewBlock, output: string, opts: { toolName?: string; isError?: boolean } = {}): { res: ViewBlock; map: Map<string, ViewBlock> } {
	const res = result(output, { toolName: opts.toolName ?? c.toolName, callId: c.callId, isError: opts.isError });
	const map = new Map<string, ViewBlock>([[c.callId!, c]]);
	return { res, map };
}

/** Prefix every non-empty line with a right-aligned `<n>\t` (Claude-Code cat -n style). */
function withLineNumbers(body: string): string {
	const lines = body.split("\n");
	return lines
		.map((line, idx) => {
			const n = String(idx + 1).padStart(5, " ");
			return `${n}\t${line}`;
		})
		.join("\n");
}

const TS_BODY = `import { foo } from "./foo";

export interface Widget {
  id: string;
  size: number;
}

export function build(w: Widget): string {
  const parts: string[] = [];
  for (let i = 0; i < w.size; i++) {
    parts.push(w.id + ":" + i);
  }
  return parts.join(",");
}
`;

const PY_BODY = `import os


class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return "hello " + self.name


def main():
    g = Greeter("world")
    print(g.greet())
`;

// ───────────────────────── ACCEPT cases ─────────────────────────

describe("classifyCodeRead — accepts real code reads", () => {
	it("CC Read of a .ts file with cat -n line-number prefixes → strips prefixes, recovers path", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("/abs/src/widget.ts");
		// The N\t prefix must be gone, but the actual body line survives.
		expect(info!.source).toContain("export function build(w: Widget): string {");
		expect(info!.source).not.toMatch(/^\s*\d+\texport function build/m);
	});

	it("pi read of a .py file → accepts, path from args.path", () => {
		const c = call("read", { path: "src/greeter.py" });
		const { res, map } = pair(c, PY_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/greeter.py");
		expect(info!.source).toContain("class Greeter:");
	});
});

// ───────────────────────── REJECT cases ─────────────────────────

describe("classifyCodeRead — rejects non-code reads", () => {
	it("Read of package.json → null (data extension)", () => {
		const c = call("Read", { file_path: "/repo/package.json" });
		const jsonBody = `{\n  "name": "thing",\n  "version": "1.0.0",\n  "dependencies": { "x": "^1.0.0" }\n}\n`;
		const { res, map } = pair(c, jsonBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Bash `grep -R foo src/` dump → null (search, not a single-file read)", () => {
		const c = call("Bash", { command: "grep -R foo src/" });
		const grepDump = ["src/a.ts:12:  const foo = 1;", "src/b.ts:48:function foo() {}", "src/c.ts:3:// foo here"].join("\n");
		const { res, map } = pair(c, grepDump);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("an errored tool_result → null", () => {
		const c = call("Read", { file_path: "/repo/widget.ts" });
		const { res, map } = pair(c, TS_BODY, { isError: true });
		expect(classifyCodeRead(res, map)).toBeNull();
	});
});

describe("codemode result classification", () => {
	it("accepts a single code read and strips tool headers and line numbers", () => {
		const c = call("codemode", { code: `text(await tools.read({ path: "src/widget.ts" }));` });
		const output = `Script completed\nWall time 0.3 seconds\nOutput:\n\n==> text 1/1 <==\nWall time: 0.1s\nOutput:\n${withLineNumbers(TS_BODY)}`;
		const { res, map } = pair(c, output);
		expect(classifyCodeRead(res, map)).toEqual({ path: "src/widget.ts", source: TS_BODY });
	});

	it("leaves a multi-read result to per-section compaction, skeletonizing each code read", () => {
		const c = call("codemode", { code: `const a = await tools.read({path: 'src/a.ts'});\nconst b = await tools.read({path: "src/b.py"});\ntext(a); text(b);` });
		const { res, map } = pair(c, `Script completed\nWall time 0.3 seconds\nOutput:\n\n==> text 1/2 <==\n${TS_BODY}\n==> text 2/2 <==\n${PY_BODY}`);
		expect(classifyCodeRead(res, map)).toBeNull();
		const sections = parseCodemodeResult(res.text, c.text)?.sections ?? [];
		expect(sections.map((s) => classifyCodemodeRead(s.call?.tool, s.call?.path, s.text))).toEqual([
			{ path: "src/a.ts", source: TS_BODY },
			{ path: "src/b.py", source: PY_BODY },
		]);
		const compact = compactCodemode(res.text, c.text, { skeleton: (path) => `skeleton of ${path}` });
		expect(compact?.skeletons).toBe(2);
		expect(compact?.content).toContain("==> 1/2 · read src/a.ts <==\nskeleton of src/a.ts");
	});

	it("never classifies bash, grep or unknown tools as code reads", () => {
		for (const code of [`text(await tools.bash({ command: 'cat src/a.ts' }));`, `text(await tools.grep({ path: 'src/widget.ts', pattern: 'function' }));`, `text(await tools.ls({path: 'src/a.ts'}));`]) {
			const single = pair(call("codemode", { code }), `==> text 1/1 <==\n${TS_BODY}`);
			expect(classifyCodeRead(single.res, single.map)).toBeNull();
		}
	});

	it("does not infer a path from a dynamic expression", () => {
		const c = call("codemode", { code: `text(await tools.read({path: 'src/base.ts' + suffix}));` });
		const { res, map } = pair(c, `==> text 1/1 <==\n${TS_BODY}`);
		expect(parseCodemodeResult(res.text, c.text)?.sections[0]?.call).toEqual({ tool: "read", ranged: false });
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("unwraps JSON-printed results before classifying", () => {
		const c = call("codemode", { code: `text(JSON.stringify({i: 0, result: await tools.read({path: 'src/widget.ts'})}));` });
		const { res, map } = pair(c, `Script completed\nOutput:\n${JSON.stringify({ i: 0, result: { status: "fulfilled", value: TS_BODY } })}`);
		expect(classifyCodeRead(res, map)).toEqual({ path: "src/widget.ts", source: TS_BODY });
	});

	it("rejects non-codemode outputs and paths without code extensions", () => {
		const c = call("codemode", { code: `text(await tools.read({path: 'README'}));` });
		expect(classifyCodeRead(pair(c, TS_BODY).res, pair(c, TS_BODY).map)).toBeNull();
		const numbered = pair(c, `==> text 1/1 <==\n${TS_BODY}`);
		expect(classifyCodeRead(numbered.res, numbered.map)).toBeNull();
	});
});

// ───────────────────────── determinism ─────────────────────────

describe("classifyCodeRead — determinism", () => {
	it("classifying the same inputs twice yields equal results", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		expect(classifyCodeRead(res, map)).toEqual(classifyCodeRead(res, map));
	});
});
