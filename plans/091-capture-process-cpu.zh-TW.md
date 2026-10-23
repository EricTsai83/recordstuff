# 091 — capture 程序的 CPU 花在哪裡

[English](091-capture-process-cpu.md) | [繁體中文](091-capture-process-cpu.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-23，依維護者要求，來自 083 的數據（[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-083-結案--2026-10-23)、[管線 baseline](../docs/zh-TW/system-design/tooling.md#管線-baseline)）；同日修訂，加入停損規則、值得改的門檻，以及重量 baseline 的責任。硬性相依：083（已結案）。佇列第三個，在 090 之後、092 之前。依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，除了 083 的回合外沒有新的量測。

## 目標與現況

083 開啟開關的回合在 M1 Pro 參考機上發現，capture 程序（執行引擎的 `utilityProcess`）錄 30 fps 動態素材時每秒約用 100 ms CPU，60 fps 約 146 ms。083 在引擎內計時的各階段加起來少得多：核心接下每張送來的畫面（`capture_callback`，含送進編碼器）在 30 fps 每秒約 12–14 ms、60 fps 約 25–29 ms，writer 約 2–3 ms。這些是經過時間，所以其中的 CPU 最多就這麼多：程序 CPU 約 80–86% 不在 083 量測的任何階段裡。靜態素材顯示了輪廓：每秒約一張畫面時是 3.3%，所以無論畫面如何每秒約花 33 ms（聲音、Node runtime、計時器），而每送來一張畫面再多約 1.1 ms，其中核心自己的處理只有約 0.2 ms。

錄影 CPU（30／60 fps 時為單核的 10.4%／14.0%）已遠低於預算（30%／40%），所以這是為了續航與理解所做的調查，不是修正超標。只有原因夠大、解法夠安全時才值得改。

有兩個事實指出該先看哪裡，但還不下結論：

- 擷取要求的間隔是影格間隔的四分之一（`Pacer::capture_interval_ns`，[pacing.rs](../native/capture/src/pacing.rs)，plan 076 第 7 步），所以即使是 30 fps，ScreenCaptureKit 也會送來每一次螢幕更新，每秒約 58 張，pacer 只保留一半。每次送達都要從系統的擷取服務跨進本程序（以 IOSurface 為底的 `CMSampleBuffer`、Objective-C retain 與 autorelease pool），不論是否保留。四分之一是刻意的：配合 plan 078 對跳過更新的補幀，讓每個時槽附近都有畫面；改成要求影格間隔本身，可能讓 076 與 078 消除的 50 ms 間隔回來。
- 錄影期間一直在取聲音：ScreenCaptureKit 的音訊 buffer、混音器與 AAC 編碼都在同一個程序執行，Node runtime 與原生 addon 的 thread-safe 呼叫也是。

同類工具在較新的 Mac 上量到的數字較低（原生 ScreenCaptureKit 錄影工具在 M4 Pro 上的單程序數字約 3–6%，rec-rs 的錄影程序在 1080p60 為 5.9%），但目前沒有任何比較使用相同的機器、素材與量測範圍，所以本計畫量測我們自己，而不是追趕別人的數字。

## 範圍

不在範圍內：把引擎搬出 Node 的 `utilityProcess`（sidecar 執行檔或其他 host），這會改變監督、打包與故障隔離，需要自己的計畫；改變錄影的編碼器或畫質；Windows 的 profiling。

## 步驟與責任

- [ ] **先確認 profiler 看得到關鍵的 frame。** 回合開始前，先用一段短錄影確認 `pnpm measure:cpu -- --profile`（plan 081，`sample`）能依執行緒解析出 ScreenCaptureKit、CoreMedia、AudioToolbox 與引擎的 frame。若不行，capture 程序改用 Instruments 的 Time Profiler（`xctrace record --template 'Time Profiler' --attach <pid>`），trace 與報告放在一起保存。
- [ ] **重量 baseline 並依執行緒歸因。** 在目前 HEAD 的簽章 bundle 上（083 的 bundle 早於 089、090 與 093），以 `--repeat 3 --diagnostics --profile` 跑 R，涵蓋動態與靜態素材、30 與 60 fps，並跑 `pnpm matrix -- quick` 與 `long` 取得節奏與同步的基準。把 capture 程序的樣本依執行緒拆開：ScreenCaptureKit 的送達佇列、refresh 執行緒、writer、音訊與麥克風執行緒、AudioToolbox 的 AAC 編碼器、Node 主執行緒與 libuv。這些就是本計畫所有比較的修改前數據。
- [ ] **用開關逐一隔離，使用同一個 bundle。** 關閉聲音（`RECORDSTUFF_CAPTURE_AUDIO=off`，plan 076 的開發開關；`measure:cpu` 拒收 launchd 帶的這個開關，所以需要新增一個以 `open --env` 傳入的 runner 選項）、靜態素材，以及一個讓擷取要求影格間隔本身而不是四分之一的開發開關。每一項回答一個原因佔了多少無法解釋的成本；都不是產品變更。
- [ ] **停損或決定（D1）。** 若沒有任何單一原因在 30 fps 下值得**至少 2 點單核 CPU**（約為程序的五分之一），或成本大多是 Node runtime 的固定成本（如上，不在範圍內），就在這裡停止，把歸因記錄為結論。否則在決定點由維護者選擇要降低哪項成本、用什麼變更、承擔什麼風險（影格節奏、音畫同步、相機的逐格編碼、Windows），或延後。
- [ ] **若決定實作，就實作並量測**，以 083 的門檻與上述門檻判定：改善超過 baseline 範圍、至少為中位數的 10%，而且在 30 fps 至少 2 點；`pnpm matrix -- quick` **與 `long`**（節奏、掉幀、音畫偏差、漂移）與 `pnpm verify` 不退步。改擷取間隔時也要跑靜態素材，因為它的閒置編碼路徑取決於送達次數。
- [ ] **重量管線 baseline。** 若採用了變更，就在最終 bundle 上重量工具指南的管線 baseline（R、靜態素材，以及 Studio 的 S 與 L，因為每個 Studio 數字都是相對 R 的增量），並更新引用它的預算；之後的計畫以新的 baseline 比較，不再用 083 的。

## 門檻與完成條件

結案時，capture 程序的 CPU 已依執行緒與原因歸因，涵蓋兩種素材與兩種幀率，無法解釋的部分已具名；並且有一項通過門檻、錄影完整性不變、baseline 已重量的已採用變更，或一份書面結論說明沒有值得其風險的變更。為歸因而加的量測要做成開發開關，否則在結案前移除。

## 驗證

profile 與開關都是新簽章 bundle 上的桌面回合，需要維護者交接；除非維護者同意，否則不開相機。程式變更要跑 `pnpm check`、受影響的 `pnpm measure:cpu` 案例、`pnpm matrix -- quick` 與 `long`，並對其檔案跑 `pnpm verify`。Windows 只由 CI 檢查，依 076 的 D8；擷取間隔的變更只限 macOS，除非 Windows 也改並且寫明。

## 執行與結案契約

依[計畫索引](README.zh-TW.md)處理順序、決定點、桌面交接與結案；維持 capture 程序的故障隔離、預設直接 MP4 與 076 的影格節奏。開始執行時先檢查當時的程式與 083、090、093 的紀錄；以上數字只屬於一台機器。
