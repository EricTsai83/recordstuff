import { useLayoutEffect, useRef, type RefObject } from "react";

const TOP_SIZE = 30;
const BOTTOM_SIZE = 38;

/** Shared scroll-edge blur. Opacity follows distance; updates stay out of the page's render tree. */
export function ScrollFades({
  scrollRef,
  contentRevision,
  topId,
  bottomId,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRevision?: unknown;
  topId?: string;
  bottomId?: string;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = (): void => {
      // Leave at least 120 CSS pixels clear between the fades. A short or zoomed window needs its
      // small reading area more than it needs a scroll cue; below that height, omit the blur entirely.
      const available = Math.max(0, (node.clientHeight - 120) / 2);
      const topSize = Math.min(TOP_SIZE, available), bottomSize = Math.min(BOTTOM_SIZE, available);
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
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    node.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, [scrollRef, contentRevision]);
  return <>
    <div ref={topRef} id={topId} className="scroll-hint scroll-hint-top" aria-hidden="true" style={{ height: TOP_SIZE, opacity: 0 }} />
    <div ref={bottomRef} id={bottomId} className="scroll-hint" aria-hidden="true" style={{ height: BOTTOM_SIZE, opacity: 0 }} />
  </>;
}
