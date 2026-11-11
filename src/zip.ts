import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

interface Entry { name: string; data: Buffer }

// @types/node 20 + TypeScript 5.9 disagree about Buffer vs Uint8Array; the values are the same.
const u8 = (b: Buffer): Uint8Array => b as unknown as Uint8Array;

/** Every file and folder under `dir`, with `prefix/` in front of each name. */
export function collect(dir: string, prefix: string): Entry[] {
	const out: Entry[] = [{ name: `${prefix}/`, data: Buffer.alloc(0) }];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, e.name);
		const rel = `${prefix}/${e.name}`;
		if (e.isDirectory()) out.push(...collect(abs, rel));
		else if (e.isFile()) out.push({ name: rel, data: fs.readFileSync(abs) });
	}
	return out;
}

export function zip(entries: Entry[]): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, "utf8");
		const isDir = e.name.endsWith("/");
		const comp = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(u8(e.data));
		const method = isDir ? 0 : 8;
		const crc = isDir ? 0 : crc32(e.data);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
		lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
		local.push(lh, name, comp);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
		ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(isDir ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
		central.push(ch, name);
		offset += 30 + name.length + comp.length;
	}
	const cd = Buffer.concat(central.map(u8));
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, cd, end].map(u8));
}
