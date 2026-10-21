import { useState } from "react";

/**
 * Which of a control's saves is the latest, and whether it is still pending. A value equal to the saved one needs no
 * save, unless another save is pending: a step back to the saved value is then the newer intent and must be sent, or
 * the pending value would be kept while the control showed the old one.
 */
export class LatestSave {
  private request = 0;
  private open = false;

  /** Whether a value needs a save, given whether it equals the saved value. */
  needed(equalsSaved: boolean): boolean {
    return this.open || !equalsSaved;
  }

  /** Starts a save and returns its request number. */
  begin(): number {
    this.request += 1;
    this.open = true;
    return this.request;
  }

  /**
   * The user moved the control while a save is pending: the value shown is theirs now, so that save's end must not
   * replace it with the saved one.
   */
  moved(): void {
    if (this.open) this.request += 1;
  }

  /** Ends save `request`; true when it was the latest, whose end shows the saved value again. */
  end(request: number): boolean {
    if (request !== this.request) return false;
    this.open = false;
    return true;
  }
}

/**
 * A control's value while the user moves it and while its save is pending (sliders, number fields, the camera's
 * place). `move` shows a value without saving it, which a pending save's end then leaves shown; `commit` saves one and
 * keeps it shown until the latest save ends, after which the confirmed value shows: what was saved, or the old value
 * after a failure.
 */
export function usePendingValue<T>(confirmed: T, equal: (a: T, b: T) => boolean = Object.is): {
  shown: T;
  moving: T | undefined;
  move: (value: T | undefined) => void;
  commit: (next: T, save: (value: T) => Promise<unknown>) => void;
} {
  const [moving, setMoving] = useState<T | undefined>(undefined);
  const [latest] = useState(() => new LatestSave());
  const move = (value: T | undefined): void => {
    latest.moved();
    setMoving(value);
  };
  const commit = (next: T, save: (value: T) => Promise<unknown>): void => {
    if (!latest.needed(equal(next, confirmed))) return setMoving(undefined);
    setMoving(next);
    const request = latest.begin();
    void save(next).finally(() => { if (latest.end(request)) setMoving(undefined); });
  };
  return { shown: moving ?? confirmed, moving, move, commit };
}
