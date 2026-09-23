import { expect, it } from "vitest";
import { HOTKEY_PRESETS, canonicalizeAccelerator, describeAccelerator, isAccelerator, validateAccelerator } from "./hotkey";

it("keeps every preset and validates the bounded custom vocabulary", () => {
  for (const value of [...HOTKEY_PRESETS, "Control+F24", "CommandOrControl+Alt+Space", "Control+Left", "Control+Plus", "Control+;"]) expect(isAccelerator(value), value).toBe(true);
  for (const value of [null, "R", "Shift+R", "Control", "Control+Shift", "Control+R+S", "Control+Nope", "Control+Control+R", "Control+" + "A".repeat(65), "CommandOrControl+Space", "CommandOrControl+Tab", "CommandOrControl+Q", ...[3, 4, 5, 6].map(n => `Shift+CommandOrControl+${n}`)]) expect(isAccelerator(value), String(value)).toBe(false);
  expect(validateAccelerator("Shift+R").error).toBe("A shortcut needs Command or Control.");
  expect(validateAccelerator("CommandOrControl+Tab").error).toBe("macOS reserves this combination.");
});
it("canonicalizes without changing key identity and describes named keys", () => {
  const value = canonicalizeAccelerator("Shift+Alt+Control+CommandOrControl+Left")!;
  expect(value).toBe("CommandOrControl+Control+Alt+Shift+Left");
  expect(canonicalizeAccelerator(value)).toBe(value);
  expect(describeAccelerator(value, "darwin")).toBe("⌘⌃⌥⇧←");
  expect(describeAccelerator("Control+F24", "win32")).toBe("Ctrl+F24");
  expect(describeAccelerator("Control+Space", "darwin")).toBe("⌃␣");
  expect(describeAccelerator("Control+Plus", "darwin")).toBe("⌃+");
});

it("normalizes shifted glyph aliases before checking reserved combinations", () => {
  expect(canonicalizeAccelerator("Control+Plus")).toBe("Control+Shift+=");
  expect(canonicalizeAccelerator("Shift+Control+Plus")).toBe("Control+Shift+=");
  expect(canonicalizeAccelerator("Control+?")).toBe("Control+Shift+/");
  expect(isAccelerator("CommandOrControl+Shift+#")).toBe(false);
  expect(isAccelerator("CommandOrControl+$")).toBe(false);
});
