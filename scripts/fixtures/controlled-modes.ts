/**
 * Fault names, modes and hold targets of the controlled acceptance build (plan 035),
 * shared by the build and its runner. No imports, so Node can load it directly.
 */
export const FAULT_MODES = {
  /** Holds each failure's settled result, so its pending result stays until released. */
  cleanup: ["off", "hold"],
  /** Fails the next write to a recording file that already holds data, once. */
  write: ["off", "eio", "enospc"],
  /** Fails the next close of a recording file after it really closed, once. */
  close: ["off", "fail"],
  /** Holds or rejects failure-history saves until changed. */
  "history-save": ["off", "hold", "fail"],
} as const;
export type FaultName = keyof typeof FAULT_MODES;
export type Faults = { -readonly [K in FaultName]: (typeof FAULT_MODES)[K][number] };
export const HOLD_TARGETS = ["cleanup", "history-save", "history-load"] as const;
export type HoldTarget = (typeof HOLD_TARGETS)[number];

export const isFaultName = (value: unknown): value is FaultName =>
  typeof value === "string" && Object.hasOwn(FAULT_MODES, value);
export const isFaultMode = (name: FaultName, mode: unknown): boolean =>
  (FAULT_MODES[name] as readonly unknown[]).includes(mode);
export const isHoldTarget = (value: unknown): value is HoldTarget =>
  typeof value === "string" && (HOLD_TARGETS as readonly string[]).includes(value);
