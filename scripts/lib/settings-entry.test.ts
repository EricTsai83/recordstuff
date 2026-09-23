import { expect, it } from "vitest";
import { registeredSettingsAccelerator, acceleratorToKeystroke, keystrokeScript } from "./acceptance.mts";
const start = "[time] start: RecordStuff";
const registered = "[time] settings shortcut: registered CommandOrControl+Alt+,";
it("does not send a reserved key on stale, suspended, failed or conflicting ownership", () => {
  expect(registeredSettingsAccelerator([registered])).toBeUndefined();
  expect(registeredSettingsAccelerator([start, registered, start])).toBeUndefined();
  for (const status of ["disabled", "suspended", "registration failed for key: OS", "unavailable; recording shortcut owns the combination"]) {
    expect(registeredSettingsAccelerator([start, registered, `[time] settings shortcut: ${status}`])).toBeUndefined();
  }
});
it("accepts resumed ownership and ignores press logs and unrelated recording registrations", () => {
  expect(registeredSettingsAccelerator([start, "[time] settings shortcut: suspended", registered,
    "[time] settings shortcut: CommandOrControl+Alt+, pressed", "[time] hotkey: disabled"])).toBe("CommandOrControl+Alt+,");
  expect(keystrokeScript(acceleratorToKeystroke("CommandOrControl+Alt+,")!)).toBe('tell application "System Events" to key code 43 using {command down, option down}');
});
