# 原生 UI 驗收重試：權限排查

時間：2026-09-19 17:42–17:44 +08:00。使用者表示手動操作曾出現允許錄影提示，要求重試。

結論：**blocked**。再次使用完整路徑取得 RecordStuff 原生介面，約 5 秒後仍回傳 `Computer Use server error -10005: timeoutReached`。

## 本次實際觀察

- `cua.getState()` 仍未列出 RecordStuff；唯讀程序檢查確認 PID 27012 正在執行 checkout 的 `dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff`。
- 透過 Computer Use 開啟系統設定 → 隱私權與安全性 → 螢幕與系統錄音：RecordStuff.app 與 Codex Computer Use.app 均為 **on**；RecordStuff 的僅限系統錄音亦為 **on**。
- 系統設定 → 隱私權與安全性 → 輔助使用：Codex Computer Use.app 為 **on**。
- 這次沒有觀察到待處理的允許錄影對話框。工具可正常讀取並操作系統設定的導覽。
- [本次 App 執行期間日誌](app-session.log) 顯示 17:27 權限檢查成功；17:38:10 進入 recording，17:38:25 回到 idle 並儲存 `/Users/eric/Movies/RecordStuff/2026-09-19 17-38-10.mp4`。這是使用者手動操作的紀錄，不計為代理驗收通過，也未檢查影片內容與音訊。

## 判讀

目前無法把 Computer Use 逾時歸因於錄影權限尚未開啟。先前提示的申請者與文字未知，不能推論其一定與這次取用 App 的逾時相同。無一般視窗的選單列 App 存取方式或工具問題仍需排查；沒有證據證明產品完全不支援。

## 驗收與收尾

基本八項案例均仍 blocked（pass 0、fail 0、blocked 8、not run 0）；沒有重建、沒有由代理開始／停止錄影、沒有變更任何權限或偏好。未能操作 RecordStuff 選單，所以未執行後續存檔／播放／語言回歸。RecordStuff 保持執行；系統設定留在輔助使用頁供檢視。

證據為工具 AX 觀察與上述日誌，未保存截圖。報告連結已檢查；未變更應用程式，因此未執行 pnpm check。

## 選單已展開的對照測試

時間：2026-09-19T17:47:59+08:00。使用者回覆已手動展開 RecordStuff 選單後，再以相同完整 App 路徑呼叫 `cua.getApp(...)`，5.16 秒後仍回傳 `Computer Use server error -10005: timeoutReached`。工具沒有取得選單 AX 或截圖，因此無法獨立確認呼叫當下選單是否持續展開。此結果表示使用者預先展開選單未解除本次 getApp 逾時；尚不能證明所有選單列 App 都不受支援，亦不能確定底層逾時原因。未操作錄影或設定。
