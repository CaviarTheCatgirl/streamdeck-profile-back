import { action, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { log } from "../log";
import { backStatus, boardBack, historyOf, type Where } from "../navigator";
import { PLUGIN_UUID } from "../paths";
import { BaseAction } from "./base";

/**
 * Board Back: one step back through the boards you opened
 * (Game → Board A → Board B → Board Back → Board A). On the first board of a
 * chain it does the same as Back. No depth limit.
 */
@action({ UUID: `${PLUGIN_UUID}.board-back` })
export class BoardBackAction extends BaseAction<JsonObject> {
	readonly kind = "board-back" as const;

	/** Only on the first board of a chain does Board Back depend on Stream Deck's memory. */
	protected override warn(deviceId: string): boolean {
		return historyOf(deviceId).length <= 1 && backStatus(deviceId) !== "ok";
	}

	protected async press(ev: KeyDownEvent<JsonObject> | KeyUpEvent<JsonObject>, from: Where | null): Promise<void> {
		if (from?.kind === "normal") {
			log("board-back.on-normal-profile", {});
			await ev.action.showAlert();
			return;
		}
		await boardBack(ev.action.device.id, from, () => void ev.action.showAlert());
	}
}
