# 041 — 以要求的影格率擷取

[English](041-capture-frame-cadence.md) | [繁體中文](041-capture-frame-cadence.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-25。依維護者決定（2026-09-25）排在佇列最前面、031 之前，並先於 040 與 037。執行順序見[佇列](README.zh-TW.md#順序與狀態)。來源：[plan 030](../docs/zh-TW/verification/history-2026-09.md#plan-030-結案--2026-09-25) 原生輪次後的影格時間戳分析。

## 問題與證據

這台機器上的每段錄影，實際交付的影格都略慢於要求，而且沒有掉幀。以 ffprobe 讀取四段錄影的影格時間戳（time base 為 1/30000 或 1/60000）：

| 錄影 | 要求 | 實際 | 中位間隔（理想值） | 掉幀 |
| --- | --- | --- | --- | --- |
| `2026-09-25 16-31-41.mp4`，10 秒快捷鍵驗收 | 60 fps | 57.54 fps | 17.32 ms（16.67） | 0 |
| `2026-09-25 23-06-14.mp4` 與 `23-07-53.mp4`，`pnpm matrix -- quick` | 30 fps | 29.42 與 29.41 fps | 33.90 ms（33.33） | 0 |
| `2026-09-25 23-08-54.mp4`，`pnpm matrix -- long`，180 秒 | 30 fps | 29.38 fps | 33.90 ms（33.33） | 0 |

30 fps 時，間隔落在 1/30000 秒的 1000 到 1046 ticks 之間（33.3–34.9 ms）：幾乎沒有一格短於理想間隔，也沒有一格是它的兩倍。兩種影格率的平均多出量都約為每格 0.7 ms，30 fps 因此少了約 2% 的影格，60 fps 少了約 4%。先前的紀錄一致：10 分鐘基準量到 29.30 fps，60 fps 以約 57 fps 被接受（[已取得的結果](../docs/zh-TW/verification/history-2026-09.md#已取得的結果)）；更新驗收為 29.28 fps；兩次 60 fps 快捷鍵驗收回報 55.32 與 56.60 fps，掉幀 2.58% 與 2.85%（[plan 020 驗證](../docs/zh-TW/verification/history-2026-09.md#plan-020-開發驗證--2026-09-23)）。

這個不足是系統性的、不是隨機的，但會讓測試變得脆弱：30 fps 已用掉 ±2 fps 容差中的 0.6，負載升高時多出的排程延遲就可能讓它跌出門檻；只要判定影格時序（`pnpm matrix -- fps`、`pnpm verify -- … --sync`），60 fps 的平均影格率每次都會 fail。60 fps 錄影的影格也比要求少約 4%。音畫同步不受影響，因為時間戳是真實時間：長案例的漂移只有 1.3 ms。

## 靜態閱讀與假設

對 Electron 44.3.0 內建的 Chromium 152.0.7977.78 做靜態原始碼檢視（不是執行中 App 的追蹤）：

- macOS 的螢幕擷取使用 `ScreenCaptureKitDeviceMac`：[`kScreenCaptureKitMacScreen` 預設開啟](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/renderer_host/media/in_process_video_capture_device_launcher.cc#92)，而且[螢幕優先使用該裝置](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/renderer_host/media/in_process_video_capture_device_launcher.cc#195)。以 timer 驅動的 `DesktopCaptureDevice` 重新排程時也會累積延遲，但這裡只是 fallback。
- 該裝置把 [`SCStreamConfiguration.minimumFrameInterval` 設成剛好 1／要求的影格率](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/media/capture/screen_capture_kit_device_mac.mm#239)。
- [`IOSurfaceCaptureDeviceBase` 以影格到達時的 `base::TimeTicks::Now()` 作為時間戳](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/media/capture/io_surface_capture_device_base_mac.cc#57)，而不是 ScreenCaptureKit 的 presentation time。
- RecordStuff 在 `getDisplayMedia` 要求 `frameRate: { ideal: N, max: N }`，並在 `applyConstraints` 中重複（[capture host](../src/renderer/capture-host.ts)）。

假設：要求的影格率成了最小間隔，也就是一個下限，所以每個交付的間隔都是「下限＋排程延遲」，平均一定低於要求。尚未量測的是：多出的時間來自 ScreenCaptureKit 的交付、Chromium 對 track 的影格率限制（`max`），還是時間戳本身。步驟 1 會在任何產品修改前確定這一點。

## Cap 參考

在固定 revision `b2b6ae45d4cae303107b10a9df166d91caed7702`（靜態原始碼檢視，沒有執行 Cap），Cap [以整數毫秒設定最小影格間隔，即截斷後的 `1000 / fps`](https://github.com/CapSoftware/Cap/blob/b2b6ae45d4cae303107b10a9df166d91caed7702/crates/scap-screencapturekit/src/config.rs#L24-L31)：30 fps 為 33 ms、60 fps 為 16 ms，略短於理想間隔。它[以 sample buffer 的 presentation time 作為影格時間戳](https://github.com/CapSoftware/Cap/blob/b2b6ae45d4cae303107b10a9df166d91caed7702/crates/recording/src/sources/screen_capture/macos.rs#L314-L317)，並[依影格率調整 queue depth](https://github.com/CapSoftware/Cap/blob/b2b6ae45d4cae303107b10a9df166d91caed7702/crates/recording/src/sources/screen_capture/macos.rs#L241-L251)。這些是設計選擇，不代表 Cap 的節奏精準。RecordStuff 只能控制透過 web constraints 要求什麼；Chromium 的時間戳來源與 queue depth 不在它能改的範圍。

## 範圍

範圍內：capture host 的影格率要求與回報它的地方、確認層級的診斷、可選的 `pnpm verify` 節奏回報，以及雙語文件。範圍外：`THRESHOLDS`（±2 fps 容差與掉幀率）、碼率公式（仍以要求的影格率計算）、解析度上限、音訊、Windows、修改 Chromium，或以原生模組取代其擷取。

## 步驟 1 — 確認層級

- [ ] 建一個有明確標記、不會出貨的診斷版本（暫時的 instrumentation 或隔離 fixture）。在以 30 與 60 fps 錄製動態測試素材時，於 renderer 記錄每一格進入 MediaRecorder 前的時間戳（`MediaStreamTrackProcessor` 或 `requestVideoFrameCallback`）、`track.stats`（delivered、discarded 與 total frames）與 `track.getSettings().frameRate`，並和檔案的 pts 比對。每種影格率在 60 Hz 主螢幕上至少錄兩段 30 秒；記錄螢幕更新率與 CPU。
- [ ] 以分布而非平均值分類：(A) 影格到達時就已是「間隔＋多出量」且沒有被丟棄——來源端的下限；(B) 影格以等於或高於要求的速率到達，但 track 丟棄了一部分——Chromium 的限制器；(C) 影格準時到達，但檔案的間隔較長——錄製器的時間戳。在受控的 CPU 負載下再重複一次，看多出量是否變大。選擇修正前先把分類記錄下來。

## 步驟 2 — 在負責的那一層修正

- [ ] 若為 (A) 或 (B)，比較能讓錄製影格率維持在設定值的候選要求，例如把 `max` 設得比設定值高幾個百分點，或只用 `ideal`。選出符合通過條件的最小修改，在程式中說明為何要求值與設定值不同，碼率目標仍以要求的影格率計算。30 fps 在 60 Hz 螢幕上須確認限制器不會造成兩倍長的間隔；60 fps 須確認不會超過螢幕更新率或重複影格。
- [ ] 若為 (C)，在 RecordStuff 能控制時修正時間戳；否則依下方的不通過處理。
- [ ] 讓 `frameRateDowngrade` 與 `CaptureReport.frameRate` 保持真實：改變要求不能誤觸發、也不能隱藏 60→30 的降級通知。為 constraint builder 與降級規則加入單元測試。
- [ ] 可選：在 `pnpm verify` 的平均影格率旁顯示中位影格間隔，讓節奏不足和掉幀可以區分。只回報，不新增門檻。
- [ ] 不通過：若沒有任何候選能在不造成掉幀、CPU 或同步退步下符合條件，就不修改產品程式。帶著量測與靜態閱讀向 Chromium／Electron 回報，把量到的節奏寫成錄影與工具指南中的平台限制，並在[設計決策](../docs/zh-TW/system-design/decisions.md)記錄維護者對是否繼續提供 60 fps 的決定。不放寬 `THRESHOLDS`；已知的 60 fps 失敗維持可見。

## 通過條件

在這台機器與素材上、同一螢幕的前後對照，每種影格率至少兩次：

- 平均值與 30 相差不超過 0.5 fps、與 60 相差不超過 1 fps，中位間隔與理想間隔相差不超過 1%；
- 兩倍長的間隔與掉幀不多於基準，掉幀率低於 2%；
- CPU 平均與基準相差不超過 3 個百分點，閃光／短音偏移與長案例漂移在門檻內，聲道能量通過，視訊碼率至少為目標的 70%。

## 驗證與排除

- [ ] `pnpm check`，含針對性的單元測試。
- [ ] 在新的 `pnpm start:app` bundle 做錄影 smoke：開始、停止、存檔、媒體驗證與播放，例如以 60 fps 設定執行 `pnpm acceptance`，並透過[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 在 QuickTime 播放。
- [ ] 修改前後各跑 `pnpm matrix -- fps`、`pnpm matrix -- quick` 與 `pnpm matrix -- long`，保留 030 起要求的聲道 RMS 與同步證據。
- [ ] 除非節奏證實與它們有關，否則排除：levels 矩陣、10 分鐘錄影、權限重設與設定回歸（設定 UI 不變）。必要但未執行的原生案例轉入 035。

## 完成與證據處理

依[共用測試政策](../docs/zh-TW/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。桌面輪次期間保持 `caffeinate` 執行；每輪桌面、音訊與快捷鍵由一個執行者獨占，build 序列執行；恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束。

- [ ] 分列檢查與結果、範圍排除及必要但未驗項目。診斷用的 instrumentation 不能出貨；移除它或只留在隔離 fixture 中。執行 `git diff --check`。
- [ ] 把分類結果、選定的要求值或不通過決定，以及前後量測寫入雙語的錄影、工具與驗證文件，更新兩份索引，再刪除本計畫與翻譯。沒有另外要求時不 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑測試、launch 或錄影。Chromium 與 Cap 參考是固定 tag 與 revision 的靜態原始碼閱讀，不是執行結果。
