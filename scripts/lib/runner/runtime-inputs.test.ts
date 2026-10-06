import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeInputDigest, runtimeInputFiles, staleBundleReason, writeBuildStamp } from "./runtime-inputs.mjs";

let root: string;
const app = (): string => path.join(root, "dist/mac-arm64/RecordStuff.app");
const write = (relative: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
};
function setup(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-inputs-"));
  write("src/main/index.ts", "export {};\n");
  write("package.json", "{}\n");
  write("dist/mac-arm64/RecordStuff.app/Contents/Resources/app.asar", "archive");
}
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("runtime inputs", () => {
  it("ignore tests, tooling and documentation but not sources or configuration", () => {
    setup();
    const digest = (): string => runtimeInputDigest(runtimeInputFiles(root));
    const base = digest();
    write("src/main/index.test.ts", "test\n");
    write("scripts/runner.mts", "tool\n");
    write("docs/testing.md", "doc\n");
    write("resources/INSTALL.md", "guide\n");
    write("src/.DS_Store", "finder\n");
    expect(digest()).toBe(base);
    write("electron.vite.config.ts", "config\n");
    const configured = digest();
    expect(configured).not.toBe(base);
    write("src/main/index.ts", "export const x = 1;\n");
    expect(digest()).not.toBe(configured);
  });

  it("let only the bundle the current inputs built be reopened", () => {
    setup();
    expect(staleBundleReason(root, app())).toContain("no build record");
    expect(writeBuildStamp(root, app(), "HASH", runtimeInputFiles(root))?.app).toMatch(/^[\da-f]{64}$/);
    expect(staleBundleReason(root, app())).toBeUndefined();
    write("src/main/index.test.ts", "test\n");
    expect(staleBundleReason(root, app())).toBeUndefined();
    write("src/main/index.ts", "export const changed = 1;\n");
    expect(staleBundleReason(root, app())).toBe("runtime inputs changed since it was built: src/main/index.ts");
  });

  it("refuse a bundle replaced after its record was written", () => {
    setup();
    writeBuildStamp(root, app(), "HASH", runtimeInputFiles(root));
    write("dist/mac-arm64/RecordStuff.app/Contents/Resources/app.asar", "other archive");
    expect(staleBundleReason(root, app())).toContain("app.asar changed");
  });

  it("write no record when the inputs changed during the build", () => {
    setup();
    const before = runtimeInputFiles(root);
    write("src/main/index.ts", "export const midBuild = 1;\n");
    expect(writeBuildStamp(root, app(), "HASH", before)).toBeUndefined();
    expect(staleBundleReason(root, app())).toContain("no build record");
  });

  it("hash what a symlink points to, not just its target path", () => {
    setup();
    write("shared/icon.png", "one");
    fs.mkdirSync(path.join(root, "resources"));
    fs.symlinkSync(path.join(root, "shared/icon.png"), path.join(root, "resources/icon.png"));
    fs.symlinkSync(path.join(root, "resources"), path.join(root, "resources/loop"));
    const first = runtimeInputFiles(root);
    expect(first["resources/loop"]).toMatch(/^cycle:/);
    write("shared/icon.png", "two");
    expect(runtimeInputDigest(runtimeInputFiles(root))).not.toBe(runtimeInputDigest(first));
  });

  it("count scripts/ for a workspace whose sources import from it", () => {
    setup();
    write("scripts/fixtures/update-acceptance.ts", "export const a = 1;\n");
    const normal = runtimeInputFiles(root);
    expect(Object.keys(normal).some(name => name.startsWith("scripts/"))).toBe(false);
    write("src/main/index.ts", 'import { a } from "../../scripts/fixtures/update-acceptance";\n');
    writeBuildStamp(root, app(), "HASH", runtimeInputFiles(root));
    write("scripts/fixtures/update-acceptance.ts", "export const a = 2;\n");
    expect(staleBundleReason(root, app())).toContain("scripts/fixtures/update-acceptance.ts");
  });

  it("refuse an unreadable or unknown record", () => {
    setup();
    write("dist/mac-arm64/RecordStuff.app.inputs.json", "{");
    expect(staleBundleReason(root, app())).toContain("unreadable");
    write("dist/mac-arm64/RecordStuff.app.inputs.json", "{\"version\":2}");
    expect(staleBundleReason(root, app())).toContain("unknown format");
  });
});
