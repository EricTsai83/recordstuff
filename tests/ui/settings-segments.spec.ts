/** Preference selection timing in the hidden production app, including real IPC and disk persistence. */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";

interface SelectionSample {
  id: string;
  elapsedMs: number;
  language: string;
}
interface SelectionProbe {
  pending?: { id: string; started: number };
  input?: { id: string; started: number };
  samples: SelectionSample[];
  themeChanges: Array<{ id: string; elapsedMs: number; dark: boolean }>;
}

for (const scheme of ["light", "dark"] as const) {
  test(`grouped selections commit, persist and apply: ${scheme}, mouse and keyboard`, async ({ launchApp }, testInfo) => {
    const app = await launchApp({ settings: { appearance: scheme } });
    const waiting = app.page("settings.html");
    await app.evaluate(h => { h.rightClickTray(); h.clickTrayItem("^Open RecordStuff$"); });
    const page = await waiting;
    await page.locator("#tab-general").click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      const probe: SelectionProbe = { samples: [], themeChanges: [] };
      (window as unknown as { selectionProbe: SelectionProbe }).selectionProbe = probe;
      document.addEventListener("click", event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button[aria-pressed]");
        if (button && button.getAttribute("aria-pressed") !== "true") {
          probe.input = { id: button.id, started: performance.now() };
          probe.pending = probe.input;
        }
      }, true);
      // Chromium delivers nativeTheme changes separately from the settings reply; time that path independently.
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
        if (probe.input) probe.themeChanges.push({
          id: probe.input.id, elapsedMs: performance.now() - probe.input.started, dark: event.matches,
        });
      });
      new MutationObserver(() => {
        const pending = probe.pending;
        if (!pending) return;
        const selected = document.getElementById(pending.id)!;
        if (selected.getAttribute("aria-pressed") !== "true") return;
        const elapsedMs = performance.now() - pending.started;
        probe.samples.push({ id: pending.id, elapsedMs, language: document.documentElement.lang });
        delete probe.pending;
      }).observe(document.getElementById("settings")!, { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
    });

    const choices = [
      // One round per input method; extra identical rounds add no different behavior.
      ["language", "zh-TW"], ["language", "en"],
      ["language", "zh-TW"], ["language", "en"],
      ["appearance", scheme === "light" ? "dark" : "light"],
      ["appearance", "system"], ["appearance", scheme],
    ] as const;
    for (const [index, [group, choice]] of choices.entries()) {
      const button = page.locator(`#setting-${group}-${choice}`);
      if (index === 2 || index === 3 || index === 5) {
        await button.focus();
        await page.keyboard.press("Space");
      } else await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(`#setting-${group}-row`)).toHaveAttribute("aria-busy", "false");
      const sample = await page.evaluate(index =>
        (window as unknown as { selectionProbe: SelectionProbe }).selectionProbe.samples[index]!, index);
      expect(sample.id).toBe(`setting-${group}-${choice}`);
      if (group === "language") expect(sample.language).toBe(choice === "en" ? "en" : "zh-Hant");
      if (group === "appearance") {
        // The chosen appearance reaches the page: the renderer follows nativeTheme's dark or light.
        const dark = await app.evaluate((_h, _arg, electron) => electron.nativeTheme.shouldUseDarkColors);
        await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(dark);
        await page.screenshot({ path: testInfo.outputPath(`appearance-icon-${scheme}-${choice}.png`), animations: "disabled" });
      }
      const saved = JSON.parse(fs.readFileSync(path.join(app.data, "userData/settings.json"), "utf8"));
      expect(saved[group]).toBe(choice);
      if (index < 2) await page.screenshot({ path: testInfo.outputPath(`segments-${scheme}-${choice}.png`) });
    }
    await page.locator("#tab-failures").click();
    const tabs = [page.locator("#troubleshooting-tools-tab"), page.locator("#troubleshooting-history-tab")];
    for (const [index, tab] of tabs.entries()) {
      if (index) { await tab.focus(); await page.keyboard.press("Space"); }
      else await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(index ? "#troubleshooting-tools-tab" : "#troubleshooting-history-tab")).toHaveAttribute("aria-selected", "false");
    }
    await page.screenshot({ path: testInfo.outputPath(`troubleshooting-selection-${scheme}.png`), animations: "disabled" });
    const probe = await page.evaluate(() => {
      const { samples, themeChanges } = (window as unknown as { selectionProbe: SelectionProbe }).selectionProbe;
      return { samples, themeChanges };
    });
    expect(probe.samples).toHaveLength(choices.length);
    // Timings are diagnostic, not a flaky CI speed threshold. Offscreen DOM/style readiness does not measure native paint.
    fs.writeFileSync(testInfo.outputPath("selection-timings.json"), JSON.stringify({ scheme, ...probe }, null, 2));
  });
}
