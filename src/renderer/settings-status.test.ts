// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";

/**
 * The status card speaks only when there is something to say (2026-10-04); the sidebar's foot carries the
 * credit, version and links; the tab strip turns an unread count into a badge without changing its text.
 */
it("hides the card while ready, shows a problem with its fix and a recording with the lock, and fills the sidebar's foot", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p><button id="status-action" hidden></button></div>'
    + '<footer id="sidebar-about" hidden><div class="sidebar-text"><p class="sidebar-credit"></p><p class="sidebar-version"></p><p class="sidebar-error" hidden></p></div><div class="sidebar-links"></div></footer><p id="feedback"></p><form id="settings"></form>';
  const ready: SettingsView = { language: "en", title: "RecordStuff", hint: "", failure: "",
    status: { tone: "ready", title: "Ready to record", detail: "" },
    tabs: [{ id: "recording", label: "Recording settings" }, { id: "failures", label: "Failures (2)", accessibleLabel: "Recording failures, 2 unread" }],
    groups: [{ id: "about", label: "Built by Eric Tsai", note: "Version 1.3.0", tab: "general", kind: "actions", enabled: true,
      choices: [{ id: "website", label: "Official website", enabled: true, checked: false }, { id: "source", label: "GitHub source", enabled: true, checked: false }] }] };
  let push!: (view: SettingsView) => void;
  const choose = vi.fn(async () => ({ view: ready, applied: true }));
  window.settings = { read: async () => ready, capture: async () => ready, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-recording")).toBeTruthy());
  const card = document.getElementById("status")!, detail = document.getElementById("status-detail")!, action = document.getElementById("status-action")!;
  expect(card.hidden).toBe(true);

  // The sidebar's foot: the credit, the version and both links as named icons, which ask main for the About choices.
  const foot = document.getElementById("sidebar-about")!;
  expect([foot.hidden, foot.querySelector(".sidebar-credit")!.textContent, foot.querySelector(".sidebar-version")!.textContent]).toEqual([false, "Built by Eric Tsai", "Version 1.3.0"]);
  expect([...foot.querySelectorAll<HTMLButtonElement>(".sidebar-link")].map(link => [link.textContent, link.getAttribute("aria-label"), link.title, Boolean(link.querySelector("svg"))]))
    .toEqual([["", "Official website", "Official website", true], ["", "GitHub source", "GitHub source", true]]);
  (foot.querySelector("#sidebar-about-source") as HTMLButtonElement).click();
  expect(choose).toHaveBeenCalledWith("about", "source");
  // One request at a time (settings.ts `choose`): the next click waits for this one to settle.
  await vi.waitFor(() => expect(foot.querySelector("#sidebar-about-source")!.getAttribute("aria-disabled")).toBe("false"));
  // A link that did not open says so beside it: General's About row, which also shows it, is hidden beside a sidebar.
  const error = foot.querySelector<HTMLElement>(".sidebar-error")!;
  expect(error.hidden).toBe(true);
  choose.mockImplementationOnce(async () => ({ view: ready, applied: false, failure: "Could not open the link. Try again." }));
  (foot.querySelector("#sidebar-about-website") as HTMLButtonElement).click();
  await vi.waitFor(() => expect([error.hidden, error.textContent]).toEqual([false, "Could not open the link. Try again."]));
  (foot.querySelector("#sidebar-about-website") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(error.hidden).toBe(true));

  push({ ...ready, revision: 2, status: { tone: "attention", title: "Output folder unavailable", detail: "Check the output folder.", action: { id: "folder", label: "Change output folder…" } } });
  expect([card.hidden, card.dataset.tone, detail.textContent, action.hidden, action.textContent]).toEqual([false, "attention", "Check the output folder.", false, "Change output folder…"]);
  action.click();
  expect(choose).toHaveBeenLastCalledWith("status", "folder");
  // Main answers with the fixed, ready state: the card has nothing left to say.
  await vi.waitFor(() => expect(card.hidden).toBe(true));

  // A keyboard user's fix hides the card under their focus: the selected tab keeps the place, and the switch is said.
  push({ ...ready, revision: 2, status: { tone: "attention", title: "Selected display is unavailable", detail: "", action: { id: "primary", label: "Use Primary display" } } });
  // Chromium drops focus to the page when the focused button's card hides; happy-dom keeps it, so the reply does it.
  choose.mockImplementationOnce(async () => { (document.activeElement as HTMLElement).blur(); return { view: ready, applied: true }; });
  action.focus(); action.click();
  await vi.waitFor(() => expect(card.hidden).toBe(true));
  await vi.waitFor(() => expect(document.activeElement?.id).toMatch(/^tab-/));
  expect(document.getElementById("feedback")!.textContent).toBe("Switched to Primary display");

  const tab = document.getElementById("tab-failures")!;
  expect([tab.textContent, tab.querySelector(".tab-badge")?.textContent]).toEqual(["Failures (2)", "2"]);
  // The sidebar lists the tabs in a column: Up and Down move between them as Left and Right do (review pass 1, F3).
  const strip = document.querySelector('[role="tablist"]')!;
  expect(["horizontal", "vertical"]).toContain(strip.getAttribute("aria-orientation"));
  document.getElementById("tab-recording")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.getElementById("tab-failures")!.getAttribute("aria-selected")).toBe("true");
  document.getElementById("tab-failures")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  expect(document.getElementById("tab-recording")!.getAttribute("aria-selected")).toBe("true");

  push({ ...ready, revision: 3, hint: "Recording in progress; only language and appearance can change.",
    status: { tone: "recording", title: "Recording", detail: "" }, tabs: [ready.tabs[0]!, { id: "failures", label: "Failures" }] });
  expect([card.hidden, card.dataset.tone, detail.hidden, document.getElementById("hint")!.hidden, action.hidden]).toEqual([false, "recording", true, false, true]);
  // Switching tabs rebuilt the strip, so the tab is looked up again.
  const failures = document.getElementById("tab-failures")!;
  expect([failures.textContent, failures.querySelector(".tab-badge")]).toEqual(["Failures", null]);
  expect(failures.querySelector("svg")).toBeTruthy();
});
