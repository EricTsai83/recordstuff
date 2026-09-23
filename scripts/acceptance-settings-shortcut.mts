/** System Events entry step only; Computer Use must independently verify the visible panel. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_SHORTCUT } from "../src/shared/hotkey.ts";
import { acceleratorToKeystroke, keystrokeScript, lastStartIndex, nextLogIndex, registeredSettingsAccelerator } from "./lib/acceptance.mts";
import { command, waitForLog } from "./lib/acceptance-runtime.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff");
const logPath = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
if (args.length) throw new Error("usage: pnpm acceptance:settings-shortcut (no arguments)");
fs.mkdirSync(path.join(root, "docs/verification/measurements"), { recursive: true });
const out = fs.mkdtempSync(path.join(root, "docs/verification/measurements/", `${new Date().toISOString().replaceAll(":", "-")}-settings-entry-`));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort(new Error(`interrupted: ${signal}`)));
const read = (): string[] => fs.readFileSync(logPath, "utf8").split(/\r?\n/);
let from = fs.existsSync(logPath) ? nextLogIndex(read()) : 0;
let evidence = "";
try {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This runner requires the local macOS arm64 pnpm start:app bundle.");
  const escaped = appPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pid = (await command("pgrep", ["-f", `^${escaped}$`], controller.signal)).trim();
  if (!/^\d+$/.test(pid)) throw new Error("Expected exactly one local RecordStuff bundle process.");
  const lines = read();
  from = nextLogIndex(lines);
  const start = lines[lastStartIndex(lines)];
  if (!start?.endsWith(`; executable ${appPath}`)) throw new Error("Latest app log does not belong to the local bundle.");
  if (registeredSettingsAccelerator(lines) !== SETTINGS_SHORTCUT) throw new Error("Settings shortcut is not currently registered (conflict, capture, failure or older build). No key sent.");
  const script = keystrokeScript(acceleratorToKeystroke(SETTINGS_SHORTCUT)!);
  evidence = `PID: ${pid}\nExecutable: ${appPath}\nSent: ${SETTINGS_SHORTCUT}\nAppleScript: ${script}\n`;
  await command("osascript", ["-e", script], controller.signal);
  const hit = await waitForLog(read, from, /\] settings shortcut: CommandOrControl\+Alt\+, pressed$/, "Settings shortcut callback", controller.signal);
  evidence += `Observed: ${hit.line}\n`;
  fs.writeFileSync(path.join(out, "report.md"), `# Settings shortcut entry — PASS (callback only)\n\n${evidence}\nMode: System Events + Computer Use. No IPC or test-only opening route.\n\nPanel visibility, focus, keyboard navigation and recording continuity are NOT verified by this script. Continue with native Computer Use; do not report full UI acceptance from this exit code.\n`);
  console.log(`PASS: Settings callback received. Continue native Computer Use. Evidence: ${out}`);
} catch (error) {
  fs.writeFileSync(path.join(out, "report.md"), `# Settings shortcut entry — FAIL\n\n${evidence}\n${String(error)}\n\nNo permission settings were changed. Check System Events/Accessibility permission if macOS refused the command.\n`);
  console.error(`${String(error)}\nEvidence: ${out}`);
  process.exitCode = 1;
} finally {
  if (fs.existsSync(logPath)) fs.writeFileSync(path.join(out, "app.log"), read().slice(from).join("\n"));
}
