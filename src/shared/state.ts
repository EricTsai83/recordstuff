/**
 * The authoritative recording state. Owned by `main/recorder.ts`; the tray is
 * only a projection of it (docs/system-design/recording.md).
 *
 * `idle.outputDirUnavailable` is set when the last start attempt failed
 * because the chosen output directory could not be written (docs/system-design/recording.md:
 * the menu's first line must read"Output folder unavailable"). It is cleared by the
 * next successful start or by changing the output directory.
 */
export type RecordingState =
  | { type: "needsPermission"; needsRelaunch: boolean }
  | { type: "idle"; lastSavedPath?: string; outputDirUnavailable?: boolean }
  | { type: "starting" }
  | { type: "recording"; startedAt: string }
  | { type: "stopping" };

/**
 * Every failure the app can report (docs/system-design/recording.md). `capture_failed` covers a
 * capture that stopped on its own mid-recording (track ended, MediaRecorder
 * error); unexpected termination must not be reported as a successful stop.
 */
export const ERROR_CODES = [
  "permission_denied",
  "permission_needs_relaunch",
  "unsupported_os_version",
  "no_display",
  "no_audio_track",
  "mp4_unsupported",
  "capture_start_failed",
  "capture_failed",
  "capture_host_crashed",
  "capture_host_unresponsive",
  "output_open_failed",
  "output_write_failed",
  "disk_full",
  "stop_timeout",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
