# 006 RecordStuff.app 開發包與簽章

狀態：待執行（前置 004 已於 2026-09-13 完成，可開始）
前置：004（已完成）
對應：001 里程碑 3

## 目標

讓開發與測試跑的是使用者實際拿到的 RecordStuff.app，而不是通用的 Electron.app，然後完成簽章、公證、安裝檔。

## 為什麼

`pnpm start` 跑的 Electron.app 名字是 Electron、識別碼是 `com.github.Electron`，權限提示與設定頁清單顯示的都是「Electron」，和使用者看到的「RecordStuff」是兩筆不同的權限紀錄。`electron-builder --dir` 會組出完整的 RecordStuff.app 但跳過 DMG 與壓縮，幾秒完成，權限記在 RecordStuff 名下，`LSUIElement`、`NSAudioCaptureUsageDescription` 等 Info.plist 設定也是真的那一份。

## 步驟

1. 加 `pnpm start:app`：`electron-vite build && electron-builder --dir --mac && open dist/mac-arm64/RecordStuff.app`。確認 Dock 沒有圖示、選單列有圖示、log 寫到 `~/Library/Application Support/RecordStuff/logs/`（注意 userData 目錄名從 `recordstuff` 變成 `RecordStuff`）。
2. 用這個 .app 重跑 004。權限提示應顯示「RecordStuff」。
3. Developer ID 簽章：確認 keychain 有憑證、`electron-builder.yml` 的 `hardenedRuntime` 與 entitlements 讓 app 能啟動且能錄。ad-hoc 與正式簽章的 TCC 紀錄分開，簽章後要再授權一次。
4. 公證：設 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，`pnpm dist:mac` 產 DMG，另一台或新使用者帳號安裝，確認 Gatekeeper 不擋、第一次啟動的權限流程與 004 一致。
5. 001 §4「簽章打包後的版本行為與開發版相同」逐項對照。
6. **004／003 移交的驗收**（004 於 2026-09-13 結案，這七項在那裡都沒有結論，全部由這裡負責，每項都要寫下實際觀察，不能只標「應該沒問題」）：
   - (a) **通知顯示與點擊**——開發版（ad-hoc、無 TeamIdentifier）2026-09-13 存檔後完全沒有顯示通知，診斷 log 是 `notification: failed (無法完成作業。（UNErrorDomain錯誤1 。）)`，代表通知中心拒收。簽章版要確認這行消失、「已儲存 …」通知會出現、點下去 Finder 會選到該檔；未授權時的「需要螢幕錄製權限」通知是否顯示同樣在這裡看。
   - (b) **HiDPI**——把內建 Retina 螢幕設為主螢幕錄一段，比對 `capture:` log 的 `track size=` 與成品尺寸，補完 001 §17 第 7 題。
   - (c) **乾淨 TCC 第一次授權的完整流程**（004 步驟 2–6 逐字）在 RecordStuff 名下重跑一次，包含 004 未驗到的「第一次授予螢幕錄製」這條路徑（004 只走到「開→關→開」的復原路徑）。
   - (d) **第一次系統音訊提示按「拒絕」**——預期 `no_audio_track` 通知且 `~/Movies/RecordStuff` 不留檔案。004 兩次嘗試（17:31、17:59）都沒能讓提示出現，原因未查明；這裡要記下提示到底有沒有彈、彈了按拒絕之後實際發生什麼。
   - (e) **同一個 process 開啟音訊權限後直接錄**——在設定頁打開「僅系統音訊錄製」，不重啟 app 直接點錄製，確認是否真的不需重啟。004 那次是開關打開後才啟動的 process，等於沒測到。
   - (f) **修正後的權限選單實地確認**——`needsPermission` 的第一行灰字、「開啟系統設定」、以及新增的「已經允許了？重新啟動 RecordStuff」按下去真的重啟並進 `idle`。目前只有單元測試涵蓋，沒在真機逐項點過。
   - (g) **錄製中撤銷螢幕權限選「結束並重新打開」**這條分支——app 被終止後殘檔還在不在、能不能播。004 只驗了「稍後」那條。

   重跑 TCC 重置時，參數要用這個 .app 實際的 bundle id（`com.recordstuff.app`），先確認過身分再重置；不要用不帶 bundle id 的 `tccutil reset AudioCapture` 或 `tccutil reset All`，那會波及其他 app。也不要預設「重置完提示就會彈」——004 針對 `com.github.Electron` 的兩次重置之後都沒等到音訊提示。
7. Windows 簽章：有憑證就設 `CSC_LINK`／`CSC_KEY_PASSWORD`；沒有就照 001 §15 出未簽章版並在 README 註明。（Windows 的錄製驗收本身仍屬 005，不在這裡結案。）

## 完成標準

- 001 §4 全部達成，里程碑 3 完成。
- 步驟 6 的 (a)–(g) 每一項都有**具體結論**：通知在簽章版會顯示且點得開 Finder（或查明為什麼仍然不行）、001 §17 第 7 題的 HiDPI 部分答完、乾淨 TCC 的第一次授權與音訊拒絕路徑在 RecordStuff 名下實際走過一次、同一 process 開啟音訊後能否直接錄有答案、權限選單三個項目在真機逐項點過、「結束並重新打開」分支的殘檔狀態有紀錄。「未重現」**只是實驗紀錄，不等於驗收通過**：要寫清楚試了什麼、觀察到什麼，但該項仍算未驗證，仍由 006 持有，並**阻擋 006 結案與第一版發布**，直到真的驗證過，或使用者另行批准範圍調整。使用者批准的是把這些驗收移交 006，不是豁免。
- 第一版發布另需 005 的 Windows 驗收完成（001 §4 要求兩個平台）；006 自己結案不等於可發布。
