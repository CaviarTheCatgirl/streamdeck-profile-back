import streamDeck from "@elgato/streamdeck";

/**
 * Developer trace. Written at debug level only, so a normal install records
 * nothing (Stream Deck's plugin log is set to "info" in plugin.ts). Run with
 * a debugger attached to see it.
 */
export function log(event: string, data: Record<string, unknown> = {}): void {
	streamDeck.logger.debug(`${event} ${JSON.stringify(data)}`);
}

/** Something went wrong that a user might want to report. */
export function warn(event: string, data: Record<string, unknown> = {}): void {
	streamDeck.logger.warn(`${event} ${JSON.stringify(data)}`);
}
