import { expect, it, vi } from "vitest";
import { HISTORY_QUIT_WAIT_MS, createHistoryQuit, createQuitFeedback } from "./quit-feedback";
import type { MessageBoxOptions } from "electron";
import type { Language } from "../shared/i18n";
import type { RecordingResult } from "../shared/recording-result";

it("tells a deferred quit in a notification in the current language and returns without waiting (plan 055)", () => {
  let language: Language = "en";
  const notify = vi.fn((_body: string) => undefined);
  const feedback = createQuitFeedback({ language: () => language, notify, log: vi.fn() });
  // Nothing to await: the deadlines the notice describes keep running while it is shown.
  expect(feedback()).toBeUndefined();
  expect(notify).toHaveBeenCalledExactlyOnceWith("Recording is still starting, saving or cleaning up. RecordStuff will stay open. A recording that has not started yet will be cancelled. After it finishes, retry the same action: Quit or Relaunch.");
  language = "zh-TW";
  feedback("media");
  expect(notify.mock.calls[1]?.[0]).toContain("RecordStuff 將保持開啟");
});

it("names a pending preference or log write instead of a recording when media had settled", () => {
  const notify = vi.fn((_body: string) => undefined);
  createQuitFeedback({ language: () => "en", notify, log: vi.fn() })("metadata");
  expect(notify).toHaveBeenCalledExactlyOnceWith("Settings or the log are still being written. RecordStuff will stay open. In a moment, retry the same action: Quit or Relaunch.");
});

it("logs a failed notification instead of throwing into the deferred quit", () => {
  const log = vi.fn();
  const feedback = createQuitFeedback({ language: () => "en", notify: () => { throw new Error("no notification"); }, log });
  expect(() => feedback()).not.toThrow();
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no notification"));
});

function historyResults(outcomes: Array<"safe" | "unsaved" | "writing">, unsaved: RecordingResult[] = [{ id: "a", occurredAt: "2026-09-25T04:05:06Z", code: "disk_full", detail: "", outcome: "empty", acknowledged: false, persistenceFailed: "io" }]) {
  return { flush: vi.fn(async (_ms: number) => outcomes.shift() ?? "safe"), unsaved: vi.fn(() => unsaved),
    resume: vi.fn(), close: vi.fn(), busy: false };
}

it("admits exit without a prompt once history is saved", async () => {
  const results = historyResults(["safe"]), show = vi.fn();
  expect(await createHistoryQuit({ results, language: () => "en", focus() {}, show, log: vi.fn(), waitMs: 7 })()).toBe(true);
  expect(results.flush).toHaveBeenCalledWith(7); expect(results.close).toHaveBeenCalledOnce(); expect(show).not.toHaveBeenCalled();
});

it("never offers exit while a save is still in flight; waiting again can then admit exit", async () => {
  const results = historyResults(["writing", "safe"]);
  const show = vi.fn(async (_options: MessageBoxOptions) => ({ response: 0 }));
  expect(await createHistoryQuit({ results, language: () => "en", focus() {}, show, log: vi.fn() })()).toBe(true);
  expect(results.flush).toHaveBeenCalledWith(HISTORY_QUIT_WAIT_MS);
  expect(show.mock.calls[0]?.[0]).toMatchObject({ message: "Still saving failure records", buttons: ["Keep waiting", "Stay in app"], cancelId: 1 });
  expect(show.mock.calls[0]?.[0].detail).toContain("may still be written");
});

it("lists unsaved reminders and exits without saving only on explicit choice and an idle writer", async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: String(i), occurredAt: `2026-09-25T0${i}:00:00Z`, code: "disk_full" as const,
    detail: "", outcome: "empty" as const, acknowledged: false, persistenceFailed: "io" as const }));
  const results = historyResults(["unsaved", "unsaved"], many);
  const log = vi.fn();
  const show = vi.fn(async (_options: MessageBoxOptions) => {
    // The first choice arrives while a write started meanwhile; it must be asked again.
    results.busy = show.mock.calls.length === 1;
    return { response: 2 };
  });
  expect(await createHistoryQuit({ results, language: () => "en", focus() {}, show, log })()).toBe(true);
  expect(show).toHaveBeenCalledTimes(2);
  const options = show.mock.calls[0]![0];
  expect(options.buttons).toEqual(["Retry", "Stay in app", "Exit without saving these records"]);
  expect(options.defaultId).toBe(0);
  expect(options.detail).toContain("Unsaved records: 7");
  expect(options.detail).toContain("The disk is full.");
  expect(options.detail).toContain("…and 2 more");
  expect(options.detail).toContain("Recording files are not affected.");
  expect(results.close).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("exiting without saving 7"));
});

it("staying, a failed prompt and Chinese copy keep the app open and resume retries", async () => {
  const results = historyResults(["unsaved"], [{ id: "a", occurredAt: "2026-09-25T04:05:06Z", code: "disk_full", detail: "", outcome: "empty", acknowledged: false, persistenceFailed: "blocked" }]);
  const show = vi.fn(async (options: MessageBoxOptions) => ({ response: options.buttons!.indexOf("留在 App") }));
  expect(await createHistoryQuit({ results, language: () => "zh-TW", focus() {}, show, log: vi.fn() })()).toBe(false);
  expect(results.resume).toHaveBeenCalledOnce(); expect(results.close).not.toHaveBeenCalled();
  // A blocked history fails every retry, so staying is the default and Retry is not offered.
  expect(show.mock.calls[0]?.[0]).toMatchObject({ message: "無法儲存失敗紀錄", buttons: ["留在 App", "不儲存這些紀錄並結束"], defaultId: 0, cancelId: 0 });
  expect(show.mock.calls[0]?.[0].detail).toContain("不會覆寫");
  const broken = historyResults(["unsaved"]), log = vi.fn();
  expect(await createHistoryQuit({ results: broken, language: () => "en", focus() {}, show: async () => { throw new Error("no dialog"); }, log })()).toBe(false);
  expect(broken.resume).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith(expect.stringContaining("no dialog"));
});

it("still shows the history prompt when bringing the app forward fails", async () => {
  const focus = () => { throw new Error("focus unavailable"); };
  const log = vi.fn(), show = vi.fn().mockResolvedValue({ response: 1 });
  const results = historyResults(["unsaved"]);
  expect(await createHistoryQuit({ results, language: () => "en", focus, show, log })()).toBe(false);
  expect(show).toHaveBeenCalledOnce();
  expect(results.resume).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("focus unavailable"));
});

it("an oversized history offers no Retry but still lets the user exit without saving", async () => {
  const results = historyResults(["unsaved"], [{ id: "a", occurredAt: "2026-09-25T04:05:06Z", code: "disk_full", detail: "", outcome: "empty", acknowledged: false, persistenceFailed: "tooLarge" }]);
  const show = vi.fn(async (options: MessageBoxOptions) => ({ response: options.buttons!.indexOf("Exit without saving these records") }));
  expect(await createHistoryQuit({ results, language: () => "en", focus() {}, show, log: vi.fn() })()).toBe(true);
  expect(show).toHaveBeenCalledOnce();
  expect(show.mock.calls[0]?.[0]).toMatchObject({ buttons: ["Stay in app", "Exit without saving these records"], defaultId: 0, cancelId: 0 });
  expect(results.flush).toHaveBeenCalledOnce(); expect(results.close).toHaveBeenCalledOnce();
});
