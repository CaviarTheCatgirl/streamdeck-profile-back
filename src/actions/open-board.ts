import { action, type DialAction, type DidReceiveSettingsEvent, type KeyAction, type KeyDownEvent, type KeyUpEvent, type WillAppearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { BOARD_DEVICE, boardName, boardPath, inventory, nextFreeBoard, shippedCounts } from "../boards";
import { log } from "../log";
import { openBoard, type Where } from "../navigator";
import { PLUGIN_UUID } from "../paths";
import { BaseAction } from "./base";

type Settings = JsonObject & {
	board?: number | string;
	/** "first" (default) | "remembered" | page number as text */
	page?: string;
	/** show the board's name as the key title (default on) */
	showName?: boolean;
};

const boardNumber = (s: Settings): number => Math.max(1, Math.floor(Number(s.board) || 1));

/** Open Board: switches to one of the plugin's boards. */
@action({ UUID: `${PLUGIN_UUID}.open-board` })
export class OpenBoardAction extends BaseAction<Settings> {
	readonly kind = "open-board" as const;
	private timer: NodeJS.Timeout | null = null;

	protected override async appeared(ev: WillAppearEvent<Settings>, _w: Where | null, saved: Settings): Promise<void> {
		let s = saved;
		// A new key gets the first board that isn't in use yet. (Uses the
		// appear payload: a getSettings round trip would also fire
		// didReceiveSettings with the old, empty settings.)
		if (s.board === undefined && BOARD_DEVICE[ev.action.device.type]) {
			s = { ...s, board: nextFreeBoard(ev.action.device.type), page: "first", showName: true };
			await ev.action.setSettings(s);
		}
		await this.title(ev.action, s);
		this.startTitleRefresh();
	}

	protected override async settingsChanged(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
		if (ev.payload.settings.board === undefined) return; // not set up yet; appeared() handles it
		if (ev.action.isKey()) await this.title(ev.action, ev.payload.settings);
	}

	private async title(a: DialAction<Settings> | KeyAction<Settings>, s: Settings): Promise<void> {
		if (!a.isKey()) return;
		if (s.showName === false) await a.setTitle();
		else if (BOARD_DEVICE[a.device.type]) await a.setTitle(boardName(a.device.type, boardNumber(s)));
	}

	/** Board names change when the user renames a profile; keep visible titles current. */
	private startTitleRefresh(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			inventory(25_000);
			this.actions.forEach((a) => {
				void a.getSettings().then((s) => this.title(a, s)).catch(() => undefined);
			});
		}, 30_000);
		this.timer.unref?.();
	}

	protected async press(ev: KeyDownEvent<Settings> | KeyUpEvent<Settings>, from: Where | null): Promise<void> {
		const s = ev.payload.settings;
		const type = ev.action.device.type;
		const n = boardNumber(s);
		const path = boardPath(type, n);
		const max = shippedCounts()[BOARD_DEVICE[type] ?? ""] ?? 0;
		if (!path || n > max) {
			log("open-board.unavailable", { deviceType: type, board: n, max });
			await ev.action.showAlert();
			return;
		}
		const page = s.page === "remembered" ? undefined : s.page && s.page !== "first" ? Math.max(0, Number(s.page) - 1) : 0;
		await openBoard(ev.action.device.id, from, path, page, s._pbId);
	}

	protected override extraState(s: Settings, deviceType: number): JsonObject {
		const dev = BOARD_DEVICE[deviceType];
		const installed = inventory().boards.filter((b) => b.dev === dev).map((b) => ({ n: b.n, name: b.name }));
		return { board: boardNumber(s), page: s.page ?? "first", showName: s.showName !== false, installed, next: dev ? nextFreeBoard(deviceType) : 1 };
	}
}
