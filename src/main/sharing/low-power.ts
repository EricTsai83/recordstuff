/**
 * Whether macOS runs in Low Power Mode (plan 100 step 4), which holds the versions prepared ahead: Electron does not say
 * it, so `pmset -g` is read, only while versions are being prepared. Anything that cannot be read counts as off.
 */
import { execFile } from "node:child_process";

/** How often it is read while versions are being prepared. */
export const LOW_POWER_POLL_MS = 30_000;

/** `pmset -g`'s `lowpowermode 1` (macOS 12 and later): on. */
export function lowPowerIn(output: string): boolean {
  return /^\s*lowpowermode\s+1\s*$/m.test(output);
}

export function readLowPower(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("/usr/bin/pmset", ["-g"], { timeout: 5000 }, (error, stdout) => resolve(!error && lowPowerIn(stdout)));
  });
}
