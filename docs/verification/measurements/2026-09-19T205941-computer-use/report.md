# 無人值守快捷鍵路徑 — 開發驗收

本次結果：**blocked**。快捷鍵註冊與啟動證據通過；原生 computer-use 存取遭自動核准拒絕，按鍵未送出，未完成錄影、媒體驗證或播放。這不是快捷鍵功能 fail，也不能據此宣稱 plan 016 已完成。

案例數：**pass 2／fail 0／blocked 10／not run 1**（共 13）。

## 範圍與環境

- 執行時間：2026-09-19 約 20:57–21:01（Asia/Taipei）；報告目錄以 20:59:41 建立時間命名。
- 範圍：[plan 016](../../../../plans/016-recording-hotkey.md)，使用[原生驗收 skill](../../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)的無人值守快捷鍵段落；本執行者未委派。
- macOS 26.6.2（25G83），Darwin arm64；App log 的核心版本為 darwin 25.6.0。RecordStuff 0.1.2，Electron 44.3.0。
- HEAD：`e4b24dbd82e0be6ab0761f39c9b8d98761308f30`，已有未提交 plan 016 實作及文件變更，屬開發驗收。參見 [工作樹記錄](worktree-before.txt)、[環境與素材 SHA256](environment.txt)。工作樹快照取得時本報告目錄已建立；既有 `2026-09-19T205642-computer-use/` 未覆寫。
- App：`/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app`。協調者已於 sandbox 外在同工作樹執行啟動流程，本次未執行 `pnpm start:app`、`pnpm open:app` 或重開／重建指令。
- 原有設定（唯讀）：語言 `zh-TW`，standard／source／60 fps，輸出 `/Users/eric/Movies/RecordStuff`。設定檔為 v2；本次實際註冊組合鍵以 log 為準：`CommandOrControl+Alt+Shift+R`。
- 受控素材未啟動；主螢幕、音訊輸出裝置及音量未能從 UI 確認。未改動設定。

## 案例結果

| 案例 | 操作與預期 | 實際與證據 | 結果 |
| --- | --- | --- | --- |
| 啟動證據 | 讀協調者啟動輸出；確認建置、自簽、驗證、開啟及 ready | [啟動副本](start-app-016.log)記載 Verified 9 bundle identities、正確 executable、Opened、EXIT=0；[本次 log](app-current-launch.log)確認 packaged true、相同路徑及 ready。非 Tray UI 驗收 | pass |
| 快捷鍵註冊 | 本次啟動後應出現 registered | 12:53:54.132Z 註冊 `CommandOrControl+Alt+Shift+R`，沒有 registration failed | pass |
| 動態素材 | Safari 開檔並以 computer use 點擊開始，全螢幕動態素材 | shell 找不到 Safari；getApp 又被拒。Chrome 先前拒絕由使用者提供；兩者均記於[工具證據](tool-evidence.txt)。沒有使用 auto=1 或腳本代按 | blocked |
| 快捷鍵開始 | computer use 送 ⌘⌥⇧R，30 秒內 pressed 與 recording | 已確認 pressKey API 存在並直接嘗試；getApp 拒絕導致無操作物件，`safari is not defined`，按鍵未送出。log 無 pressed／recording；不適用送鍵後 30 秒功能逾時判定 | blocked |
| 快捷鍵停止與存檔 | 約錄 10 秒再送鍵，30 秒內 stopping、idle、saved | 開始受阻，未錄製；未發送第二次組合鍵，沒有新 saved 路徑 | blocked |
| 完整性驗證 | 新 MP4 執行 `pnpm verify -- <path> --json <report-dir>/verify.json` | 報告目錄已建立，但無本次 MP4；未執行 verify，未生成 verify.json，不拿舊錄影替代 | blocked |
| 客觀聲音 | Sample rate/channels 為 48 kHz、2 聲道，各 RMS > −60 dBFS | 無受控音源且無 MP4；Sample rate/channels、左右 RMS 均 n/a，不能判定通過 | blocked |
| QuickTime 播放與截圖 | 開本次影片，computer use 播放、觀察進度、截播放畫面並關閉 | 無 MP4；QuickTime getApp 也被拒，未開檔、播放或截圖 | blocked |
| 語言與保存 | Tray 切換、重開確認保存 | 無人值守路徑排除 Tray；另依使用者要求不重開 App | blocked |
| 顯示最後錄影 | Tray 操作並確認 Finder 定位 | 此路徑無法操作 Tray；Finder 存取亦被拒 | blocked |
| 錄製中選單狀態 | Tray 確認停止、設定鎖定狀態 | 此路徑無法操作 Tray，也未開始錄製 | blocked |
| 更改快捷鍵 | Tray 變更並驗證 | 此路徑無法操作 Tray，沒有變更設定 | blocked |
| 主觀聽感 | 聽取本次影片聲音 | 未錄製、未聽取；未驗 | not run |

## 啟動與 log 證據邊界

[本次 log 片段](app-current-launch.log)只取最後一行 `start: RecordStuff 0.1.2`（2026-09-19T12:53:54.078Z）起的資料。其後為 registered、ready、permission granted，沒有本次錄影狀態或存檔。收尾再次讀取確認內容未增加。

啟動輸出來自使用者指定 `/tmp/start-app-016.log` 的原樣副本，包含 EXIT=0；本執行者未重跑建置。未使用 ps／pgrep；副本身分依啟動證據及本次 executable log 核對，未獨立檢查程序列表。

## 受阻原因與收尾

原生工具 inventory 可用，文件含 `Target.pressKey()`；Safari、Finder、QuickTime Player 的 getApp 均遭自動核准拒絕。由於沒有 Target，直接 pressKey 嘗試未能送鍵。這是操作入口權限阻礙，並非已證明 pressKey 本身遭拒。[完整呼叫及錯誤](tool-evidence.txt)可供後續排查；Chrome 訊息屬使用者提供的先前結果。

未建立任何錄影、素材分頁或播放器視窗，無自己開始的錄影需要停止／存檔。Safari 開檔失敗；初始 inventory 中 QuickTime 已在執行，但其操作被拒，因此未能關閉既有 QuickTime，亦未改動其檔案。RecordStuff 保持原先開啟狀態，未送出結束指令；最後 log 沒有 recording 或 quit。無設定變更需要還原。

未產生 verify.json 或截圖，原因為上述依賴受阻；不建立假證據檔。既有變更與使用者影片皆保留，沒有修改程式、commit、push 或發布。本次僅新增報告證據；未跑 pnpm check（未改應用程式）。

除表列項目，衝突註冊、停用／重啟持久化、過渡狀態重複按鍵、長錄穩定性、音質／聲道分離／同步、首次授權及發布安裝均未驗證；不包含於本次 13 個案例的計數。
