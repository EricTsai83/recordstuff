import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import afterPack, { CAPTURE_HELPER_INFO, captureHelperPlist } from "./after-pack.mjs";

const context = (appOutDir: string, platform = "darwin") => ({ appOutDir, electronPlatformName: platform, packager: { appInfo: { productFilename: "RecordStuff" } } });

describe.skipIf(process.platform !== "darwin")("afterPack (plan 075)", () => {
  it("writes the camera process's entries into the capture helper's Info.plist, keeping the rest", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recordstuff-after-pack-"));
    try {
      const plist = captureHelperPlist(path.join(dir, "RecordStuff.app"), "RecordStuff");
      mkdirSync(path.dirname(plist), { recursive: true });
      writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>RecordStuff Helper</string></dict></plist>\n');
      await afterPack(context(dir));
      const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })) as Record<string, unknown>;
      expect(info).toEqual({ CFBundleName: "RecordStuff Helper", ...CAPTURE_HELPER_INFO });
      expect(info.NSCameraReactionEffectGesturesEnabledDefault).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves other platforms' builds alone", async () => {
    await expect(afterPack(context("/nonexistent", "win32"))).resolves.toBeUndefined();
  });
});
