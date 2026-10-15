# 078 — 原生錄影的後續：影格間隔、開發版 App、節奏診斷

[English](078-native-capture-follow-ups.md) | [繁體中文](078-native-capture-follow-ups.zh-TW.md)

狀態：已規劃；尚未開始。建立：2026-10-16，依維護者在 076 步驟 7 的要求（「先記下這個問題，之後再處理」）。優先順序：由維護者排序；都不阻擋 074 或 075。硬性相依：076。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與範圍

解決 076 驗收與文件在原生錄影引擎上留下的問題。成功的標準是：剩下的 50 ms 影格間隔找到原因並消除，或連同原因一起被接受；開發版 Electron App 和簽署 bundle 一樣把自己的視窗排除在錄影之外，或把這個限制寫進文件；影格節奏的診斷涵蓋實際錄影的引擎。

不在範圍內：Windows 實機回合（Windows 只由 CI 驗證，步驟 4 的硬體編碼器也一樣）、新的擷取功能，以及 [077](077-native-hands-on-acceptance.zh-TW.md) 的動手驗收案例。

## 目前狀態

- **影格間隔。**在 60 Hz 螢幕上錄 30 fps 時，原生有 0.66–2.17% 的影格間隔 50 ms，Chromium 為 0（2026-10-15）。076 發現螢幕沒有變化時 ScreenCaptureKit 會送 idle 影格，並修正了因此晚一次更新才拿到畫面的格位（PR #12）：還剩 0.22–0.44%，每段 15 秒 1–2 格，且擷取從未漏掉任何一次更新（畫面之間最長 33.3 ms）。原因不明；停止報告的計數（`capture delivered … pictures and … without one, … apart at most`）是調查的起點。門檻是 2%，Chromium 為 0%。
- **開發版 App。**透過開發版 Electron App 錄影（`pnpm matrix`、`pnpm audio:quality`）時，log 會出現 `RecordStuff's own app was not found among the shareable applications; its windows may be recorded`；簽署 bundle 則回報 `1 own app(s) excluded`。原因（開發版 App 的 bundle 身分，或讀取可分享內容時它沒有視窗）尚未確定。
- **節奏診斷。**`pnpm diagnose:cadence` 只量隱藏 renderer 的擷取 host，已於 2026-10-16 隨它一併移除；除了停止報告的計數之外，原生引擎還沒有逐格的診斷。

## 步驟

### 1. 剩下的影格間隔

- [ ] 找出剩下的 50 ms 間隔從何而來：針對一段錄影，記錄每個間隔前後每一格的編碼時間與來源（畫面、idle 更新、refresh 執行緒的格位），並和 pacer 的格位比對。要確認或排除的可能：pacer 沒有接受的 idle 更新（落在半個間隔之前）、refresh 執行緒的 `due` 路徑在較新的畫面到達時於格位編碼 pending 畫面，以及開頭被略過的影格。
- [ ] 依證據修正，並為該情況加上測試，再以原生與 Chromium 在同一個螢幕上跑 `pnpm matrix -- quick` 量測；若在引擎中找不到原因，記錄證據並請維護者接受剩下的部分。

### 2. 開發版 App 自己的視窗

- [ ] 找出開發版 App 為何不在可分享的應用程式中（比對它的 process 與 bundle 身分和 `SCShareableContent` 列出的內容，分別在有視窗與沒有視窗時），讓它和 bundle 一樣被排除，或記錄為何做不到，以及這對開發版錄影的影響。

### 3. 原生引擎的節奏診斷

- [ ] 和維護者決定原生引擎是否需要節奏診斷（取自逐格 log，或每個編碼影格時間與來源的診斷匯出），需要的話就建立；步驟 1 可能會先需要它。

### 4. Chromium 路徑留下的部分

- [ ] **Windows 硬體 H.264（維護者 2026-10-16 決定：實作，並和 Cap 一樣預設開啟）。** Windows 目前只用 Microsoft 的軟體 transform 編碼，而 D4 的本意是有 GPU 硬體編碼器時使用它。透過 Media Foundation 的非同步硬體 transform 實作，畫面留在 GPU 上，依照 Cap（revision `83237e9`，AGPL 程式碼只參考設計）、OBS 與 Chromium 的做法；三者都不會在沒有退路的情況下信任硬體編碼器：
  - 在擷取裝置所在的 adapter 上列舉硬體編碼器（以其 LUID 呼叫 `MFTEnum2`）；WARP 上不使用，因為那裡的畫面在 CPU 上轉換。和 Cap 一樣跳過 AMD（OBS 在 AMD 的 Media Foundation 編碼器出問題後放棄了這類編碼器），AMD 使用軟體編碼器。
  - 錄影前做一次自我測試，依 adapter、驅動與尺寸快取結果：編碼幾張灰色畫面再解碼回來，檢查灰色，因為有些驅動能開啟 session，卻不報錯地輸出綠色或黑色畫面。任何失敗，以及第一個關鍵影格送到 muxer 前的任何錯誤，都默默改用軟體編碼器。
  - 錄影中由 watchdog 監測（有輸入沒輸出、連續輸入失敗、5 秒沒有輸出、`MEError`），觸發時以已寫入的內容結束錄影，視為擷取失敗，之後的錄影改用軟體編碼器。
  - 開發用開關可強制使用軟體編碼器；和 Cap 一樣沒有使用者設定。
  - `windows-2025` 的 CI 沒有 GPU：測試列舉不到編碼器、退回軟體、以軟體編碼器跑自我測試，以及用會注入卡住、錯誤與格式變更的假非同步 transform 測試事件處理。真實 GPU（NVIDIA、Intel）、畫面正確性與 CPU 仍未測試，照實列出，依使用者回報修正。
- [ ] **沒有 Media Foundation 的 Windows（維護者 2026-10-16 決定：專屬錯誤碼，加上錄影前檢查）。** 沒有 Media Feature Pack 的 Windows N 版無法編碼，目前以 `capture_start_failed` 失敗（「再試一次……或調低畫質」），既沒說出原因，也沒說出補救方法；缺少 `mfplat.dll` 時模組是否還能載入尚未驗證，要最先確認。一個錯誤碼對應一種原因與補救：
  - 新增錯誤碼（暫名 `media_components_missing`），有自己的原因、說明（到 設定 → 應用程式 → 選用功能 安裝 Media Feature Pack，然後重新開機）與圖示；模組因此無法載入、Media Foundation 無法啟動，或找不到 H.264 或 AAC 編碼器時使用。
  - 和 macOS 缺螢幕錄製權限一樣在錄影前檢查：main 在啟動時確認 Media Foundation 存在；不存在時「開始錄影」不可用並說明原因，設定視窗顯示提示，按鈕可開啟 `ms-settings:optionalfeatures`。錯誤碼保留作為檢查看不到的情況的最後防線。
- [ ] **移除 `mp4_unsupported`（維護者 2026-10-16 決定：不留 legacy code）。** 只有隱藏 renderer 會產生它，所以錯誤碼、原因、說明與圖示一併移除。失敗紀錄遇到不認得的錯誤碼會拒絕整份檔案，以免降版的 App 覆寫新版的紀錄；因此含有舊 `mp4_unsupported` 紀錄的失敗紀錄會變成無法讀取。維護者接受這個小風險（這個錯誤碼只在 Chromium 無法錄 MP4 時出現，實務上是 Windows N 版，而 Windows 版自 2026-10-03 才發布）。
- [ ] **讓無法讀取的失敗紀錄有出路（維護者 2026-10-16 決定）。** 目前設定視窗只顯示「無法讀取失敗紀錄。檔案已保留；請查看 log。」，在使用者手動刪除檔案前，新的失敗都存不進去。在這句旁邊加上「重設失敗紀錄」按鈕：先確認，把讀不到的檔案保留為備份（`keepFile(…, "reset-backup")`），建立空白紀錄，不必重開就能再存失敗；提示也不再叫使用者看 log。它也涵蓋因其他原因損毀的紀錄，而降版保護仍在，因為只有使用者的操作會取代檔案。
- [ ] **移除幀率降級與解析度上限提示（維護者 2026-10-16 決定）。** 兩者都在比對 Chromium 實際給的與要求的。引擎自己把畫面縮放到指定大小，並以選定的幀率產生影格，螢幕沒變化時重複上一張畫面，所以 host 回報的就是要求的幀率，也從不設定 `capUnconfirmed`。移除 `frameRateDowngrade`、`capUnconfirmed`、選單列通知、設定視窗的擷取警告，以及它們的字串與測試。
- [ ] **檔案大小估算改依原生引擎（維護者 2026-10-16 決定）。** `estimatedBytesPerMinute` 因為 MediaRecorder 實際約為目標的兩倍，而把 60 fps 的影片估算加倍。原生引擎在 30 與 60 fps 都是目標的 101–102%（8.10 Mbps 實測 8.25–8.28、14.90 實測 15.11–15.19、16.20 實測 16.33–16.47；2026-10-15/16 以測試素材跑 `pnpm matrix -- quick` 與 `pnpm acceptance`），所以估算直接等於目標、不再加倍；靜止的畫面錄出來會更小。

### 5. 文件

- [ ] 把結果寫進 [recording](../docs/zh-TW/system-design/recording.md)、[tooling](../docs/zh-TW/system-design/tooling.md) 與驗證紀錄，含翻譯。

## 完成與驗證邊界

每個步驟都完成或由維護者接受其結果，量測也已記錄，即算完成。引擎修改依[測試規則](../docs/zh-TW/testing.md#依行為選擇測試)的錄影相關列：`cargo test`、`pnpm check`，以及依步驟需要在簽署 bundle 或開發版 App 上跑原生 matrix；每一次都是一輪桌面驗證，遵守[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)。撰寫本 plan 只需檢查連結、中英文一致與 `git diff --check`。
