// =============================================================================
// scripts/make-profiles.mjs — writes the bundled .streamDeckProfile files
//
// Run: npm run profiles   (output is committed; the normal build doesn't run it)
//
// Format = what the Stream Deck app exports (checked against Elgato's own
// "lights-out" sample plugin, which bundles one profile per device type):
//
//   <PROFILE-UUID>.sdProfile/manifest.json
//       { Device: { Model, UUID: "" }, Name, Pages: { Current, Default, Pages: [...] }, Version: "2.0" }
//   <PROFILE-UUID>.sdProfile/Profiles/<PAGE-FOLDER>/manifest.json
//       { Controllers: [{ Actions: { "col,row": {...} }, Type: "Keypad" }], Icon: "", Name: "" }
//   <PROFILE-UUID>.sdProfile/Profiles/<PAGE-FOLDER>/Images/
//
// PAGE-FOLDER = the page UUID's 16 bytes in base32hex, with the alphabet's
// "U" and "V" shifted to "V" and "W" (no U), plus a trailing "Z". Verified
// against every page of the Elgato sample (selfTest below).
// "Default" is an empty page that is NOT listed in Pages (same as the sample).
//
// IDs are derived from fixed seeds, so every build produces identical files
// (an update ships byte-identical profiles unless the layout changes).
// =============================================================================

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const PLUGIN = "com.caviarthecatgirl.profile-back";

// ── ids ─────────────────────────────────────────────────────────────────────
function seededUuid(seed) {
	const b = createHash("sha1").update(`${PLUGIN}/${seed}`).digest().subarray(0, 16);
	b[6] = (b[6] & 0x0f) | 0x50; // version 5 style
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const B32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
const SD_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTVW";
export function pageFolder(uuid) {
	const bytes = Buffer.from(uuid.replace(/-/g, ""), "hex");
	let n = BigInt(`0x${bytes.toString("hex")}`) << 2n; // 128 bits → 130 = 26 × 5
	let s = "";
	for (let i = 0; i < 26; i++) { s = SD_ALPHA[Number(n & 31n)] + s; n >>= 5n; }
	return `${s}Z`;
}

function selfTest() {
	// Pairs taken from Elgato's lights-out sample profiles.
	const known = [
		["cca21b93-64c5-4578-8a58-a6c35df9a5f2", "PIH1N4R4OL2NH2IOKR1LRVD5V8Z"],
		["58012f2d-6556-4424-a672-51814fcb396c", "B00IVBB5AP2299JIA60KWIPPDGZ"],
	];
	for (const [u, f] of known) if (pageFolder(u) !== f) throw new Error(`pageFolder(${u}) = ${pageFolder(u)}, expected ${f}`);
	void B32HEX;
}

// ── devices ─────────────────────────────────────────────────────────────────
// DeviceType numbers = @elgato/schemas DeviceType. Models = what the app
// writes into exported profiles (Elgato sample + observed manifests).
export const DEVICES = {
	sd: { type: 0, model: "20GAA9901", controllers: ["Keypad"], cols: 5, rows: 3 },
	mini: { type: 1, model: "20GAI9901", controllers: ["Keypad"], cols: 3, rows: 2 },
	xl: { type: 2, model: "20GAT9901", controllers: ["Keypad"], cols: 8, rows: 4 },
	plus: { type: 7, model: "20GBD9901", controllers: ["Keypad", "Encoder"], cols: 4, rows: 2 },
	neo: { type: 9, model: "20GBJ9901", controllers: ["Keypad", "Neo"], cols: 4, rows: 2 },
	plusxl: { type: 13, model: "20GBX9901", controllers: ["Keypad", "Encoder"], cols: 9, rows: 4 },
};
// Stream Deck rewrites Device.Model to the user's exact deck on install
// (e.g. 20GAA9901 becomes 20GBA9901 on an MK.2), so the model only has to be
// plausible; DeviceType in the plugin manifest decides which deck gets it.

// ── actions placed on generated pages ───────────────────────────────────────
const titleState = () => ({
	FontFamily: "", FontSize: 9, FontStyle: "", FontUnderline: false, OutlineThickness: 2,
	ShowTitle: true, TitleAlignment: "bottom", TitleColor: "#ffffff",
});
function placed(seed, kind, name, settings) {
	return {
		ActionID: seededUuid(`action/${seed}`),
		LinkedTitle: true,
		Name: name,
		Settings: settings,
		State: 0,
		States: [titleState()],
		UUID: `${PLUGIN}.${kind}`,
	};
}

// ── board pool ──────────────────────────────────────────────────────────────
// boards/<device>/<nnnn>.streamDeckProfile, shown as "Board <n>".
// Only a Back key is pre-placed (top-left), so every board works out of the box.
// The count may only GROW: boards.lock.json remembers the highest count ever
// shipped and the script refuses to write fewer. Shrinking would cut the link
// between boards people already use and the plugin.
// (One deliberate reset happened before release: a stress-test build shipped
// 1000, 1.0 ships 100. Only test boards were affected. Never again.)
export const BOARDS_PER_DEVICE = 100;
const BOARD_DEVICES = ["sd", "mini", "xl", "plus", "neo", "plusxl"];
const pad = (n) => String(n).padStart(4, "0");
export const boardPath = (dev, n) => `boards/${dev}/${pad(n)}`;
function boardSpec(dev, n) {
	return { file: boardPath(dev, n), device: dev, name: `Board ${n}`, pages: [{ "0,0": ["back", "Back", {}] }] };
}

function buildProfile(spec) {
	const dev = DEVICES[spec.device];
	const profileId = seededUuid(`profile/${spec.file}`).toUpperCase();
	const root = `${profileId}.sdProfile`;
	const files = [];
	const emptyControllers = dev.controllers.map((t) => ({ Actions: {}, Type: t }));

	const defaultId = seededUuid(`profile/${spec.file}/default`);
	files.push({ name: `${root}/Profiles/${pageFolder(defaultId)}/manifest.json`, data: JSON.stringify({ Controllers: emptyControllers, Icon: "", Name: "" }) });

	const pageIds = [];
	spec.pages.forEach((p, i) => {
		const id = seededUuid(`profile/${spec.file}/page/${i + 1}`);
		pageIds.push(id);
		const actions = {};
		for (const [pos, [kind, label, settings, seed]] of Object.entries(p)) actions[pos] = placed(`${spec.file}/${i}/${seed ?? pos}`, kind, label, settings);
		const controllers = dev.controllers.map((t) => ({ Actions: t === "Keypad" ? actions : {}, Type: t }));
		files.push({ name: `${root}/Profiles/${pageFolder(id)}/manifest.json`, data: JSON.stringify({ Controllers: controllers, Icon: "", Name: "" }) });
	});

	files.unshift({
		name: `${root}/manifest.json`,
		data: JSON.stringify({ Device: { Model: dev.model, UUID: "" }, Name: spec.name, Pages: { Current: pageIds[0], Default: defaultId, Pages: pageIds }, Version: "2.0" }),
	});
	// Directory entries, in the same order the app writes them.
	const dirs = new Set();
	for (const f of files) {
		const parts = f.name.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
		if (f.name.endsWith("/manifest.json") && f.name.includes("/Profiles/")) dirs.add(f.name.replace(/manifest\.json$/, "Images/"));
	}
	const entries = [...dirs].sort().map((d) => ({ name: d, data: Buffer.alloc(0) }));
	for (const f of files) entries.push({ name: f.name, data: Buffer.from(f.data, "utf8") });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return zip(entries);
}

// ── tiny ZIP writer (deflate, fixed timestamp → reproducible) ───────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(entries) {
	const local = [], central = [];
	let offset = 0;
	const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
	for (const e of entries) {
		const name = Buffer.from(e.name, "utf8");
		const isDir = e.name.endsWith("/");
		const comp = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(e.data);
		const method = isDir ? 0 : 8;
		const crc = isDir ? 0 : crc32(e.data);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
		lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
		local.push(lh, name, comp);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
		ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
		ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(isDir ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
		central.push(ch, name);
		offset += 30 + name.length + comp.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, cd, end]);
}

// ── main ────────────────────────────────────────────────────────────────────
selfTest();

const LOCK = path.join(ROOT, "boards.lock.json");
const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, "utf8")) : {};
for (const dev of BOARD_DEVICES) {
	if ((lock[dev] ?? 0) > BOARDS_PER_DEVICE) {
		throw new Error(`boards.lock.json says ${lock[dev]} boards were shipped for "${dev}"; refusing to build only ${BOARDS_PER_DEVICE}. The pool may only grow.`);
	}
}

const SD = path.join(ROOT, `${PLUGIN}.sdPlugin`);
const write = (rel, buf) => {
	const file = path.join(SD, `${rel}.streamDeckProfile`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Skip identical files: keeps rebuilds fast and mtimes stable.
	if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return false;
	fs.writeFileSync(file, buf);
	return true;
};

const t0 = Date.now();
let written = 0, total = 0;
const entries = [];
for (const dev of BOARD_DEVICES) {
	for (let n = 1; n <= BOARDS_PER_DEVICE; n++) {
		const spec = boardSpec(dev, n);
		if (write(spec.file, buildProfile(spec))) written++;
		total++;
		entries.push({ Name: spec.file, DeviceType: DEVICES[dev].type, Readonly: false, DontAutoSwitchWhenInstalled: false, AutoInstall: false });
	}
}

// Pre-release builds left files in the plugin folder that 1.0 no longer has; an update
// extracted over an old project would otherwise pack them again.
for (const rel of ["profiles", "ui/go-slot.html", "imgs/actions/probe", "imgs/actions/slot", "imgs/actions/report"]) {
	fs.rmSync(path.join(SD, rel), { recursive: true, force: true });
}

// Drop board files this version doesn't ship (left over from a bigger local build).
for (const dev of BOARD_DEVICES) {
	const dir = path.join(SD, "boards", dev);
	if (!fs.existsSync(dir)) continue;
	for (const f of fs.readdirSync(dir)) {
		const n = Number(f.replace(/\.streamDeckProfile$/, ""));
		if (!(n >= 1 && n <= BOARDS_PER_DEVICE)) fs.rmSync(path.join(dir, f));
	}
}

// Manifest: replace only the Profiles array, keep everything else as it is.
const mfile = path.join(SD, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(mfile, "utf8"));
manifest.Profiles = entries;
const text = `${JSON.stringify(manifest, null, "\t")}\n`;
if (fs.readFileSync(mfile, "utf8") !== text) fs.writeFileSync(mfile, text);

const newLock = Object.fromEntries(BOARD_DEVICES.map((d) => [d, Math.max(lock[d] ?? 0, BOARDS_PER_DEVICE)]));
fs.writeFileSync(LOCK, `${JSON.stringify(newLock, null, "\t")}\n`);

console.log(`profiles: ${total} (${written} written, ${total - written} unchanged), manifest entries: ${entries.length}, ${Date.now() - t0} ms`);
