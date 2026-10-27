# 099 — 選單列、Dock 與桌面分開設定，並裁掉它們佔住的區域

[English](099-system-ui-crop.md) | [繁體中文](099-system-ui-crop.zh-TW.md)

狀態：已規劃，尚未開始。建立：2026-10-28，依維護者要求。硬性相依：無未完成的項目。本計畫更動已結案的 076（D6）加入的開關。依[計畫索引](README.zh-TW.md)的順序執行。本任務只撰寫計畫，下文所述內容都尚未實作、量測或驗證。

## 目標與現況

維護者發現（2026-10-28），開啟「隱藏選單列與 Dock」後，錄影最上方會多出一條空白。選單列雖然沒有錄進畫面，但螢幕上它仍在，macOS 也就仍讓視窗停在它下面：最大化的瀏覽器只到選單列下緣，錄影裡原本是選單列的位置只剩桌布或空白。沒有設定自動隱藏的 Dock，也會在它那一側造成同樣的空白。

現況：

- **一個開關，一個篩選。** `hideSystemUi`（[settings.ts](../src/main/settings/settings.ts)、[protocol.ts](../src/shared/protocol.ts)）一次排除選單列與狀態列項目、Dock、桌面圖示與小工具。[content.rs](../native/capture/src/mac/content.rs)（`system_ui_windows`、`filter`）把這些視窗列為顯示器篩選的例外，並在 macOS 14.2 以上關閉 `includeMenuBar`。
- **一律錄整個顯示器。** 錄顯示器時沒有設定 `sourceRect`（[session.rs](../native/capture/src/mac/session.rs)）。只有開發用的 `area` 來源會設定，取自以顯示器像素表示的矩形（`content::area_rect`）。
- **開關出現在兩處：** 錄影設定（`hideSystemUiGroup`，[recording.ts](../src/main/settings/model/recording.ts)）與 Studio 的螢幕選單（`studioScreenGroups`，[studio.ts](../src/main/settings/model/studio.ts)）。Windows 上顯示為無法使用的「隱藏工作列」。

目標：

1. 一個開關改為三個：**隱藏選單列**、**隱藏 Dock**、**隱藏桌面圖示與小工具**，彼此獨立。
2. 被隱藏的部分若在螢幕上佔住一條區域，錄影就不錄那一條，不再錄到空白。不佔區域的部分（例如設定為自動隱藏的選單列或 Dock）只從畫面中排除，不裁切。

## 設計（提案）

### 怎麼知道哪些區域被佔住：顯示器的工作區域

macOS 以每個螢幕的 `visibleFrame` 公開選單列與 Dock 佔住之外、視窗可以使用的範圍。Electron 以 `Display.workArea` 提供這個值，與 `Display.bounds` 並列，單位是點。RecordStuff 已經用它來擺放倒數與設定視窗（[countdown.ts](../src/shared/countdown.ts)、[settings-window.ts](../src/main/settings/settings-window.ts)）。

兩者的差就是正在錄的顯示器上每一條被佔住的區域：

| 情況 | `bounds` − `workArea` |
| --- | --- |
| 選單列顯示中 | 上方內縮選單列高度（約 24 pt；有瀏海時 37–38 pt） |
| 選單列設定為自動隱藏 | 上方不內縮 |
| Dock 常駐在下方、左側或右側 | 該側內縮 Dock 的大小 |
| Dock 設定為自動隱藏 | 不內縮，或只內縮幾點（於步驟 0 量測） |
| Dock 在另一台顯示器 | 這台不內縮 |

所以不必另外讀取 Dock 是否自動隱藏：工作區域已經依顯示器反映了這件事，也包含 Dock 所在的邊與大小。有瀏海的 MacBook，選單列以下剛好是 16:10（例如 1512 × 982 pt 中的 1512 × 945 pt）。

裁切方式：

- 只有開啟「隱藏選單列」時才裁上方；只有開啟「隱藏 Dock」時才裁 Dock 那一側。關閉的開關不裁，因為那部分會被錄進去。
- 點依顯示器縮放比例換算為像素，往內取整為偶數，符合 H.264 要求。
- 裁切在開始錄影時固定。錄影中 Dock 若移動、改變大小或改變自動隱藏，錄影尺寸維持不變：直到下一次錄影前，可能會露出一條或被裁到一些內容。開關說明會寫明這點。
- Studio 的即時預覽套用同樣的裁切，預覽看到的就是會錄下的。

**如果步驟 0 發現工作區域在某些情況不正確**（例如全螢幕 Space、幕前調度，或沒有選單列的顯示器），備援做法是以 CFPreferences 讀取 `com.apple.dock` 的 `autohide` 與 `orientation`，得知 Dock 是否常駐與位置，再從 `SCShareableContent` 中 Dock 的視窗量出它的大小；選單列高度取自 `NSStatusBar.system.thickness` 或瀏海的 `safeAreaInsets.top`。備援只用在工作區域出錯的情況，不是每次錄影都走的第二條路。

### 引擎：帶來源矩形的顯示器錄影

錄影請求為顯示器錄影加入選用的裁切範圍，以顯示器像素表示。引擎已經會為選取範圍設定 `sourceRect`：裁切後的顯示器沿用這條路（`area_rect`），並照舊使用顯示器篩選與被隱藏的視窗。`source_size` 回傳裁切後的大小，因此畫質的輸出尺寸、鏡頭泡泡位置與預覽都跟著裁切後的畫面。泡泡的版面是相對於輸出畫面（[camera-layout](../src/shared/camera-layout.ts)）；步驟 0 確認沒有地方假設整個顯示器的大小。

### 輸出尺寸：保留裁切後的比例

錄影保留裁切後的比例（例如 2560 × 1440 外接螢幕隱藏選單列時為 2560 × 1415），不縮放也不補邊成 16:9：播放器與網站會依影片本身比例顯示，與 16:9 的差距不到 2%。選取範圍錄影本來就會錄出任意比例。（D3）

### 設定

- 設定版本 4 → 5：`hideSystemUi` 改為 `hideMenuBar`、`hideDock`、`hideDesktop`。版本 4 檔案中 `hideSystemUi` 為開時三者皆開，為關時三者皆關。新欄位讀到非布林值時照舊視為關閉並發出警告。
- 原生請求帶上三個選擇與裁切範圍；`system_ui_windows` 依開關挑選視窗：選單列（`MENU_BAR_LEVEL`、`STATUS_LEVEL`、`includeMenuBar`）、Dock（`com.apple.dock` 擁有的 `DOCK_LEVEL`）、桌面（層級低於 0 的 `DESKTOP_OWNERS`）。
- 錄影設定與 Studio 螢幕選單顯示三個開關，各有說明。選單列的說明寫明它佔住的那一條不會錄進去；Dock 的說明對常駐的 Dock 寫明同樣的事。Windows 保留一個無法使用的「隱藏工作列」。
- i18n：新的標籤與說明提供英文與繁體中文；移除舊的兩則字串。

### 不在本計畫範圍

- 錄影期間更改系統本身的選單列或 Dock 自動隱藏（見下方不採用的做法）。
- Windows：Windows.Graphics.Capture 仍無法排除工作列。
- 視窗與 App 錄影：沒有選單列或 Dock 的區域可裁。

### 不採用的做法

- **錄影時開啟系統的自動隱藏**（透過 System Events 設定 `autohide menu bar`、Dock 的 `autohide`）。已最大化的視窗不會長高；它改的是全域設定，當掉時會留在被改的狀態；需要「自動化」權限；滑鼠移到頂端時選單列又會出現。
- **以 yabai 的 scripting addition 讓選單列透明。** 需要部分關閉系統完整性保護。
- **補邊或縮放成 16:9。** 為了不到 2% 的差距，讓每支錄影多一條色帶或多一次重新取樣（D3）。

## 決策

- **D1 — 三個開關或兩個。** 提案：三個（選單列；Dock；桌面圖示與小工具）。另一個選項是桌面圖示與小工具跟 Dock 合在一起。
- **D2 — Dock 的裁切。** 維護者已於 2026-10-28 決定：常駐的 Dock 和選單列一樣裁掉。
- **D3 — 裁切後的比例。** 提案：保留，如上。另一個選項是補邊到最接近的標準比例。

## 步驟

- [ ] **0. 開始。** 閱讀 076 的結案紀錄與[桌面設計](../docs/system-design/desktop.md)中關於這個開關的部分。在這台 Mac 上記錄下列情況的 `bounds` 與 `workArea`：內建瀏海螢幕、外接螢幕、選單列顯示與自動隱藏、Dock 在下方、左側、右側且常駐與自動隱藏、Dock 在另一台顯示器、全螢幕 Space、開啟幕前調度。依結果決定只用工作區域是否足夠，還是需要備援。確認哪些地方假設整個顯示器的大小（鏡頭版面、預覽、`quality` 的輸出尺寸、會說出尺寸的通知）。依 [AGENTS.md](../AGENTS.md)，在第一輪桌面測試前啟動 `caffeinate -d -i -t 5400`。
- [ ] **1. 以純函式計算裁切。** 由 `bounds`、`workArea`、縮放比例與兩個開關算出像素矩形；偶數尺寸；沒有被佔住的區域時不裁切。測試涵蓋上表每一列與步驟 0 量到的情況。
- [ ] **2. 設定與協定。** 版本 5、從 `hideSystemUi` 遷移、三個欄位、原生請求的選擇與裁切範圍及其驗證。測試：舊開關開與關兩種遷移、格式錯誤的欄位、協定的拒絕情況。
- [ ] **3. 引擎。** `system_ui_windows` 依開關挑選；帶裁切的顯示器錄影設定 `sourceRect` 並回報裁切後的大小。引擎測試涵蓋矩形與大小；實機測試錄一次裁切後的顯示器。
- [ ] **4. 設定與 Studio 介面。** 錄影設定與螢幕選單中的三個開關、兩種語言的說明、Windows 那一列不變。預覽顯示裁切結果。
- [ ] **5. App。** 經「好了」交接後，用新簽署的 bundle：瀏覽器最大化，分別只開每一個開關、以及三個全開，在內建與外接螢幕上、Dock 常駐與自動隱藏時各錄一次。每一次確認：以 ffprobe 量出的錄影尺寸等於工作區域（開關關閉的部分則為整個顯示器）、最上方一列是瀏覽器而不是桌布、Dock 與選單列沒有入鏡、從選單列打開的選單在那一條以下的部分仍有錄到、鏡頭泡泡位置與預覽相同。還原設定、關閉 App，並確認程序已結束。
- [ ] **6. 文件與結案。** [桌面設計](../docs/system-design/desktop.md)（三個開關、裁切與其限制）、若上方不採用的做法要保留為決策則更新[設計決策](../docs/system-design/decisions.md)、驗證紀錄、翻譯、移除本計畫並更新索引。

## 驗證

- 步驟 1–4：進行中執行 `pnpm test:scope -- recording-settings studio settings-bridge` 與引擎的錄影測試；因設定檔、錄影協定與引擎的來源都有更動，步驟 5 前執行 `pnpm check`。
- 步驟 5：經「好了」交接後進行桌面測試，使用[原生驗收 skill](../.agents/skills/native-acceptance/SKILL.md)；`out/` 與 `dist/` 的使用者依序執行；桌面只由一方操作。
- 分開回報：自動化結果、步驟 0 的工作區域量測、實際錄過並檢查的顯示器與 Dock 配置，以及未驗證的部分（例如這台 Mac 無法做出的顯示器配置，或缺少 `includeMenuBar` 的 macOS 14.2 以前版本）。

## 執行與結案約定

依[計畫索引](README.zh-TW.md)處理順序、決策點、桌面交接與結案。D1 與 D3 須在步驟 2 前回覆。除非另有要求，本計畫不包含 commit、push、PR 或發布。
