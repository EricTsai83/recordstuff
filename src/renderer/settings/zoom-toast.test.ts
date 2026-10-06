// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsZoom } from "../../shared/settings-panel";

it("refreshes the notice on repeated zoom, dismisses it after five seconds, and cleans up its subscription", async () => {
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
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
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
    await advance(4900);
    await emit(1.25);
    await advance(4900);
    expect(document.getElementById("zoom-toast")?.textContent).toContain("125%");
    await advance(200);
    expect(document.getElementById("zoom-toast")).toBeNull();
    await act(async () => root.unmount());
    unmount = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { unmount?.(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
