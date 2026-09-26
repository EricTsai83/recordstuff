/**
 * Frame-cadence diagnostic main process (plan 041); never shipped. One
 * recording of the primary display through the production main-side
 * `CaptureHost`, the built capture-host preload and the real renderer host
 * (wrapped by `frame-cadence-renderer.ts`), answered like the app answers
 * display-media requests: primary screen plus system-audio loopback. Chunks
 * are appended to `recording.mp4`; the renderer's observations, the capture
 * report and every host message go to `result.json`. Launched by
 * `scripts/diagnose-frame-cadence.mts` through `open -a Electron.app`, so the
 * development Electron.app's screen-recording grant applies.
 */
import { BrowserWindow, app, desktopCapturer, screen, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { CaptureHost } from "../../src/main/capture-host";
import type { HostMessage } from "../../src/shared/protocol";
import type { QualitySettings } from "../../src/shared/quality";

interface FixtureConfig {
  seconds: number;
  quality: QualitySettings;
  request: { ideal?: number; max?: number } | null;
  preloadPath: string;
  rendererScript: string;
}

const SESSION_ID = "cadence";

async function main(): Promise<void> {
  const dir = process.argv[2]!;
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as FixtureConfig;
  const logFile = path.join(dir, "fixture.log");
  const log = (line: string): void => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  app.setPath("userData", path.join(dir, "user-data"));
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  app.dock?.hide();

  const primary = screen.getPrimaryDisplay();
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const source = sources.find((candidate) => candidate.display_id === String(primary.id));
      log(`display media: ${source ? `primary ${source.display_id}` : "primary display not among sources"}`);
      if (source) callback({ video: source, audio: "loopback" });
      else (callback as () => void)();
    });
  }, { useSystemPicker: false });

  const hostDir = path.join(dir, "host");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.copyFileSync(config.rendererScript, path.join(hostDir, "frame-cadence-renderer.js"));
  fs.writeFileSync(path.join(hostDir, "config.js"), `window.__cadenceConfig = ${JSON.stringify({ request: config.request })};\n`);
  fs.writeFileSync(path.join(hostDir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'" />
<title>RecordStuff frame-cadence diagnostic</title></head>
<body><script src="./config.js"></script><script src="./frame-cadence-renderer.js"></script></body></html>
`);

  const output = fs.openSync(path.join(dir, "recording.mp4"), "w");
  const messages: { at: string; type: string; detail?: unknown }[] = [];
  let started: Extract<HostMessage, { type: "prepared" }> | undefined;
  let bytes = 0;
  let settle!: (outcome: string) => void;
  const settled = new Promise<string>((resolve) => { settle = resolve; });
  let begin!: () => void;
  const began = new Promise<void>((resolve) => { begin = resolve; });
  let prepared: Extract<HostMessage, { type: "prepared" }> | undefined;
  const host = new CaptureHost({ preloadPath: config.preloadPath, htmlPath: path.join(hostDir, "index.html"), log });
  host.onMessage((message) => {
    const at = new Date().toISOString();
    if (message.type === "chunk") {
      const chunk = new Uint8Array(message.bytes);
      fs.writeSync(output, chunk);
      bytes += chunk.byteLength;
      return;
    }
    // The host prepares first; this diagnostic starts encoding at once, like the countdown Off.
    if (message.type === "prepared") {
      messages.push({ at, type: message.type, detail: message.capture });
      prepared = message;
      try { host.record(SESSION_ID); } catch (cause) { begin(); settle(`record threw ${String(cause)}`); }
      return;
    }
    if (message.type === "started") {
      started = prepared;
      messages.push({ at, type: message.type });
      begin();
      return;
    }
    messages.push({ at, type: message.type, ...(message.type === "error" ? { detail: `${message.code}: ${message.detail}` } : {}) });
    if (message.type === "error") { begin(); settle(`error ${message.code}: ${message.detail}`); }
    if (message.type === "stopped") settle("stopped");
  });
  host.onFailure((code, detail) => { begin(); settle(`host failure ${code}: ${detail}`); });

  const timeout = (ms: number, what: string): Promise<string> => new Promise((resolve) => setTimeout(() => resolve(`timed out ${what}`), ms));
  let outcome: string;
  try {
    await host.start(SESSION_ID, config.quality);
    const startOutcome = await Promise.race([began.then(() => "began"), timeout(15_000, "waiting for started")]);
    if (!started) outcome = startOutcome === "began" ? await settled : startOutcome;
    else {
      log(`recording ${config.seconds} s`);
      await new Promise((resolve) => setTimeout(resolve, config.seconds * 1000));
      host.stop(SESSION_ID);
      outcome = await Promise.race([settled, timeout(15_000, "waiting for stopped")]);
    }
  } catch (cause) {
    outcome = `start threw ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  fs.closeSync(output);
  const window = BrowserWindow.getAllWindows()[0];
  const probe: unknown = window && !window.isDestroyed()
    ? JSON.parse(await window.webContents.executeJavaScript("JSON.stringify(window.__cadence ?? null)") as string)
    : null;
  host.destroy();
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    outcome, bytes, capture: started?.capture, mimeType: started?.mimeType, messages, probe,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    display: { id: primary.id, size: primary.size, scaleFactor: primary.scaleFactor, displayFrequency: primary.displayFrequency },
  }, null, 2));
  log(`done: ${outcome}; ${bytes} bytes`);
  app.quit();
}

void main().catch((cause: unknown) => {
  fs.appendFileSync(path.join(process.argv[2] ?? ".", "fixture.log"), `${new Date().toISOString()} fatal: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  app.exit(1);
});
