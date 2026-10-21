// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountRoot } from "./mount-root";

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error("an unexpected view");
}

it("says the window could not load, in the page's language, when the page throws while it draws", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.documentElement.lang = "zh-Hant";
  document.body.innerHTML = '<div id="root"></div>';
  mountRoot(Broken);
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("這個視窗無法載入，請關閉後再開啟 RecordStuff。");
});

it("shows nothing for a window over the screen", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.documentElement.lang = "en";
  document.body.innerHTML = '<div id="root"></div>';
  mountRoot(Broken, { fallback: "none" });
  expect(document.getElementById("root")?.innerHTML).toBe("");
});

it("draws the page itself when nothing throws", () => {
  document.body.innerHTML = '<div id="root"></div>';
  mountRoot(() => "drawn");
  expect(document.getElementById("root")?.textContent).toBe("drawn");
});
