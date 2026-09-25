/** English is the source language; Traditional Chinese is an explicit user choice. */
export type Language = "en" | "zh-TW";
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh-TW";
}

export const ZH_TW = {
  "Recording is still starting, saving or cleaning up. RecordStuff will stay open. Any pending capture will stop when it starts. Please try quitting again after it finishes.": "錄影仍在啟動、存檔或清理中，RecordStuff 將保持開啟。尚在啟動的擷取會在開始後立即停止。完成後請再次嘗試退出。",
  "Could not complete this action. Please try again.": "無法完成此操作，請重試。",
  "This reminder is not saved yet. RecordStuff keeps it and retries automatically. If this continues, check free disk space and access to the app's data folder. A force-quit loses unsaved reminders.": "這項提醒尚未儲存。RecordStuff 會保留它並自動重試；若持續失敗，請檢查可用磁碟空間與 App 資料夾的存取權限。強制結束會遺失尚未儲存的提醒。",
  "The saved failure history could not be read or comes from a newer version, so RecordStuff will not overwrite it. This reminder is kept only until RecordStuff quits.": "已儲存的失敗紀錄無法讀取，或由較新版本建立，因此 RecordStuff 不會覆寫它。這項提醒只會保留到 RecordStuff 結束為止。",
  "The failure history is too large to save. Remove reviewed failures, then retry. Until then this reminder is kept only until RecordStuff quits.": "失敗紀錄過大，無法儲存。請移除已確認的紀錄後重試；在此之前，這項提醒只會保留到 RecordStuff 結束為止。",
  "Saving this change…": "正在儲存這項變更…",
  "Loading failure history…": "正在載入失敗紀錄…",
  "Could not save failure reminders": "無法儲存失敗提醒",
  "Still saving failure reminders": "仍在儲存失敗提醒",
  "Unsaved reminders: {count}": "尚未儲存的提醒：{count} 筆",
  "…and {count} more": "……另有 {count} 筆",
  "If you exit without saving, these reminders are lost and will not appear after RecordStuff restarts. Recording files are not affected.": "若不儲存就結束，這些提醒會遺失，重新啟動 RecordStuff 後不會再出現。錄影檔案不受影響。",
  "The save has not finished. RecordStuff stays open instead of exiting while the history file may still be written.": "儲存尚未完成。紀錄檔可能仍在寫入，因此 RecordStuff 會保持開啟，不會直接結束。",
  "Check free disk space and access to the app's data folder, then retry.": "請檢查可用磁碟空間與 App 資料夾的存取權限後重試。",
  "Retry": "重試",
  "Keep waiting": "繼續等待",
  "Stay in app": "留在 App",
  "Exit without saving these reminders": "不儲存這些提醒並結束",
  "Retry saving reminder": "重新儲存提醒",
  "This is a previous recording failure. Check current recording permissions before trying again.": "這是先前錄影的失敗紀錄。請確認目前的錄影權限後再試。",
  "The output folder could not be written.": "無法寫入輸出資料夾。",
  "Free disk space or choose another output folder before recording again.": "請釋放磁碟空間，或選擇其他輸出資料夾後重新錄影。",
  "Check the output folder, its permissions and the connected drive before recording again.": "請檢查輸出資料夾、存取權限與外接磁碟後重新錄影。",
  "Check recording permissions in System Settings. Relaunch if access was recently granted.": "請在系統設定檢查錄影權限；若剛授權，請重新啟動 App。",
  "Check your recording settings before trying again. Starting again does not recover missing content.": "請檢查錄影設定後再試。重新錄影不會恢復先前遺失的內容。",
  "Processing the recorded data… The file result is not yet confirmed.": "正在處理已錄製的資料……尚未確認檔案結果。",
  "A partial recording was kept. It may not be playable.": "已保留部分錄影，但可能無法播放。",
  "No recording content was kept.": "這次沒有留下錄影內容。",
  "Could not confirm whether recording content was kept. Check the output folder.": "無法確認錄影內容是否保留，請檢查輸出資料夾。",
  "Recording failure": "錄影失敗",
  "Recording failures": "失敗紀錄",
  "Unreviewed recording failures: {value}": "尚未確認的錄影失敗：{value} 筆",
  "View recording failures…": "查看失敗紀錄…",
  "Remove from history": "移除這筆紀錄",
  "Keeps all unreviewed failures and the 20 most recently reviewed failures. Removing a record does not delete the recording file.": "保留所有尚未確認的失敗，以及最近確認的 20 筆紀錄。移除紀錄不會刪除錄影檔案。",
  "Recording failed": "錄影失敗",
  "Show partial recording": "顯示部分檔案",
  "Got it": "知道了",
  "Technical details": "技術詳細資料",
  "Check capture permissions and audio devices before recording again.": "再次錄影前，請檢查擷取權限與音訊裝置。",
  "Recent failure: {reason}": "最近一次失敗：{reason}",
  "Click to view the recording result.": "點此查看錄影結果。",
  "Notifications are off. Recording failures remain visible in the menu bar and Recording failures.": "通知已關閉。錄影失敗仍會顯示於選單列與「失敗紀錄」。",

  "RecordStuff - Settings": "RecordStuff - 設置",
  "{label} — Unavailable": "{label} — 無法使用",
  "Selected display is unavailable": "所選螢幕無法使用",
  "{label} is unavailable, so recording cannot start.": "{label} 目前無法使用，因此無法開始錄影。",
  "Choose Primary display or another available screen.": "請選擇主螢幕或其他可用的螢幕。",
  "Use Primary display": "使用主螢幕",
  "Last recording interrupted": "上次錄影中斷",
  "Last recording failure": "上次錄影失敗",
  "Try recording again using the shortcut or menu, or choose another screen.": "請使用快捷鍵或選單再次錄影，或選擇其他螢幕。",
  "Shortcut unavailable": "快捷鍵無法使用",
  "Recording is still available from the menu. Choose another shortcut.": "仍可從選單操作錄影，請選擇其他快捷鍵。",
  "Built by Eric Tsai": "由 Eric Tsai 製作",
  "Official website": "官方網站",
  "GitHub source": "GitHub 原始碼",
  "Could not open the link. Try again.": "無法開啟連結，請重試。",
  "Confirm": "確定",
  "Confirm to save": "按確定儲存",
  "Press a combination, then Confirm; Esc cancels": "按下組合後，按確定儲存；Esc 取消",
  "Cancel": "取消",
  "Applying…": "正在套用…",
  "Action failed": "操作失敗",
  "Change was not saved": "變更未儲存",
  "Retry save": "重試儲存",
  "Choose the setting again to retry.": "請重新選擇設定後再試一次。",
  "Shortcut saved": "快捷鍵已儲存",
  "Switched to Primary display": "已切換至主螢幕",
  "Could not edit the shortcut. Try again.": "無法編輯快捷鍵，請重試。",

  "The display capture ended unexpectedly. Retry or choose another screen.": "螢幕錄製非預期結束，請重試或選擇其他螢幕。",
  "Screen": "螢幕",
  "Primary display": "主螢幕",
  "Display {id}": "螢幕 {id}",
  "{label} (Primary)": "{label}（主螢幕）",
  "Captures one whole screen. System audio is unaffected.": "錄製一個完整螢幕，不影響系統音訊。",
  "Selected display is unavailable. Choose another screen.": "所選螢幕無法使用，請重新選擇。",
  "Display is connected but its capture source is unavailable. Retry or choose another screen.": "螢幕已連接，但無法取得錄製來源。請重試或選擇其他螢幕。",
  "Display configuration changed. Retry.": "螢幕配置已變更，請重試。",
  "The recording display was removed. Choose another screen.": "錄製中的螢幕已移除，請選擇其他螢幕。",
  "Last display failure: {reason}": "上次螢幕錯誤：{reason}",
  "Ready — {label}": "待命 — {label}",
  "Could not save the screen setting.": "無法儲存螢幕設定。",

  Settings: "設定",
  "Custom shortcut…": "自訂快捷鍵…",
  "Recommended: {shortcut}": "建議：{shortcut}",
  "{shortcut} (custom)": "{shortcut}（自訂）",
  "Appearance": "外觀",
  "System default": "跟隨系統",
  "Light": "淺色",
  "Dark": "深色",
  "Press a combination": "請按下快捷鍵組合",
  "Escape to cancel": "按 Escape 取消",
  "A shortcut needs Command or Control.": "快捷鍵需要包含 ⌘ 或 ⌃。",
  "This key cannot be used.": "無法使用這個按鍵。",
  "macOS reserves this combination.": "macOS 已保留這個組合。",
  "Recording settings": "錄影",
  General: "一般",
  Updates: "更新",
  "Higher quality preserves more detail and uses more space at the same resolution.": "在相同解析度下，較高品質可保留更多細節，也會使用更多儲存空間。",
  "Limits pixel dimensions while keeping the aspect ratio. Smaller sources are not enlarged.": "限制畫面像素尺寸並維持長寬比，不會放大較小的來源畫面。",
  "Right-click to open the menu": "右鍵開啟選單",
  "Recording in progress. Recording settings are locked.": "錄製作業進行中，錄製相關設定暫時鎖定。",
  "Could not apply this setting. Your current settings are shown.": "無法套用這項設定，目前顯示的是實際使用的設定。",
  "Could not open settings. Close this window and open it again.": "無法開啟設定，請關閉這個視窗後再開一次。",
  "Check for updates…": "檢查更新…",
  "Checking for updates…": "正在檢查更新…",
  "Update available: {version}": "有可用更新：{version}",
  "Up to date (checked {time})": "已是最新版本（檢查時間：{time}）",
  "Update check failed — open releases": "更新檢查失敗 — 開啟版本發布頁",
  "Check for updates on launch": "啟動時檢查更新",
  On: "開啟",
  Economy: "精省",
  Standard: "標準",
  High: "高品質",
  Source: "原尺寸",
  "Video quality": "影像品質",
  "Resolution cap": "解析度上限",
  "Frame rate": "幀率",
  "{value} fps (unverified on this platform)": "{value} fps（此平台尚未驗證，暫不開放）",
  Language: "語言",
  "Show log": "顯示 log",
  Quit: "結束",
  "Output folder: {path}": "儲存位置：{path}",
  "Change output folder": "更改儲存位置",
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
  "Saved {file}. Recording stopped early because the disk is almost full.": "已儲存 {file}。磁碟空間即將用盡，已提前停止錄製",
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
  "RecordStuff is ready in the menu bar. Click to start recording; click again to stop.":
    "RecordStuff 在選單列待命。左鍵點圖示開始錄製，再點一下停止",
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
  "Could not write the recording.": "寫入錄影失敗",
  "The disk is full.": "磁碟已滿",
  "Stopping the recording timed out.": "停止錄製逾時",
  "RecordStuff did not exit normally while recording.": "RecordStuff 在錄製期間未正常結束",
  "The recording file may be incomplete. RecordStuff does not repair it, and starting again does not recover missing content.":
    "錄影檔可能不完整。RecordStuff 不會修復它，重新錄影也不會恢復遺失的內容。",
  Shortcut: "快捷鍵",
  "This combination is reserved for Settings.": "這個組合鍵保留給設定使用。",
  "Settings shortcut unavailable: change the recording shortcut through the tray Settings entry.": "設定快捷鍵無法使用：請從選單列開啟設定並變更錄影快捷鍵。",
  "Settings shortcut unavailable: another app may use it. Open Settings from the tray.": "設定快捷鍵無法使用：可能被其他 App 佔用。請從選單列開啟設定。",
  "Unavailable: another app is using this shortcut.": "無法使用：這個快捷鍵被其他 App 佔用。",
  "Start / stop recording with {value}": "以 {value} 開始／停止錄製",
  Off: "關閉",
  "Could not register the shortcut {value}. Another app may be using it. Choose another shortcut in Settings.":
    "無法註冊快捷鍵 {value}，可能被其他 App 佔用。可以在設定視窗改用其他快捷鍵",
  "Could not save the shortcut. Your previous shortcut is still in use.":
    "無法儲存快捷鍵設定，仍使用原本的快捷鍵。請再試一次",
  Notifications: "通知",
  "Shows a notification when a recording is saved or an error occurs.": "錄影儲存完成或發生錯誤時顯示通知。",
  "macOS must also allow RecordStuff in System Settings → Notifications.":
    "macOS 另外還要在「系統設定 → 通知」中允許 RecordStuff。",
  "Could not open System Settings. Allow RecordStuff in System Settings → Privacy & Security → Screen & System Audio Recording.":
    "無法開啟系統設定。請在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」中允許 RecordStuff",
  "Open notification settings…": "開啟通知設定…",
  "Notifications are on. This is what a RecordStuff notification looks like.":
    "通知已開啟，RecordStuff 的通知會像這樣顯示。",
  "Choose a recording folder": "選擇錄影儲存位置",
  "Could not open the output folder": "無法開啟儲存位置",
  "{path} was not found. It may have been moved or deleted, or its drive may be disconnected. Reconnect the drive and try again, or choose another folder.":
    "找不到 {path}。它可能已被移動或刪除，或所在的磁碟未連接。請重新連接磁碟後再試一次，或選擇其他位置。",
  "{path} could not be created because its parent folder {parent} is missing or is not a folder. Restore that folder and try again, or choose another folder.":
    "無法建立 {path}，因為上層資料夾 {parent} 不存在或不是資料夾。請還原該資料夾後再試一次，或選擇其他位置。",
  "{path} is a file, not a folder. Choose another folder.": "{path} 是檔案，不是資料夾。請選擇其他位置。",
  "{path} could not be created. Check the permissions of its parent folder and try again, or choose another folder.":
    "無法建立 {path}。請檢查上層資料夾的權限後再試一次，或選擇其他位置。",
  "RecordStuff does not have permission to open {path}. Check the folder's permissions and try again, or choose another folder.":
    "RecordStuff 沒有開啟 {path} 的權限。請檢查資料夾權限後再試一次，或選擇其他位置。",
  "{path} is unavailable. Check the folder and its drive, then try again, or choose another folder.":
    "{path} 目前無法使用。請檢查資料夾與所在磁碟後再試一次，或選擇其他位置。",
  "{path} could not be opened. Try again, or choose another folder.": "無法開啟 {path}。請再試一次，或選擇其他位置。",
  "Details: {error}": "詳細資訊：{error}",
  "An unexpected error occurred. See the log for details.": "發生未預期的錯誤，請查看 log 取得詳細資訊。",
} as const;

export type MessageKey = keyof typeof ZH_TW;

/** The `{name}` placeholders of a message: `"Saved {file}"` → `"file"`. */
type Placeholders<K extends string> = K extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
/** A message without placeholders; lookup tables of labels use this type. */
export type PlainMessageKey = { [K in MessageKey]: [Placeholders<K>] extends [never] ? K : never }[MessageKey];
/** Every placeholder must receive a value, so a missing one fails to compile instead of showing `{name}`. */
type MessageValues<K extends MessageKey> = [Placeholders<K>] extends [never]
  ? []
  : [values: Readonly<Record<Placeholders<K>, string | number>>];

/** Substitute all placeholders in the selected catalog; never translate diagnostic logs. */
export function translate<K extends MessageKey>(key: K, language?: Language, ...values: MessageValues<K>): string;
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
