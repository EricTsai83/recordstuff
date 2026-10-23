# 091 — capture 程序的 CPU 花在哪裡

[English](091-capture-process-cpu.md) | [繁體中文](091-capture-process-cpu.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-23，依維護者要求，來自 083 的數據（[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-083-結案--2026-10-23)、[管線 baseline](../docs/zh-TW/system-design/tooling.md#管線-baseline)）。硬性相依：083（已結案）。排在 090 之後、084 之前。依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，除了 083 的回合外沒有新的量測。

## 目標與現況

083 開啟開關的回合在 M1 Pro 參考機上發現，capture 程序（執行引擎的 `utilityProcess`）錄 30 fps 動態素材時每秒約用 100 ms CPU，60 fps 約 146 ms。083 在引擎內計時的各階段加起來少得多：核心接下每張送來的畫面（`capture_callback`，含送進編碼器）在 30 fps 每秒約 12–14 ms、60 fps 約 25–29 ms，writer 約 2–3 ms。這些是經過時間，所以其中的 CPU 最多就這麼多：程序 CPU 約 80–86% 不在 083 量測的任何階段裡。靜態素材顯示了輪廓：每秒約一張畫面時是 3.3%，所以無論畫面如何每秒約花 33 ms（聲音、Node runtime、計時器），而每送來一張畫面再多約 1.1 ms，其中核心自己的處理只有約 0.2 ms。

有兩個事實指出該先看哪裡，但還不下結論：

- 擷取要求的間隔是影格間隔的四分之一（`Pacer::capture_interval_ns`，plan 076 第 7 步），所以即使是 30 fps，ScreenCaptureKit 也會送來每一次螢幕更新，每秒約 58 張，pacer 只保留一半。每次送達都要從系統的擷取服務跨進本程序（以 IOSurface 為底的 `CMSampleBuffer`、Objective-C retain 與 autorelease pool），不論是否保留。
- 錄影期間一直在取聲音：ScreenCaptureKit 的音訊 buffer、混音器與 AAC 編碼都在同一個程序執行，Node runtime 與原生 addon 的 thread-safe 呼叫也是。

同類工具在較新的 Mac 上量到的數字較低（原生 ScreenCaptureKit 錄影工具在 M4 Pro 上的單程序數字約 3–6%，rec-rs 的錄影程序在 1080p60 為 5.9%），但目前沒有任何比較使用相同的機器、素材與量測範圍，所以本計畫量測我們自己，而不是追趕別人的數字。

## 步驟與責任

- [ ] **依執行緒歸因。** `pnpm measure:cpu -- --profile`（plan 081）在每段錄影中對每個程序取樣 10 秒；在動態與靜態素材、30 與 60 fps 下執行，同一輪加上 `--diagnostics`，把 capture 程序的樣本依執行緒拆開：ScreenCaptureKit 的送達佇列、refresh 執行緒、writer、音訊與麥克風執行緒、AudioToolbox 的 AAC 編碼器、Node 主執行緒與 libuv。profile 與報告放在一起保存。
- [ ] **用既有開關逐一隔離，使用同一個 bundle。** 關閉聲音（`RECORDSTUFF_CAPTURE_AUDIO=off`，plan 076 的開發開關；`measure:cpu` 拒收 launchd 帶的這個開關，所以需要新增一個以 `open --env` 傳入的 runner 選項）、靜態素材，必要時加一個開發開關，讓擷取要求影格間隔本身而不是四分之一（它對 076 影格節奏、以及當時修正的 50 ms 間隔的影響，要用 `pnpm matrix -- quick` 量測）。每一項回答一個原因佔了多少無法解釋的成本；都不是產品變更。
- [ ] **在決定點決定（D1）。** 依歸因結果：哪項成本值得降低、用什麼變更、有什麼風險（影格節奏、音畫同步、相機的逐格編碼、Windows）。由維護者選擇實作、延後，或只記錄發現。
- [ ] **若決定實作，就實作並量測**，以 083 的門檻判定：改善超過 baseline 範圍且至少為中位數的 10%，`pnpm matrix`（節奏、掉幀、音畫偏差）與 `pnpm verify` 不退步。

## 門檻與完成條件

結案時，capture 程序的 CPU 已依執行緒與原因歸因，涵蓋兩種素材與兩種幀率，無法解釋的部分已具名；並且有一項通過 083 門檻、錄影完整性不變的已採用變更，或一份書面結論說明沒有值得其風險的變更。為歸因而加的量測要做成開發開關，否則在結案前移除。

## 驗證

profile 與開關都是新簽章 bundle 上的桌面回合，需要維護者交接；除非維護者同意，否則不開相機。程式變更要跑 `pnpm check`、受影響的 `pnpm measure:cpu` 與 `pnpm matrix` 案例（節奏或同步可能漂移時跑 `long`），並對其檔案跑 `pnpm verify`。Windows 只由 CI 檢查，依 076 的 D8。

## 執行與結案契約

依[計畫索引](README.zh-TW.md)處理順序、決定點、桌面交接與結案；維持 capture 程序的故障隔離、預設直接 MP4 與 076 的影格節奏。開始執行時先檢查當時的程式與 083、090 的紀錄；以上數字只屬於一台機器。
