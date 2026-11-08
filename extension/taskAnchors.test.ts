import { expect, test } from "bun:test";
import { makeQuote, refOf, resolveQuote, resolveSection, similarity } from "./taskAnchors";

const DOC = [
	"# Auth",
	"intro",
	"## Token store",
	"store text",
	"### Interface",
	"```ts",
	"# not a heading",
	"```",
	"interface TokenStore {}",
	"### Notes",
	"notes text",
	"## Rollout",
	"Phase 1",
	"Appendix",
	"========",
	"setext body",
	"",
].join("\n");

test("a section resolves to its heading and body up to the next heading of the same or higher level", () => {
	const r = resolveSection(DOC, "Token store > Interface");
	expect(r).toEqual({ content: "### Interface\n```ts\n# not a heading\n```\ninterface TokenStore {}" });
	expect(resolveSection(DOC, "Token store")).toMatchObject({ content: expect.stringContaining("### Notes") });
});

test("a heading path matches as a suffix and headings inside code fences are ignored", () => {
	expect(resolveSection(DOC, "Interface")).toMatchObject({ content: expect.stringContaining("interface TokenStore") });
	expect(resolveSection(DOC, "Appendix")).toEqual({ content: "Appendix\n========\nsetext body" });
	expect(resolveSection(DOC, "not a heading")).toMatchObject({ lost: true });
});

test("editing inside a section or moving it keeps the anchor valid; deleting its heading loses it with candidates", () => {
	const edited = DOC.replace("interface TokenStore {}", "interface TokenStore { get(): void }");
	expect(resolveSection(edited, "Token store > Interface")).toMatchObject({ content: expect.stringContaining("get(): void") });
	const moved = ["# Elsewhere", ...DOC.split("\n").slice(2)].join("\n");
	expect(resolveSection(moved, "Token store > Interface")).toMatchObject({ content: expect.stringContaining("interface TokenStore") });
	const renamed = DOC.replace("### Interface", "### Contract");
	expect(resolveSection(renamed, "Token store > Interface")).toEqual({ lost: true });
	const found = resolveSection(DOC.replace("### Interface", "### Interface details"), "Token store > Interface");
	expect(found).toMatchObject({ lost: true, candidates: ["Auth > Token store > Interface details"] });
});

test("a repeated heading path is ambiguous rather than silently picking one", () => {
	const dup = "# A\n## Same\none\n# B\n## Same\ntwo\n";
	expect(resolveSection(dup, "Same")).toMatchObject({ lost: true, candidates: ["A > Same", "B > Same"] });
	expect(resolveSection(dup, "B > Same")).toEqual({ content: "## Same\ntwo" });
});

const FILE = "line one\nfunction get(key) {\n  return store[key];\n}\nline five\n";

test("a quote resolves exactly in place, as moved when it shifted, as fuzzy when edited, else lost", () => {
	const start = FILE.indexOf("function get");
	const q = makeQuote(FILE, start, FILE.indexOf("}\nline five") + 1);
	expect(resolveQuote(FILE, q)).toEqual({ content: q.exact });
	expect(resolveQuote(`new header\nmore\n${FILE}`, q)).toEqual({ content: q.exact, state: "moved" });
	const edited = FILE.replace("return store[key];", "return store.get(key);");
	const fuzzy = resolveQuote(edited, q);
	expect(fuzzy).toMatchObject({ state: "fuzzy", content: expect.stringContaining("store.get(key)") });
	expect(resolveQuote("nothing related here at all\n", q)).toEqual({ lost: true });
});

test("a fuzzy match needs similar text: a rewritten block is lost, not guessed", () => {
	const q = makeQuote(FILE, FILE.indexOf("function get"), FILE.indexOf("}\nline five") + 1);
	expect(resolveQuote("line one\nconst totallyDifferent = 42;\nline five\n", q)).toEqual({ lost: true });
	expect(similarity("abcdef", "abcdef")).toBe(1);
	expect(similarity("a", "b")).toBe(0);
});

test("canonical refs name the anchor, never a line number", () => {
	expect(refOf("docs/auth.md", { section: "Token store > Interface" })).toBe("docs/auth.md#Token store > Interface");
	expect(refOf("src/store.ts", { symbol: "TokenStore.get" })).toBe("src/store.ts::TokenStore.get");
	expect(refOf("src/store.ts", { quote: makeQuote(FILE, 0, 8) }, "q1")).toBe("src/store.ts@q:q1");
	expect(refOf("README.md", undefined)).toBe("README.md");
});
