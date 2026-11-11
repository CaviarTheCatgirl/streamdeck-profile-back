import streamDeck from "@elgato/streamdeck";
import fs from "node:fs";
import path from "node:path";

import { BackAction } from "./actions/back";
import { BoardBackAction } from "./actions/board-back";
import { OpenBoardAction } from "./actions/open-board";
import { backupIfNeeded } from "./backups";
import { log, warn } from "./log";
import { loadHistory, restoreIfWanted } from "./navigator";
import { dataDir, pluginVersion } from "./paths";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new OpenBoardAction());
streamDeck.actions.registerAction(new BackAction());
streamDeck.actions.registerAction(new BoardBackAction());

streamDeck.devices.onDeviceDidConnect((ev) => {
	log("device.connect", { type: ev.device.type });
	// A short pause lets Stream Deck show its start profile first (its keys tell us its name).
	setTimeout(() => void restoreIfWanted(ev.device.id).catch((e) => warn("restore", { message: (e as Error).message })), 400).unref();
});

/** Files written by pre-release test builds; the plugin no longer keeps any of this. */
function removeTestBuildFiles(): void {
	for (const f of ["events.log", "events.old.log", "state.json", "alpha-report.txt", "diagnostics-report.txt"]) {
		try {
			fs.rmSync(path.join(dataDir(), f), { force: true });
		} catch {
			/* not there / locked: harmless */
		}
	}
}

streamDeck.connect().then(() => {
	removeTestBuildFiles();
	loadHistory();
	const version = pluginVersion();
	log("start", { version });
	// Backups: shortly after start (Stream Deck is busy loading), then hourly.
	// Each run only writes a backup when boards changed or the version did.
	setTimeout(() => backupIfNeeded(version), 15_000).unref();
	setInterval(() => backupIfNeeded(version), 60 * 60_000).unref();
});
