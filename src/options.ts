import fs from "node:fs";
import path from "node:path";
import { dataDir, ensureDir } from "./paths";

// Plugin-wide options, kept in our own data folder (survives updates).
export interface Options {
	/** After a Stream Deck restart, reopen the board you were on (with its history). */
	restoreOnStart: boolean;
}

const DEFAULTS: Options = { restoreOnStart: true };
const file = (): string => path.join(dataDir(), "options.json");

export function getOptions(): Options {
	try {
		const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Options>;
		return { restoreOnStart: typeof saved.restoreOnStart === "boolean" ? saved.restoreOnStart : DEFAULTS.restoreOnStart };
	} catch {
		return { ...DEFAULTS };
	}
}

export function setOption<K extends keyof Options>(key: K, value: Options[K]): Options {
	const o = { ...getOptions(), [key]: value };
	ensureDir(dataDir());
	fs.writeFileSync(file(), JSON.stringify(o, null, 2));
	return o;
}
