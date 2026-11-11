import fs from "node:fs";
import path from "node:path";
import { PLUGIN_UUID, elgatoDir } from "./paths";

// Read-only look at Stream Deck's profile folder. Nothing there is ever
// written, moved or deleted. For each profile only its name and, on its pages,
// this plugin's own keys are read; other plugins' keys and settings are never
// looked at.

export interface PageInfo {
	folder: string;
	/** number of keys on the page (any plugin) */
	actions: number;
	images: number;
	/** `_pbId` of this plugin's keys on the page (maps a key to its profile) */
	ids: string[];
}

export interface ProfileInfo {
	store: string;
	folder: string;
	dir: string;
	name: string;
	/** the board path for profiles installed by this plugin ("boards/sd/0001"), else "" */
	preconfigured: string;
	/** installed by this plugin */
	ours: boolean;
	pages: PageInfo[];
	modified: string;
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function scanPage(dir: string, folder: string): PageInfo {
	const info: PageInfo = { folder, actions: 0, images: 0, ids: [] };
	try {
		info.images = fs.readdirSync(path.join(dir, "Images")).length;
	} catch {
		/* no images */
	}
	const m = readJson(path.join(dir, "manifest.json"));
	const controllers = m && Array.isArray(m.Controllers) ? (m.Controllers as Record<string, unknown>[]) : [];
	for (const c of controllers) {
		const actions = c.Actions && typeof c.Actions === "object" ? (c.Actions as Record<string, Record<string, unknown>>) : {};
		for (const a of Object.values(actions)) {
			info.actions++;
			if (typeof a?.UUID !== "string" || !a.UUID.startsWith(`${PLUGIN_UUID}.`)) continue;
			const id = (a.Settings as Record<string, unknown> | undefined)?._pbId;
			if (typeof id === "string") info.ids.push(id);
		}
	}
	return info;
}

function scanProfile(store: string, root: string, folder: string): ProfileInfo | null {
	const dir = path.join(root, folder);
	const file = path.join(dir, "manifest.json");
	const m = readJson(file);
	if (!m) return null;
	const p: ProfileInfo = {
		store, folder, dir,
		name: String(m.Name ?? "?"),
		preconfigured: m.InstalledByPluginUUID === PLUGIN_UUID && typeof m.PreconfiguredName === "string" ? m.PreconfiguredName : "",
		ours: m.InstalledByPluginUUID === PLUGIN_UUID,
		pages: [],
		modified: "",
	};
	try {
		p.modified = fs.statSync(file).mtime.toISOString();
		for (const e of fs.readdirSync(path.join(dir, "Profiles"), { withFileTypes: true })) {
			if (e.isDirectory()) p.pages.push(scanPage(path.join(dir, "Profiles", e.name), e.name));
		}
	} catch {
		/* profile without pages */
	}
	return p;
}

/** All profiles in Stream Deck's profile folders (ProfilesV2 / ProfilesV3). */
export function scanProfiles(): ProfileInfo[] {
	const base = elgatoDir();
	let stores: string[] = [];
	try {
		stores = fs.readdirSync(base).filter((n) => /^Profiles/i.test(n));
	} catch {
		return [];
	}
	const out: ProfileInfo[] = [];
	for (const store of stores) {
		const dir = path.join(base, store);
		try {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!e.isDirectory() || !e.name.endsWith(".sdProfile")) continue;
				const p = scanProfile(store, dir, e.name);
				if (p) out.push(p);
			}
		} catch {
			/* unreadable store */
		}
	}
	return out;
}
