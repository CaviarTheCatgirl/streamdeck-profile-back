import { action, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { log } from "../log";
import { backStatus, backToNormal, type Where } from "../navigator";
import { PLUGIN_UUID } from "../paths";
import { BaseAction } from "./base";

/**
 * Back: to the normal profile you came from, however many boards deep.
 * This is Stream Deck's own "previous profile", which only works while a board
 * is on screen; on a normal profile Stream Deck refuses ("Profile not found"),
 * so the key shows an alert there instead of doing nothing.
 */
@action({ UUID: `${PLUGIN_UUID}.back` })
export class BackAction extends BaseAction<JsonObject> {
	readonly kind = "back" as const;

	protected override warn(deviceId: string): boolean {
		return backStatus(deviceId) !== "ok";
	}

	protected async press(ev: KeyDownEvent<JsonObject> | KeyUpEvent<JsonObject>, from: Where | null): Promise<void> {
		if (from?.kind === "normal") {
			log("back.on-normal-profile", {});
			await ev.action.showAlert();
			return;
		}
		await backToNormal(ev.action.device.id, () => void ev.action.showAlert());
	}
}
