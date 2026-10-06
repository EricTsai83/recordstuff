import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { SettingsZoom, SettingsZoomRequest } from "../../shared/settings-panel";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import * as model from "./settings-controller";

// Use Chromium's close delays; after a button press, passive hover/focus must not hold the notice open.
const DEFAULT_CLOSE_DELAY = 1500;
const BUTTON_CLOSE_DELAY = 5000;

/** Main reports the applied factor; this notice never predicts or applies zoom itself. */
export function ZoomToast() {
  const [notice, setNotice] = useState<{ zoom: SettingsZoom; interacted: boolean }>();
  const [pointer, setPointer] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => window.settings.onZoomChanged?.((zoom) => {
    setFailed(false);
    setNotice((current) => ({ zoom, interacted: current?.interacted ?? false }));
  }), []);
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
    const timer = setTimeout(dismiss, notice.interacted ? BUTTON_CLOSE_DELAY : DEFAULT_CLOSE_DELAY);
    return () => clearTimeout(timer);
  }, [notice, paused, dismiss]);
  const change = (request: SettingsZoomRequest) => {
    // Restart even when Reset or a capped zoom request emits no applied-factor change.
    setNotice((current) => current && ({ ...current, interacted: true }));
    void window.settings.zoom?.(request).catch(() => setFailed(true));
  };
  if (!notice) return null;
  const { zoom } = notice;
  return (
    <Card ref={card} id="zoom-toast" className="zoom-toast gap-2 bg-popover p-2.5 text-popover-foreground shadow-toast"
      onMouseOver={() => setPointer(true)}
      onMouseOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPointer(false); }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
      }}>
      <div className="zoom-toast-row">
        <p className="zoom-toast-value" role="status" aria-live="polite">
          <span className="sr-only">{model.text("Zoom")} </span><strong>{Math.round(zoom.factor * 100)}%</strong>
        </p>
        <div className="zoom-toast-controls" role="group" aria-label={model.text("Zoom")}>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={model.text("Zoom Out")}
            disabled={!zoom.canZoomOut} onClick={() => change("out")}><Minus /></Button>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={model.text("Zoom In")}
            disabled={!zoom.canZoomIn} onClick={() => change("in")}><Plus /></Button>
          <Button variant="outline" className="ml-1 rounded-full px-3" onClick={() => change("reset")}>{model.text("Reset")}</Button>
        </div>
      </div>
      {failed && <p role="alert" className="max-w-60 text-destructive">{model.text("Could not complete this action. Try again.")}</p>}
    </Card>
  );
}
