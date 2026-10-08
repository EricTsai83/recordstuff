// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsGroup, SettingsView } from "../../shared/settings-panel";

/** The file name pattern (2026-10-05): a typed row, previewed as it is typed, saved by Enter, put back by Escape. */
it("previews a draft, saves it trimmed, says why main refused one, and keeps what is typed through a push", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const row = (template: string, revision: number): SettingsView => {
    const fileName: SettingsGroup = { id: "fileName", label: "File name format", tab: "recording", control: "text", section: "source", enabled: true,
      note: `Example: ${template === "{date} {time}" ? "2026-10-05 14-02-11" : "Demo 14-02-11"}.mp4`,
      choices: [{ id: template, label: template, enabled: true, checked: true }] };
    return { language: "en", title: "RecordStuff", hint: "", failure: "Could not apply this setting.", revision, tabs: [{ id: "recording", label: "Recording settings" }], groups: [fileName] };
  };
  let revision = 1;
  let current = row("{date} {time}", revision);
  const choose = vi.fn(async (_group: string, choice: unknown): Promise<any> => {
    revision++;
    if (choice === "Meeting {date}") return { view: current, applied: false, refused: true, failure: "Include {time} or {second} so each recording gets its own name." };
    current = row(String(choice), revision);
    return { view: current, applied: true };
  });
  let push!: (view: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  const input = await vi.waitFor(() => document.getElementById("setting-fileName") as HTMLInputElement);
  const note = document.getElementById("setting-fileName-note")!;
  expect([input.value, input.getAttribute("aria-describedby")]).toEqual(["{date} {time}", "setting-fileName-note"]);
  expect(note.textContent).toBe("Example: 2026-10-05 14-02-11.mp4");

  // A draft previews itself, or says what is wrong with it, before anything is sent.
  input.focus();
  input.value = "Demo {date}"; input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(note.textContent).toBe("Include {time} or {second} so each recording gets its own name.");
  input.value = "Demo {second}s"; input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(note.textContent).toMatch(/^Example: Demo \d\ds\.mp4$/);
  // A push meanwhile keeps the draft, and the example keeps its time: it is read once, not redrawn with the clock.
  const example = note.textContent;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5_000);
  push(row("{date} {time}", ++revision));
  expect(input.value).toBe("Demo {second}s");
  expect(note.textContent).toBe(example);
  vi.useRealTimers();

  // Main refuses a pattern it cannot use: its reason shows under the row, without "choose again".
  input.value = "Meeting {date}"; input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector("#setting-fileName-row .save-error p")!.textContent).toBe("Include {time} or {second} so each recording gets its own name."));
  expect(document.querySelector<HTMLElement>("#setting-fileName-row .reselect")!.hidden).toBe(true);
  expect(input.value).toBe("Meeting {date}");
  // Leaving the field or Enter again does not send the refused pattern a second time.
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(choose).toHaveBeenCalledTimes(1);

  // Escape puts the saved pattern back and keeps the window open; Enter saves a usable one, trimmed.
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect([input.value, close.mock.calls.length, document.querySelector<HTMLElement>("#setting-fileName-row .diagnostics")!.hidden]).toEqual(["{date} {time}", 0, true]);
  input.value = "  Demo {time} "; input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(input.value).toBe("Demo {time}"));
  expect(choose).toHaveBeenLastCalledWith("fileName", "Demo {time}");
  expect([note.textContent, document.getElementById("feedback")!.textContent]).toEqual(["Example: Demo 14-02-11.mp4", "Saved; new recordings use this name."]);
  // Leaving the field after Enter sends nothing more.
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(choose).toHaveBeenCalledTimes(2);
});
