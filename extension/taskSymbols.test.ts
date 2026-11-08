import { beforeAll, expect, test } from "bun:test";
import { resolveSymbol, symbolLang, warmSymbols } from "./taskSymbols";

beforeAll(async () => {
	await warmSymbols(["a.ts", "a.py", "a.rs"]);
});

const TS = [
	"import x from 'y';",
	"",
	"/** Stores tokens. */",
	"export class TokenStore {",
	"\t/** Read one. */",
	"\tget(key: string): string | null {",
	"\t\treturn null;",
	"\t}",
	"\tset(key: string, value: string): void {}",
	"}",
	"",
	"// unrelated",
	"",
	"export function parse(a: string): number;",
	"export function parse(a: number): number;",
	"export function parse(a: any): number { return 1; }",
	"export const LIMIT = 5;",
].join("\n");

test("a TypeScript symbol resolves to its declaration with export and doc comment", () => {
	expect(resolveSymbol("a.ts", TS, "TokenStore")).toEqual({ content: TS.slice(TS.indexOf("/** Stores"), TS.indexOf("\n\n// unrelated")) });
	expect(resolveSymbol("a.ts", TS, "LIMIT")).toEqual({ content: "export const LIMIT = 5;" });
});

test("nested members resolve by dotted path, with the member's own doc comment only", () => {
	const r = resolveSymbol("a.ts", TS, "TokenStore.get");
	expect(r).toEqual({ content: "/** Read one. */\n\tget(key: string): string | null {\n\t\treturn null;\n\t}" });
});

test("editing a symbol's body or moving it does not matter while the declaration exists", () => {
	const edited = TS.replace("return null;", "return key;");
	expect(resolveSymbol("a.ts", edited, "TokenStore.get")).toMatchObject({ content: expect.stringContaining("return key;") });
	expect(resolveSymbol("a.ts", `// header\n${TS}`, "TokenStore.set")).toEqual({ content: "set(key: string, value: string): void {}" });
});

test("overloads resolve to the union of their sibling declarations", () => {
	const r = resolveSymbol("a.ts", TS, "parse") as { content: string };
	expect(r.content.startsWith("export function parse(a: string): number;")).toBe(true);
	expect(r.content.endsWith("{ return 1; }")).toBe(true);
});

test("a missing symbol is lost and names what exists at that level", () => {
	expect(resolveSymbol("a.ts", TS, "TokenStore.remove")).toEqual({ lost: true, candidates: ["get", "set"] });
	expect(resolveSymbol("a.ts", TS, "Nope")).toMatchObject({ lost: true, candidates: expect.arrayContaining(["TokenStore", "parse", "LIMIT"]) });
});

test("Python classes, decorated methods and Rust impl blocks resolve", () => {
	const py = "class Store:\n    @property\n    def size(self):\n        return 1\n\n    def get(self, k):\n        \"\"\"Read.\"\"\"\n        return k\n";
	expect(resolveSymbol("a.py", py, "Store.size")).toEqual({ content: "@property\n    def size(self):\n        return 1" });
	expect(resolveSymbol("a.py", py, "Store.get")).toMatchObject({ content: expect.stringContaining('"""Read."""') });
	const rs = "/// A store.\nstruct Store;\n\nimpl Store {\n    /// Read.\n    fn get(&self) -> u8 { 1 }\n}\n";
	expect(resolveSymbol("a.rs", rs, "Store")).toMatchObject({ content: expect.stringMatching(/\/\/\/ A store\.[\s\S]*impl Store/) });
	expect(resolveSymbol("a.rs", rs, "Store.get")).toEqual({ content: "/// Read.\n    fn get(&self) -> u8 { 1 }" });
});

test("unsupported files are lost rather than guessed, and the language follows the extension", () => {
	expect(resolveSymbol("notes.txt", "class A {}", "A")).toEqual({ lost: true });
	expect([symbolLang("a.mts"), symbolLang("a.jsx"), symbolLang("a.pyi"), symbolLang("a.md")]).toEqual(["ts", "tsx", "py", null]);
});

test("resolving before the grammar is loaded is an error, not a silent loss", () => {
	expect(() => resolveSymbol("a.js", "function a() {}", "a")).toThrow(/not loaded/);
});
