/**
 * The outline that marks where a jump landed (a notification's recording card, the Shortcut row reached from the
 * Keyboard Shortcuts tab): ui.css draws `.arrived::after` in the primary accent, which then fades. A second jump
 * restarts it; the class goes when the outline has faded.
 */
export function flashArrival(element: HTMLElement | null): void {
  if (!element) return;
  element.classList.remove("arrived");
  void element.offsetWidth;
  element.classList.add("arrived");
  const done = (event: AnimationEvent): void => {
    // A child's own animation ending (a spinner, the listening dots) bubbles here too.
    if (event.target !== element || event.animationName !== "arrival") return;
    clearArrival(element);
  };
  element.addEventListener("animationend", done);
  listeners.set(element, done);
}

/** Takes the outline off at once, as when the element it marks loses focus. */
export function clearArrival(element: HTMLElement): void {
  element.classList.remove("arrived");
  const done = listeners.get(element);
  if (done) element.removeEventListener("animationend", done);
  listeners.delete(element);
}

const listeners = new WeakMap<HTMLElement, (event: AnimationEvent) => void>();
