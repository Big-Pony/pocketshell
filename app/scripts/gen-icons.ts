// Generate PWA icons into public/icons/. The SVG templates below are the
// single source of truth (icon.svg is emitted too, for use as favicon).
// Rendering: headless chromium screenshots via @playwright/test (already a
// devDependency — no new deps). Usage: cd app && bun run gen:icons
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "../public/icons");

// Brand tokens (mirror app/src/app.css): dark IDE bg + indigo accent.
const BG = "#0f131b";
const BG_DEEP = "#0a0d13";
const ACCENT = "#7c8cf8";
const CASE_BG = "#2a3142";
const CASE_DEEP = "#1a1f2b";
const BEZEL = "#3d4661";

function defs(): string {
  return `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG_DEEP}"/>` +
    `</linearGradient>` +
    `<linearGradient id="case" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${CASE_BG}"/><stop offset="1" stop-color="${CASE_DEEP}"/>` +
    `</linearGradient>` +
    `</defs>`;
}

// Phone-case-wrapped terminal icon on a 512 viewBox.
function phoneTerminal(scale: number): string {
  return `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">` +
    // phone case body
    `<rect x="116" y="24" width="280" height="464" rx="48" fill="url(#case)" stroke="${BEZEL}" stroke-width="8"/>` +
    // screen
    `<rect x="140" y="56" width="232" height="400" rx="34" fill="${BG_DEEP}"/>` +
    // dynamic island
    `<rect x="210" y="72" width="92" height="24" rx="12" fill="${CASE_DEEP}"/>` +
    // terminal prompt glyph (scaled to keep clear of the screen bezel)
    `<g transform="translate(256 256) scale(0.68) translate(-256 -256)">` +
    `<polyline points="120,156 270,256 120,356" fill="none" stroke="${ACCENT}" ` +
    `stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<rect x="296" y="310" width="100" height="42" rx="21" fill="${ACCENT}"/>` +
    `</g>` +
    // home indicator
    `<rect x="202" y="436" width="108" height="6" rx="3" fill="${BEZEL}"/>` +
    `</g>`;
}

// purpose "any": rounded square, transparent corners.
export function svgAny(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs()}` +
    `<rect x="4" y="4" width="504" height="504" rx="112" fill="url(#bg)"/>${phoneTerminal(1)}</svg>`;
}

// purpose "maskable": full-bleed square; icon scaled into the 80% safe zone.
export function svgMaskable(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs()}` +
    `<rect width="512" height="512" fill="url(#bg)"/>${phoneTerminal(0.85)}</svg>`;
}

// apple-touch-icon: full-bleed square (iOS applies its own corner mask).
export function svgApple(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs()}` +
    `<rect width="512" height="512" fill="url(#bg)"/>${phoneTerminal(1)}</svg>`;
}

interface Target {
  file: string;
  size: number;
  svg: () => string;
}

const TARGETS: Target[] = [
  { file: "icon-192.png", size: 192, svg: svgAny },
  { file: "icon-512.png", size: 512, svg: svgAny },
  { file: "icon-maskable-192.png", size: 192, svg: svgMaskable },
  { file: "icon-maskable-512.png", size: 512, svg: svgMaskable },
  { file: "apple-touch-icon.png", size: 180, svg: svgApple },
];

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "icon.svg"), svgAny());

  const browser = await chromium.launch();
  try {
    for (const t of TARGETS) {
      const page = await browser.newPage({
        viewport: { width: t.size, height: t.size },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<body style="margin:0"><div style="width:${t.size}px;height:${t.size}px">` +
          t.svg().replace("<svg ", `<svg width="${t.size}" height="${t.size}" `) +
          `</div></body>`,
      );
      await page.screenshot({ path: join(OUT, t.file), omitBackground: true });
      await page.close();
      console.log(`[gen-icons] ${t.file} (${t.size}x${t.size})`);
    }
    console.log(`[gen-icons] icon.svg (favicon source)`);
  } finally {
    await browser.close();
  }
}
