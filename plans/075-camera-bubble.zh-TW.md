# 075 — 合成進錄影的鏡頭，在即時預覽中擺放

[English](075-camera-bubble.md) | [繁體中文](075-camera-bubble.zh-TW.md)

狀態：進行中；2026-10-17 依維護者要求重新設計（鏡頭改由引擎合成，和 OBS 一樣，不再是螢幕上的泡泡視窗）；步驟 1 的決定已於 2026-10-17 記錄；步驟 2 的原型以開發用開關建置，2026-10-17 量測結果超出 D18 的預算；依維護者的選擇，Metal 上的共用 shader 與 D17 的第二個選項已於同日建置並量測：除了預覽本身多出的部分（10.5 與 8.7 點，預算 8 點）之外都在 D18 之內，這部分維護者已接受；關卡通過，裝置變更檢查延後到有可拔插的相機時再做。建立：2026-10-14。優先順序：在 078（2026-10-17 結案，[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-078-結案--2026-10-17)）之後，它的步驟 4（Windows 畫面留在 GPU 上）與步驟 6（macOS 上來來去去的裝置）是本計畫的基礎。硬性相依：076 的引擎，它掌管畫面、時鐘與編碼器；078 的 GPU 畫面與裝置發現；074 的權限卡片與失敗處理模式（[桌面](../docs/zh-TW/system-design/desktop.md)、[錄影](../docs/zh-TW/system-design/recording.md)）。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與邊界

讓使用者把自己的鏡頭以泡泡放進錄影中，泡泡的寬、高、圓角、位置與鏡像都能自由設定，錄影中也能更改，設定的地方是 Settings 中顯示合成後錄影的預覽。泡泡由引擎畫進錄下的影格，而不是以視窗顯示在螢幕上：使用者的螢幕保持乾淨，沒有東西蓋住下方的 App 或攔下它的點擊，泡泡的控制項也不可能被錄進去。

成功的標準是：鏡頭開啟時，存下的 MP4 中鏡頭的擺放、大小、圓角與鏡像與預覽所示相同，錄影中的變更也精確到影格；錄影前，預覽以等比例顯示所選螢幕，即時鏡頭放在正確位置；錄影中，預覽顯示的就是合成後的錄影本身；托盤可以隱藏與顯示鏡頭；RecordStuff 自己的視窗和以前一樣不出現在錄影中；鏡頭關閉時一切不變，錄影也一樣；成本維持在步驟 2 設定的預算之內。

不在範圍內：獨立的鏡頭軌或檔案與事後編輯（Cap Studio、Screen Studio）、背景模糊或去背、只錄鏡頭或全螢幕鏡頭模式、多個鏡頭、螢幕上的鏡頭視窗，以及 Windows 實機（只由 CI 檢查）。

## 重新設計（2026-10-17）

2026-10-14 的設計錄下一個被螢幕擷取錄進去的泡泡視窗（Loom、Cap 的 Instant 模式）。被問到為什麼錄影中擺放要鎖定時，維護者改選 OBS 的模式。視窗設計之所以鎖定擺放，是因為視窗上畫的任何東西都會被錄進去，而可移動的視窗必須攔下原本要點到下方 App 的點擊；在引擎中合成就同時消除了這兩個理由。它也讓使用者不必在螢幕上看到泡泡：它蓋住什麼，預覽中都看得到。

所檢查的產品中沒有一個錄下看不見、固定不動的泡泡：鏡頭一旦合成，OBS 會在預覽中顯示結果，Cap Studio 與 Screen Studio 則讓它事後再移動。本計畫跟隨 OBS、即時進行，因為 RecordStuff 沒有編輯器。

## 技術架構適合嗎？效能（評估）

合成方面適合；預覽是唯一屬於 Electron 特有的成本，也是步驟 2 最先量測的項目。

目前工作在哪裡執行（076，2026-10-16 在參考用的 M1 Pro 上量測）：`utilityProcess` 中的 Rust 引擎把 ScreenCaptureKit 的畫面以 `CVImageBuffer`（GPU 記憶體、IOSurface）直接送進 VideoToolbox（`native/capture/src/mac/session.rs`、`video.rs`）；Windows 上畫面經由 Direct3D 11 video processor 留在 GPU 上（`win/capture.rs`），只有在沒有 video processor 的裝置（WARP）上改在 CPU 轉換。以 30／60 fps 錄影耗用一個核心的 10.4%／14.0%，預算為 30%／40%（[CPU 預算](../docs/zh-TW/system-design/tooling.md#cpu-預算)），麥克風再多 3.4 個百分點（13.3%），編碼服務約 2.7%。Electron 只負責畫 UI。

| 鏡頭增加的成本 | 在哪裡 | 預期大小 | 原因與風險 |
| --- | --- | --- | --- |
| 鏡頭擷取 | 引擎，AVFoundation（`AVCaptureVideoDataOutput`） | 小 | 畫面以 IOSurface 為底的 `CVPixelBuffer` 送達，格式是鏡頭原生的 YUV，沒有複製；720p、30 fps。風險在裝置變更而不在成本：AVFoundation 的裝置狀態需要 utility process 所沒有的主 run loop（074 的探查），音訊由 078 步驟 6 解決，影像由本計畫解決（D16） |
| 合成 | 引擎，GPU（macOS 上 Metal 或 Core Image，Windows 上 Direct3D 11） | CPU 小，GPU 有一些 | 每格在螢幕畫面上畫一個帶圓角遮罩與翻轉的貼圖四邊形，在 GPU 記憶體中、於編碼器之前完成。60 fps 的 4K 畫面完全在內顯的能力之內；CPU 只負責編碼指令。風險：CPU 的退路（Windows WARP）每格要付出一次整格複製 |
| 螢幕靜止時的影格 | 引擎，pacer 與編碼器 | 最大的新增成本 | 目前螢幕靜止時每秒只送一格；鏡頭顯示時每一格都會變，所以編碼器一直以完整幀率運作。硬體編碼讓它大致維持在上面畫面變動時的數字，不會更多 |
| 錄影中的預覽 | 引擎 → Settings renderer | Electron 特有的風險 | OBS 與 Cap 都在 GPU 上以原生方式畫預覽（Cap：IOSurface 到 Metal 到 wgpu，`apps/desktop/src-tauri/src/camera.rs`）；Chromium 頁面則必須接收畫面。若做得天真（原始畫面走 IPC、每格重畫 canvas），CPU 就耗在這裡：計畫 072 量到一個 renderer 在其播放器播放錄影時佔一個核心的 74–77%，來自每個影像格周圍的工作。選項見 D17 |
| 錄影前的預覽 | Settings renderer，`getUserMedia` | 小 | 只有預覽大小的鏡頭，以 `<video>` 顯示；螢幕用既有的排列外框表示，所以面板仍然從不擷取螢幕 |
| 記憶體 | 引擎 | 數十 MB | 合成後畫面與預覽用的 pixel buffer pool |

限制不在技術架構本身。改用 Tauri 不會改變合成（同樣的原生工作），預覽也同樣要透過 web view 顯示；Cap 以原生 GPU 視窗避開這點，在 Electron 中這代表由 main 承載、跨程序餵資料的原生圖層，若步驟 2 顯示網頁預覽成本太高，就以此為退路。Electron 44 實驗性的 `sharedTexture` 模組可以把 IOSurface 或 Direct3D 11 shared handle 不經複製匯入 renderer 成為 `VideoFrame`，但只能從 main 匯入，所以引擎的 surface 得先送到 main（Mach port 或 shared handle）；以 WebCodecs 解碼的低解析度預覽串流則不需要新的程序間管線。原型關卡（步驟 2）以量測在兩者間做決定，就像 076 的關卡為引擎做的一樣。

## 現況

- **076（已結案）。**引擎掌管螢幕、系統音訊與麥克風的擷取、時鐘、節奏、編碼與寫檔。RecordStuff 自己的視窗不出現在任何錄影中（ScreenCaptureKit 的 App 篩選；Windows 上為 `WDA_EXCLUDEFROMCAPTURE`），所以 Settings 預覽從不會被錄進去；現在也不需要任何例外，因為泡泡已不再是視窗。倒數 overlay 是 RecordStuff 在被錄螢幕上顯示的唯一視窗，而它在擷取開始前就已消失。
- **074（已結案）。**權限卡片、拒絕提示、在倒數前拒絕開始、附退回提示的裝置選擇器，以及依送達判斷中斷，都可以沿用。它的後續發現 utility process 中的 AVFoundation 從來看不到裝置離開或回來（沒有主 run loop）；078 步驟 6 把麥克風改用 CoreAudio 的 HAL。
- **078（2026-10-17 結案，[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-078-結案--2026-10-17)）。**步驟 4 建立了畫面留在 GPU 上的 Windows 硬體 H.264，這是 Windows 合成器需要的（僅 CI，未測試任何 GPU）。步驟 6 把麥克風改用 CoreAudio 的 HAL，並發現離開的裝置不會讓它的錄音單元停止：HAL 會把單元移到另一個輸入，所以單靠送達無法判斷中斷，必須檢查裝置本身（[錄影](../docs/zh-TW/system-design/recording.md#音訊)）。相機方面，它的探測程式（`native/capture/src/mac/live_test.rs` 的 `probe_cameras_coming_and_going`，在沒有 run loop 的情況下每秒讀一次 CoreMediaIO 與 AVFoundation 的清單）看到兩邊都列出 iPhone 的接續互通相機，CoreMediaIO 還多列了它的桌上視角相機；但在 180 秒內、相機從 iPhone 斷開又重新選取的過程中，清單沒有任何變化：可能是從 iPhone 斷開不會把它移出清單，也可能是沒有 run loop 時清單不會更新。這會在本計畫步驟 2 用真正會離開的相機（拔掉 USB 相機）釐清，再設計 D12 的重新連線。
- 程式中沒有從鏡頭擷取影像的程式碼。`electron-builder.yml` 沒有 `NSCameraUsageDescription`；`resources/entitlements.mac.plist` 沒有 `com.apple.security.device.camera`。
- Settings → Recording → Screen 不經擷取就畫出螢幕的排列（`src/renderer/settings/tabs/display-arrangement.tsx`），預覽將擴充它。

## 競品怎麼處理

於 2026-10-14 與 2026-10-17 讀取：Cap 版本 `3d19c5c` 與 `d7d36a3`（其 AGPL 程式碼只參考設計）、OBS Studio、各廠商說明頁；這些描述的是所檢視的範圍，不是實測行為。

| 產品 | 鏡頭在哪裡合成 | 預覽 | 錄影中更改 |
| --- | --- | --- | --- |
| OBS Studio | 即時，在它的 GPU 畫布中 | 合成後的畫布，以原生方式繪製 | 可以，任何來源 |
| Cap Studio、Screen Studio | 事後，在編輯器中（獨立鏡頭軌） | 浮動鏡頭視窗，排除在螢幕軌之外 | 在編輯器中，事後 |
| Cap Instant、Loom | 不合成：鏡頭視窗在螢幕上並被錄進去 | 視窗本身 | Cap：任何東西；Loom：拖曳 |
| Apple 簡報者疊加 | 由系統即時合成 | 分享中的螢幕 | 拖曳（小泡泡模式） |

2026-10-14 關於形狀、大小與鏡像的表格（Cap 預覽 150–600 px、其編輯器的 Corners 0–100 搭配 Squircle 或 Rounded、Loom 的四種形狀與「Flip camera」、Tella 的版面、Screenity 的圓形）仍是下方 D1–D3 與 D8 的依據。

## 步驟

### 1. 決定行為

沿用 2026-10-14 的決定（維護者當時採用了所有建議），因為它們仍然適用：

- [x] **D1 形狀。**寬、高與圓角是三個獨立的數值；預覽中有邊緣與角落把手，另有欄位；比例按鈕（1:1、4:3、3:4、16:9）；圓角 0–100%，100% 為短邊的一半；預設為 100% 的正方形。
- [x] **D3 大小。**寬與高各自以被錄螢幕短邊的比例表示，5–60%，預設 20% × 20%。
- [x] **D6 鏡頭何時開啟。**只在預覽可見時，以及從準備到停止；閒置時絕不開啟。
- [x] **D8 鏡像。**「錄影時鏡像」，預設關閉；預覽顯示的是將來錄下的樣子。
- [x] **D9 裝置。**第一項為「系統預設」的選單，記住 id 與名稱，裝置不存在時退回預設並提示。
- [x] **D10 開關。**「錄影設定」分頁的 Camera 開關，加上托盤 idle 選單的勾選項，和 074 對麥克風的做法相同。
- [x] **D11 開始時無法使用。**在任何倒數之前以 `camera_unavailable` 拒絕開始。
- [x] **D13 錄影中隱藏與顯示。**一個托盤項目；隱藏時鏡頭保持開啟。不做全域快捷鍵。
- [x] **D14 自己的視窗。**RecordStuff 的視窗不出現在任何錄影中（076）；合成的鏡頭不是視窗，所以不再需要例外。

已變更或新增，維護者於 2026-10-17 決定：

- [x] **D2 圓角樣式。**由合成器畫圓弧圓角矩形，預覽用同一個公式；squircle 只列為之後的選項。依據：同一個公式畫在兩個地方，必須完全一致。
- [x] **D4 在哪裡擺放。**在 Settings 預覽中擺放，錄影前與錄影中都可以；捨棄「在螢幕上顯示」，因為螢幕上不再顯示任何東西。
- [x] **D5 預覽顯示什麼。**依維護者要求改變建議：維護者希望錄影前就能確認畫面與聲音都正常，就像 OBS 的預覽。因此提供一個**即時預覽**按鈕，按下後啟動一個預覽 session，跑的就是錄影本身的管線（所選螢幕走同一個 filter，RecordStuff 的視窗與隱藏的選單列和 Dock 和錄影一樣排除在外；系統音訊、麥克風與鏡頭，合成後的畫面），只是不寫檔；以預覽大小與幀率顯示在預覽中（D17），並以系統音訊與麥克風的音量表代替播放聲音（避免回授與回音）。視窗關閉、離開分頁或開始錄影時停止；把其他 app 帶到前景時不停止，讓使用者可以一邊操作要錄的 app 一邊看。沒有按下時，預覽以等比例顯示螢幕外框、選單列的帶狀區與即時鏡頭（不擷取螢幕）。錄影中顯示錄影 session 合成後的畫面。依據：預覽就是錄影的管線，才能確認錄影會錄到什麼；按下才開始，避免 Settings 只要開著就擷取（OBS 就是如此）。
- [x] **D7 錄影中。**錄影中可以從預覽更改擺放、大小、圓角與鏡像，從下一格生效，每次變更都隨 session 寫入 log；托盤的隱藏與顯示（D13）保留。
- [x] **D12 錄影中鏡頭中斷。**和麥克風一樣，2 秒沒有畫面即為中斷：錄影繼續但沒有鏡頭，結束時告知通知，存下的紀錄會標記；同一個 session 再次送達時就接回。會離開又回來的鏡頭如何重新連上：和麥克風一樣檢查裝置本身（是否還在、是否仍是 session 使用的裝置），絕不只看送達，並在清單再出現時以同一個 unique ID 重新打開；清單在沒有 run loop 時是否跟得上鏡頭，由步驟 2 先釐清。
- [x] **D15 鏡頭在哪裡合成。**在引擎中、GPU 上、編碼之前，所有平台共用一個 compute shader（2026-10-17 步驟 2 第一次量測後決定）：`native/capture/shaders/compose.wgsl` 是圓角、裁切與鏡像唯一的來源，build.rs 以 naga 把它翻譯成 macOS 的 Metal MSL 與 Windows 的 Direct3D 11 HLSL；各平台把自己的 texture 接給它（macOS 經 `CVMetalTextureCache` 取得 IOSurface 的 plane，Windows 用 078 步驟 4 的 Direct3D 11 影格），再把結果交給自己的編碼器。不用 wgpu：它能共用的只有 shader，而 naga 已經做到；texture 仍要從各平台的擷取接進來、再交給各自的編碼器，而且 wgpu 在 Windows 上沒有 Direct3D 11 後端，每一格都得在 Direct3D 11 與 12 之間以 fence 共用。Cap 用 wgpu，是因為它的編輯器要以多個 pass 畫十幾種圖層（背景、模糊、游標、字幕、轉場）；這裡也出現那樣規模的場景（編輯器或多 pass 的特效）時，才是改用 wgpu 的時機，而 shader 已經是 WGSL。shader 以手動取樣代替 sampler，因為 naga 的 HLSL 會把 sampler 寫成 Direct3D 12 的 sampler heap。
- [x] **D16 引擎如何擷取鏡頭。**macOS 上在引擎中用 AVFoundation 的 `AVCaptureVideoDataOutput`，Windows 上用 Media Foundation 的 source reader；預設 720p、30 fps，鏡頭本身的幀率較低時用它的幀率。
- [x] **D17 預覽如何送到 Settings。**比較其他產品的做法後改變建議。OBS 把合成好的 GPU texture 直接畫進原生 view（`obs_display`），不複製也不經過編解碼；Cap 錄影時的鏡頭預覽是原生 wgpu 視窗（`apps/desktop/src-tauri/src/camera.rs`），編輯器則把畫面以未壓縮的 NV12 或 RGBA 經本機 WebSocket 送進 web view（`frame_ws.rs`，於 `f2e13fb` 閱讀）。關卡依序量測，第一個符合 D18 的就採用：(1) 在 GPU 上縮成寬約 640 px、15 fps 的 NV12，讀回後經 message port 直接送給 Settings renderer，以 WebGL 繪製（Cap 編輯器的做法；不需要第二個編碼器）；(2) 由硬體編碼器產生的小 H.264 串流，以 WebCodecs 解碼；(3) 由 main 承載的原生 GPU 圖層（OBS 的做法），排在最後，因為引擎的 surface 必須跨進 main（Electron 的 `utilityProcess` 不傳 Mach port，只能用 private 的 `CAContext`/`CALayerHost` 或自建 rendezvous），main 必須載入原生程式碼（076 的 D2 刻意排除），預覽上不能疊 HTML（把手、tooltip、選單），Windows 也要另做一套；估計工作量是第一個選項的四到六倍。維護者選擇符合預算中最有效率的選項，而不是絕對最有效率的選項。第一個選項於 2026-10-17 量測超出 D18（12.7 個百分點，其中 9 點是 renderer 與 Chromium 的 GPU process 上傳 texture），所以現在建置的是第二個選項。
- [x] **D18 預算。**（步驟 2 的第二版原型除了預覽本身多出的部分外都符合，30 fps 為 10.5 點、60 fps 為 8.7 點，預算 8 點，維護者於 2026-10-17 接受。）對照參考 Mac 2026-10-16 的數字：顯示鏡頭時以 30 fps 錄影最多佔一個核心的 20%（沒有鏡頭時 10.4%），60 fps 最多 25%（14.0%）；錄影中開著 Settings 預覽，RecordStuff 各程序合計最多多 8 個百分點；錄影前的即時預覽（D5）與錄影適用同樣的數字，因為它就是不寫檔的錄影；閒置不變（鏡頭關閉）。超出預算時，步驟 2 改用 D17 的下一個選項，或由維護者接受該數字。

### 2. 原型關卡（macOS）

- [x] 在引擎中、以開發用開關啟用：開啟鏡頭（D16），以圓角遮罩合成到每一格（D15），編碼，並把預覽送到測試頁面（D17）。在參考 Mac 上量測：`pnpm measure:cpu`（鏡頭顯示，預覽關閉與開啟，螢幕靜止與變動）、以 `pnpm matrix` 量合成後影格的時序，以及鏡頭到畫面的時間差（對鏡頭閃光，和螢幕對照）。比較 D17 的各選項，直到其中一個符合 D18，或維護者接受這些數字。在步驟 3 之前記錄結果。
- 2026-10-17 已建置，並於同日量測（見下）。開關 `RECORDSTUFF_CAMERA_PROTOTYPE`（`1`，或 `width=…,height=…,rounding=…,x=…,y=…,mirror=…,device=…,preview=0`；`native/capture/src/camera_layout.rs`）會在引擎中開啟鏡頭（`mac/camera.rs`，1280×720、420v，只保留最新一格），在 VideoToolbox 之前合成（`mac/compositor.rs`：起初用 Core Image，第二次量測起改用 Metal 上的共用 shader，D15），開啟時依幀率的每個 slot 編碼（`Core::encode_every_slot`），並每秒產生 15 張寬 640 像素的預覽，由 capture host 經 `MessageChannelMain` 的 port 直接送到開發用頁面（起初是以 WebGL 繪製的 NV12 影格；第二次量測起改為 VideoToolbox 的 1 Mbps H.264 串流，以 WebCodecs 的 `VideoDecoder` 解碼後畫到 canvas）（`src/main/recording/camera-preview.ts`、`src/renderer/camera-preview/`）。Bundle 帶有 `NSCameraUsageDescription` 與 `com.apple.security.device.camera`，開關開啟時 main 在啟動時詢問鏡頭權限。`pnpm measure:cpu -- --camera <value> --skip-settings --skip-playback` 以它量測 A 與 R；`cargo test --lib -- --ignored --nocapture camera_delivers_without_a_run_loop` 確認鏡頭在沒有 run loop 時會送達。錄影前的即時預覽（D5）尚未建置：準備好的 session 在倒數期間就會產生預覽影格，它的成本以 R 為上限。
- **2026-10-17 量測**（參考 M1 Pro，蓋子闔上、以外接 1920×1080 螢幕為主螢幕，`pnpm measure:cpu -- --minutes 1 --camera …`，各跑一次，報告在 `docs/verification/measurements/2026-10-17T16*-camera-cpu-*`，不納入版本控制）。鏡頭是 iPhone 的接續互通相機：內建 FaceTime HD 相機在蓋子闔上時仍能開啟、回報執行中，卻送不出任何畫面（感光元件 4 秒後斷電）；起初看似 run loop 的問題，其實不是（同一份程式碼在 capture process 與純 Node 中都能收到 iPhone 的畫面，不需要 run loop，也不需要處理 main queue）。每段 60 秒的錄影，鏡頭送出約 1,780 格（每秒 29.7 格），沒有丟格；檔案為 30.02 與 60.01 fps，音訊與影像同時開始，泡泡的位置與版面一致（於 30 秒處讀回一格確認）。
  | 錄影 | CPU，App 與 helper 合計 | Capture process | GPU process | 預覽 renderer | 編碼服務 | 預算（D18） |
  | --- | --- | --- | --- | --- | --- | --- |
  | 30 fps，鏡頭，無預覽 | 20.9% | 20.8% | — | — | 2.1% | 20% |
  | 30 fps，鏡頭與預覽頁 | 33.6% / 33.3% | 24.2% | 5.5% | 3.6% | 1.9% | 28% |
  | 60 fps，鏡頭與預覽頁 | 43.2% | 34.0% | 5.6% | 3.4% | 3.1% | 33% |

  對照沒有鏡頭時的 10.4% / 14.0%，以 Core Image 合成並在每個 slot 編碼，30 fps 時約多 10 個百分點；預覽（D17 的第一個選項：讀回 NV12、經 port 傳送、以 WebGL 繪製）約多 12.7 個百分點，其中 renderer 與 Chromium 的 GPU process 佔 9 點。兩者都超出 D18：合成在 30 fps 時約超出 1 點，預覽約超出 5 點。依 D18 的規則，維護者於 2026-10-17 選擇以 Metal 上的共用 shader 取代 Core Image 每格建立的 graph（D15），預覽改用 D17 的第二個選項（以 WebCodecs 解碼的小 H.264 串流，用硬體解碼取代 texture 上傳）；兩者已於同日建置並量測（見下）。尚未量測：以 `pnpm matrix` 量影格時序、鏡頭到畫面的時間差、60 fps 無預覽、蓋子打開時的內建相機，以及真正會離開的鏡頭：手邊沒有可拔插的相機，維護者於 2026-10-17 決定把下方的裝置變更檢查延後到有設備時再做。
- **2026-10-17 第二次量測**，量的是第二版原型（以 Metal 執行共用 shader，D15；預覽為 1 Mbps 的 Constrained Baseline H.264 串流，以 WebCodecs 解碼，D17 的第二個選項），同一台 Mac、同一個鏡頭與 runner，報告在 `docs/verification/measurements/2026-10-17T18*-metal-cpu-*`：
  | 錄影 | CPU，App 與 helper 合計 | Capture process | GPU process | 預覽 renderer | 編碼服務 | 預算（D18） |
  | --- | --- | --- | --- | --- | --- | --- |
  | 30 fps，鏡頭，無預覽 | 14.7% / 13.8% | 14.6% | — | — | 2.6% | 20% |
  | 60 fps，鏡頭，無預覽 | 21.2% | — | — | — | 3.9% | 25% |
  | 30 fps，鏡頭與預覽，硬體解碼 | 24.8% | 15.7% | 5.4% | 3.2% | 2.9% | 28% |
  | 30 fps，鏡頭與預覽，軟體解碼 | 24.3% | 13.6% | 3.7% | 5.4% | 2.5% | 28% |
  | 60 fps，鏡頭與預覽，硬體解碼 | 29.4% | — | — | — | 4.3% | 33% |
  | 60 fps，鏡頭與預覽，軟體解碼 | 29.9% | 19.9% | 4.0% | 5.5% | 4.1% | 33% |

  以 Metal 合成，相對於沒有鏡頭，30 fps 約多 4 個百分點、60 fps 約多 7 點（Core Image 為 10 點），兩種幀率都在 D18 之內。開著預覽的錄影在兩種幀率下都在預算之內，但預覽本身多出的部分在 30 fps 為 10.5 點、60 fps 為 8.7 點，D18 是 8 點：分別超出 2.5 與 0.7 點，幾乎全是 Chromium 的 GPU process 與頁面的 renderer（9 點），不論用哪一種解碼。Chromium 的硬體解碼器會壓住約六格（15 fps 時比 capture process 晚 397 ms，即使設了 `optimizeForLatency`、用的是 Constrained Baseline 串流）；軟體解碼在 capture process 送出後約 2.5 ms 就顯示每一格，CPU 耗用相同，所以頁面改用軟體解碼。檔案為 30.00–30.03 與 59.97–60.03 fps，音訊與影像同時開始；鏡頭每分鐘送出 1,766–1,795 格，沒有丟格；讀回的一格中泡泡與顏色正確；頁面畫出了收到的每一個 chunk（15 秒內 238／238）。依 D18 的規則，預覽多出的 0.7–2.5 點由維護者決定，維護者於 2026-10-17 接受：開著預覽的錄影在兩種幀率下仍在預算之內，而且預覽只在 Settings 顯示它時執行。不改試 D17 的第三個選項（原生圖層）。
- [ ] 裝置變更（來自 078）：在拔掉再插回 USB 相機時執行 `probe_cameras_coming_and_going`，確認 CoreMediaIO 與 AVFoundation 的清單在沒有 run loop 時是否跟得上；接著像麥克風一樣，檢查開著的 session 的裝置是否仍是它正在使用的那個，並記錄 D12 如何重新打開它。

### 3. 版面模型與設定（共用的純函式）

- [ ] `src/shared/camera-layout.ts`（提議中）：保存的設定（寬、高、圓角、鏡像、裝置、以比例表示的各螢幕位置）、預設值、驗證，以及預覽與引擎參數共用的純函式：泡泡在螢幕座標與輸出像素中的矩形、半徑、吸附，以及在螢幕或解析度變更後夾回。
- [ ] 單元測試：圓角 0、50 與 100 的形狀；比例按鈕；在小螢幕、大螢幕與縮放比例下的上下限；每個解析度上限下，預覽與引擎的矩形一致；無效的保存值會退回預設。
- [ ] `src/main/settings/settings.ts`：鏡頭欄位，用既有的 `field` 模式。

### 4. 權限與打包

- [ ] 加入 `NSCameraUsageDescription` 與 `com.apple.security.device.camera`；用 `codesign -d --entitlements` 確認。
- [ ] 開啟鏡頭時呼叫 `systemPreferences.askForMediaAccess("camera")`；被拒絕時在卡片上顯示，附開啟「系統設定 → 隱私權與安全性 → 相機」的動作；Windows 則說明其隱私權設定。和 074 相同。

### 5. 引擎中的鏡頭擷取

- [ ] macOS 與 Windows 依 D16 擷取，以螢幕所用的 host 時鐘標記時間，最多排隊一格（最新的優先）；無法開啟時回報 `camera_unavailable`；中斷與接回依 D12；鏡頭在停止、取消、失敗、睡眠與退出時關閉，讓鏡頭指示燈熄滅。
- [ ] 以假鏡頭做核心測試：每個輸出影格的時間點取到最新的畫面、鏡頭比輸出幀率慢或快、2 秒後中斷與接回、每條結束路徑都會關閉。

### 6. 引擎中的合成

- [ ] macOS：依 D15，在 VideoToolbox 之前，依 main 送來的版面參數合成到每一格；參數變更從下一格生效；隱藏時（D13）不合成任何東西。
- [ ] Windows：在 078 步驟 4 路徑的 Direct3D 11 畫面上做同樣的事；沒有 video processor（WARP）時走 CPU 路徑，由 CI 檢查。
- [ ] 鏡頭顯示時，pacer 以所選幀率編碼；隱藏或關閉時維持目前螢幕靜止時的行為。
- [ ] 協定：從 main 到 host 的版面訊息，和其他訊息一樣加上防護；隨 session 寫入 log。
- [ ] 測試：每個解析度上限下合成的矩形與半徑（在合成畫面上做像素檢查）、鏡像、隱藏與顯示、錄影中的變更落在下一格、鏡頭關閉時影格與目前逐位元相同。

### 7. Settings 中的預覽

- [ ] Settings → Recording 新增 Camera 群組：開關與選單（D9、D10）、權限狀態、預覽、寬、高與圓角搭配比例按鈕、錄影時鏡像；錄影中可以操作（D7），其他錄影設定則維持鎖定。新字串加進 `ZH_TW`。
- [ ] 錄影前：等比例的螢幕加上即時鏡頭（`getUserMedia`，只在可見時，D6），以及即時預覽按鈕（D5），在引擎中啟動預覽 session 並顯示音量表，視窗關閉、離開分頁或開始錄影時停止。錄影中：引擎的預覽（D17），只在可見時；拖曳與控制項會送出版面訊息。
- [ ] 頁面測試：控制項與數值、拖曳與鍵盤擺放會保存、錄影中可編輯、被拒絕的狀態、zh-TW、離開分頁時鏡頭與預覽停止；無障礙名稱與數值文字。

### 8. 量測

- [ ] 開啟鏡頭的錄影冒煙：存下的影格中，鏡頭位於 log 記錄的矩形與半徑，與預覽一致；錄影中的變更落在 log 記錄的位置。
- [ ] 隱藏與顯示；取消倒數後鏡頭指示燈熄滅；開著 Settings 與其預覽時，自己的視窗不在影格中。
- [ ] 依 D18 以 `pnpm measure:cpu` 量 CPU（鏡頭顯示，預覽開啟與關閉）；以 `pnpm matrix` 的子集量影格時序；鏡頭到畫面的時間差。

### 9. 文件

- [ ] [錄影](../docs/zh-TW/system-design/recording.md)：鏡頭擷取、合成器與它在編碼器之前的位置、有鏡頭時的 pacer、版面訊息、失敗處理；[桌面](../docs/zh-TW/system-design/desktop.md)：預覽與權限；[設計決策](../docs/zh-TW/system-design/decisions.md)：在引擎中合成（OBS 的模式），而不是錄下視窗或獨立軌；[工具](../docs/zh-TW/system-design/tooling.md)：量到的成本。英文版同步更新。
- [ ] README、README.zh-TW 與官網說明頁：提到鏡頭功能。
- [ ] 學習文章：撰寫[索引清單](README.zh-TW.md#074076-的學習文章)中，所依據的計畫已隨本計畫全部結案的文章。

## 完成與驗證邊界

完成條件：步驟 1 的決定已記錄，且通過步驟 2 的關卡；鏡頭依決定合成、擺放與更改；錄影與預覽一致；隱藏、顯示與中斷鏡頭依決定運作；RecordStuff 的視窗不出現在錄影中；步驟 8 的結果已記錄且在 D18 之內，或由維護者接受；測試與文件已更新。

檢查依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)。本計畫修改引擎的影格路徑、協定、權限與打包，所以適用錄影那一列（`pnpm check`，加上鏡頭關閉與開啟各一次錄影冒煙回合，以及取消倒數後鏡頭指示燈必須熄滅的案例）、CPU 那一列（`pnpm measure:cpu`）與影格時序那一列（`pnpm matrix` 的子集）；設定群組跑 `pnpm test:scope -- recording-settings`；托盤項目跑 `pnpm acceptance:tray`。鏡頭權限的提示與拒絕需要在 `tccutil reset Camera com.ericts.record` 之後跑原生回合，依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)與[原生驗收 skill](../.agents/skills/native-acceptance/SKILL.md)進行。鏡頭中斷需要可拔除的鏡頭（外接 webcam 或接續互通相機）；若沒有，回報為未測試。Windows 只由 CI 檢查。

撰寫本計畫只需要：連結與錨點、既有與提議中的指令、中英文一致，以及 `git diff --check`；不需要測試、建置或啟動 App。

結案時，把設計寫進系統設計文件，結果連同翻譯寫進驗證紀錄，更新兩份索引，並依專案的完成規則移除計畫檔案。除非使用者要求，否則不 commit、push 或發布。
