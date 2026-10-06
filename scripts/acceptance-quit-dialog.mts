/**
 * Guided deferred-quit notice check (plans 055 and 062). Launches the fixture only from a
 * per-round, fully signed Electron.app copy, and never interprets a shown event as visual acceptance.
 */
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { scrubbedEnv } from "./lib/runner/runner-env.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { runIsolatedProcess } from "./lib/runner/isolated-process.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { workingTreeIdentity } from "./lib/runner/verification-timing.mts";
import {
  DEFERRED_QUIT_MEDIA_MESSAGE, DELIVERY_WINDOW_MS, MAX_LATE_MS, VISUAL_PENDING, classifyBannerText, classifyCleanup, classifyDelivery, classifyLifecycle, classifySetup,
  combineVerdict, parseNotificationEvents, renderReport, type BannerSighting, type DeliveryLayer, type Layer,
} from "./lib/acceptance/quit-dialog-acceptance.mts";
import { AccessibilityBlockedError, osascriptAx } from "./lib/runner/native-ax.mts";
import { isLanguage, translate } from "../src/shared/i18n.ts";

/** Copy, sign and verify take about two seconds; a keychain prompt waiting for a person must not hold the round. */
const SETUP_TIMEOUT_MS = 60_000;
const args = process.argv.slice(2).filter(arg => arg !== "--");
if (args.length === 1 && args[0] === "--help") {
  console.log("pnpm acceptance:quit-dialog -- --language en|zh-TW\nIsolated synthetic data; no recording. Copies this checkout's Electron.app to a temporary directory, signs it with the RecordStuff Dev identity (or RECORDSTUFF_SIGN_IDENTITY) and verifies it before launch; a missing identity is blocked (exit 2) and a failed signature fails (exit 1), both without launching. About 3 seconds after launch the deferred-quit notification appears; observe the banner and its text. Nothing needs an answer. Exit 0 covers the signed app, lifecycle, the notification's shown event and cleanup; visual acceptance must be recorded separately. Ctrl+C cancels this fixture only.");
} else {
  if (process.platform !== "darwin") throw new Error("This guided native check requires macOS.");
  const language = args[1];
  if (args.length !== 2 || args[0] !== "--language" || !isLanguage(language)) {
    console.error("Use --language en or --language zh-TW (or --help). No app launched.");
    process.exit(2);
  }
  // The observer judges the notification on an awake, unlocked display.
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} No app launched.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = path.join(root, "docs/verification/measurements", `${new Date().toISOString().replace(/[:.]/g, "-")}-quit-dialog-${language}`);
  fs.mkdirSync(dir, { recursive: true });
  const fixture = await buildFixture("quit-dialog", dir);
  const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const tree = workingTreeIdentity(root);
  const provenance = [
    tree ? `Commit ${tree.head}; working tree ${tree.dirty ? `dirty, content ${tree.content}` : "clean"}` : "Commit: unknown (git unavailable)",
    `Electron ${JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version}; pnpm-lock.yaml sha256 ${sha256(path.join(root, "pnpm-lock.yaml"))}`,
    `Fixture ${path.basename(fixture)} sha256 ${sha256(fixture)}`,
  ];
  const abort = new AbortController();
  let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
  const cancel = (name: "SIGINT" | "SIGTERM"): void => { interruptedBy ??= name; abort.abort(); };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  // Unique per round and owned by it: removed after its processes exit, never node_modules or dist/.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-quit-dialog-"));
  const appPath = path.join(temporary, "Electron.app");
  const signaturePath = path.join(dir, "signature.json");
  const timingPath = path.join(dir, "setup-timing.jsonl");
  const setupFd = fs.openSync(path.join(dir, "setup.log"), "w");
  const fd = fs.openSync(path.join(dir, "electron.log"), "w");
  // start-app's verification scratch lands here too, so a killed setup leaves nothing outside the round's directory.
  const setupTmp = path.join(temporary, "tmp");
  fs.mkdirSync(setupTmp);
  /** Evidence a killed process may have left torn reads as missing, never as an exception that skips cleanup. */
  const readJson = (file: string): Record<string, unknown> | undefined => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return undefined; }
  };
  type Run = Partial<Awaited<ReturnType<typeof runIsolatedProcess>>> & { code: number | null };
  let setupRun: Run | undefined;
  let execution: Run | undefined;
  let reported = false;
  console.log(`隔離提示驗收 / Deferred-quit notice check (${language})\n不錄影、不修改正式 App／偏好。先簽署暫存的 Electron.app 副本，約 3 秒後出現延後退出通知。\n觀察通知橫幅與文字；不需要回應。fixture 會確認通知期間 timer 準時，之後解除延遲、檢查檔案並結束。Ctrl+C 可取消本測試。\nEvidence: ${dir}`);
  try {
    const supervise = async (options: Omit<Parameters<typeof runIsolatedProcess>[0], "cwd" | "signal">): Promise<Run> => {
      if (abort.signal.aborted) return { code: null, stopped: "interrupted", groupGone: true };
      try { return await runIsolatedProcess({ ...options, cwd: root, signal: abort.signal }); }
      // A failed supervisor probe is not proof that its owned process group is gone.
      catch (cause) { return { code: null, stopped: "supervisor-error", error: String(cause) }; }
    };
    setupRun = await supervise({ executable: process.execPath, args: [path.join(root, "scripts/start-app.mjs"), "--fixture-app", appPath, signaturePath],
      env: { ...scrubbedEnv(), RECORDSTUFF_TIMING_FILE: timingPath, TMPDIR: setupTmp }, logFd: setupFd, timeoutMs: SETUP_TIMEOUT_MS });
    const phases = (fs.existsSync(timingPath) ? fs.readFileSync(timingPath, "utf8") : "").split("\n").flatMap(line => {
      try { return [JSON.parse(line) as { phase: string; ms: number; ok: boolean }]; } catch { return []; }
    });
    const setupReason = fs.readFileSync(path.join(dir, "setup.log"), "utf8").split("\n").map(line => line.trim())
      .filter(line => line && !line.startsWith("Timing:")).at(-1) ?? "";
    let setup: Layer = classifySetup(setupRun, phases.filter(phase => phase.ok).map(phase => phase.phase), setupReason);
    const signature = readJson(signaturePath);
    const executable = path.join(appPath, "Contents/MacOS/Electron");
    if (setup.status === "pass" && (signature?.appPath !== appPath || !fs.existsSync(executable))) {
      setup = { status: "fail", reason: "Setup reported success without a signature record for this round's copy. No fixture launched." };
    }
    if (signature) {
      const certificate = (signature.certificate ?? {}) as { sha1?: string; name?: string; expires?: string };
      provenance.push(`Bundle ${String(signature.appPath)} (${String(signature.bundleIdentifier)}), copied from ${String(signature.source)}; removed after the round`,
        `Certificate ${certificate.name}, SHA-1 ${certificate.sha1}, expires ${certificate.expires}; ${String(signature.bundles)} bundles verified; ${String(signature.designatedRequirement)}`);
    }
    if (phases.length) provenance.push(`Setup phases: ${phases.map(phase => `${phase.phase} ${(phase.ms / 1000).toFixed(2)} s${phase.ok ? "" : " (failed)"}`).join(", ")}`);

    const notRun = (reason: string): Layer => ({ status: "not run", reason });
    let lifecycle = notRun("No fixture launched: the signed app was not ready.");
    let delivery: DeliveryLayer = notRun("No fixture launched.");
    let result: Record<string, unknown> | undefined;
    // Plan 063, step 6: Notification Center's Accessibility tree, read before launch and while the notice is up.
    const ax = osascriptAx(abort.signal, 5000);
    let bannersBefore: BannerSighting[] = [];
    const bannerPolls: BannerSighting[][] = [];
    let bannerBlocked: string | undefined;
    let polling = false;
    const pollBanners = async (): Promise<void> => {
      while (polling && !abort.signal.aborted) {
        try { bannerPolls.push(await ax.banners()); }
        catch (cause) {
          if (cause instanceof AccessibilityBlockedError) { bannerBlocked = cause.message; return; }
          if (abort.signal.aborted) return;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    };
    let poller: Promise<void> | undefined;
    if (setup.status === "pass") {
      try { bannersBefore = await ax.banners(); } catch (cause) { if (cause instanceof AccessibilityBlockedError) bannerBlocked = cause.message; }
      polling = !bannerBlocked;
      poller = pollBanners();
      execution = await supervise({ executable, args: [fixture, dir, language], env: scrubbedEnv(), logFd: fd, timeoutMs: 40_000, stopSignal: "SIGKILL" });
      polling = false;
      await poller;
      const resultPath = path.join(dir, "result.json");
      result = readJson(resultPath);
      lifecycle = classifyLifecycle(execution, result as Parameters<typeof classifyLifecycle>[1]);
      const eventsPath = path.join(dir, "notification.jsonl");
      delivery = classifyDelivery(parseNotificationEvents(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : ""));
    }
    desktop.end();
    // Remove the signed copy only once nothing that may still run from it is left.
    const setupGroupGone = setupRun.groupGone;
    const fixtureGroupGone = execution?.groupGone;
    if (setupGroupGone && (execution === undefined || fixtureGroupGone)) fs.rmSync(temporary, { recursive: true, force: true });
    const cleanup = classifyCleanup({ setupGroupGone, fixtureGroupGone, forced: !interruptedBy && Boolean(setupRun.forced || execution?.forced), temporaryRemoved: !fs.existsSync(temporary) });
    const other = language === "en" ? "zh-TW" : "en";
    const bannerText = setup.status === "pass"
      ? classifyBannerText({ before: bannersBefore, polls: bannerPolls, expected: translate(DEFERRED_QUIT_MEDIA_MESSAGE, language), otherLanguage: translate(DEFERRED_QUIT_MEDIA_MESSAGE, other), delivery, ...(bannerBlocked ? { blocked: bannerBlocked } : {}) })
      : { status: "not run" as const, reason: "No fixture launched." };
    const layers = { setup, lifecycle, delivery, bannerText, cleanup };
    const verdict = combineVerdict(layers, desktop.lockedAt, interruptedBy);
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({
      automated: verdict.automated, exitCode: verdict.exitCode, layers: { ...layers, visual: VISUAL_PENDING },
      limits: { maxLateMs: MAX_LATE_MS, deliveryWindowMs: DELIVERY_WINDOW_MS, setupTimeoutMs: SETUP_TIMEOUT_MS },
      provenance, signature, setup: setupRun, execution, result, temporary, desktop: desktop.summary, nativeObservation: "not recorded",
    }, null, 2));
    const files = ["report.json", "signature.json", "setup.log", "electron.log", "notification.jsonl", "result.json"].filter(file => fs.existsSync(path.join(dir, file)));
    fs.writeFileSync(path.join(dir, "report.md"), renderReport({ language, layers, verdict, desktop: desktop.summary, provenance, files }));
    reported = true;
    console.log(`${verdict.automated.toUpperCase()}: setup ${setup.status}, lifecycle ${lifecycle.status}, delivery ${delivery.status}, banner text ${bannerText.status}, cleanup ${cleanup.status}. 原生畫面結果仍需另行記錄。\nReport: ${path.join(dir, "report.md")}`);
    process.exitCode = verdict.exitCode;
  } catch (cause) {
    console.error(cause);
  } finally {
    desktop.end();
    fs.closeSync(fd); fs.closeSync(setupFd); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (!reported) {
      // The verdict could not be completed: still remove what this round owns once its processes are gone, and say so.
      if ((setupRun?.groupGone ?? !setupRun) && (execution?.groupGone ?? !execution)) fs.rmSync(temporary, { recursive: true, force: true });
      const retained = fs.existsSync(temporary);
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ automated: "fail", exitCode: 1, error: "The runner could not complete its verdict; see the console.",
        setup: setupRun, execution, temporary, temporaryRetained: retained, provenance }, null, 2));
      console.log(`FAIL: the runner could not complete its verdict.${retained ? ` Retained ${temporary}.` : ""}\nReport: ${path.join(dir, "report.json")}`);
      process.exitCode = 1;
    }
  }
}
