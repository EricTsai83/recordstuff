# 075 — 事前設定好的鏡頭泡泡與版面預覽

[English](075-camera-bubble.md) | [繁體中文](075-camera-bubble.zh-TW.md)

狀態：已規劃；步驟 1 已於 2026-10-14 決定，尚未開始實作。建立：2026-10-14。優先順序：074 之後。硬性相依：076，由它的原生引擎在錄下泡泡的同時，把 RecordStuff 的視窗排除在錄影之外（D14）；沿用 074 的媒體權限卡片與失敗處理模式，不另做一套。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與邊界

讓使用者在錄影中以螢幕上的泡泡顯示自己的鏡頭畫面，寬、高、圓角與位置都在**錄影前**自由設定好：RecordStuff 視窗中有一個版面預覽，顯示被錄的螢幕會長什麼樣子。成功的標準是：預覽以真實比例與位置顯示所選螢幕與泡泡，泡泡裡是即時鏡頭畫面；寬、高與圓角各自獨立調整（圓角從直角長方形到圓形或膠囊形），全部會保存；開始錄影時，真正的泡泡出現在被錄螢幕上預覽所放的位置，存下的 MP4 和螢幕上看到的完全一樣，錄影結束前維持同樣的擺放，但使用者錄影中可以從選單列隱藏與顯示它；RecordStuff 自己的視窗不會出現在錄影中；鏡頭關閉時一切不變。

泡泡是一個會被螢幕擷取錄進去的即時視窗（看到什麼就錄到什麼），與 Loom、Apple 的簡報者疊加以及 Cap 的 Instant 模式相同。不在範圍內：錄影中移動、縮放或改變泡泡形狀、獨立的鏡頭軌或檔案與事後編輯（Cap Studio、Screen Studio、Tella、Camtasia）、整個螢幕的即時影像預覽、背景模糊或去背、只錄鏡頭或全螢幕鏡頭模式，以及 Windows 實機（只由 CI 檢查）。

## 版面預覽是好設計嗎？（評估）

是，但做成「所選螢幕的等比例版面＋放在正確位置的即時鏡頭」，而不是整個螢幕的即時影像。

- **這是唯一能事前設定的地方。** 維護者希望所有東西在錄影前決定好。Loom、Cap 與 Screen Studio 讓使用者在真實螢幕上擺放浮動的鏡頭視窗，這行得通是因為它們的錄影面板本來就開著；RecordStuff 是選單列 App，沒有錄影面板，錄影相關的選擇本來就在 Settings 視窗。Screen 卡片已經畫出螢幕的排列（`src/renderer/settings/tabs/display-arrangement.tsx`），預覽是擴充既有控制項，而不是新增一個介面。
- **有這個設計的產品很少，有的那個也付出了代價。** 只有 OBS 在錄影前顯示合成後輸出的預覽：一個可以拖曳、縮放來源的即時畫布。它已知的代價是 OBS 自己的視窗在被擷取的螢幕上時出現的「無限鏡像」；論壇上的解法是把 OBS 移走、讓它的視窗不被擷取，或關掉預覽。Loom、Cap、Screen Studio、Tella 與 Camtasia 只顯示鏡頭本身（浮動視窗或縮圖），把真實螢幕當作預覽；Cap 主視窗只顯示每個螢幕的靜態縮圖。
- **即時的螢幕預覽成本大於它提供的資訊。** 它必須在閒置時擷取螢幕（CPU，而且違反「開啟面板絕不列舉擷取來源、也不要求螢幕權限」的規則，見[桌面](../docs/zh-TW/system-design/desktop.md#螢幕偏好與診斷)），Settings 視窗也會看到自己。使用者需要判斷的是泡泡相對於螢幕的位置、大小與圓角；等比例外框加上即時鏡頭就能回答。是否提供只在使用者要求時才拍的一張靜態螢幕快照，列為決定 D5。
- **它無法顯示的東西。** 預覽是模型，錄影時螢幕上會有哪些視窗不在其中。「在螢幕上顯示」動作會把真正的泡泡放上去做最後確認（決定 D4）。

## 競品怎麼處理

來源皆於 2026-10-14 讀取：Cap 版本 `3d19c5cfa5e636107e78adde6d55be78404d4f23`，只讀程式碼、沒有執行；各廠商說明頁，多數沒有標日期；Screenity 與 OBS 的公開資料。這些描述的是所檢視的範圍，不是實測行為；標「?」的項目無法確認。

| 產品 | 形狀／圓角 | 大小 | 錄影前 | 錄影中 | 鏡像 | 模式 |
| --- | --- | --- | --- | --- | --- | --- |
| Cap 即時預覽 | round、square、full（16:9 或原始比例），循環切換；沒有圓角控制 | 高度 150–600 px，預設 230，角落把手 | 選了鏡頭就開啟視窗；滑鼠移上去可拖曳、縮放、換形狀 | Instant 模式完全不鎖定；滑鼠移上去的工具列可能被錄進去（推測） | 切換，預設關閉 | Instant：視窗被擷取。Studio：排除擷取，另存 `camera.mp4` |
| Cap 編輯器（Studio） | Square 或 Source；Corners 0–100（預設 100），Squircle 或 Rounded | 輸出短邊的 20–80%，預設 30 | — | — | 切換 | 獨立軌 |
| Loom 桌面版 | squircle、圓形、橫向、直向 | 五段式滑桿 | Loom 開啟時就顯示泡泡；可拖曳並吸附 | 工具列隱藏；能否移動／縮放 ? | 「Flip camera」，錄影前設定；預設 ? | 即時疊加 |
| Screen Studio | 「Roundness」（範圍 ?） | 大小設定 | 浮動預覽，不會出現在輸出中 | — | 編輯器設定 | 獨立軌 |
| Tella | 圓形、blob、裁切比例 | S／M／L 或把手 | 螢幕與鏡頭分開預覽；版面只在編輯器 | — | 切換 | 獨立圖層 |
| OBS Studio | 任何來源、可裁切 | 自由 | 即時合成畫布；可拖曳與縮放 | 仍可編輯 | 濾鏡 | 即時合成 |
| Screenity | 只有圓形 | 自由，最小 150 px | 頁面內疊加 | ? | 切換 | 即時疊加 |
| Apple 簡報者疊加 | 小泡泡或大型模式 | 兩種模式 | — | 拖曳（小泡泡） | ? | 即時套用 |

來源：Cap `apps/desktop/src-tauri/src/windows.rs`、`apps/desktop/src/routes/camera.tsx`、`apps/desktop/src/components/CameraPreviewChrome.tsx`、`apps/desktop/src/routes/(window-chrome)/new-main/CameraSelect.tsx`、`TargetCard.tsx`、`apps/desktop/src/routes/in-progress-recording.tsx`、`apps/desktop/src-tauri/src/recording.rs`、`recording_settings.rs`、`lib.rs`、`crates/project/src/configuration.rs`；[Loom for macOS](https://support.atlassian.com/loom/docs/get-started-with-loom-for-macos)、[Loom 翻轉鏡頭](https://support.atlassian.com/loom/docs/flip-your-camera/)、[Loom 泡泡可見性](https://support.atlassian.com/loom/docs/make-your-camera-bubble-visible-in-loom-recordings/)；[Screen Studio 鏡頭](https://screen.studio/guide/camera)、[Screen Studio 鏡頭與麥克風](https://screen.studio/guide/webcam-microphone)；[Tella 選擇錄製內容](https://www.tella.com/help/recording/choose-what-to-record.md)、[Tella 版面](https://www.tella.com/help/editing/use-layouts)；[OBS 來源指南](https://obsproject.com/kb/sources-guide)、[OBS 論壇談鏡像效果](https://obsproject.com/forum/threads/what-on-earth-causes-this-and-how-do-i-fix-it.79949/)（社群回答）；[Screenity `CameraWrap.jsx`](https://github.com/alyssaxuu/screenity/blob/master/src/pages/Content/camera/layout/CameraWrap.jsx)；[Apple 105117](https://support.apple.com/105117)。

## 現況

**076 提供了什麼（2026-10-16 結案）。**錄影只透過原生引擎進行。引擎會把 RecordStuff 自己的視窗排除在每一段錄影之外，包括開始後才開的：macOS 用 ScreenCaptureKit 的 App 篩選（2026-10-16 驗證：錄影中打開的 Settings 不在影格中；App 在選單列的選單也被排除，選單列圖示仍在），Windows 在錄影期間對每個視窗設定 `WDA_EXCLUDEFROMCAPTURE`（只由 CI 驗證）。因此泡泡需要相反的處理：引擎必須在排除 App 其他視窗的同時錄下泡泡（macOS 在篩選中加入例外，Windows 不保護那一個視窗），這仍由 075 實作。引擎也能錄單一視窗、螢幕的一個區域與指定的 App（只有引擎與測試，沒有選擇器），D6 能隱藏選單列與 Dock。下列項目描述 076 之前的狀態：其中關於擷取與保護的事實請當作歷史。

- 程式中沒有以 `getUserMedia` 取得影像。倒數 overlay（`src/main/recording/countdown-overlay.ts`）是既有的模式：在被錄螢幕上的透明、無邊框、永遠置頂、不啟用 App、滑鼠可穿透的 macOS 面板，於準備階段建立、隨該次嘗試銷毀；鎖定的泡泡可以沿用這個模式。
- 螢幕擷取會錄下所有可見視窗；沒有視窗使用內容保護，所以泡泡只要不明確加保護就會被錄進去。
- Settings → Recording → Screen 以 `screen.getAllDisplays()` 畫出螢幕排列，不碰擷取（`display-arrangement.tsx`）。
- RecordStuff 自己的視窗目前會被錄進去：沒有視窗使用內容保護，所以 Settings 視窗只要開在被錄的螢幕上就會出現在影片中，選單列與其中的 RecordStuff 圖示也一樣。在 macOS 上，單靠 `setContentProtection(true)` 無法讓視窗不被 ScreenCaptureKit 擷取（[Electron 的 `setContentProtection` 說明](https://github.com/electron/electron/blob/main/docs/api/browser-window.md)、[維護者說明，2025-09-09](https://github.com/electron/electron/issues/48258#issuecomment-3269893618)）；但 Electron 對 Chromium 打了修補（`feat_filter_out_non-shareable_windows_in_the_current_application_in.patch`），讓同一個 App 內的整螢幕 `getDisplayMedia` 排除該 App 受保護的視窗，前提是擷取開始時視窗已受保護。Windows 上則使用 `WDA_EXCLUDEFROMCAPTURE`。
- `electron-builder.yml` 沒有 `NSCameraUsageDescription`；`resources/entitlements.mac.plist` 沒有 hardened runtime 需要的 `com.apple.security.device.camera`。

## 步驟

### 1. 決定行為（2026-10-14 已決定）

每個決定都列出其他產品的做法與建議的依據。

- [x] **D1 形狀：寬、高與圓角自由調整。** 其他產品：Loom 提供四種固定形狀；Cap 預覽在 round／square／full 間循環；只有 Cap 編輯器（在 Square 或 Source 上的 Corners 0–100）與 Screen Studio（「Roundness」）把圓角做成數值；Tella 與 Camtasia 在編輯器中可把畫框裁成任意比例；Screenity 只有圓形。沒有找到任何產品在錄影前同時讓寬、高與圓角自由調整。建議（依維護者要求）：寬、高與圓角是三個獨立的數值。預覽中有邊緣把手（只調寬或高）與角落把手（兩者一起），另有欄位或滑桿輸入精確數值；比例按鈕（1:1、4:3、3:4、16:9）是快捷，依寬度設定高度；圓角 0–100%，100% 為短邊的一半（正方形時是圓形，其他是膠囊形），0% 為直角；預設為 100% 的正方形。依據：維護者的要求；Cap 編輯器顯示在任意畫框上搭配一個圓角數值，就能涵蓋其他產品列出的所有形狀。
- [x] **D2 圓角樣式。** 其他產品：Cap 編輯器預設 Squircle，也提供 Rounded；Loom 有一個 squircle 形狀。建議：先用一般圓弧（`border-radius`），只有在內建 Electron 的 Chromium 支援 `corner-shape: squircle` 時才加 squircle。依據：squircle 是兩個產品重視的細節，但不應因此需要自製繪製器。
- [x] **D3 大小的單位與範圍。** 其他產品：Cap 預覽高度 150–600 px，預設 230；Cap 編輯器為短邊的 20–80%，預設 30%；Loom 五段；Tella S／M／L 或把手；Screenity 自由調整、最小 150 px。建議：寬與高各自以被錄螢幕短邊的比例表示，5–60%，預設 20% × 20%。依據：用比例可以在換螢幕時維持外觀，和 Cap 編輯器一樣；14 吋 MacBook Pro 的 982 pt 高度乘 20% 約為 196 pt，接近 Cap 預設的 230 px；下限讓臉仍可辨識，上限讓大部分螢幕保持可見，因為泡泡蓋住的是事後無法移開的即時內容。
- [x] **D4 在哪裡設定。** 其他產品：只有 OBS 在 App 內的合成預覽中設定版面；Loom、Cap 與 Screen Studio 用真實螢幕上的浮動鏡頭視窗。建議：Settings → Recording 中的版面預覽就是設定的地方；在預覽中拖曳、縮放泡泡，會吸附到角落與邊緣；「在螢幕上顯示」動作把真正的泡泡放上去做最後確認，60 秒沒有操作就關閉。依據：上方的評估；RecordStuff 沒有一直開著的錄影面板可以承載浮動視窗。
- [x] **D5 預覽顯示多少螢幕內容。** 其他產品：OBS 顯示即時影像，也因此有鏡像問題；Cap 為每個螢幕顯示一張靜態縮圖。建議：以真實比例顯示螢幕外框，macOS 上加上選單列的帶狀區，泡泡內是即時鏡頭；不擷取螢幕。可選：「拍攝快照」按鈕，只在使用者要求時拍一張該螢幕的靜態畫面，和 Cap 的縮圖一樣；需要螢幕權限，絕不自動執行。依據：讓面板不涉及擷取與權限提示。
- [x] **D6 鏡頭何時開啟。** 其他產品：Cap 一選鏡頭就開啟，直到設為無；Loom 在錄影面板開著時顯示；Screen Studio 在選擇鏡頭時顯示。建議：只在預覽可見時（Recording 分頁開著且鏡頭開啟）、「在螢幕上顯示」期間，以及從準備到停止開啟。依據：這些產品都是錄影面板開著時才顯示鏡頭，這裡是同樣的規則；選單列 App 閒置時不能讓鏡頭燈一直亮著。
- [x] **D7 錄影中。** 其他產品：Cap 的 Instant 模式完全不鎖定，滑鼠移上去的控制項可能被錄進去（推測）；Loom 錄影時隱藏控制項；OBS 仍可編輯。建議：位置、大小、形狀與鏡像都鎖定；泡泡不畫任何控制項、讓滑鼠穿透，絕不攔下原本要點到下方 App 的點擊；顯示與隱藏仍可操作（D13）。依據：維護者的要求，而且泡泡上畫的任何東西都會被錄進去。
- [x] **D8 鏡像。** 其他產品：Zoom、Teams 與 Google Meet 只鏡像使用者自己的預覽，送出與錄下的畫面不鏡像（Teams 的自我預覽預設鏡像）；OBS 不會翻轉鏡頭，除非使用者自己加變換；Loom 的「Flip camera」會改變錄影本身，Loom 建議保持關閉，讓文字正確可讀；Cap 預覽預設不鏡像。教學創作者多半讓臉部鏡頭保持不鏡像，有些人在鏡頭位於角落時翻轉，讓自己看起來朝向內容（論壇共識，沒有權威來源）。建議：「錄影時鏡像」，預設關閉。Settings 預覽顯示的是將來錄下的樣子，所以跟著這個設定，而不是自己另外鏡像；這和通話 App 不同，它們的預覽只是自我預覽。依據：泡泡照所見錄下，沒有另外的自我預覽，而業界對觀眾看到的畫面預設是不鏡像。
- [x] **D9 裝置。** 其他產品：每個產品都有鏡頭選單；Cap 第一項為「No Camera」，記住上次的裝置，保存的 id 無效時捨棄並警告；Loom 提供內建、外接或無。建議：第一項為「系統預設」的選單，記住 id 與名稱，裝置不存在時退回預設並提示。依據：這是普遍做法，而且 Mac 常有多個鏡頭（內建、接續互通相機、外接）。
- [x] **D10 開關。** 其他產品：Cap 與 Loom 沒有獨立開關，選單中的「No Camera」就是關閉。建議：沿用 074 對麥克風的決定，讓兩種輸入用同樣的方式操作；若 074 選了開關，這裡也用開關。
- [x] **D11 開始時鏡頭無法使用。** 其他產品：Cap 開啟裝置前會檢查權限，沒有權限就拒絕準備。建議：在任何倒數之前以 `camera_unavailable` 拒絕開始，和 074 處理麥克風一樣。依據：預期有鏡頭的錄影默默少了鏡頭，這段就白錄了。
- [x] **D12 錄影中斷線。** 其他產品：Cap 繼續錄影、通知（「Camera disconnected — Recording continues without camera…」），裝置回來時重新連線。建議：繼續錄影、隱藏泡泡、通知一次；不重新連線。依據：採用 Cap 的行為，但不做重新連線的機制；檔案仍然有效。
- [x] **D13 錄影中顯示與隱藏。** 其他產品：Cap 錄影中的選單可以把鏡頭切到「No webcam」，會暫停錄影；Loom 泡泡上有「Turn camera off」（錄影中能否使用未確認）；Tella 在片段之間切換鏡頭。建議（依維護者要求）：在選單列的錄影中選單加「隱藏鏡頭」／「顯示鏡頭」，隱藏時鏡頭保持開啟，讓它立刻回到原位（鏡頭燈仍亮著，項目說明會寫明）；開始時為顯示。請維護者確認是否也要全域快捷鍵；建議本計畫不做，因為新的全域快捷鍵會帶來註冊、衝突與快捷鍵清單（073）的工作。
- [x] **D14 RecordStuff 自己的視窗在錄影中。** 其他產品：Cap 預設以 ScreenCaptureKit 的視窗篩選排除自己所有的視窗（主視窗、設定、錄影控制等），清單可在設定中修改，控制列只在錄影時加保護；Loom 在 Mac 上不把錄影控制錄進影片，另有「Hide system UI」隱藏選單列、Dock 與小工具；Screen Studio 在 macOS 12.3 以上不錄錄影小工具；OBS 提供「Hide OBS from capture」，預設關閉。沒有確認任何產品會隱藏自己的選單列圖示。建議：Settings 視窗（含播放器與全螢幕影片視窗）不出現在任何錄影中，包括開始錄影後才開啟的。從 076 起，原生引擎以 ScreenCaptureKit 的視窗篩選做到這點，視窗開啟時會更新篩選，Windows 上則用 `WDA_EXCLUDEFROMCAPTURE`；初稿的替代做法（Electron 的同 App 篩選加內容保護）已不需要。閒置時其他 App 對 RecordStuff 的螢幕分享與截圖不受影響。鏡頭泡泡永遠不加保護。隱藏選單列與 Dock 是 076 的 D6 開關。依據：除了 OBS，所檢查的產品都預設不錄自己的控制項。

維護者於 2026-10-14 決定：採用以上所有建議，所以 D5 不做快照按鈕，D13 不新增全域快捷鍵。D10 採用 074 建議的開關；若 074 自己的步驟 1 另有決定，075 跟著那個答案。

### 2. 形狀與位置模型（共用的純函式）

- [ ] 新增 `src/shared/camera-bubble.ts`（提議中）：保存的設定（`width`、`height`、`rounding`、`mirror`、`device`、以螢幕比例表示的各螢幕 `position`）、預設值、驗證，以及預覽與真正視窗共用的純函式：由設定與螢幕算出範圍、由圓角算出半徑、吸附，以及在螢幕或解析度變更、螢幕消失後夾回（退回預設的右下角，也避開右上角的倒數數字）。
- [ ] 單元測試：正方形、寬、高三種畫框在圓角 0、50、100 的結果；比例按鈕；寬與高的上下限在小螢幕、大螢幕與 Retina 縮放下的結果；預覽縮小後的範圍與真正視窗的範圍一致；吸附與夾回；無效的保存值會退回預設。

### 3. 權限、打包與設定

- [ ] 加入 `NSCameraUsageDescription` 與 `com.apple.security.device.camera`；用 `codesign -d --entitlements` 在 `pnpm start:app` 的 bundle 上確認。
- [ ] 開啟鏡頭時呼叫 `systemPreferences.askForMediaAccess("camera")`；被拒絕時顯示狀態與開啟「系統設定 → 隱私權與安全性 → 相機」的動作，和 074 處理麥克風的方式相同。
- [ ] `src/main/settings/settings.ts`：鏡頭欄位，用既有的 `field` 模式解析。

### 4. Settings 中的版面預覽

- [ ] Settings → Recording 新增 Camera 群組：依 D9／D10 的開關或選單、權限狀態、版面預覽、寬／高／圓角控制與比例按鈕、錄影時鏡像，錄影中和其他錄影設定一樣鎖定。新字串加進 `ZH_TW`。
- [ ] 預覽以正式元件與 design token 等比例畫出被錄的螢幕（Screen 卡片的選擇），泡泡用步驟 2 的函式計算；可用滑鼠拖曳，以邊緣把手（寬或高）與角落把手（兩者）縮放，也可用鍵盤（方向鍵移動、加修飾鍵調整寬或高），並會吸附。鏡頭串流只在預覽可見時運作（D6），換分頁、關視窗或關閉開關時停止。
- [ ] 有多個螢幕時，預覽跟著 Screen 卡片的選擇；選「主螢幕」時預覽目前的主螢幕。
- [ ] 頁面測試：控制項與數值、拖曳與鍵盤擺放會保存、錄影中鎖定、被拒絕的狀態、zh-TW、離開分頁時鏡頭串流停止（使用假的媒體裝置）。只驗證行為與無障礙；滑桿與泡泡要有無障礙名稱與數值文字（「圓角 60%」、「泡泡在右下角」）。

### 5. 泡泡視窗

- [ ] `src/main/recording/camera-bubble.ts`（提議中）在準備階段依步驟 2 的範圍在被錄螢幕上建立視窗：透明、無邊框、無陰影、滑鼠穿透，以倒數的層級永遠置頂，在所有工作區與全螢幕 App 上可見，macOS 上為不啟用 App 的面板、不可取得焦點、不加內容保護。Recorder 和接收倒數 overlay 一樣以注入的 presenter 接收它。
- [ ] renderer 頁面（`src/renderer/camera/`，提議中）呼叫 `getUserMedia({ video: { deviceId, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })`（Cap 的目標），以 `object-fit: cover`、半徑與鏡像繪製 `<video>`，使用與預覽相同的元件。
- [ ] 「在螢幕上顯示」（D4）開啟同一個視窗，只在這次確認中可移動，並把位置寫回設定。
- [ ] 顯示與隱藏（D13）：選單列的錄影中選單隱藏或顯示視窗，不停止鏡頭串流；狀態隨 session 寫入 log。
- [ ] 自己的視窗（D14）：由 076 的引擎排除 Settings、播放器與全螢幕視窗；泡泡以「必須錄進去」的視窗交給引擎，倒數 overlay 在開始擷取前就已消失。
- [ ] 生命週期：在倒數 overlay 使用的每條結束路徑上隨該次嘗試銷毀；鏡頭串流一起停止，所以在停止、取消、失敗、睡眠與退出時，macOS 的鏡頭指示燈都會熄滅。斷線依 D12 處理。

### 6. 量測

- [ ] 開啟鏡頭的錄影冒煙：存下的影格中，泡泡位於 log 記錄的範圍、具有所選半徑（比照驗收找倒數數字的方式定位），且與預覽的擺放一致。
- [ ] 自己的視窗：一次在被錄螢幕上開著 Settings 視窗錄影、一次在開始後才開啟，分別檢查影格中都沒有它。
- [ ] 顯示與隱藏：一次錄影中隱藏再顯示泡泡，檢查影格，並確認泡泡回到原位。
- [ ] CPU：在預覽開啟時與帶泡泡錄影時執行 `pnpm measure:cpu`，對照 [CPU 預算](../docs/zh-TW/system-design/tooling.md#cpu-預算)。
- [ ] 影格時序：顯示泡泡時跑一個相關的 `pnpm matrix` 案例。

### 7. 文件

- [ ] [桌面](../docs/zh-TW/system-design/desktop.md)：預覽、泡泡視窗、生命週期與權限；[錄影](../docs/zh-TW/system-design/recording.md)：它在開始流程中的位置與失敗處理；[設計決策](../docs/zh-TW/system-design/decisions.md)：事前以模型預覽設定、以即時疊加錄製，而不是獨立軌或即時螢幕預覽。英文版同步更新。
- [ ] README、README.zh-TW 與官網說明頁：提到鏡頭功能。
- [ ] 學習文章：撰寫[索引清單](README.zh-TW.md#074076-的學習文章)中，所依據的計畫已隨本計畫全部結案的文章；依主題劃分，而不是依計畫劃分。

## 完成與驗證邊界

完成條件：步驟 1 的決定已記錄；預覽、泡泡與其設定依決定運作；錄影與預覽的擺放一致，錄影中可以隱藏與顯示，RecordStuff 自己的視窗依決定不出現在錄影中；步驟 6 的結果已記錄；測試與文件已更新。

檢查依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)。本計畫新增視窗與錄影時的行為、權限與打包，所以適用錄影那一列（`pnpm check`，加上鏡頭關閉與開啟各一次錄影冒煙回合，包含取消倒數後鏡頭指示燈必須熄滅的案例）、CPU 那一列（`pnpm measure:cpu`）與影格時序那一列（`pnpm matrix` 的子集）。設定群組跑 `pnpm test:scope -- recording-settings`；「在螢幕上顯示」的拖曳需要把 `pnpm acceptance:window-drag` 擴充到泡泡，並檢查最前方 App 保有焦點；若有選單列項目則跑 `pnpm acceptance:tray`。鏡頭權限的提示與拒絕需要在 `tccutil reset Camera com.ericts.record` 之後跑原生回合，依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)與[原生驗收 skill](../.agents/skills/native-acceptance/SKILL.md)進行。錄影中斷線需要可拔除的鏡頭（外接 webcam 或接續互通相機）；若沒有，回報為未測試。Windows 只由 CI 檢查。

撰寫本計畫只需要：連結與錨點、既有與提議中的指令、中英文一致，以及 `git diff --check`；不需要測試、建置或啟動 App。

結案時，把設計寫進系統設計文件，結果連同翻譯寫進驗證紀錄，更新兩份索引，並依專案的完成規則移除計畫檔案。除非使用者要求，否則不 commit、push 或發布。
