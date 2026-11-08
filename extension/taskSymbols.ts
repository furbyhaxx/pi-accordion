import { createRequire } from "node:module";
import * as path from "node:path";
import type { Resolution } from "./taskAnchors";

/** Symbol anchors (SPEC-0002 §4.2): a declaration found by tree-sitter, dotted for nesting, with its doc comment. */

type Lang = "ts" | "tsx" | "js" | "py" | "rs";

const WASM: Record<Lang, string> = {
	ts: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	js: "tree-sitter-javascript.wasm",
	py: "tree-sitter-python.wasm",
	rs: "tree-sitter-rust.wasm",
};

/** The part of a tree-sitter node this module reads. */
interface Node {
	type: string;
	startIndex: number;
	endIndex: number;
	namedChildren: Node[];
	text: string;
	childForFieldName(name: string): Node | null;
}
interface Parser {
	parse(text: string): { rootNode: Node } | null;
}

const parsers = new Map<Lang, Parser>();
let runtime: Promise<void> | null = null;

/** The grammar a file's extension selects, or null when symbol anchors do not support it. */
export function symbolLang(file: string): Lang | null {
	const ext = /\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase();
	if (ext === "ts" || ext === "mts" || ext === "cts") return "ts";
	if (ext === "tsx" || ext === "jsx") return "tsx";
	if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
	if (ext === "py" || ext === "pyi") return "py";
	if (ext === "rs") return "rs";
	return null;
}

/** Load the parser runtime and the grammars of `files`. Idempotent; call before any `resolveSymbol`. */
export async function warmSymbols(files: readonly string[]): Promise<void> {
	const wanted = new Set(files.map(symbolLang).filter((l): l is Lang => l !== null && !parsers.has(l)));
	if (!wanted.size) return;
	const { Parser: P, Language } = (await import("web-tree-sitter")) as unknown as {
		Parser: { new (): Parser & { setLanguage(l: unknown): void }; init(): Promise<void> };
		Language: { load(p: string): Promise<unknown> };
	};
	runtime ??= P.init();
	await runtime;
	const dir = path.join(path.dirname(createRequire(import.meta.url).resolve("tree-sitter-wasms/package.json")), "out");
	for (const lang of wanted) {
		if (parsers.has(lang)) continue;
		const parser = new P();
		parser.setLanguage(await Language.load(path.join(dir, WASM[lang])));
		parsers.set(lang, parser);
	}
}

/** Declaration node types that carry a `name` field, per grammar family. */
const NAMED = new Set([
	"function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration", "interface_declaration",
	"type_alias_declaration", "enum_declaration", "method_definition", "method_signature", "abstract_method_signature",
	"public_field_definition", "property_signature", "function_signature", "internal_module", "module",
	"function_definition", "class_definition",
	"function_item", "struct_item", "enum_item", "trait_item", "mod_item", "const_item", "static_item", "type_item", "union_item", "function_signature_item",
]);
const WRAPPERS = new Set(["export_statement", "decorated_definition"]);
const DOC = new Set(["comment", "line_comment", "block_comment"]);

function nameOf(node: Node): string | null {
	if (NAMED.has(node.type)) return node.childForFieldName("name")?.text ?? null;
	if (node.type === "impl_item") {
		const t = node.childForFieldName("type");
		return t ? (t.childForFieldName("type")?.text ?? t.text) : null;
	}
	if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
		const names = node.namedChildren.filter((c) => c.type === "variable_declarator").map((c) => c.childForFieldName("name")?.text);
		return names.length === 1 ? (names[0] ?? null) : null;
	}
	return null;
}

/** Peel `export`/decorator wrappers: the declaration inside, and the wrapper that owns the leading text. */
function declarations(parent: Node): { decl: Node; outer: Node; name: string }[] {
	const out: { decl: Node; outer: Node; name: string }[] = [];
	for (const child of parent.namedChildren) {
		const inner = WRAPPERS.has(child.type) ? (child.childForFieldName("declaration") ?? child.childForFieldName("definition") ?? child.namedChildren.find((c) => nameOf(c) !== null)) : child;
		const name = inner ? nameOf(inner) : null;
		if (inner && name) out.push({ decl: inner, outer: child, name });
	}
	return out;
}

/** Members of a declaration: its `body`, or the declaration itself for grammars without one. */
function bodyOf(decl: Node): Node {
	return decl.childForFieldName("body") ?? decl;
}

/** Start of the comments directly above `node` (no blank line between), else its own start. */
function withDoc(text: string, node: Node, siblings: readonly Node[]): number {
	let start = node.startIndex;
	const index = siblings.indexOf(node);
	for (let i = index - 1; i >= 0 && DOC.has(siblings[i].type); i--) {
		const gap = text.slice(siblings[i].endIndex, start);
		if ((gap.match(/\n/g)?.length ?? 0) > 1) break;
		start = siblings[i].startIndex;
	}
	return start;
}

/**
 * Resolve `TokenStore.get` in a file's source. A name that several declarations share (overloads, a
 * Rust struct and its `impl`) resolves to all of them, each with its own text; an unknown name is lost
 * with the names found at that level as candidates.
 */
export function resolveSymbol(file: string, text: string, symbol: string): Resolution {
	const lang = symbolLang(file);
	if (!lang) return { lost: true };
	const parser = parsers.get(lang);
	if (!parser) throw new Error(`symbol grammar for ${file} is not loaded; await warmSymbols first`);
	const tree = parser.parse(text);
	if (!tree) return { lost: true };
	const segments = symbol.split(".").map((s) => s.trim()).filter(Boolean);
	if (!segments.length) return { lost: true };
	let containers: Node[] = [tree.rootNode];
	let pieces: string[] = [];
	for (const segment of segments) {
		const hits = containers.flatMap((container) => declarations(container).filter((d) => d.name === segment).map((d) => ({ ...d, siblings: container.namedChildren })));
		if (!hits.length) {
			const names = [...new Set(containers.flatMap((c) => declarations(c).map((d) => d.name)))];
			return { lost: true, ...(names.length ? { candidates: names.slice(0, 8) } : {}) };
		}
		pieces = hits.map((h) => text.slice(withDoc(text, h.outer, h.siblings), h.outer.endIndex));
		containers = hits.map((h) => bodyOf(h.decl));
	}
	return { content: pieces.join("\n\n") };
}

interface SymbolCarrier {
	attachments?: readonly { path: string; anchor?: unknown }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const symbolPaths = (items: unknown): string[] =>
	(Array.isArray(items) ? items : []).flatMap((i) => (isObject(i) && typeof i.symbol === "string" && typeof i.path === "string" ? [i.path.replace(/:\d+(?:-\d+)?$/, "")] : []));
const treePaths = (nodes: unknown): string[] =>
	(Array.isArray(nodes) ? nodes : []).flatMap((n) => (isObject(n) ? [...symbolPaths(n.attachments), ...treePaths(n.subtasks)] : []));

/** Files whose symbol anchors one `tasks` call resolves; their grammars must be loaded before the synchronous action runs. */
export function symbolFiles(args: { action?: string; items?: unknown; tasks?: unknown }, list: (SymbolCarrier & { tasks: readonly SymbolCarrier[] }) | null): string[] {
	if (args.action === "attach") return symbolPaths(args.items);
	if (args.action === "create" || args.action === "add") return treePaths(args.tasks);
	if ((args.action === "start" || args.action === "claim") && list)
		return [list, ...list.tasks].flatMap((h) => (h.attachments ?? []).flatMap((a) => (isObject(a.anchor) && "symbol" in a.anchor ? [a.path] : [])));
	return [];
}
