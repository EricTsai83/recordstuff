/**
 * The authoritative recording state. Owned by `main/recorder.ts`; the tray is
 * only a projection of it (plans/001-first-version.md §8, §19-2).
 *
 * `idle.outputDirUnavailable` is set when the last start attempt failed
 * because the chosen output directory could not be written (plans/001-first-version.md §10.1:
 * the menu's first line must read「儲存位置無法使用」). It is cleared by the
 * next successful start or by changing the output directory.
 */
export type RecordingState =
  | { type: "needsPermission"; needsRelaunch: boolean }
  | { type: "idle"; lastSavedPath?: string; outputDirUnavailable?: boolean }
  | { type: "starting" }
  | { type: "recording"; startedAt: string }
  | { type: "stopping" };

/**
 * Every failure the app can report (plans/001-first-version.md §13). `capture_failed` covers a
 * capture that stopped on its own mid-recording (track ended, MediaRecorder
 * error); the plan's list has no code for that path and we do not fake success.
 */
export type ErrorCode =
  | "permission_denied"
  | "permission_needs_relaunch"
  | "unsupported_os_version"
  | "no_display"
  | "no_audio_track"
  | "mp4_unsupported"
  | "capture_start_failed"
  | "capture_failed"
  | "capture_host_crashed"
  | "capture_host_unresponsive"
  | "output_open_failed"
  | "output_write_failed"
  | "disk_full"
  | "stop_timeout";

export const ERROR_CODES: readonly ErrorCode[] = [
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
];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
