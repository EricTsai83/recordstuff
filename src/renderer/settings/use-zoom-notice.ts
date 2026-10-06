/** Owns applied zoom, the existing dismissal deadlines, IPC and focus restoration. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SettingsZoom,
  SettingsZoomRequest,
} from "../../shared/settings-panel";
import * as model from "./settings-controller";

// Use Chromium's close delays; after a button press, passive hover/focus must not hold the notice open.
const DEFAULT_CLOSE_DELAY = 1500;
const BUTTON_CLOSE_DELAY = 5000;

/** Main reports the applied factor; this notice never predicts or applies zoom itself. */
export function useZoomNotice() {
  const [notice, setNotice] = useState<{
    zoom: SettingsZoom;
    interacted: boolean;
  }>();
  const [pointer, setPointer] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      window.settings.onZoomChanged?.((zoom) => {
        setFailed(false);
        setNotice((current) => ({
          zoom,
          interacted: current?.interacted ?? false,
        }));
      }),
    [],
  );
  const dismiss = useCallback(() => {
    if (card.current?.contains(document.activeElement))
      document.getElementById(`tab-${model.selectedTab}`)?.focus();
    setNotice(undefined);
    setPointer(false);
    setFocused(false);
  }, []);
  const paused = Boolean(notice && !notice.interacted && (pointer || focused));
  useEffect(() => {
    if (!notice || paused) return;
    const timer = setTimeout(
      dismiss,
      notice.interacted ? BUTTON_CLOSE_DELAY : DEFAULT_CLOSE_DELAY,
    );
    return () => clearTimeout(timer);
  }, [notice, paused, dismiss]);
  const change = useCallback((request: SettingsZoomRequest) => {
    // Restart even when Reset or a capped zoom request emits no applied-factor change.
    setNotice((current) => current && { ...current, interacted: true });
    void window.settings.zoom?.(request).catch(() => setFailed(true));
  }, []);
  return { notice, failed, card, dismiss, change, setPointer, setFocused };
}
