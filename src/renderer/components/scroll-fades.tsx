import { useLayoutEffect, useRef, type RefObject } from "react";

const TOP_SIZE = 30;
const BOTTOM_SIZE = 38;

/** Shared scroll-edge blur. Opacity follows distance; updates stay out of the page's render tree. */
export function ScrollFades({
  scrollRef,
  contentRevision,
  topId,
  bottomId,
  clear = 120,
  topSize: topMax = TOP_SIZE,
  bottomSize: bottomMax = BOTTOM_SIZE,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRevision?: unknown;
  topId?: string;
  bottomId?: string;
  /** The reading room kept clear between the fades, in CSS pixels; a small scroll area (Share…'s files) keeps less. */
  clear?: number;
  topSize?: number;
  bottomSize?: number;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sizes = useRef({ clear, topMax, bottomMax });
  sizes.current = { clear, topMax, bottomMax };
  /** One observer and scroll listener for the scroll node's life; a new revision only re-syncs the observed children. */
  const watch = useRef<{ node: HTMLElement; observer: ResizeObserver; children: Set<Element>; update: () => void } | undefined>(undefined);
  const stop = (): void => {
    const current = watch.current;
    if (!current) return;
    current.observer.disconnect();
    current.node.removeEventListener("scroll", current.update);
    watch.current = undefined;
  };
  useLayoutEffect(() => stop, []);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (watch.current?.node !== node) stop();
    if (!node) return;
    if (!watch.current) {
      const update = (): void => {
        // Leave `clear` CSS pixels (120 for a page) between the fades. A short or zoomed window needs its
        // small reading area more than it needs a scroll cue; below that height, omit the blur entirely.
        const { clear, topMax, bottomMax } = sizes.current;
        const available = Math.max(0, (node.clientHeight - clear) / 2);
        const topSize = Math.min(topMax, available), bottomSize = Math.min(bottomMax, available);
        const amount = (distance: number, size: number): number => {
          if (size === 0) return 0;
          // Start fading two blur heights from the edge so the visual transition approaches zero before the endpoint.
          const progress = Math.max(0, Math.min(1, distance / (size * 2)));
          return progress * progress * (3 - 2 * progress);
        };
        const top = amount(node.scrollTop, topSize);
        const bottom = amount(node.scrollHeight - node.clientHeight - node.scrollTop, bottomSize);
        if (topRef.current) {
          topRef.current.style.height = `${topSize}px`;
          topRef.current.style.opacity = String(top);
        }
        if (bottomRef.current) {
          bottomRef.current.style.height = `${bottomSize}px`;
          bottomRef.current.style.opacity = String(bottom);
        }
      };
      const observer = new ResizeObserver(update);
      observer.observe(node);
      node.addEventListener("scroll", update, { passive: true });
      watch.current = { node, observer, children: new Set(), update };
    }
    // The content's own size changes reach the observer; a revision can add or remove the children it watches.
    const { observer, children, update } = watch.current;
    const present = new Set(node.children);
    for (const child of children) if (!present.has(child)) { observer.unobserve(child); children.delete(child); }
    for (const child of present) if (!children.has(child)) { observer.observe(child); children.add(child); }
    update();
  }, [scrollRef, contentRevision]);
  return <>
    <div ref={topRef} id={topId} className="scroll-hint scroll-hint-top" aria-hidden="true" style={{ height: topMax, opacity: 0 }} />
    <div ref={bottomRef} id={bottomId} className="scroll-hint" aria-hidden="true" style={{ height: bottomMax, opacity: 0 }} />
  </>;
}
