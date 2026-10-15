# 錄影為何離開 Chromium 的 WebRTC 擷取

[English](../../system-design/webrtc.md) | [繁體中文](webrtc.md)

更新日期：2026-10-16。

這是一份設計紀錄。2026-10-16 之前，RecordStuff 透過隱藏 renderer 中的 Chromium 媒體堆疊錄影；plan 076 改用原生擷取引擎，也就是 Electron `utilityProcess` 中的 Rust 模組，並移除了 Chromium 路徑（commit `644f94f3`）。本文記錄那套堆疊帶來什麼、付出什麼、每項代價如何量測或解決，以及原生引擎為此換來的代價。目前錄影如何運作見[架構](architecture.md)與[錄影管線](recording.md)；已接受的取捨見[設計決策](decisions.md)。

## Chromium 路徑原本是什麼

一個隱藏、啟用沙箱的 renderer 呼叫 `getDisplayMedia`；main 的 display-media handler 回應所選的螢幕與 `audio: "loopback"`。`MediaRecorder` 把軌道編碼成 fragmented MP4（H.264，以及要求 256 kbps 的 AAC），每秒透過 `MessagePort` 交一個 chunk 給 main；main 的 `FileWriter` 負責附加、每 5 秒 sync 一次，並在存檔時轉為一般 MP4。

這些都不是 WebRTC 通訊：沒有 `RTCPeerConnection`、signaling、ICE／STUN／TURN 或上傳，`MessagePort` 只是本機 IPC。WebRTC 之所以相關，是因為 Chromium 可能在擷取路徑中套用它的原生 Audio Processing Module（回音消除、降噪、自動增益，為語音通話設計），即使是沒有網路的螢幕擷取也一樣（[Chromium 的處理配置](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_audio_processing_layout.cc)）。

## 它帶來什麼

- **不需要原生程式碼。**單一語言，除了 Node 不需要其他編譯工具鏈，除了 App 本身也沒有東西要簽章。這是最初設計選擇它的原因：避免自訂音訊裝置與原生 sidecar。
- **免費得到平台擷取與硬體編碼。**Chromium 152 在 macOS 上本來就透過 ScreenCaptureKit 擷取螢幕並以硬體編碼 H.264；QuickTime 能播放結果。
- **兩個平台同一份程式碼**，在 Electron 可攜性所及的範圍內。

## 它的代價，以及每項代價如何收場

| 限制 | 代表什麼 | 如何量測或解決 |
| --- | --- | --- |
| 只能錄一個螢幕或一個視窗 | `getDisplayMedia` 只能排除本 App 受保護的視窗（Electron 對 Chromium 的修補）。它無法隱藏選單列或 Dock、無法錄區域或指定 App，也無法只錄單一 App 的聲音；在 macOS 上這些都需要 ScreenCaptureKit 的 `SCContentFilter`，而 Electron 與 Chromium 都沒有提供對應的 API。這些是維護者 2026-10-14 的需求，也是設計決策要求在改用原生前先實測到的限制 | 引擎自己過濾內容。「隱藏選單列與 Dock」是設定 → 錄影中的開關（macOS；引擎回報隱藏了 35 個系統視窗，選單列的位置錄到的是桌布）。視窗、區域與單一 App 的聲音都通過 macOS 的實際測試與 Windows 的 CI；選定 App 的視窗只在 macOS 上支援（Windows.Graphics.Capture 做不到，引擎在 Windows 上會拒絕）；選擇介面屬於之後的計畫 |
| RecordStuff 自己的視窗 | 沒有逐視窗排除，倒數覆蓋層只好在擷取前 300 ms 離開，被錄螢幕上的任何 RecordStuff 視窗都會被錄進去 | ScreenCaptureKit 的 application filter 把整個 App 排除，包括開始後才開的視窗；Windows 上標為 `WDA_EXCLUDEFROMCAPTURE`。在 macOS 上，錄影中開啟的設定出現在螢幕上，但不在錄影同一時刻的畫面中（2026-10-16） |
| 系統音訊上的語音處理 | 為語音設計的處理改變了已混好的系統音訊的高頻平衡，並讓立體聲塌成單聲；App 必須要求 `echoCancellation`、`noiseSuppression` 與 `autoGainControl` 為 false，而這些只是 runtime 不一定遵守的請求 | 2026-09-14 同時關閉三者後探測恢復（[音質 §15](audio-quality.md#15-系統擷取修正2026-09-14)）。引擎直接編碼 ScreenCaptureKit 或 WASAPI loopback 交來的樣本，路徑中沒有語音處理（[§16](audio-quality.md#16-原生音訊路徑為什麼能保留音質)）；`pnpm audio:quality` 兩種引擎都通過所有檢查，時鐘原生為 −0.07 ppm，Chromium 為 −1.45 ppm |
| 幀率下限 | Chromium 把要求的幀率轉成 ScreenCaptureKit 的最小影格間隔，那是下限而不是週期，所以要求 30 或 60 實際錄到約 29.4 或 57.5 fps。renderer 改為要求 30.3 與 62.5 才錄到設定值 | 引擎向 ScreenCaptureKit 要求影格間隔的四分之一，並依顯示時間在格點上排定影格。步驟 2 中 30 fps 沒有掉格、60 fps 掉 0.06–0.22%；結案前的回合有 0.22–0.44% 的影格間隔達 50 ms，Chromium 為零，原因尚未找到（plan 078） |
| chunk 交給 main | 在 Electron 44 的實驗中轉移 `ArrayBuffer` 會卡住 main，所以每秒的媒體都要複製，且沒有有界背壓；main 的事件迴圈卡住會延誤寫入；MP4 的索引與其他容器的 cues 需要回頭寫，chunk 串流無法乾淨做到；低動態的 Retina 錄影在關鍵影格間隔對齊 timeslice 之前，曾錯過第一個 chunk 的期限 | 由引擎自己寫檔（076 的 D3）：錄影中為 fragmented，存檔時轉為一般 MP4，並回報已寫入的位元組與寫入錯誤。停止與檔案完成是兩則不同的訊息，所以慢速磁碟的存檔不算在停止裡 |
| renderer 預熱與音訊服務 | display-media handler 在啟動時就使用預設 session，所以 Electron 44 預熱了一個 renderer（約 65 MB），由第一次擷取接手；第一次擷取系統音訊會啟動 Chromium 的音訊服務，一直留到結束（約 49 MB，每秒 0.3 次喚醒） | 原生引擎兩者都沒有：第一個視窗開啟前沒有 renderer，錄影後只剩 main、GPU 與網路服務。錄影後待命量得單核 0.036%，Chromium 為 0.054%。擷取程序也不預先啟動（快約 50 ms 不值得約 73 MB，維護者 2026-10-15） |
| 回報的數值 | `getSettings` 曾把 1080p 螢幕回報為 1080×606，所以 renderer 改從靜音影片量測影格；codec 與時間戳的控制只限於 `MediaRecorder` 提供的部分 | 引擎探測來源尺寸、設定編碼器屬性（至少每秒一個關鍵影格、位元率），並在單一單調時鐘上依樣本數為音訊蓋時間戳 |

### 與 Chromium 的實測對照

M1 Pro、60 Hz 1920×1080 螢幕、簽章 bundle，2026-10-14 到 2026-10-16（plan 076）：

| 項目 | 原生引擎 | Chromium |
| --- | --- | --- |
| 錄影 CPU，30 fps（`pnpm measure:cpu`） | 單核 10.4% | 15.3% |
| 錄影 CPU，60 fps | 14.0% | 23.3% |
| 閃光到嗶聲的偏移（`pnpm matrix -- quick`） | −25 ms | +68 到 +74 ms |
| 音訊與畫面的長度差 | 0 ms，含 10 分鐘的錄影 | +13 到 +15 ms |
| 10 分鐘漂移 | 0 ms，600 組閃光與嗶聲全數配對 | — |
| 音質（`pnpm audio:quality`） | 全部檢查通過 | 全部檢查通過 |
| 間隔達 50 ms 的影格 | 0.22–0.44% | 0% |
| 快捷鍵到 `prepared` | 457–535 ms | 347–369 ms |

維護者於 2026-10-16 接受這些結果，包括影格間隔與較慢的開始，Chromium 路徑隨之移除。睡眠、螢幕移除、權限拒絕，以及「隱藏選單列與 Dock」下的 Dock，是留給 [plan 077](../../../plans/077-native-hands-on-acceptance.zh-TW.md) 的親手驗收案例；影格間隔與原生節奏診斷留給 [plan 078](../../../plans/078-native-capture-follow-ups.zh-TW.md)。

## 原生引擎換來的代價

- **Rust 工具鏈。**需要錄影的貢獻者要安裝 rustup 的 stable 工具鏈，Windows 上還要 Visual Studio C++ 建置工具；兩個 CI runner 都會建置 crate 並執行 `cargo test`。不需要錄影的工作可用 `RECORDSTUFF_SKIP_NATIVE=1` 建置。
- **要簽一個 `.node`。**模組從 asar 封存中解出，以 App 的憑證與 hardened runtime 簽章；`start-app.mjs --verify-app` 會拒絕缺少它的 bundle。開發用 Electron 的 `utilityProcess` 會被拒絕擷取（`-3801`），所以錄影與量測都需要簽章的 bundle。
- **平台程式碼寫兩份。**`native/capture/src/mac/` 與 `src/win/` 共用 session 狀態機、節奏控制、混音器與 muxer，但擷取與編碼要各寫一份。Windows 只由 CI 驗證：實際擷取品質、影格時間、自己的視窗是否不被錄到、系統音訊內容、CPU 與麥克風在那裡都未測。
- **綁定可能落後。**`objc2` 與 `windows` crate 可能落後 Apple 或 Microsoft 的新 API；若長期需要某個 API，macOS 改用 Swift 仍是替代方案。
- **原本由 Chromium 負責的程式碼。**ISO BMFF muxer、編碼器設定與時鐘，現在都要由本專案維持正確；Media Foundation 的 AAC 編碼器最高 192 kbps，低於 256 kbps 的要求。

## 延續下來的原則

- **請求不等於結果。**程式要求的、runtime 回報的，以及解碼後檔案中真正留下的，仍是三種強度不同的證據；[音質測試](audio-quality.md)因此量測解碼後的輸出。
- **麥克風旁白需要獨立的音訊政策**（plan 074）。回音消除對麥克風可能有用，但系統音訊軌不應沿用語音處理。
- **沒有傳輸。**錄影路徑沒有 signaling 服務、peer 傳輸、STUN／TURN 依賴或雲端上傳。加入即時分享會是另一套架構，需要另外決定 signaling、連線、驗證與媒體隱私。

## 程式地圖

- [原生擷取 host](../../../src/main/recording/native-capture-host.ts) 與[它的程序](../../../src/main/recording/native-host-process.ts)：main 的監督器，以及載入引擎的 `utilityProcess`。
- [擷取引擎](../../../native/capture/)：Rust crate，包含共用核心、平台模組與 muxer。
- [共用協定](../../../src/shared/protocol.ts)：main 與擷取程序之間的訊息。
- [品質政策](../../../src/shared/quality.ts)：要求的編碼品質。
- [音質測試](audio-quality.md)：已量測的音質、限制與回歸策略。
