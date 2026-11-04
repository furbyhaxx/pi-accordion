/**
 * Codemode tool results, parsed for conductors: the script's nested tool calls and the text items
 * it printed. Pure and deterministic; every parse is best effort and returns null or `undefined`
 * fields rather than guessing.
 */

/** One nested `tools.<name>(…)` call recovered from a codemode script. */
export interface CodemodeCall {
	/** Lowercased tool name as written in the script. */
	tool: string;
	/** String-literal `path` / `file_path` / `filePath` argument, or a leading string argument. */
	path?: string;
	/** String-literal `command` argument. */
	command?: string;
	/** An `offset`/`limit`/line-range argument was passed, so a read covered only part of a file. */
	ranged: boolean;
}

/** One text item the script printed, decoded. */
export interface CodemodeSection {
	/** 0-based position among the printed text items. */
	index: number;
	/** The item exactly as printed. */
	raw: string;
	/** The payload: a JSON envelope's string value unwrapped, else `raw`. */
	text: string;
	/** The envelope reports a rejected or failed call. */
	failed: boolean;
	/** The nested call that produced it, when the association is unambiguous. */
	call?: CodemodeCall;
}

/** A codemode result split around its text items. */
export interface CodemodeOutput {
	/** Everything before the first item ("Script completed", wall time, truncation notes). */
	preamble: string;
	sections: CodemodeSection[];
	/** Everything after the last item, such as the full-output file pointer. */
	postamble: string;
}

const MARKER = /^==> text (\d+)\/(\d+) <==\r?$/gm;
const OUTPUT_HEADER = /^Output:\r?\n/m;
const FULL_OUTPUT = /\r?\n\[Full output: [^\]\n]+\]\s*$/;
const PAYLOAD_KEYS = ["value", "output", "stdout", "content", "text", "result"] as const;

/** Is this tool the codemode script runner? */
export function isCodemodeTool(toolName: string | undefined, callText?: string): boolean {
	const own = toolName?.trim().toLowerCase();
	if (own && own !== "tool") return own === "codemode";
	return callText?.trimStart().match(/^([^\s{]+)/)?.[1]?.toLowerCase() === "codemode";
}

/** The `code` argument of a codemode tool_call block's text (`codemode {"code": …}`). */
export function codemodeScript(callText: string | undefined): string | undefined {
	if (typeof callText !== "string") return undefined;
	const start = callText.indexOf("{");
	if (start < 0) return undefined;
	try {
		const args = JSON.parse(callText.slice(start)) as unknown;
		const code = args && typeof args === "object" ? (args as Record<string, unknown>)["code"] : undefined;
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}

interface Token {
	value: string;
	quoted: boolean;
	/** A template literal or a string with escapes we do not decode: its value is unknown. */
	opaque?: boolean;
}

function tokenize(script: string): Token[] {
	const tokens: Token[] = [];
	const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
	for (const match of script.matchAll(pattern)) {
		const value = match[0];
		if (value.startsWith("//") || value.startsWith("/*")) continue;
		const quote = value[0];
		if (quote === "`") {
			tokens.push({ value: "", quoted: true, opaque: true });
		} else if (quote === '"' || quote === "'") {
			const content = value.slice(1, -1);
			if (/\\(?:[^\\'"nrt]|$)/.test(content)) tokens.push({ value: "", quoted: true, opaque: true });
			else tokens.push({ value: content.replace(/\\([\\'"nrt])/g, (_, ch: string) => ({ n: "\n", r: "\r", t: "\t" })[ch] ?? ch), quoted: true });
		} else {
			tokens.push({ value, quoted: false });
		}
	}
	return tokens;
}

const PATH_KEYS = new Set(["path", "file_path", "filePath"]);
const RANGE_KEYS = new Set(["offset", "limit", "start_line", "end_line", "startLine", "endLine"]);

/** Every `tools.<name>(…)` call in script order; string arguments only when they are literals. */
export function codemodeScriptCalls(script: string): CodemodeCall[] {
	const tokens = tokenize(script);
	const calls: CodemodeCall[] = [];
	for (let i = 0; i + 3 < tokens.length; i++) {
		const t = tokens[i];
		if (tokens[i - 1]?.value === "." || t.quoted || t.value !== "tools" || tokens[i + 1].value !== "." || tokens[i + 2].quoted || tokens[i + 3].value !== "(") continue;
		const call: CodemodeCall = { tool: tokens[i + 2].value.toLowerCase(), ranged: false };
		const first = tokens[i + 4];
		if (first?.quoted && !first.opaque && (tokens[i + 5]?.value === ")" || tokens[i + 5]?.value === ",")) {
			call.path = first.value;
		} else if (first?.value === "{" && !first.quoted) {
			let depth = 1;
			for (let j = i + 5; j < tokens.length && depth > 0; j++) {
				const tok = tokens[j];
				if (!tok.quoted && (tok.value === "{" || tok.value === "[" || tok.value === "(")) depth++;
				else if (!tok.quoted && (tok.value === "}" || tok.value === "]" || tok.value === ")")) depth--;
				else if (depth === 1 && !tok.quoted && (tokens[j - 1]?.value === "{" || tokens[j - 1]?.value === ",") && tokens[j + 1]?.value === ":") {
					const arg = tokens[j + 2];
					const literal = arg?.quoted && !arg.opaque && (tokens[j + 3]?.value === "," || tokens[j + 3]?.value === "}");
					if (RANGE_KEYS.has(tok.value) && arg?.value !== "null" && arg?.value !== "undefined") call.ranged = true;
					else if (literal && PATH_KEYS.has(tok.value)) call.path = arg.value;
					else if (literal && tok.value === "command") call.command = arg.value;
				}
			}
		}
		calls.push(call);
	}
	return calls;
}

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unwrap the `{i, result: {status, value}}`-style envelopes agents print around tool results. */
function decode(raw: string): { text: string; failed: boolean; index?: number } {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith('"')) return { text: raw, failed: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { text: raw, failed: false };
	}
	if (typeof parsed === "string") return { text: parsed, failed: false };
	if (!record(parsed)) return { text: raw, failed: false };
	const index = typeof parsed["i"] === "number" && Number.isInteger(parsed["i"]) ? parsed["i"] : undefined;
	let failed = false;
	let node: unknown = parsed;
	for (let depth = 0; depth < 4 && record(node); depth++) {
		const status = node["status"];
		if (status === "rejected" || status === "error" || status === "failed" || node["error"] !== undefined) failed = true;
		if (failed && typeof node["reason"] === "string") return { text: node["reason"], failed, index };
		if (failed && typeof node["error"] === "string") return { text: node["error"], failed, index };
		const key = PAYLOAD_KEYS.find((k) => node !== null && typeof node === "object" && k in node);
		if (key === undefined) break;
		node = (node as Record<string, unknown>)[key];
		if (typeof node === "string") return { text: node, failed, index };
	}
	return { text: raw, failed, index };
}

/**
 * Split a codemode result into its printed text items and associate each with the nested call that
 * produced it: by the envelope's `i` field, else by position when the counts match. Null when the
 * output is not a completed codemode result.
 */
export function parseCodemodeOutput(output: string, calls: readonly CodemodeCall[] = []): CodemodeOutput | null {
	const header = OUTPUT_HEADER.exec(output);
	const markers = [...output.matchAll(MARKER)];
	if (!header && markers.length === 0) return null;
	const tail = FULL_OUTPUT.exec(output);
	const end = tail ? tail.index : output.length;
	const postamble = tail ? output.slice(tail.index) : "";
	const spans: Array<{ start: number; end: number }> = [];
	let preamble: string;
	if (markers.length === 0) {
		const start = (header?.index ?? 0) + (header?.[0].length ?? 0);
		preamble = output.slice(0, start);
		spans.push({ start, end });
	} else {
		preamble = output.slice(0, markers[0].index ?? 0);
		markers.forEach((m, i) => {
			const start = (m.index ?? 0) + m[0].length;
			spans.push({ start, end: i + 1 < markers.length ? (markers[i + 1].index ?? end) : end });
		});
	}
	const decoded = spans.map(({ start, end: stop }, i) => {
		let raw = output.slice(start, stop).replace(/^\r?\n/, "");
		if (i + 1 < spans.length || tail) raw = raw.replace(/\r?\n$/, "");
		return { raw, ...decode(raw) };
	});
	const byIndex = decoded.every((d) => d.index !== undefined && d.index < calls.length);
	const sections = decoded.map((d, index): CodemodeSection => {
		const call = byIndex ? calls[d.index ?? -1] : decoded.length === calls.length ? calls[index] : undefined;
		return { index, raw: d.raw, text: d.text, failed: d.failed, ...(call ? { call } : {}) };
	});
	return { preamble, sections, postamble };
}

/** Parse a codemode tool_result from its own text and the originating call's text. */
export function parseCodemodeResult(resultText: string | undefined, callText: string | undefined): CodemodeOutput | null {
	if (typeof resultText !== "string") return null;
	return parseCodemodeOutput(resultText, codemodeScriptCalls(codemodeScript(callText) ?? ""));
}

function short(s: string, n: number): string {
	const line = s.split("\n").find((l) => l.trim())?.trim() ?? "";
	return line.length <= n ? line : `${line.slice(0, n - 1)}…`;
}

/** A compact human label for a nested call: `read src/a.ts`, `bash git status`, `grep`. */
export function callLabel(call: CodemodeCall): string {
	const arg = call.path ?? (call.command === undefined ? undefined : short(call.command, 48));
	return arg ? `${call.tool} ${arg}` : call.tool;
}

/** A one-line description of a codemode run: its nested calls, at most `max` named. */
export function codemodeSummary(calls: readonly CodemodeCall[], max = 4): string {
	if (calls.length === 0) return "codemode script";
	const named = calls.slice(0, max).map(callLabel).join(" · ");
	return calls.length > max ? `codemode: ${named} · +${calls.length - max} more` : `codemode: ${named}`;
}

/**
 * Readable rendering of a codemode result for prompts and excerpts: each item decoded and labeled
 * with its call, without the runner's wall-time preamble. `body` may shorten each item.
 */
export function renderCodemode(out: CodemodeOutput, body: (s: CodemodeSection) => string = (s) => s.text): string {
	const n = out.sections.length;
	return out.sections
		.map((s) => {
			const label = s.call ? ` · ${callLabel(s.call)}` : "";
			const failed = s.failed ? " · failed" : "";
			return `==> ${s.index + 1}/${n}${label}${failed} <==\n${body(s)}`;
		})
		.join("\n");
}

/**
 * A block's text as a prompt or excerpt should see it: a codemode result decoded and labeled, any
 * other text unchanged.
 */
export function readableToolText(text: string | undefined, toolName: string | undefined, callText: string | undefined): string {
	if (typeof text !== "string" || !isCodemodeTool(toolName, callText)) return text ?? "";
	const out = parseCodemodeResult(text, callText);
	return out ? renderCodemode(out) : text;
}
