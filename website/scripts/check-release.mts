/** Run after the online-verified build; a preview is intentionally not a release feed. */
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { DOWNLOAD_URL } from "../src/lib/site-origin.ts";
const read = async (name: string) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const manifest = await read("../release-manifest.json");
const { values } = parseArgs({ options: { dir: { type: "string" } } });
const feedPath = values.dir ? path.join(path.resolve(values.dir), "release.json") : new URL("../dist/release.json", import.meta.url);
let feedText: string;
try {
  feedText = await readFile(feedPath, "utf8");
} catch (error) {
  throw new Error(`Cannot read ${feedPath}: ${(error as Error).message}. Build the site first (pnpm build), or pass --dir to the built output.`);
}
const feed = JSON.parse(feedText);
assert.deepEqual(feed, {
  version: manifest.version, tag: manifest.tag, platform: manifest.platform,
  architecture: manifest.architecture, dmg: manifest.dmg, publishedAt: manifest.publishedAt,
  releaseUrl: manifest.releaseUrl, downloadUrl: DOWNLOAD_URL,
});
console.log(`Built release.json matches verified manifest ${manifest.version}.`);
