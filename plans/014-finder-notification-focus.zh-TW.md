# 014 通知點擊後 Finder 置前

[English](014-finder-notification-focus.md) | [繁體中文](014-finder-notification-focus.zh-TW.md)

狀態：已在本地實作；流程完成與清理已驗證；通知點擊未送達仍未解，待發布。更新：2026-09-20。

## 問題與目標

v0.1.0 使用者實測可在 Finder 選取正確錄影，但 Finder 留在其他視窗後方。既有 tray 測試以 mock 驗證 shell.showItemInFolder 延後呼叫，未驗證原生前景狀態。使用者明確點擊儲存通知後，應定位正確檔案並將該 Finder 視窗置前；單純完成錄影不可搶焦點。

## 剩餘工作

步驟 1–4 與步驟 5 的本機部分已有本地實作與先前原生驗證紀錄（設計：[桌面](../docs/zh-TW/system-design/desktop.md#tray-與通知)；工具：[通知驗收](../docs/zh-TW/system-design/tooling.md#通知驗收)；證據：[驗證紀錄](../docs/zh-TW/verification/README.md#通知點擊後-finder-置前--2026-09-20)）。強化後腳本已完成預設、中斷及完整六組矩陣實測；完整結果為 25 通過、1 次點擊未送達失敗、4 次缺少通知，需先釐清未解點擊問題才能視為驗收完成，收到發布指示後再發布：推送新版本 tag 讓修正後的 bytes 上線（[發布自動化](../docs/zh-TW/system-design/releases.md)），再對安裝的公開版跑 `pnpm acceptance:notification -- --full`，然後移除本計畫。

## 工作及驗收

1. 用已安裝簽章版、另一個 App 在前景重現。記錄 Finder 關閉、在背景、最小化，以及可行時不同 Space／全螢幕 App 的情境；分別記錄通知點擊時序、選取檔案與真正前景 App／視窗。用選單的定位動作對照，盡可能保留使用者桌面狀態。
2. 查核當前 Electron／macOS API，採最小且受支援的解法。不依賴任意重複延遲，不把 log 的要求已送出當成置前成功。不為強制置前而新增輔助使用／自動化權限或拼接 shell 指令；無法避免的 OS 限制需記錄。
3. 為選用的觸發、callback 與失敗行為補回歸測試。只有明確定位操作可啟動 Finder，背景儲存不搶焦點。涵蓋空白／非 ASCII 路徑，錯誤不可打斷錄影或遺失檔案。
4. 用安裝版驗證重現情境，包含英文／繁中通知。檔案選取與前景狀態分開記錄，不能只靠 mock 測試結案。若 OS 限制導致目標無法達成，記錄證據並保留未解結果，不宣稱已修復。
5. 執行 pnpm check 及相關人工驗證，更新桌面設計、驗證紀錄、發行說明與翻譯。修正產物使用新版本，推送其 tag 發布（[發布自動化](../docs/zh-TW/system-design/releases.md)）；不替換已發布產物。

不包含通用視窗管理、焦點輪詢服務、通知重設計或錄影流程變更。
