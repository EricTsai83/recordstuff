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
