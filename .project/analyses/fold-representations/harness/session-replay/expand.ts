// Test-only: expose tasks calls made inside codemode (recorded in the result's details.calls) as direct tasks calls.
export function expand(messages: any[]): any[] {
  const nested = new Map<string, any[]>();
  for (const m of messages) if (m.role === "toolResult" && m.toolName === "codemode" && Array.isArray(m.details?.calls)) {
    const calls = m.details.calls.filter((c: any) => c.name === "tasks");
    if (calls.length) nested.set(m.toolCallId, calls);
  }
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const content: any[] = [];
      for (const p of m.content) {
        content.push(p);
        if (p.type === "toolCall" && nested.has(p.id)) nested.get(p.id)!.forEach((c: any, k: number) => {
          let args: any = {}; try { args = JSON.parse(c.args); } catch { for (const k of ["action", "list", "id"]) { const m = new RegExp(`"${k}":"([^"]*)"`).exec(c.args); if (m) args[k] = m[1]; } }
          content.push({ type: "toolCall", id: `${p.id}#t${k}`, name: "tasks", arguments: args });
        });
      }
      out.push({ ...m, content }); continue;
    }
    out.push(m);
    if (m.role === "toolResult" && nested.has(m.toolCallId)) {
      const text = m.content.map((c: any) => c.text ?? "").join("");
      const parts = text.split(/==> text \d+\/\d+ <==\n/).slice(1);
      nested.get(m.toolCallId)!.forEach((c: any, k: number) => out.push({ role: "toolResult", toolCallId: `${m.toolCallId}#t${k}`, toolName: "tasks", content: [{ type: "text", text: (parts[k] ?? "").trim() || "ok" }], isError: false, timestamp: m.timestamp, ...(c.details ? { details: c.details } : {}) }));
    }
  }
  return out;
}
