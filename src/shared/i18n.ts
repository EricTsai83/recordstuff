/** English is the source language; Traditional Chinese is an explicit user choice. */
export type Language = "en" | "zh-TW";
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh-TW";
}

export const ZH_TW = {
  "Retry shortcut registration": "重試註冊快捷鍵",
  "The shortcut is still unavailable; another app may be using it.": "快捷鍵仍無法使用，可能被其他 App 佔用。",
  "Could not confirm the resolution cap. The recording may be larger.": "無法確認解析度上限，錄影尺寸可能較大。",
  "Could not read the failure history. The file was kept; see the log.": "無法讀取失敗紀錄，原檔已保留，詳見 log。",
  "Show more failures": "顯示更多失敗紀錄",
  "Recording is still starting, saving or cleaning up, so RecordStuff stays open. A recording that has not started is cancelled. Try Quit or Relaunch again when it finishes.": "錄影仍在啟動、存檔或清理中，RecordStuff 會保持開啟；尚未開始的錄影會取消。完成後請再按一次結束或重新啟動。",
  "Settings or the log are still being written, so RecordStuff stays open. Try Quit or Relaunch again in a moment.": "設定或 log 仍在寫入，RecordStuff 會保持開啟。請稍後再按一次結束或重新啟動。",
  "Could not complete this action. Try again.": "無法完成此操作，請重試。",
  "This record is not saved yet; RecordStuff keeps retrying. If this continues, check free disk space and access to the app's data folder. Force-quitting loses unsaved records.": "這筆紀錄尚未存檔，RecordStuff 會自動重試。若持續失敗，請檢查磁碟空間與 App 資料夾的存取權限。強制結束會遺失未存檔的紀錄。",
  "The saved failure history is unreadable or from a newer version, so RecordStuff will not overwrite it. This record is kept only until RecordStuff quits.": "已儲存的失敗紀錄無法讀取或來自較新版本，RecordStuff 不會覆寫。這筆紀錄只保留到 RecordStuff 結束。",
  "The failure history is too large to save. Remove reviewed failures, then retry; until then this record is kept only until RecordStuff quits.": "失敗紀錄過大，無法儲存。請移除已確認的紀錄後重試；在此之前，這筆紀錄只保留到 RecordStuff 結束。",
  "Saving this change…": "正在儲存這項變更…",
  "Loading failure history…": "正在載入失敗紀錄…",
  "Could not save failure records": "無法儲存失敗紀錄",
  "Still saving failure records": "仍在儲存失敗紀錄",
  "Unsaved records: {count}": "未存檔的紀錄：{count} 筆",
  "…and {count} more": "……另有 {count} 筆",
  "Exiting without saving loses these records. Recording files are not affected.": "不儲存就結束會遺失這些紀錄，錄影檔案不受影響。",
  "The save has not finished, so RecordStuff stays open.": "儲存尚未完成，RecordStuff 會保持開啟。",
  "Check free disk space and access to the app's data folder, then retry.": "請檢查磁碟空間與 App 資料夾的存取權限後重試。",
  "Retry": "重試",
  "Keep waiting": "繼續等待",
  "Stay in app": "留在 App",
  "Exit without saving": "不儲存並結束",
  "Retry saving the record": "重試儲存紀錄",
  "This failure is from an earlier session. Check recording permissions before trying again.": "這是先前的失敗紀錄，請先確認目前的錄影權限再試。",
  "The output folder could not be written.": "無法寫入儲存位置",
  "Free disk space or choose another output folder before recording again.": "請釋放磁碟空間，或選擇其他儲存位置後重新錄影。",
  "Check the output folder, its permissions and the connected drive before recording again.": "請檢查儲存位置、存取權限與外接磁碟後重新錄影。",
  "Check recording permissions in System Settings. Relaunch if access was recently granted.": "請在系統設定檢查錄影權限；若剛授權，請重新啟動 App。",
  "Check your recording settings, then try again. Missing content cannot be recovered.": "請檢查錄影設定後再試。遺失的內容無法恢復。",
  "Update macOS, then record again.": "請更新 macOS 後再錄影。",
  "Processing the recording…": "正在處理錄影…",
  "A partial recording was kept; it may not play.": "已保留部分錄影，可能無法播放。",
  "No recording was kept.": "沒有保留錄影內容。",
  "Could not confirm whether anything was kept. Check the output folder.": "無法確認是否保留了錄影，請檢查儲存位置。",
  "Recording failures": "失敗紀錄",
  Failures: "失敗紀錄",
  "Failures ({count})": "失敗紀錄（{count}）",
  "Recording failures, {count} unread": "失敗紀錄，{count} 筆未確認",
  "No recording failures.": "沒有失敗紀錄。",
  Today: "今天",
  Yesterday: "昨天",
  // The visually hidden prefix of an unread row's name, with each language's own separator.
  "Unread, ": "未確認，",
  "Unreviewed recording failures: {value}": "尚未確認的錄影失敗：{value} 筆",
  "View recording failures…": "查看失敗紀錄…",
  "Remove from history": "移除這筆紀錄",
  "Keeps unreviewed failures and the {count} most recently reviewed. Removing a record does not delete its file.": "保留所有未確認的失敗與最近確認的 {count} 筆。移除紀錄不會刪除錄影檔。",
  "Recording failed": "錄影失敗",
  "Show partial recording": "顯示部分錄影",
  "Got it": "知道了",
  "Technical details": "技術詳細資料",
  "Check capture permissions and audio devices before recording again.": "再次錄影前，請檢查擷取權限與音訊裝置。",
  "Click for details.": "點此查看詳情。",
  "Failures still appear in the menu bar and the Failures tab.": "失敗仍會顯示在選單列與「失敗紀錄」分頁。",
  "Failures still appear in the system tray and the Failures tab.": "失敗仍會顯示在系統匣與「失敗紀錄」分頁。",

  "{label} — Unavailable": "{label} — 無法使用",
  "Selected display is unavailable": "所選螢幕無法使用",
  "Recording cannot start on {label}.": "無法在 {label} 開始錄影。",
  "Choose Primary display or another screen.": "請選擇主螢幕或其他螢幕。",
  "Use Primary display": "使用主螢幕",
  "Last recording interrupted": "上次錄影中斷",
  "Last recording failure": "上次錄影失敗",
  "Shortcut unavailable": "快捷鍵無法使用",
  "Record from the menu, or choose another shortcut.": "可從選單錄影，或選擇其他快捷鍵。",
  "Built by Eric Tsai": "由 Eric Tsai 製作",
  "Version {version}": "版本 {version}",
  "Ready to record": "隨時可以錄影",
  Recordings: "錄影檔",
  "Loading recordings…": "正在載入錄影…",
  "Could not read the output folder. Check the folder and its drive, or choose another folder.": "無法讀取儲存位置。請檢查資料夾與所在磁碟，或選擇其他位置。",
  "1 recording · {size}": "1 個錄影・{size}",
  "{count} recordings · {size}": "{count} 個錄影・{size}",
  "No recordings yet": "還沒有錄影",
  "Recordings saved to {path} appear here.": "儲存在 {path} 的錄影會顯示在這裡。",
  "Play {title}": "播放 {title}",
  "Open": "開啟",
  "Move to Trash": "丟到垃圾桶",
  "Move to Recycle Bin": "移到資源回收筒",
  "Moved to the Trash": "已丟到垃圾桶",
  "Moved to the Recycle Bin": "已移到資源回收筒",
  "Close": "關閉",
  "Drag into another app to share.": "拖曳到其他 App 即可分享。",
  "This recording is no longer in the folder.": "這個錄影已不在資料夾中。",
  "This recording cannot be played here. Choose Open from its ⋯ menu to play it in another app.": "無法在這裡播放這段錄影，可從它的「⋯」選單選「開啟」改用其他 App 播放。",
  "More actions for {title}": "{title} 的更多動作",
  "About {size} per minute at {width} × {height}, {fps} fps.": "每分鐘約 {size}（{width} × {height}、{fps} fps）。",
  "Official website": "官方網站",
  "GitHub source": "GitHub 原始碼",
  "Could not open the link. Try again.": "無法開啟連結，請重試。",
  "Confirm": "確定",
  "Confirm to save": "按確定儲存",
  "Press a combination and Confirm within 15 seconds; Esc cancels": "請在 15 秒內按下組合並確定；Esc 取消",
  "Timed out after 15 seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.": "已超過 15 秒，快捷鍵未變更。請選擇「自訂快捷鍵…」再試一次。",
  "Cancel": "取消",
  "Applying…": "正在套用…",
  "Action failed": "操作失敗",
  "Change was not saved": "變更未儲存",
  "Retry save": "重試儲存",
  "Choose the setting again to retry.": "請重新選擇設定後再試一次。",
  "Shortcut saved": "快捷鍵已儲存",
  "Switched to Primary display": "已切換至主螢幕",
  "Could not edit the shortcut. Try again.": "無法編輯快捷鍵，請重試。",

  "Screen capture ended unexpectedly. Retry or choose another screen.": "螢幕錄影非預期結束，請重試或選擇其他螢幕。",
  "Screen": "螢幕",
  "Primary display": "主螢幕",
  "Display {id}": "螢幕 {id}",
  "{label} (Primary)": "{label}（主螢幕）",
  "Selected display is unavailable. Choose another screen.": "所選螢幕無法使用，請選擇其他螢幕。",
  "The display's capture source is unavailable. Retry or choose another screen.": "無法取得這個螢幕的錄影來源，請重試或選擇其他螢幕。",
  "Display configuration changed. Retry.": "螢幕配置已變更，請重試。",
  "The recording display was removed. Choose another screen.": "錄影中的螢幕已移除，請選擇其他螢幕。",
  "Last display failure: {reason}": "上次螢幕錯誤：{reason}",
  "Ready — {label}": "待命 — {label}",
  "Could not save the screen setting.": "無法儲存螢幕設定。",

  "Custom shortcut…": "自訂快捷鍵…",
  "Editing ended; the shortcut is unchanged.": "已結束編輯，快捷鍵未變更。",
  "Recommended: {shortcut}": "建議：{shortcut}",
  "{shortcut} (custom)": "{shortcut}（自訂）",
  "Appearance": "外觀",
  "System default": "跟隨系統",
  "Light": "淺色",
  "Dark": "深色",
  "Press a combination": "請按下快捷鍵組合",
  "Escape to cancel": "按 Escape 取消",
  "A shortcut needs Command or Control.": "快捷鍵需要包含 Command 或 Control。",
  "A shortcut needs Ctrl.": "快捷鍵需要包含 Ctrl。",
  "This key cannot be used.": "無法使用這個按鍵。",
  "macOS reserves this combination.": "macOS 已保留這個組合。",
  "Other apps use this combination.": "其他 App 會使用這個組合。",
  "Recording settings": "錄影設定",
  "Recording resolution": "錄影解析度",
  General: "一般",
  Updates: "更新",
  "Manual check": "手動檢查",
  "Source and output": "來源與輸出",
  "Before recording": "錄影開始前",
  Video: "影像",
  "Language and appearance": "語言與外觀",
  "Higher quality keeps more detail but makes larger files.": "品質越高，細節越多，檔案也越大。",
  "Scales larger screens down, keeping the aspect ratio. Smaller ones are not enlarged.": "縮小超過上限的畫面並保持長寬比，不會放大較小的畫面。",
  "Right-click to open the menu": "右鍵開啟選單",
  "Click to open the menu": "按一下開啟選單",
  "RecordStuff is ready in the menu bar. Click its icon and choose Start recording.": "RecordStuff 在選單列待命。點圖示並選「開始錄影」即可開始。",
  "RecordStuff is ready in the system tray. Click its icon and choose Start recording.": "RecordStuff 在系統匣待命。點圖示並選「開始錄影」即可開始。",
  "Icon click": "點擊圖示",
  "Open the menu": "開啟選單",
  "Start / stop recording": "開始／停止錄影",
  "A right click always opens the menu.": "按右鍵一律開啟選單。",
  "Controls and notifications": "操作與通知",
  "Choose Cancel recording from the menu bar icon, or press the shortcut.": "從選單列圖示選「取消錄影」，或按快捷鍵即可取消。",
  "Choose Cancel recording from the menu bar icon.": "從選單列圖示選「取消錄影」即可取消。",
  "Choose Cancel recording from the system tray icon, or press the shortcut.": "從系統匣圖示選「取消錄影」，或按快捷鍵即可取消。",
  "Choose Cancel recording from the system tray icon.": "從系統匣圖示選「取消錄影」即可取消。",
  "Recording in progress; only language and appearance can change.": "錄影中，只能變更語言與外觀。",
  "Could not apply this setting. Your current settings are shown.": "無法套用此設定，已顯示目前的設定。",
  "Could not open settings. Close this window and open it again.": "無法開啟設定，請關閉這個視窗後再開一次。",
  "Check for updates…": "檢查更新…",
  "Checking for updates…": "正在檢查更新…",
  "Version {version} is available.": "有可用的新版本：{version}。",
  "RecordStuff {version} is available. Click to open the download page.": "RecordStuff {version} 已推出，按一下開啟下載頁。",
  "Download {version}…": "下載 {version}…",
  "Up to date (checked {time})": "已是最新版本（檢查時間：{time}）",
  "Could not check for updates.": "無法檢查更新。",
  "Open releases page…": "開啟版本發布頁…",
  "Check for updates on launch": "啟動時檢查更新",
  On: "開啟",
  Economy: "精省",
  Standard: "標準",
  High: "高品質",
  Source: "原尺寸",
  "Video quality": "影像品質",
  "Resolution cap": "解析度上限",
  "Frame rate": "幀率",
  "{value} fps (unverified on this platform)": "{value} fps（此平台未驗證）",
  Language: "語言",
  "Show log": "顯示 log",
  "Log file": "記錄檔（log）",
  Troubleshooting: "疑難排解",
  "Open RecordStuff": "開啟 RecordStuff",
  "The shortcut for RecordStuff is the recording shortcut: open RecordStuff above to change it.": "開啟 RecordStuff 的快捷鍵與錄影快捷鍵相同：請從上方開啟 RecordStuff 更改。",
  "The shortcut for RecordStuff is unavailable: another app may use it. Open RecordStuff above.": "開啟 RecordStuff 的快捷鍵無法使用，可能被其他 App 佔用。請從上方開啟 RecordStuff。",
  // Gone from the menu since 2026-10-04: kept for the tray runner, which checks it stays gone (scripts/lib/tray-driver.mts).
  "Output folder: {path}": "儲存位置：{path}",
  "Start recording": "開始錄影",
  "Quit RecordStuff": "結束 RecordStuff",
  "Change output folder…": "更改儲存位置…",
  "Output folder": "儲存位置",
  "Change…": "更改…",
  "Show in Finder": "在 Finder 中顯示",
  "Open folder": "開啟資料夾",
  "Change output folder": "更改儲存位置",
  "Open System Settings": "開啟系統設定",
  Relaunch: "重新啟動",
  "Already allowed? Relaunch RecordStuff": "已經允許了？重新啟動 RecordStuff",
  "If capture still fails after you allow access, relaunch RecordStuff.":
    "允許權限後若仍無法擷取，請重新啟動 RecordStuff。",
  "Screen recording permission required": "需要螢幕錄製權限",
  "Output folder unavailable": "儲存位置無法使用",
  Ready: "待命中",
  // Gone from the menu since 2026-10-04: kept for the tray runner, which checks it stays gone (scripts/lib/tray-driver.mts).
  "Show last recording": "顯示最後一個錄影",
  "Starting… Check for system permission prompts": "啟動中，請留意系統權限提示…",
  Recording: "錄影中",
  Stop: "停止",
  "Saving…": "儲存中…",
  "Recording starts in {seconds} s": "{seconds} 秒後開始錄影",
  "Recording starts in {seconds} s. Click to cancel.": "{seconds} 秒後開始錄影，按一下即可取消。",
  "Cancel recording": "取消錄影",
  "Quitting once the recording is saved or cleaned up…": "錄影存檔或清理完成後即結束…",
  "Cancel recording with {value}": "以 {value} 取消錄影",
  "Saved {file}": "已儲存 {file}",
  "Saved {file}. Stopped early: the disk is almost full.": "已儲存 {file}。磁碟空間即將用盡，已提前停止錄影。",
  "Saved {file}. Stopped because the Mac went to sleep.": "已儲存 {file}。Mac 進入睡眠，已停止錄影。",
  "Saved {file}. Stopped because the computer went to sleep.": "已儲存 {file}。電腦進入睡眠，已停止錄影。",
  "RecordStuff cannot capture the screen. Allow screen recording in System Settings, then click to relaunch.":
    "RecordStuff 無法擷取螢幕。請在系統設定允許螢幕錄製，再點這則通知重新啟動。",
  "RecordStuff needs screen recording access. Click to open System Settings.":
    "RecordStuff 需要螢幕錄製權限，點此開啟系統設定。",
  "Could not change the output folder. Try choosing {path} again.":
    "無法變更儲存位置，請再選一次 {path}。",
  "A recording started, so the output folder is unchanged. Choose {path} again after it ends.":
    "錄影已開始，儲存位置未變更。錄影結束後請再選一次 {path}。",
  "Could not save recording quality. Your previous settings are still in use.":
    "無法儲存錄影品質設定，仍使用原本的選項。",
  "Could not save the language. Your previous language is still in use.":
    "無法儲存語言設定，仍使用原本的語言。",
  "The system cannot provide {requested} fps, so this recording uses {actual} fps.":
    "系統無法提供 {requested} fps，本次以 {actual} fps 錄影。",
  "RecordStuff is ready in the system tray. Click to start recording; click again to stop.":
    "RecordStuff 在系統匣待命。左鍵點圖示開始錄影，再點一下停止。",
  "RecordStuff is ready in the menu bar. Click to start recording; click again to stop.":
    "RecordStuff 在選單列待命。左鍵點圖示開始錄影，再點一下停止。",
  "This system cannot capture system audio. Mac requires macOS 13 or newer.":
    "這個系統版本不支援擷取系統音訊，Mac 需要 macOS 13 以上",
  "No display is available for recording.": "找不到可以錄影的螢幕",
  "System audio was unavailable at start, so nothing was recorded.": "開始時無法取得系統音訊，未錄到任何內容",
  "Heavy load can block system audio: close demanding apps and try again. If it keeps happening, allow RecordStuff in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch.":
    "系統負載過重時可能無法取得系統音訊：請關閉耗資源的 App 後再試。若持續發生，請在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」允許 RecordStuff，然後重新啟動。",
  "System audio comes from the default playback device. Check that one is connected and enabled in Windows sound settings, then try again.":
    "系統音訊取自預設的播放裝置。請確認已連接播放裝置，並在 Windows 音效設定中啟用後再試。",
  "MP4 recording is not supported on this computer.": "這台電腦不支援 MP4 錄影",
  "Could not start recording.": "無法開始錄影",
  "Recording was interrupted.": "錄影中斷",
  "The recording process crashed.": "錄影程序當機",
  "The recording process is not responding.": "錄影程序沒有回應",
  "Could not write the recording.": "寫入錄影失敗",
  "The disk is full.": "磁碟已滿",
  "Stopping the recording timed out.": "停止錄影逾時",
  "RecordStuff did not exit normally while recording.": "RecordStuff 在錄影期間未正常結束",
  "The recording file may be incomplete; missing content cannot be recovered.":
    "錄影檔可能不完整，遺失的內容無法恢復。",
  Shortcut: "快捷鍵",
  "This combination is reserved for Settings.": "這個組合鍵保留給設定使用。",
  "Another app may be using this shortcut.": "這個快捷鍵可能被其他 App 佔用。",
  "The shortcut for RecordStuff is unavailable": "開啟 RecordStuff 的快捷鍵無法使用",
  "Another app may be using {shortcut}.": "{shortcut} 可能被其他 App 佔用。",
  "Open RecordStuff from the menu bar icon, or retry once the other app releases it.": "可從選單列圖示開啟 RecordStuff，或待其他 App 釋放後重試。",
  "Open RecordStuff from the system tray icon, or retry once the other app releases it.": "可從系統匣圖示開啟 RecordStuff，或待其他 App 釋放後重試。",
  "{shortcut} is the recording shortcut, so it does not open Settings.": "{shortcut} 已是錄影快捷鍵，不會開啟設定。",
  "Choose another recording shortcut to open Settings with {shortcut} again.": "選擇其他錄影快捷鍵後，即可再用 {shortcut} 開啟設定。",
  "Start / stop recording with {value}": "以 {value} 開始／停止錄影",
  Off: "關閉",
  Countdown: "倒數",
  "{value} s": "{value} 秒",
  "Click the menu bar icon or press the shortcut to cancel.": "按一下選單列圖示或按快捷鍵即可取消。",
  "Click the menu bar icon to cancel.": "按一下選單列圖示即可取消。",
  "Click the system tray icon or press the shortcut to cancel.": "按一下系統匣圖示或按快捷鍵即可取消。",
  "Click the system tray icon to cancel.": "按一下系統匣圖示即可取消。",
  "Countdown sound": "倒數音效",
  "The tick is not recorded.": "提示音不會被錄進影片。",
  "More about {label}": "{label}的說明",
  "Could not register {value}; another app may be using it. Choose another shortcut in Settings.":
    "無法註冊 {value}，可能被其他 App 佔用。請在設定改用其他快捷鍵。",
  "Could not save the shortcut. Your previous shortcut is still in use.":
    "無法儲存快捷鍵設定，仍使用原本的快捷鍵。",
  Notifications: "通知",
  "macOS must also allow RecordStuff in System Settings → Notifications.":
    "macOS 另外還要在「系統設定 → 通知」中允許 RecordStuff。",
  "Could not open System Settings. Allow RecordStuff in System Settings → Privacy & Security → Screen & System Audio Recording.":
    "無法開啟系統設定。請在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」中允許 RecordStuff。",
  "Could not open System Settings. Allow RecordStuff in System Settings → Notifications.":
    "無法開啟系統設定。請在「系統設定 → 通知」中允許 RecordStuff。",
  "Open notification settings…": "開啟通知設定…",
  "Notifications are on. This is what a RecordStuff notification looks like.":
    "通知已開啟，RecordStuff 的通知會像這樣。",
  "Choose a recording folder": "選擇錄影儲存位置",
  "Could not open the output folder": "無法開啟儲存位置",
  "{path} was not found. It may have been moved or deleted, or its drive disconnected. Try again or choose another folder.":
    "找不到 {path}，可能已被移動、刪除，或所在磁碟未連接。請再試一次或選擇其他位置。",
  "Could not create {path}: {parent} is missing or not a folder. Restore it and try again, or choose another folder.":
    "無法建立 {path}：{parent} 不存在或不是資料夾。請還原後再試，或選擇其他位置。",
  "{path} is a file, not a folder. Choose another folder.": "{path} 是檔案，不是資料夾。請選擇其他位置。",
  "Could not create {path}. Check its parent folder's permissions, or choose another folder.":
    "無法建立 {path}。請檢查上層資料夾的權限，或選擇其他位置。",
  "No permission to open {path}. Check the folder's permissions, or choose another folder.":
    "沒有開啟 {path} 的權限。請檢查資料夾權限，或選擇其他位置。",
  "{path} is unavailable. Check the folder and its drive, or choose another folder.":
    "{path} 無法使用。請檢查資料夾與所在磁碟，或選擇其他位置。",
  "{path} could not be opened. Try again, or choose another folder.": "無法開啟 {path}。請再試一次，或選擇其他位置。",
  "Details: {error}": "詳細資訊：{error}",
  "An unexpected error occurred. See the log for details.": "發生未預期的錯誤，詳見 log。",
  "Quit or relaunch postponed: recording work is pending. Try again when it finishes.": "錄影工作仍在進行，暫不結束或重新啟動；完成後請再試一次。",
  "Quit or relaunch postponed: settings or the log are being written. Try again in a moment.": "設定或 log 仍在寫入，暫不結束或重新啟動；請稍後再試。",
} as const;

export type MessageKey = keyof typeof ZH_TW;

/**
 * Joins independent messages into one line: English messages end in their own
 * period and are separated by a space; Traditional Chinese ones are closed with
 * 。 when they do not end in sentence punctuation, and follow each other directly.
 * Failure reasons omit that 。 because they also appear as headings.
 */
export function sentences(parts: readonly string[], language: Language = DEFAULT_LANGUAGE): string {
  if (language === "zh-TW") return parts.map(part => /[。！？]$/.test(part) ? part : `${part}。`).join("");
  return parts.map(part => /[.!?…]$/.test(part) ? part : `${part}.`).join(" ");
}

/** Joins the parts of one name or line, such as a day and a time, with each language's comma: "Today, 2:02 PM", 「今天，下午2:02」. */
export function phrases(parts: readonly string[], language: Language = DEFAULT_LANGUAGE): string {
  return parts.join(language === "zh-TW" ? "，" : ", ");
}

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
