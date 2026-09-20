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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
