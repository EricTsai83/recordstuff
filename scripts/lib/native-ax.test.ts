import { expect, it } from "vitest";
import { judgeAppMenu, type AppMenu } from "./native-ax.mts";

const item = (title: string, cmdChar = "", cmdModifiers = 0) => ({ title, cmdChar, cmdModifiers });
/** RecordStuff's menu bar as AX reads it: the system Apple menu, then App, Edit and Window. */
const MINIMAL: AppMenu[] = [
  { title: "Apple", items: [item("Force Quit…", "\u001b", 2), item("Lock Screen", "Q", 4)] },
  { title: "RecordStuff", items: [item("Hide RecordStuff", "H"), item("Quit RecordStuff", "Q")] },
  { title: "Edit", items: [item("Copy", "C"), item("Paste", "V"), item("Paste and Match Style", "V", 3), item("Select All", "A")] },
  { title: "Window", items: [item("Minimize", "M"), item("Zoom")] },
];

it("passes the minimal menu and names Electron's default Reload and Developer Tools shortcuts", () => {
  expect(judgeAppMenu(MINIMAL)).toEqual({ bound: [], missing: [] });
  const withView = [...MINIMAL, { title: "View", items: [item("Reload", "R"), item("Force Reload", "R", 1), item("Toggle Developer Tools", "I", 2)] }];
  expect(judgeAppMenu(withView).bound).toEqual(["⌘R (Reload)", "⌘⌥I (Developer Tools)"]);
});

it("requires ⌘ alone for copy, select all, minimize and quit, so Lock Screen's ⌃⌘Q does not count as Quit", () => {
  const noEdit = MINIMAL.filter(menu => menu.title !== "Edit" && menu.title !== "RecordStuff");
  expect(judgeAppMenu(noEdit).missing).toEqual(["⌘C", "⌘A", "⌘Q"]);
  // Settings has no field to paste into, so a menu without Paste still passes.
  expect(judgeAppMenu([{ title: "Edit", items: [item("Copy", "c"), item("Select All", "a")] }, ...MINIMAL.slice(1, 2), ...MINIMAL.slice(3)])).toEqual({ bound: [], missing: [] });
});
