import { expect, it } from "vitest";
import { canonicalizeAccelerator, describeAccelerator, sameShortcut, validateAccelerator } from "./hotkey";

const isAccepted = (value: unknown, platform: string): boolean => canonicalizeAccelerator(value, platform) !== undefined;

it("keeps every preset and validates the bounded custom vocabulary", () => {
  for (const platform of ["darwin", "win32"]) {
    for (const value of ["CommandOrControl+Shift+1", "CommandOrControl+Alt+Shift+R", "CommandOrControl+Shift+R", "CommandOrControl+Alt+R", "Control+F24", "CommandOrControl+Alt+Space", "Control+Left", "Control+Plus", "Control+;"]) expect(isAccepted(value, platform), `${platform} ${value}`).toBe(true);
    for (const value of [null, "R", "Shift+R", "Control", "Control+Shift", "Control+R+S", "Control+Nope", "Control+Control+R", "Control+" + "A".repeat(65), "CommandOrControl+Tab", "CommandOrControl+Q", "CommandOrControl+W"]) expect(isAccepted(value, platform), `${platform} ${String(value)}`).toBe(false);
  }
  expect(validateAccelerator("Shift+R", "darwin").error).toBe("A shortcut needs Command or Control.");
  expect(validateAccelerator("CommandOrControl+Tab", "darwin").error).toBe("macOS reserves this combination.");
  // Command+W stays every window's close key; macOS Control+W and Command+Shift+W remain choices.
  expect(validateAccelerator("CommandOrControl+W", "darwin").error).toBe("macOS reserves this combination.");
  expect(validateAccelerator("Control+W", "darwin").accelerator).toBe("Control+W");
  expect(validateAccelerator("Shift+CommandOrControl+W", "darwin").accelerator).toBe("CommandOrControl+Shift+W");
});

it("reserves the macOS screenshot and Spotlight chords on macOS only (plan 064)", () => {
  // With Control the screenshot goes to the clipboard: ⌃⇧⌘3, ⌃⇧⌘4 and the Touch Bar's ⌃⇧⌘6 are the system's too.
  const chords = ["CommandOrControl+Space", ...[3, 4, 5, 6].map(n => `Shift+CommandOrControl+${n}`), ...[3, 4, 6].map(n => `Control+Shift+CommandOrControl+${n}`)];
  for (const value of chords) expect(validateAccelerator(value, "darwin").error, value).toBe("macOS reserves this combination.");
  for (const value of chords) expect(isAccepted(value, "win32"), value).toBe(true);
  expect(canonicalizeAccelerator("Shift+CommandOrControl+3", "win32")).toBe("CommandOrControl+Shift+3");
});

it("off macOS, refuses every app's switch, quit and close keys however Ctrl is spelled, with Windows wording (plan 064)", () => {
  // The Windows editor reports Ctrl as Control, so Control+Q used to slip past a Command-only list.
  for (const value of ["Control+Q", "CommandOrControl+Q", "CommandOrControl+Control+Q", "Control+W", "Control+Tab"]) {
    expect(validateAccelerator(value, "win32").error, value).toBe("Other apps use this combination.");
  }
  expect(validateAccelerator("Control+Shift+Q", "win32").accelerator).toBe("Control+Shift+Q");
  expect(validateAccelerator("Alt+Shift+R", "win32").error).toBe("A shortcut needs Ctrl.");
  expect(validateAccelerator("Alt+Shift+R", "linux").error).toBe("A shortcut needs Ctrl.");
});

it("refuses the editing keys every app shares, so pasting never starts a recording", () => {
  for (const value of ["CommandOrControl+C", "CommandOrControl+V", "CommandOrControl+X", "CommandOrControl+A", "CommandOrControl+Z", "Shift+CommandOrControl+Z"]) {
    expect(validateAccelerator(value, "darwin").error, value).toBe("Other apps use this combination.");
    expect(validateAccelerator(value, "win32").error, value).toBe("Other apps use this combination.");
  }
  for (const value of ["Control+C", "Control+V", "Control+Y", "Control+Shift+Z"]) expect(validateAccelerator(value, "win32").error, value).toBe("Other apps use this combination.");
  // With another modifier, or Control on macOS, which is a key of its own there, they stay choices.
  for (const value of ["CommandOrControl+Alt+V", "CommandOrControl+Shift+C", "Control+V", "CommandOrControl+Y"]) expect(isAccepted(value, "darwin"), value).toBe(true);
  expect(isAccepted("Control+Alt+V", "win32")).toBe(true);
});

it("canonicalizes without changing key identity and describes named keys", () => {
  const value = canonicalizeAccelerator("Shift+Alt+Control+CommandOrControl+Left", "darwin")!;
  expect(value).toBe("CommandOrControl+Control+Alt+Shift+Left");
  expect(canonicalizeAccelerator(value, "darwin")).toBe(value);
  expect(describeAccelerator(value, "darwin")).toBe("⌃⌥⇧⌘←");
  expect(describeAccelerator("Control+F24", "win32")).toBe("Ctrl+F24");
  expect(describeAccelerator("Control+Space", "darwin")).toBe("⌃␣");
  expect(describeAccelerator(canonicalizeAccelerator("Control+Plus", "darwin")!, "darwin")).toBe("⌃⇧=");
});

it("normalizes shifted glyph aliases before checking reserved combinations", () => {
  expect(canonicalizeAccelerator("Control+Plus", "darwin")).toBe("Control+Shift+=");
  expect(canonicalizeAccelerator("Shift+Control+Plus", "darwin")).toBe("Control+Shift+=");
  expect(canonicalizeAccelerator("Control+?", "darwin")).toBe("Control+Shift+/");
  expect(isAccepted("CommandOrControl+Shift+#", "darwin")).toBe(false);
  expect(isAccepted("CommandOrControl+$", "darwin")).toBe(false);
});

it("compares shortcuts by the keys they press on each platform", () => {
  expect(sameShortcut("Control+Shift+1", "CommandOrControl+Shift+1", "win32")).toBe(true);
  expect(sameShortcut("CommandOrControl+Control+Shift+1", "Control+Shift+1", "linux")).toBe(true);
  expect(sameShortcut("Control+Shift+1", "CommandOrControl+Shift+1", "darwin")).toBe(false);
  expect(sameShortcut("Shift+CommandOrControl+!", "CommandOrControl+Shift+1", "darwin")).toBe(true);
  expect(sameShortcut("Control+Nope", "Control+Nope", "win32")).toBe(false);
});
