/**
 * Pure projection of `RecordingState` onto tray icon, title and menu
 * (plans/001-first-version.md §8 table). No Electron import so the table is unit-testable;
 * `tray.ts` turns this model into real `Tray` / `Menu` calls.
 */
import path from "node:path";
import {
  isFrameRateAvailable,
  type FrameRate,
  type QualitySettings,
  type ResolutionCap,
  type VideoQuality,
} from "../shared/quality";
import type { ErrorCode, RecordingState } from "../shared/state";

export type TrayIcon = "idle" | "recording";

export type TrayAction =
  | "openPermissionSettings"
  | "relaunch"
  | "stop"
  | "revealLastSaved"
  | "openOutputDir"
  | "changeOutputDir"
  | "revealLog"
  | "quit"
  /** One radio choice in the「錄製品質」submenu (plan 007 §B1). */
  | { setQuality: Partial<QualitySettings> };

export type TrayMenuItem =
  | { kind: "separator" }
  | { kind: "item"; label: string; enabled: boolean; action?: TrayAction; toolTip?: string }
  /** Exactly one radio item is `checked`; the group is the whole submenu. */
  | { kind: "radio"; label: string; enabled: boolean; checked: boolean; action: TrayAction }
  | { kind: "submenu"; label: string; enabled: boolean; items: TrayMenuItem[] };

export interface TrayModel {
  icon: TrayIcon;
  /** Text next to the icon; macOS only (`tray.setTitle`). */
  title: string;
  tooltip: string;
  menu: TrayMenuItem[];
}

export interface TrayContext {
  platform: NodeJS.Platform;
  outputDir: string;
  homeDir: string;
  /** The effective quality for this platform (a Windows file storing 60 fps shows 30). */
  quality: QualitySettings;
}

export const VIDEO_QUALITY_LABELS: Record<VideoQuality, string> = {
  economy: "精省",
  standard: "標準",
  high: "高品質",
};

export const RESOLUTION_CAP_LABELS: Record<ResolutionCap, string> = {
  "1080p": "1080p",
  "1440p": "1440p",
  "4k": "4K",
  source: "原尺寸",
};

const QUALITY_MENU_LABEL = "錄製品質";

export const APP_NAME = "RecordStuff";

/** `/Users/eric/Movies/RecordStuff` → `~/Movies/RecordStuff`. */
export function abbreviateHome(filePath: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length === 0) return filePath;
  if (filePath === home) return "~";
  const sep = filePath.startsWith(home + "/") ? "/" : filePath.startsWith(home + "\\") ? "\\" : "";
  return sep ? `~${sep}${filePath.slice(home.length + 1)}` : filePath;
}

function disabled(label: string): TrayMenuItem {
  return { kind: "item", label, enabled: false };
}

function item(label: string, action: TrayAction, toolTip?: string): TrayMenuItem {
  return toolTip === undefined
    ? { kind: "item", label, enabled: true, action }
    : { kind: "item", label, enabled: true, action, toolTip };
}

const SEPARATOR: TrayMenuItem = { kind: "separator" };
/**
 * Every menu ends with these two (plans/002-file-logging.md): the log is the
 * only way a user of a window-less app can find out why something failed, so
 * it stays reachable in every state; revealing it has no effect on a recording.
 */
const FOOTER: TrayMenuItem[] = [{ kind: "separator" }, item("顯示 log", "revealLog"), item("結束", "quit")];

function outputDirItems(ctx: TrayContext, enabled: boolean): TrayMenuItem[] {
  // Electron menu tooltips exist only on macOS, so both platforms show the
  // `~`-abbreviated path in the label; macOS additionally gets the full path
  // as a tooltip.
  const label = `儲存位置：${abbreviateHome(ctx.outputDir, ctx.homeDir)}`;
  const open: TrayMenuItem = enabled
    ? item(label, "openOutputDir", ctx.outputDir)
    : { kind: "item", label, enabled: false, toolTip: ctx.outputDir };
  const change: TrayMenuItem = enabled
    ? item("更改儲存位置…", "changeOutputDir")
    : disabled("更改儲存位置…");
  return [open, change];
}

function radioGroup<K extends keyof QualitySettings>(
  key: K,
  current: QualitySettings[K],
  choices: readonly QualitySettings[K][],
  label: (choice: QualitySettings[K]) => string,
  available: (choice: QualitySettings[K]) => boolean = () => true,
): TrayMenuItem[] {
  return choices.map((choice) => ({
    kind: "radio",
    label: label(choice),
    enabled: available(choice),
    checked: choice === current,
    action: { setQuality: { [key]: choice } as Partial<QualitySettings> },
  }));
}

/**
 * 「錄製品質」: four nested single-choice submenus, each labelled with its
 * current value so the whole configuration is readable without opening them.
 * Only offered while idle / needsPermission; a recording keeps the snapshot
 * it started with, so the other states show the entry greyed out.
 */
function qualityMenu(ctx: TrayContext): TrayMenuItem {
  const q = ctx.quality;
  const frameRateLabel = (fps: FrameRate): string =>
    isFrameRateAvailable(fps, ctx.platform) ? `${fps} fps` : `${fps} fps（此平台尚未驗證，暫不開放）`;
  return {
    kind: "submenu",
    label: QUALITY_MENU_LABEL,
    enabled: true,
    items: [
      {
        kind: "submenu",
        label: `影像品質：${VIDEO_QUALITY_LABELS[q.videoQuality]}`,
        enabled: true,
        items: radioGroup("videoQuality", q.videoQuality, ["economy", "standard", "high"], (v) => VIDEO_QUALITY_LABELS[v]),
      },
      {
        kind: "submenu",
        label: `解析度上限：${RESOLUTION_CAP_LABELS[q.resolutionCap]}`,
        enabled: true,
        items: radioGroup("resolutionCap", q.resolutionCap, ["1080p", "1440p", "4k", "source"], (v) => RESOLUTION_CAP_LABELS[v]),
      },
      {
        kind: "submenu",
        label: `幀率：${q.frameRate} fps`,
        enabled: true,
        items: radioGroup("frameRate", q.frameRate, [30, 60], frameRateLabel, (fps) => isFrameRateAvailable(fps, ctx.platform)),
      },
    ],
  };
}

const QUALITY_LOCKED: TrayMenuItem = disabled(QUALITY_MENU_LABEL);

export function trayModel(state: RecordingState, ctx: TrayContext): TrayModel {
  switch (state.type) {
    case "needsPermission":
      return {
        icon: "idle",
        title: "",
        tooltip: `${APP_NAME}：需要螢幕錄製權限`,
        menu: [
          disabled("需要螢幕錄製權限"),
          state.needsRelaunch ? item("重新啟動", "relaunch") : item("開啟系統設定", "openPermissionSettings"),
          SEPARATOR,
          ...outputDirItems(ctx, true),
          qualityMenu(ctx),
          ...FOOTER,
        ],
      };
    case "idle": {
      const menu: TrayMenuItem[] = [
        disabled(state.outputDirUnavailable ? "儲存位置無法使用" : "待命中"),
      ];
      if (state.lastSavedPath) {
        menu.push(item("顯示最後一個錄影", "revealLastSaved", state.lastSavedPath));
      }
      menu.push(SEPARATOR, ...outputDirItems(ctx, true), qualityMenu(ctx), ...FOOTER);
      return {
        icon: "idle",
        title: "",
        tooltip: state.outputDirUnavailable ? `${APP_NAME}：儲存位置無法使用` : `${APP_NAME}：待命中`,
        menu,
      };
    }
    case "starting":
      return {
        icon: "idle",
        title: "…",
        tooltip: `${APP_NAME}：啟動中…`,
        menu: [disabled("啟動中…"), SEPARATOR, QUALITY_LOCKED, ...FOOTER],
      };
    case "recording":
      return {
        icon: "recording",
        title: "REC",
        tooltip: `${APP_NAME}：錄製中`,
        menu: [
          disabled("錄製中"),
          item("停止", "stop"),
          SEPARATOR,
          ...outputDirItems(ctx, false),
          QUALITY_LOCKED,
          ...FOOTER,
        ],
      };
    case "stopping":
      return {
        icon: "idle",
        title: "…",
        tooltip: `${APP_NAME}：儲存中…`,
        menu: [disabled("儲存中…"), SEPARATOR, QUALITY_LOCKED, ...FOOTER],
      };
  }
}

export interface NotificationText {
  title: string;
  body: string;
}

export function savedNotification(savedPath: string): NotificationText {
  return { title: APP_NAME, body: `已儲存 ${path.basename(savedPath)}` };
}

export function permissionNotification(needsRelaunch: boolean): NotificationText {
  return needsRelaunch
    ? { title: APP_NAME, body: "已取得螢幕錄製權限，但需要重新啟動 RecordStuff。點這則通知重新啟動" }
    : { title: APP_NAME, body: "RecordStuff 需要螢幕錄製權限，點這則通知開啟系統設定" };
}

export function settingsWriteFailedNotification(chosenDir: string, homeDir: string): NotificationText {
  return {
    title: APP_NAME,
    body: `無法儲存設定，儲存位置仍是原本的資料夾。想改成 ${abbreviateHome(chosenDir, homeDir)} 請再試一次`,
  };
}

export function qualityWriteFailedNotification(): NotificationText {
  return { title: APP_NAME, body: "無法儲存錄製品質設定，仍使用原本的選項。請再試一次" };
}

/** Plan 007: a clear frame-rate downgrade is shown, not just logged. */
export function frameRateDowngradeNotification(requested: FrameRate, actual: number): NotificationText {
  return {
    title: APP_NAME,
    body: `系統只提供 ${actual} fps，本次以 ${actual} fps 錄製（設定為 ${requested} fps）`,
  };
}

export function trayHintNotification(): NotificationText {
  return { title: APP_NAME, body: "RecordStuff 在系統匣待命。左鍵點圖示開始錄製，再點一下停止" };
}

/** One plain sentence per error code (plans/001-first-version.md §13). */
export function errorNotification(
  code: ErrorCode,
  detail: string,
  partialPath: string | undefined,
  ctx: Pick<TrayContext, "homeDir" | "outputDir">,
): NotificationText {
  const kept = partialPath
    ? `已保留部分錄影：${path.basename(partialPath)}。點這則通知顯示檔案`
    : "沒有錄到任何內容";
  const why = detail ? `（${detail}）` : "";
  const body = ((): string => {
    switch (code) {
      case "permission_denied":
        return "沒有螢幕錄製權限，無法開始錄製。右鍵選單可以開啟系統設定";
      case "permission_needs_relaunch":
        return "已取得螢幕錄製權限，但需要重新啟動 RecordStuff。右鍵選單可以重新啟動";
      case "unsupported_os_version":
        return "這個系統版本不支援錄製系統音訊，需要 macOS 13 或 Windows 10 20H2 以上";
      case "no_display":
        return `找不到可以錄製的螢幕${why}`;
      case "no_audio_track":
        return "拿不到系統音訊，沒有開始錄製。macOS 請確認「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」已允許 RecordStuff";
      case "mp4_unsupported":
        return "這台電腦的錄製元件不支援 MP4，沒有開始錄製";
      case "capture_start_failed":
        return `無法開始錄製${why}。${kept}`;
      case "capture_failed":
        return `錄製中斷${why}。${kept}`;
      case "capture_host_crashed":
        return `錄製程序當機。${kept}`;
      case "capture_host_unresponsive":
        return `錄製程序沒有回應。${kept}`;
      case "output_open_failed":
        return `儲存位置無法寫入：${abbreviateHome(ctx.outputDir, ctx.homeDir)}。右鍵選單可以更改儲存位置`;
      case "output_write_failed":
        return `寫入錄影失敗${why}。${kept}`;
      case "disk_full":
        return `磁碟已滿。${kept}`;
      case "stop_timeout":
        return `停止錄製逾時。${kept}`;
    }
  })();
  return { title: APP_NAME, body };
}
