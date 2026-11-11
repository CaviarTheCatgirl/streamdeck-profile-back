import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseBoardPath } from "./boards";
import { log, warn } from "./log";
import { dataDir, ensureDir } from "./paths";
import { scanProfiles, type ProfileInfo } from "./scan";
import { collect, zip } from "./zip";

// Copies of every installed board as double-clickable .streamDeckProfile files
// in %APPDATA%\ProfileBack\backups\<time>\. Restoring = double-click: tested
// on Stream Deck 7.5 that the import keeps the board's link to the plugin and
// takes over that board number.
//
// Automatic: at startup and every hour, but only when something changed
// (or the plugin version changed). The newest KEEP backups are kept.

const KEEP = 30;
const MIN_GAP_MS = 60 * 60_000;

export const backupsDir = (): string => path.join(dataDir(), "backups");
const lastFile = (): string => path.join(backupsDir(), "last.json");

interface Last { at: string; fingerprint: string; version: string; folder: string; boards: number }

function readLast(): Last | null {
	try {
		return JSON.parse(fs.readFileSync(lastFile(), "utf8")) as Last;
	} catch {
		return null;
	}
}

function ourProfiles(): ProfileInfo[] {
	return scanProfiles().filter((p) => p.ours);
}

/** Changes whenever a board is added, removed, renamed or edited. */
function fingerprint(profiles: ProfileInfo[]): string {
	const h = createHash("sha1");
	for (const p of [...profiles].sort((a, b) => a.folder.localeCompare(b.folder))) {
		h.update(`${p.folder}|${p.name}|${p.modified}|`);
		for (const pg of p.pages) h.update(`${pg.folder}:${pg.actions}:${pg.images};`);
	}
	return h.digest("hex");
}

const safe = (s: string): string => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80) || "board";

export interface BackupResult { folder: string; files: string[]; errors: string[]; skipped?: string }

export function backupNow(reason: string, version: string): BackupResult {
	const profiles = ourProfiles();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const folder = path.join(backupsDir(), stamp);
	const res: BackupResult = { folder, files: [], errors: [] };
	if (!profiles.length) {
		res.skipped = "no boards installed";
		return res;
	}
	ensureDir(folder);
	writeReadme();
	for (const p of profiles) {
		const b = parseBoardPath(p.preconfigured);
		const label = b ? (p.name === `Board ${b.n}` ? p.name : `Board ${b.n} - ${p.name}`) : p.name;
		const file = path.join(folder, `${safe(label)} [${p.store}].streamDeckProfile`);
		try {
			fs.writeFileSync(file, zip(collect(p.dir, p.folder)) as unknown as Uint8Array);
			res.files.push(file);
		} catch (e) {
			res.errors.push(`${p.name}: ${(e as Error).message}`);
		}
	}
	const last: Last = { at: new Date().toISOString(), fingerprint: fingerprint(profiles), version, folder, boards: res.files.length };
	fs.writeFileSync(lastFile(), JSON.stringify(last, null, 2));
	prune();
	log("backup", { reason, boards: res.files.length, errors: res.errors.length });
	if (res.errors.length) warn("backup-errors", { errors: res.errors });
	return res;
}

/** Backs up only if something changed (or the plugin version did) and the last one is old enough. */
export function backupIfNeeded(version: string): void {
	try {
		const last = readLast();
		const profiles = ourProfiles();
		if (!profiles.length) return;
		const versionChanged = !last || last.version !== version;
		const changed = !last || last.fingerprint !== fingerprint(profiles);
		const oldEnough = !last || Date.now() - Date.parse(last.at) >= MIN_GAP_MS;
		if (versionChanged || (changed && oldEnough)) backupNow(versionChanged ? "version" : "changed", version);
	} catch (e) {
		warn("backup", { message: (e as Error).message });
	}
}

function prune(): void {
	try {
		const dirs = fs.readdirSync(backupsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
		for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP))) fs.rmSync(path.join(backupsDir(), d), { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

function writeReadme(): void {
	const f = path.join(backupsDir(), "HOW TO RESTORE.txt");
	if (fs.existsSync(f)) return;
	fs.writeFileSync(f, [
		"Profile Back - board backups",
		"",
		"Each folder is one backup (newest = latest date). Each .streamDeckProfile file is one board.",
		"",
		"To restore a board: double-click its file. Stream Deck imports it (the name may get a \"Copy\"/\"Kopie\" suffix).",
		"The imported copy stays linked to the plugin and takes over that board number,",
		"so your Open Board keys open it. Then delete the old (broken) copy in Stream Deck if it still exists.",
		"",
		"The plugin keeps the newest 30 backups and only makes a new one when something changed.",
	].join("\r\n"));
}

export interface BackupStatus { last: string | null; boards: number; folder: string; count: number }

export function backupStatus(): BackupStatus {
	const last = readLast();
	let count = 0;
	try {
		count = fs.readdirSync(backupsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
	} catch {
		/* none yet */
	}
	return { last: last?.at ?? null, boards: last?.boards ?? 0, folder: backupsDir(), count };
}
