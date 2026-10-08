/** Sonner owns placement and presence; the hook owns zoom and its interaction deadlines. */
import { useCallback, useEffect, useId, useRef, type RefObject } from "react";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import type {
  SettingsZoom,
  SettingsZoomRequest,
} from "../../shared/settings-panel";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Toaster } from "../components/ui/sonner";
import { useZoomNotice } from "./use-zoom-notice";
import * as model from "./settings-controller";

export function ZoomToast() {
  const instance = useId();
  const { notice, failed, card, dismiss, change, setPointer, setFocused } =
    useZoomNotice();
  const shown = useRef<string | undefined>(undefined),
    sequence = useRef(0);
  useEffect(() => {
    if (notice) {
      shown.current ??= `recordstuff-zoom-${instance}-${++sequence.current}`;
      toast.custom(
        () => (
          <ZoomNotice
            zoom={notice.zoom}
            failed={failed}
            card={card}
            dismiss={dismiss}
            change={change}
            holdPointer={setPointer}
            holdFocus={setFocused}
          />
        ),
        {
          id: shown.current,
          toasterId: "recordstuff-zoom",
          duration: Infinity,
          dismissible: false,
          className: "zoom-notice",
          style: { width: "max-content", maxWidth: "calc(100vw - 32px)" },
        },
      );
    } else if (shown.current) {
      // The departing copy stays for Sonner's exit animation, but cannot receive another operation.
      const item = card.current?.closest<HTMLElement>("[data-sonner-toast]");
      if (item) item.inert = true;
      toast.dismiss(shown.current);
      shown.current = undefined;
    }
  }, [notice, failed, card, dismiss, change, setPointer, setFocused, instance]);
  useEffect(
    () => () => {
      if (shown.current) toast.dismiss(shown.current);
    },
    [],
  );
  return (
    <Toaster
      id="recordstuff-zoom"
      position="top-right"
      offset={16}
      mobileOffset={16}
      hotkey={[]}
      visibleToasts={1}
      style={{ zIndex: 60 }}
      ref={(node) => {
        node?.setAttribute("aria-live", "off");
      }}
    />
  );
}

function ZoomNotice({
  zoom,
  failed,
  card,
  dismiss,
  change,
  holdPointer,
  holdFocus,
}: {
  zoom: SettingsZoom;
  failed: boolean;
  card: RefObject<HTMLDivElement | null>;
  dismiss: () => void;
  change: (request: SettingsZoomRequest) => void;
  holdPointer: (held: boolean) => void;
  holdFocus: (held: boolean) => void;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      // Removing a departing toast must not detach the newer toast's focus owner.
      if (node) card.current = node;
      else if (card.current === own.current) card.current = null;
      own.current = node;
    },
    [card],
  );
  return (
    <Card
      ref={attach}
      className="zoom-toast gap-2 bg-popover p-2.5 text-popover-foreground shadow-md"
      onMouseOver={() => holdPointer(true)}
      onMouseOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          holdPointer(false);
      }}
      onFocusCapture={(event) => {
        event.stopPropagation();
        holdFocus(true);
      }}
      onBlurCapture={(event) => {
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget))
          holdFocus(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="zoom-toast-row">
        <p className="zoom-toast-value" role="status" aria-live="polite">
          <span className="sr-only">{model.text("Zoom")} </span>
          <strong>{Math.round(zoom.factor * 100)}%</strong>
        </p>
        {/* At 80% or 150% the step that went there stops, but keeps the focus it has, so Escape still reaches the card. */}
        <div
          className="zoom-toast-controls"
          role="group"
          aria-label={model.text("Zoom")}
        >
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full data-disabled:pointer-events-none data-disabled:opacity-50"
            aria-label={model.text("Zoom Out")}
            disabled={!zoom.canZoomOut}
            focusableWhenDisabled
            onClick={() => change("out")}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full data-disabled:pointer-events-none data-disabled:opacity-50"
            aria-label={model.text("Zoom In")}
            disabled={!zoom.canZoomIn}
            focusableWhenDisabled
            onClick={() => change("in")}
          >
            <Plus />
          </Button>
          <Button
            variant="outline"
            className="ml-1 rounded-full px-3"
            onClick={() => change("reset")}
          >
            {model.text("Reset")}
          </Button>
        </div>
      </div>
      {failed && (
        <p role="alert" className="max-w-60 text-destructive-ink">
          {model.text("Could not complete this action. Try again.")}
        </p>
      )}
    </Card>
  );
}
