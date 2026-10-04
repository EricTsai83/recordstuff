// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { SettingsView } from "../shared/settings-panel";

/**
 * A push that changes nothing rewrites none of the controls' states: no disabled flag flips off and on again, and
 * no ARIA state or name is written over itself. (happy-dom records any `hidden` or class write, even an unchanged
 * one, so only these attributes are watched.)
 */
it("leaves controls untouched when the same view arrives again", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p><button id="status-action" hidden></button></div><p id="feedback"></p><form id="settings"></form>';
  const view: SettingsView = { language: "en", title: "RecordStuff", hint: "", failure: "", revision: 1,
    tabs: [{ id: "recording", label: "Recording settings" }],
    groups: [
      { id: "countdown", label: "Countdown", tab: "recording", control: "segmented", enabled: true, info: "How to cancel",
        choices: [{ id: "0", label: "Off", enabled: true, checked: false }, { id: "3", label: "3 s", enabled: false, checked: true }] },
      { id: "countdownSound", label: "Sound", tab: "recording", control: "switch", enabled: true,
        choices: [{ id: "on", label: "On", enabled: false, checked: true }, { id: "off", label: "Off", enabled: false, checked: false }] },
      { id: "log", label: "Log file", tab: "recording", kind: "actions", enabled: true, choices: [{ id: "show", label: "Show log", enabled: true, checked: false }] },
    ] };
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => view, capture: async () => view, choose: async () => ({ view, applied: true }), ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  const sound = await vi_waitFor(() => document.getElementById("setting-countdownSound") as HTMLInputElement | null);
  expect([sound.disabled, (document.getElementById("setting-countdown-3") as HTMLInputElement).disabled]).toEqual([true, true]);
  const changes: string[] = [];
  const observer = new MutationObserver(records => { for (const record of records) changes.push(`${(record.target as Element).id}:${record.attributeName}`); });
  observer.observe(document.getElementById("settings")!, { attributes: true, subtree: true,
    attributeFilter: ["disabled", "aria-disabled", "aria-label", "aria-busy", "aria-describedby", "title"] });
  push({ ...view, revision: 2 });
  await Promise.resolve();
  observer.disconnect();
  expect(changes).toEqual([]);
});

async function vi_waitFor<T>(find: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = find();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("not rendered");
}
