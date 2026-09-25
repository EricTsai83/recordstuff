import { expect, it, vi } from "vitest";
import { HISTORY_QUIT_WAIT_MS, createHistoryQuit, createQuitFeedback } from "./quit-feedback";
import type { MessageBoxOptions } from "electron";
import type { Language } from "../shared/i18n";
import type { RecordingResult } from "../shared/recording-result";

it("joins overlapping native prompts and allows a later prompt in the current language", async () => {
  let close!: () => void;
  let language: Language = "en";
  const show = vi.fn((_options: MessageBoxOptions) => new Promise<void>(resolve => { close = resolve; }));
  const focus = vi.fn();
  const prompt = createQuitFeedback({ language: () => language, show, focus, log: vi.fn() });
  const first = prompt(); expect(prompt()).toBe(first);
  await Promise.resolve();
  expect(show).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledTimes(2);
  expect(show.mock.calls[0]?.[0]).toMatchObject({ type: "info", title: "RecordStuff", message: expect.stringContaining("RecordStuff will stay open") });
  // A later quit while the existing dialog is open must bring it forward again.
  expect(prompt()).toBe(first);
  expect(focus).toHaveBeenCalledTimes(3); expect(show).toHaveBeenCalledOnce();
  close(); await first;
  language = "zh-TW";
  const second = prompt(); await Promise.resolve();
  expect(show).toHaveBeenCalledTimes(2);
  expect(show.mock.calls[1]?.[0]).toMatchObject({ message: expect.stringContaining("RecordStuff 將保持開啟") });
  close(); await second;
});

it("clears the guard after rejected and synchronous native failures", async () => {
  const show = vi.fn().mockRejectedValueOnce(new Error("rejected")).mockImplementationOnce(() => { throw new Error("sync"); }).mockResolvedValue(undefined);
  const log = vi.fn();
  const prompt = createQuitFeedback({ language: () => "en", show, focus() {}, log });
  await prompt(); await prompt(); await prompt();
  expect(show).toHaveBeenCalledTimes(3); expect(log).toHaveBeenCalledTimes(2);
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
  expect(show.mock.calls[0]?.[0]).toMatchObject({ message: "Still saving failure reminders", buttons: ["Keep waiting", "Stay in app"], cancelId: 1 });
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
  expect(options.buttons).toEqual(["Retry", "Stay in app", "Exit without saving these reminders"]);
  expect(options.defaultId).toBe(0);
  expect(options.detail).toContain("Unsaved reminders: 7");
  expect(options.detail).toContain("The disk is full.");
  expect(options.detail).toContain("…and 2 more");
  expect(options.detail).toContain("Recording files are not affected.");
  expect(results.close).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("exiting without saving 7"));
});

it("staying, a failed prompt and Chinese copy keep the app open and resume retries", async () => {
  const results = historyResults(["unsaved"], [{ id: "a", occurredAt: "2026-09-25T04:05:06Z", code: "disk_full", detail: "", outcome: "empty", acknowledged: false, persistenceFailed: "blocked" }]);
  const show = vi.fn(async (_options: MessageBoxOptions) => ({ response: 1 }));
  expect(await createHistoryQuit({ results, language: () => "zh-TW", focus() {}, show, log: vi.fn() })()).toBe(false);
  expect(results.resume).toHaveBeenCalledOnce(); expect(results.close).not.toHaveBeenCalled();
  expect(show.mock.calls[0]?.[0]).toMatchObject({ message: "無法儲存失敗提醒", buttons: ["重試", "留在 App", "不儲存這些提醒並結束"] });
  expect(show.mock.calls[0]?.[0].detail).toContain("不會覆寫");
  const broken = historyResults(["unsaved"]), log = vi.fn();
  expect(await createHistoryQuit({ results: broken, language: () => "en", focus() {}, show: async () => { throw new Error("no dialog"); }, log })()).toBe(false);
  expect(broken.resume).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith(expect.stringContaining("no dialog"));
});
