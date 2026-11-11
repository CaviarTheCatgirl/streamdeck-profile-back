// =============================================================================
// scripts/make-icons.mjs — renders every plugin image from the SVG sources below
//
//   npx -y -p sharp@0.33.5 node scripts/make-icons.mjs     (or with sharp installed)
//
// Output is committed; the normal build does not run this. All shapes are
// vector strokes with round caps/joins, rendered by librsvg (via sharp) at the
// exact target size, so edges are anti-aliased at 1x and 2x.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const IMGS = path.join(ROOT, "com.caviarthecatgirl.profile-back.sdPlugin", "imgs");

// ── glyphs (viewBox 0 0 100 100) ────────────────────────────────────────────
// `fill` = colour of solid parts on keys; monochrome icons use white for all.
const GLYPHS = {
	// U-turn arrow: "go back where you came from".
	back: (c, solid) => `
		<path d="M38 20 L19 39 L38 58" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
		<path d="M21 39 H58 A21.5 21.5 0 0 1 58 82 H42" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
	// Two stacked boards, arrow on the front one: "previous board".
	"board-back": (c, solid) => `
		<rect x="40" y="13" width="46" height="46" rx="10" fill="none" stroke="${c}" stroke-width="7" opacity="0.5"/>
		<rect x="14" y="33" width="54" height="54" rx="11" fill="${solid ?? "none"}" stroke="${c}" stroke-width="7"/>
		<path d="M45 47 L32 60 L45 73" fill="none" stroke="${solid ? "#ffffff" : c}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
		<path d="M34 60 H55" fill="none" stroke="${solid ? "#ffffff" : c}" stroke-width="7.5" stroke-linecap="round"/>`,
	// A board (2×2 keys), one lit: "open a board".
	"open-board": (c, solid) => `
		<rect x="15" y="15" width="31" height="31" rx="8" fill="none" stroke="${c}" stroke-width="7"/>
		<rect x="54" y="15" width="31" height="31" rx="8" fill="${solid ?? c}" stroke="${solid ?? c}" stroke-width="7"/>
		<rect x="15" y="54" width="31" height="31" rx="8" fill="none" stroke="${c}" stroke-width="7"/>
		<rect x="54" y="54" width="31" height="31" rx="8" fill="none" stroke="${c}" stroke-width="7"/>`,
};

const ACCENT = { back: "#4C8DFF", "board-back": "#A374FF", "open-board": "#2EC48E" };

/** Monochrome action-list / category icon. */
const iconSvg = (g, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${GLYPHS[g]("#FFFFFF")}</svg>`;

/** Full key image: dark background, soft accent glow, glyph a bit above centre (the title sits at the bottom). */
function keySvg(g, size) {
	const a = ACCENT[g];
	const solid = g === "back" ? undefined : a;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D1C27"/><stop offset="1" stop-color="#121119"/></linearGradient>
		<radialGradient id="glow" cx="0.5" cy="0.42" r="0.5"><stop offset="0" stop-color="${a}" stop-opacity="0.42"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
	</defs>
	<rect width="144" height="144" fill="url(#bg)"/>
	<rect width="144" height="144" fill="url(#glow)"/>
	<g transform="translate(29 17) scale(0.86)">${GLYPHS[g](g === "back" ? "#FFFFFF" : "#FFFFFF", solid)}</g>
</svg>`;
}

/** Same key with a small amber warning badge (top-right): "open my settings, something's off". */
function keyWarnSvg(g, size) {
	return keySvg(g, size).replace("</svg>", `
	<circle cx="118" cy="26" r="17" fill="#F0B44C" stroke="#121119" stroke-width="3"/>
	<path d="M118 16 V28" stroke="#121119" stroke-width="5" stroke-linecap="round"/>
	<circle cx="118" cy="35.5" r="3" fill="#121119"/>
</svg>`);
}

/** Plugin icon (marketplace / plugin list). */
function pluginSvg(size) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 288 288">
	<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4C8DFF"/><stop offset="1" stop-color="#A374FF"/></linearGradient></defs>
	<rect width="288" height="288" rx="64" fill="url(#g)"/>
	<g transform="translate(64 60) scale(1.6)">${GLYPHS.back("#FFFFFF")}</g>
</svg>`;
}

async function png(svg, file) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
}

for (const g of Object.keys(GLYPHS)) {
	await png(iconSvg(g, 20), path.join(IMGS, "actions", g, "icon.png"));
	await png(iconSvg(g, 40), path.join(IMGS, "actions", g, "icon@2x.png"));
	await png(keySvg(g, 72), path.join(IMGS, "actions", g, "key.png"));
	await png(keySvg(g, 144), path.join(IMGS, "actions", g, "key@2x.png"));
}
for (const g of ["back", "board-back"]) {
	await png(keyWarnSvg(g, 72), path.join(IMGS, "actions", g, "key-warn.png"));
	await png(keyWarnSvg(g, 144), path.join(IMGS, "actions", g, "key-warn@2x.png"));
}
await png(iconSvg("back", 28), path.join(IMGS, "plugin", "category-icon.png"));
await png(iconSvg("back", 56), path.join(IMGS, "plugin", "category-icon@2x.png"));
await png(pluginSvg(288), path.join(IMGS, "plugin", "marketplace.png"));
await png(pluginSvg(576), path.join(IMGS, "plugin", "marketplace@2x.png"));
// Small mark for the settings panel header.
fs.writeFileSync(path.join(ROOT, "com.caviarthecatgirl.profile-back.sdPlugin", "ui", "logo.svg"), pluginSvg(64));
console.log("icons written");
