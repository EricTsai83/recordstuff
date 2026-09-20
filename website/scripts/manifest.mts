/**
 * Release manifest tool for the website.
 *
 *   node scripts/manifest.mts generate vX.Y.Z   fetch the public release and write release-manifest.json
 *   node scripts/manifest.mts verify            re-fetch and fail if the stored manifest drifted
 *   node scripts/manifest.mts verify --offline  structural check only (also SITE_MANIFEST_OFFLINE=1)
 *   node scripts/manifest.mts verify --online   force the network check even if SITE_MANIFEST_OFFLINE is set
 *
 * The build runs `verify` first so the site never ships a download button that
 * points at something other than the verified release. `GH_TOKEN` or
 * `GITHUB_TOKEN`, when present, is sent to the GitHub API to avoid rate limits.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertManifestShape,
  diffManifest,
  type ReleaseManifest,
} from "../../scripts/lib/release-manifest.mts";

import { fetchManifest } from "../../scripts/lib/release-manifest-client.mts";

export const MANIFEST_PATH = fileURLToPath(new URL("../release-manifest.json", import.meta.url));

export async function readStoredManifest(path = MANIFEST_PATH): Promise<ReleaseManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}. Run \`pnpm manifest generate vX.Y.Z\` first.`);
  }
  return assertManifestShape(JSON.parse(text));
}

async function generate(tag: string | undefined): Promise<void> {
  if (!tag) throw new Error("Usage: manifest.mts generate vX.Y.Z");
  const manifest = await fetchManifest(tag);
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${MANIFEST_PATH} for ${manifest.tag} (${manifest.dmg.name}, ${manifest.dmg.size} bytes).`);
}

async function verify(offline: boolean): Promise<void> {
  const stored = await readStoredManifest();
  if (offline) {
    console.log(`Manifest ${stored.tag} is well-formed (offline check only; GitHub was not consulted).`);
    return;
  }
  const fresh = await fetchManifest(stored.tag, new Date(stored.verifiedAt));
  const differences = diffManifest(stored, fresh);
  if (differences.length > 0) {
    throw new Error(
      `Stored manifest for ${stored.tag} no longer matches GitHub:\n  ${differences.join("\n  ")}\nRegenerate it with \`pnpm manifest generate ${stored.tag}\`.`,
    );
  }
  console.log(`Manifest ${stored.tag} matches the published release (${fresh.dmg.size} bytes, sha256 ${fresh.dmg.sha256}).`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (rest.includes("--offline") && rest.includes("--online")) throw new Error("--offline and --online are mutually exclusive.");
  // The production build passes --online so an inherited SITE_MANIFEST_OFFLINE cannot downgrade its verification.
  const offline = rest.includes("--online") ? false : rest.includes("--offline") || process.env.SITE_MANIFEST_OFFLINE === "1";
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  switch (command) {
    case "generate":
      await generate(positional[0]);
      return;
    case "verify":
      await verify(offline);
      return;
    default:
      throw new Error("Usage: manifest.mts <generate vX.Y.Z | verify [--offline|--online]>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`manifest: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
