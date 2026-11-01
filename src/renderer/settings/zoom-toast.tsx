/** Base UI owns placement and presence (2026-11-01; Sonner before); the hook owns zoom and its interaction deadlines. */
import { useCallback, useEffect, useId, useRef, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import type {
  SettingsZoom,
  SettingsZoomRequest,
} from "../../shared/settings-panel";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Toast, ToastPortal, ToastProvider, ToastViewport, createToastManager, useToastManager } from "../components/ui/toast";
import { useZoomNotice } from "./use-zoom-notice";
import * as model from "./settings-controller";

const zoomToasts = createToastManager();

export function ZoomToast() {
  const instance = useId();
  const zoom = useZoomNotice();
  const { notice } = zoom;
  const shown = useRef<string | undefined>(undefined),
    sequence = useRef(0);
  useEffect(() => {
    if (notice) {
      if (!shown.current) {
        shown.current = `recordstuff-zoom-${instance}-${++sequence.current}`;
        zoomToasts.add({ id: shown.current, timeout: 0 });
      }
    } else if (shown.current) {
      zoomToasts.close(shown.current);
      shown.current = undefined;
    }
  }, [notice, instance]);
  useEffect(
    () => () => {
      if (shown.current) zoomToasts.close(shown.current);
    },
    [],
  );
  return (
    <ToastProvider toastManager={zoomToasts} limit={1}>
      <ToastPortal>
        <ToastViewport aria-live="off" aria-label={model.text("Zoom")} className="inset-x-auto top-4 right-4 bottom-auto left-auto z-60 w-max sm:right-4 sm:w-max">
          <ZoomToasts zoom={zoom} />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

/** The notice, from the top: the live one draws the hook's state; a departing copy keeps its last and takes no input. */
function ZoomToasts({ zoom }: { zoom: ReturnType<typeof useZoomNotice> }) {
  const { toasts } = useToastManager();
  const last = useRef(zoom.notice);
  if (zoom.notice) last.current = zoom.notice;
  return toasts.map((item) => {
    const leaving = item.transitionStatus === "ending";
    const notice = leaving ? last.current : zoom.notice ?? last.current;
    if (!notice) return null;
    return (
      <Toast
        key={item.id}
        toast={item}
        className="zoom-notice top-0 bottom-auto w-max max-w-[calc(100vw-32px)] origin-top border-0 bg-transparent shadow-none data-starting-style:[transform:translateY(-150%)] [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(-150%)]"
        inert={leaving || undefined}
      >
        <ZoomNotice
          zoom={notice.zoom}
          failed={zoom.failed}
          card={zoom.card}
          dismiss={zoom.dismiss}
          change={zoom.change}
          holdPointer={zoom.setPointer}
          holdFocus={zoom.setFocused}
        />
      </Toast>
    );
  });
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
        <p className="m-0 min-w-14 pl-1 text-xs tabular-nums" role="status" aria-live="polite">
          <span className="sr-only">{model.text("Zoom")} </span>
          <strong>{Math.round(zoom.factor * 100)}%</strong>
        </p>
        {/* At 80% or 150% the step that went there stops, but keeps the focus it has, so Escape still reaches the card. */}
        <div
          className="flex items-center gap-1.5"
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
