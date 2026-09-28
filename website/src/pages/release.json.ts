import { manifest, reverified } from "../lib/release.ts";
import { DOWNLOAD_URL } from "../lib/site-origin.ts";

/** Unverified previews never advertise a downloadable release to installed apps. */
export function GET(): Response {
  return Response.json(reverified ? {
    version: manifest.version, tag: manifest.tag,
    platform: manifest.platform, architecture: manifest.architecture,
    dmg: manifest.dmg, publishedAt: manifest.publishedAt,
    releaseUrl: manifest.releaseUrl,
    downloadUrl: DOWNLOAD_URL,
  } : { error: "Release not re-verified; preview only" });
}
