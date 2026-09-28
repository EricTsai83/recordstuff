/**
 * The site's public origin. The release feed's `downloadUrl` is fixed to it,
 * because the App compares that URL byte for byte (src/main/updates.ts); page
 * URLs (canonical, OpenGraph) follow `SITE_URL` when set, so previews stay
 * well-formed. Plain TypeScript with no Astro import: the feed test and the
 * check scripts load it directly under Node.
 */
export const SITE_ORIGIN = "https://record.ericts.com";
export const DOWNLOAD_URL = `${SITE_ORIGIN}/download`;

/** The origin this build is for: `SITE_URL` for a preview, otherwise the public one. */
export function configuredSite(env: NodeJS.ProcessEnv = process.env): string {
  return env.SITE_URL ?? SITE_ORIGIN;
}
