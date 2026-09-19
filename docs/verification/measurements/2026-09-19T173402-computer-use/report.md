# RecordStuff 原生 UI 開發驗收

驗收時間：2026-09-19 17:33–17:35 +08:00。整體結論：**blocked**。
使用 `astra-acceptance-with-computer-use` 技能，以目前工作目錄為範圍做基本驗收；未指定發布候選。

## 環境與來源

- macOS 26.6.2（25G83），arm64；package 0.1.2。
- HEAD：`d63bef37bd4b19f8f5b9a6401c25e1a509668e9b`。
- 開始前工作樹：CLAUDE.md 已修改；AGENTS.md、驗收 skill 目錄、`2026-09-19T1727-computer-use/` 報告目錄未追蹤。全部保留，本次未修改應用程式。
- 既有程序 PID 27012，啟動時間 2026-09-19 17:27:30；路徑 `/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff`。
- 沒有執行 `pnpm start:app`：無法從 UI 確認既有程序是否正在錄影，不安全地關閉或覆寫既有產物不符合驗收規則。現有產物不能視為本次從 HEAD 重建。
- 唯讀 settings.json：繁體中文、standard、source、60 fps，输出目錄 `/Users/eric/Movies/RecordStuff`。此為磁碟偏好，未由 UI 核對目前載入值。
- 固定素材 `scripts/test-material.html` SHA-256：`a327547a798cd75f2bc4320fbd670ce107481335eeb47243ea997e03b514b965`。沒有啟動素材，瀏覽器／輸出裝置／音量未驗。

## 阻礙與證據

原生工具 `cua.getState()` 可列出一般應用程式與 Chrome 分頁，卻未列出執行中的 RecordStuff。Finder 的 AX 與截圖可取得，但截圖只含 Finder 視窗，沒有桌面選單列。

1. `cua.getApp('com.recordstuff.app')` 回傳 bundle identifier 歧義：/Applications、目前 checkout 產物、兩個掛載磁碟映像均有相同識別碼。
2. 依程序已核對的完整路徑呼叫 `cua.getApp('/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app')`，約 5 秒後回傳 `Computer Use server error -10005: timeoutReached`。
3. `cua.getApp('com.apple.systemuiserver')` 同樣約 5 秒後回傳 `Computer Use server error -10005: timeoutReached`。

以上為本次工具觀察，沒有可保存的 RecordStuff／選單列截圖，亦未虛構截圖檔案。工具未提供可用的全桌面 target。這是存取介面受阻，不代表 App 啟動失敗或功能有缺陷。

## 案例結果

| 案例 | 操作與預期 | 實際 | 狀態 |
| --- | --- | --- | --- |
| 啟動與選單 | 確認既有狀態，重建並右鍵查看待命與主要選項 | 完整路徑取用 UI 逾時；未關閉或重建 | blocked |
| 開始錄製 | 左鍵開始、素材播放約 10–15 秒，觀察 REC | 無法操作選單列；未開始錄製 | blocked |
| 錄製中狀態 | 停止可用、品質與輸出設定鎖定 | 無法開始錄製或讀取選單 | blocked |
| 停止與存檔 | 左鍵停止、回到待命，記錄 MP4 與通知 | 本次沒有錄影產物 | blocked |
| 定位檔案 | 通知／顯示最後錄影，Finder 置前且選中正確檔案 | 沒有本次錄影且無法操作選單 | blocked |
| 實際播放 | Finder 開啟本次影片、播放與拖曳 | 沒有本次影片 | blocked |
| 客觀聲音檢查 | pnpm verify；48 kHz、2 聲道，各聲道 RMS > −60 dBFS | 沒有本次影片，未執行 verify | blocked |
| 語言與保存 | 切換中英文、重開驗證、還原原語言 | 無法操作選單與確認錄影狀態 | blocked |

基本案例合計：pass 0、fail 0、blocked 8、not run 0。表外的首次授權、長時間穩定性、音質／同步、故障注入、安裝與發布驗收均未執行。

## 獨立檢查與收尾

- 現有產物 `codesign --verify --deep --strict` 退出碼 0；這僅驗證現有簽章，不證明目前原始碼已重建或 UI 通過。
- [唯讀檢查證據](checks.txt) 保存程序路徑、OS、commit、簽章結果及文件空白檢查。
- 沒有開始或停止任何錄影，沒有新增 MP4，沒有變更偏好或播放素材。既有 App 保持執行，錄影狀態未知。
- 未執行 pnpm check：本次只新增驗收報告，沒有應用程式變更。
- 後續需提供能存取原生桌面／選單列的 computer use 介面，才可安全確認既有錄影狀態並重新進行完整驗收。
