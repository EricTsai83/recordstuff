/**
 * What the capture process sends per preview chunk (native-host-process.ts): H.264 in AVCC form, the `avcC` record with
 * every key frame, and when it was captured (host µs) and sent (wall-clock ms).
 */
export interface PreviewMessage {
  width: number; height: number; data: Uint8Array; key: boolean; timestamp: number;
  description?: Uint8Array; sent: number; n: number;
}

/** WebCodecs' codec string from an `avcC` record (`avc1.PPCCLL`), or nothing when it is not one. */
export function codecFrom(description: Uint8Array): string | undefined {
  if (description.length < 4 || description[0] !== 1) return undefined;
  const hex = (byte: number): string => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(description[1]!)}${hex(description[2]!)}${hex(description[3]!)}`;
}

/** Whether a message is a chunk the page can decode. */
export function isPreviewMessage(value: unknown): value is PreviewMessage {
  const m = value as Partial<PreviewMessage> | null;
  return !!m && typeof m === "object" && Number.isInteger(m.width) && Number.isInteger(m.height) && m.data instanceof Uint8Array
    && typeof m.key === "boolean" && typeof m.timestamp === "number" && typeof m.n === "number" && typeof m.sent === "number"
    && (m.description === undefined || m.description instanceof Uint8Array);
}

/**
 * Frames drawn, chunks the capture process sent that never arrived, the rate over the last second and the delay, split
 * at `received` (when the page took the chunk) into the port's share and the decoder's.
 */
export function previewStats(): { add(message: PreviewMessage, now: number, received?: number): string; reset(): void } {
  let drawn = 0, first = 0, last = 0, recent: number[] = [], delays: number[] = [], decodes: number[] = [];
  const mean = (values: number[]): number => values.reduce((sum, d) => sum + d, 0) / Math.max(1, values.length);
  return {
    reset() { drawn = 0; first = 0; last = 0; recent = []; delays = []; decodes = []; },
    add(message, now, received) {
      drawn += 1;
      if (!first) first = message.n;
      last = message.n;
      recent = [...recent.filter((at) => now - at < 1000), now];
      delays = [...delays.slice(-29), Math.max(0, now - message.sent)];
      if (received !== undefined) decodes = [...decodes.slice(-29), Math.max(0, now - received)];
      const missed = last - first + 1 - drawn;
      const split = decodes.length ? ` (${mean(decodes).toFixed(1)} ms of it decoding)` : "";
      return `${message.width}×${message.height} · ${recent.length} fps · ${drawn} drawn, ${missed} not shown · ${mean(delays).toFixed(1)} ms from the capture process${split}`;
    },
  };
}
