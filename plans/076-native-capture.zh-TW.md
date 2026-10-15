# 076 — macOS 與 Windows 的原生錄影引擎

[English](076-native-capture.md) | [繁體中文](076-native-capture.zh-TW.md)

狀態：進行中；步驟 1 已於 2026-10-14 決定，步驟 2 與 3 已於 2026-10-14 完成，步驟 4 已於 2026-10-15 完成（PR #6），步驟 5 已於 2026-10-15 完成，只剩移除 display-media handler，要等步驟 7 之後 D7 的旗標移除；步驟 6 已於 2026-10-15 完成。建立：2026-10-14。優先順序：下一項，排在 074 與 075 之前，因為它的結果決定 074 在哪裡混入麥克風，以及 075 如何讓 RecordStuff 的視窗不出現在錄影中。硬性相依：無。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與邊界

把目前由 Chromium 與寫檔程式負責的錄影部分，也就是擷取螢幕與系統聲音、編碼、封裝與寫檔，換成在 Electron `utilityProcess` 中執行的原生 Rust 模組，並在同一個計畫中完成 macOS 與 Windows。Electron、TypeScript、Settings 視窗、選單列、Recorder 的狀態流程、檔案的生命週期（檔名、sentinel、歷史、通知）與錄影檔庫都保留。成功的標準是：兩個平台經由原生引擎錄下的影片，在量測的畫質、影格時序、音訊保真度與 CPU 上都不比現在差，或者更好；引擎提供下表列出的能力；結案時移除舊的 Chromium 錄影路徑；依步驟 1 的紀錄，macOS 以實機驗證、Windows 以 CI 驗證。

本計畫中引擎提供的能力，以及現在就會用到它們的使用者設定：

| 能力 | macOS | Windows | 本計畫是否開放給使用者 |
| --- | --- | --- | --- |
| 整個螢幕加系統聲音（現在的行為） | ScreenCaptureKit | Windows.Graphics.Capture、WASAPI loopback | 是，行為不變 |
| 排除 RecordStuff 自己的視窗 | `SCContentFilter` 排除本 App 的視窗 | 對其視窗設 `WDA_EXCLUDEFROMCAPTURE` | 是，永遠開啟（075 的 D14） |
| 隱藏系統介面：選單列、Dock、桌面圖示與小工具 | `SCContentFilter` 排除這些視窗 | Windows.Graphics.Capture 做不到（工作列）；由步驟 1 決定 | 是，Settings → Recording 中的開關 |
| 麥克風輸入混進音軌 | AVFoundation 或 Core Audio 輸入 | WASAPI capture | 供 074 使用 |
| 單一視窗、區域、指定 App；單一 App 的聲音 | `SCContentFilter`、`sourceRect`；依 App 篩選的聲音 | Windows.Graphics.Capture 視窗項目、裁切；process loopback（Windows 10 2004 起） | 只做引擎與測試；選擇介面留給之後的計畫 |

不在範圍內：瀏覽器分頁（只有瀏覽器或它的擴充功能能錄單一分頁，屬於另一個產品）、改用 Tauri、編輯器或分軌，以及視窗、區域與 App 的選擇介面。

## 為什麼要原生錄影、為什麼用 Rust、為什麼不換 Tauri（評估）

- **已經量到具體的限制。** [設計決策](../docs/zh-TW/system-design/decisions.md)寫明「量到具體限制後」才考慮原生錄影。Chromium 的 `getDisplayMedia` 只能錄一個螢幕或一個視窗，也只能排除本 App 自己受保護的視窗（Electron 為此修補了 Chromium）；它無法隱藏選單列、Dock 或桌面，無法錄區域或指定 App，也無法只錄單一 App 的聲音。維護者在 2026-10-14 提出的每一項需求，在 macOS 上都需要 `SCContentFilter`，而 Electron 與 Chromium 都沒有開放這個 API。
- **其他產品的做法。** 成熟的桌面錄影軟體都用原生錄影：OBS（每個平台各有錄影外掛）、Cap（Rust，macOS 用 ScreenCaptureKit、Windows 用 Windows.Graphics.Capture）、Screen Studio 與 CleanShot X（原生 macOS）。以瀏覽器為基礎的錄影工具（Loom 的擴充功能、Screenity）只能用瀏覽器 API，功能也受限。
- **Rust，兩個平台用同一種語言。** 作業系統是以二進位呼叫約定開放 API 的（macOS 是 Objective-C runtime 與 C；Windows 是 C、COM 與 WinRT），所以任何編譯式語言都能呼叫。Swift 是 Apple 的第一語言，在 macOS 上最直接，但對 Windows 沒有幫助。Rust 透過綁定套件呼叫 ScreenCaptureKit（Cap 在正式產品中使用 `cidre`），而 `windows-rs` 是微軟官方的綁定。用一種語言就只需要一條錄影流程、一個封裝器（muxer）與一套測試。代價是在兩個既有的 CI job 中加入 Rust 工具鏈（`check.yml` 與 `release.yml` 本來就在 `macos-15` 與 `windows-2025` 上建置）、設定編譯快取，以及綁定套件可能較晚跟上 Apple 的新 API。TypeScript 搭配 Rust 很常見：Cap（TypeScript 介面、Rust 後端）、Signal Desktop（Electron 加 Rust 的 libsignal）、1Password 8（Electron 加 Rust 核心），以及用 napi-rs 打造的 JavaScript 工具。
- **為什麼用 `utilityProcess`。** 原生程式碼當掉時只會結束這個子程序，不會讓整個 App 閃退：已寫入的內容會以可救回的形式留在磁碟上，由 main 完成檔案並回報失敗。它也維持現在的形狀：一個獨立的錄影程序透過 `MessagePort` 與 main 溝通（`prepared`、`record`、`stop`、進度），所以 Recorder 的狀態流程改動不大。
- **為什麼不換 Tauri。** Tauri 一樣是 TypeScript 加 Rust（介面是 WKWebView 或 WebView2 中的 HTML）。改用它要重寫約 14,600 行 main、shared 與 preload 的程式碼，以及約 32,000 行依賴 Electron 的測試與驗收工具，還要更換 Mac 上的網頁引擎；換來的是 App 體積與記憶體上的好處，而[計畫索引](README.zh-TW.md)已經決定不為此重寫。若日後真的選擇搬遷，Rust 錄影模組可以原封不動帶過去，所以這個計畫不是死路。

## 現況

- 隱藏的 renderer `src/renderer/capture/capture-host.ts` 呼叫 `getDisplayMedia`（由 `src/main/index.ts` 中 main 的 handler 回應所選螢幕與 `audio: "loopback"`），以 `MediaRecorder` 編碼成 fragmented MP4（H.264 + AAC 256 kbps），透過 `src/shared/protocol.ts` 的協定每秒送出一個分片。
- `src/main/recording/recorder.ts` 管理整個 session；`file-writer.ts` 寫入分片、每 5 秒同步一次並維護 session sentinel；`mp4-finalize.ts` 追蹤分片，存檔時把檔案轉成一般 MP4（[錄影](../docs/zh-TW/system-design/recording.md)）。
- 品質設定、影格率請求與音訊條件在 `src/shared/quality.ts` 與 `src/renderer/capture/apply-quality.ts`；理由見[錄影](../docs/zh-TW/system-design/recording.md#品質與編碼)與[音訊品質](../docs/zh-TW/system-design/audio-quality.md)。
- 透過 App 錄影的驗證工具：`pnpm acceptance`、`pnpm matrix`、`pnpm audio:quality`、`pnpm measure:cpu`、`pnpm acceptance:lifecycle`（[工具](../docs/zh-TW/system-design/tooling.md)）。
- Cap 的授權（版本 `3d19c5cfa5e636107e78adde6d55be78404d4f23`）：`scap-*` 與 `camera*` 系列套件為 MIT，包含 `scap-screencapturekit`、`scap-direct3d`、`scap-targets` 與 `scap-ffmpeg`；其餘部分，包括它的錄影流程、編碼器與封裝器，皆為 AGPLv3，不得複製進這個 MIT 專案。

## 步驟

### 1. 決定（決定點）

- [x] **D1 語言（2026-10-14 決定：兩個平台都用 Rust）。** 建議：兩個平台都用 Rust（napi-rs）。替代方案：macOS 用 Swift、Windows 用 Rust 或 C++；在 macOS 上最直接、最先用到 Apple 的新 API，代價是維護兩種原生語言。
- [x] **D2 執行方式（2026-10-14 決定：`utilityProcess`）。** 建議：模組載入在 Electron 的 `utilityProcess` 中，透過 `MessagePort` 以既有的訊息格式與 main 溝通。替代方案：直接載入在 main（最簡單，但原生程式當掉會讓整個 App 閃退），或獨立的執行檔（隔離，但必須先證明 macOS 的螢幕錄製權限適用於它）。
- [x] **D3 由誰寫檔（2026-10-14 決定：引擎）。** 引擎負責擷取、編碼、封裝與寫檔，定期同步，並先寫成可從當機中救回的分片格式，存檔時再轉成一般 MP4，和 OBS 的 hybrid MP4 與現在的 `mp4-finalize.ts` 相同。main 保留檔案的生命週期：檔名與資料夾、開始前的剩餘空間檢查、session sentinel、歷史紀錄、通知，以及包含退出與睡眠的狀態流程；引擎以事件回報寫入量與寫入錯誤（磁碟已滿、寫入失敗）。理由：多數容器格式收尾時需要回頭修改檔案（MP4 的索引、MKV 的長度與索引），一旦輸出格式可選，單向送分片給 main 的方式就很難做好；main 的事件迴圈卡住時也不會延遲寫檔；媒體相關的事集中在一種語言。`file-writer.ts` 與 `mp4-finalize.ts` 以 Rust 重寫，沿用它們的設計與測試案例。不採用：把分片送給 main 既有的寫檔程式，現在改動最少，但會擋住其他容器格式。
- [x] **D4 編碼與封裝（2026-10-14 決定）。** 分成兩層、各自可替換。編碼器：平台的硬體編碼器，macOS 用 VideoToolbox 與 AudioToolbox，Windows 用 Media Foundation（顯示卡支援時走硬體，否則用微軟的軟體編碼器；沒有媒體功能套件的 Windows N 版會得到明確的錯誤）。封裝器：本專案以 Rust 自寫的 ISO BMFF 封裝器，涵蓋 MP4 與 MOV，寫出 OBS 式的 hybrid MP4（錄影中為分片格式，存檔時轉成一般 MP4）。本計畫只出 H.264 + AAC 的 MP4，也就是現在的格式；HEVC 與 MOV 是之後在同樣兩層上加的設定。其他格式（GIF、WebM、MKV）屬於之後的匯出功能，屆時可能只為轉檔引入 FFmpeg。依據：錄影軟體多半以系統編碼器加精簡的封裝器錄影（Chromium、Cap、Kap、QuickTime、OBS 的 hybrid MP4），FFmpeg 用在匯出或支援大量格式；錄影路徑不用 FFmpeg，App 保持精簡，也不必處理 LGPL 連結。
- [x] **D5 沿用 Cap 的部分（2026-10-14 決定）。** 適合的地方依賴或改寫 Cap 的 MIT `scap-*` 套件，保留其授權聲明，並記錄每個套件的授權與版本。Cap 的 AGPL 程式碼只作設計參考：可以閱讀以理解做法，但不複製、不逐行翻譯，實作依據 Apple 與微軟的官方文件以及 ISO BMFF 規格。
- [x] **D6 隱藏系統介面（2026-10-14 決定）。** Settings → Recording 中的「隱藏選單列與 Dock」開關，預設關閉，僅限 macOS：錄影中不包含選單列、Dock、桌面圖示與小工具，但使用者螢幕上照常看得到；ⓘ 說明 App 打開的下拉選單仍會被錄到，因為那是該 App 的視窗。Windows 上開關顯示為無法使用並說明原因（Windows.Graphics.Capture 無法排除工作列），也不做裁切。預設關閉，因為更新後既有的錄影結果不應改變，而且「螢幕上看到什麼就錄到什麼」是使用者預期的行為；Loom 與 CleanShot X 也是把它做成選項。
- [x] **D7 過渡方式（2026-10-14 決定）。** Chromium 路徑保留為開發用旗標以便對照，原生引擎在 macOS 通過步驟 7 後即於本計畫中移除；Windows 一起切換，由 CI 檢查（D8）。
- [x] **D8 Windows 驗證（維護者於 2026-10-14 決定）。** Windows 只由 CI 驗證，和現在所有 Windows 變更一樣：`windows-2025` job 建置模組、執行測試並載入它，並在 runner 桌面允許的範圍內實際錄影。CI 無法驗證的部分在本計畫的結案紀錄與發布紀錄中列為未測試，交由使用者回報；不做 Windows 實機或虛擬機回合。

步驟 1 已全部由維護者於 2026-10-14 決定。

### 2. macOS 原型與量測關卡（決定點）

- [x] 一個最小的 Rust 模組：透過 ScreenCaptureKit 錄下所選螢幕與系統聲音，排除 RecordStuff 的視窗，可選擇隱藏選單列與 Dock，以 VideoToolbox 與 AudioToolbox 編碼，經由 D4 的封裝器寫出 hybrid MP4 檔（commit `c4f9a2dd`；在 `9df50a25` 優化）。以 `RECORDSTUFF_CAPTURE_ENGINE=native` 選用。
- [x] 權限：在簽章的 `pnpm start:app` bundle 上，螢幕與系統聲音的授權適用於 `utilityProcess` 中的模組。開發版 Electron 的 `utilityProcess` 會被拒絕（`-3801`），所以原生量測都使用簽章 bundle。因為已經授權過，沒有看到第一次的權限提示。
- [x] 當機安全性：錄影中強制結束 `utilityProcess`，留下 8.0 s 可播放的部分檔案。兩個 track 的長度差 147 ms，因為各自約每秒才寫出一次分片。
- [x] 2026-10-14 在同一台機器上與現有引擎比較，數據為優化回合之後（括號內為 Chromium）：
  - 開始：快捷鍵到 `prepared` 457–535 ms（347–369 ms）；`record` 到 `started` 2 ms（1–2 ms）。
  - 聲音與畫面的長度差：每個檔案都是 -0 ms，包含 10 分鐘的錄影（+13 到 +15 ms）。
  - 掉幀：30 fps 0.00%，60 fps 0.06–0.22%（0.00%；0.14–0.22%）。
  - 錄影 CPU，30/60 fps：10.0–10.5% / 15.0%（15.6% / 23.0%）。
  - 10 分鐘 drift：0 ms，600 組閃光與嗶聲全部配對。
  - 閃光到嗶聲的 offset：-22 到 +9 ms，同一段錄影內固定（+6 到 +8 ms）。
  - `pnpm matrix` 與 `pnpm audio:quality record` 無法驅動原生引擎，因為開發版 Electron 被拒絕擷取。改用 `pnpm acceptance` 加 `pnpm verify --sync`、在播放測試素材的錄影上跑 `audio:quality verify`，以及在簽章 bundle 上跑 `pnpm measure:cpu`。
  - 原生模式下，`pnpm measure:cpu` 因 Electron 預先啟動的 renderer 在 `IDLE_ROLES` 判定失敗，由步驟 4 處理。
- [x] 已回報給維護者。維護者於 2026-10-14 決定在優化回合後繼續。接受的取捨：開始比 Chromium 慢約 0.1 秒，落在倒數之內。後續項目在步驟 4（影格時序、開始延遲、閒置的 renderer），以及其寫檔項目（把停止與檔案收尾分開）。

### 3. Windows 原型

- [x] 同一個模組的 Windows 版：以 Windows.Graphics.Capture 擷取螢幕、WASAPI loopback 擷取系統聲音、Media Foundation 編碼 H.264／AAC，使用共用的封裝器；對 RecordStuff 的視窗設 `WDA_EXCLUDEFROMCAPTURE`（PR #5）。
- [x] 在 `windows-2025` 的 CI 上：建置、`cargo test`、載入模組，並嘗試一段帶系統聲音的短暫螢幕錄影。runner 的工作階段能否擷取本身就是一項發現；不能的話，錄影列為未測試，而不是失敗。runner 可以擷取：`native-windows` job 在 commit `886a7f55` 通過。
- 完成內容（2026-10-14，PR #5）：
  - 錄影的狀態機從 `mac/session.rs` 移到 `native/capture/src/core/`，以平台的影格、encoder 與時鐘為泛型，兩個平台共用同一套節奏、停止與停止前聲音的規則。它有以假 encoder 寫的測試，兩個平台都會執行。macOS 已在簽章 bundle 上重新驗證（`pnpm acceptance`、`pnpm verify --sync`、`pnpm measure:cpu`）。
  - `native/capture/src/win/` 實作模組：
    - Windows.Graphics.Capture，由 Direct3D 11 video processor 轉成 NV12。裝置沒有 video processor 時（沒有 GPU 的機器上的 WARP，例如 runner），每張畫面複製到 staging texture，要編碼的畫面再於 CPU 上轉換（`nv12.rs`）。
    - WASAPI process loopback，排除 RecordStuff 的 process tree。
    - Media Foundation 的軟體 H.264 encoder，每一秒呈現時間產生一個 key frame。
    - 它的 AAC encoder，最高只接受 192 kbps，建立時量測 priming。
    - `avc.rs` 把它的 Annex B 輸出轉成封裝器的格式。
  - main 傳入螢幕上一個實體座標點（Electron 的 display id 在 Windows 上對應不到螢幕），並在錄影期間把自己的視窗設為 `setContentProtection(true)`（`capture-exclusion.ts`）。Windows 建置需明確開啟（`RECORDSTUFF_BUILD_NATIVE=1`），所以在步驟 6 之前 check 與 release 建置都不變。
  - `check.yml` 的 `native-windows` job 執行 `cargo test`、以 `ffprobe`／`ffmpeg` 解碼合成檔，再把「只有系統聲音」、「只有畫面」和完整三秒錄影各自在獨立 process 中實錄（失敗時以 `cdb` 加 full page heap 重跑），最後在 Node 中載入模組。最初幾輪找到兩個缺陷，都已修正：runner 的裝置沒有 video processor；loopback 啟用參數的 `PROPVARIANT` 在 drop 時釋放了放在 stack 上的參數。
  - runner 上的結果（run 38569135126）：1024×768 螢幕走 CPU 轉換；`prepare` 92 ms；三秒錄到 6 個影片 sample（3 個 key frame，桌面靜止）與 141 個 AAC 封包，兩條軌都是 3000 ms；drain 2 ms，沒有補靜音；量到的 AAC priming 為 0 frame；Node 的 `probe` 回傳 1024×768。合成檔解碼沒有錯誤。
  - Windows 上未測試（D8）：video processor 與硬體路徑、畫面內容與品質、聲音內容與 A/V 同步、自己視窗的排除、多螢幕的 DPI、CPU、長時間錄影。
- 從這個原型移到步驟 4：硬體 H.264 encoder（非同步 transform）、沒有聲音播放時的音訊（process loopback 可能不送封包，音訊分片會等到下一次有聲音），以及在真實 Windows 硬體上確認量測到的 AAC priming（runner 上為 0；如果 encoder 的輸出實際上有延遲，聲音就會晚那麼多）與自己視窗的排除；依 D8，這些留給使用者回報。

### 4. 引擎

- [x] 新增 Rust crate（提議為 `native/capture/`）與 napi-rs 綁定，以 `cargo test` 測試封裝器、時間戳與來源篩選，平台模組藏在同一個 Rust 介面後面。crate 從步驟 2 就存在；步驟 4 在同一個 `Core` 後面加入來源與混音器（2026-10-15）。
- [x] 寫檔（D3）：Rust 的寫檔與封裝器接手 `file-writer.ts` 與 `mp4-finalize.ts` 的工作（定期同步、寫入錯誤分類、分片索引、存檔轉一般 MP4），並移植它們的測試案例；main 保留 sentinel、剩餘空間檢查、發布與歷史，結案時移除這兩個 TypeScript 模組。步驟 2 的原型在回報 `stopped` 前就把檔案收尾，所以慢速磁碟的存檔會落在 recorder 10 秒的停止期限內，被當成 `stop_timeout` 終止（步驟 2 的 review）：要把擷取停止和檔案收尾分開，就像現在 renderer 停止和 main 收尾是分開的。
  - 2026-10-15 完成：引擎的 `stop` 在擷取與編碼器停止後就回覆，另一個 `finish` 在檔案轉成一般 MP4、或確定為何沒轉成時回覆。host 先送 `stopped`，再送新的 `finished`（或 `writeError`）。recorder 回到 idle 後，`NativeCaptureHost` 讓正在收尾的 process 繼續執行，把結果交給 `EngineFileWriter`，之後才結束它，上限 150 秒。桌面上，recorder 在 `stopped` 後 0–1 ms 回到 idle，檔案在 19–22 ms 後完成。
  - 封裝器的測試已涵蓋 TypeScript 中適用於它的案例（64-bit `mdat`、分片索引、索引寫入失敗時保留 fragmented）；`file-writer.test.ts` 的其餘部分是附加 chunk 與發布，留在 main。沒有慢到會超過舊期限的磁碟可測：分開的效果以事件順序與單元測試證明。
- [x] 時鐘與同步：每個 session 使用一個單調時鐘（mach absolute time；QueryPerformanceCounter）；音訊時間戳以累計樣本數計算，空隙以靜音補上，和 Cap 一樣，讓長時間錄影的聲音不會相對畫面漂移。步驟 2 起就已實作（`timing.rs`）；步驟 4 的混音器對每個輸入各自維持。
- [x] 影格時序，來自步驟 2 的優化回合（commit `9df50a25`，維護者 2026-10-14 的要求），2026-10-15 在簽章 bundle 上量測：
  - 統一停止規則：影格的時間早於停止點才保留。已完成；有測試送入時間剛好在停止點的影格。封裝器的丟棄保留為保險。
  - 擷取間隔：要求每次刷新時，30 與 60 fps 都掉了 0.17%；四分之一幀間隔則是 0.06% 與 0.11%，CPU 差不多（30 fps 10.8% 對 10.4%，60 fps 14.4% 對 15.0%）。維持四分之一。
  - 影格時間：顯示時間的閃光與嗶聲 offset 為 -7 與 -15 ms，掉幀 0.22–0.27%；送達時間為 +5 與 +3 ms，但掉了 1.4% 與 16%，因為送達時間隨 callback 排程抖動，pacer 的時間格會留下錯的影格。維持顯示時間。兩項結果都寫在 `pacing.rs`，量測用的兩個開關已移除。
- [x] 開始延遲：步驟 2 的優化回合之後，原生引擎從按下快捷鍵到 `prepared` 需要 457–535 ms，Chromium 需要 347–369 ms。原生的時間由三部分組成：`utilityProcess` 啟動（74–88 ms）、shareable content 查詢（59–83 ms），以及 ScreenCaptureKit 的 `startCapture`（206–227 ms）。
  - [x] 用同樣的方式替 Chromium 路徑的開始流程分段計時。已完成（`CaptureHost.phase`）：隱藏視窗在 83–84 ms 就緒，螢幕在 98–101 ms 前回覆，Chromium 自己的擷取啟動與 `MediaRecorder` 花掉剩下的 180–215 ms，從 `start` 起 282–313 ms 到 `prepared`。
  - [x] 量測預先啟動擷取用的 `utilityProcess`。以開發用開關量測（之後已移除）：快捷鍵到 `prepared` 為 437–439 ms，不預先啟動為 484–497 ms，Chromium 為 369–395 ms；代價是多一個約 73 MB 的閒置 process。
  - [x] 把延遲與記憶體回報給維護者，由維護者決定；這個 process 會改變[在選單列待命](../docs/zh-TW/system-design/design-overview.md#在選單列待命)的閒置清單。維護者於 2026-10-15 決定：不預先啟動。快約 50 ms 不值得閒置時一直多佔約 73 MB 的 process，而且開始仍在倒數時間內，所以閒置清單不變。
- [x] 閒置的 renderer：Electron 44 在第一次使用預設 session 時會預先啟動一個 renderer，而 display-media handler 在啟動時就會使用預設 session。走 Chromium 時，第一個 capture host 會用掉它；走原生時沒有人用，所以它一直留著（約 65 MB），錄影後的 `pnpm measure:cpu` 因此在 `IDLE_ROLES` 判定失敗。
  - 原生模式下，main 不再註冊 display-media handler；錄影檔庫的 media protocol 啟動時也會使用預設 session，改為在第一個視窗建立時才註冊。
  - 原生模式的 `pnpm measure:cpu` 通過 process 角色檢查：啟動時與錄影後都沒有 renderer。
  - Settings 第一次開啟：原生 253–341 ms，有預先啟動的 renderer 時 241–245 ms（341 ms 那次是建置後第一次啟動）。
- [x] 輸入：螢幕（現在就用）、視窗、區域與 App 篩選、單一 App 聲音（只做引擎與測試）、麥克風（供 074），每一項都有清楚的錯誤，對應到既有的 `HostErrorCode` 或新代碼。
  - 2026-10-15 實作：`prepare` 接受來源（螢幕、視窗、區域、App）與聲音（系統聲音、指定 process 的聲音或無，加上麥克風，預設裝置或指定 id）；`microphones()` 列出輸入裝置。core 把每個輸入混進同一條 AAC 音軌（`core/mixer.rs`）；某個輸入沒送資料時，音軌跟著時鐘、落後 500 ms 前進，所以 WASAPI loopback 的靜音不再讓音訊分片停住。錯誤使用 `capture_start_failed` 並附原因；給使用者看的錯誤碼隨選擇器與 074 加入。
  - macOS：以這台 Mac 的 live test 驗證（視窗、區域、單一 App 的視窗與聲音，各 3 秒，影音長度相同），也透過簽章 App 驗證（區域與 Finder 視窗，`RECORDSTUFF_CAPTURE_SOURCE`）。錄視窗一開始會讓擷取 process 結束（`CGS_REQUIRE_INIT`，沒有 window server 連線），已修正。macOS 尚未詢問過麥克風權限時，麥克風會拒絕，因為 AVFoundation 此時只送出靜音；它的聲音在這裡未測，因為執行測試的 App 沒有權限。
  - Windows：Windows.Graphics.Capture 的視窗與裁切、每個 process 的 loopback、WASAPI 麥克風；只錄指定 App 的視窗會被拒絕（Windows.Graphics.Capture 做不到）。`native-windows` job 在 commit `985221bd` 通過（run 38692860341）：區域錄成 640×360，測試自己開的視窗錄成 786×592，各 3001 ms，音軌一樣長（區域那次關掉系統聲音，整段是時鐘補上的靜音）；單一 process 的聲音成功開啟、讀取並停止。runner 沒有音訊輸入，所以 Windows 麥克風未測，步驟 3 列出的項目也同樣未測。
- [x] 品質：`src/shared/quality.ts` 中的既有設定（尺寸上限、影格率、位元率）改由原生端套用；`CaptureReport` 維持原有欄位，讓 Recorder、log 與警告維持原樣。步驟 2 起就已實作（`native-host-process.ts`）。
- 過程中的發現：`pnpm measure:cpu` 的情境 C（Settings 開在其他 App 後面）在兩次原生執行量到 38.5% 與 39.0%，一次 Chromium 執行量到 10.0%；同一個 build 的另外兩次是 0.15–0.18%。忙碌的是 Settings 的 renderer 與 GPU process；它不只發生在原生引擎。原因於 2026-10-15 查明：游標停在錄影檔的卡片上，卡片的 hover 預覽便在 Finder 後面持續循環播放（以 `--hover-card` 量到 33.6%）。runner 現在會先把游標移開（PR #7），Settings 失去焦點時也會停止預覽、沒有焦點時不會開始預覽（PR #8；之後 `--hover-card` 量到 0.33%）。

### 5. 整合

- [x] 以載入模組的 `utilityProcess` host 取代隱藏的錄影 renderer，並使用既有協定（`ready`、`ping`／`pong`、`start` → 帶著 main 決定的檔案路徑回 `prepared`、`record`、進度與寫入錯誤、`stop` → 完成、失敗），讓 `recorder.ts` 保留它的狀態、期限、倒數與退出處理；只調整新 host 需要的部分。
  - 2026-10-15 完成：host 從步驟 2 就已存在，recorder 的狀態也維持不變；步驟 5 改變的是由哪個引擎錄影（`capture-engine.ts`）。macOS 預設由原生引擎錄影，D7 的開發旗標改為 `RECORDSTUFF_CAPTURE_ENGINE=chromium`，用來改回隱藏 renderer 做並排比較。
  - Windows 在步驟 6 讓 check 與 release 建置帶上模組之前，預設仍是隱藏 renderer，可用 `=native` 選用；在那之前切換，Windows 會沒有可用的錄影引擎。因此 D7 的「Windows 一起切換」順延一步。
  - 在全新的簽署 bundle 上不設任何變數，log 寫著 `capture engine: native`，`pnpm acceptance -- --seconds 10 --skip-cancel --no-open-material` 以快捷鍵存出 10.3 秒、1920×1080 的檔案，可完整解碼，音訊與影像一樣長。沒有開測試素材時畫面靜止、沒有聲音，所以聲道能量與位元率如預期未通過；完整驗收屬於步驟 7。
- [ ] D7 的旗標移除後，從 `src/main/index.ts` 移除 display-media handler 與 loopback 請求；保留螢幕選擇與其診斷。在那之前，main 只在由隱藏 renderer 錄影時註冊這個 handler。
- [x] Settings → Recording：D6 的開關與 zh-TW 字串；075 的「排除自己的視窗」規則移到這裡，永遠開啟。
  - 2026-10-15 完成：「隱藏選單列與 Dock」（英文 Hide menu bar and Dock）位於「螢幕」之後，預設關閉，錄影中鎖定，存在 settings.json 的 `hideSystemUi`；ⓘ 說明使用者打開的選單仍會被錄進去，因為它屬於該 App。Windows 上這一列是「隱藏工作列」，顯示為關閉且無法使用，並附註 Windows 無法把工作列排除在錄影之外。只有 macOS 會把開關傳給引擎；`RECORDSTUFF_HIDE_SYSTEM_UI` 已移除。
  - 開關打開時，引擎回報隱藏了 35 個系統視窗，畫面中原本是選單列的位置變成桌布；開關關閉時選單列有被錄進去。兩次錄影時 Dock 都不在畫面上，所以這裡沒有證明 Dock 被排除。
  - 原生引擎以 ScreenCaptureKit 的 App 篩選把 RecordStuff 排除在每一段錄影之外，開始後才開的視窗也包括在內；Windows 上則用 `WDA_EXCLUDEFROMCAPTURE`。沒有任何設定會關掉它。這一輪沒有在被錄的螢幕上開著 Settings 錄影：自己的視窗不出現在畫面中，屬於步驟 7 的驗收項目。

### 6. 建置與發布

- [x] 在兩個 runner 的 `check.yml` 與 `release.yml` 中加入 Rust 工具鏈與 cargo 快取；`.node` 二進位從 asar 中解出，在 macOS 上隨 App 一起簽章；Windows 安裝檔的冒煙測試涵蓋載入它。
  - 2026-10-15 完成：macOS 與 Windows 的每次建置都會編譯模組，因此 Windows 的 check、installer 與發布建置都帶有它；沒有 Cargo 的建置現在會失敗，而不是產出無法錄影的 App，`RECORDSTUFF_SKIP_NATIVE=1` 可刻意略過（CI 中從不錄影的背景 UI 分片）。因此 Windows 也預設以原生引擎錄影，`RECORDSTUFF_CAPTURE_ENGINE=chromium` 與 macOS 一樣可改回隱藏 renderer：D7 的切換在兩個平台都完成。
  - `check.yml` 在 `check`、`windows-installer` 與 `native-windows` job 以 `Swatinem/rust-cache` 保留 Cargo 的輸出；發布建置只確認有 Rust，不使用快取，讓發布的內容完全由原始碼建出。
  - macOS：electron-builder 本來就以 App 的憑證與 hardened runtime 簽署解出的模組。本機 bundle 與發布時掛載的 DMG 都會經過的 `start-app.mjs --verify-app`，現在要求它存在並檢查其憑證（真實 bundle 通過；拿掉模組的副本被拒絕）。
  - Windows：installer smoke（`windows-smoke`、`candidate-windows`、`published-windows`）會以 `scripts/native-load.mjs` 在 Node 中載入安裝後的模組。
- [x] `pnpm check` 執行 `cargo test` 與建置後模組的載入測試；[CONTRIBUTING.md](../CONTRIBUTING.md) 的開發環境設定寫明需要 Rust。
  - 2026-10-15 完成：`pnpm check` 依序為 typecheck、Vitest、`pnpm test:native`（`cargo test --lib`）、建置，以及 `node scripts/native-load.mjs`：載入模組並確認 capture host 會呼叫的方法都在，不進行擷取。驗證 recipe 也跟著調整。本機通過：1946 個 Vitest 測試、65 個 Rust 測試（5 個 live 測試如常略過），模組可載入。

### 7. 驗證工具與驗收

- [x] 讓 `pnpm acceptance`、`pnpm matrix`、`pnpm audio:quality`、`pnpm measure:cpu` 與 `pnpm acceptance:lifecycle` 改用新的 host，報告格式不變。受控 build（`pnpm acceptance:controlled` 與 tray runner 的受控案例）從步驟 5 起固定由隱藏 renderer 錄影，因為它的寫入與關閉錯誤注入包在該路徑的 FileWriter 上；要讓引擎的寫入也能注入錯誤，再取消這個固定。
  - 2026-10-15 完成（不需要桌面）。會啟動 App 的 runner 接受 `--engine native|chromium`（預設 native），把 shell 的擷取開關從 App 的環境中移除，確認 App 記錄的引擎，並在報告中寫出；`measure:cpu` 在這一輪透過 launchd 設定引擎。`measure:cpu` 以原生引擎自己的待機契約判定（`NATIVE_IDLE_ROLES`：沒有預熱 renderer、沒有音訊服務、沒有擷取 process），CPU 基準依引擎分開，原生的一輪會在自己的數字旁列出隱藏 renderer 的基準。`audio:quality` 的指紋涵蓋引擎原始碼，建置上限放寬為 10 分鐘。`pnpm acceptance` 的開始時間軸讀取原生引擎的 process、probe 與 prepare 時間，並把它每秒一次的第一個進度回報標示清楚。
  - `measure:finalization` 自從存檔改在背景進行（2026-10-09）後就找不到樣本：現在不論順序都會把停止與存檔配對，並加入 stop→saved、finalize 與引擎完成時間。
  - `acceptance:lifecycle` 新增 `native`（在 `stopped` 之後延遲引擎的完成結果）與 `native-crash`（當機後保留引擎的 partial）；六種模式全部通過。受控 build 以 App 的引擎錄影，固定已取消，原生引擎的寫入與關檔故障分別透過其進度與完成結果注入。
  - `diagnose:cadence` 自行建立隱藏 renderer 的擷取 host，仍只量那個引擎；原生引擎沒有提供逐格時間戳給它。
- [ ] macOS：完整的錄影驗收、與本計畫風險相關的 matrix 案例、音訊保真度測試、新的 CPU 基準（`pnpm measure:cpu -- --fps 60 --repeat 3`）、生命週期、錄影中退出與睡眠、權限被拒、螢幕移除、影格中沒有自己的視窗，以及 D6 的開關。
  - 第 1 輪，錄影品質（2026-10-15，主螢幕為 60 Hz 的 BenQ，1920×1080）。`pnpm acceptance -- --seconds 30` 以原生引擎在簽署 bundle 上通過（60 fps）。原生 `pnpm matrix -- quick` 共 9 次：30 fps 時約佔一個核心的 9–10%，Chromium 為 15%；閃光對嗶聲 −25 ms，Chromium 為 +68 到 +74 ms；但有 0.66–2.17% 的影格間隔 50 ms，Chromium 為 0（一次超過 2% 的門檻；第一次的第一個案例沒找到閃光，素材尚未全螢幕）。`pnpm audio:quality` 兩個引擎都通過每一項（時脈原生 −0.07 ppm、Chromium −1.45 ppm；增益與殘差相同）。
  - 間隔的原因於 2026-10-16 以停止報告的新計數（有畫面的影格、沒有畫面的送達、畫面之間最長的間隔）找到：擷取從未漏掉任何一次更新（最多相隔 33.3 ms），但每 15 秒送來 15–37 個 idle 影格，也就是螢幕沒有變化的更新，而 idle 更新所在的格位會晚一次更新才拿到下一張畫面。現在引擎會在這樣的格位再編碼一次最新的畫面（`frame_unchanged`）。再錄 3 次：0.22–0.44%，CPU 不變；其餘原因尚未找到。
  - 第 2 輪，CPU 基準（2026-10-16，同一個螢幕，使用含 idle 修正的簽署 bundle）：兩個引擎的 `pnpm measure:cpu -- --fps 60 --repeat 3` 都通過。原生錄影在 30 fps 佔一個核心的 10.4%（10.4–10.5%），60 fps 為 14.0%（14.0–14.2%），Chromium 為 15.3% 與 23.3%；啟動後待機 0.108% 對 0.056%，錄影後待機 0.036% 對 0.054%，且只剩 main、GPU 與 network（Chromium 錄影後會留下音訊服務），Settings 在其他 App 後面 0.136% 對 0.300%，播放 16.0% 對 16.9%。中位數成為這台機器的新基準（`cpu-baselines.json`）。
  - 第 3 輪，選單列（2026-10-16，簽署 bundle，原生）：`pnpm acceptance:tray` 通過 14 個案例（從選單開始與停止、錄影與待機選單、倒數的三種取消方式（含「退出」）、鍵盤操作、顯示最新錄影、選單點擊、待機時退出）；兩個案例因腳本輸入的時序競爭而未執行（選單打開時倒數已結束；macOS 先送出「開始」再處理排隊的快捷鍵），與引擎無關。
  - 尚待完成：錄影中退出與影格中沒有 RecordStuff 自己的視窗，需要目前已 commit 的 runner 都還沒有的案例；D6 的 Dock 需要 Dock 在畫面上；錄影中睡眠、螢幕移除與權限被拒需要維護者動手，依維護者指示（2026-10-16）連同 Dock 移到 [077](077-native-hands-on-acceptance.zh-TW.md)。剩下 0.22–0.44% 的影格間隔、開發版 App 自己視窗的警告與原生節奏診斷移到 [078](078-native-capture-follow-ups.zh-TW.md)。
- [ ] Windows：步驟 3 的 CI 檢查與安裝檔冒煙測試；CI 無法顯示的部分（實際錄影品質、沒有自己的視窗、系統聲音內容、CPU、影格時序）列為未測試。

### 8. 文件

- [ ] 更新[設計決策](../docs/zh-TW/system-design/decisions.md)（Electron／TypeScript、內建 `getDisplayMedia`／`MediaRecorder` 與隱藏錄影 renderer 這幾列）、[架構](../docs/zh-TW/system-design/architecture.md)、[錄影](../docs/zh-TW/system-design/recording.md)、[音訊品質](../docs/zh-TW/system-design/audio-quality.md)、[WebRTC](../docs/zh-TW/system-design/webrtc.md)、[工具](../docs/zh-TW/system-design/tooling.md)、[函式](../docs/zh-TW/system-design/functions.md)、[儲存庫](../docs/zh-TW/system-design/repository.md)與[概覽](../docs/zh-TW/system-design/overview.md)，英文版同步更新；README 與官網說明頁補上 D6 的開關。
- [ ] 在 074 與 075 中註明引擎現在提供了什麼。
- [ ] 學習文章：撰寫[索引清單](README.zh-TW.md#074076-的學習文章)中，所依據的計畫已隨本計畫全部結案的文章；依主題劃分，而不是依計畫劃分。

## 完成與驗證邊界

完成條件：步驟 1 與步驟 2 的決定已記錄；macOS 經由原生引擎錄影，在量測項目上的結果至少與現在相同，或每一項退步都已記錄並經維護者接受；Windows 通過 CI 檢查，其餘列為未測試；macOS 上自己的視窗不會出現、D6 可正常運作；Chromium 路徑已移除；文件與本次結案應寫的學習文章已更新。

檢查依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)。本計畫改動錄影開始與停止、錄影 host 與協定、編碼、權限、打包、CPU 與音訊保真度，所以這些列全部適用：`pnpm check`，加上在新的 `pnpm start:app` bundle 上跑一次錄影冒煙回合、受影響的 `pnpm matrix` 案例、`pnpm audio:quality`、建立新基準的 `pnpm measure:cpu`，以及 `pnpm acceptance:lifecycle`；最後一輪跑 `pnpm acceptance:regression`。桌面回合依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)與[原生驗收 skill](../.agents/skills/native-acceptance/SKILL.md)進行。Windows 只由 CI 檢查（D8）；未測試的項目列在結案紀錄中，不回報為通過。

撰寫本計畫只需要：連結與錨點、既有與提議中的指令、中英文一致，以及 `git diff --check`；不需要測試、建置或啟動 App。

結案時，把設計寫進系統設計文件，結果連同翻譯寫進驗證紀錄，更新兩份索引，並依專案的完成規則移除計畫檔案。除非使用者要求，否則不 commit、push 或發布。
