// electron-builder afterPack hook: runs after the App is assembled and before it is signed.

import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Info.plist entries of the helper that runs the native capture engine (an Electron utility process, plan 076).
 * AVFoundation reads them from the camera process's own bundle, `RecordStuff Helper.app`, not from the App's, so
 * `mac.extendInfo` does not reach them.
 *
 * Reactions' gestures start off (plan 075): a hand gesture would otherwise put balloons or fireworks into a
 * recording. The user can still turn them on in Control Center > Video Effects. This saves no CPU: while Reactions
 * itself is on, which an app cannot turn off on macOS (`NSCameraReactionEffectsEnabled` is iOS's opt-in), macOS
 * detects hands and bodies in every camera picture in this process either way (2026-10-18, M1 MacBook Air).
 */
export const CAPTURE_HELPER_INFO = { NSCameraReactionEffectGesturesEnabledDefault: false };

/** The capture helper's Info.plist inside an App bundle. */
export function captureHelperPlist(appPath, productName) {
  return path.join(appPath, "Contents/Frameworks", `${productName} Helper.app`, "Contents/Info.plist");
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const name = context.packager.appInfo.productFilename;
  const plist = captureHelperPlist(path.join(context.appOutDir, `${name}.app`), name);
  for (const [key, value] of Object.entries(CAPTURE_HELPER_INFO)) {
    execFileSync("plutil", ["-replace", key, "-bool", value ? "YES" : "NO", plist]);
  }
}
