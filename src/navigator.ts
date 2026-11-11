import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import fs from "node:fs";
import path from "node:path";
import { log, warn } from "./log";
import { homeOf, isDuplicate, newKeyId } from "./keys";
import { getOptions } from "./options";
import { dataDir, elgatoDir, ensureDir } from "./paths";

// ─────────────────────────────────────────────────────────────────────────────
// Stream Deck tells a plugin nothing about which profile is on screen. The
// navigator works it out from the plugin's own keys:
//
// • When the plugin itself switches (Open Board, Board Back, Back), it knows
//   where the deck is going. Our keys appearing right after that switch are ON
//   that profile, so each is stamped with the location (`_pb` in the key's own
//   settings; Stream Deck saves them with the profile).
// • Later, a stamped key appearing tells us where the deck is, however the
//   user got there (page change, native Switch Profile key, app window).
// • Every key also gets a random `_pbId`; a read-only scan of the profile
//   folder maps it to the profile's name ("Game 1"), see keys.ts.
//
// History per device: the boards opened (last = on screen), the normal
// profile the chain started from (`origin`) and what Stream Deck remembers as
// "previous profile" (`memory`, the target of Back).
//
// Stream Deck's rule, measured on Stream Deck 7.6:
// • it remembers the profile you were on when a PLUGIN first opens a board;
// • only Back (its "previous profile") uses that up, by jumping there — from a
//   board or even from a normal profile;
// • leaving the boards any other way keeps the old memory; opening a board by
//   hand (app window) doesn't create one; a Stream Deck restart clears it.
// No plugin can change that, so the keys show a warning badge when Back would
// go somewhere unexpected or nowhere.
// ─────────────────────────────────────────────────────────────────────────────

export type Where = { kind: "board"; board: string } | { kind: "normal" };
export const STAMP = "_pb";
export const KEY_ID = "_pbId";

const encode = (w: Where): string => (w.kind === "board" ? `board:${w.board}` : "normal");
export function decode(v: unknown): Where | null {
	if (v === "normal") return { kind: "normal" };
	if (typeof v === "string" && v.startsWith("board:")) return { kind: "board", board: v.slice(6) };
	return null;
}

interface Saved {
	stack: string[];
	/** where the deck was last known to be: a board path, "normal", or null (unknown) */
	current: string | null;
	/** name of the normal profile this chain started from */
	origin: string | null;
	/** Stream Deck's remembered "previous profile" (name; "" = a profile we couldn't name), null = nothing remembered */
	memory: string | null;
	/** left the boards without Back since Stream Deck last used its memory */
	leftWithoutBack: boolean;
	/** when this was last saved (ISO) */
	updated?: string;
}

interface Device extends Saved {
	expect: { where: Where; at: number; until: number; firstAppear: number | null } | null;
	visible: Set<string>;
	unknownTimer: NodeJS.Timeout | null;
	/** id of the last key seen on a normal profile (to name it) */
	lastNormalKey: string | null;
}

const devices = new Map<string, Device>();
/** What history.json held when the plugin started (for restore-on-start). */
const atStart = new Map<string, Saved>();
const historyFile = (): string => path.join(dataDir(), "history.json");

const blank = (): Saved => ({ stack: [], current: null, origin: null, memory: null, leftWithoutBack: false });

function dev(id: string): Device {
	let d = devices.get(id);
	if (!d) {
		d = { ...blank(), expect: null, visible: new Set(), unknownTimer: null, lastNormalKey: null };
		devices.set(id, d);
	}
	return d;
}

/** When the running Stream Deck app started (first line of its current log), if we can tell. */
function streamDeckStartedAt(): number | null {
	try {
		const fd = fs.openSync(path.join(elgatoDir(), "logs", "StreamDeck.log"), "r");
		const buf = Buffer.alloc(200);
		fs.readSync(fd, buf as unknown as Uint8Array, 0, 200, 0);
		fs.closeSync(fd);
		const m = /^\uFEFF?(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))/.exec(buf.toString("utf8"));
		const t = m ? Date.parse(m[1]) : NaN;
		return Number.isFinite(t) ? t : null;
	} catch {
		return null;
	}
}

export function loadHistory(): void {
	const sdStart = streamDeckStartedAt();
	try {
		const raw = JSON.parse(fs.readFileSync(historyFile(), "utf8")) as Record<string, Partial<Saved>>;
		for (const [id, v] of Object.entries(raw)) {
			const s: Saved = {
				stack: Array.isArray(v.stack) ? v.stack.filter((x) => typeof x === "string") : [],
				current: typeof v.current === "string" ? v.current : null,
				origin: typeof v.origin === "string" ? v.origin : null,
				memory: typeof v.memory === "string" ? v.memory : null,
				leftWithoutBack: v.leftWithoutBack === true,
			};
			// Stream Deck restarted since we last saved → its memory is gone.
			const saved = typeof v.updated === "string" ? Date.parse(v.updated) : NaN;
			if (sdStart !== null && Number.isFinite(saved) && sdStart > saved) {
				s.memory = null;
				s.leftWithoutBack = false;
			}
			atStart.set(id, { ...s, stack: [...s.stack] });
			Object.assign(dev(id), s);
		}
	} catch {
		/* first run */
	}
}

function save(): void {
	for (const id of devices.keys()) changed(id);
	const out: Record<string, Saved & { updated: string }> = {};
	for (const [id, d] of devices) {
		out[id] = { stack: d.stack, current: d.current, origin: d.origin, memory: d.memory, leftWithoutBack: d.leftWithoutBack, updated: new Date().toISOString() };
	}
	try {
		ensureDir(dataDir());
		const tmp = `${historyFile()}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
		fs.renameSync(tmp, historyFile());
	} catch (e) {
		warn("history-save", { message: (e as Error).message });
	}
}

// ── change notifications (for the keys' warning badge) ──────────────────────
type Listener = (deviceId: string) => void;
const listeners: Listener[] = [];
export function onNavChange(fn: Listener): void {
	listeners.push(fn);
}
function changed(deviceId: string): void {
	for (const fn of listeners) {
		try {
			fn(deviceId);
		} catch {
			/* a listener must not break navigation */
		}
	}
}

/**
 * What Back (Stream Deck's "previous profile") would do right now:
 * "ok", "stale" (goes to an older profile than the one you came from) or
 * "none" (Stream Deck remembers nothing: Back does nothing).
 */
export function backStatus(deviceId: string): "ok" | "stale" | "none" {
	const d = dev(deviceId);
	if (!d.current?.startsWith("board:")) return "ok";
	if (d.memory === null) return "none";
	if (d.origin && d.memory && d.memory !== d.origin) return "stale";
	return "ok";
}

export interface NavState { stack: string[]; origin: string | null; memory: string | null; leftWithoutBack: boolean; current: string | null }
export function stateOf(deviceId: string): NavState {
	const d = dev(deviceId);
	return { stack: [...d.stack], origin: d.origin, memory: d.memory, leftWithoutBack: d.leftWithoutBack, current: d.current };
}
export const historyOf = (deviceId: string): string[] => [...dev(deviceId).stack];

// ── learning where keys are ─────────────────────────────────────────────────

/** Keys appearing within this long of the first one after a switch belong to the new profile. */
const BATCH_MS = 250;
/** No key of ours visible for this long → the deck is somewhere we can't see. */
const UNKNOWN_MS = 1500;

interface KeyLike {
	id: string;
	device: { id: string };
	setSettings(settings: JsonObject): Promise<void>;
}

/**
 * Call from every action's willAppear. Stamps the key if this appearance is
 * the result of our own switch, otherwise reads its stamp to learn where the
 * deck is. Gives every key an id. Returns the key's location (if known) and
 * its settings as saved (callers must build on these, not on the event's).
 */
export async function keyAppeared(action: KeyLike, settings: JsonObject): Promise<{ where: Where | null; settings: JsonObject }> {
	const d = dev(action.device.id);
	d.visible.add(action.id);
	if (d.unknownTimer) { clearTimeout(d.unknownTimer); d.unknownTimer = null; }

	const patch: JsonObject = {};
	// A key without an id, or a copy of another key (same id in two profiles), gets a fresh one.
	if (typeof settings[KEY_ID] !== "string" || isDuplicate(settings[KEY_ID])) patch[KEY_ID] = newKeyId();
	const id = (patch[KEY_ID] ?? settings[KEY_ID]) as string;

	const now = Date.now();
	const e = d.expect;
	let w: Where | null;
	if (e && now <= e.until && (e.firstAppear === null || now - e.firstAppear <= BATCH_MS)) {
		if (e.firstAppear === null) {
			e.firstAppear = now;
			log("switch.done", { to: encode(e.where), ms: now - e.at });
		}
		w = e.where;
		if (settings[STAMP] !== encode(w)) patch[STAMP] = encode(w);
		d.current = encode(w);
		if (w.kind === "normal") d.lastNormalKey = id;
		save();
	} else {
		if (e && (now > e.until || (e.firstAppear !== null && now - e.firstAppear > BATCH_MS))) d.expect = null;
		w = decode(settings[STAMP]);
		if (!w) {
			// Never stamped (e.g. placed by hand): its profile file may already say where it is.
			w = fromHome(id);
			if (w) patch[STAMP] = encode(w);
		}
		if (w) arrive(d, w, id);
	}
	const merged = Object.keys(patch).length ? { ...settings, ...patch } : settings;
	if (merged !== settings) await action.setSettings(merged);
	return { where: w, settings: merged };
}

/** Call from every action's willDisappear. */
export function keyDisappeared(action: { id: string; device: { id: string } }): void {
	const d = dev(action.device.id);
	d.visible.delete(action.id);
	// Keys of the profile we switched to are going away: that switch is over,
	// whatever appears next belongs to some other profile.
	if (d.expect && d.expect.firstAppear !== null) d.expect = null;
	if (d.visible.size || d.unknownTimer) return;
	d.unknownTimer = setTimeout(() => {
		d.unknownTimer = null;
		if (d.visible.size || d.expect) return;
		// A profile or page without our keys: we no longer know where the deck is.
		if (d.current?.startsWith("board:")) d.leftWithoutBack = true; // possibly; confirmed when a normal key shows up
		d.current = null;
		save();
	}, UNKNOWN_MS);
	d.unknownTimer.unref?.();
}

/** The deck is now showing `w` (learned from a stamped key, not from our own switch). */
function arrive(d: Device, w: Where, keyId: string): void {
	if (w.kind === "normal") {
		d.lastNormalKey = keyId;
		const wasOnBoard = d.current?.startsWith("board:") || d.stack.length > 0;
		if (wasOnBoard) {
			// Left the boards without Back: Stream Deck keeps its memory.
			d.leftWithoutBack = true;
			log("nav.left-without-back", { from: d.current });
		}
		d.current = "normal";
		d.stack = [];
		save();
		return;
	}
	d.current = encode(w);
	align(d, w.board);
	save();
}

/** Make the history end at `board` (cut back to it, or start over with it). */
function align(d: Device, board: string): void {
	if (d.stack[d.stack.length - 1] === board) return;
	const i = d.stack.lastIndexOf(board);
	d.stack = i >= 0 ? d.stack.slice(0, i + 1) : [board];
}

function fromHome(id: unknown, maxAgeMs = 3000): Where | null {
	const h = homeOf(id, maxAgeMs);
	return h ? (h.board ? { kind: "board", board: h.board } : { kind: "normal" }) : null;
}

/**
 * Where a pressed key is: its stamp, else its profile file, else the last
 * known location of its deck. Learning it from the file also updates the
 * deck's location (a key pressed on Game 2 proves the boards were left).
 */
export function whereIs(deviceId: string, settings: JsonObject): Where | null {
	const stamped = decode(settings[STAMP]);
	if (stamped) return stamped;
	const home = fromHome(settings[KEY_ID], 0);
	if (home) {
		arrive(dev(deviceId), home, String(settings[KEY_ID]));
		return home;
	}
	return decode(dev(deviceId).current);
}

// ── switching ───────────────────────────────────────────────────────────────

function expect(d: Device, where: Where, windowMs: number): void {
	d.expect = { where, at: Date.now(), until: Date.now() + windowMs, firstAppear: null };
}

/** Name of the normal profile a key (or the last normal key seen) is on. */
function normalName(d: Device, keyId: unknown): string {
	return homeOf(keyId)?.profile ?? homeOf(d.lastNormalKey)?.profile ?? "";
}

/** Open a board. From a board it adds to the history, from a normal profile it starts a new one. */
export async function openBoard(deviceId: string, from: Where | null, board: string, page: number | undefined, keyId?: unknown): Promise<void> {
	const d = dev(deviceId);
	if (from?.kind === "board") {
		align(d, from.board);
		if (from.board !== board) d.stack.push(board);
	} else {
		d.stack = [board];
		d.origin = normalName(d, keyId);
		if (d.memory === null) d.memory = d.origin; // Stream Deck remembers where we came from…
		else if (d.memory !== d.origin) log("nav.memory-kept", { memory: d.memory, origin: d.origin }); // …unless it still holds an older one (3a)
		d.leftWithoutBack = false;
	}
	save();
	// The first open of a board shows Stream Deck's install prompt; allow time to click it.
	expect(d, { kind: "board", board }, 30_000);
	log("nav.open", { board, page: page ?? "remembered", history: d.stack.length, origin: d.origin, memory: d.memory });
	await streamDeck.profiles.switchToProfile(deviceId, board, page);
}

/**
 * Back: Stream Deck's own "previous profile", i.e. the last normal profile.
 * If nothing happens (Stream Deck remembers nothing), `onNothing` runs so the
 * key can show an alert instead of silently doing nothing.
 */
export async function backToNormal(deviceId: string, onNothing?: () => void): Promise<void> {
	const d = dev(deviceId);
	const expected = d.memory;
	d.stack = [];
	d.memory = null; // used up
	d.leftWithoutBack = false;
	save();
	expect(d, { kind: "normal" }, 5_000);
	const e = d.expect;
	log("nav.back", { expected: expected ?? "(nothing)" });
	// Known in advance (the prediction held in every real-deck test): Stream Deck
	// remembers nothing, so Back can't go anywhere. Alert right away; still ask
	// Stream Deck, in case it does know somewhere (then the page just changes).
	let alerted = false;
	if (expected === null) {
		alerted = true;
		onNothing?.();
	}
	await streamDeck.profiles.switchToProfile(deviceId);
	setTimeout(() => {
		if (d.expect === e && e?.firstAppear === null) {
			log("nav.back-did-nothing", {});
			d.expect = null;
			if (!alerted) onNothing?.();
		}
	}, 1200).unref?.();
}

/** Board Back: the previous board in the history; on the first board of a chain, same as Back. */
export async function boardBack(deviceId: string, from: Where | null, onNothing?: () => void): Promise<"board" | "normal"> {
	const d = dev(deviceId);
	if (from?.kind === "board") align(d, from.board);
	d.stack.pop();
	const target = d.stack[d.stack.length - 1];
	if (!target) {
		await backToNormal(deviceId, onNothing);
		return "normal";
	}
	save();
	expect(d, { kind: "board", board: target }, 30_000);
	log("nav.board-back", { to: target, history: d.stack.length });
	await streamDeck.profiles.switchToProfile(deviceId, target);
	return "board";
}

// ── restore after a Stream Deck restart ─────────────────────────────────────

const restored = new Set<string>();

/**
 * Stream Deck starts on a normal profile even if a board was on screen when it
 * closed. If the deck was surely on a board at shutdown, reopen it (with its
 * history, so Board Back keeps working). Called once per device after connect.
 */
export async function restoreIfWanted(deviceId: string): Promise<void> {
	if (restored.has(deviceId)) return;
	restored.add(deviceId);
	const s = atStart.get(deviceId);
	if (!getOptions().restoreOnStart || !s || !s.current?.startsWith("board:") || !s.stack.length) return;
	const board = s.current.slice(6);
	if (s.stack[s.stack.length - 1] !== board) return;
	const d = dev(deviceId);
	if (d.expect) return; // the user already pressed something
	d.stack = [...s.stack];
	d.origin = s.origin;
	// Stream Deck restarted, so its memory is fresh: the profile it started on.
	d.memory = normalName(d, d.lastNormalKey) || s.origin;
	d.leftWithoutBack = false;
	save();
	expect(d, { kind: "board", board }, 10_000);
	log("nav.restore", { board, history: d.stack.length });
	await streamDeck.profiles.switchToProfile(deviceId, board);
}
