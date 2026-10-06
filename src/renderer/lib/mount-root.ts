import { createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const lifecycle = Symbol.for("recordstuff.renderer.dispose");
/** One root and one disposal path for each renderer, including module reloads in tests. */
export function mountRoot(component: ComponentType): void {
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
  flushSync(() => root.render(createElement(component)));
  window.addEventListener("pagehide", dispose, { once: true });
}
