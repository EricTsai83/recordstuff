/** System Events entry step only; Computer Use must independently verify the visible panel. */
import fs from "node:fs";
import { APP_LOG_PATH } from "./lib/runner-env.mts";
import { escapeRegExp } from "./lib/processes.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_SHORTCUT } from "../src/shared/hotkey.ts";
import { acceleratorToKeystroke, keystrokeScript, lastStartIndex, registeredSettingsAccelerator } from "./lib/acceptance.mts";
import { command, waitForLog } from "./lib/acceptance-runtime.mts";
import { LogReader, evidenceSince } from "./lib/log-reader.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff");
const logPath = APP_LOG_PATH;
const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
if (args.length) throw new Error("usage: pnpm acceptance:settings-shortcut (no arguments)");
fs.mkdirSync(path.join(root, "docs/verification/measurements"), { recursive: true });
const out = fs.mkdtempSync(path.join(root, "docs/verification/measurements/", `${new Date().toISOString().replaceAll(":", "-")}-settings-entry-`));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort(new Error(`interrupted: ${signal}`)));
const appLog = new LogReader(logPath);
let from = appLog.end();
let evidence = "";
let desktop: DesktopRound | undefined;
try {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This runner requires the local macOS arm64 pnpm start:app bundle.");
  // The panel this opens is judged by native observation on an awake, unlocked display.
  desktop = await beginDesktopRound();
  // pgrep exits 1 when nothing matches; that is the not-running case the check below explains.
  const pid = (await command("pgrep", ["-f", `^${escapeRegExp(appPath)}$`], controller.signal, 5000, [0, 1])).trim();
  if (!/^\d+$/.test(pid)) throw new Error("Expected exactly one local RecordStuff bundle process.");
  from = appLog.end();
  const lines = appLog.all();
  const start = lines[lastStartIndex(lines)];
  if (!start?.endsWith(`; executable ${appPath}`)) throw new Error("Latest app log does not belong to the local bundle.");
  if (registeredSettingsAccelerator(lines) !== SETTINGS_SHORTCUT) throw new Error("Settings shortcut is not currently registered (conflict, capture, failure or older build). No key sent.");
  const script = keystrokeScript(acceleratorToKeystroke(SETTINGS_SHORTCUT)!);
  evidence = `PID: ${pid}\nExecutable: ${appPath}\nSent: ${SETTINGS_SHORTCUT}\nAppleScript: ${script}\n`;
  await command("osascript", ["-e", script], controller.signal);
  const hit = await waitForLog(appLog, from, new RegExp(`\\] settings shortcut: ${escapeRegExp(SETTINGS_SHORTCUT)} pressed$`), "Settings shortcut callback", controller.signal);
  evidence += `Observed: ${hit.line}\n`;
  desktop.end();
  if (desktop.lockedAt) throw new DesktopBlockedError(desktop.summary);
  fs.writeFileSync(path.join(out, "report.md"), `# Settings shortcut entry — PASS (callback only)\n\n${evidence}${desktop.summary}\nMode: System Events + Computer Use. No IPC or test-only opening route.\n\nPanel visibility, focus, keyboard navigation and recording continuity are NOT verified by this script. Continue with native Computer Use; do not report full UI acceptance from this exit code.\n`);
  console.log(`PASS: Settings callback received. Continue native Computer Use. Evidence: ${out}`);
} catch (error) {
  desktop?.end();
  const blocked = error instanceof DesktopBlockedError;
  fs.writeFileSync(path.join(out, "report.md"), `# Settings shortcut entry — ${blocked ? "BLOCKED" : "FAIL"}\n\n${evidence}\n${String(error)}\n\nNo permission settings were changed. Check System Events/Accessibility permission if macOS refused the command.\n`);
  console.error(`${blocked ? "BLOCKED: " : ""}${String(error)}\nEvidence: ${out}`);
  process.exitCode = blocked ? DESKTOP_BLOCKED_EXIT : 1;
} finally {
  if (fs.existsSync(logPath)) fs.writeFileSync(path.join(out, "app.log"), evidenceSince(appLog, from).join("\n"));
}
