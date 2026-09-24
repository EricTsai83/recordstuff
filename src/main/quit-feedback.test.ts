import { expect, it, vi } from "vitest";
import { createQuitFeedback } from "./quit-feedback";
import type { MessageBoxOptions } from "electron";
import type { Language } from "../shared/i18n";

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
