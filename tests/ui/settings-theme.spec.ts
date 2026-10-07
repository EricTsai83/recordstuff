/** Real preference clicks and nativeTheme changes in the hidden production app; no desktop input. */
import { test, expect } from "./fixtures";
import fs from "node:fs";
import path from "node:path";

test("the brand mark matches the packaged icon's red dot and stays fixed across themes", async ({ launchView }, testInfo) => {
  const { launched: host, page } = await launchView();
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.default));
  const icon = fs.readFileSync(path.resolve("build/icon.png")).toString("base64");
  const packagedRed = await page.evaluate(async png => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), char => char.charCodeAt(0))], { type: "image/png" }));
    try {
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const [r, g, b] = context.getImageData(image.width / 2, image.height / 2, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    } finally { image.close(); }
  }, icon);
  let fixed: { tile: string; ring: string; dot: string } | undefined;
  for (const scheme of ["light", "dark"] as const) {
    await host.evaluate((h, theme) => h.theme(theme), scheme);
    await expect(page.locator(".brand-mark")).toBeVisible();
    const colours = await page.locator(".brand-mark").evaluate(mark => ({
      tile: getComputedStyle(mark).backgroundColor,
      ring: getComputedStyle(mark, "::before").borderTopColor,
      dot: getComputedStyle(mark, "::after").backgroundColor,
    }));
    expect(colours.dot).toBe(packagedRed);
    if (fixed) expect(colours).toEqual(fixed);
    else fixed = colours;
    await page.screenshot({ path: testInfo.outputPath(`fixed-brand-${scheme}.png`), animations: "disabled" });
  }
});

interface ButtonColours { id: string; background: string; foreground: string; border: string }
interface ThemeSample { dark: boolean; colours: ButtonColours[]; transitions: string[]; suppressed: boolean }
interface ThemeProbe { samples: ThemeSample[]; hoverTransitions: string[] }

test("theme changes commit button colours immediately in both directions and retain hover feedback", async ({ launchApp }, testInfo) => {
  const app = await launchApp({ settings: { appearance: "light", hotkey: { enabled: false, accelerator: "Control+Shift+F20" } } });
  const waiting = app.page("settings.html");
  await app.evaluate(h => { h.rightClickTray(); h.clickTrayItem("^Open RecordStuff$"); });
  const page = await waiting;
  await page.locator("#tab-general").click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const probe: ThemeProbe = { samples: [], hoverTransitions: [] };
    (window as unknown as { themeProbe: ThemeProbe }).themeProbe = probe;
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[id]")].filter(button => button.getBoundingClientRect().height > 0);
      // This listener runs after the production hook, in the same media-change task, before 150ms can elapse.
      probe.samples.push({
        dark: event.matches,
        colours: buttons.map(button => {
          const style = getComputedStyle(button);
          return { id: button.id, background: style.backgroundColor, foreground: style.color, border: style.borderTopColor };
        }),
        transitions: buttons.flatMap(button => button.getAnimations().filter(animation => animation instanceof CSSTransition).map(() => button.id)),
        suppressed: document.documentElement.hasAttribute("data-theme-changing"),
      });
    });
    document.getElementById("sidebar-about-hide")!.addEventListener("transitionrun", event => {
      probe.hoverTransitions.push((event as TransitionEvent).propertyName);
    });
  });

  for (const [index, scheme] of (["dark", "light"] as const).entries()) {
    if (index === 1) {
      // Keyboard activation takes the same preference path as a mouse click.
      await page.locator(`#setting-appearance-${scheme}`).focus();
      await page.keyboard.press("Space");
    } else await page.locator(`#setting-appearance-${scheme}`).click();
    await page.mouse.move(0, 0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { themeProbe: ThemeProbe }).themeProbe.samples.length)).toBe(index + 1);
    const sample = await page.evaluate(index => (window as unknown as { themeProbe: ThemeProbe }).themeProbe.samples[index]!, index);
    expect(sample.dark).toBe(scheme === "dark");
    expect(sample.colours.length).toBeGreaterThan(0);
    expect(sample.transitions, "no button is still interpolating its theme colours").toEqual([]);
    expect(sample.suppressed, "hover transitions are already restored").toBe(false);
    await expect(page.locator(`#setting-appearance-${scheme}`)).toHaveAttribute("aria-pressed", "true");
    // Compare against the settled palette, avoiding a test tied to particular colour tokens.
    await page.waitForTimeout(200);
    const settled = await page.evaluate(colours => colours.map(({ id }) => {
      const style = getComputedStyle(document.getElementById(id)!);
      return { id, background: style.backgroundColor, foreground: style.color, border: style.borderTopColor };
    }), sample.colours);
    // The clicked appearance segment can leave hover after the change; the sidebar button stays at rest throughout.
    expect(sample.colours.find(button => button.id === "sidebar-about-hide-menu"))
      .toEqual(settled.find(button => button.id === "sidebar-about-hide-menu"));
    await page.screenshot({ path: testInfo.outputPath(`theme-${index}-${scheme}.png`), animations: "disabled" });
  }

  await page.locator("#sidebar-about-hide").hover();
  await expect.poll(() => page.evaluate(() => (window as unknown as { themeProbe: ThemeProbe }).themeProbe.hoverTransitions))
    .toContain("background-color");
  await page.screenshot({ path: testInfo.outputPath("theme-hover-restored.png"), animations: "disabled" });
});

test("the content is a raised card over the shared window and sidebar backdrop", async ({ launchView }, testInfo) => {
  const { launched: host, page } = await launchView();
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.default));
  for (const scheme of ["light", "dark"] as const) {
    await host.evaluate((h, theme) => h.theme(theme), scheme);
    const surfaces = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar-background")!;
      const content = document.querySelector<HTMLElement>(".settings-card")!;
      const viewport = document.querySelector<HTMLElement>(".settings-viewport")!;
      const sidebarStyle = getComputedStyle(sidebar), contentStyle = getComputedStyle(content);
      const sidebarBounds = sidebar.getBoundingClientRect(), contentBounds = content.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.backgroundColor = "var(--card)";
      const card = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        backdrop: getComputedStyle(document.documentElement).backgroundColor,
        sidebar: sidebarStyle.backgroundColor,
        content: contentStyle.backgroundColor,
        card,
        sidebarRadius: parseFloat(sidebarStyle.borderTopRightRadius),
        contentRadius: parseFloat(contentStyle.borderTopLeftRadius),
        sidebarShadow: sidebarStyle.boxShadow,
        contentShadow: contentStyle.boxShadow,
        separate: sidebarBounds.right <= contentBounds.left,
        inset: viewportBounds.top >= 32 && viewportBounds.right < innerWidth && viewportBounds.bottom <= innerHeight,
        containsViewport: viewportBounds.left >= contentBounds.left && viewportBounds.right <= contentBounds.right
          && viewportBounds.top >= contentBounds.top && viewportBounds.bottom - parseFloat(getComputedStyle(document.getElementById("settings-panel")!).paddingBottom) <= contentBounds.bottom,
      };
    });
    expect(surfaces.sidebar).toBe(surfaces.backdrop);
    expect(surfaces.content).toBe(surfaces.card);
    expect(surfaces.content).not.toBe(surfaces.backdrop);
    expect(surfaces.sidebarRadius).toBe(0);
    expect(surfaces.sidebarShadow).toBe("none");
    expect(surfaces.contentRadius).toBeGreaterThan(0);
    expect(surfaces.contentShadow).not.toBe("none");
    expect(surfaces.separate, JSON.stringify(surfaces)).toBe(true);
    expect(surfaces.inset, JSON.stringify(surfaces)).toBe(true);
    expect(surfaces.containsViewport, JSON.stringify(surfaces)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`content-card-${scheme}.png`), animations: "disabled" });
  }
});

test("the card fills the right viewport, grows beyond it and scrolls without moving the sidebar", async ({ launchView }, testInfo) => {
  const { launched: host, page } = await launchView();
  const card = page.locator(".settings-card"), panel = page.locator("#settings-panel"), sidebar = page.locator(".sidebar-background");
  const availableHeight = () => panel.evaluate(el => el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom));
  for (const scheme of ["light", "dark"] as const) {
    await host.evaluate((h, theme) => {
      h.theme(theme);
      h.setContentSize(960, 1000);
      h.pushModel({ type: "idle" }, { library: { ...h.library().state, files: [] } });
    }, scheme);
    await page.locator("#tab-library").click();
    await expect.poll(async () => (await card.boundingBox())!.height - await availableHeight()).toBeCloseTo(0, 0);
    await host.evaluate(h => h.setContentSize(960, 1200));
    await expect.poll(async () => (await card.boundingBox())!.height - await availableHeight()).toBeCloseTo(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`minimum-card-${scheme}.png`), animations: "disabled" });
    await page.locator("#tab-general").click();
    await host.evaluate(h => h.setContentSize(960, 400));
    await panel.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const before = (await card.boundingBox())!, viewport = (await panel.boundingBox())!, fixedSidebar = (await sidebar.boundingBox())!;
    expect(before.height).toBeGreaterThan(viewport.height);
    expect(before.y + before.height).toBeGreaterThan(400);
    await page.screenshot({ path: testInfo.outputPath(`long-card-top-${scheme}.png`), animations: "disabled" });
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const after = (await card.boundingBox())!;
    expect(after.y).toBeLessThan(before.y);
    expect(after.height).toBe(before.height);
    expect(await sidebar.boundingBox()).toEqual(fixedSidebar);
    await panel.focus();
    await page.keyboard.press("PageDown");
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => panel.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    const bottom = (await card.boundingBox())!;
    const endGap = await panel.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom));
    expect(bottom.y + bottom.height).toBeCloseTo(viewport.y + viewport.height - endGap, 0);
    expect(await card.evaluate(el => parseFloat(getComputedStyle(el).borderBottomLeftRadius))).toBeGreaterThan(0);
    expect(await page.evaluate(() => [document.documentElement.scrollTop, document.querySelector("main")!.scrollTop])).toEqual([0, 0]);
    await page.screenshot({ path: testInfo.outputPath(`long-card-bottom-${scheme}.png`), animations: "disabled" });
  }
});
