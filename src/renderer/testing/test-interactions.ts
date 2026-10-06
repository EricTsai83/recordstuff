/** Browser input sequences for renderer tests; React commits are flushed before assertions. */
import { vi } from "vitest";
import { flushSync } from "react-dom";
export function click(element: HTMLElement): void {
  flushSync(() => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        bubbles: true,
        pointerType: "mouse",
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true }),
    );
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        bubbles: true,
        pointerType: "mouse",
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mouseup", { button: 0, bubbles: true }),
    );
    if (element.getAttribute("aria-haspopup") !== "menu") element.click();
  });
}
export function enter(input: HTMLInputElement, value: string): void {
  flushSync(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Opens a card's menu and waits until it holds focus as well: Base UI marks the menu open first and moves focus
 * into it on a later frame, so a keystroke or a focus check right after `data-open` could still land on the button.
 */
export async function menu(element: HTMLElement): Promise<void> {
  click(element);
  await vi.waitFor(() => {
    const opened = document.getElementById("clip-menu");
    if (!opened?.hasAttribute("data-open"))
      throw new Error("Menu has not opened");
    if (!opened.contains(document.activeElement))
      throw new Error("Menu has not taken focus");
  });
}

/** The value a settings menu (shadcn Select) shows: its trigger carries it as data-value. */
export const menuValue = (id: string): string | undefined =>
  document.getElementById(id)?.dataset.value;

/** Chooses `value` in a settings menu as the pointer does: opens it, then clicks the item. */
export async function pick(id: string, value: string): Promise<void> {
  const trigger = document.getElementById(id)!;
  click(trigger);
  const item = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-slot="select-item"][data-value="${value}"]`,
    );
    if (!found) throw new Error(`${id} has no item ${value} open`);
    return found;
  });
  click(item);
  await vi.waitFor(() => {
    if (document.querySelector('[data-slot="select-content"][data-open]'))
      throw new Error(`${id} is still open`);
  });
}
