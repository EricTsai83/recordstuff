# 054 — Plan 053 的原生驗收後續

[English](054-053-native-follow-up.md) | [繁體中文](054-053-native-follow-up.zh-TW.md)

狀態：已規劃。建立日期：2026-09-29。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

Plan 053 於 2026-09-29 結案時，還有三項原生檢查沒有完成（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-053-結案--2026-09-29)）。它的程式碼已合併並有單元測試涵蓋；本計畫只補齊缺少的證據，只有在檢查失敗時才修改程式碼。

- **已安裝 App 的通知點擊。** 點擊通知不可開啟設定。開發版 bundle 執行中時，點擊讓 macOS 啟動了登記在 /Applications 的那一份，它以 `second-instance` 通知開發版；因此 053 在通知點擊後 2 秒內忽略 `second-instance` 與 macOS reopen（`activate`）（[desktop](../docs/zh-TW/system-design/desktop.md#設定快捷鍵)）。登記的那一份自己在執行時點擊會收到什麼，尚未觀察到：該回合因 session 鎖定而停止。Plan 014 記錄到啟用發生在 click 回呼後約 110 ms，支持這個時間窗但不構成證明。
- **真實報告中的 checkpoint。** `pnpm measure:finalization` 因 053 worktree 的開發版 Electron.app 沒有螢幕錄製授權而 blocked，因此還沒有任何報告顯示 `checkpoint`（[tooling](../docs/zh-TW/system-design/tooling.md#收尾量測)）。
- **殘留的權限提示。** 那次 blocked 的執行在畫面上留下 macOS 的「Electron 正在要求略過系統私密視窗選擇器」提示；必須按「不允許」而非「允許」，讓 worktree 的那一份不取得授權。

不在範圍內：新功能；擷取開始通知的錄影，它需要大於最小解析度上限（1080p）的螢幕，以及擷取無法確認的上限，參考機上兩者都沒有；只有接上這類螢幕時才執行。

## 驗證

- [ ] 回合開始前：依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)確認 session 已解鎖；session 鎖定時，回合在啟動任何東西前停止。
- [ ] 對殘留的 Electron 權限提示按「不允許」。
- [ ] 在主 checkout 的 `main` 上以 `pnpm start:app` 建置全新簽署的 bundle 並結束它，再執行 `pnpm acceptance:notification -- --install --clicks 2`。通過條件：runner 判定點擊通過、已安裝的 App 已還原並驗證，且 App log 在任何點擊後都沒有 `reopen: … Settings opened`。出現 `reopen: … ignored … ms after a notification click` 是預期的證據，代表時間窗攔下了啟用。若設定被開啟，記錄事件及其在 `notification: clicked` 之後的延遲，再以另一個變更修正時間窗或 listener。
- [ ] 在開發版 Electron 已有螢幕錄製授權的主 checkout 執行 `pnpm measure:finalization -- --dir <絕對路徑資料夾> --repeat 1`。通過條件：該段錄影儲存並驗證通過，報告中 `checkpoint` 有數值。
- [ ] 選做，只在有大於 1080p 的螢幕時：以 1080p 上限錄一次，確認任何擷取開始通知都在存檔後出現、錄影期間不出現。
- [ ] 排除：capture matrix、長時間錄影與音訊保真度；擷取與編碼沒有改變。

## 完成與證據處理

遵循[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。每一回合只有一個桌面擁有者。還原所有變更的設定、關閉測試 UI、結束受測的 App 並確認程序已結束。

- [ ] 以中英文把結果加入 plan 053 的紀錄或新的日期紀錄，更新兩個索引，再移除本計畫與其翻譯。未經另外要求，不 commit、push 或發布。
