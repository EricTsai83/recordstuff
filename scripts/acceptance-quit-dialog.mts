/** Guided deferred-quit notice check (plan 055). Never interprets a shown event as visual acceptance. */
import fs from "node:fs";
import { scrubbedEnv } from "./lib/runner-env.mts";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./lib/build-fixture.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";
import { isLanguage } from "../src/shared/i18n.ts";

/** A 1 s timer late by this much means something held main while the notice was up; unheld it is a few ms. */
const MAX_LATE_MS = 500;
const args = process.argv.slice(2).filter(arg => arg !== "--");
if (args.length === 1 && args[0] === "--help") {
  console.log("pnpm acceptance:quit-dialog -- --language en|zh-TW\nIsolated synthetic data; no recording. About 3 seconds after launch the deferred-quit notification appears; observe the banner and its text. Nothing needs an answer: the fixture checks that its timers stay on time while the notice is up, then saves and exits. Visual acceptance must be recorded separately. Ctrl+C cancels this fixture only.");
} else {
  if (process.platform !== "darwin") throw new Error("This guided native check requires macOS.");
  const language = args[1];
  if (args.length !== 2 || args[0] !== "--language" || !isLanguage(language)) {
    throw new Error("Use --language en or --language zh-TW (or --help). No app launched.");
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
  const env = scrubbedEnv();
  const abort = new AbortController();
  const cancel = (): void => abort.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const fd = fs.openSync(path.join(dir, "electron.log"), "w");
  console.log(`隔離提示驗收 / Deferred-quit notice check (${language})\n不錄影、不修改正式 App／偏好。約 3 秒後出現延後退出通知。\n觀察通知橫幅與文字；不需要回應。fixture 會確認通知期間 timer 準時，之後解除延遲、檢查檔案並結束。Ctrl+C 可取消本測試。\nEvidence: ${dir}`);
  try {
    let execution: Partial<Awaited<ReturnType<typeof runIsolatedProcess>>>;
    try {
      execution = await runIsolatedProcess({ executable: createRequire(import.meta.url)("electron") as string,
        args: [fixture, dir, language], cwd: root, env, logFd: fd, timeoutMs: 40_000, stopSignal: "SIGKILL", signal: abort.signal });
    } catch (cause) {
      // A failed supervisor probe is not proof that its owned process group is gone.
      execution = { code: null, stopped: "supervisor-error", error: String(cause) };
    }
    const resultPath = path.join(dir, "result.json");
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : undefined;
    desktop.end();
    const passed = execution.code === 0 && !execution.stopped && !execution.forced && execution.groupGone && result?.prompts === 1 && result?.deferred === 1
      && typeof result?.maxLateMs === "number" && result.maxLateMs < MAX_LATE_MS;
    const automated = desktop.lockedAt ? "blocked" : passed ? "pass" : "fail";
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ execution, result, automated, desktop: desktop.summary, nativeObservation: "not recorded" }, null, 2));
    fs.writeFileSync(path.join(dir, "report.md"), `# Deferred-quit notice (${language})\n\nAutomated lifecycle: ${automated.toUpperCase()}.\nTimers while the notice was up: late by at most ${result?.maxLateMs ?? "unknown"} ms (limit ${MAX_LATE_MS} ms).\n${desktop.summary}\nNative banner/readability observation: **not recorded**. A shown event is not visual proof.\n\nSource: isolated synthetic fixture using production feedback; not a signed normal-bundle capture test.\nCleanup: groupGone=${execution.groupGone ?? "unknown"}, forced=${execution.forced ?? "unknown"}, stopped=${execution.stopped ?? "none"}.\nDetails: [report.json](report.json), [electron.log](electron.log).\n`);
    console.log(`${automated.toUpperCase()}: lifecycle/timers/cleanup. 原生畫面結果仍需另行記錄。\nReport: ${path.join(dir, "report.md")}`);
    if (desktop.lockedAt) process.exitCode = DESKTOP_BLOCKED_EXIT;
    else if (!passed) process.exitCode = 1;
  } finally {
    fs.closeSync(fd); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
