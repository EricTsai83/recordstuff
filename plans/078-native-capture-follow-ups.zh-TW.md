# 078 — 原生錄影的後續：影格間隔、開發版 App、節奏診斷

[English](078-native-capture-follow-ups.md) | [繁體中文](078-native-capture-follow-ups.zh-TW.md)

狀態：已規劃；尚未開始。建立：2026-10-16，依維護者在 076 步驟 7 的要求（「先記下這個問題，之後再處理」）。優先順序：由維護者排序；都不阻擋 074 或 075。硬性相依：076。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與範圍

解決 076 驗收在 macOS 原生錄影引擎上留下的三個問題。成功的標準是：剩下的 50 ms 影格間隔找到原因並消除，或連同原因一起被接受；開發版 Electron App 和簽署 bundle 一樣把自己的視窗排除在錄影之外，或把這個限制寫進文件；影格節奏的診斷涵蓋實際錄影的引擎。

不在範圍內：Windows 實機（只由 CI 驗證）、新的擷取功能，以及 [077](077-native-hands-on-acceptance.zh-TW.md) 的動手驗收案例。

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

### 4. 文件

- [ ] 把結果寫進 [recording](../docs/zh-TW/system-design/recording.md)、[tooling](../docs/zh-TW/system-design/tooling.md) 與驗證紀錄，含翻譯。

## 完成與驗證邊界

每個步驟都完成或由維護者接受其結果，量測也已記錄，即算完成。引擎修改依[測試規則](../docs/zh-TW/testing.md#依行為選擇測試)的錄影相關列：`cargo test`、`pnpm check`，以及依步驟需要在簽署 bundle 或開發版 App 上跑原生 matrix；每一次都是一輪桌面驗證，遵守[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)。撰寫本 plan 只需檢查連結、中英文一致與 `git diff --check`。
