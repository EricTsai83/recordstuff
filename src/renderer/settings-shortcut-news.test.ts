// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsGroup, SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";

const NOTE = "Unavailable: another app is using this shortcut.";
const diagnostic = (reason: string) => ({ kind: "current" as const, heading: "Shortcut unavailable", reason, guidance: "Choose another shortcut." });
function view(shortcut: Partial<SettingsGroup> = {}): SettingsView {
  return {
    language: "en", title: "Settings", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true, noteKind: "status",
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }], ...shortcut }],
  };
}
const failed = (reason = NOTE): SettingsView => view({ note: reason, diagnostics: [diagnostic(reason)] });

/** A registration failure is read once, and the editor handing its note back on close is not news. */
it("reads a shortcut failure once and not again when the editor closes", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current = view();
  let push!: (next: SettingsView) => void;
  /** What main shows once the editor closes. */
  let afterCapture = failed();
  const capture = vi.fn(async (armed: boolean) => {
    // Main hides the note, diagnostics and retry while the editor holds its lease.
    current = armed ? view({ capturing: true }) : structuredClone(afterCapture);
    return current;
  });
  window.settings = { read: async () => current, capture, choose: vi.fn(), onChanged: (cb) => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const feedback = document.getElementById("feedback")!;

  current = failed(); push(current);
  expect(feedback.textContent).toBe(`Shortcut unavailable. ${NOTE} Choose another shortcut.`);

  const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
  const field = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  const open = async (): Promise<void> => {
    select.value = "custom"; select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));
  };
  const cancel = async (): Promise<void> => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(capture).toHaveBeenLastCalledWith(false));
    await vi.waitFor(() => expect(current.groups[0]!.capturing).toBeUndefined());
  };

  await open();
  await cancel();
  expect(feedback.textContent).toBe("");

  // A different failure after the editor closes is news.
  afterCapture = failed("Unavailable: the shortcut could not be registered.");
  await open();
  await cancel();
  await vi.waitFor(() => expect(feedback.textContent).toContain("the shortcut could not be registered"));
});
