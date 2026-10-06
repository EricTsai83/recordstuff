import { useRef, useState } from "react";

/** Measure when the user asks for a hint; no observer runs while the page is idle. */
export function useTruncated<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [truncated, setTruncated] = useState(false);
  const measure = () => {
    const node = ref.current;
    setTruncated(
      Boolean(
        node &&
        (node.scrollHeight > node.clientHeight + 1 ||
          node.scrollWidth > node.clientWidth + 1),
      ),
    );
  };
  return { ref, truncated, measure };
}
