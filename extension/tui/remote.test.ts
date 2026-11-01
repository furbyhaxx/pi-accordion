import { afterEach, describe, expect, test } from "bun:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Truth } from "../../core/truth";
import { serializeSnapshot } from "../../core/replica";
import { PROTOCOL_VERSION } from "../../core/protocol";
import { REGISTRY_PROTOCOL, type SessionEntry } from "../../app/src/lib/live/registry";
import { connectRemoteSession } from "./remote";

const meta = { format: "pi" as const, title: "test", cwd: "/tmp", model: "test", contextWindow: null };
const conductor = { id: "example", label: "Example", locks: ["human-steering"], tailTokens: 0, holdWireUpToMs: 0, remote: false, readiness: { state: "ready" } };
const servers: WebSocketServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		for (const client of server.clients) client.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
async function setup() {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const port = (server.address() as AddressInfo).port;
	const entry: SessionEntry = { registryProtocol: REGISTRY_PROTOCOL, protocolVersion: PROTOCOL_VERSION, sessionId: "test", port, pid: 1, cwd: "/tmp", title: "test", model: "test", tokens: null, contextWindow: null, startedAt: Date.now(), heartbeatAt: Date.now() };
	const truth = new Truth({ meta, blocks: [], lineCount: 0, skipped: 0 });
	let socket: WebSocket | undefined;
	const messages: { type: string; seq?: number; cmd?: unknown }[] = [];
	let wake = () => {};
	server.on("connection", (ws, req) => {
		socket = ws;
		expect(req.headers.origin).toBeUndefined();
		const url = new URL(req.url ?? "", "http://localhost");
		expect(url.searchParams.get("surface")).toBe("my-surface");
		expect(url.searchParams.get("label")).toBe("Pi TUI");
		ws.on("message", (data) => { messages.push(JSON.parse(data.toString())); wake(); });
		ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "test", role: "gui", meta, conductors: [conductor] }));
		ws.send(JSON.stringify({ type: "snapshot", state: serializeSnapshot(truth, false) }));
	});
	const host = await connectRemoteSession(entry, "my-surface");
	if (!socket) throw new Error("No socket");
	const ws: WebSocket = socket;
	async function next() {
		if (!messages.length) await new Promise<void>((resolve) => { wake = resolve; });
		const message = messages.shift();
		if (!message) throw new Error("No message");
		return message;
	}
	const send = (frame: unknown) => ws.send(JSON.stringify(frame));
	return { server, truth, host, ws, next, send };
}
function update(host: { subscribe(listener: () => void): () => void }) {
	return new Promise<void>((resolve) => { const unsubscribe = host.subscribe(() => { unsubscribe(); resolve(); }); });
}

describe("remote TUI host", () => {
	test("replays events, handles refusal, explicit claim and revision-gap resnapshot", async () => {
		const s = await setup();
		expect(s.host.truth()?.rev).toBe(s.truth.rev);
		expect(s.host.conductors()).toEqual([conductor]);
		const first = s.host.command({ kind: "setBudget", value: 2000 });
		const command = await s.next();
		expect(command).toEqual({ type: "command", seq: 1, cmd: { kind: "setBudget", value: 2000 } });
		s.send({ type: "commandResult", seq: 1, results: [], rev: s.truth.rev, refused: "read-only" });
		expect(await first).toEqual({ results: [], rev: s.truth.rev, refused: "read-only" });
		s.host.claim(); expect(await s.next()).toEqual({ type: "claimController" });
		const second = s.host.command({ kind: "setBudget", value: 3000 });
		expect((await s.next()).seq).toBe(2);
		expect(s.host.truth()?.budget).toBe(s.truth.budget);
		s.truth.setBudget(3000);
		let changed = update(s.host);
		s.send({ type: "event", event: { kind: "config", budget: 3000, rev: s.truth.rev } });
		await changed;
		expect(s.host.truth()?.budget).toBe(3000);
		s.send({ type: "commandResult", seq: 2, results: [], rev: s.truth.rev });
		expect(await second).toEqual({ results: [], rev: s.truth.rev });
		s.truth.setBudget(4000); s.truth.setBudget(5000);
		s.send({ type: "event", event: { kind: "config", budget: 5000, rev: s.truth.rev } });
		expect(await s.next()).toEqual({ type: "resnapshot" });
		s.send({ type: "event", event: { kind: "config", budget: 6000, rev: s.truth.rev + 1 } });
		changed = update(s.host);
		s.send({ type: "snapshot", state: serializeSnapshot(s.truth, true) });
		await changed;
		expect(s.host.truth()?.rev).toBe(s.truth.rev);
		expect(s.host.truth()?.budget).toBe(5000);
		expect(s.host.folding()).toBe(true);
		changed = update(s.host); s.send({ type: "conductorState", active: conductor }); await changed;
		expect(s.host.activeConductor()).toEqual(conductor);
		changed = update(s.host); s.send({ type: "folding", enabled: false }); await changed;
		expect(s.host.folding()).toBe(false);
		s.host.close();
	});
	test("rejects pending commands on disconnect", async () => {
		const s = await setup();
		const result = s.host.command({ kind: "setFolding", value: true });
		await s.next(); s.ws.close();
		await expect(result).rejects.toThrow("disconnected");
		expect(s.host.truth()).toBeNull();
		s.host.close();
	});
	test("rejects malformed snapshots", async () => {
		const s = await setup();
		const closed = update(s.host);
		s.send({ type: "snapshot", state: { blocks: [null] } });
		await closed;
		expect(s.host.truth()).toBeNull();
	});
	test("rejects a mismatched hello and out-of-range ports", async () => {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.push(server);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const port = (server.address() as AddressInfo).port;
		const entry: SessionEntry = { registryProtocol: REGISTRY_PROTOCOL, protocolVersion: PROTOCOL_VERSION, sessionId: "test", port, pid: 1, cwd: "", title: "", model: "", tokens: null, contextWindow: null, startedAt: Date.now(), heartbeatAt: Date.now() };
		server.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, sessionId: "test", role: "gui", meta })));
		await expect(connectRemoteSession(entry, "my-surface")).rejects.toThrow("Protocol mismatch");
		await expect(connectRemoteSession({ ...entry, port: 65536 }, "my-surface")).rejects.toThrow("Invalid or stale");
	});
});
