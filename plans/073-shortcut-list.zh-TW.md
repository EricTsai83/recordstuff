# 073 — 在一個地方列出所有快捷鍵

[English](073-shortcut-list.md) | [繁體中文](073-shortcut-list.zh-TW.md)

狀態：已規劃，尚未開始。建立：2026-10-13。優先順序：072 之後。硬性相依：無。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與邊界

在 RecordStuff 視窗中提供一個地方，列出使用者能用的所有快捷鍵，並顯示每個快捷鍵目前是否有效。成功的標準是：清單涵蓋下方盤點的每一類快捷鍵、依平台顯示正確的按鍵（macOS 用 ⌘⌥⇧⌃ 符號，Windows 用 `Ctrl+Shift+…`）、反映錄影快捷鍵的目前設定與註冊狀態，而且清單與實際的按鍵處理不會各自漂移。

本計畫只新增「檢視」。錄影快捷鍵仍然只在 General 分頁既有的 Shortcut 卡片中修改；不新增可自訂的快捷鍵，不改任何既有快捷鍵的行為或按鍵，也不新增全域快捷鍵。官網的說明頁不在範圍內，除非維護者另外要求。

## 現況

App 中沒有任何地方列出全部快捷鍵；只有 Shortcut 卡片顯示錄影快捷鍵，選單列選單和 macOS 的 Record／Dock 選單顯示錄影與開啟快捷鍵，復原提示顯示 ⌘Z。官網說明頁（`website/src/components/HelpContent.astro`）與 README 只提到 ⇧⌘1 和 ⌥⌘,。2026-10-13 盤點到的快捷鍵：

| 類別 | 按鍵（macOS／Windows） | 動作 | 定義位置 |
| --- | --- | --- | --- |
| 全域 | 預設 ⇧⌘1／Ctrl+Shift+1，可自訂或關閉 | 開始／停止錄影；也能取消倒數或已持續 1 秒的開始 | `src/shared/hotkey.ts`（`DEFAULT_HOTKEY`）、`src/main/shortcuts/hotkey.ts` |
| 全域 | ⌥⌘,／Ctrl+Shift+,，固定 | 開啟 RecordStuff；與錄影快捷鍵相同時不註冊（conflict） | `settingsShortcut()`、`src/main/shortcuts/settings-hotkey.ts` |
| 視窗 | ⌘W／Ctrl+W、Esc | 關閉視窗（Esc 依序先關閉播放器、對話框、選單等） | `src/renderer/settings/controller/core.ts`、`src/renderer/lib/shortcut-capture.ts`（`isCloseChord`） |
| 視窗 | ⌘Z／Ctrl+Z | 復原「移到垃圾桶」 | `core.ts` |
| 視窗 | ⌘+、⌘-、⌘0（Windows 用 Ctrl） | 放大、縮小、實際大小 | `src/main/settings/settings-window.ts`（`zoomRequest`） |
| 錄影檔 | 搜尋框中按 Esc | 清除搜尋 | `src/renderer/settings/tabs/library.tsx` |
| 播放器 | Space／K、←／→、↑／↓、M、F；進度列上 PageUp／PageDown、Home／End | 播放／暫停、跳 ±5 秒、音量 ±5%、靜音、全螢幕；跳 ±10 秒、跳到開頭／結尾 | `src/renderer/player/player.tsx` |
| 全螢幕視窗 | Esc、⌘W／Ctrl+W、F、雙擊 | 離開全螢幕 | `src/renderer/video/video-app.tsx` |

不列入：系統標準的編輯與選單按鍵（⌘C／⌘V、⌘Q、⌘H、⌘M 等）、清單與對話框中的一般鍵盤導覽（Tab、方向鍵、Enter 確認、Esc 取消），以及快捷鍵編輯器錄製中的按鍵。這些是平台慣例，不是 RecordStuff 的功能；步驟 1 的決定點可以改變這個範圍。

## 步驟

### 1. 決定位置與範圍（決定點）

- [ ] 請維護者決定位置。建議：在 General 分頁「Controls and notifications」區段、Shortcut 卡片下方，新增唯讀的「Keyboard shortcuts」群組，依上表類別分組。替代方案：(b) 從 Shortcut 卡片或側邊欄開啟的對話框，另加 ⌘/ 開啟；(c) 獨立分頁。(b) 的 ⌘/ 是新的視窗快捷鍵，需要通過 `validateAccelerator` 的保留規則檢查，且不能與錄製中的快捷鍵編輯器衝突。
- [ ] 請維護者確認是否要在 macOS 選單加「Keyboard Shortcuts」項目。建議不加：目前沒有 Help 選單，加了就需要原生驗收回合。
- [ ] 請維護者確認上方「不列入」的範圍。

維護者回答前，本計畫暫停在這一步。

### 2. 單一來源的快捷鍵目錄

- [ ] 新增 `src/shared/shortcut-catalog.ts`（提議中，尚未存在）：每一列有 id、類別、英文標籤（作為 i18n key）與 accelerator 或按鍵清單，顯示時用既有的 `acceleratorKeys`／`describeAccelerator`，不另寫平台格式。
- [ ] 讓按鍵處理引用同一份目錄，避免漂移：播放器的按鍵對應、縮放的 `zoomRequest`、`isCloseChord` 與復原改為讀目錄常數，或至少由目錄匯出它們比對的按鍵。行為必須不變；既有的 player、shortcut、layout 單元測試要繼續通過。
- [ ] 單元測試：目錄中每個播放器與視窗按鍵都能觸發對應的處理（以既有的處理函式驗證，不靠 UI），且 macOS 與 Windows 的顯示文字正確。

### 3. 由 main 組出清單

- [ ] 在 `src/main/settings/settings-model.ts` 組出清單群組，因為全域快捷鍵的狀態只有 main 知道：錄影快捷鍵顯示目前的 accelerator，關閉時顯示「Off」，註冊失敗時顯示「Unavailable」；開啟 RecordStuff 在 `failed` 或 `conflict` 時顯示「Unavailable」。原因說明沿用 Shortcut 卡片既有的 diagnostics，不重複。
- [ ] 在 `src/shared/settings-panel.ts` 的群組型別加入唯讀清單所需的欄位（例如新的 `kind`），維持現有群組不變。
- [ ] 錄影快捷鍵那一列提供「Change」，把焦點移到 Shortcut 卡片，而不是在清單中編輯。
- [ ] 新字串加進 `src/shared/i18n.ts` 的 `ZH_TW`。
- [ ] `settings-model.test.ts`：darwin 與 win32、預設、自訂、Off、註冊失敗、開啟快捷鍵 failed 與 conflict。

### 4. Renderer

- [ ] 在 `src/renderer/settings/tabs/preferences.tsx` 呈現清單，用既有的 `Kbd`、群組與區段元件和 design token；不另寫一套樣式。按鍵要讓螢幕閱讀器讀得出來（例如 `aria-label` 用 `describeAccelerator` 的文字，不只讀符號）。
- [ ] 頁面測試（`src/renderer/settings/page-tests/`）：清單呈現、狀態文字、「Change」把焦點移到 Shortcut 卡片、zh-TW 文字。只驗證行為與無障礙，不驗證設計數值。
- [ ] 若步驟 1 選了對話框或新分頁，對應調整 settings-app 與 Esc 的處理順序，並補頁面測試。

### 5. 文件

- [ ] 在 `docs/system-design/desktop.md` 新增一節說明清單、目錄是唯一來源及不列入的範圍，同步 `docs/zh-TW/`。
- [ ] README 與 README.zh-TW 在提到快捷鍵處加一句，指向這個清單。

## 完成條件與驗證界線

完成條件：步驟 1 的決定已記錄；清單在 General 分頁（或維護者選的位置）列出目錄中的每一列，依平台與狀態正確顯示；按鍵處理與目錄共用定義；測試與文件都已更新。

檢查依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)：這是 Settings UI 與共用常數的修改，不是錄影或原生介面的修改。執行 `pnpm test:scope -- general shortcut player`，涵蓋 General 分頁、快捷鍵與播放器的單元與背景 UI 測試（含 `settings-layout.spec.ts`、`settings-matrix.spec.ts` 的 `@general`），加上 `src/shared/i18n.test.ts`；步驟 2 動到 `settings-window.ts` 的縮放，所以再加 `layout` scope。不需要錄影回合或原生驗收，除非步驟 1 決定加 macOS 選單項目或新的視窗快捷鍵，那時要加上 `pnpm acceptance:recipe -- native-ui` 中相關的部分，並先依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)確認。Windows 只由 CI 檢查。

撰寫本計畫時只需：檢查連結與錨點、既有與提議中的指令、中英一致與 `git diff --check`；不跑測試、不建置、不啟動 app。

結案時，把清單的設計寫進 desktop 文件，結果連同翻譯記入驗證紀錄，更新兩份索引，並依專案的完成規則移除計畫檔。未經使用者要求，不 commit、push 或發布。
