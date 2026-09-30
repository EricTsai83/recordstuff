import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-links.mts", import.meta.url));

test("checks the selected deployment output, including nested page fragments", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recordstuff-links-"));
  const check = () => spawnSync(process.execPath, [checker, "--dir", dir, "--offline"], { encoding: "utf8" });
  try {
    await mkdir(path.join(dir, "help"));
    await writeFile(path.join(dir, "index.html"), '<a href="/help#install">Install</a>');
    await writeFile(path.join(dir, "help/index.html"), '<h1 id="install">Install</h1>');
    const valid = check();
    assert.equal(valid.status, 0, valid.stderr);
    await writeFile(path.join(dir, "help/index.html"), '<h1 id="renamed">Install</h1>');
    const broken = check();
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /fragment #install not found/);
    await rm(path.join(dir, "help"), { recursive: true });
    assert.match(check().stderr, /internal link .* does not resolve/);
    // A malformed escape is reported with its page, and the other problems are still listed.
    await writeFile(path.join(dir, "index.html"), '<a href="#100%">Share</a><a href="https://example.com/#100%">Out</a><a href="/missing">Gone</a>');
    const malformed = check();
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /\/index\.html: malformed reference #100%/);
    assert.doesNotMatch(malformed.stderr, /example\.com/);
    assert.match(malformed.stderr, /internal link \/missing does not resolve/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves sibling, parent, query and escaped-fragment links from their page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recordstuff-relative-links-"));
  try {
    await mkdir(path.join(dir, "guide"));
    await writeFile(path.join(dir, "index.html"), '<h1 id="home">Home</h1>');
    await writeFile(path.join(dir, "guide/index.html"), '<a href="../#home">Home</a><a href="next.html?x=1&amp;y=2#%E8%AA%AA%E6%98%8E">Next</a>');
    await writeFile(path.join(dir, "guide/next.html"), '<h1 id="說明">Next</h1>');
    const result = spawnSync(process.execPath, [checker, "--dir", dir, "--offline"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
