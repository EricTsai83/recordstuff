// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../../shared/settings-panel";
import * as model from "./settings-controller";

it("draws the screens where they stand, chooses one by click or arrow, and follows the primary by a switch that turns off", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "recording", label: "Recording" }],
    groups: [{ id: "screen", label: "Screen", tab: "recording", control: "arrangement", enabled: true, choices: [
      { id: "primary", label: "Primary display · 1920×1080", enabled: true, checked: true },
      { id: "1", label: "Side · 1080×1920", enabled: true, checked: false,
        display: { x: -1080, y: -840, width: 1080, height: 1920, primary: false, name: "Side", pixels: "1080×1920" } },
      { id: "2", label: "Main (Primary) · 1920×1080", enabled: true, checked: false,
        display: { x: 0, y: 0, width: 1920, height: 1080, primary: true, name: "Main", pixels: "1920×1080" } },
    ] }],
  };
  let push!: (view: SettingsView) => void;
  const choose = vi.fn(async (_group: string, choice: string) => {
    current = structuredClone(current);
    current.groups[0]!.choices.forEach((c) => { c.checked = c.id === choice; });
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-recording")).toBeTruthy());
  document.getElementById("tab-recording")!.click();
  await vi.waitFor(() => expect(document.getElementById("setting-screen")).toBeTruthy());
  const radio = (id: string) => document.getElementById(`setting-screen-${id}`) as HTMLButtonElement;

  expect(document.querySelector("#setting-screen [role=radiogroup]")!.contains(radio("1"))).toBe(true);
  expect(radio("primary").getAttribute("role")).toBe("switch");
  // The desk spans 3000×1920 logical pixels: the side screen stands at its left edge and top, the primary below and right.
  expect([radio("1").style.left, radio("1").style.top, radio("1").style.width]).toEqual(["0.000%", "0.000%", "36.000%"]);
  expect([radio("2").style.left, radio("2").style.top, radio("2").style.height]).toEqual(["36.000%", "43.750%", "56.250%"]);
  expect(radio("2").hasAttribute("data-primary")).toBe(true);
  // Following the primary marks the screen that holds the menu bar without checking it, and that screen is the Tab stop.
  expect(radio("primary").getAttribute("aria-checked")).toBe("true");
  expect(radio("primary").labels[0]!.querySelector(".sr-only")!.textContent).toBe("Follow the primary display");
  expect(radio("2").getAttribute("aria-checked")).toBe("false");
  expect(radio("2").hasAttribute("data-following")).toBe(true);
  expect(["1", "2"].map((id) => radio(id).tabIndex)).toEqual([-1, 0]);

  // Turning following off keeps today's primary screen, now chosen for itself; turning it on follows again.
  radio("primary").click();
  await vi.waitFor(() => expect(radio("2").getAttribute("aria-checked")).toBe("true"));
  expect(choose).toHaveBeenLastCalledWith("screen", "2");
  expect(radio("primary").getAttribute("aria-checked")).toBe("false");
  expect(radio("2").hasAttribute("data-following")).toBe(false);
  radio("primary").click();
  await vi.waitFor(() => expect(radio("primary").getAttribute("aria-checked")).toBe("true"));
  expect(choose).toHaveBeenLastCalledWith("screen", "primary");
  choose.mockClear();

  radio("1").click();
  await vi.waitFor(() => expect(radio("1").getAttribute("aria-checked")).toBe("true"));
  expect(choose).toHaveBeenLastCalledWith("screen", "1");
  expect(radio("2").hasAttribute("data-following")).toBe(false);
  expect(["1", "2"].map((id) => radio(id).tabIndex)).toEqual([0, -1]);

  // Choosing the checked screen again saves nothing; an arrow moves to the next screen and chooses it.
  radio("1").click();
  expect(choose).toHaveBeenCalledTimes(1);
  radio("1").focus();
  radio("1").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await vi.waitFor(() => expect(radio("2").getAttribute("aria-checked")).toBe("true"));
  expect(choose).toHaveBeenLastCalledWith("screen", "2");
  expect(document.activeElement).toBe(radio("2"));
  // After the last screen, the arrow wraps to the first; the switch is not one of the screens.
  radio("2").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await vi.waitFor(() => expect(radio("1").getAttribute("aria-checked")).toBe("true"));
  radio("primary").click();
  await vi.waitFor(() => expect(radio("primary").getAttribute("aria-checked")).toBe("true"));

  // Review P2-1: while another screen saves, choosing the committed one again replaces that intent rather than being dropped.
  let release!: () => void;
  choose.mockImplementation(async (_group: string, choice: string) => {
    await new Promise<void>((resolve) => { release = resolve; });
    current = structuredClone(current);
    current.groups[0]!.choices.forEach((c) => { c.checked = c.id === choice; });
    return { view: current, applied: true };
  });
  // Primary is committed: choose screen 2, then Primary again before 2's save returns.
  radio("2").click();
  expect(choose).toHaveBeenLastCalledWith("screen", "2");
  const first = release;
  radio("primary").click();
  expect(choose).toHaveBeenLastCalledWith("screen", "primary");
  first(); release();
  await vi.waitFor(() => expect(model.saving).toBeUndefined());
  expect(radio("primary").getAttribute("aria-checked")).toBe("true");
  expect(radio("2").getAttribute("aria-checked")).toBe("false");
  choose.mockImplementation(async (_group: string, choice: string) => {
    current = structuredClone(current);
    current.groups[0]!.choices.forEach((c) => { c.checked = c.id === choice; });
    return { view: current, applied: true };
  });

  // Review P2-2: with an unavailable screen still chosen, the row's focus target is a screen that can be chosen.
  current = structuredClone(current);
  current.groups[0]!.choices.forEach((c) => { c.checked = false; });
  current.groups[0]!.choices.push({ id: "9", label: "Gone — Unavailable", enabled: false, checked: true });
  push(current);
  await vi.waitFor(() => expect(radio("9").getAttribute("aria-checked")).toBe("true"));
  expect(radio("9").disabled).toBe(true);
  expect(model.groupControl("screen")).toBe(radio("1"));
  expect(model.groupControl("screen", "2")).toBe(radio("2"));
  const calls = choose.mock.calls.length;

  // Locked while recording: nothing can be chosen.
  current = structuredClone(current);
  current.groups[0]!.enabled = false;
  push(current);
  await vi.waitFor(() => expect(radio("1").disabled).toBe(true));
  radio("1").click();
  expect(choose).toHaveBeenCalledTimes(calls);
});
