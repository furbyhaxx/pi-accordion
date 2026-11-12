import * as fs from "node:fs";
import { setTimeout } from "node:timers/promises";
import { SettingsStore } from "../../../../../extension/settingsStore.ts";

const [home, channel, patchText] = process.argv.slice(2);
if (!home || !channel || !patchText) throw new Error("Usage: store-writer.ts <home> <private-channel-prefix> <patch-json>");
const store = new SettingsStore(home, {});
const base = store.current().rev;
fs.writeFileSync(`${channel}.ready.json`, JSON.stringify({ rev: base }), { mode: 0o600 });
const deadline = Date.now() + 15_000;
while (!fs.existsSync(`${channel}.go`)) {
	if (Date.now() >= deadline) throw new Error("Writer barrier timed out");
	await setTimeout(10);
}
const saved = await store.save(JSON.parse(patchText), base);
fs.writeFileSync(`${channel}.result.json`, JSON.stringify(saved.ok ? { ok: true, rev: saved.snapshot.rev } : saved), { mode: 0o600 });
