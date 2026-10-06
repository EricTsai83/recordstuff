// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsZoom } from "../../shared/settings-panel";

it("refreshes repeated zoom, closes after 1.5 s or 5 s after a button, and cleans up its subscription", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let unmount: (() => void) | undefined;
  try {
    document.body.innerHTML = '<button id="tab-library">Recordings</button><div id="root"></div>';
    const unsubscribe = vi.fn();
    let notify!: (zoom: SettingsZoom) => void;
    window.settings = { read: vi.fn(), capture: vi.fn(), choose: vi.fn(), ready: vi.fn(), onChanged: () => () => {},
      zoom: vi.fn(async () => {}), onZoomChanged: (callback) => { notify = callback; return unsubscribe; } };
    const { createRoot } = await import("react-dom/client");
    const { createElement, act } = await import("react");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const advance = async (ms: number) => {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      // Sonner publishes its presence updates asynchronously after the hook's deadline effect.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    };
    const { ZoomToast } = await import("./zoom-toast");
    const root = createRoot(document.getElementById("root")!);
    unmount = () => root.unmount();
    await act(async () => root.render(createElement(ZoomToast)));
    await advance(0);
    const emit = async (factor: number) => {
      await act(async () => notify({ factor, canZoomIn: factor < 1.5, canZoomOut: factor > 0.8 }));
      await advance(0);
    };
    await emit(1.1);
    await advance(1400);
    await emit(1.25);
    await advance(1499);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')?.textContent).toContain("125%");
    await advance(1);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).toBeNull();
    await emit(1.1);
    const zoomIn = document.querySelector<HTMLButtonElement>('.zoom-notice:not([data-removed="true"]) .zoom-toast button[aria-label="Zoom In"]')!;
    await act(async () => {
      zoomIn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      zoomIn.focus();
      zoomIn.click();
    });
    expect(window.settings.zoom).toHaveBeenCalledWith("in");
    await emit(1.25);
    await advance(4999);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')?.textContent).toContain("125%");
    await advance(1);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).toBeNull();
    expect(document.activeElement?.id).toBe("tab-library");
    // Passive pointer/focus transitions cannot extend the last button operation's deadline.
    await emit(1);
    const reset = document.querySelectorAll<HTMLButtonElement>('.zoom-notice:not([data-removed="true"]) .zoom-toast button')[2]!;
    await act(async () => { reset.focus(); reset.click(); });
    await advance(2500);
    await act(async () => {
      document.getElementById("tab-library")!.focus();
      reset.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await advance(2499);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).not.toBeNull();
    await advance(1);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).toBeNull();
    // Repeated Reset counts as activity even without a new applied-factor notification.
    await emit(1);
    const sameReset = document.querySelectorAll<HTMLButtonElement>('.zoom-notice:not([data-removed="true"]) .zoom-toast button')[2]!;
    await act(async () => sameReset.click());
    await advance(4900);
    await act(async () => sameReset.click());
    await advance(4999);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).not.toBeNull();
    await advance(1);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).toBeNull();
    // A new notice starts with the short delay again after the interacted one disappears.
    await emit(1.1);
    await advance(1499);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).not.toBeNull();
    await advance(1);
    expect(document.querySelector('[data-sonner-toast]:not([data-removed="true"]) .zoom-toast')).toBeNull();
    await act(async () => root.unmount());
    unmount = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { unmount?.(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
