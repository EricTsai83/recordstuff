/** Preference selection timing in the hidden production app, including real IPC and disk persistence. */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";

interface SelectionSample {
  id: string;
  elapsedMs: number;
  language: string;
  background: string;
  shadow: string;
  transitions: string[];
}
interface SelectionProbe {
  pending?: { id: string; started: number };
  input?: { id: string; started: number };
  samples: SelectionSample[];
  themeChanges: Array<{ id: string; elapsedMs: number; dark: boolean }>;
}

for (const scheme of ["light", "dark"] as const) {
  test(`grouped selections commit and settle with brief colour transitions: ${scheme}, mouse and keyboard`, async ({ launchApp }, testInfo) => {
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
        const button = (event.target as Element).closest<HTMLButtonElement>(".segments button");
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
        const style = getComputedStyle(selected);
        probe.samples.push({
          id: pending.id, elapsedMs, language: document.documentElement.lang,
          background: style.backgroundColor, shadow: style.boxShadow,
          transitions: [...selected.parentElement!.querySelectorAll("button")].flatMap(button =>
            button.getAnimations().filter(animation => animation instanceof CSSTransition).map(() => button.id)),
        });
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
      // The background and icon share the same short transition, rather than a 150ms all-property fade.
      const timing = await button.evaluate(node => {
        const style = getComputedStyle(node), icon = node.querySelector("svg");
        return { property: style.transitionProperty, duration: style.transitionDuration,
          iconDuration: icon ? getComputedStyle(icon).transitionDuration : undefined };
      });
      expect(timing.property).not.toBe("all");
      // Bound responsiveness without making a design adjustment to the exact duration a regression.
      for (const duration of [timing.duration, timing.iconDuration].filter(Boolean))
        for (const seconds of duration!.split(",").map(value => parseFloat(value))) {
          expect(seconds).toBeGreaterThanOrEqual(0);
          expect(seconds).toBeLessThanOrEqual(0.2);
        }
      await expect.poll(() => button.evaluate(node => node.getAnimations().filter(a => a instanceof CSSTransition && a.playState === "running").length)).toBe(0);
      if (group === "language") expect(sample.language).toBe(choice === "en" ? "en" : "zh-Hant");
      if (group === "language") {
        // Language keeps the palette fixed; inspect the settled red-tinted selection after the brief transition.
        const settled = await button.evaluate(button => {
          const style = getComputedStyle(button);
          return { background: style.backgroundColor, shadow: style.boxShadow };
        });
        const selection = await button.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--selection)";
          document.body.append(probe);
          const colour = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return colour;
        });
        expect(settled.background).toBe(selection);
      } else {
        const dark = await app.evaluate((_h, _arg, electron) => electron.nativeTheme.shouldUseDarkColors);
        if (dark) await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        const primary = await button.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--primary)";
          document.body.append(probe);
          const colour = getComputedStyle(probe).color;
          probe.remove();
          return colour;
        });
        await expect(button.locator("svg")).toHaveCSS("color", primary);
        for (const unselected of await page.locator('#setting-appearance-row button[aria-pressed="false"]').all())
          await expect(unselected.locator("svg")).toHaveCSS("color", await unselected.evaluate(node => getComputedStyle(node).color));
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
      await expect(tab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const indicator = await tab.evaluate(node => {
        const style = getComputedStyle(node, "::after");
        return { opacity: style.opacity, height: style.height };
      });
      expect(indicator.opacity).toBe("1");
      expect(parseFloat(indicator.height)).toBeGreaterThan(0);
      const otherTab = page.locator(index ? "#troubleshooting-tools-tab" : "#troubleshooting-history-tab");
      expect(await otherTab.evaluate(node => getComputedStyle(node, "::after").opacity)).toBe("0");
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
