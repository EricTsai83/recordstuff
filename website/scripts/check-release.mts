/** Run after the online-verified build; a preview is intentionally not a release feed. */
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
const read = async (name: string) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const manifest = await read("../release-manifest.json");
const { values } = parseArgs({ options: { dir: { type: "string" } } });
const feedPath = values.dir ? path.join(path.resolve(values.dir), "release.json") : new URL("../dist/release.json", import.meta.url);
const feed = JSON.parse(await readFile(feedPath, "utf8"));
assert.deepEqual(feed, {
  version: manifest.version, tag: manifest.tag, platform: manifest.platform,
  architecture: manifest.architecture, dmg: manifest.dmg, publishedAt: manifest.publishedAt,
  releaseUrl: manifest.releaseUrl, downloadUrl: "https://record.ericts.com/download",
});
console.log(`Built release.json matches verified manifest ${manifest.version}.`);
