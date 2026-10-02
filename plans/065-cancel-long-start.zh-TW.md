# 065 — 讓快捷鍵與點擊能取消很久的開始

[English](065-cancel-long-start.md) | [繁體中文](065-cancel-long-start.zh-TW.md)

狀態：提案；佇列第一個，排在 064 之前，因為 064 最後會推 tag 發布，而這個計畫修改的 Recorder 行為會隨那次發布出去。相依：步驟 2–5 需要步驟 1 的維護者決定。與已延後的 058–060 Playwright 鏈互相獨立。由 [plan 063](../docs/zh-TW/verification/history-2026-10.md#plan-063-結案--2026-10-02) 的 stale-start 案例發現，維護者於 2026-10-02 要求處理。

## 問題與證據

全域快捷鍵與狀態列項目的左鍵都呼叫 `Recorder.toggle()`（[recorder.ts](../src/main/recorder.ts)）：idle 時開始、錄影中停止、倒數中取消，狀態為 `starting` 或 `stopping` 時則什麼都不做就返回。單元測試 `ignores clicks while starting and stopping` 鎖定了這個行為，[錄影設計](../docs/zh-TW/system-design/recording.md#倒數)也寫明開始與停止期間的點擊一律忽略，重複的開始操作在倒數前都會被忽略。目的是防止連按：再按一次開始快捷鍵或連點兩下時，第二下不能把剛開始的嘗試取消掉。

Tray 選單的「取消錄影」在 starting 期間已經有效：`cancelCountdown` 接受 `starting`，仍在開啟資料夾或準備擷取的嘗試會立即取消（沒有檔案、失敗紀錄或通知）；已經送出 `record` 的嘗試（倒數為關閉時）則轉成「開始後立即停止」的請求。所以開始期間只有選單能取消，快捷鍵與點擊都不行。

`starting` 持續多久，取自維護者保留的 log（2026-09-13 至 2026-10-02，共 740 次開始）：中位數 291 ms，第 95 百分位 399 ms。較長的情況：

- 1.1–9.4 秒：開啟資料夾觸發了 8 秒的 `DEFAULT_START_TIMEOUT_MS`，以及在重試螢幕來源後才回報的權限拒絕。
- 約 120 秒，2026-09-29 發生兩次：螢幕與音訊的擷取請求一直沒有回應，直到 `DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS`（120 秒）以 `capture_start_failed` 結束。這兩分鐘裡 Tray 顯示「啟動中，請留意系統權限提示…」，按快捷鍵或點狀態列項目都沒有作用。其中一次開始期間選了結束，也等滿 120 秒才生效（`capture request timed out after cancel (quit) was requested`）。

Plan 063 的 stale-start 案例在選單的開始之後 8 ms 送出快捷鍵，落在 `starting` 而被忽略。log 只有 `hotkey: CommandOrControl+Shift+1 pressed`，沒有任何一行說明這次按鍵被忽略，所以使用者回報「按了快捷鍵沒反應」時，從 log 無法分辨是被忽略還是按鍵沒送到。

## 目標

進入 `starting` 經過一段寬限期之後，toggle（快捷鍵或左鍵）會像選單的「取消錄影」一樣取消這次嘗試：在 `record` 之前，嘗試被取消，沒有檔案、失敗紀錄或通知；在 `record` 之後（倒數為關閉時），轉成開始後立即停止的請求。寬限期內的按鍵維持現在的忽略行為，並寫進 log。`stopping` 不變。建議寬限期為 1 秒：遠高於第 95 百分位的 399 ms，正常的開始不會被第二下取消；也遠低於讓人想中止的長時間等待。

## 步驟

每個步驟都能獨立完成，完成後文件保持一致。

### 1. 量測，然後是維護者決定關卡

- 從保留的 log 與一次受控重現，把每次超過 1 秒的開始歸到它所在的階段（開啟資料夾、準備擷取，或送出 `record` 後等待 `started`），並量測 log 中看起來是連按的兩次快捷鍵實際相隔多久，讓寬限期有證據支持。
- 詢問維護者：(a) 寬限期（建議 1 秒；其他選項：starting 期間任何時候都取消，或只在準備擷取時取消）；(b) 屆時 starting 選單的「取消錄影」與 tooltip 是否像倒數時一樣標出快捷鍵；(c) 準備擷取期間選結束時，是否要立即取消，而不是等擷取請求結束（建議另行記為後續事項，不在本計畫內）。把決定與日期記錄在[錄影設計](../docs/zh-TW/system-design/recording.md#倒數)。
- 拒絕時：記錄決定，只加上步驟 2 最後一項的「忽略按鍵」log，然後結案。

### 2. Recorder 修改

- 在 `toggle()` 的 `starting` 分支：若從狀態變成 `starting` 起（以 Recorder 的單調時鐘計算）已過寬限期，呼叫 `cancelCountdown("toggle")`；否則記錄 `recorder: session <id> toggle ignored while starting (<n> ms after the start)`。`stopping` 維持忽略，並寫同類的 log。
- 以受控時鐘撰寫單元測試：寬限期內的按鍵被忽略並寫進 log；寬限期後，在開啟資料夾或準備擷取時按下會取消，沒有檔案、失敗紀錄或通知，回到 idle 並保留「顯示上一段錄影」；倒數為關閉時，在 `record` 之後按下會轉成開始後立即停止，錄影會存檔；開始後 8 ms 的按鍵（063 的案例）仍被忽略；快捷鍵與左鍵走同一條路徑。

### 3. 呈現（只照步驟 1 的決定）

- 若 (b) 核准：`tray-model.ts` 中 starting 狀態的「取消錄影」以已註冊的錄影快捷鍵作為靠右的 accelerator，tooltip 也標出它，兩種語言都要；選單 model 的測試與 plan 048 的群組規則不變。

### 4. 為原生檢查隨時製造很久的開始

- 一般 bundle 無法穩定製造很久的開始。提議：在[受控驗收 build](../docs/zh-TW/system-design/tooling.md#受控驗收-build) 加入 `prepare=hold` 故障點，在 `release prepare` 之前扣住 capture host 的 `prepared` 回覆，讓開始停在 `starting` 想多久都可以。
- 提議的原生案例：對那個 build，在寬限期內透過 System Events 按下真正的快捷鍵（被忽略並寫進 log），在寬限期後再按一次（被取消），並在寬限期後以 [tray driver](../docs/zh-TW/system-design/tooling.md#腳本化原生驗收) 左鍵點擊狀態列項目（被取消）。可以是 `pnpm acceptance:tray` 的一種模式（以 `--bundle`、`--log`、`--settings` 指向受控執行目錄），也可以是一個小型專用 runner；由實作者選擇並記錄理由。

### 5. 文件

- 更新[錄影設計](../docs/zh-TW/system-design/recording.md#倒數)的倒數規則與稽核加固那一句、[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)的快捷鍵段落、[驗收](../docs/zh-TW/acceptance.md#依影響追加案例)的倒數與 tray 案例，以及步驟 4 若新增故障點或 runner 時的[工具指南](../docs/zh-TW/system-design/tooling.md)，兩種語言都要。

## 不在範圍內

`stopping` 的行為；120 秒的擷取請求逾時本身；準備擷取期間選結束時的等待，除非步驟 1 決定納入；權限提示、「系統設定」與 TCC；Windows。

## 驗證與完成

每個步驟的 diff 都套用[測試規則](../docs/zh-TW/testing.md)。步驟 2 屬於錄影開始／停止與全域快捷鍵兩列：`pnpm check`，加上在全新 `pnpm start:app` bundle 上做一次錄影 smoke（`pnpm acceptance`，它的開始與停止必須不受影響），以及用 `pnpm acceptance:tray` 檢查 tray 的取消路徑。步驟 3 與 4 另外加上選單檢查與受控 build 的原生案例，包括失敗與收尾路徑，並依桌面交接進行。快捷鍵註冊沒有改變，所以除非 diff 碰到它，否則不需要 `pnpm acceptance:shortcut-layout`。

完成條件：決定與日期已記錄；在原生環境證明寬限期後的快捷鍵與點擊都能取消很久的開始，且沒有檔案、失敗紀錄或通知，寬限期內的按鍵被忽略並寫進 log；設計文件與驗收案例兩種語言都已更新。把結果記錄在驗證歷史，再依[計畫完成](README.zh-TW.md#完成計畫)處理。
