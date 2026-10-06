// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";

/** Main keeps a new window hidden until the page reports this, so it must follow the first drawn view, once. */
it("reports ready once, after the frame that holds the first view", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p></div><p id="feedback"></p><form id="settings"></form>';
  const current: SettingsView = { language: "en", title: "Settings", hint: "", failure: "",
    tabs: [{ id: "recording", label: "Recording" }], groups: [] };
  let push!: (view: SettingsView) => void;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
  const ready = vi.fn(async () => {});
  window.settings = { read: async () => current, capture: async () => current, choose: vi.fn(), ready, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-recording")).toBeTruthy());
  push({ ...current, revision: 2 });
  expect(ready).not.toHaveBeenCalled();
  frames.shift()!(0);
  expect(ready).not.toHaveBeenCalled();
  frames.shift()!(16);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(frames).toHaveLength(0);
});
