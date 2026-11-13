import streamDeck, {
	type DidReceiveSettingsEvent, type KeyDownEvent, type KeyUpEvent, type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { backupNow, backupStatus, backupsDir } from "../backups";
import { BOARD_DEVICE, DEVICE_LABEL, boardName, forgetInventory, inventory, parseBoardPath, shippedCounts } from "../boards";
import { log, warn } from "../log";
import { homeOf } from "../keys";
import { backStatus, decode, KEY_ID, keyAppeared, keyDisappeared, onNavChange, STAMP, stateOf, switching, whereIs, type Where } from "../navigator";
import { getOptions, setOption, type Options } from "../options";
import { pluginVersion } from "../paths";
import { openFolder } from "../system";

export type Kind = "open-board" | "back" | "board-back";

type AnyKeyEvent<T extends JsonObject> = KeyDownEvent<T> | KeyUpEvent<T>;

/**
 * Common behaviour of all three keys:
 * - location stamping on appear (navigator),
 * - press on keyDown; inside a Multi Action Stream Deck may only send keyUp,
 *   so a keyUp without a keyDown in the last 3 s also counts,
 * - the settings panel: state on open, buttons (backup, folder, diagnostics).
 */
export abstract class BaseAction<T extends JsonObject> extends SingletonAction<T> {
	abstract readonly kind: Kind;
	private lastDown = new Map<string, number>();

	protected abstract press(ev: AnyKeyEvent<T>, from: Where | null): Promise<void>;

	/** Back / Board Back: should this key show the warning badge? (default: never) */
	protected warn(_deviceId: string): boolean {
		return false;
	}
	private badged = new Map<string, boolean>();

	constructor() {
		super();
		onNavChange((deviceId) => void this.refreshBadges(deviceId));
	}

	/** Swap the key image to the badge version (and back) when the state changes. */
	protected async refreshBadges(deviceId?: string): Promise<void> {
		for (const a of this.actions) {
			if (!a.isKey() || (deviceId && a.device.id !== deviceId)) continue;
			if (switching(a.device.id)) continue; // these keys are leaving; leave their image alone
			const want = this.warn(a.device.id);
			if (this.badged.get(a.id) === want) continue;
			this.badged.set(a.id, want);
			// undefined = back to the default image (or the user's own image).
			await a.setImage(want ? `imgs/actions/${this.kind}/key-warn` : undefined).catch(() => undefined);
		}
	}
	protected async appeared(_ev: WillAppearEvent<T>, _w: Where | null, _settings: T): Promise<void> {}
	protected extraState(_settings: T, _deviceType: number): JsonObject {
		return {};
	}

	override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
		const { where: w, settings } = await keyAppeared(ev.action, ev.payload.settings);
		log(`${this.kind}.appear`, { at: w ? (w.kind === "board" ? w.board : "normal") : "?" });
		this.badged.delete(ev.action.id); // a fresh key shows its default image
		await this.appeared(ev, w, settings as T);
		await this.refreshBadges(ev.action.device.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		keyDisappeared(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<T>): Promise<void> {
		this.lastDown.set(ev.action.id, Date.now());
		await this.run(ev, "keyDown");
	}

	override async onKeyUp(ev: KeyUpEvent<T>): Promise<void> {
		const t = this.lastDown.get(ev.action.id);
		if (t && Date.now() - t < 3000) return;
		await this.run(ev, "keyUp-only");
	}

	private async run(ev: AnyKeyEvent<T>, via: string): Promise<void> {
		const from = whereIs(ev.action.device.id, ev.payload.settings);
		log(`${this.kind}.press`, { via, from: from ? (from.kind === "board" ? from.board : "normal") : "?" });
		try {
			await this.press(ev, from);
		} catch (e) {
			warn(`${this.kind}`, { message: (e as Error).message });
			await ev.action.showAlert();
		}
	}

	// ── settings panel ────────────────────────────────────────────────────────
	override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<T>): Promise<void> {
		const settings = await ev.action.getSettings();
		await this.sendState(settings, ev.action.device.type, ev.action.device.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
		await this.settingsChanged(ev);
	}
	protected async settingsChanged(_ev: DidReceiveSettingsEvent<T>): Promise<void> {}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, T>): Promise<void> {
		const msg = (ev.payload ?? {}) as { type?: string; key?: string; value?: unknown };
		const settings = await ev.action.getSettings();
		const device = ev.action.device;
		switch (msg.type) {
			case "backup-now": {
				const r = backupNow("manual", pluginVersion());
				await streamDeck.ui.sendToPropertyInspector({ type: "toast", text: r.skipped ? "Nothing to back up yet (no boards installed)." : `Backed up ${r.files.length} board${r.files.length === 1 ? "" : "s"}.`, error: r.errors.length > 0 });
				break;
			}
			case "open-backups":
				openFolder(backupsDir());
				break;
			case "refresh":
				forgetInventory();
				break;
			case "set-option":
				if (msg.key === "restoreOnStart") {
					setOption(msg.key as keyof Options, msg.value === true);
					log("option", { [msg.key]: msg.value === true });
				}
				break;
		}
		await this.sendState(settings, device.type, device.id);
	}

	protected async sendState(settings: T, deviceType: number, deviceId: string): Promise<void> {
		const inv = inventory();
		const dev = BOARD_DEVICE[deviceType];
		const nameOf = (path: string): string => {
			const b = parseBoardPath(path);
			return b ? boardName(deviceType, b.n) : path;
		};
		const w = decode(settings[STAMP]);
		const nav = stateOf(deviceId);
		const here = homeOf(settings[KEY_ID]);
		await streamDeck.ui.sendToPropertyInspector({
			type: "state",
			kind: this.kind,
			version: pluginVersion(),
			device: { type: deviceType, label: DEVICE_LABEL[deviceType] ?? "this device", supported: Boolean(dev), boards: dev ? shippedCounts()[dev] ?? 0 : 0 },
			where: w ? (w.kind === "board" ? { kind: "board", name: nameOf(w.board) } : { kind: "normal", name: here?.profile ?? null }) : null,
			history: nav.stack.map(nameOf),
			origin: nav.origin || null,
			memory: nav.memory,
			backStatus: backStatus(deviceId),
			options: { ...getOptions() },
			orphans: inv.orphans.filter((b) => b.dev === dev).map((b) => `${b.name} (#${b.n})`),
			backups: { ...backupStatus() },
			...this.extraState(settings, deviceType),
		});
	}
}
