/** English is the source language; Traditional Chinese is an explicit user choice. */
export type Language = "en" | "zh-TW";
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh-TW";
}

export const ZH_TW = {
  Economy: "精省",
  Standard: "標準",
  High: "高品質",
  Source: "原尺寸",
  "Recording quality": "錄製品質",
  "Video quality: {value}": "影像品質：{value}",
  "Resolution cap: {value}": "解析度上限：{value}",
  "Frame rate: {value} fps": "幀率：{value} fps",
  "{value} fps (unverified on this platform)": "{value} fps（此平台尚未驗證，暫不開放）",
  Language: "語言",
  "Show log": "顯示 log",
  Quit: "結束",
  "Output folder: {path}": "儲存位置：{path}",
  "Change output folder…": "更改儲存位置…",
  "Open System Settings": "開啟系統設定",
  Relaunch: "重新啟動",
  "Already allowed? Relaunch RecordStuff": "已經允許了？重新啟動 RecordStuff",
  "After allowing access in System Settings, relaunch RecordStuff if this process still cannot capture.":
    "在系統設定允許之後，如果目前程序仍無法擷取，請重新啟動 RecordStuff。",
  "Screen recording permission required": "需要螢幕錄製權限",
  "Output folder unavailable": "儲存位置無法使用",
  Ready: "待命中",
  "Show last recording": "顯示最後一個錄影",
  "Starting… Check for system permission prompts": "啟動中，請留意系統權限提示…",
  Recording: "錄製中",
  Stop: "停止",
  "Saving…": "儲存中…",
  "Saved {file}": "已儲存 {file}",
  "Screen recording access was granted, but RecordStuff needs to relaunch. Click to relaunch.":
    "已取得螢幕錄製權限，但需要重新啟動 RecordStuff。點這則通知重新啟動",
  "RecordStuff needs screen recording access. Click to open System Settings.":
    "RecordStuff 需要螢幕錄製權限，點這則通知開啟系統設定",
  "Could not save settings. The output folder is unchanged. Try choosing {path} again.":
    "無法儲存設定，儲存位置仍是原本的資料夾。想改成 {path} 請再試一次",
  "Could not save recording quality. Your previous settings are still in use.":
    "無法儲存錄製品質設定，仍使用原本的選項。請再試一次",
  "Could not save the language. Your previous language is still in use.":
    "無法儲存語言設定，仍使用原本的語言。請再試一次",
  "The system provides {actual} fps. This recording uses {actual} fps (requested {requested} fps).":
    "系統只提供 {actual} fps，本次以 {actual} fps 錄製（設定為 {requested} fps）",
  "RecordStuff is ready in the system tray. Click to start recording; click again to stop.":
    "RecordStuff 在系統匣待命。左鍵點圖示開始錄製，再點一下停止",
  "Partial recording kept: {file}. Click to show the file.": "已保留部分錄影：{file}。點這則通知顯示檔案",
  "No content was recorded.": "沒有錄到任何內容",
  "Screen recording access is missing. Open System Settings from the tray menu.":
    "沒有螢幕錄製權限，無法開始錄製。右鍵選單可以開啟系統設定",
  "Screen recording access was granted, but RecordStuff needs to relaunch. Use the tray menu.":
    "已取得螢幕錄製權限，但需要重新啟動 RecordStuff。右鍵選單可以重新啟動",
  "This system version does not support system audio capture. macOS 13 or newer is required on Mac.":
    "這個系統版本不支援錄製系統音訊，Mac 需要 macOS 13 以上",
  "No display is available for recording.": "找不到可以錄製的螢幕",
  "System audio is unavailable. On macOS, allow RecordStuff in System Settings > Privacy & Security > Screen & System Audio Recording.":
    "拿不到系統音訊，沒有開始錄製。macOS 請確認「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」已允許 RecordStuff",
  "MP4 recording is not supported on this computer.": "這台電腦的錄製元件不支援 MP4，沒有開始錄製",
  "Could not start recording.": "無法開始錄製",
  "Recording was interrupted.": "錄製中斷",
  "The recording process crashed.": "錄製程序當機",
  "The recording process is not responding.": "錄製程序沒有回應",
  "Cannot write to {path}. Choose another output folder from the tray menu.":
    "儲存位置無法寫入：{path}。右鍵選單可以更改儲存位置",
  "Could not write the recording.": "寫入錄影失敗",
  "The disk is full.": "磁碟已滿",
  "Stopping the recording timed out.": "停止錄製逾時",
  "Choose a recording folder": "選擇錄影儲存位置",
  "An unexpected error occurred. See the log for details.": "發生未預期的錯誤，請查看 log 取得詳細資訊。",
} as const;

export type MessageKey = keyof typeof ZH_TW;

/** Substitute all placeholders in the selected catalog; never translate diagnostic logs. */
export function translate(
  key: MessageKey,
  language: Language = DEFAULT_LANGUAGE,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const template = language === "zh-TW" ? ZH_TW[key] : key;
  return template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
