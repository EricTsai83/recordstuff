/** Test-only Electron host. Production renderer/preload, isolated state, never displays or focuses a window. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { prepareDataCleanup } = require(process.env.RECORDSTUFF_UI_CLEANUP);
const { installQuitCoordinator } = require(process.env.RECORDSTUFF_UI_QUIT);
globalThis.cleanupChoices = 0;
const root = process.cwd();
app.setPath("userData", process.env.RECORDSTUFF_UI_DATA);
app.setPath("sessionData", process.env.RECORDSTUFF_UI_DATA);
app.dock?.hide();
const choice = (id, label, checked = false) => ({
  id,
  label,
  checked,
  enabled: true,
});
let view = {
  language: "en",
  title: "RecordStuff",
  hint: "",
  failure: "Could not apply this setting.",
  revision: 1,
  tabs: [
    { id: "library", label: "Recordings" },
    { id: "recording", label: "Recording settings" },
    { id: "general", label: "General" },
    { id: "failures", label: "Failures (1)" },
  ],
  groups: [
    {
      id: "countdownSound",
      tab: "recording",
      label: "Countdown sound",
      enabled: true,
      control: "switch",
      info: "The tick is not recorded.",
      choices: [choice("on", "On", true), choice("off", "Off")],
    },
    {
      id: "fileName",
      tab: "recording",
      label: "File name format",
      enabled: true,
      control: "text",
      choices: [choice("{date} {time}", "Default", true)],
    },
    {
      id: "language",
      tab: "general",
      label: "Language",
      enabled: true,
      control: "segmented",
      choices: [choice("en", "English", true), choice("zh-TW", "繁體中文")],
    },
    {
      id: "appearance",
      tab: "general",
      label: "Appearance",
      enabled: true,
      control: "segmented",
      iconChoices: true,
      choices: [
        choice("system", "System default", true),
        choice("light", "Light"),
        choice("dark", "Dark"),
      ],
    },
  ],
  recordingResults: [
    {
      id: "failure",
      reason: "The disk is full.",
      day: "Today",
      time: "2:05 PM",
      outcome: "No recording was kept.",
      guidance: "Free disk space.",
      detail: "ENOSPC",
      acknowledged: false,
      actions: [choice("acknowledge", "Got it")],
    },
    {
      id: "earlier",
      reason: "The recording could not start.",
      day: "Yesterday",
      time: "1:00 PM",
      outcome: "No recording was kept.",
      guidance: "Try again.",
      acknowledged: true,
      actions: [choice("remove", "Remove from history")],
    },
  ],
  library: {
    folder: "~/Movies",
    items: ["a", "b"].map((id) => ({
      id,
      day: "Today",
      name: `${id}.mp4`,
      title: id,
      time: "2:02 PM",
      duration: "1:23",
      size: "1 MB",
      thumbnail: "",
      video: "",
    })),
  },
};
let window;
let zoom = 1;
function changeZoom(request) {
  const steps = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
  zoom = request === "reset" ? 1 : request === "in"
    ? steps.find(step => step > zoom + 0.001) ?? 1.5
    : [...steps].reverse().find(step => step < zoom - 0.001) ?? 0.8;
  window.webContents.setZoomFactor(zoom);
  window.webContents.send("settings:zoom-changed", { factor: zoom, canZoomIn: zoom < 1.5, canZoomOut: zoom > 0.8 });
}
ipcMain.handle("settings:zoom", (_event, request) => changeZoom(request));
app.on("fixture:zoom", (_event, request) => changeZoom(request));
app.on("fixture:set", (next) => {
  view = { ...next, revision: view.revision + 1 };
  window.webContents.send("settings:changed", view);
});
ipcMain.handle("settings:read", () => view);
ipcMain.handle("settings:ready", () => {});
ipcMain.handle("settings:capture", () => view);
ipcMain.handle("settings:choose", (_event, group, value) => {
  let renamed;
  if (group === "localData" && value === "clear") {
    globalThis.cleanupChoices += 1;
    return { view, applied: true }; // Controlled cancellation; native consent has its own production tests.
  }
  if (group === "library") view.library.layout = value;
  else if (group.startsWith("recordingFile:")) {
    const id = group.slice("recordingFile:".length),
      item = view.library.items.find((item) => item.id === id);
    if (value?.action === "rename") {
      renamed = `${id}-renamed`;
      item.id = renamed;
      item.title = value.name;
      item.name = value.name + ".mp4";
    }
  } else if (group.startsWith("recordingResult:")) {
    view.recordingResults[0].acknowledged = true;
    view.recordingResults[0].actions = [
      choice("remove", "Remove from history"),
    ];
  } else {
    const setting = view.groups.find((setting) => setting.id === group);
    setting.choices =
      setting.control === "text"
        ? [choice(value, value, true)]
        : setting.choices.map((item) => ({
            ...item,
            checked: item.id === value,
          }));
    if (group === "language") view.language = value;
  }
  view = { ...view, revision: view.revision + 1 };
  return { view, applied: true, ...(renamed ? { renamed } : {}) };
});
void app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 800,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(root, "out/preload/settings.js"),
      contextIsolation: true,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setAudioMuted(true);
  window.webContents.setZoomMode("isolated");
  await window.loadFile(path.join(root, "out/renderer/settings.html"));
});
app.on("window-all-closed", () => app.quit());
app.on("fixture:cleanup", async ({ profile, output, logs }) => {
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, "recordstuff.log"), "log");
  // Exercise real Electron shutdown and the production admission hook. The
  // Chromium profile remains in use until app.quit completes.
  const quit = installQuitCoordinator(app, {
    shutdown: async () => { await window.webContents.session.cookies.set({ url: "https://fixture.local", name: "test", value: "private" }); return true; },
    pending() {}, error: error => { console.error(error); },
    beforeExit: () => prepareDataCleanup({ userData: profile, sessionData: app.getPath("sessionData"), logs, outputDir: output, media: [], parentPid: process.pid }),
  });
  quit.quit();
});
