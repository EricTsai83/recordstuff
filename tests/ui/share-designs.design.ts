/**
 * Share…'s design (plan 100 step 3, the little folder the maintainer chose), drawn for review: not a test of behaviour, and not
 * part of `pnpm test:ui` (Playwright's `design` project: `pnpm exec playwright test --project=design`). The production
 * page in the view host, offscreen, over the demonstration folder: the newest recording made editable with its Video
 * being prepared, the next one edited, in both languages and themes, the grid card and the list row. Pictures go to
 * test-results/share-designs/.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, ROOT, type Launched } from "./fixtures";
import { drawn } from "./helpers";

const OUT = path.join(ROOT, "test-results", "share-designs");
const DESIGNS = ["folder"] as const;
const VARIANTS = [["en", "light"], ["zh-TW", "dark"], ["en", "dark"], ["zh-TW", "light"]] as const;

async function show(host: Launched, page: Page, language: string, layout: "grid" | "list"): Promise<string[]> {
  return drawn(page, () => host.evaluate((h, [language, layout]) => {
    const library = h.library().state;
    // The newest made editable, named as a new editable recording is (D3); the third, which has no picture, left out.
    const files = library.files.slice(0, 2).map((file: { name: string }, index: number) =>
      (index === 0 ? { ...file, editable: true, name: file.name.replace(/\.mp4$/, ".recordstuff.mp4") } : file));
    h.pushModel({ type: "idle" }, {
      language, libraryLayout: layout, now: h.snapshotNow(),
      library: { ...library, files },
      editedRecordings: new Map([[files[1].path, files[1].size]]),
      preparingVideos: new Map([[files[0].path, { state: "preparing", progress: 0.4 }]]),
      shareStates: new Map([[files[0].path, { video: { state: "preparing", progress: 0.4 }, sound: { state: "preparing", progress: 0 } }]]),
    });
    return files.map((file: { id: string }) => file.id);
  }, [language, layout] as const));
}

async function shot(page: Page, id: string, name: string, below = false): Promise<void> {
  // Away from the panel, so no item shows the pointer's hover.
  await page.mouse.move(2, 2);
  const card = await page.locator(`#clip-${id}`).boundingBox();
  if (!card) throw new Error(`no card ${id}`);
  const panel = below ? await page.locator(".share-panel").boundingBox() : undefined;
  const bottom = Math.max(card.y + card.height, panel ? panel.y + panel.height : 0);
  const left = Math.max(0, Math.min(card.x, panel?.x ?? card.x) - 12);
  const right = Math.max(card.x + card.width, panel ? panel.x + panel.width : 0) + 12;
  const clip = { x: left, y: Math.max(0, card.y - 12), width: right - left, height: bottom - card.y + 24 };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
}

for (const design of DESIGNS) {
  for (const [language, theme] of VARIANTS) {
    test(`${design} ${language} ${theme}`, async ({ launchView }) => {
      const { launched: host, page } = await launchView();
      await host.evaluate(async (h, theme) => { h.theme(theme); await h.setSize(760, 640); }, theme);
      const ids = await show(host, page, language, "grid");
      await page.locator("#tab-library").click();
      const base = `${design}-${language}-${theme}`;
      for (const [index, id] of [[0, ids[0]!], [1, ids[1]!]] as const) {
        await page.locator(`#clip-${id}-more`).click();
        await page.locator("#clip-menu-share").click();
        await page.locator(".share-panel").waitFor();
        await shot(page, id, `${base}-grid-${index === 0 ? "editable" : "edited"}`);
        // A version picked: Copy and Save to… on it (the tiles and the hero's side list).
        if (index === 0) {
          await page.locator(`#share-${id}-original`).click();
          await shot(page, id, `${base}-grid-picked`);
          // ⌘-click adds Sound only: two files selected.
          await page.locator(`#share-${id}-sound`).click({ modifiers: ["Meta"] });
          await shot(page, id, `${base}-grid-two`);
        }
        if (index === 0) {
          await page.locator(`#share-${id}-more`).click();
          await shot(page, id, `${base}-grid-more`);
        }
        await page.locator(`#share-${id}-close`).click();
      }
      await show(host, page, language, "list");
      await page.locator(`#clip-${ids[0]}-more`).click();
      await page.locator("#clip-menu-share").click();
      await page.locator(".share-panel").waitFor();
      await shot(page, ids[0]!, `${base}-list-editable`, true);
    });
  }
}
