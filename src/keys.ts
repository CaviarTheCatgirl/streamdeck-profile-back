import { scanProfiles } from "./scan";

// Which profile is a key on? Every key of ours carries a random `_pbId` in its
// settings; Stream Deck saves those settings inside the profile's files, so a
// read-only scan of the profile folder maps id → profile. That's how the
// plugin can show "Game 1" although Stream Deck never tells plugins profile
// names. (Stream Deck writes the files within a second or two of a change;
// until then a brand-new key's profile is simply "not known yet".)

export interface KeyHome { profile: string; board: string | null }

let index: { at: number; map: Map<string, KeyHome[]> } | null = null;

function build(): Map<string, KeyHome[]> {
	const map = new Map<string, KeyHome[]>();
	for (const p of scanProfiles()) {
		const board = p.preconfigured.startsWith("boards/") ? p.preconfigured : null;
		for (const pg of p.pages) {
			for (const id of pg.ids) {
				const list = map.get(id) ?? [];
				if (!list.some((h) => h.profile === p.name)) list.push({ profile: p.name, board });
				map.set(id, list);
			}
		}
	}
	return map;
}

function current(maxAgeMs: number): Map<string, KeyHome[]> {
	if (!index || Date.now() - index.at > maxAgeMs) index = { at: Date.now(), map: build() };
	return index.map;
}

/** The profile a key is on, if exactly one profile holds it. */
export function homeOf(id: unknown, maxAgeMs = 3000): KeyHome | null {
	if (typeof id !== "string") return null;
	let list = current(maxAgeMs).get(id);
	if (!list && maxAgeMs > 0) list = current(0).get(id); // maybe just written
	return list && list.length === 1 ? list[0] : null;
}

/** True when the same id sits in more than one profile (a copied key). */
export function isDuplicate(id: unknown): boolean {
	return typeof id === "string" && (current(3000).get(id)?.length ?? 0) > 1;
}

export const newKeyId = (): string => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6);
