// @vitest-environment happy-dom
import { expect, it } from "vitest";

it("marks a failed first read's message with the requested language, not the page default", async () => {
  history.replaceState(null, "", "?lang=zh-TW");
  document.documentElement.lang = "en";
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback" class="visually-hidden"></p><form id="settings"></form>';
  window.settings = { read: async () => { throw new Error("main unavailable"); }, capture: async () => { throw new Error("unused"); },
    choose: async () => { throw new Error("unused"); }, onChanged: () => () => {} };
  await import("./settings");
  const feedback = document.getElementById("feedback")!;
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(feedback.textContent).toBe("無法開啟設定，請關閉這個視窗後再開一次。");
  expect(document.documentElement.lang).toBe("zh-Hant");
});
