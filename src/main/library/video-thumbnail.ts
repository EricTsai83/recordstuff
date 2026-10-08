/**
 * The picture a Recordings card shows (docs/system-design/desktop.md#recordings), made as the app makes it, so the
 * thumbnail measurement (tests/ui/measure) reads the same work the app does.
 */
import type { NativeImage } from "electron";

/** Twice a card's width in a wide window, so a three-column grid stays sharp on a Retina display. */
export const THUMBNAIL_SIZE = { width: 960, height: 540 } as const;

/** A JPEG of the video's picture (QuickLook on macOS), or undefined when none can be made. */
export async function videoThumbnail(
  nativeImage: { createThumbnailFromPath: (path: string, size: { width: number; height: number }) => Promise<NativeImage> },
  file: string,
): Promise<Buffer | undefined> {
  const image = await nativeImage.createThumbnailFromPath(file, THUMBNAIL_SIZE);
  // A video frame: as JPEG it is several times smaller than as PNG, in the cache and on the way to the page.
  return image.isEmpty() ? undefined : image.toJPEG(85);
}
