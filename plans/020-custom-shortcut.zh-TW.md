# 020 — 自訂錄影快捷鍵

[English](020-custom-shortcut.md) | [繁體中文](020-custom-shortcut.zh-TW.md)

狀態：尚未開始；設計已提出，程式尚未動工。優先順序：019 之後。建立：2026-09-21。

## 問題與目標

「設定 → 快捷鍵」目前提供四組預設與「關閉」（016，見[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)）。預設值是對一台維護者看不到的鍵盤所做的猜測：使用者自己的 App、啟動器、視窗管理工具或鍵盤配置，可能四組全都已經佔用；而全域快捷鍵的優先權高於最前景的 App，所以被犧牲的是使用者當下正在打字的那個 App。今天唯一的補救手段是「關閉」。

讓使用者可以在設定中錄下自己的組合，並保有預設值既有的保證：選擇能在重新啟動後保留、作業系統拒絕註冊時會明講而不是默默失效，而且任何快捷鍵狀態都不能阻擋開始、停止或存檔。範圍限於支援的 macOS App 與單一的開始／停止切換；其他平台維持既有行為，不宣稱已驗收。

## 設計決策

### 預設保留，Custom 併排新增

預設清單是快速路徑，也是相容性保證 — 曾經提供過的 accelerator 全部留在 [`HOTKEY_PRESETS`](../src/shared/hotkey.ts)，任何人已儲存的選擇都不會消失。自訂是這個群組的增項而非取代；「關閉」仍記住最後一組 accelerator，重新開啟即可還原。預設值不變。

### accelerator 是驗證出來的，不是信任來的

儲存格式由預設值的聯集放寬為字串，驗證器因此變成邊界。`isAccelerator` 只接受：一個以上的 modifier，取自 `CommandOrControl`、`Control`、`Alt`、`Shift`，其中至少一個是 `CommandOrControl` 或 `Control`；後面接剛好一個非 modifier 按鍵，取自明列的集合（A–Z、0–9、F1–F24、Space、四個方向鍵，以及 Electron 文件列出的標點）。只有 modifier、只有按鍵、兩個按鍵、未知名稱、重複 modifier，以及超過 64 字元，一律拒絕。

要求必須含 Command／Control 並不是禮貌問題：純按鍵的全域快捷鍵會把那個鍵從系統上每個 App 手中拿走，包括使用者下一句話要打字的欄位。錄製結果會正規化成單一順序 — `CommandOrControl`、`Control`、`Alt`、`Shift`、按鍵 — 同一個實體組合永遠得到同一個字串，比較也就仍然只是字串比較。⌘ 記成 `CommandOrControl` 而非 `Command`，讓已儲存的自訂值在沒有 Command 鍵的平台上仍有意義。

另有一份很短的硬性保留清單（`CommandOrControl+Shift+3/4/5/6`、`CommandOrControl+Space`、`CommandOrControl+Tab`、`CommandOrControl+Q`）會附理由拒絕。刻意只列這些：其他真正被 macOS 佔用的組合會註冊失敗，而失敗路徑本來就會回報。

目前每一組預設都必須通過驗證器，並以測試守住。設定讀取維持既有的寬鬆做法：無法辨識的值回退到預設並記既有 warning — 舊版本讀到未來版本寫下的值時，得到的也是同一個結果。

### 面板新增一個帶值的控制項

設定面板是投影，只把 id 回傳（[settings-panel.ts](../src/shared/settings-panel.ts)），而錄下的組合是值不是 id。與其開一條通用的自由文字通道，改為讓快捷鍵群組取得 `kind: "shortcut"`：僅限這一個群組，`choose(group, choice)` 可以帶一個候選 accelerator，而 [`settingsAction`](../src/main/settings-model.ts) 只在用同一支共用驗證器重新驗證並正規化之後才組出 action。renderer 依然無法描述 main 沒有提供的工作 — 它只能提出一個字串，由 main 獨立決定接受或拒絕；拒絕沿用既有的 `applied: false` 路徑，另加一行說明是哪一條規則沒過。

### 錄製新快捷鍵時，暫停已註冊的那一組

當擷取欄位處於待錄狀態時，目前註冊的 accelerator 在作業系統層仍然生效：想按它來重新錄它，結果會是開始錄影。因此 `RecordingHotkey` 新增 `suspend()` / `resume()` — 釋放註冊但保留設定，並在擷取完成、取消、視窗失焦、視窗關閉、逾時或 App 結束時還原。擷取只在偏好未鎖定時提供，所以一開始就不存在會被干擾的錄影工作。

### 被拒絕的註冊維持「已儲存但無作用」

維持現行行為：設定已存檔，`apply` 已先釋放前一組 accelerator，說明文字與通知直說這個快捷鍵不會有作用。自訂值讓註冊失敗更常見，這是把話講清楚的理由，不是偷偷讓另一組跟面板顯示不同的組合繼續生效的理由。

### Escape 與作業系統保有自己的按鍵

Escape 用來取消擷取，因此不能被綁定。⌘Tab、⌘Q 與 Spotlight 組合在 renderer 看到之前就被 macOS 吃掉；欄位單純錄不到它們，而真的送達的那些由保留清單給出同樣的答案。按鍵在 `Key*`、`Digit*` 與 `F*` 範圍改由 `event.code` 判讀，讓非 QWERTY 配置錄到的是實際按下的那顆鍵；至於那是否等同 Electron 在該配置下註冊的鍵，屬於原生驗收問題，不是單元測試問題。

## 預期體驗

- 「設定 → 一般 → 快捷鍵」列出預設、關閉，以及「自訂…」。選「自訂…」會啟用擷取欄位，顯示「請按下組合鍵」，並隨著 modifier 被按住即時顯示。
- 第一個非 modifier 按鍵送出組合：欄位以 ⌘⌥⇧R 形式顯示，設定存檔，作業系統註冊隨後進行。按 Escape、點擊別處或關閉視窗即取消，前一組快捷鍵原封不動並重新註冊。
- 沒通過規則的組合不會存檔，並以一行說明原因：快捷鍵需要 ⌘ 或 ⌃、這個按鍵不能使用，或這個組合由 macOS 保留。
- 被作業系統拒絕的組合沿用既有回報：選擇維持選取、說明文字指出被其他 App 佔用，通知也說同一件事。
- Tray 選單與 log 以與預設相同的符號形式顯示自訂組合，包含預設從未用過的按鍵 — Space、F 系列與方向鍵。
- 錄製進行中整個群組與其他錄影偏好一樣鎖定；任何快捷鍵狀態都不會阻擋存檔。

## 執行順序

### 1. 共用驗證與呈現

- [ ] 於 [shared/hotkey.ts](../src/shared/hotkey.ts) 新增 `isAccelerator`、正規化、允許按鍵集合與保留清單；把 `HotkeySettings.accelerator` 放寬為驗證過的字串，`HOTKEY_PRESETS` 維持為提供清單。
- [ ] 擴充 `describeAccelerator`，補上 Space、F1–F24、方向鍵與標點在 macOS 與其他平台的顯示名稱。
- [ ] 測試：每組預設皆通過；只有 modifier、只有按鍵、兩個按鍵、未知按鍵、重複 modifier、超長與保留值皆被拒絕；正規化順序穩定；兩平台的顯示字串。

### 2. 儲存

- [ ] 讓 [settings.ts](../src/main/settings.ts) 改用新驗證器，維持寬鬆讀取與無法辨識值的既有 warning。
- [ ] 測試：自訂值往返、舊預設不受影響、無效值回退預設並記 warning。

### 3. Main 模型與快捷鍵生命週期

- [ ] 於 [settings-panel.ts](../src/shared/settings-panel.ts) 新增 `kind: "shortcut"`，並在 [settings-model.ts](../src/main/settings-model.ts) 加入「自訂…」選項、擷取狀態與拒絕說明；候選值在 `settingsAction` 內驗證。
- [ ] 於 [hotkey.ts](../src/main/hotkey.ts) 新增 `suspend()` / `resume()`，並在 [index.ts](../src/main/index.ts) 接上啟用／解除、視窗失焦、視窗關閉、逾時與結束。
- [ ] 測試：合法候選值產生 `setHotkey`、非法候選值不產生 action、錄製中群組鎖定；suspend 釋放、resume 還原，包含有延後請求待處理時與 dispose 時。

### 4. Renderer 擷取控制項

- [ ] 於 [renderer/settings.ts](../src/renderer/settings.ts) 與 [settings.css](../src/renderer/settings.css) 加入擷取欄位：啟用、即時 modifier 顯示、第一個非 modifier 鍵送出、Escape 與失焦取消、`aria-live` 播報、不用滑鼠也能操作。
- [ ] 測試涵蓋啟用、錄製、取消與鎖定時的停用狀態。

### 5. 訊息

- [ ] 所有新字串加入 [i18n.ts](../src/shared/i18n.ts) 的英文與繁體中文條目，具名參數保持一致。

### 6. 工具與文件

- [ ] 讓 [scripts/lib/acceptance.mts](../scripts/lib/acceptance.mts) 的 `acceleratorToKeystroke` 認得自訂快捷鍵新增的按鍵，或以明確訊息指出它無法輸入哪一組；使用者改過快捷鍵之後 `pnpm acceptance` 仍必須可執行。
- [ ] 更新[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)與[英文版](../docs/system-design/desktop.md#recording-shortcut) — 兩份目前都寫著自由錄製不在範圍內。
- [ ] 執行 `pnpm check` 與 `git diff --check`。

### 7. 驗證行為

- [ ] 在面板錄一組自訂快捷鍵，確認 log 出現 `hotkey: registered …`，然後在其他 App 位於前景時按下它，完成開始 → 停止 → 存檔 → 播放。使用[原生 computer-use 驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 搭配 `pnpm start:app`；重建或結束前先確認沒有使用者正在進行的錄影。
- [ ] 確認擷取啟用期間按下目前已註冊的快捷鍵是錄下它、而不是開始錄影，且取消後會還原。
- [ ] 確認刻意衝突的組合會產生說明文字與通知，且已存檔的選擇能在重新啟動後保留。
- [ ] 在已設定自訂快捷鍵的情況下執行 `pnpm acceptance`。
- [ ] 檢查一種非美式鍵盤配置，或記錄為未測試。
- [ ] 於[驗證紀錄](../docs/zh-TW/verification/README.md)寫下實際測試與未測試的項目。

## 完成條件與範圍

本計畫不授權任何 commit、push、tag 或發布。範圍外：開始／停止以外的快捷鍵、按鍵序列或和弦、依來源或品質區分的快捷鍵、其他 App 快捷鍵的資料庫、更動預設 accelerator，以及任何 Windows 或 Linux 已驗收的宣稱。不得為製造測試情境而重設使用者已儲存的快捷鍵。

完成後把長期結論寫入[桌面設計](../docs/zh-TW/system-design/desktop.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)，再依[計畫完成流程](README.zh-TW.md#完成計畫)處理。

## 技術參考

- [Electron：Accelerator](https://www.electronjs.org/docs/latest/api/accelerator)：驗證器必須待在其中的 modifier 與按鍵代碼詞彙。
- [Electron：globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)：註冊、拒絕與釋放的語意。
- [MDN：KeyboardEvent.code](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code)：擷取欄位所需、與配置無關的實體按鍵識別。
- [Apple：Mac 鍵盤快速鍵](https://support.apple.com/en-us/HT201236)：保留清單背後由系統佔用的組合。
