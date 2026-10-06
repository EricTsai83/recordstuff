import { useEffect, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { SettingsZoom, SettingsZoomRequest } from "../../shared/settings-panel";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import * as model from "./settings-controller";

/** Main reports the applied factor; this notice never predicts or applies zoom itself. */
export function ZoomToast() {
  const [notice, setNotice] = useState<{ zoom: SettingsZoom }>();
  const [pointer, setPointer] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => window.settings.onZoomChanged?.((zoom) => {
    setFailed(false);
    setNotice({ zoom });
  }), []);
  useEffect(() => {
    if (!notice || pointer || focused) return;
    const timer = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(timer);
  }, [notice, pointer, focused]);
  const dismiss = () => {
    if (card.current?.contains(document.activeElement))
      document.getElementById(`tab-${model.selectedTab}`)?.focus();
    setNotice(undefined);
    setPointer(false);
    setFocused(false);
  };
  const change = (request: SettingsZoomRequest) => {
    void window.settings.zoom?.(request).catch(() => setFailed(true));
  };
  if (!notice) return null;
  const { zoom } = notice;
  return (
    <Card ref={card} id="zoom-toast" className="zoom-toast gap-2.5 bg-popover p-3 shadow-toast ring-0"
      onMouseOver={() => setPointer(true)}
      onMouseOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPointer(false); }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
      }}>
      <p className="zoom-toast-value" role="status" aria-live="polite">
        {model.text("Zoom")} <strong>{Math.round(zoom.factor * 100)}%</strong>
      </p>
      <div className="zoom-toast-controls" role="group" aria-label={model.text("Zoom")}>
        <Button variant="outline" size="icon-sm" aria-label={model.text("Zoom Out")}
          disabled={!zoom.canZoomOut} onClick={() => change("out")}><Minus /></Button>
        <Button variant="outline" size="icon-sm" aria-label={model.text("Zoom In")}
          disabled={!zoom.canZoomIn} onClick={() => change("in")}><Plus /></Button>
        <Button variant="outline" size="sm" onClick={() => change("reset")}>{model.text("Reset")}</Button>
        <Button variant="ghost" size="icon-sm" aria-label={model.text("Close")} onClick={dismiss}><X /></Button>
      </div>
      {failed && <p role="alert">{model.text("Could not complete this action. Try again.")}</p>}
    </Card>
  );
}
