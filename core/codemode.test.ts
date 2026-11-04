import { describe, expect, it } from "vitest";
import { codemodeScriptCalls, codemodeSummary, parseCodemodeOutput, parseCodemodeResult, readableToolText, renderCodemode } from "./codemode";

const call = (code: string) => `codemode ${JSON.stringify({ code })}`;

describe("codemodeScriptCalls", () => {
	it("recovers literal paths, commands and ranges in script order, ignoring comments and strings", () => {
		const script = `// tools.read({path: "wrong.ts"})
const s = "tools.read({path: 'wrong2.ts'})";
const [a, b] = await Promise.allSettled([
  tools.read({ path: "src/a.ts", offset: 10, limit: 20 }),
  tools.bash({ command: 'git status --short' }),
]);
text(await tools.grep({ pattern: "x", path: "src" }));
text(await tools.read("README.md"));
text(await tools.read({ path: \`src/\${name}.ts\` }));`;
		expect(codemodeScriptCalls(script)).toEqual([
			{ tool: "read", path: "src/a.ts", ranged: true },
			{ tool: "bash", command: "git status --short", ranged: false },
			{ tool: "grep", path: "src", ranged: false },
			{ tool: "read", path: "README.md", ranged: false },
			{ tool: "read", ranged: false },
		]);
	});

	it("treats explicit null ranges as whole-file reads", () => {
		expect(codemodeScriptCalls(`tools.read({path: "a.ts", offset: null, limit: undefined})`)).toEqual([{ tool: "read", path: "a.ts", ranged: false }]);
	});
});

describe("parseCodemodeOutput", () => {
	const header = "Script completed\nWall time 0.3 seconds\nOutput:\n";

	it("unwraps JSON envelopes and associates sections through their i field", () => {
		const calls = codemodeScriptCalls(`tools.read({path: "AGENTS.md"}); tools.bash({command: "ls"});`);
		const output = `${header}==> text 1/2 <==\n${JSON.stringify({ i: 1, result: { status: "fulfilled", value: "a\nb" } })}\n==> text 2/2 <==\n${JSON.stringify({ i: 0, result: { status: "rejected", reason: "ENOENT" } })}\n\n[Full output: /tmp/x.txt (read with offset/limit)]`;
		const out = parseCodemodeOutput(output, calls);
		expect(out?.preamble).toBe(header);
		expect(out?.postamble).toContain("[Full output: /tmp/x.txt");
		expect(out?.sections).toEqual([
			expect.objectContaining({ index: 0, text: "a\nb", failed: false, call: { tool: "bash", command: "ls", ranged: false } }),
			expect.objectContaining({ index: 1, text: "ENOENT", failed: true, call: { tool: "read", path: "AGENTS.md", ranged: false } }),
		]);
	});

	it("treats unmarked output as one section and maps by position only when counts match", () => {
		const one = parseCodemodeResult(`${header}plain text`, call(`text(await tools.read({path: "a.ts"}))`));
		expect(one?.sections).toEqual([{ index: 0, raw: "plain text", text: "plain text", failed: false, call: { tool: "read", path: "a.ts", ranged: false } }]);
		const mismatch = parseCodemodeResult(`${header}==> text 1/2 <==\nx\n==> text 2/2 <==\ny`, call(`tools.read({path: "a.ts"})`));
		expect(mismatch?.sections.map((s) => s.call)).toEqual([undefined, undefined]);
	});

	it("rejects text that is not a completed codemode result", () => {
		expect(parseCodemodeOutput("Script failed: SyntaxError", [])).toBeNull();
	});
});

describe("rendering", () => {
	it("labels decoded sections and summarizes the run", () => {
		const callText = call(`tools.read({path: "a.ts"}); tools.bash({command: "npm test -- --run"});`);
		const result = `Script completed\nOutput:\n==> text 1/2 <==\n"export const a = 1;"\n==> text 2/2 <==\npass`;
		expect(readableToolText(result, "codemode", callText)).toBe("==> 1/2 · read a.ts <==\nexport const a = 1;\n==> 2/2 · bash npm test -- --run <==\npass");
		expect(readableToolText("raw", "bash", undefined)).toBe("raw");
		const out = parseCodemodeResult(result, callText);
		if (!out) throw new Error("parse failed");
		expect(renderCodemode(out, (s) => `${s.text.length}`)).toBe("==> 1/2 · read a.ts <==\n19\n==> 2/2 · bash npm test -- --run <==\n4");
		expect(codemodeSummary(codemodeScriptCalls(`tools.read({path:"a"}); tools.read({path:"b"}); tools.bash({command:"c"})`), 2)).toBe("codemode: read a · read b · +1 more");
	});
});
