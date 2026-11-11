import { spawn } from "node:child_process";
import { warn } from "./log";
import { dataDir, ensureDir } from "./paths";

/**
 * Opens a folder in Explorer / Finder. The child process starts in our data
 * folder, never the plugin folder: a child inherits the working directory, and
 * on Windows that would lock the plugin folder and block the next update.
 */
export function openFolder(folder: string): void {
	try {
		ensureDir(folder);
		ensureDir(dataDir());
		const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [folder]] : ["open", [folder]];
		const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", cwd: dataDir() });
		child.on("error", (e) => warn("open-folder", { message: e.message }));
		child.unref();
	} catch (e) {
		warn("open-folder", { message: (e as Error).message });
	}
}
