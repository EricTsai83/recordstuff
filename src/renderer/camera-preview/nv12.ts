/** What the capture process sends per preview frame (native-host-process.ts): NV12 bytes and when it sent them. */
export interface PreviewMessage { width: number; height: number; data: Uint8Array; sent: number; n: number }

/** The luma and chroma planes of a frame, or nothing when its size and its bytes disagree. */
export function nv12Planes(message: PreviewMessage): { luma: Uint8Array; chroma: Uint8Array } | undefined {
  const { width, height, data } = message;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width % 2 || height % 2) return undefined;
  if (!(data instanceof Uint8Array) || data.length !== width * height * 3 / 2) return undefined;
  return { luma: data.subarray(0, width * height), chroma: data.subarray(width * height) };
}

/** Frames drawn, frames the capture process sent that never arrived, the rate over the last second and the delay. */
export function previewStats(): { add(message: PreviewMessage, now: number): string; reset(): void } {
  let drawn = 0, first = 0, last = 0, recent: number[] = [], delays: number[] = [];
  return {
    reset() { drawn = 0; first = 0; last = 0; recent = []; delays = []; },
    add(message, now) {
      drawn += 1;
      if (!first) first = message.n;
      last = message.n;
      recent = [...recent.filter((at) => now - at < 1000), now];
      delays = [...delays.slice(-29), Math.max(0, now - message.sent)];
      const missed = last - first + 1 - drawn;
      const delay = delays.reduce((sum, d) => sum + d, 0) / delays.length;
      return `${message.width}×${message.height} · ${recent.length} fps · ${drawn} drawn, ${missed} not received · ${delay.toFixed(1)} ms from the capture process`;
    },
  };
}
