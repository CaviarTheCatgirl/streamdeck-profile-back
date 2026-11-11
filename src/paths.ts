import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_UUID = "com.caviarthecatgirl.profile-back";

/** Our own folder, OUTSIDE the plugin folder, so plugin updates never touch it. */
export function dataDir(): string {
	const base = process.platform === "win32"
		? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
		: path.join(os.homedir(), "Library", "Application Support");
	return path.join(base, "ProfileBack");
}

/** Where the Stream Deck app keeps its data (profiles, plugins). */
export function elgatoDir(): string {
	return process.platform === "win32"
		? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Elgato", "StreamDeck")
		: path.join(os.homedir(), "Library", "Application Support", "com.elgato.StreamDeck");
}

/** The installed <uuid>.sdPlugin folder (bin/plugin.js lives one level below it). */
export function pluginDir(): string {
	const candidates = [path.resolve(path.dirname(process.argv[1] ?? ""), ".."), process.cwd()];
	for (const c of candidates) if (fs.existsSync(path.join(c, "manifest.json"))) return c;
	return candidates[0];
}

export function pluginVersion(): string {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(pluginDir(), "manifest.json"), "utf8")) as { Version?: string };
		return m.Version ?? "unknown";
	} catch {
		return "unknown";
	}
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}
