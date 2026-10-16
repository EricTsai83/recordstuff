# 075 — 合成進錄影的鏡頭，在即時預覽中擺放

[English](075-camera-bubble.md) | [繁體中文](075-camera-bubble.zh-TW.md)

狀態：已規劃；2026-10-17 依維護者要求重新設計（鏡頭改由引擎合成，和 OBS 一樣，不再是螢幕上的泡泡視窗）；先做步驟 1 的新決定與步驟 2 的原型關卡，尚未開始實作。建立：2026-10-14。優先順序：在 [078](078-native-capture-follow-ups.zh-TW.md) 之後，它的步驟 4（Windows 畫面留在 GPU 上）與步驟 6（macOS 上來來去去的裝置）是本計畫的基礎。硬性相依：076 的引擎，它掌管畫面、時鐘與編碼器；078；074 的權限卡片與失敗處理模式（[桌面](../docs/zh-TW/system-design/desktop.md)、[錄影](../docs/zh-TW/system-design/recording.md)）。依[計畫索引](README.zh-TW.md)按順序執行。

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
- **078（已規劃）。**步驟 4 建立畫面留在 GPU 上的 Windows 硬體 H.264，這是 Windows 合成器需要的。步驟 6 解決 macOS 上的裝置變更。
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

已變更或新增、待維護者決定（附建議）：

- [ ] **D2 圓角樣式。**原本：CSS `border-radius`，Chromium 支援時用 squircle。現在由引擎畫遮罩。建議：在合成器的 shader 中畫圓弧圓角矩形，預覽用同一個公式；squircle 只列為之後的選項。依據：同一個公式畫在兩個地方，必須完全一致。
- [ ] **D4 在哪裡擺放。**原本：錄影前在預覽中擺放，另有「在螢幕上顯示」。建議：在 Settings 預覽中擺放，錄影前與錄影中都可以；捨棄「在螢幕上顯示」，因為螢幕上不再顯示任何東西。依據：維護者選擇了 OBS 的模式。
- [ ] **D5 預覽顯示什麼。**建議：錄影前，以等比例顯示螢幕外框，加上選單列的帶狀區與即時鏡頭（不擷取螢幕，符合現行面板規則）；錄影中，以預覽大小與幀率顯示引擎合成後的畫面（D17）。替代方案：錄影前也顯示即時螢幕預覽，但這會在閒置時擷取、讓面板需要螢幕權限，而且只要 Settings 開著就耗用 CPU。
- [ ] **D7 錄影中。**原本：鎖定。建議：錄影中可以從預覽更改擺放、大小、圓角與鏡像，從下一格生效，每次變更都隨 session 寫入 log；托盤的隱藏與顯示（D13）保留。依據：維護者的要求；合成消除了鎖定的理由。
- [ ] **D12 錄影中鏡頭中斷。**建議：和麥克風一樣，2 秒沒有畫面即為中斷：錄影繼續但沒有鏡頭，結束時告知通知，存下的紀錄會標記；同一個 session 再次送達時就接回。會離開又回來的鏡頭如何重新連上，依 078 步驟 6 為 macOS 裝置建立的做法。依據：074 的規則與其發現。
- [ ] **D15 鏡頭在哪裡合成（新增）。**建議：在引擎中、GPU 上、編碼之前：macOS 上用 Metal（或 Core Image）；Windows 上在 078 步驟 4 的 GPU 畫面上用 Direct3D 11。替代方案：在 Chromium 頁面中合成再擷取該頁面（每格都要繞經 renderer 來回）；CPU 合成器（每格一次整格複製）。依據：畫面已經在引擎的 GPU 記憶體中；OBS 也在 GPU 上合成。
- [ ] **D16 引擎如何擷取鏡頭（新增）。**建議：macOS 上在引擎中用 AVFoundation 的 `AVCaptureVideoDataOutput`（它會在 utility process 中送達，和麥克風一樣；裝置變更依 D12），Windows 上用 Media Foundation 的 source reader；預設 720p、30 fps，鏡頭本身的幀率較低時用它的幀率。替代方案：在 renderer 中用 `getUserMedia`，再把畫面送給引擎（裝置由 Chromium 處理，代價是每格都要跨程序複製）。依據：畫面應該從鏡頭到編碼器都留在 GPU 記憶體中。
- [ ] **D17 預覽如何送到 Settings（新增）。**關卡建議：引擎用它已有的硬體編碼器編碼一個小預覽（例如寬 640 px、15 fps），透過 message port 直接送給 Settings renderer，由它以 WebCodecs 解碼到 canvas，只在 Settings 顯示預覽時進行。替代方案：Electron 實驗性的 `sharedTexture`（不複製，但需要先把引擎的 surface 傳給 main）；每秒幾張的靜態圖片（JPEG）（最簡單、較粗糙）；由 main 承載的原生 GPU 圖層（和 Cap 與 OBS 的畫法一樣，工作量最大）。依據：先量測不需要新程序間管線的選項，其他保留為退路。
- [ ] **D18 預算（新增）。**建議，對照參考 Mac 2026-10-16 的數字：顯示鏡頭時以 30 fps 錄影最多佔一個核心的 20%（沒有鏡頭時 10.4%），60 fps 最多 25%（14.0%）；錄影中開著 Settings 預覽，RecordStuff 各程序合計最多多 8 個百分點；閒置不變（鏡頭關閉）。超出預算時，步驟 2 改選 D17 的其他選項，或由維護者接受該數字。

### 2. 原型關卡（macOS）

- [ ] 在引擎中、以開發用開關啟用：開啟鏡頭（D16），以圓角遮罩合成到每一格（D15），編碼，並把預覽送到測試頁面（D17）。在參考 Mac 上量測：`pnpm measure:cpu`（鏡頭顯示，預覽關閉與開啟，螢幕靜止與變動）、以 `pnpm matrix` 量合成後影格的時序，以及鏡頭到畫面的時間差（對鏡頭閃光，和螢幕對照）。比較 D17 的各選項，直到其中一個符合 D18，或維護者接受這些數字。在步驟 3 之前記錄結果。

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
- [ ] 錄影前：等比例的螢幕加上即時鏡頭（`getUserMedia`，只在可見時，D6）。錄影中：引擎的預覽（D17），只在可見時；拖曳與控制項會送出版面訊息。
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
