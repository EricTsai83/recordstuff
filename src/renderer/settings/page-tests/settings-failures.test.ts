// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { RecordingResultView, SettingsView } from "../../../shared/settings-panel";

/** Plan 047: the Recording failures tab, driven through the real page module with a fake bridge. */
const row = (id: string, over: Partial<RecordingResultView> = {}): RecordingResultView => ({
  id, code: "disk_full", outcomeState: "empty", reason: "The disk is full.", day: "Today", time: "2:05 PM", outcome: "No recording was kept.",
  guidance: "Free disk space or choose another output folder before recording again.", detail: "ENOSPC: fixture",
  acknowledged: false, actions: [{ id: "acknowledge", label: "Got it", enabled: true, checked: false }], ...over,
});
const reviewed = (id: string, over: Partial<RecordingResultView> = {}): RecordingResultView =>
  row(id, { acknowledged: true, actions: [{ id: "remove", label: "Remove from history", enabled: true, checked: false }], ...over });

let current: SettingsView;
let push!: (view: SettingsView) => void;
const choose = vi.fn(async (group: string, choice: string) => {
  const id = group.replace(/^recordingResult:/, "");
  const results = (current.recordingResults ?? []).flatMap((r) => r.id !== id ? [r]
    : choice === "remove" ? [] : choice === "acknowledge" ? [{ ...r, acknowledged: true, actions: [{ id: "remove", label: "Remove from history", enabled: true, checked: false }] }] : [r]);
  current = { ...view(results), ...(current.resultFocus === undefined ? {} : { resultFocus: current.resultFocus }) };
  return { view: current, applied: true };
});

function view(results: RecordingResultView[], over: Partial<SettingsView> = {}): SettingsView {
  const unread = results.filter((r) => !r.acknowledged).length;
  return {
    language: "en", title: "RecordStuff", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording settings" }, { id: "general", label: "General" },
      unread ? { id: "failures", label: `Troubleshooting (${unread})`, accessibleLabel: unread === 1 ? "Troubleshooting, 1 unread recording failure" : `Troubleshooting, ${unread} unread recording failures` } : { id: "failures", label: "Troubleshooting", accessibleLabel: "Troubleshooting" }],
    groups: [
      { id: "screen", label: "Screen", tab: "recording", enabled: true, choices: [{ id: "primary", label: "Primary display", enabled: true, checked: true }] },
      { id: "language", label: "Language", tab: "general", control: "segmented", enabled: true, choices: [{ id: "en", label: "English", enabled: true, checked: true }] },
    ],
    recordingResults: results,
    ...over,
  };
}
const tab = (id: string) => document.getElementById(`tab-${id}`) as HTMLButtonElement;
const rows = () => [...document.querySelectorAll<HTMLElement>(".recording-result")];
const headers = () => rows().map((r) => r.querySelector<HTMLElement>(".result-summary")!);
const key = (target: Element, name: string) => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); if (["Enter", " "].includes(name)) (target as HTMLElement).click(); };
const show = async (next: SettingsView) => { current = next; push(next); await Promise.resolve(); };

it("keeps the history in its own tab, as collapsed day-grouped rows that open independently", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  current = view([row("new"), reviewed("old", { day: "Yesterday", time: "9:12 AM", fileName: "2026-09-27 09-12-00.mp4",
    file: "/Users/me/Movies/RecordStuff/2026-09-27 09-12-00.mp4" }), reviewed("older", { day: "September 24" })]);
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(tab("failures")).toBeTruthy());

  // A normal open shows Recording, which carries no history.
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.id).toBe("tab-recording");
  expect(document.getElementById("recording-results")).toBeNull();
  expect([tab("recording"), tab("general"), tab("failures")].map((t) => t.textContent)).toEqual(["Recording settings", "General", "Troubleshooting (1)"]);
  expect(tab("failures").getAttribute("aria-label")).toBe("Troubleshooting, 1 unread recording failure");
  // The count is the tab's badge; the page's own title names the tab without it.
  expect([...tab("failures").querySelectorAll(".tab-badge")].map(badge => badge.textContent)).toEqual(["1"]);
  tab("failures").click();
  expect(document.getElementById("page-title")!.textContent).toBe("Troubleshooting");
  tab("recording").click();
  tab("general").click();
  expect(document.getElementById("recording-results")).toBeNull();

  tab("failures").click();
  expect([...document.querySelectorAll(".result-day-heading")].map((h) => h.textContent)).toEqual(["Today", "Yesterday", "September 24"]);
  expect(rows().map((r) => [r.dataset.resultId, r.hasAttribute("data-open")])).toEqual([["new", false], ["old", false], ["older", false]]);
  // The header: the unread marker in its accessible name, the reason and time; the outcome beneath.
  const first = headers()[0]!;
  expect(first.querySelector(".result-unread-label")!.textContent).toBe("Unread, ");
  expect(first.querySelector(".result-reason")!.textContent).toBe("The disk is full.");
  expect(first.querySelector(".result-time")!.textContent).toBe("2:05 PM");
  expect(first.querySelector(".result-outcome")!.textContent).toBe("No recording was kept.");
  expect(headers()[1]!.querySelector<HTMLElement>(".result-unread-label")!.hidden).toBe(true);
  // Details: no repeated heading or time, the file name, and the full path under Technical details.
  const old = rows()[1]!;
  expect(old.querySelector(".result-details")!.textContent).not.toContain("9:12 AM");
  expect(old.querySelector(".result-file")!.textContent).toBe("2026-09-27 09-12-00.mp4");
  expect(old.querySelector(".result-technical pre")!.textContent).toBe("/Users/me/Movies/RecordStuff/2026-09-27 09-12-00.mp4\nENOSPC: fixture");
  expect([...old.querySelectorAll(".result-actions button")].map((b) => b.textContent)).toEqual(["Remove from history"]);
  expect(document.querySelector(".result-history-note")!.textContent).toContain("Keeps unreviewed failures and the 20 most recently reviewed.");

  // Each row opens on its own: opening another leaves the first open (2026-10-05).
  headers()[0]!.click();
  headers()[1]!.click();
  expect(rows().map((r) => r.hasAttribute("data-open"))).toEqual([true, true, false]);
  headers()[0]!.click();
  expect(rows().map((r) => r.hasAttribute("data-open"))).toEqual([false, true, false]);

  // Up, Down, Home and End move between headers across day groups; Enter and Space open and close.
  headers()[0]!.focus();
  key(headers()[0]!, "ArrowDown");
  expect(document.activeElement).toBe(headers()[1]);
  key(headers()[1]!, "End");
  expect(document.activeElement).toBe(headers()[2]);
  key(headers()[2]!, "ArrowDown");
  expect(document.activeElement).toBe(headers()[2]);
  key(headers()[2]!, "Home");
  expect(document.activeElement).toBe(headers()[0]);
  key(headers()[0]!, "ArrowUp");
  expect(document.activeElement).toBe(headers()[0]);
  key(headers()[0]!, "Enter");
  expect(rows()[0]!.hasAttribute("data-open")).toBe(true);
  key(headers()[0]!, " ");
  expect(rows()[0]!.hasAttribute("data-open")).toBe(false);

  // Got it returns focus to its row's header and collapses the row.
  key(headers()[0]!, "Enter");
  const gotIt = rows()[0]!.querySelector<HTMLButtonElement>('[data-action="acknowledge"]')!;
  gotIt.focus(); gotIt.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("recordingResult:new", "acknowledge"));
  await vi.waitFor(() => expect(document.activeElement).toBe(headers()[0]));
  expect(rows()[0]!.hasAttribute("data-open")).toBe(false);
  expect(tab("failures").textContent).toBe("Troubleshooting");
  expect(tab("failures").getAttribute("aria-label")).toBe("Troubleshooting");
});

it("opens only the target of an explicit entry, in its tab, without acknowledging it", async () => {
  choose.mockClear();
  await show(view([row("n1"), row("n2"), reviewed("r1")], { resultFocus: 1 }));
  tab("recording").click();
  await show(view([row("n1"), row("n2"), reviewed("r1")], { resultFocus: 2 }));
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.id).toBe("tab-failures");
  expect(rows().map((r) => [r.dataset.resultId, r.hasAttribute("data-open")])).toEqual([["n1", true], ["n2", false], ["r1", false]]);
  expect(document.activeElement).toBe(headers()[0]);
  expect(choose).not.toHaveBeenCalled();
  // A later push with the same token opens nothing more.
  headers()[1]!.focus();
  await show(view([row("n1"), row("n2"), reviewed("r1")], { resultFocus: 2 }));
  expect(document.activeElement).toBe(headers()[1]);
});

it("moves focus to the row that took a removed row's place, then to the tab after the last one", async () => {
  await show(view([reviewed("a"), reviewed("b")]));
  const removeA = () => rows()[0]!.querySelector<HTMLButtonElement>('[data-action="remove"]')!;
  key(headers()[0]!, "Enter");
  removeA().focus(); removeA().click();
  await vi.waitFor(() => expect(rows().map((r) => r.dataset.resultId)).toEqual(["b"]));
  await vi.waitFor(() => expect(document.activeElement).toBe(headers()[0]));
  key(headers()[0]!, "Enter");
  removeA().focus(); removeA().click();
  await vi.waitFor(() => expect(rows()).toHaveLength(0));
  await vi.waitFor(() => expect(document.activeElement).toBe(tab("failures")));
  const empty = document.querySelector<HTMLElement>(".result-empty")!;
  expect(empty.hidden).toBe(false);
  expect(empty.textContent).toBe("No recording failures.");
  expect(document.querySelector<HTMLElement>(".result-history-note")!.hidden).toBe(true);
});

it("gives a removed row's focus to the next remaining row when other rows change in the same update", async () => {
  await show(view([reviewed("a"), reviewed("b"), reviewed("c"), reviewed("d"), reviewed("e")]));
  tab("failures").click();
  headers()[2]!.focus();
  // "c" goes together with "a" above it: its old position now holds "e", not its neighbour "d".
  await show(view([reviewed("b"), reviewed("d"), reviewed("e")]));
  expect(document.activeElement).toBe(document.getElementById("recording-result-d-summary"));
  // A new failure arriving at the top in the same update does not move it either.
  headers()[1]!.focus();
  await show(view([row("new"), reviewed("b"), reviewed("e")]));
  expect(rows().map((r) => r.dataset.resultId)).toEqual(["new", "b", "e"]);
  expect(document.activeElement).toBe(document.getElementById("recording-result-e-summary"));
  // The last row, removed with nothing after it: the new last row takes focus.
  await show(view([row("new"), reviewed("b")]));
  headers()[1]!.focus();
  await show(view([row("new")]));
  expect(document.activeElement).toBe(document.getElementById("recording-result-new-summary"));
});

it("shows the loading line instead of the empty state", async () => {
  await show(view([], { recordingHistoryStatus: "Loading failure history…" }));
  const status = document.querySelector<HTMLElement>(".result-history-status")!;
  expect([status.hidden, status.textContent]).toEqual([false, "Loading failure history…"]);
  expect(document.querySelector<HTMLElement>(".result-empty")!.hidden).toBe(true);
});

it("keeps each tab's scroll position when switching away and back; a first visit starts at the top", async () => {
  await show(view([row("s1"), row("s2")]));
  const panel = () => document.getElementById("settings-panel")!;
  const scrollable = (el: HTMLElement) => {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 300 });
  };
  tab("recording").click();
  scrollable(panel()); panel().scrollTop = 140;
  tab("general").click();
  expect(panel().scrollTop).toBe(0);
  scrollable(panel()); panel().scrollTop = 60;
  tab("recording").click();
  expect(panel().scrollTop).toBe(140);
  tab("general").click();
  expect(panel().scrollTop).toBe(60);
  // A background update in the same tab keeps its position.
  await show(view([row("s1"), row("s2"), row("s3")]));
  expect(panel().scrollTop).toBe(60);
});

it("does not announce loaded history, but announces a new persistence warning once", async () => {
  await show(view([], { recordingHistoryStatus: "Loading failure history…" }));
  document.getElementById("feedback")!.textContent = "";
  await show(view([row("restored")]));
  expect(document.getElementById("feedback")!.textContent).toBe("");
  await show(view([row("restored", { persistenceWarning: "Could not save history." })]));
  expect(document.getElementById("feedback")!.textContent).toContain("Could not save history.");
  tab("failures").click();
  expect(document.querySelectorAll('.result-persistence[role="alert"], .result-error[role="alert"]')).toHaveLength(0);
});

it("keeps the missing-file explanation instead of offering an impossible reveal retry", async () => {
  await show(view([row("gone", { actions: [{ id: "reveal", label: "Show in Finder", enabled: true, checked: false }] })]));
  tab("failures").click();
  key(headers()[0]!, "Enter");
  choose.mockImplementationOnce(async () => ({ applied: false, view: view([row("gone", { outcome: "The file is no longer available." })]) }));
  (document.querySelector('.result-actions button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.querySelector('.result-outcome')?.textContent).toBe("The file is no longer available."));
  expect(document.querySelector<HTMLElement>('.result-error')!.hidden).toBe(true);
  expect(document.getElementById("feedback")!.textContent).not.toContain("Could not complete this action");
});

it("announces an action that fails again, although its message is the same", async () => {
  const offered = () => view([row("again", { actions: [{ id: "folder", label: "Open folder", enabled: true, checked: false }] })]);
  await show(offered());
  tab("failures").click();
  key(headers()[0]!, "Enter");
  const feedback = document.getElementById("feedback")!;
  const spoken: string[] = [];
  new MutationObserver(() => spoken.push(feedback.textContent ?? "")).observe(feedback, { childList: true, characterData: true, subtree: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    choose.mockImplementationOnce(async () => ({ applied: false, view: offered() }));
    (document.querySelector('.result-actions button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(spoken.filter(t => t.startsWith("Could not complete this action."))).toHaveLength(attempt + 1));
  }
  // The live region's text changed both times, so a screen reader speaks the second failure too.
  const failures = spoken.filter(t => t.startsWith("Could not complete this action."));
  expect(failures[0]).not.toBe(failures[1]);
  expect(failures.map(t => t.trim())).toEqual(Array(2).fill("Could not complete this action. Try again."));
});

it("pages older failures in without announcing them or dropping focus, and still announces a new one", async () => {
  await show(view([row("n1"), row("n2")], { recordingResultsRemaining: 2 }));
  tab("failures").click();
  const more = document.querySelector<HTMLButtonElement>(".history-more")!;
  expect(more.hidden).toBe(false);
  more.focus();
  document.getElementById("feedback")!.textContent = "";
  choose.mockImplementationOnce(async () => ({ applied: true, view: current = view([row("n1"), row("n2"), reviewed("o1"), reviewed("o2")]) }));
  more.click();
  // Busy without native disabled, which would drop the focus it has.
  expect([more.disabled, more.getAttribute("aria-disabled")]).toEqual([false, "true"]);
  await vi.waitFor(() => expect(rows()).toHaveLength(4));
  expect(document.getElementById("feedback")!.textContent).toBe("");
  // The last page hides the button; focus moves to the first row it loaded.
  expect(more.hidden).toBe(true);
  expect(document.activeElement).toBe(document.getElementById("recording-result-o1-summary"));
  await vi.waitFor(() => expect(more.hasAttribute("aria-disabled")).toBe(false));
  await show(view([row("n0", { reason: "Capture stopped." }), row("n1"), row("n2"), reviewed("o1"), reviewed("o2")]));
  expect(document.getElementById("feedback")!.textContent).toBe("Capture stopped. No recording was kept.");
});

it("updates the scroll hint when technical details grow the content", async () => {
  const callbacks: ResizeObserverCallback[] = [];
  const resize = vi.spyOn(globalThis, "ResizeObserver").mockImplementation(class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver);
  await show(view([row("tech")]));
  tab("failures").click();
  const panel = document.getElementById("settings-panel")!;
  const hint = document.getElementById("scroll-hint")!;
  panel.scrollTop = 0; Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 0 }); panel.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(hint.style.opacity).toBe("0"));
  Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(panel, "clientHeight", { configurable: true, value: 300 });
  const technical = document.querySelector<HTMLElement>(".result-technical")!;
  technical.querySelector<HTMLElement>(".technical-summary")!.click();
  for (const callback of callbacks) callback([], {} as ResizeObserver);
  await vi.waitFor(() => expect(hint.style.opacity).toBe("1"));
  resize.mockRestore();
});

it("describes a control only by the note and diagnostics that are shown", async () => {
  await show(view([]));
  tab("recording").click();
  const select = () => document.getElementById("setting-screen")!;
  expect(select().hasAttribute("aria-describedby")).toBe(false);
  const noted = view([]);
  noted.groups[0] = { ...noted.groups[0]!, note: "Primary display is unavailable." };
  await show(noted);
  expect(select().getAttribute("aria-describedby")).toBe("setting-screen-note");
  await show(view([]));
  expect(select().hasAttribute("aria-describedby")).toBe(false);
});
