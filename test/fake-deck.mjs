// =============================================================================
// test/fake-deck.mjs — runs the BUILT plugin against a fake Stream Deck
//
//   npm run build && npm test
//
// Fakes the Stream Deck websocket (incl. getSettings / setSettings round trips)
// and a profile folder with one installed board (renamed "Voicemod") and two
// user profiles, one holding another plugin's secret. Then plays through real
// navigation: open boards, chains, Board Back, Back, wrong placements, Stream
// Deck's memory, warning badges, restart, the settings panel and backups.
// =============================================================================

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const UUID = "com.caviarthecatgirl.profile-back";
const SD = path.join(ROOT, `${UUID}.sdPlugin`);
const VERSION = JSON.parse(fs.readFileSync(path.join(SD, "manifest.json"), "utf8")).Version;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pb-test-"));
const SUPPORT = path.join(HOME, "Library", "Application Support");
const STORE = path.join(SUPPORT, "com.elgato.StreamDeck", "ProfilesV3");
const DATA = path.join(SUPPORT, "ProfileBack");
const B = (n) => `boards/sd/${String(n).padStart(4, "0")}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake profile store ──────────────────────────────────────────────────────
fs.mkdirSync(STORE, { recursive: true });
execFileSync("unzip", ["-q", path.join(SD, "boards", "sd", "0001.streamDeckProfile"), "-d", STORE]);
for (const d of fs.readdirSync(STORE)) {
	const f = path.join(STORE, d, "manifest.json");
	const m = JSON.parse(fs.readFileSync(f, "utf8"));
	Object.assign(m, { Name: "Voicemod", InstalledByPluginUUID: UUID, PreconfiguredName: B(1), ReadOnly: false, Version: "3.0" });
	fs.writeFileSync(f, JSON.stringify(m));
}
const mk = (folder, manifest, pages) => {
	const dir = path.join(STORE, folder);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
	for (const [p, actions] of Object.entries(pages)) {
		fs.mkdirSync(path.join(dir, "Profiles", p), { recursive: true });
		fs.writeFileSync(path.join(dir, "Profiles", p, "manifest.json"), JSON.stringify({ Controllers: [{ Type: "Keypad", Actions: actions }] }));
	}
};
mk("AAAA0000-0000-0000-0000-000000000000.sdProfile", { Device: { Model: "20GBA9901", UUID: "" }, Name: "Game 1", Pages: {}, Version: "3.0" },
	{ P1: { "0,0": { UUID: "com.other.plugin.action", Settings: { token: "SECRET-TOKEN-123" } } } });
mk("CCCC0000-0000-0000-0000-000000000000.sdProfile", { Device: { Model: "20GBA9901", UUID: "" }, Name: "Game 2", Pages: {}, Version: "3.0" }, { P1: {} });
// Files left by pre-release test builds: the plugin removes them on start.
fs.mkdirSync(DATA, { recursive: true });
for (const f of ["events.log", "state.json", "alpha-report.txt", "diagnostics-report.txt"]) fs.writeFileSync(path.join(DATA, f), "old");

// ── fake Stream Deck ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: 0 });
const port = wss.address().port;
const got = [];
const settings = new Map(); // context → settings
const ctxInfo = new Map(); // context → { action, device }
let sock;
let mark = 0; // index into `got` for "since" queries

const since = () => got.slice(mark);
const waitFor = (pred, ms = 3000) => new Promise((resolve) => {
	const t0 = Date.now();
	const tick = () => {
		const m = since().find(pred);
		if (m) return resolve(m);
		if (Date.now() - t0 > ms) return resolve(null);
		setTimeout(tick, 15);
	};
	tick();
});
const send = (o) => sock.send(JSON.stringify(o));

wss.on("connection", (s) => {
	sock = s;
	s.on("message", (raw) => {
		const m = JSON.parse(String(raw));
		got.push(m);
		if (m.event === "setSettings") settings.set(m.context, m.payload);
		if (m.event === "getSettings") {
			const i = ctxInfo.get(m.context);
			send({ action: `${UUID}.${i.action}`, event: "didReceiveSettings", context: m.context, device: i.device, payload: { settings: settings.get(m.context) ?? {}, coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
		}
	});
});

const appear = (action, context, s, device = "DEV1") => {
	if (s) settings.set(context, s);
	ctxInfo.set(context, { action, device });
	send({ action: `${UUID}.${action}`, event: "willAppear", context, device, payload: { controller: "Keypad", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: settings.get(context) ?? {}, state: 0 } });
};
const disappear = (context) => {
	const i = ctxInfo.get(context);
	send({ action: `${UUID}.${i.action}`, event: "willDisappear", context, device: i.device, payload: { controller: "Keypad", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: settings.get(context) ?? {} } });
};
const press = (context) => {
	const i = ctxInfo.get(context);
	const payload = { coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: settings.get(context) ?? {}, state: 0 };
	send({ action: `${UUID}.${i.action}`, event: "keyDown", context, device: i.device, payload });
	send({ action: `${UUID}.${i.action}`, event: "keyUp", context, device: i.device, payload });
};
const stampOf = (context) => (settings.get(context) ?? {})._pb;
const switched = () => waitFor((m) => m.event === "switchToProfile");
/** Simulate Stream Deck showing a profile: old keys go, new keys come (all within a few ms). */
const show = (gone, come) => { gone.forEach(disappear); come.forEach(([a, c, s]) => appear(a, c, s)); };
const history = () => JSON.parse(fs.readFileSync(path.join(DATA, "history.json"), "utf8")).DEV1.stack;

const info = {
	application: { font: "Arial", language: "en", platform: "mac", platformVersion: "14.0", version: "7.5.1.0" },
	colors: {}, devicePixelRatio: 2,
	devices: [
		{ id: "DEV1", name: "Stream Deck", size: { columns: 5, rows: 3 }, type: 0 },
		{ id: "PEDAL", name: "Pedal", size: { columns: 3, rows: 1 }, type: 5 },
	],
	plugin: { uuid: UUID, version: VERSION },
};
let stderr = "";
const start = () => {
	const c = spawn(process.execPath, [path.join(SD, "bin", "plugin.js"), "-port", String(port), "-pluginUUID", "PLUGINCTX", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
		cwd: SD, env: { ...process.env, HOME }, stdio: ["ignore", "pipe", "pipe"],
	});
	c.stderr.on("data", (d) => { stderr += d; });
	return c;
};
let child = start();
/** Put one of our keys into a fake profile file, the way Stream Deck saves settings. */
const putKey = (folder, action, context, pos = "4,2") => {
	const f = path.join(STORE, folder, "Profiles", "P1", "manifest.json");
	const m = JSON.parse(fs.readFileSync(f, "utf8"));
	m.Controllers[0].Actions[pos] = { UUID: `${UUID}.${action}`, Settings: settings.get(context) ?? {} };
	fs.writeFileSync(f, JSON.stringify(m));
};
const GAME1 = "AAAA0000-0000-0000-0000-000000000000.sdProfile";
const GAME2 = "CCCC0000-0000-0000-0000-000000000000.sdProfile";


try {
	ok(await waitFor((m) => m.event === "registerPlugin"), "plugin registers");
	await sleep(300);
	ok(["events.log", "state.json", "alpha-report.txt", "diagnostics-report.txt"].every((f) => !fs.existsSync(path.join(DATA, f))), "old test-build files are removed");

	// ── Game 1 (normal profile): a fresh Open Board key ─────────────────────
	mark = got.length;
	appear("open-board", "g1-open", {});
	const s0 = await waitFor((m) => m.event === "setSettings" && m.context === "g1-open" && m.payload.board !== undefined);
	ok(s0?.payload.board === 2 && s0?.payload.page === "first", `new key gets the first unused board (Board 1 is in use) → ${JSON.stringify(s0?.payload)}`);
	const t0 = await waitFor((m) => m.event === "setTitle" && m.context === "g1-open");
	ok(t0?.payload?.title === "Board 2", `title shows the board name → "${t0?.payload?.title}"`);

	ok(typeof settings.get("g1-open")?._pbId === "string", "every key gets an id");
	putKey(GAME1, "open-board", "g1-open"); // Stream Deck saves the key into Game 1's file

	// Point it at Board 1 ("Voicemod") and press.
	settings.set("g1-open", { ...settings.get("g1-open"), board: 1, page: "first", showName: true });
	send({ action: `${UUID}.open-board`, event: "didReceiveSettings", context: "g1-open", device: "DEV1", payload: { settings: settings.get("g1-open"), coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
	const t1 = await waitFor((m) => m.event === "setTitle" && m.context === "g1-open" && m.payload?.title === "Voicemod");
	ok(t1, "renamed board's real name appears on the key");

	mark = got.length;
	press("g1-open");
	const sw1 = await switched();
	ok(sw1?.payload?.profile === B(1) && sw1?.payload?.page === 0, `Open Board → ${JSON.stringify(sw1?.payload)} (first page)`);
	show(["g1-open"], [["back", "b1-back"], ["board-back", "b1-bb"], ["open-board", "b1-open", { board: 2, page: "remembered", showName: true }]]);
	await sleep(250);
	ok(stampOf("b1-back") === `board:${B(1)}` && stampOf("b1-bb") === `board:${B(1)}` && stampOf("b1-open") === `board:${B(1)}`, "keys appearing after the switch are stamped as Board 1");
	ok(stampOf("g1-open") === undefined, "key that disappeared is not stamped");

	// Board 1 → Board 2 (remembered page).
	mark = got.length;
	press("b1-open");
	const sw2 = await switched();
	ok(sw2?.payload?.profile === B(2) && sw2?.payload?.page === undefined, `board → board, remembered page → ${JSON.stringify(sw2?.payload)}`);
	show(["b1-back", "b1-bb", "b1-open"], [["back", "b2-back"], ["board-back", "b2-bb"], ["open-board", "b2-open", { board: 3, page: "2", showName: true }]]);
	await sleep(250);
	ok(stampOf("b2-bb") === `board:${B(2)}`, "Board 2 keys stamped");

	// Board 2 → Board 3, page 2.
	mark = got.length;
	press("b2-open");
	const sw3 = await switched();
	ok(sw3?.payload?.profile === B(3) && sw3?.payload?.page === 1, `specific page → ${JSON.stringify(sw3?.payload)}`);
	show(["b2-back", "b2-bb", "b2-open"], [["back", "b3-back"], ["board-back", "b3-bb"]]);
	await sleep(250);
	ok(JSON.stringify(history()) === JSON.stringify([B(1), B(2), B(3)]), `history ${history().join(" → ")}`);
	const h0 = JSON.parse(fs.readFileSync(path.join(DATA, "history.json"), "utf8")).DEV1;
	ok(h0.origin === "Game 1" && h0.memory === "Game 1", `chain knows it started on Game 1 (origin ${h0.origin}, Stream Deck remembers ${h0.memory})`);

	// Board Back ×2 walks the chain, a 3rd one leaves like Back.
	mark = got.length;
	press("b3-bb");
	const bb1 = await switched();
	ok(bb1?.payload?.profile === B(2) && bb1?.payload?.page === undefined, `Board Back on 3 → ${bb1?.payload?.profile} (its last page)`);
	show(["b3-back", "b3-bb"], [["back", "b2-back"], ["board-back", "b2-bb"], ["open-board", "b2-open"]]);
	await sleep(250);
	mark = got.length;
	press("b2-bb");
	const bb2 = await switched();
	ok(bb2?.payload?.profile === B(1), `Board Back on 2 → ${bb2?.payload?.profile}`);
	show(["b2-back", "b2-bb", "b2-open"], [["back", "b1-back"], ["board-back", "b1-bb"], ["open-board", "b1-open"]]);
	await sleep(250);
	mark = got.length;
	press("b1-bb");
	const bb3 = await switched();
	ok(bb3 && !bb3.payload?.profile, "Board Back on the first board → Stream Deck's previous profile (like Back)");
	show(["b1-back", "b1-bb", "b1-open"], [["open-board", "g1-open"], ["back", "g1-back", {}]]);
	await sleep(250);
	ok(stampOf("g1-open") === "normal" && stampOf("g1-back") === "normal", "keys on the normal profile get stamped normal");
	ok(history().length === 0, "history cleared after leaving the boards");

	// Back / Board Back placed on a normal profile → alert, no switch.
	mark = got.length;
	press("g1-back");
	ok(await waitFor((m) => m.event === "showAlert" && m.context === "g1-back"), "Back on a normal profile shows an alert");
	await sleep(150);
	ok(!since().some((m) => m.event === "switchToProfile"), "…and sends no switch (Stream Deck would refuse)");

	// Deep chain: 1 → 2 → … → 8.
	mark = got.length;
	press("g1-open");
	await switched();
	show(["g1-open", "g1-back"], [["open-board", "c1", { board: 2, page: "first" }], ["back", "c1-back"]]);
	await sleep(200);
	let prev = ["c1", "c1-back"];
	for (let n = 2; n <= 8; n++) {
		mark = got.length;
		press(`c${n - 1}`);
		const s = await switched();
		if (s?.payload?.profile !== B(n)) { ok(false, `chain step ${n} → ${s?.payload?.profile}`); break; }
		const keys = [["open-board", `c${n}`, { board: n + 1, page: "first" }], ["board-back", `c${n}-bb`], ["back", `c${n}-back`]];
		show(prev, keys);
		prev = keys.map((k) => k[1]);
		await sleep(200);
	}
	ok(history().length === 8 && history()[7] === B(8), `chain of 8 boards recorded (${history().length})`);
	// Board Back ×3 from board 8 → 7 → 6 → 5
	let at = 8;
	for (let k = 0; k < 3; k++) {
		mark = got.length;
		press(`c${at}-bb`);
		const s = await switched();
		ok(s?.payload?.profile === B(at - 1), `Board Back from ${at} → ${s?.payload?.profile}`);
		at -= 1;
		const keys = [["open-board", `c${at}`], ["board-back", `c${at}-bb`], ["back", `c${at}-back`]];
		show(prev, keys);
		prev = keys.map((x) => x[1]);
		await sleep(200);
	}
	// Back from board 5 → home in one press.
	mark = got.length;
	press(`c${at}-back`);
	const home = await switched();
	ok(home && !home.payload?.profile, "Back from board 5 of 8 → straight to the normal profile");
	show(prev, [["open-board", "g1-open"], ["back", "g1-back"]]);
	await sleep(200);
	ok(history().length === 0, "Back clears the history");

	// Native switch between boards: an already-stamped key appearing re-aligns the history.
	mark = got.length;
	press("g1-open"); await switched();
	show(["g1-open", "g1-back"], [["open-board", "c1"], ["back", "c1-back"]]);
	await sleep(200);
	mark = got.length;
	press("c1"); await switched();
	show(["c1", "c1-back"], [["board-back", "c2-bb"], ["open-board", "c2"]]);
	await sleep(500);
	// User goes back to Board 1 with Stream Deck's own Switch Profile key (no plugin switch):
	show(["c2-bb", "c2"], [["open-board", "c1"], ["back", "c1-back"]]);
	await sleep(150);
	ok(JSON.stringify(history()) === JSON.stringify([B(1)]), `native switch back to Board 1 is noticed → history ${history().join(" → ")}`);

	// Device without boards (Pedal).
	mark = got.length;
	appear("open-board", "pedal-open", { board: 1 }, "PEDAL");
	press("pedal-open");
	ok(await waitFor((m) => m.event === "showAlert" && m.context === "pedal-open"), "Open Board on a deck without boards shows an alert");

	// ── 3a: leave the boards without Back, then come back from Game 2 ────────
	show(["c1", "c1-back"], [["open-board", "g1-open"], ["back", "g1-back"]]);
	await sleep(200);
	mark = got.length;
	press("g1-open"); await switched(); // Game 1 → Board 1
	show(["g1-open", "g1-back"], [["back", "b1-back"], ["board-back", "b1-bb"]]);
	await sleep(250);
	// …user picks Game 2 in the app window (no plugin switch). Its key already exists (saved in Game 2's file):
	settings.set("g2-open", { board: 1, page: "first", _pbId: "g2key00000001" });
	putKey(GAME2, "open-board", "g2-open");
	await sleep(3100); // let the plugin's 3 s profile-folder cache expire, like real time passing
	show(["b1-back", "b1-bb"], [["open-board", "g2-open"]]);
	await sleep(250);
	let nav = JSON.parse(fs.readFileSync(path.join(DATA, "history.json"), "utf8")).DEV1;
	ok(nav.leftWithoutBack === true && nav.stack.length === 0, "leaving the boards without Back is noticed");
	mark = got.length;
	press("g2-open"); await switched();
	show(["g2-open"], [["back", "b1-back"], ["board-back", "b1-bb"]]);
	await sleep(250);
	ok(since().some((m) => m.event === "setImage" && m.context === "b1-back" && m.payload?.image === "imgs/actions/back/key-warn"), "Back key shows the warning badge (goes to Game 1, not Game 2)");
	ok(since().some((m) => m.event === "setImage" && m.context === "b1-bb" && m.payload?.image === "imgs/actions/board-back/key-warn"), "Board Back on the first board shows it too");
	nav = JSON.parse(fs.readFileSync(path.join(DATA, "history.json"), "utf8")).DEV1;
	ok(nav.origin === "Game 2" && nav.memory === "Game 1", `new chain from Game 2, Stream Deck still remembers Game 1 (origin ${nav.origin}, memory ${nav.memory})`);
	mark = got.length;
	send({ action: `${UUID}.back`, event: "propertyInspectorDidAppear", context: "b1-back", device: "DEV1" });
	const stBack = await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload?.type === "state");
	ok(stBack?.payload?.origin === "Game 2" && stBack?.payload?.memory === "Game 1", "Back's panel shows: goes to Game 1, not Game 2");
	mark = got.length;
	press("b1-back"); await switched();
	show(["b1-back", "b1-bb"], [["open-board", "g1-open"], ["back", "g1-back"]]); // Stream Deck lands on Game 1
	await sleep(300);
	nav = JSON.parse(fs.readFileSync(path.join(DATA, "history.json"), "utf8")).DEV1;
	ok(nav.memory === null && nav.leftWithoutBack === false, "Back uses up Stream Deck's memory");

	// Board opened by hand (app window): Stream Deck remembers nothing → badge, and an alert instead of silence.
	mark = got.length;
	show(["g1-open", "g1-back"], [["back", "b1-back"], ["board-back", "b1-bb"]]);
	await sleep(300);
	ok(since().some((m) => m.event === "setImage" && m.context === "b1-back" && m.payload?.image === "imgs/actions/back/key-warn"), "board opened by hand: Back shows the warning badge");
	mark = got.length;
	const pressedAt = Date.now();
	press("b1-back");
	const al = await waitFor((m) => m.event === "showAlert" && m.context === "b1-back", 2500);
	ok(al && Date.now() - pressedAt < 600, `…and pressing it shows the alert right away (${Date.now() - pressedAt} ms)`);
	await sleep(1500);
	ok(since().filter((m) => m.event === "showAlert" && m.context === "b1-back").length === 1, "…only once (no second, late alert)");
	show(["b1-back", "b1-bb"], [["open-board", "g1-open"], ["back", "g1-back"]]); // user goes to Game 1 by hand
	await sleep(250);
	mark = got.length;
	press("g1-open"); await switched();
	show(["g1-open", "g1-back"], [["back", "b1-back"], ["board-back", "b1-bb"]]);
	await sleep(300);
	ok(since().some((m) => m.event === "setImage" && m.context === "b1-back" && m.payload?.image === undefined), "opened with Open Board again: badge gone");
	mark = got.length;
	press("b1-back"); await switched();
	show(["b1-back", "b1-bb"], [["open-board", "g1-open"], ["back", "g1-back"]]);
	await sleep(250);

	// ── settings panel (back on Game 1) ─────────────────────────────────────
	mark = got.length;
	send({ action: `${UUID}.open-board`, event: "propertyInspectorDidAppear", context: "g1-open", device: "DEV1" });
	const st = await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload?.type === "state");
	ok(st?.payload?.device?.boards === 100 && st.payload.device.supported, "panel: 100 boards for this deck");
	ok(st?.payload?.installed?.some((b) => b.n === 1 && b.name === "Voicemod"), "panel: lists installed boards by their real name");
	ok(st?.payload?.where?.kind === "normal" && st.payload.where.name === "Game 1", `panel: knows this key is on Game 1 (${st?.payload?.where?.name})`);

	mark = got.length;
	send({ action: `${UUID}.open-board`, event: "sendToPlugin", context: "g1-open", payload: { type: "backup-now" } });
	const toast = await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload?.type === "toast");
	ok(/Backed up 1 board\./.test(toast?.payload?.text ?? ""), `backup now → "${toast?.payload?.text}"`);
	const dirs = fs.readdirSync(path.join(DATA, "backups")).filter((d) => !d.includes("."));
	const files = fs.readdirSync(path.join(DATA, "backups", dirs[0]));
	ok(files.some((f) => f.startsWith("Board 1 - Voicemod")), `backup file named after the board: ${files.join(", ")}`);
	ok(fs.existsSync(path.join(DATA, "backups", "HOW TO RESTORE.txt")), "restore instructions written next to backups");
	const zl = execFileSync("unzip", ["-l", path.join(DATA, "backups", dirs[0], files.find((f) => f.startsWith("Board 1")))]).toString();
	ok(/\.sdProfile\/manifest\.json/.test(zl), "backup is a Stream Deck profile archive");

	// Privacy: nothing the plugin writes contains another plugin's settings.
	const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
	ok(walk(DATA).every((f) => !fs.readFileSync(f).includes("SECRET-TOKEN-123")), "other plugins' settings never end up in the plugin's files");
	ok(fs.readdirSync(STORE).length === 3, "Stream Deck's profile folder untouched");

	// ── restart while on Board 2 → reopened ─────────────────────────────────
	mark = got.length;
	press("g1-open"); await switched();
	show(["g1-open", "g1-back"], [["open-board", "c1", { board: 2, page: "first" }], ["back", "c1-back"]]);
	await sleep(200);
	mark = got.length;
	press("c1"); await switched();
	show(["c1", "c1-back"], [["board-back", "c2-bb"], ["back", "c2-back"]]);
	await sleep(300);
	child.kill();
	await sleep(300);
	mark = got.length;
	child = start();
	ok(await waitFor((m) => m.event === "registerPlugin"), "plugin restarts");
	await sleep(300);
	appear("open-board", "g1-open"); // Stream Deck starts on Game 1
	send({ event: "deviceDidConnect", device: "DEV1", deviceInfo: { name: "Stream Deck", type: 0, size: { columns: 5, rows: 3 } } });
	const rs = await waitFor((m) => m.event === "switchToProfile", 4000);
	ok(rs?.payload?.profile === B(2), `after a restart the plugin reopens Board 2 (${rs?.payload?.profile})`);
	show(["g1-open"], [["board-back", "c2-bb"], ["back", "c2-back"]]);
	await sleep(250);
	mark = got.length;
	press("c2-bb");
	const rb = await switched();
	ok(rb?.payload?.profile === B(1), `…with its history: Board Back → ${rb?.payload?.profile}`);

	// Option off → no reopen.
	show(["c2-bb", "c2-back"], [["open-board", "c1"], ["back", "c1-back"]]);
	await sleep(200);
	mark = got.length;
	press("c1"); await switched();
	show(["c1", "c1-back"], [["board-back", "c2-bb"], ["back", "c2-back"]]);
	await sleep(300);
	fs.writeFileSync(path.join(DATA, "options.json"), JSON.stringify({ restoreOnStart: false }));
	child.kill();
	await sleep(300);
	mark = got.length;
	child = start();
	await waitFor((m) => m.event === "registerPlugin");
	await sleep(300);
	appear("open-board", "g1-open");
	send({ event: "deviceDidConnect", device: "DEV1", deviceInfo: { name: "Stream Deck", type: 0, size: { columns: 5, rows: 3 } } });
	ok(!(await waitFor((m) => m.event === "switchToProfile", 2500)), "with the option off, Stream Deck's start profile stays");
} finally {
	child.kill();
	wss.close();
	if (stderr.trim()) console.log(`plugin stderr:\n${stderr}`);
	console.log(failures ? `\n${failures} FAILED  (files kept in ${HOME})` : "\nall checks passed");
	if (!failures && !process.env.KEEP) fs.rmSync(HOME, { recursive: true, force: true });
	process.exit(failures ? 1 : 0);
}
