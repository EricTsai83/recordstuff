/**
 * RecordStuff's windows out of a native recording on Windows (plan 076, step 3). Windows.Graphics.Capture records the
 * whole display and cannot leave out another process's windows, so main marks its own: `setContentProtection(true)`
 * is `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` there, which leaves the window out of every capture (shown as
 * black before Windows 10 2004). Windows opened while excluded, such as the countdown, are marked as they appear, and
 * all of them are let back in when the attempt ends, so screenshots of Settings work between recordings.
 */
export interface Protectable {
  isDestroyed(): boolean;
  setContentProtection(enable: boolean): void;
}

export interface ExclusionDeps<W extends Protectable> {
  windows: () => W[];
  /** Calls `listener` for each window created from now on; returns what stops that. */
  onCreated: (listener: (window: W) => void) => () => void;
}

export function captureExclusion<W extends Protectable>(deps: ExclusionDeps<W>): (excluded: boolean) => void {
  let stopListening: (() => void) | undefined;
  const marked = new Set<W>();
  const mark = (window: W): void => {
    if (window.isDestroyed()) return;
    window.setContentProtection(true);
    marked.add(window);
  };
  return (excluded) => {
    if (excluded) {
      if (stopListening) return;
      stopListening = deps.onCreated(mark);
      for (const window of deps.windows()) mark(window);
      return;
    }
    stopListening?.();
    stopListening = undefined;
    for (const window of marked) if (!window.isDestroyed()) window.setContentProtection(false);
    marked.clear();
  };
}
