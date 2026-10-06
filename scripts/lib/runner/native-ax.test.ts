import { expect, it } from "vitest";
import { judgeAppMenu, judgeWindowLayout, type AppMenu, type WindowLayout } from "./native-ax.mts";

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
  expect(judgeAppMenu(withView).bound).toEqual(["⌘R (Reload)", "⌥⌘I (Developer Tools)"]);
});

it("requires ⌘ alone for copy, select all, minimize and quit, so Lock Screen's ⌃⌘Q does not count as Quit", () => {
  const noEdit = MINIMAL.filter(menu => menu.title !== "Edit" && menu.title !== "RecordStuff");
  expect(judgeAppMenu(noEdit).missing).toEqual(["⌘C", "⌘A", "⌘Q"]);
  // Settings has no field to paste into, so a menu without Paste still passes.
  expect(judgeAppMenu([{ title: "Edit", items: [item("Copy", "c"), item("Select All", "a")] }, ...MINIMAL.slice(1, 2), ...MINIMAL.slice(3)])).toEqual({ bound: [], missing: [] });
});

/** The Settings window as `layout` read it on 2026-10-04 (macOS 26, Electron 44, a display left of the primary one). */
const SETTINGS: WindowLayout = {
  frame: { x: -1018, y: 532, width: 957, height: 592 },
  controls: [0, 1, 2].map(i => ({ name: ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"][i]!, frame: { x: -1001 + i * 23, y: 549, width: 16, height: 16 } })),
  webArea: { x: -1018, y: 532, width: 957, height: 592 }, clickable: [], visited: 20, truncated: false,
};
const ZONE = { width: 86, height: 40 };

it("passes a hidden-inset window whose controls sit in their zone with nothing clickable under them", () => {
  expect(judgeWindowLayout(SETTINGS, ZONE)).toEqual([]);
});

it("names a title bar above the page, a control outside its zone, a missing control and a clickable element under them", () => {
  const problems = judgeWindowLayout({ ...SETTINGS,
    webArea: { x: -1018, y: 560, width: 957, height: 564 },
    controls: [{ name: "AXCloseButton", frame: { x: -928, y: 549, width: 16, height: 16 } }, { name: "AXZoomButton", frame: undefined }],
    clickable: [{ role: "AXRadioButton", title: "Recordings", frame: { x: -1008, y: 540, width: 60, height: 24 } }] }, ZONE);
  expect(problems).toEqual([
    "the web content starts 28 pt below the window's top (a title bar?)",
    "AXCloseButton at 90,17 16×16 lies outside the 86×40 zone",
    "AXZoomButton not found",
    'AXRadioButton "Recordings" at 10,8 lies under the window controls',
  ]);
  expect(judgeWindowLayout({ ...SETTINGS, webArea: null }, ZONE)).toContain("no web content found in the window");
  // A scan cut short is no pass: what it did not reach was never judged.
  expect(judgeWindowLayout({ ...SETTINGS, visited: 20000, truncated: true }, ZONE))
    .toEqual(["the page's accessibility tree was read only in part (20000 elements): nothing past them was checked"]);
});
