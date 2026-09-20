import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const endpoint = new URL("../src/pages/release.json.ts", import.meta.url).href;
const manifest = JSON.parse(await readFile(new URL("../release-manifest.json", import.meta.url), "utf8"));
function response(verified: string | undefined) {
  const env = { ...process.env };
  delete env.SITE_MANIFEST_VERIFIED;
  if (verified !== undefined) env.SITE_MANIFEST_VERIFIED = verified;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { GET } from ${JSON.stringify(endpoint)}; console.log(await GET().text());`], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test("verified endpoint exposes the complete manifest feed", () => {
  const feed = response("1");
  assert.equal(feed.version, manifest.version);
  assert.deepEqual(feed.dmg, manifest.dmg);
  assert.equal(feed.downloadUrl, "https://record.ericts.com/download");
});
test("unverified and false-flag previews never advertise a release", () => {
  for (const value of [undefined, "0", "true"]) {
    const feed = response(value);
    assert.deepEqual(feed, { error: "Release not re-verified; preview only" });
  }
});
test("the deployment gate checks the selected output and rejects missing or different feeds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recordstuff-feed-"));
  const script = fileURLToPath(new URL("./check-release.mts", import.meta.url));
  const check = () => spawnSync(process.execPath, [script, "--dir", dir], { encoding: "utf8" });
  try {
    assert.notEqual(check().status, 0);
    const feed = response("1");
    await writeFile(path.join(dir, "release.json"), JSON.stringify(feed));
    assert.equal(check().status, 0);
    await writeFile(path.join(dir, "release.json"), JSON.stringify({ ...feed, version: "0.0.0" }));
    assert.notEqual(check().status, 0);
    await writeFile(path.join(dir, "release.json"), JSON.stringify(response(undefined)));
    assert.notEqual(check().status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
