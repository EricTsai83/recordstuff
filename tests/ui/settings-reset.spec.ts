import { test, expect } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";

// Production startup and IPC, with the existing background OS adapters.
test("old settings reset once at startup and preferences chosen in the UI survive restart", async ({ launchApp }) => {
  const first = await launchApp({ offline: true, settings: {
    version: 3, outputDir: "/old-recordings", language: "zh-TW", appearance: "dark",
    countdown: 0, notifications: false, trayClick: "record", hotkey: { enabled: false, accelerator: "Control+Shift+F20" },
  } });
  const settingsFile = path.join(first.data, "userData/settings.json");
  const backup = settingsFile + ".reset-backup";
  expect(JSON.parse(await fs.readFile(settingsFile, "utf8"))).toMatchObject({
    version: 4, outputDir: path.join(first.data, "videos/RecordStuff"), language: "en", appearance: "system",
    countdown: 3, notifications: true, trayClick: "menu", hotkey: { enabled: true, accelerator: "CommandOrControl+Shift+1" },
  });
  const original = await fs.readFile(backup, "utf8");
  expect(JSON.parse(original)).toMatchObject({ version: 3, language: "zh-TW", outputDir: "/old-recordings" });
  await first.evaluate(h => { h.rightClickTray(); h.clickTrayItem("^Open RecordStuff$"); });
  const page = await first.page("settings.html");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.locator("#setting-language-zh-TW").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await first.close();
  const restarted = await launchApp({ data: first.data, offline: true });
  expect(JSON.parse(await fs.readFile(settingsFile, "utf8"))).toMatchObject({ version: 4, language: "zh-TW" });
  expect(await fs.readFile(backup, "utf8")).toBe(original);
  expect((await fs.readdir(path.dirname(settingsFile))).filter(name => name.startsWith("settings.json.reset-backup"))).toEqual(["settings.json.reset-backup"]);
  await restarted.close();
});

// The first-launch guide (2026-10-26): a new install, with no settings file, opens the window with the guide over it;
// finishing it saves it as done, so the next launch shows no window by itself. The background host allows the screen,
// so the guide offers Done rather than Set up later, which both finish it.
test("a new install opens the first-launch guide by itself, and Done closes it for good", async ({ launchApp }) => {
  test.skip(process.platform !== "darwin", "the guide is macOS's only");
  const first = await launchApp({ offline: true, settings: false });
  const page = await first.page("settings.html");
  const guide = page.getByRole("dialog", { name: "Welcome to RecordStuff" });
  await expect(guide).toBeVisible();
  await page.locator("#onboarding-done").click();
  await expect(guide).toHaveCount(0);
  const settingsFile = path.join(first.data, "userData/settings.json");
  await expect.poll(async () => JSON.parse(await fs.readFile(settingsFile, "utf8").catch(() => "{}")).onboardingDone).toBe(true);
  expect(JSON.parse(await fs.readFile(settingsFile, "utf8"))).toMatchObject({ microphone: true, camera: true });
  await first.close();
});
