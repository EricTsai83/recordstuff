import { useLayoutEffect } from "react";

/**
 * Keeps `.dark` on <html> in step with the appearance main applies (System follows the OS), before the page paints.
 * The colour tokens' dark values and the `dark:` utilities both key on it (plan 069).
 */
export function useDarkClass(): void {
  useLayoutEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)"),
      apply = (): void => {
        document.documentElement.classList.toggle("dark", query.matches);
      };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}
