import fs from "node:fs";
import path from "node:path";
import { pluginDir } from "./paths";
import { scanProfiles, type ProfileInfo } from "./scan";

// Boards = the plugin's own profiles (see scripts/make-profiles.mjs):
// boards/<device>/<nnnn>.streamDeckProfile, one pool per deck model.

export const BOARD_DEVICE: Record<number, string> = { 0: "sd", 1: "mini", 2: "xl", 7: "plus", 9: "neo", 13: "plusxl" };
export const DEVICE_LABEL: Record<number, string> = {
	0: "Stream Deck (15 keys)", 1: "Stream Deck Mini", 2: "Stream Deck XL", 3: "Stream Deck Mobile", 5: "Stream Deck Pedal",
	7: "Stream Deck +", 9: "Stream Deck Neo", 10: "Stream Deck Studio", 11: "Virtual Stream Deck", 13: "Stream Deck + XL",
};

export const boardPath = (deviceType: number, n: number): string | null => {
	const dev = BOARD_DEVICE[deviceType];
	return dev ? `boards/${dev}/${String(n).padStart(4, "0")}` : null;
};

export function parseBoardPath(p: string): { dev: string; n: number } | null {
	const m = /^boards\/([a-z]+)\/(\d{4})$/.exec(p);
	return m ? { dev: m[1], n: Number(m[2]) } : null;
}

/** How many boards this version ships per device folder (read from the manifest). */
let counts: Record<string, number> | null = null;
export function shippedCounts(): Record<string, number> {
	if (counts) return counts;
	counts = {};
	try {
		const m = JSON.parse(fs.readFileSync(path.join(pluginDir(), "manifest.json"), "utf8")) as { Profiles?: { Name: string }[] };
		for (const p of m.Profiles ?? []) {
			const b = parseBoardPath(p.Name);
			if (b) counts[b.dev] = Math.max(counts[b.dev] ?? 0, b.n);
		}
	} catch {
		/* no manifest: no boards */
	}
	return counts;
}

export interface InstalledBoard {
	path: string;
	dev: string;
	n: number;
	name: string;
	profile: ProfileInfo;
}

export interface BoardInventory {
	boards: InstalledBoard[];
	/** Installed boards whose number this version no longer ships (would not open). */
	orphans: InstalledBoard[];
	at: number;
}

let cache: BoardInventory | null = null;

/** Installed boards, from Stream Deck's profile folder (cached for a few seconds). */
export function inventory(maxAgeMs = 5000): BoardInventory {
	if (cache && Date.now() - cache.at < maxAgeMs) return cache;
	const inv: BoardInventory = { boards: [], orphans: [], at: Date.now() };
	const shipped = shippedCounts();
	for (const p of scanProfiles()) {
		const b = parseBoardPath(p.preconfigured);
		if (!b) continue;
		const item: InstalledBoard = { path: p.preconfigured, dev: b.dev, n: b.n, name: p.name, profile: p };
		(b.n > (shipped[b.dev] ?? 0) ? inv.orphans : inv.boards).push(item);
	}
	inv.boards.sort((a, b) => a.dev.localeCompare(b.dev) || a.n - b.n);
	cache = inv;
	return inv;
}

export function forgetInventory(): void {
	cache = null;
}

/** Display name of a board for one device type: the name it has in Stream Deck, or "Board n". */
export function boardName(deviceType: number, n: number): string {
	const dev = BOARD_DEVICE[deviceType];
	const hit = inventory().boards.filter((b) => b.dev === dev && b.n === n);
	// Several identical decks can each have their own copy; the newest one wins.
	hit.sort((a, b) => b.profile.modified.localeCompare(a.profile.modified));
	return hit[0]?.name ?? `Board ${n}`;
}

/** Lowest board number not installed yet for this device type (for new keys). */
export function nextFreeBoard(deviceType: number): number {
	const dev = BOARD_DEVICE[deviceType];
	const used = new Set(inventory().boards.filter((b) => b.dev === dev).map((b) => b.n));
	const max = shippedCounts()[dev] ?? 0;
	for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
	return 1;
}
