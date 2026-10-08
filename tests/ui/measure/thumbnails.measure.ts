/**
 * Thumbnail measurement (`pnpm measure:thumbnails`, not part of `pnpm test:ui`): the Recordings tab over a folder of
 * hundreds of real videos, whose pictures QuickLook makes as the app makes them (hosts/view-host.ts `measuredFolder`),
 * scrolled to the bottom and back with the mouse wheel in the hidden offscreen view host. It compares how many are
 * made at once and whether the page may keep them (2026-10-08: at most `THUMBNAILS_AT_ONCE`, the newest asked first,
 * immutable under their versioned address), with the former behaviour (no limit, `no-cache`) as the baseline.
 *
 * Timings are evidence for a comparison on one machine, not a budget: nothing here fails on a slow result. Every run
 * reads fresh copies, so QuickLook's own cache of an earlier run's files is never what is measured.
 *
 * Variables: RECORDSTUFF_MEASURE_COUNT (videos, default 240), RECORDSTUFF_MEASURE_REPEAT (runs per configuration,
 * default 2), RECORDSTUFF_MEASURE_SOURCE (a video to copy, default a 30 s 1080p H.264 clip made with ffmpeg).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, ROOT } from "../fixtures";

const COUNT = Number(process.env.RECORDSTUFF_MEASURE_COUNT ?? 240);
const REPEAT = Number(process.env.RECORDSTUFF_MEASURE_REPEAT ?? 2);
/** `atOnce` 0 is no limit; `cache` "no-cache" rewrites the app's header as it was before. */
const CONFIGS = [
  { name: "before: no limit, no-cache", atOnce: 0, cache: "no-cache" },
  { name: "no limit, immutable", atOnce: 0, cache: "app" },
  { name: "2 at once, immutable", atOnce: 2, cache: "app" },
  { name: "3 at once, immutable", atOnce: 3, cache: "app" },
  { name: "4 at once, immutable (app)", atOnce: 4, cache: "app" },
] as const;

interface Result {
  config: string; run: number;
  firstScreenMs: number; scrollMs: number; landBottomMs: number; drainMs: number;
  madeDown: number; most: number; meanMakeMs: number;
  landTopMs: number; requestsUp: number; madeUp: number;
  /** Pictures asked for again after another tab and back, and after the page is loaded again, as a reopened window. */
  requestsTabBack: number; requestsReload: number;
  appCpuS: number; quickLookCpuS: number;
}
const results: Result[] = [];

/** A 30 s 1080p H.264 clip, made once per machine, or the video RECORDSTUFF_MEASURE_SOURCE names. */
function sourceVideo(): string {
  if (process.env.RECORDSTUFF_MEASURE_SOURCE) return process.env.RECORDSTUFF_MEASURE_SOURCE;
  const made = path.join(os.tmpdir(), "recordstuff-measure-1080p-30s.mp4");
  if (!fs.existsSync(made)) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", `${made}.tmp.mp4`]);
    fs.renameSync(`${made}.tmp.mp4`, made);
  }
  return made;
}

/** CPU seconds so far of the processes QuickLook makes pictures in (an approximation: one that exited is not counted). */
function quickLookCpu(): number {
  const lines = execFileSync("ps", ["-axo", "time=,comm="], { encoding: "utf8" }).split("\n");
  let total = 0;
  for (const line of lines) {
    const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.*)$/.exec(line);
    if (!match || !/quicklook|thumbnail/i.test(match[5]!)) continue;
    total += Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  }
  return total;
}

/** Milliseconds until every card picture in the panel's view has loaded or failed. */
const settleVisible = (page: Page): Promise<number> => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const start = performance.now();
  const check = (): void => {
    const panel = document.getElementById("settings-panel")!.getBoundingClientRect();
    const pictures = [...document.querySelectorAll<HTMLImageElement>(".clip-thumb img")].filter(img => {
      const box = img.getBoundingClientRect();
      return box.width > 0 && box.bottom > panel.top && box.top < panel.bottom;
    });
    if (pictures.length && pictures.every(img => img.complete)) resolve(performance.now() - start);
    else if (performance.now() - start > 120_000) reject(new Error(`pictures still loading: ${pictures.filter(img => !img.complete).length} of ${pictures.length}`));
    else requestAnimationFrame(check);
  };
  check();
}));

/** Wheels the panel to its end in `direction`, a screenful at a time as a fast flick does; milliseconds taken. */
async function flick(page: Page, direction: 1 | -1): Promise<number> {
  const panel = page.locator("#settings-panel");
  const box = (await panel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = Date.now();
  for (let step = 0; step < 400; step++) {
    const done = await panel.evaluate((node, down) => down ? node.scrollTop + node.clientHeight >= node.scrollHeight - 2 : node.scrollTop <= 0, direction === 1);
    if (done) break;
    await page.mouse.wheel(0, direction * box.height);
    await page.waitForTimeout(16);
  }
  return Date.now() - start;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

for (let run = 1; run <= REPEAT; run++) {
  // Alternate the order, so a configuration is not always measured on a machine warmed by the same one before it.
  for (const config of run % 2 ? CONFIGS : [...CONFIGS].reverse()) {
    test(`${config.name} · run ${run}`, async ({ launchView }, testInfo) => {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-measure-"));
      try {
        const source = sourceVideo();
        for (let index = 0; index < COUNT; index++) {
          fs.copyFileSync(source, path.join(folder, `clip-${String(index).padStart(4, "0")}.mp4`), fs.constants.COPYFILE_FICLONE);
        }
        const { launched: host, page } = await launchView({ env: {
          RECORDSTUFF_UI_RECORDINGS: folder, RECORDSTUFF_UI_THUMBNAILS_AT_ONCE: String(config.atOnce),
          ...(config.cache === "no-cache" ? { RECORDSTUFF_UI_THUMBNAIL_CACHE: "no-cache" } : {}),
        } });
        const appCpu = (): Promise<number> => host.evaluate((_h, _arg, { app }) => app.getAppMetrics().reduce((sum, metric) => sum + (metric.cpu.cumulativeCPUUsage ?? 0), 0));
        const stats = (): Promise<{ made: Array<{ start: number; end: number }>; making: number; most: number; requests: number }> =>
          host.evaluate(h => JSON.parse(JSON.stringify(h.thumbnailStats)));
        const cpuBefore = await appCpu(), quickLookBefore = quickLookCpu();

        await host.evaluate(h => { h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); });
        // From the listing reaching the page to its first screen of pictures: pictures made while the tab opens count.
        const shown = Date.now();
        await host.evaluate(h => { h.pushModel({ type: "idle" }, { library: h.library().state }); });
        await page.locator("#tab-library").click();
        await expect(page.locator(".clip")).toHaveCount(COUNT);
        await settleVisible(page);
        const firstScreenMs = Date.now() - shown;
        await expect(page.locator("#library")).toHaveAttribute("data-layout", "grid");

        const scrollMs = await flick(page, 1);
        const scrolled = Date.now();
        const landBottomMs = await settleVisible(page);
        // Pictures asked for on the way down may still be made after the last screen has its own.
        await expect.poll(async () => { const now = await stats(); return now.making; }, { timeout: 120_000 }).toBe(0);
        const down = await stats();
        const drainMs = Date.now() - scrolled;

        await host.evaluate(h => { h.thumbnailStats.requests = 0; });
        const madeBeforeUp = down.made.length;
        await flick(page, -1);
        const landTopMs = await settleVisible(page);
        await expect.poll(async () => (await stats()).making, { timeout: 120_000 }).toBe(0);
        const up = await stats();

        const showLibrary = async (): Promise<void> => {
          await host.evaluate(h => h.pushModel({ type: "idle" }, { library: h.library().state }));
          await page.locator("#tab-library").click();
          await expect(page.locator(".clip")).toHaveCount(COUNT);
        };
        await host.evaluate(h => { h.thumbnailStats.requests = 0; });
        await page.locator("#tab-recording").click();
        await page.locator("#tab-library").click();
        await settleVisible(page);
        const requestsTabBack = (await stats()).requests;
        await host.evaluate(h => { h.thumbnailStats.requests = 0; });
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await showLibrary();
        await settleVisible(page);
        await expect.poll(async () => (await stats()).making, { timeout: 120_000 }).toBe(0);
        const requestsReload = (await stats()).requests;

        const durations = down.made.map(item => item.end - item.start);
        const result: Result = {
          config: config.name, run, firstScreenMs, scrollMs, landBottomMs, drainMs,
          madeDown: madeBeforeUp, most: down.most, meanMakeMs: durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length),
          landTopMs, requestsUp: up.requests, madeUp: up.made.length - madeBeforeUp, requestsTabBack, requestsReload,
          appCpuS: await appCpu() - cpuBefore, quickLookCpuS: quickLookCpu() - quickLookBefore,
        };
        results.push(result);
        await testInfo.attach("result.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        if (config.atOnce) expect(result.most, "never more pictures made at once than the limit").toBeLessThanOrEqual(config.atOnce);
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });
  }
}

test.afterAll(() => {
  if (!results.length) return;
  const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2; };
  const keys = ["firstScreenMs", "landBottomMs", "drainMs", "madeDown", "most", "meanMakeMs", "landTopMs", "requestsUp", "madeUp", "requestsTabBack", "requestsReload", "appCpuS", "quickLookCpuS"] as const;
  const table = CONFIGS.map(config => {
    const runs = results.filter(result => result.config === config.name);
    return { config: config.name, runs: runs.length, ...Object.fromEntries(keys.map(key => [key, Math.round(median(runs.map(run => run[key])) * 10) / 10])) };
  }).filter(row => row.runs);
  const file = path.join(ROOT, "test-results", "thumbnail-measure.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ count: COUNT, repeat: REPEAT, machine: `${os.cpus()[0]?.model} · ${os.release()}`, medians: table, runs: results }, null, 2)}\n`);
  console.table(table);
  console.log(`thumbnail measurement written to ${path.relative(ROOT, file)}`);
});
