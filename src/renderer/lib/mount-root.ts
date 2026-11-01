import { Component, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import { flushSync } from "react-dom";
import { translate } from "../../shared/i18n";

const lifecycle = Symbol.for("recordstuff.renderer.dispose");
/** The line every icon draws, in screen pixels. */
export const ICON_STROKE = 1.5;

/** What a window shows when it cannot draw: the load failure's own words, or nothing for a window over the screen. */
export type RootFallback = "message" | "none";

/** The page's language as its app last set it on `<html lang>`, for text drawn without the app. */
function pageLanguage(): "en" | "zh-TW" {
  return document.documentElement.lang.startsWith("zh") ? "zh-TW" : "en";
}

/**
 * Catches what any part of the page throws while it draws. Without it React unmounts the whole root and the window
 * goes blank with nothing said; with it the window says it could not load, as a failed start does. React reports the
 * error to the console itself.
 */
class RootBoundary extends Component<{ fallback: RootFallback; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback === "none") return null;
    return createElement("p", { className: "startup-error", role: "alert" },
      translate("This window could not load. Close it and open RecordStuff again.", pageLanguage()));
  }
}

/** One root and one disposal path for each renderer, including module reloads in tests. */
export function mountRoot(component: ComponentType, { fallback = "message" }: { fallback?: RootFallback } = {}): void {
  const owner = document as Document & { [lifecycle]?: () => void };
  owner[lifecycle]?.();
  const element = document.getElementById("root");
  if (!element) throw new Error("Renderer root is missing");
  const root = createRoot(element);
  const dispose = (): void => {
    window.removeEventListener("pagehide", dispose);
    root.unmount();
    if (owner[lifecycle] === dispose) delete owner[lifecycle];
  };
  owner[lifecycle] = dispose;
  // Every icon draws one line weight on screen, whatever its size (2026-11-01, at the maintainer's request: Lucide scales
  // its 2-unit stroke with the icon, so a 24 px stage button drew twice the line of a 14 px toolbar one).
  flushSync(() =>
    root.render(createElement(RootBoundary, { fallback }, createElement(LucideProvider, { nonScalingStroke: true, strokeWidth: ICON_STROKE, children: createElement(component) }))),
  );
  window.addEventListener("pagehide", dispose, { once: true });
}
