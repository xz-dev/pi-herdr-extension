import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Handler = (event: any, ctx: any) => unknown;
type OfficialFactory = (pi: any) => unknown;

const WRAPPED_EVENTS = new Set(["session_start", "agent_start", "agent_settled"]);

/** Path herdr installs its managed Pi integration to (`herdr integration install pi`). */
export function officialIntegrationPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = configured
		? configured.replace(/^~(?=$|[\\/])/, homedir())
		: join(homedir(), ".pi", "agent");
	return join(agentDir, "extensions", "herdr-agent-state.ts");
}

/**
 * Runs herdr's managed Pi integration unchanged, but lets sibling `herdr:busy`
 * work (e.g. pi-subagents async runs) keep the pane working after the parent
 * agent loop settles. The official integration stays the only herdr:pi
 * reporter; this wrapper only changes which lifecycle events it sees.
 */
export function wrapOfficialIntegration(pi: ExtensionAPI, official: OfficialFactory): void {
	const handlers = new Map<string, Handler[]>();
	let busyCount = 0;
	let parentActive = false;
	let lastCtx: any;
	let sessionStarted = false;
	let pendingBlocked: unknown[] = [];
	let blockedHandlers: Array<(data: unknown) => unknown> = [];
	let busyCheckScheduled = false;
	let presentedBusy = false;

	const realIdle = (ctx: any): boolean | undefined => {
		try {
			return ctx?.isIdle?.();
		} catch {
			return undefined; // stale ctx after session replacement
		}
	};

	// The official handlers decide working/idle from ctx.isIdle(); sibling busy
	// work makes the pane non-idle even when the parent loop is.
	const withBusyIdle = (ctx: any) =>
		new Proxy(ctx, {
			get(target, prop) {
				if (prop === "isIdle") return () => realIdle(target) === true && busyCount === 0;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

	const dispatch = async (name: string, event: unknown, ctx: any) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, withBusyIdle(ctx));
	};

	const onBusyChanged = () => {
		// pi-subagents relabels by lowering then raising in the same tick; settle first.
		if (busyCheckScheduled) return;
		busyCheckScheduled = true;
		setTimeout(() => {
			busyCheckScheduled = false;
			const busy = busyCount > 0;
			if (busy === presentedBusy || !sessionStarted || !lastCtx || parentActive) {
				presentedBusy = busy;
				return;
			}
			presentedBusy = busy;
			const name = busy ? "agent_start" : "agent_settled";
			dispatch(name, { type: name }, lastCtx).catch((error) => {
				console.error(`pi-herdr-extension: ${name} replay failed:`, error);
			});
		}, 0);
	};

	pi.events.on("herdr:busy", (data: any) => {
		busyCount = data?.active ? busyCount + 1 : Math.max(0, busyCount - 1);
		onBusyChanged();
	});

	// The official integration drops herdr:blocked until its session_start ran.
	// Packages may load after it, so buffer early signals and replay them.
	pi.events.on("herdr:blocked", (data: unknown) => {
		if (!sessionStarted) {
			pendingBlocked.push(data);
			return;
		}
		for (const handler of blockedHandlers) handler(data);
	});

	const events = new Proxy(pi.events, {
		get(target, prop) {
			if (prop === "on") {
				return (channel: string, handler: (data: unknown) => unknown) => {
					if (channel !== "herdr:blocked") return target.on(channel, handler);
					blockedHandlers.push(handler);
					return () => {
						blockedHandlers = blockedHandlers.filter((h) => h !== handler);
					};
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	const proxiedPi = new Proxy(pi, {
		get(target, prop) {
			if (prop === "events") return events;
			if (prop === "on") {
				return (name: string, handler: Handler, ...rest: unknown[]) => {
					if (!WRAPPED_EVENTS.has(name)) return (target.on as any)(name, handler, ...rest);
					const list = handlers.get(name) ?? [];
					list.push(handler);
					handlers.set(name, list);
					return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		parentActive = realIdle(ctx) === false;
		presentedBusy = busyCount > 0;
		await dispatch("session_start", event, ctx);
		sessionStarted = true;
		const replay = pendingBlocked;
		pendingBlocked = [];
		for (const data of replay) for (const handler of blockedHandlers) handler(data);
	});

	pi.on("agent_start", async (event, ctx) => {
		lastCtx = ctx;
		parentActive = true;
		await dispatch("agent_start", event, ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		lastCtx = ctx;
		if (realIdle(ctx) === true) parentActive = false;
		await dispatch("agent_settled", event, ctx);
	});

	official(proxiedPi);
}

/**
 * Whether Pi also auto-loads the official file on its own. Uses Pi's own
 * resolver, so global/project settings and +/-/! filters are all honored.
 */
async function officialAutoloaded(ctx: any, officialPath: string): Promise<boolean> {
	const argv = process.argv;
	if (argv.includes("--no-extensions") || argv.includes("-ne")) return false; // discovery disabled
	const { DefaultPackageManager, SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted?.() === true });
	const resolved = await new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager }).resolve(async () => "skip");
	return resolved.extensions.some((entry) => entry.enabled && resolve(entry.path) === resolve(officialPath));
}

function duplicateLoadMessage(officialPath: string): string {
	const settingsPath = join(officialPath, "..", "..", "settings.json");
	return [
		"",
		"pi-herdr-extension: Herdr's managed Pi integration is also auto-loaded by Pi:",
		`  ${officialPath}`,
		"Both copies would report herdr:pi state for this pane and fight each other.",
		"pi-herdr-extension loads that file itself, so stop Pi from auto-loading it.",
		"",
		`Add this entry to "extensions" in ${settingsPath} (keep any existing entries):`,
		'  "extensions": ["-extensions/herdr-agent-state.ts"]',
		"or run `pi config` and disable herdr-agent-state.ts. Keep the file installed.",
		"Then start pi again.",
		"",
	].join("\n");
}

export default async function herdrExtension(pi: ExtensionAPI): Promise<void> {
	const path = officialIntegrationPath();
	if (!existsSync(path)) return; // herdr integration not installed; nothing to extend

	// Same gate as the official integration: only the interactive pane owner reports.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") return;
		if (!(await officialAutoloaded(ctx, path))) return;
		// Print after the TUI restores the terminal; exit non-zero so scripts notice.
		process.once("exit", () => {
			writeSync(2, duplicateLoadMessage(path));
			process.exitCode = 1;
		});
		ctx.shutdown();
	});

	const mod = await import(pathToFileURL(path).href);
	const official = (mod?.default ?? mod) as OfficialFactory;
	if (typeof official !== "function") return;
	wrapOfficialIntegration(pi, official);
}
