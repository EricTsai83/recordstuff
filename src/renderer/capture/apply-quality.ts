/**
 * What a capture will record (docs/system-design/recording.md): the frames' real size, the resolution cap applied to
 * it and the encoder targets derived from the result. The capture host (capture-host.ts) runs it between
 * `getDisplayMedia` and building the encoder; it knows nothing of sessions or the port.
 */
import {
  AUDIO_BITS_PER_SECOND,
  fitWithinCap,
  frameRateConstraint,
  videoBitsPerSecond,
  type CaptureReport,
  type Dimensions,
  type QualitySettings,
} from "../../shared/quality";

/** Used for the encoder target when the platform does not report the captured size. */
const ASSUMED_SIZE = { width: 1920, height: 1080 };

export interface MeasureOptions {
  timeoutMs?: number;
  /**
   * After a constraint was applied the first frames may still be the old
   * size: keep watching `resize` until the frames fit within this, or time out
   * and return the last size seen. Within, not equal: the old size is always
   * larger, and Chromium scales by the source's aspect ratio, which can land a
   * pixel short of a target whose edges were each rounded to an even number
   * (3024x1964 under the 1080p cap: 1662x1080 asked, 1662x1079 delivered).
   */
  expect?: Dimensions;
}

export type FrameSizeMeasurer = (stream: MediaStream, options?: MeasureOptions) => Promise<Dimensions | undefined>;

/**
 * The size of the frames a stream really carries, read from a hidden
 * `<video>` element's intrinsic size. The first measurements showed
 * `track.getSettings()` reporting 1920x1920 for a 1920x1080 display (the
 * height of another monitor), which made the 1080p cap scale the picture to
 * 1080x606; the frames themselves never lie. Undefined when there is no DOM,
 * no video track, or no frame arrives within the timeout.
 */
export async function measureFrameSize(stream: MediaStream, options: MeasureOptions = {}): Promise<Dimensions | undefined> {
  if (typeof document === "undefined") return undefined;
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  const timeoutMs = options.timeoutMs ?? 3000;
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  const current = (): Dimensions | undefined =>
    video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : undefined;
  const matches = (size: Dimensions | undefined): boolean =>
    size !== undefined && (!options.expect || (size.width <= options.expect.width && size.height <= options.expect.height));
  try {
    return await new Promise<Dimensions | undefined>((resolve) => {
      let last: Dimensions | undefined;
      const timer = setTimeout(() => resolve(last), timeoutMs);
      const check = (): void => {
        last = current() ?? last;
        if (matches(last)) {
          clearTimeout(timer);
          resolve(last);
        }
      };
      video.onloadedmetadata = check;
      video.onresize = check;
      video.onerror = () => {
        clearTimeout(timer);
        resolve(last);
      };
      void video.play().catch(() => undefined);
    });
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * fit the captured size into the resolution cap (same aspect
 * ratio, never upscaled), then derive the encoder targets from the size the
 * recording will have. The source size comes from the frames themselves
 * (`measureFrameSize`), falling back to `track.getSettings()` only when no
 * frame could be read; a disagreement between the two is reported as a
 * warning so the log shows it. A rejected constraint is reported as a
 * warning and the recording proceeds at the source size rather than failing.
 */
export async function applyQuality(stream: MediaStream, quality: QualitySettings, measure: FrameSizeMeasurer): Promise<CaptureReport> {
  const warnings: string[] = [];
  let capUnconfirmed = false;
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  const settings: MediaTrackSettings = video?.getSettings() ?? {};
  // A track that reports no size, or 0x0, has none: the cap and the encoder targets cannot be derived from it.
  const reported =
    (finiteOrUndefined(settings.width) ?? 0) > 0 && (finiteOrUndefined(settings.height) ?? 0) > 0
      ? { width: settings.width as number, height: settings.height as number }
      : undefined;
  const measured = video ? await measure(stream) : undefined;
  if (measured && reported && (measured.width !== reported.width || measured.height !== reported.height)) {
    warnings.push(`track.getSettings() reported ${reported.width}x${reported.height}; actual frames ${measured.width}x${measured.height}; using actual frames`);
  }
  if (!measured && reported) warnings.push("actual frame size unavailable; using track.getSettings()");
  const source = measured ?? reported;
  // What the recording will be: after an accepted constraint the frames are
  // measured again (an accepted max is not proof of the delivered size — the
  // display could have changed meanwhile, review R2-F1); without a frame to
  // read, the target is reported with a warning.
  let actual: Dimensions | undefined = source;
  if (video && source) {
    const target = fitWithinCap(source, quality.resolutionCap);
    if (target.width !== source.width || target.height !== source.height) {
      try {
        // `applyConstraints` replaces the whole constraint set, so the frame
        // rate asked for in `getDisplayMedia` must be repeated here (F1).
        await video.applyConstraints({
          width: { ideal: target.width, max: target.width },
          height: { ideal: target.height, max: target.height },
          frameRate: frameRateConstraint(quality.frameRate),
        });
        const settled = await measure(stream, { expect: target, timeoutMs: 1500 });
        if (!settled) {
          warnings.push(`could not remeasure constrained frames; reporting target ${target.width}x${target.height}`);
          capUnconfirmed = true;
          actual = target;
        } else {
          if (settled.width !== target.width || settled.height !== target.height) {
            warnings.push(`constrained frames ${settled.width}x${settled.height} differ from target ${target.width}x${target.height}`);
          }
          // Smaller frames still honour the cap; only larger ones break it.
          if (settled.width > target.width || settled.height > target.height) capUnconfirmed = true;
          actual = settled;
        }
      } catch (cause) {
        warnings.push(`could not apply resolution cap ${quality.resolutionCap}; using source size: ${describe(cause)}`);
        capUnconfirmed = true;
      }
    }
  } else if (!source) {
    warnings.push("video track has no dimensions; cannot apply resolution cap");
    if (quality.resolutionCap !== "source") capUnconfirmed = true;
  }
  const encodeSize = actual ?? ASSUMED_SIZE;
  const audioSettings = audio?.getSettings() ?? {};
  for (const effect of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    if (audioSettings[effect] === true) warnings.push(`system audio reports ${effect}=true despite requesting false`);
  }
  const report: CaptureReport = {
    videoBitsPerSecond: videoBitsPerSecond(encodeSize, quality.frameRate, quality.videoQuality),
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    warnings,
    ...(capUnconfirmed ? { capUnconfirmed: true } : {}),
  };
  // Only fields we know; `undefined` must not travel as a key with exactOptionalPropertyTypes.
  if (actual) {
    report.width = actual.width;
    report.height = actual.height;
  }
  const afterSettings: MediaTrackSettings = video?.getSettings() ?? settings;
  const frameRate = finiteOrUndefined(afterSettings.frameRate);
  if (frameRate !== undefined) report.frameRate = frameRate;
  const sampleRate = finiteOrUndefined(audioSettings.sampleRate);
  if (sampleRate !== undefined) report.sampleRate = sampleRate;
  const channelCount = finiteOrUndefined(audioSettings.channelCount);
  if (channelCount !== undefined) report.channelCount = channelCount;
  return report;
}

/** An error as the log says it: its name and message. */
export function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.name ? `${cause.name}: ${cause.message}` : cause.message;
  return String(cause);
}
