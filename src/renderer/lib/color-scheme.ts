import { useLayoutEffect } from "react";

/**
 * Keeps `.dark` on <html> in step with the appearance main applies (System follows the OS), before the page paints.
 * The colour tokens' dark values and the `dark:` utilities both key on it (plan 069).
 */
export function useDarkClass(): void {
  useLayoutEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)"),
      apply = (): void => {
        const root = document.documentElement;
        if (root.classList.contains("dark") === query.matches) return;
        root.setAttribute("data-theme-changing", "");
        try {
          root.classList.toggle("dark", query.matches);
          // Commit the new palette with transitions disabled before restoring hover/press feedback.
          // A synchronous style/layout flush also works in hidden windows, without a frame or timer to clean up.
          void root.offsetHeight;
        } finally {
          root.removeAttribute("data-theme-changing");
        }
      };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}
