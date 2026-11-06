import { appendFileSync } from "node:fs";
const log = (o: unknown) => appendFileSync("/tmp/probe/bus.jsonl", JSON.stringify(o) + "\n");
export default function (pi: any) {
	pi.events.on("pi-auth-plus:v1:tokens:context", (p: any) => log({ reason: p?.reason, tokens: p?.report?.tokens, anchor: p?.report?.anchor, tail: p?.report?.tail, pi: p?.report?.pi }));
	pi.events.on("pi-auth-plus:v1:tokens:ready", (p: any) => log({ ready: p }));
}
