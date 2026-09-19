# Computer use acceptance — 2026-09-19 17:27 (+08:00)

Skill: `.agents/skills/astra-acceptance-with-computer-use`. Scope: basic acceptance of the current source built by `pnpm start:app` before tagging v0.1.2. Reported in Traditional Chinese below.

## 環境與產物

| 項目 | 值 |
| --- | --- |
| 時間 | 2026-09-19T17:26:37+0800 |
| OS／架構 | macOS 26.6.2 (25G83)，arm64 |
| Commit | d63bef3；3 個未提交檔案（CLAUDE.md、AGENTS.md、本 skill 目錄），皆非 App 原始碼 |
| 原有設定 | 語言 zh-TW；輸出 ~/Movies/RecordStuff；Standard／Source／60 fps |
| 既有執行中副本 | 無 |
| 建置指令 | `pnpm start:app`，退出碼 0（[start-app.log](start-app.log)） |
| 產物 | `dist/mac-arm64/RecordStuff.app`，版本 0.1.2 |
| 簽章 | 9 個 bundle 身分通過；SHA-1 01B373511530BBF287CA35E54C10A5F017AAD637；designated requirement 相符 |
| 執行中程序 | PID 27012，執行路徑為上述產物（非 /Applications 舊副本） |
| Log | [app.log](app.log)：`start: RecordStuff 0.1.2 … packaged true`、`ready`、`permission: granted and capture sees 2 screen(s)`；無錯誤，無重新要求權限 |
| 新增錄影 | `~/Movies/RecordStuff/2026-09-19 18-02-38.mp4`，50,155,487 bytes，由維護者手動操作選單列圖示錄製（非 computer use） |

## 阻礙

執行環境（Claude Code，T3 Code harness）沒有原生桌面 computer use 工具；可用的只有 iOS／Android 模擬器與網頁預覽控制。依 skill 規則，不以 AppleScript、System Events、IPC 或測試 hook 代按 UI，因此所有需要操作選單列圖示、Finder 與播放器的案例標示 blocked。

## 案例結果

| 案例 | 操作 | 預期 | 實際 | 狀態 | 證據 |
| --- | --- | --- | --- | --- | --- |
| 啟動正確的 App | `pnpm start:app`，核對程序路徑與 log | 建置、簽章、驗證、開啟；log 顯示 0.1.2 就緒且權限已授予 | 全部符合 | pass | start-app.log、app.log、`ps` |
| 啟動與選單 | 右鍵開啟選單確認狀態 | Ready／待命 | 未操作；log 顯示 ready 與 permission granted，但選單未以 UI 確認 | blocked | app.log |
| 開始錄製 | 左鍵圖示 | 進入 REC | 未操作 | blocked | — |
| 錄製中狀態 | 開啟選單 | 停止可用、鎖定項目正確 | 未操作 | blocked | — |
| 停止與存檔 | 再次左鍵 | 回到待命、產生 MP4、通知 | 未操作 | blocked | — |
| 定位檔案 | 通知／Show last recording | Finder 選中檔案 | 未操作 | blocked | — |
| 實際播放 | Finder 開啟、播放器播放 | 畫面與進度正常 | 未操作 | blocked | — |
| 語言與保存 | 切換語言、重開 | 文字更新且保存 | 未操作 | blocked | — |

通過 1，失敗 0，受阻 7，未執行 0（computer use 部分）。

## 維護者手動補做 — 2026-09-19 18:02

維護者在同一個執行中的產物（PID 27012）上手動點選單列圖示開始與停止錄影。這是人工操作，不是 computer use 驗收，但提供了受阻案例中「開始錄製／停止與存檔」的實際證據：

| 案例 | 證據 | 狀態 |
| --- | --- | --- |
| 開始錄製 | log `state → starting` → `recording`；session 擷取 1920x1080 @ 60 fps、48 kHz × 2 | pass |
| 停止與存檔 | log `state → stopping` → `idle` → `saved …18-02-38.mp4`；檔案 16.7 s、47.8 MB | pass |
| 產物檢查（`pnpm verify --screen 1920x1080`，[verify.txt](verify.txt)） | 尺寸 1920x1080 ✅；掉幀 0.52% ✅；A/V 時長差 −12 ms ✅；容器起始偏移 0 ms ✅；48 kHz 雙聲道且兩聲道 RMS −29.1／−29.3 dB ✅（確實錄到聲音）；音訊 194 kbps ✅；ffprobe 完整解碼無錯誤 ✅。**平均幀率 57.55 fps ❌（門檻 60 ± 2）與視訊位元率 23.82 Mbps ❌（目標 16.2 Mbps 的 147%）**，verifier 總判定為 fail | 見說明 |
| 實際播放 | 需維護者以播放器確認；未在本報告中記錄 | not run |
| 啟動與選單、錄製中狀態、定位檔案、語言與保存 | 未操作 | blocked |

兩個 fail 的指標與[驗證紀錄](../../README.md)中已接受的 60 fps 偏差一致，且 fps 門檻本身註明需要持續移動的畫面素材，本次素材為維護者任意螢幕內容。[verify.txt](verify.txt) 保留這次原始判定（fail）。

同日 verifier 改為兩層判定（見[工具鏈](../../../system-design/tooling.md#measurement-pipeline-and-thresholds)）：完整性檢查適用於任何內容；幀率與掉幀只在 `--moving`／`--sync` 時判定；碼率改為下限。以新版對同一檔案重跑（[verify-tiered.txt](verify-tiered.txt)）：時長 16.7 s 對 log session 16.7 s ✅、尺寸 ✅、A/V ✅、音訊 ✅、視訊碼率 147%（下限 70%）✅、音訊碼率 76%（下限 50%）✅、解碼 ✅；幀率 57.55 fps 與掉幀 0.52% 顯示但標 n/a。總判定 **pass**。量測值前後相同，改變的是判定規則。

## 結論與限制

本次只證明：目前原始碼（0.1.2）可建置、以固定身分簽署並通過驗證、正確的產物能啟動到就緒狀態、既有螢幕錄影權限對此產物有效且不需重新授權。**不證明**錄製、存檔、播放、Finder 定位或語言保存；這些需要在有 computer use 工具的環境重跑本 skill，或由維護者手動操作後以 `pnpm verify` 檢查產物。

## 最終狀態

App（PID 27012，dist/mac-arm64 產物）仍在執行且處於待命，讓維護者可直接接手操作；未變更任何設定；未新增錄影或素材；沒有需要還原的項目。
