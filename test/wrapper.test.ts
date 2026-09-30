import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

// Drives the real herdr-installed integration against a fake herdr socket.
const socketPath = join(mkdtempSync(join(tmpdir(), "pi-herdr-ext-")), "herdr.sock");
process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = socketPath;
process.env.HERDR_PANE_ID = "w1:p1";

const { officialIntegrationPath, wrapOfficialIntegration } = await import("../index.ts");

let reports: Array<{ method: string; params: any }> = [];
const server = net.createServer((socket) => {
	socket.on("data", (chunk) => {
		for (const line of chunk.toString().split("\n").filter(Boolean)) reports.push(JSON.parse(line));
		socket.write('{"ok":true}\n');
	});
});

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const states = () => reports.filter((r) => r.method === "pane.report_agent").map((r) => r.params.state);

function fakePi() {
	const bus = new EventEmitter();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi: any = {
		on(name: string, handler: any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		events: {
			on(channel: string, handler: any) {
				bus.on(channel, handler);
				return () => bus.off(channel, handler);
			},
			emit(channel: string, data: unknown) {
				bus.emit(channel, data);
			},
		},
	};
	const fire = async (name: string, ctx: any, event: any = { type: name }) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, fire };
}

function ctx(idle: () => boolean) {
	return {
		mode: "tui",
		isIdle: idle,
		sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getSessionId: () => "s1" },
	};
}

describe("pi-herdr-extension wrapper around the official integration", () => {
	let official: any;

	before(async () => {
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		official = (await import(pathToFileURL(officialIntegrationPath()).href)).default;
	});
	after(() => server.close());
	beforeEach(() => {
		reports = [];
	});

	async function setup() {
		const { pi, fire } = fakePi();
		let parentIdle = true;
		const c = ctx(() => parentIdle);
		wrapOfficialIntegration(pi, official);
		await fire("session_start", c, { type: "session_start", reason: "startup" });
		await tick();
		const setParentIdle = (value: boolean) => {
			parentIdle = value;
		};
		return { pi, fire, c, setParentIdle };
	}

	it("control: the unwrapped official integration goes idle while sibling work is busy", async () => {
		const { pi, fire } = fakePi();
		let parentIdle = true;
		const c = ctx(() => parentIdle);
		official(pi);
		await fire("session_start", c, { type: "session_start", reason: "startup" });
		parentIdle = false;
		await fire("agent_start", c);
		pi.events.emit("herdr:busy", { active: true, label: "⏳ 1 subagent" });
		parentIdle = true;
		await fire("agent_settled", c);
		await tick();
		// The official send queue coalesces, so only the final state is meaningful.
		assert.equal(states().at(-1), "idle");
	});

	it("keeps working after the parent settles while sibling work is busy", async () => {
		const { pi, fire, c, setParentIdle } = await setup();
		setParentIdle(false);
		await fire("agent_start", c);
		pi.events.emit("herdr:busy", { active: true, label: "⏳ 1 subagent" });
		setParentIdle(true);
		await fire("agent_settled", c);
		await tick();
		assert.deepEqual(states(), ["idle", "working"]);

		pi.events.emit("herdr:busy", { active: false });
		await tick();
		assert.deepEqual(states(), ["idle", "working", "idle"]);
	});

	it("turns working when busy rises after the parent is already idle", async () => {
		const { pi } = await setup();
		pi.events.emit("herdr:busy", { active: true, label: "x" });
		await tick();
		pi.events.emit("herdr:busy", { active: false });
		await tick();
		assert.deepEqual(states(), ["idle", "working", "idle"]);
	});

	it("does not flash idle when pi-subagents relabels (lower then raise)", async () => {
		const { pi } = await setup();
		pi.events.emit("herdr:busy", { active: true, label: "a" });
		await tick();
		pi.events.emit("herdr:busy", { active: false });
		pi.events.emit("herdr:busy", { active: true, label: "b" });
		await tick();
		assert.deepEqual(states(), ["idle", "working"]);
	});

	it("passes blocked through and replays blocked raised before session_start", async () => {
		const { pi, fire } = fakePi();
		wrapOfficialIntegration(pi, official);
		pi.events.emit("herdr:blocked", { active: true, label: "needs attention" });
		await fire("session_start", ctx(() => true), { type: "session_start", reason: "reload" });
		await tick();
		assert.equal(states().at(-1), "blocked");
		pi.events.emit("herdr:blocked", { active: false });
		await tick();
		assert.equal(states().at(-1), "idle");
	});

	it("reports session identity from the official integration", async () => {
		await setup();
		const session = reports.find((r) => r.method === "pane.report_agent_session");
		assert.equal(session?.params.agent_session_path, "/tmp/session.jsonl");
		assert.equal(session?.params.source, "herdr:pi");
	});
});
