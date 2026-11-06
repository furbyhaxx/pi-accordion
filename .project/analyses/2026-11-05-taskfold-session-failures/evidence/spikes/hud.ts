export default function (pi: any) {
	pi.on("context", (e: any) => {
		const msgs = e.messages.slice(); const last = msgs[msgs.length - 1];
		const hud = { type: "text", text: "[probe-hud] list demo · doing 1.2 \"Parse args\" · 7 calls" };
		msgs[msgs.length - 1] = { ...last, content: typeof last.content === "string" ? [{ type: "text", text: last.content }, hud] : [...last.content, hud] };
		return { messages: msgs };
	});
}
