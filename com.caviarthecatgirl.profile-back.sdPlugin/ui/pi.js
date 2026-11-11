/* Profile Back — settings panel runtime (no external libraries).
   Stream Deck calls connectElgatoStreamDeckSocket(); everything else is ours. */

const PB = {
	ws: null,
	uuid: null,
	action: null,
	settings: {},
	state: null,
	/** page hooks */
	onSettings: () => {},
	onState: () => {},
};

function send(o) {
	if (PB.ws && PB.ws.readyState === 1) PB.ws.send(JSON.stringify(o));
}

/** Merge into the key's settings and save them. */
function saveSettings(patch) {
	PB.settings = { ...PB.settings, ...patch };
	send({ event: "setSettings", context: PB.uuid, payload: PB.settings });
}

function toPlugin(payload) {
	send({ event: "sendToPlugin", action: PB.action, context: PB.uuid, payload });
}

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
	const ai = JSON.parse(actionInfo);
	PB.uuid = uuid;
	PB.action = ai.action;
	PB.settings = (ai.payload && ai.payload.settings) || {};
	PB.ws = new WebSocket(`ws://127.0.0.1:${port}`);
	PB.ws.onopen = () => {
		send({ event: registerEvent, uuid });
		PB.onSettings(PB.settings);
		toPlugin({ type: "refresh" });
	};
	PB.ws.onmessage = (m) => {
		const d = JSON.parse(m.data);
		if (d.event === "didReceiveSettings") {
			PB.settings = d.payload.settings || {};
			PB.onSettings(PB.settings);
		} else if (d.event === "sendToPropertyInspector") {
			const p = d.payload || {};
			if (p.type === "state") {
				PB.state = p;
				renderCommon(p);
				PB.onState(p);
			} else if (p.type === "toast") toast(p.text, p.error);
		}
	};
};

// ── helpers ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

let toastTimer = 0;
function toast(text, error) {
	const t = $("#toast");
	if (!t) return;
	t.textContent = text;
	t.classList.toggle("error", Boolean(error));
	t.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function ago(iso) {
	if (!iso) return null;
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 90) return "just now";
	const n = (v, unit) => `${v} ${unit}${v === 1 ? "" : "s"} ago`;
	if (s < 3600) return n(Math.round(s / 60), "minute");
	if (s < 36 * 3600) return n(Math.round(s / 3600), "hour");
	return n(Math.round(s / 86400), "day");
}

/**
 * The trail: the profiles behind this key, as chips.
 * Board keys show the board history ending at their board; a key on a normal
 * profile shows just that.
 */
function renderTrail(state) {
	const row = $("#trail-row");
	const label = $("#trail-label");
	if (!row || !label) return;
	row.textContent = "";
	const w = state.where;
	const add = (text, cls) => {
		if (row.childElementCount) row.appendChild(el("span", "link"));
		row.appendChild(el("span", `stop ${cls}`, text));
	};
	if (!w) {
		label.textContent = "Where this key is";
		add("Not known yet", "unknown");
		return;
	}
	if (w.kind === "normal") {
		label.textContent = "This key is on";
		add(w.name || "a normal profile", "here");
		return;
	}
	label.textContent = "How you got here";
	add(state.origin || "your profile", "normal");
	const h = state.history || [];
	const i = h.lastIndexOf(w.name);
	const chain = i >= 0 ? h.slice(0, i + 1) : [w.name];
	chain.forEach((name, k) => add(name, k === chain.length - 1 ? "here" : ""));
}

/** "Pressing it goes to: …" under the trail (Back / Board Back). */
function renderGoes(state) {
	const g = $("#goes");
	if (!g) return;
	const w = state.where;
	g.hidden = !w || w.kind !== "board";
	if (g.hidden) return;
	let target = backTarget(state);
	if (state.kind === "board-back") {
		const h = state.history || [];
		const i = h.lastIndexOf(w.name);
		if (i > 0) target = h[i - 1];
	}
	g.innerHTML = `Pressing it goes to <b>${escapeHtml(target)}</b>.`;
}

/** Where Stream Deck's "previous profile" (Back) leads. */
function backTarget(state) {
	return state.memory || state.origin || "your profile";
}

/**
 * When Back can't do what you'd expect (the key shows a warning badge):
 * "stale" = Stream Deck still remembers an older profile, "none" = it remembers nothing.
 */
function renderMemory(state) {
	const n = $("#memory");
	if (!n) return;
	const onBoard = state.where && state.where.kind === "board";
	const firstBoard = state.kind !== "board-back" || (state.history || []).length <= 1;
	const status = onBoard && firstBoard ? state.backStatus : "ok";
	n.hidden = status === "ok";
	if (status === "stale") {
		n.innerHTML = `<b>Back goes to ${escapeHtml(state.memory)}, not ${escapeHtml(state.origin)}.</b> You left the boards without Back earlier, and Stream Deck still remembers ${escapeHtml(state.memory)}. It only forgets it when Back is used once. That's what the warning badge on the key means.`;
	} else if (status === "none") {
		n.innerHTML = `<b>Back can't work right now.</b> This board was opened without an Open Board key (for example from the app window), so Stream Deck doesn't know where to go back to. Pressing it shows a warning triangle. Open boards with Open Board keys and Back always works.`;
	}
}

function renderOptions(state) {
	const o = state.options || {};
	document.querySelectorAll("input[data-option]").forEach((i) => { i.checked = Boolean(o[i.dataset.option]); });
}

function renderCommon(state) {
	renderTrail(state);
	renderGoes(state);
	renderMemory(state);
	renderOptions(state);
	const b = state.backups || {};
	const st = $("#backup-status");
	if (st) {
		st.textContent = b.last
			? `Last backup ${ago(b.last)}, ${b.boards} board${b.boards === 1 ? "" : "s"}. ${b.count} kept.`
			: "No backup yet. One is made automatically once you use a board.";
	}
	const orphans = $("#orphans");
	if (orphans) {
		const n = (state.orphans || []).length;
		orphans.hidden = n === 0;
		if (n) orphans.innerHTML = `<b>Boards this version can't open:</b> ${state.orphans.map(escapeHtml).join(", ")}. Their number is higher than the ${state.device.boards} boards this version has. Your keys and contents are untouched; move them to another board if you need them.`;
	}
	const ver = $("#version");
	if (ver) ver.textContent = `Profile Back ${state.version}`;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

document.addEventListener("DOMContentLoaded", () => {
	$("#backup-now")?.addEventListener("click", () => toPlugin({ type: "backup-now" }));
	$("#open-backups")?.addEventListener("click", () => toPlugin({ type: "open-backups" }));
	document.querySelectorAll("input[data-option]").forEach((i) => i.addEventListener("change", () => toPlugin({ type: "set-option", key: i.dataset.option, value: i.checked })));
});
