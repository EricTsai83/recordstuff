# 057 — 設定 fixture 視窗失去啟用時的結果判定

[English](057-settings-fixture-window-activation.md) | [繁體中文](057-settings-fixture-window-activation.zh-TW.md)

狀態：規劃中。建立：2026-09-30。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與邊界

2026-09-30 的 20 項稽核在同一個 revision 上跑了三次 `pnpm acceptance:regression`。第一次的設定 fixture 在 `result-focus-inside-en-light.png` 之後，由 `webContents.capturePage()` 丟出 `UnknownVizError` 而中止，沒有任何結果；第二次 176 個案例失敗 22 個，全部是焦點線案例，焦點已經到達（`reached: true`），outline 卻是 `none`；第三次沒有其他 App 被帶到前景，176/176 通過。兩次失敗都落在 fixture 後段：它開啟第二個視窗、關閉後呼叫 `window.focus()`（[settings-panel.ts](../scripts/fixtures/settings-panel.ts)）。視窗未啟用時頁面不畫焦點線（`data-window="inactive"`，plan 047），而 macOS 上 `BrowserWindow.focus()` 不會從其他 App 搶回啟用狀態；事後在前景的是驅動這一輪的對話 App。因此，被其他 App 取消啟用的一輪會被回報成產品失敗，截圖失敗則成為沒有結果的 fixture 當機，看起來像回歸，也要多花一次重跑。

不在範圍內：焦點線樣式與頁面的非啟用視窗規則（行為符合設計）、shortcut integration runner，以及其他 runner 的啟用處理。

## 工作

- [ ] **掌握視窗是否啟用。** 在每個依賴視窗啟用的案例（焦點線矩陣，以及任何以啟用視窗為準比較的截圖）之前，記下 `BrowserWindow.isFocused()` 與頁面的 `data-window`，並以 App 相同的方式重新要求啟用（先 `app.focus({ steal: true })` 再 `window.focus()`），然後確認它確實維持。
- [ ] **失去啟用時回報 blocked。** 這類案例無法確認啟用時，記為未執行，並在讀得到時附上前景 App 名稱，整輪以桌面 blocked 的結束碼（2，[desktop-session.mts](../scripts/lib/desktop-session.mts)）結束，而不是 1，與鎖定工作階段相同。在啟用視窗中跑完的案例保留原本的通過或失敗。
- [ ] **截圖失敗時保留結果。** `capturePage()` 丟出例外時，寫出目前已記錄的案例並標明失敗的截圖；當下視窗未啟用或被隱藏時判為 blocked，否則判為失敗。
- [ ] 以單元測試涵蓋判定（啟用 → 照常判定；未啟用 → 未執行並 blocked；截圖錯誤時有啟用與無啟用兩種），並更新設定驗收的中英 tooling 文件。

## 驗證

- [ ] `pnpm check`，完成[準備就緒交接](../docs/zh-TW/testing.md#測試前確認桌面交接)後執行 `pnpm acceptance:settings`：一輪不受干擾時全部案例通過；另一輪在焦點線區段把其他 App 帶到前景時，以 blocked（結束碼 2）結束並列出受影響的案例，而不是失敗。
- [ ] 排除：錄影、原生快捷鍵送達與 App bundle；只變更開發用 runner。

## 完成與證據處理

依[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)辦理。以中英兩種語言在有日期的驗證紀錄中記下兩輪結果，更新兩份索引，然後移除本計畫及其翻譯。沒有另外要求時，不 commit、push 或發布。
