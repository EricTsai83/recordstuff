/** Guided native dialog check. Never interprets dismissal as visual acceptance. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./lib/build-fixture.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { isLanguage } from "../src/shared/i18n.ts";

const args = process.argv.slice(2).filter(arg => arg !== "--");
if (args.length === 1 && args[0] === "--help") {
  console.log("pnpm acceptance:quit-dialog -- --language en|zh-TW\nIsolated synthetic data; no recording. Switch to another app during the 5-second countdown. Observe the native dialog and dismiss it within 30 seconds. Visual acceptance must be recorded separately. Ctrl+C cancels this fixture only.");
} else {
  if (process.platform !== "darwin") throw new Error("This guided native check requires macOS.");
  const language = args[1];
  if (args.length !== 2 || args[0] !== "--language" || !isLanguage(language)) {
    throw new Error("Use --language en or --language zh-TW (or --help). No app launched.");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = path.join(root, "docs/verification/measurements", `${new Date().toISOString().replace(/[:.]/g, "-")}-quit-dialog-${language}`);
  fs.mkdirSync(dir, { recursive: true });
  const fixture = await buildFixture("quit-dialog", dir);
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD", "NODE_OPTIONS"]) delete env[key];
  const abort = new AbortController();
  const cancel = (): void => abort.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const fd = fs.openSync(path.join(dir, "electron.log"), "w");
  console.log(`隔離提示驗收 / Native dialog check (${language})\n不錄影、不修改正式 App／偏好。5 秒內切換到另一個 App。\n觀察提示是否置前、文字完整且只有一個；30 秒內按提示按鈕關閉。\n之後自動解除延遲、檢查檔案並結束。Ctrl+C 可取消本測試。\nEvidence: ${dir}`);
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
    const passed = execution.code === 0 && !execution.stopped && !execution.forced && execution.groupGone && result?.prompts === 1 && result?.deferred === 1;
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ execution, result, automated: passed ? "pass" : "fail", nativeObservation: "not recorded" }, null, 2));
    fs.writeFileSync(path.join(dir, "report.md"), `# Deferred-quit native dialog (${language})\n\nAutomated lifecycle: ${passed ? "PASS" : "FAIL"}.\nNative foreground/readability/single-dialog observation: **not recorded**. Dismissal is not visual proof.\n\nSource: isolated synthetic fixture using production feedback; not a signed normal-bundle capture test.\nCleanup: groupGone=${execution.groupGone ?? "unknown"}, forced=${execution.forced ?? "unknown"}, stopped=${execution.stopped ?? "none"}.\nDetails: [report.json](report.json), [electron.log](electron.log).\n`);
    console.log(`${passed ? "PASS" : "FAIL"}: lifecycle/cleanup. 原生畫面結果仍需另行記錄。\nReport: ${path.join(dir, "report.md")}`);
    if (!passed) process.exitCode = 1;
  } finally {
    fs.closeSync(fd); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
