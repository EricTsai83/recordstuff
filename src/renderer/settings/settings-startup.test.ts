// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";

it("marks a failed first read's message with the requested language, not the page default", async () => {
  history.replaceState(null, "", "?lang=zh-TW");
  document.documentElement.lang = "en";
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p></div><p id="feedback" class="visually-hidden"></p><form id="settings"></form>';
  let push!: (view: SettingsView) => void;
  const ready = vi.fn(async () => { throw new Error("main refused"); });
  window.settings = { read: async () => { throw new Error("main unavailable"); }, capture: async () => { throw new Error("unused"); },
    choose: async () => { throw new Error("unused"); }, ready, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("./settings");
  const feedback = document.getElementById("feedback")!;
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(feedback.textContent).toBe("這個視窗無法載入，請關閉後再開啟 RecordStuff。");
  expect(document.documentElement.lang).toBe("zh-Hant");
  expect(feedback.classList.contains("visually-hidden")).toBe(false);
  // The error is content: main may show the window with it, and a refused report is not the page's failure.
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  // A later push draws a working panel: the stale error goes, and the region is hidden again.
  push({ language: "zh-TW", title: "設定", hint: "", failure: "", tabs: [{ id: "general", label: "一般" }], groups: [] });
  expect(feedback.textContent).toBe("");
  expect(feedback.classList.contains("visually-hidden")).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(ready).toHaveBeenCalledTimes(1);
});
