// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../../shared/settings-panel";

/**
 * The status card speaks only when there is something to say (2026-10-04); the sidebar's foot offers Quit and Hide
 * (2026-10-07), with Hide as the primary action; the tab strip turns an unread count into a badge without changing its text.
 */
it("hides the card while ready, shows a problem with its fix and a recording with the lock, and puts Hide in the sidebar's foot", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const ready: SettingsView = { language: "en", title: "RecordStuff", hint: "", failure: "",
    status: { tone: "ready", title: "Ready to record", detail: "" },
    tabs: [{ id: "recording", label: "Recording settings" }, { id: "failures", label: "Troubleshooting (2)", accessibleLabel: "Troubleshooting, 2 unread recording failures" }],
    groups: [{ id: "about", label: "Built by Eric Tsai", note: "Version 1.3.0", tab: "general", kind: "actions", enabled: true,
      choices: [{ id: "website", label: "Official website", enabled: true, checked: false }, { id: "source", label: "GitHub source", enabled: true, checked: false },
        { id: "quit", label: "Quit RecordStuff", enabled: true, checked: false },
        { id: "hide", label: "Hide RecordStuff", enabled: true, checked: false }] }] };
  let push!: (view: SettingsView) => void;
  const choose = vi.fn(async () => ({ view: ready, applied: true }));
  window.settings = { read: async () => ready, capture: async () => ready, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-recording")).toBeTruthy());
  const statusElements = () => ({ card: document.getElementById("status")!, detail: document.getElementById("status-detail")!, action: document.getElementById("status-action")! });
  let { card, detail, action } = statusElements();
  expect(card.hidden).toBe(true);
  // In the page's order after the tabs and before their content, as the sidebar draws it under them: the first Tab
  // reaches the tabs, not the card at the sidebar's foot.
  expect([...document.querySelector(".settings-tabs")!.children].map(el => el.id || (el.classList.contains("tabs") ? "tabs" : el.className))).toEqual(["tabs", "status", "settings-content"]);
  expect(document.querySelector(".tabs")!.getAttribute("role")).toBe("tablist");

  // The sidebar's split control keeps a named Hide action and a menu; credit, version and links stay in General.
  const foot = document.getElementById("sidebar-about")!;
  const hide = foot.querySelector<HTMLButtonElement>("#sidebar-about-hide")!;
  expect([foot.hidden, hide.textContent, hide.getAttribute("aria-label"), Boolean(hide.querySelector("svg")), foot.querySelectorAll("button").length]).toEqual([false, "Hide interface", "Hide interface", true, 2]);
  hide.click();
  expect(choose).toHaveBeenCalledWith("about", "hide");
  // One request at a time (settings.ts `choose`): the next click waits for this one to settle.
  await vi.waitFor(() => expect(hide.getAttribute("aria-disabled")).toBe("false"));
  // A hide that failed says so beside it: General's About row hides its own control beside a sidebar.
  const error = foot.querySelector<HTMLElement>(".sidebar-error")!;
  expect(error.hidden).toBe(true);
  choose.mockImplementationOnce(async () => ({ view: ready, applied: false, failure: "Could not hide. Try again." }));
  hide.click();
  await vi.waitFor(() => expect([error.hidden, error.textContent]).toEqual([false, "Could not hide. Try again."]));
  // The failure reads under the row it came from.
  expect(hide.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  hide.click();
  await vi.waitFor(() => expect(error.hidden).toBe(true));

  // A failed Quit is visible beside the same split control, just as a failed Hide is.
  choose.mockImplementationOnce(async () => ({ view: ready, applied: false, failure: "Could not quit. Try again." }));
  const model = await import("./settings-controller");
  await model.choose("about", "quit", "sidebar-about-hide");
  expect([error.hidden, error.textContent]).toEqual([false, "Could not quit. Try again."]);

  push({ ...ready, revision: 2, status: { tone: "attention", title: "Output folder unavailable", detail: "Check the output folder.", action: { id: "folder", label: "Change output folder…" } } });
  expect([card.hidden, card.dataset.tone, detail.textContent, action.hidden, action.textContent]).toEqual([false, "attention", "Check the output folder.", false, "Change output folder…"]);
  // A fix main refuses says so on the card, not only aloud, until the next action.
  const statusError = document.getElementById("status-error")!;
  const attention: SettingsView = { ...ready, revision: 2, status: { tone: "attention", title: "Output folder unavailable", detail: "Check the output folder.", action: { id: "folder", label: "Change output folder…" } } };
  choose.mockImplementationOnce(async () => ({ view: attention, applied: false, failure: "Could not change the output folder. Try again." }) as { view: SettingsView; applied: boolean });
  action.click();
  await vi.waitFor(() => expect([statusError.hidden, statusError.textContent]).toEqual([false, "Could not change the output folder. Try again."]));
  action.click();
  expect(statusError.hidden).toBe(true);
  expect(choose).toHaveBeenLastCalledWith("status", "folder");
  // Main answers with the fixed, ready state: the card has nothing left to say.
  await vi.waitFor(() => expect(card.hidden).toBe(true));

  // Permission guidance stays below the tabs; the primary fix precedes the optional Relaunch link.
  expect(document.getElementById("status-secondary")!.hidden).toBe(true);
  push({ ...ready, revision: 3, status: { tone: "attention", title: "Screen recording permission required", detail: "Check recording permissions in System Settings.",
    action: { id: "permission", label: "Open System Settings" }, secondaryAction: { id: "relaunch", label: "Already allowed? Relaunch RecordStuff" } } });
  ({ card, detail, action } = statusElements());
  const secondary = document.getElementById("status-secondary")!;
  expect(detail.hidden).toBe(true);
  expect(card.parentElement?.classList.contains("settings-tabs")).toBe(true);
  expect(action.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([action.textContent, secondary.hidden, secondary.textContent]).toEqual(["Open System Settings", false, "Already allowed? Relaunch RecordStuff"]);
  secondary.click();
  expect(choose).toHaveBeenLastCalledWith("status", "relaunch");
  await vi.waitFor(() => expect(document.getElementById("status")!.hidden).toBe(true));
  ({ card, detail, action } = statusElements());

  // A keyboard user's fix hides the card under their focus: the selected tab keeps the place, and the switch is said.
  push({ ...ready, revision: 2, status: { tone: "attention", title: "Selected display is unavailable", detail: "", action: { id: "primary", label: "Use Primary display" } } });
  // Chromium drops focus to the page when the focused button's card hides; happy-dom keeps it, so the reply does it.
  choose.mockImplementationOnce(async () => { (document.activeElement as HTMLElement).blur(); return { view: ready, applied: true }; });
  action.focus(); action.click();
  await vi.waitFor(() => expect(card.hidden).toBe(true));
  await vi.waitFor(() => expect(document.activeElement?.id).toMatch(/^tab-/));
  expect(document.getElementById("feedback")!.textContent).toBe("Switched to Primary display");

  // The problem goes away by itself (the folder's drive returns) while its fix has focus: the push hides the card, and
  // the tab keeps the place, so the next Escape does not close the window.
  push({ ...ready, revision: 2.5, status: { tone: "attention", title: "Output folder unavailable", detail: "", action: { id: "folder", label: "Change output folder…" } } });
  action.focus();
  push({ ...ready, revision: 2.6 });
  expect([card.hidden, document.activeElement?.id]).toEqual([true, "tab-recording"]);

  const tab = document.getElementById("tab-failures")!;
  expect([tab.textContent, tab.querySelector(".tab-badge")?.textContent]).toEqual(["Troubleshooting (2)", "2"]);
  // The sidebar lists the tabs in a column: Up and Down move between them as Left and Right do (review pass 1, F3).
  const strip = document.querySelector('[role="tablist"]')!;
  expect(["horizontal", "vertical"]).toContain(strip.getAttribute("aria-orientation"));
  document.getElementById("tab-recording")!.focus();
  document.getElementById("tab-recording")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("tab-failures")!.getAttribute("aria-selected")).toBe("true"));
  document.getElementById("tab-failures")!.focus();
  document.getElementById("tab-failures")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("tab-recording")!.getAttribute("aria-selected")).toBe("true"));

  push({ ...ready, revision: 3, hint: "Recording in progress; only language, appearance and icon click can change.",
    status: { tone: "recording", title: "Recording", detail: "" }, tabs: [ready.tabs[0]!, { id: "failures", label: "Troubleshooting" }] });
  expect([card.hidden, card.dataset.tone, detail.hidden, document.getElementById("hint")!.hidden, action.hidden]).toEqual([false, "recording", true, false, true]);
  // The card is no live region: a state it newly shows is read through #feedback, once, a recording begun from the shortcut included.
  const feedback = document.getElementById("feedback")!;
  expect(feedback.textContent).toBe("Recording.");
  feedback.textContent = "";
  push({ ...ready, revision: 3.1, hint: "Recording in progress; only language, appearance and icon click can change.",
    status: { tone: "recording", title: "Recording", detail: "" }, tabs: [ready.tabs[0]!, { id: "failures", label: "Troubleshooting" }] });
  expect(feedback.textContent).toBe("");
  // A countdown is said as it starts, not every second.
  push({ ...ready, revision: 3.2, tabs: [ready.tabs[0]!, { id: "failures", label: "Troubleshooting" }], status: { tone: "busy", title: "Recording starts in 3 s", detail: "" } });
  expect(feedback.textContent).toBe("Recording starts in 3 s.");
  feedback.textContent = "";
  push({ ...ready, revision: 3.3, tabs: [ready.tabs[0]!, { id: "failures", label: "Troubleshooting" }], status: { tone: "busy", title: "Recording starts in 2 s", detail: "" } });
  expect(feedback.textContent).toBe("");
  // The usual way in: starting, then the countdown, both busy. Main names the state, so the countdown is still said, once.
  const busy = (revision: number, phase: "starting" | "countdown", title: string): SettingsView =>
    ({ ...ready, revision, tabs: [ready.tabs[0]!, { id: "failures", label: "Troubleshooting" }], status: { tone: "busy", phase, title, detail: "" } });
  push(busy(3.4, "starting", "Starting… Check for system permission prompts"));
  expect(feedback.textContent).toBe("Starting… Check for system permission prompts.");
  feedback.textContent = "";
  push(busy(3.5, "countdown", "Recording starts in 3 s"));
  expect(feedback.textContent).toBe("Recording starts in 3 s.");
  feedback.textContent = "";
  push(busy(3.6, "countdown", "Recording starts in 2 s"));
  expect(feedback.textContent).toBe("");
  // The open tab is on the root, where the stylesheet leaves the lock hint out beside the recordings and failures.
  expect(document.documentElement.dataset.tab).toBe("recording");
  // Switching tabs rebuilt the strip, so the tab is looked up again.
  const failures = document.getElementById("tab-failures")!;
  expect([failures.textContent, failures.querySelector(".tab-badge")]).toEqual(["Troubleshooting", null]);
  expect(failures.querySelector("svg")).toBeTruthy();
});
