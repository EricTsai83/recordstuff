/**
 * Screenshot matrix: every page at desktop (1440 px) and mobile (390 px) and narrow (320 px)
 * widths, full page, rendered by the locally installed Chrome through
 * puppeteer-core from an `astro preview` of dist/. Output: website/compare/*.png
 * (gitignored). Also refreshes src/assets/og.png, the 1200×630 social preview,
 * from the hero scene paused on its "recording" frame, so the OpenGraph image
 * is the same drawing the page shows. Commit og.png when the scene changes.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT ?? 4180);
const ORIGIN = `http://localhost:${PORT}`;
const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = `${root}compare`;

const pages: Array<{ name: string; path: string }> = [
  { name: "home", path: "/" },
  { name: "download", path: "/download/" },
  { name: "help", path: "/help/" },
  { name: "support", path: "/support/" },
];
const viewports = [
  { name: "narrow", width: 320, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

async function waitFor(url: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up.`);
}

await mkdir(outDir, { recursive: true });
// Astro 7 keeps the preview server as a detached daemon; stop any leftover before starting our own.
const stopPreview = () => spawnSync("node_modules/.bin/astro", ["preview", "stop"], { cwd: root, stdio: "ignore" });
stopPreview();
const preview = spawn("node_modules/.bin/astro", ["preview", "--port", String(PORT), "--host", "localhost"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  await waitFor(`${ORIGIN}/`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  // Social preview: the scene at its recording frame, cropped to 1200×630.
  // Animations must exist to be seeked, so motion is allowed for this shot only.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  const seeked = await page.evaluate(() => {
    const animations = document.getAnimations();
    animations.forEach((animation) => {
      animation.pause();
      animation.currentTime = 7500;
    });
    return animations.length;
  });
  if (seeked === 0) throw new Error("No animations found to seek; the OG frame would not be the recording state.");
  const scene = await page.$(".scene-frame");
  if (!scene) throw new Error("hero scene not found");
  const box = await scene.boundingBox();
  if (!box) throw new Error("hero scene has no box");
  const ogHeight = Math.round((box.width * 630) / 1200);
  await page.screenshot({
    path: `${root}src/assets/og.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(ogHeight, box.height) },
  });
  console.log(`wrote ${root}src/assets/og.png (recording frame, ${seeked} animations seeked)`);
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  for (const viewport of viewports) {
    await page.setViewport(viewport);
    for (const target of pages) {
      await page.goto(`${ORIGIN}${target.path}`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);
      const file = `${outDir}/${target.name}-${viewport.name}.png`;
      await page.screenshot({ path: file as `${string}.png`, fullPage: true });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (scrollWidth > viewport.width) {
        throw new Error(`${target.path} overflows at ${viewport.width}px: page is ${scrollWidth}px wide (${file}).`);
      }
      console.log(`wrote ${file}`);
    }
  }
} finally {
  await browser?.close();
  preview.kill();
  stopPreview();
}
