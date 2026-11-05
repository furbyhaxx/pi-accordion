/*
 * smoke-autoarm.mjs — a spawned default conductor attaches at session start.
 *
 * With `autoArm` and `defaultConductor: "thermocline"` in config.json, session_start selects the
 * conductor while the session server is still binding. The runner dials back on the session port,
 * so a selection made before the listen completed spawned it with ACCORDION_PORT=0 and it refused
 * to start. This boots the extension with that config and waits for the real runner to attach.
 *
 * Run: node smoke-autoarm.mjs   (also chained in the `smoke` npm script)
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = path.join(os.tmpdir(), `accordion-smoke-autoarm-${process.pid}`);
process.env.ACCORDION_HOME = HOME;
process.env.ACCORDION_APP_PATH = path.join(HOME, "missing-accordion-app.exe");
process.env.ATTN_PROBE_PYTHON = path.join(HOME, "no-such-python-binary");
fs.mkdirSync(path.join(HOME, ".accordion"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".accordion", "config.json"), JSON.stringify({ autoArm: true, defaultConductor: "thermocline" }));

const fails = [];
async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const jiti = createJiti(import.meta.url);
const accordionLive = (await jiti.import("./accordion.ts")).default;
const handlers = {};
const flags = new Map();
accordionLive({
	on: (name, fn) => (handlers[name] = fn),
	registerFlag: (name, def) => flags.set(name, def?.default),
	getFlag: (name) => flags.get(name),
	registerShortcut: () => {},
	registerCommand: () => {},
	registerTool: () => {},
	appendEntry: () => {},
});
const notes = [];
const ctx = {
	ui: { setStatus() {}, notify: (text) => notes.push(text), theme: { fg: (_c, s) => s } },
	model: { id: "test/model", contextWindow: 200_000 },
	getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
};
handlers.session_start({}, ctx);

const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");
let ws;
try {
	await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 3000, "registry entry");
	const entryFile = fs.readdirSync(SESSIONS_DIR).find((f) => f.endsWith(".json"));
	const { port } = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, entryFile), "utf8"));
	const conductorStates = [];
	ws = new WebSocket(`ws://127.0.0.1:${port}/?surface=autoarm-smoke&label=smoke`);
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		if (m.type === "conductorState") conductorStates.push(m);
		if (m.type === "hello" && m.conductor) conductorStates.push({ active: m.conductor });
	});
	await waitFor(() => conductorStates.some((m) => m.active?.id === "thermocline" && m.active?.remote === true), 12_000, "thermocline attach");
} catch (err) {
	fails.push(`${err.message}${notes.length ? ` (notices: ${notes.join(" | ")})` : ""}`);
} finally {
	ws?.close();
	handlers.session_shutdown?.({}, ctx);
	try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (fails.length) {
	console.error(`smoke-autoarm: FAIL\n  - ${fails.join("\n  - ")}`);
	process.exit(1);
}
console.log("smoke-autoarm: OK — the default spawn conductor attached once the session port was bound.");
process.exit(0);
