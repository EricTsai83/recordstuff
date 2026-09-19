# 計畫 016 開發驗收：無人值守快捷鍵路徑

狀態：blocked，等待使用者正常結束既有 RecordStuff 副本。本次未完成錄影驗收，不能作為發布通過證據。

## 範圍與環境

- 開始時間：2026-09-19 21:33（Asia/Taipei）。驗收 ⌘⌥⇧R 開始／停止錄製；未委派、未修改程式、未 commit、push 或發布。
- macOS 26.6.2（25G83）、arm64、Apple M1 Pro；package.json 版本 0.1.2。
- HEAD：`e4b24dbd82e0be6ab0761f39c9b8d98761308f30`。已有未提交變更，見 [工作樹基準](git-status-before.txt)，本次保留所有既有變更。
- 既有程序：PID 65413，`/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff`。已透過 sandbox 外唯讀 `pgrep` 確認；尚未執行本次 `pnpm start:app`。
- 唯讀設定：繁體中文、standard、source、60 fps；輸出 `/Users/eric/Movies/RecordStuff`。設定檔 version 2；本次未修改。
- 固定素材：[SHA-256](material-sha256.txt)。尚未開始播放；瀏覽器為 Google Chrome。
- [裝置查詢](devices.txt) 受 sandbox 可見性限制，沒有列出音訊端點與顯示器；音量與實際輸出裝置尚未確認。

## 案例結果

| 案例 | 操作與預期 | 實際與證據 | 狀態 |
| --- | --- | --- | --- |
| 原生 Computer Use 可用 | 取得 Chrome 原生介面 | `cua.getApp('com.google.Chrome')` 成功取得視窗 AX 與截圖 | pass |
| 正確產物啟動 | 確認既有副本狀態、正常結束後執行 pnpm start:app | 專案 App 的 `getApp` 回傳 `Computer Use server error -10005: timeoutReached`；已請使用者從選單結束，pgrep 仍顯示 PID 65413 | blocked |
| 本次快捷鍵註冊 | 新啟動 log 出現 registered | 尚未重建／啟動，沒有本次 log | blocked |
| 快捷鍵開始錄製 | 素材播放後由原生按鍵 API 送出組合鍵 | 未送出快捷鍵 | blocked |
| 快捷鍵停止與存檔 | 再次按鍵後 stopping、idle、saved | 本次未建立錄影 | blocked |
| 客觀聲音與完整性 | 對新 MP4 執行 pnpm verify 並核對每聲道 RMS | 無本次 MP4，未執行 verify | blocked |
| QuickTime 播放 | 原生操作播放並觀察進度 | 無本次 MP4 | blocked |
| 語言與保存 | Tray 切換並重新啟動驗證 | 此路徑不操作 Tray | blocked |
| 顯示最後錄影 | Tray 開啟 Finder | 此路徑不操作 Tray | blocked |
| 錄製中選單狀態 | Tray 狀態與鎖定項目 | 此路徑不操作 Tray | blocked |
| 更改快捷鍵 | Tray 設定操作 | 此路徑不操作 Tray | blocked |
| 主觀聽感 | 人耳確認聲音 | 未聆聽 | not run |

共 pass 1、fail 0、blocked 10、not run 1；pass 僅表示 Chrome 原生控制可用，並非錄影通過。

## 工具觀察與阻礙

1. 原生 App inventory 沒有 RecordStuff 一般視窗；未因此認定啟動失敗。
2. 以 bundle ID 取得 App 時，工具列出多份同 ID 的副本；改用上列專案產物完整路徑，於約 8.8 秒回傳 `-10005 timeoutReached`。
3. 舊 log 最新狀態為 2026-09-19T13:23:08.287Z `state → idle`，接著 saved；這只作為前置參考，沒有把舊錄影當成本次驗收。
4. 已發出互動文字請求：確認沒有錄影後，從 RecordStuff 選單按「結束」。截至本次停點尚無完成回覆，程序仍存在；沒有強制終止。
5. Chrome 截圖只能取得瀏覽器視窗，未包含系統選單列。截圖僅在工具回覆觀察，未保存檔案；不存在可交付的錄影／播放截图。
6. 嘗試準備素材分頁時工具回報使用者已操作 Chrome，要求重新取得狀態；重新觀察後停止進一步 UI 動作。未建立測試分頁、未播放素材。

## 收尾與限制

沒有開始本次錄影，沒有刪除或修改任何使用者錄影；沒有改動 App 設定。RecordStuff 既有副本仍開啟；未開啟或操作 QuickTime、Safari、Finder。需要既有副本正常結束後，接續 pnpm start:app、素材、原生快捷鍵、verify 與 QuickTime 播放。

首次授權、快捷鍵衝突／關閉／持久化、長時間穩定性、聲道分離、音質、同步、發布安裝均未驗證。此次為開發驗收，不更新發布記錄或移除計畫。
