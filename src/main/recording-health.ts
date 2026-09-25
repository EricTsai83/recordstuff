/**
 * Recording health guards (docs/system-design/recording.md#deadlines-and-supervision):
 * every threshold lives here. Values are the initial targets of plan 038; tune
 * them only with written evidence. The guards observe and stop through the
 * existing paths; nothing here reserves space, throttles capture or repairs files.
 */
export interface RecordingHealth {
  /** Free-space poll of the output folder while recording. */
  diskPollMs: number;
  /** Below this, log once per session. */
  diskWarnBytes: number;
  /** Below this, request the normal stop once so the file is drained and published while space remains. */
  diskStopBytes: number;
  /** Without a nonempty chunk after media began: log a warning once… */
  stallWarnMs: number;
  /** …then fail the session with `capture_failed`. */
  stallFailMs: number;
  /** Bytes FileWriter accepted but has not confirmed written; exceeding it fails the session. */
  writerBacklogBytes: number;
  /** A generic start failure waits at most this long for queued writer work before classifying it. */
  startDrainMs: number;
}

const MIB = 1024 * 1024;

export const RECORDING_HEALTH: Readonly<RecordingHealth> = {
  diskPollMs: 5000,
  diskWarnBytes: 1024 * MIB,
  diskStopBytes: 200 * MIB,
  stallWarnMs: 10_000,
  stallFailMs: 30_000,
  writerBacklogBytes: 64 * MIB,
  startDrainMs: 2000,
};
