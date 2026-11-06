import { appendFileSync } from "node:fs";
const log = (o: unknown) => appendFileSync("/tmp/probe/log.jsonl", JSON.stringify(o) + "\n");
export default function (pi: any) {
	let blocked = false, followed = false;
	pi.on("message_end", (e: any) => {
		const m = e.message;
		if (m?.role === "assistant") log({ hook: "message_end", provider: m.provider, model: m.model, usage: m.usage, stop: m.stopReason });
	});
	pi.on("context", (e: any) => {
		const msgs = e.messages.slice();
		const last = msgs[msgs.length - 1];
		if (!last) return;
		const hud = { type: "text", text: "[probe-hud] tasks: none" };
		const copy = { ...last, content: typeof last.content === "string" ? [{ type: "text", text: last.content }, hud] : [...last.content, hud] };
		msgs[msgs.length - 1] = copy;
		log({ hook: "context", n: msgs.length, lastRole: last.role });
		return { messages: msgs };
	});
	pi.on("tool_call", (e: any) => {
		log({ hook: "tool_call", tool: e.toolName, input: e.input });
		if (e.toolName === "bash" && !blocked) {
			blocked = true;
			return { block: true, reason: "PROBE-GATE: blocked once. Call the same bash command again." };
		}
	});
	pi.on("agent_end", () => {
		log({ hook: "agent_end", followed });
		if (!followed) {
			followed = true;
			pi.sendUserMessage("PROBE-FOLLOWUP: reply with the single word OK.", { deliverAs: "followUp" });
		}
	});
}
