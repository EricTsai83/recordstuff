import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
  createCountdownState,
  noticeRequested,
  overlayStyle,
  playTick,
  soundRequested,
  type CountdownFrame,
} from "./countdown-state";

export function CountdownFaces({ frame, notice }: { frame: CountdownFrame; notice?: string | undefined }) {
  return (
    <div id="stage" role="timer" className={`${frame.visible ? "visible" : ""}${notice ? " with-notice" : ""}`}>
      <div className="digit">
        {frame.faces.map((digit, index) => (
          <span
            key={index}
            className={`face${index === frame.front && digit ? " front" : ""}`}
          >
            {digit}
          </span>
        ))}
      </div>
      {/* What the recording starts without (plan 097), so it can still be cancelled; fixed when the page loads. */}
      {notice && <p className="notice">{notice}</p>}
    </div>
  );
}
export function CountdownApp() {
  const [frame, setFrame] = useState<CountdownFrame>({
    faces: ["", ""],
    front: 0,
    shown: undefined,
    visible: false,
  });
  useEffect(() => {
    for (const [name, value] of Object.entries(overlayStyle()))
      document.documentElement.style.setProperty(name, value);
    let context: AudioContext | undefined;
    try {
      if (soundRequested(location.search)) context = new AudioContext();
    } catch {
      /* The overlay also works silently. */
    }
    const update = createCountdownState(
      context
        ? (digit) => {
            try {
              if (context.state === "suspended")
                void context.resume().catch(() => {});
              playTick(context, digit);
            } catch {
              /* Audio failure never interrupts the digit. */
            }
          }
        : undefined,
    );
    const unsubscribe = window.countdown?.onValue((value) => {
      flushSync(() => setFrame(update(value)));
    });
    return () => {
      unsubscribe?.();
      void context?.close().catch(() => {});
    };
  }, []);
  return <CountdownFaces frame={frame} notice={noticeRequested(location.search)} />;
}
