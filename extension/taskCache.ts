import { scanTaskSpans, type TaskSpan } from "../conductors/in-process/taskfold/taskfold";
import { messageKey } from "../core/groupShape";
import type { Block } from "../core/types";
import { blockId, isDurableId, type PiMessage } from "../core/wire";

type ObjectValue = Record<string, unknown>;
type LocatedBlock = { value: ObjectValue | null; message: number; block: number; role: unknown; scalar: boolean };

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CACHEABLE = new Set(["text", "image", "document", "tool_use", "tool_result", "tool_addition", "tool_removal"]);
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const ttl = (control: ObjectValue): unknown => control.ttl ?? "5m";

/** A content-preserving request edit, or the reason no safe frontier could be added. */
export interface TaskCacheEdit {
	payload?: ObjectValue;
	reason: "applied" | "no-open-task" | "no-visible-boundary" | "ambiguous-boundary" | "cache-disabled" | "unsupported-payload" | "unsupported-controls" | "already-marked" | "no-marker-slot";
	task?: string;
	message?: number;
	block?: number;
	markers?: number;
}

function sourceParts(message: PiMessage): ObjectValue[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.map(object).filter((part): part is ObjectValue => {
		if (!part) return false;
		if (part.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
		if (part.type === "thinking") return part.redacted === true
			|| (typeof part.thinking === "string" && part.thinking.trim().length > 0)
			|| (typeof part.thinkingSignature === "string" && part.thinkingSignature.trim().length > 0);
		return true;
	});
}

function matches(source: ObjectValue, actual: ObjectValue | null): boolean {
	if (!actual) return false;
	if (source.type === "toolCall") return actual.type === "tool_use" && actual.id === source.id;
	if (source.type === "text") return actual.type === "text" && actual.text === source.text;
	if (source.type !== "thinking") return false;
	if (source.redacted === true) return actual.type === "redacted_thinking" && actual.data === source.thinkingSignature;
	const signed = typeof source.thinkingSignature === "string" && source.thinkingSignature.trim().length > 0;
	if (actual.type === "thinking") return actual.thinking === source.thinking
		&& (signed ? actual.signature === source.thinkingSignature : !actual.signature);
	return !signed && actual.type === "text" && actual.text === source.thinking;
}

function sameControl(a: ObjectValue, b: ObjectValue): boolean {
	return ttl(a) === ttl(b) && [...new Set([...Object.keys(a), ...Object.keys(b)])]
		.filter((key) => key !== "ttl").every((key) => a[key] === b[key]);
}

/**
 * Add an Anthropic breakpoint before the innermost open task; post-hook Claude OAuth identity is opt-in.
 * `spans` are the task spans of `blocks`.
 */
export function taskCacheFrontier(payload: unknown, blocks: readonly Block[], messages: readonly PiMessage[], oauthIdentityAfterHook = false,
	spans: readonly TaskSpan[] = scanTaskSpans(blocks, (block) => block.text)): TaskCacheEdit {
	const span = spans
		.filter((item) => item.status === null && item.intervals.at(-1)?.end === blocks.length - 1)
		.sort((a, b) => b.start - a.start || b.id.split(".").length - a.id.split(".").length)[0];
	if (!span) return { reason: "no-open-task" };
	const meta = { task: span.key };
	const first = blocks[span.start];
	if (!first || !isDurableId(first.id)) return { ...meta, reason: "no-visible-boundary" };
	const source = messages.find((message, index) => message.role === "assistant"
		&& messageKey(blockId(message, index, 0)) === messageKey(first.id));
	if (!source) return { ...meta, reason: "no-visible-boundary" };
	const parts = sourceParts(source);
	if (!parts.length) return { ...meta, reason: "no-visible-boundary" };
	const p = object(payload);
	if (!p || !Array.isArray(p.messages) || !p.messages.every((row) => object(row))) return { ...meta, reason: "unsupported-payload" };
	const rows = p.messages as ObjectValue[];
	const flat = rows.flatMap<LocatedBlock>((row, message) => {
		if (typeof row.content === "string") return [{ value: { type: "text", text: row.content }, message, block: 0, role: row.role, scalar: true }];
		return Array.isArray(row.content) ? row.content.map((value: unknown, block: number) => ({ value: object(value), message, block, role: row.role, scalar: false })) : [];
	});
	const starts: number[] = [];
	for (let i = 0; i + parts.length <= flat.length; i++) {
		if (parts.every((part, n) => flat[i + n].role === "assistant" && matches(part, flat[i + n].value))) starts.push(i);
	}
	if (starts.length > 1) return { ...meta, reason: "ambiguous-boundary" };
	if (!starts.length) return { ...meta, reason: "no-visible-boundary" };
	let at = starts[0] - 1;
	while (at >= 0 && (!CACHEABLE.has(String(flat[at].value?.type))
		|| flat[at].value?.type === "text" && !String(flat[at].value?.text ?? "").trim())) at--;
	const target = flat[at];
	if (!target?.value || target.scalar) return { ...meta, reason: "no-visible-boundary" };
	const located = { ...meta, message: target.message, block: target.block };
	if (target.value.cache_control !== undefined) return { ...located, reason: "already-marked" };
	const system: unknown[] = Array.isArray(p.system) ? p.system : [];
	const tools: unknown[] = Array.isArray(p.tools) ? p.tools : [];
	const nodes = [...tools.map(object), ...system.map(object), ...flat.map((item) => item.scalar ? null : item.value)];
	const controls = nodes.flatMap((node, index) => node?.cache_control !== undefined ? [{ node, index, control: object(node.cache_control) }] : []);
	if (p.cache_control !== undefined) controls.push({ node: p, index: nodes.length, control: object(p.cache_control) });
	if (!controls.length) return { ...located, reason: "cache-disabled" };
	let short = false;
	for (const { control } of controls) {
		if (!control || control.type !== "ephemeral" || !["5m", "1h"].includes(String(ttl(control))) || short && ttl(control) === "1h") {
			return { ...located, reason: "unsupported-controls" };
		}
		short ||= ttl(control) === "5m";
	}
	const identity = system.map(object).find((node) => node?.type === "text" && node.text === IDENTITY);
	const identityControl = object(identity?.cache_control);
	const identityAt = identity ? system.indexOf(identity) : -1;
	const redundant = identityControl && system.slice(identityAt + 1).some((node) => {
		const later = object(object(node)?.cache_control);
		return later !== null && sameControl(identityControl, later);
	});
	const markers = controls.length - (redundant ? 1 : 0) + 1;
	if (markers > 4) return { ...located, reason: "no-marker-slot", markers: controls.length };
	const targetIndex = nodes.indexOf(target.value);
	const preceding = controls.filter((entry) => entry.index < targetIndex && !(redundant && entry.node === identity));
	const control = preceding.at(-1)?.control ?? controls[0].control;
	const next: ObjectValue = {
		...p,
		messages: rows.map((row, i) => i !== target.message ? row : { ...row,
			content: (row.content as unknown[]).map((value, j) => j === target.block ? { ...target.value, cache_control: { ...control } } : value) }),
	};
	if (redundant && identity) next.system = system.map((node) => {
		if (node !== identity) return node;
		const rest = { ...identity };
		delete rest.cache_control;
		return rest;
	});
	if (!identity && oauthIdentityAfterHook && system.some((node) => object(object(node)?.cache_control))) {
		// pi-auth-plus otherwise adds a fifth marker on the identity after this hook.
		next.system = [{ type: "text", text: IDENTITY }, ...system];
	}
	return { ...located, reason: "applied", payload: next, markers };
}
