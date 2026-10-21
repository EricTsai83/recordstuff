/**
 * A recording's elapsed time, counted on the page from its start, beside the Recording Studio's Stop.
 */
import { useEffect, useState } from "react";
import { translate } from "../../../../shared/i18n";
import * as model from "../../settings-controller";

/** The recording's elapsed time beside the Recording Studio's Stop (plan 075, D19), counted here from its start. */
export function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Once a second, just after each second the recording has lasted: the page composes a frame only when it changes.
    let timer: ReturnType<typeof setTimeout>;
    const next = (): void => {
      const lasted = Date.now() - start;
      timer = setTimeout(() => { setNow(Date.now()); next(); }, Number.isFinite(lasted) ? 1000 - (((lasted % 1000) + 1000) % 1000) + 5 : 1000);
    };
    next();
    return () => clearTimeout(timer);
  }, [start]);
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <span className="studio-elapsed" role="timer" aria-label={translate("Elapsed {time}", model.view?.language, { time: text })}>{text}</span>;
}
