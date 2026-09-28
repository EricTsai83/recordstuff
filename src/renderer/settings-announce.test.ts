// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsGroup, SettingsView } from "../shared/settings-panel";

/** What the page reads out and where a retry leaves focus, driven through the real page module. */
function view(language: "en" | "zh-TW", over: Partial<SettingsView> = {}): SettingsView {
  const zh = language === "zh-TW";
  const groups: SettingsGroup[] = [
    { id: "language", label: zh ? "語言" : "Language", tab: "general", control: "segmented", enabled: true, choices: [
      { id: "en", label: "English", enabled: true, checked: !zh }, { id: "zh-TW", label: "繁體中文", enabled: true, checked: zh }] },
    { id: "updateChecks", label: zh ? "啟動時檢查更新" : "Check for updates on launch", tab: "general", control: "switch", enabled: true,
      noteKind: "status", note: zh ? "已是最新版本。" : "You're up to date.", choices: [
        { id: "on", label: "On", enabled: true, checked: true }, { id: "off", label: "Off", enabled: true, checked: false }] },
    { id: "about", label: "Built by Eric Tsai", tab: "general", kind: "actions", enabled: true, choices: [
      { id: "website", label: "Official website", enabled: true, checked: false }, { id: "source", label: "GitHub source", enabled: true, checked: false }] },
  ];
  return {
    language, title: "RecordStuff - Settings", hint: "", failure: zh ? "無法套用這個設定。" : "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }, { id: "failures", label: "Failures" }],
    groups, recordingResults: [], ...over,
  };
}

it("reads out only news, as sentences of the panel's language, and keeps focus when an action's retry hides", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current = view("en");
  let push!: (next: SettingsView) => void;
  let finish: (() => void) | undefined;
  const choose = vi.fn(async (group: string) => {
    if (group === "about") {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { view: current, applied: false, failure: "Could not open the link. Try again." };
    }
    return { view: current, applied: false };
  });
  window.settings = { read: async () => current, capture: async () => current, choose, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const feedback = document.getElementById("feedback")!;

  // A language switch retranslates the status note; it is not news.
  current = view("zh-TW"); push(current);
  expect(feedback.textContent).toBe("");
  // A new diagnostic is read as zh-TW sentences, not "heading. reason guidance".
  current = view("zh-TW");
  current.groups[1]!.diagnostics = [{ kind: "current", heading: "無法檢查更新", reason: "無法連線", guidance: "請稍後再試" }];
  push(current);
  expect(feedback.textContent).toBe("無法檢查更新。無法連線。請稍後再試。");
  current = view("en"); push(current);

  // A failed link offers Retry; activating it hides the button, and focus must not fall to the page.
  const website = document.getElementById("setting-about-website") as HTMLButtonElement;
  website.focus(); website.click();
  finish!();
  const retry = document.getElementById("setting-about-retry") as HTMLButtonElement;
  await vi.waitFor(() => expect(retry.hidden).toBe(false));
  retry.focus(); retry.click();
  expect(retry.hidden).toBe(true);
  // Every action button is disabled while it runs, so Chromium drops the hidden retry's focus to the page.
  expect(website.disabled).toBe(true);
  const away = document.body.appendChild(document.createElement("input")); away.focus(); away.remove();
  expect(document.activeElement).toBe(document.body);
  finish!();
  await vi.waitFor(() => expect(retry.hidden).toBe(false));
  expect(document.activeElement).toBe(retry);

  // A radio group has no focusable element of its own: its checked radio takes focus instead.
  const zhRadio = document.getElementById("setting-language-zh-TW") as HTMLInputElement;
  zhRadio.focus(); zhRadio.checked = true; zhRadio.dispatchEvent(new Event("change"));
  const languageRetry = document.getElementById("setting-language-retry") as HTMLButtonElement;
  await vi.waitFor(() => expect(languageRetry.hidden).toBe(false));
  languageRetry.focus(); languageRetry.click();
  expect(languageRetry.hidden).toBe(true);
  expect(document.activeElement?.id).toBe("setting-language-en");
  await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(4));
});
