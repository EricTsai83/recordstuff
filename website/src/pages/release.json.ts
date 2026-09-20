import { manifest, reverified } from "../lib/release.ts";

/** Unverified previews never advertise a downloadable release to installed apps. */
export function GET(): Response {
  return Response.json(reverified ? {
    version: manifest.version, tag: manifest.tag,
    platform: manifest.platform, architecture: manifest.architecture,
    dmg: manifest.dmg, publishedAt: manifest.publishedAt,
    releaseUrl: manifest.releaseUrl,
    downloadUrl: "https://record.ericts.com/download",
  } : { error: "Release not re-verified; preview only" });
}
