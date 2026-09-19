# 計畫 016 開發驗收：無人值守快捷鍵路徑

結論：未通過。原生 Computer Use 已可控制 Chrome，正確產物建置與快捷鍵註冊成功；送出 ⌘⌥⇧R 後超過 30 秒未出現 pressed 或 recording。無本次 MP4，停止／存檔、verify 與 QuickTime 播放受阻。這是觀察到的端到端案例失敗，尚不能確定根因在 Computer Use 按鍵投遞、macOS 或 App。

## 範圍與環境

- 驗收時間：2026-09-19 21:33 起；使用者結束既有副本後，21:46–21:49 接續（Asia/Taipei）。模式：開發驗收、無人值守快捷鍵路徑。
- macOS 26.6.2（25G83）、arm64、Apple M1 Pro；RecordStuff 0.1.2、Electron 44.3.0。
- HEAD：`e4b24dbd82e0be6ab0761f39c9b8d98761308f30`。有既有未提交變更，見 [工作樹基準](git-status-before.txt)；未修改程式、未委派、未 commit、push 或發布。
- 本次產物：`/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app`。唯讀 pgrep 確認 PID 64159 的執行路徑為該 bundle 內 `Contents/MacOS/RecordStuff`。
- 原設定：繁體中文、standard、source、60 fps；輸出 `/Users/eric/Movies/RecordStuff`。設定檔 version 2，啟動時採預設快捷鍵；未改動設定。
- 素材：專案 `scripts/test-material.html`，版本以 [SHA-256](material-sha256.txt) 固定；Chrome 原生 UI 開啟 file URL，未使用 auto 參數或腳本點擊。
- [裝置查詢](devices.txt) 未能取得音訊端點、音量或顯示器細節；主螢幕素材位置未獨立確認。App log 顯示可見 2 個螢幕。這些準備資訊不足保留為限制，沒有据此推論音訊或捕捉通過。

## 案例結果

| 案例 | 操作與預期 | 實際 | 狀態與證據 |
| --- | --- | --- | --- |
| 原生 Computer Use | 取得 Chrome 並操作素材 | 原生 AX、點擊、鍵盤、截圖可用 | pass；見下方 UI 證據 |
| 正確產物啟動 | 使用者結束舊副本，執行 pnpm start:app | EXIT=0；9 個 bundle identity 驗證通過，程序路徑符合 | pass；[建置紀錄](start-app.log)、[本次 log](app-session.log) |
| 快捷鍵註冊 | 新啟動 log 出現 registered | 13:47:12.045Z 註冊 CommandOrControl+Alt+Shift+R | pass；[本次 log](app-session.log) |
| 素材啟動 | 原生點擊 Click to start audio and enter fullscreen | AX 顯示音訊播放中，畫面時間從 0.368 前進至 39.803 秒 | pass；UI 觀察，未代表錄到聲音 |
| 快捷鍵開始錄製 | Chrome 前景用 pressKey 送出 super+alt+shift+r，30 秒內 recording | API 未報錯，但超過 30 秒仍無 pressed、starting、recording；未重複連按 | fail；[本次 log](app-session.log)、[UI 觀察](ui-observations.md) |
| 快捷鍵停止與存檔 | 再按快捷鍵並觀察 stopping、idle、saved | 未開始錄製，未送出第二次快捷鍵 | blocked |
| 客觀聲音與完整性 | pnpm verify 新 MP4，檢查 48 kHz、2 聲道、每聲道 RMS > −60 dBFS | 無本次 MP4，未執行 verify，無 RMS 證據 | blocked |
| QuickTime 播放 | 打開新 MP4，以原生 UI 播放並觀察進度 | 無本次 MP4，未操作播放器 | blocked |
| 語言與保存 | Tray 切換並重開驗證 | 此路徑無可用 Tray 介面 | blocked |
| 顯示最後錄影 | Tray 操作 Finder | 此路徑無可用 Tray 介面 | blocked |
| 錄製中選單狀態 | Tray 狀態與鎖定項目 | 此路徑無可用 Tray 介面 | blocked |
| 更改快捷鍵 | Tray 操作設定 | 此路徑無可用 Tray 介面 | blocked |
| 主觀聽感 | 人耳確認 | 未聆聽 | not run |

合計 pass 4、fail 1、blocked 7、not run 1。通過範圍僅限工具操作、建置啟動、註冊與素材啟動；不代表錄影功能通過。

## 失敗重現與證據

1. 舊副本的原生 App 介面回傳 `-10005 timeoutReached`。使用者回覆「已結束」後才執行 pnpm start:app；先前停點保存在 [前置受阻紀錄](preflight-blocked.md)。
2. 21:47:12 本次 App 啟動、註冊快捷鍵並 ready，權限顯示 granted。
3. Chrome 新分頁打開固定素材，以原生 click 點擊開始；進入全螢幕，頁面時間與動態方塊正常前進。
4. 素材約 4.704 秒時執行 `chrome.pressKey('super+alt+shift+r')`，其後重新取得 AX。工具未報錯。
5. 持續查看本次啟動之後 log；素材約 39.803 秒時再次截圖，即送鍵後約 35 秒。沒有 pressed 或錄製状态，最後 log 仍為 permission granted。按 skill 的 30 秒上限判 fail，未用重新計時或其他自動化重試。
6. 原生截圖已在 Computer Use 回覆中觀察；本次工具文件只提供回傳影像 bytes／emit，未提供可確認的檔案保存介面，因此未虛構 screenshot 檔案路徑。另有文字化 [UI 觀察](ui-observations.md)。

## 收尾與未驗項

已用 Escape 退出素材全螢幕、⌘W 關閉本次素材分頁，重新取得 AX 確認不再包含 RecordStuff test material。沒有本次錄影要停止或保存，沒有刪除或修改使用者既有影片；Chrome 其他分頁保留。RecordStuff 本次產物保持開啟，log 仍為 ready 後未進入錄製。未操作 Safari、Finder 或 QuickTime。

未測：實際螢幕／系統音訊捕捉、停止與存檔、完整性與 RMS、播放、主觀聽感、Tray 案例、快捷鍵衝突／停用／持久化、首次授權、長時間穩定、聲道分離、音質、同步及發布安裝。未修改應用程式，故未執行 pnpm check；報告連結與 git diff --check 已檢查。未更新發布記錄或移除計畫 016。
