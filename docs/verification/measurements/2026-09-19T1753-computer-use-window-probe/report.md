# Computer Use：Electron 可見視窗對照測試

時間：2026-09-19 17:53–17:56 +08:00。macOS 26.6.2 arm64，Electron 44.3.0（專案已安裝版本）。

## 結論

同一個 Electron 程序，在有可見視窗時可以透過 Computer Use 取得介面；隱藏視窗、只保留原生 Tray 後，工具回傳與 RecordStuff 相同的 `-10005 timeoutReached`；恢復視窗後立即成功。可見視窗存在時，Electron 原生 File 選單亦能讀取及收合。

這直接重現了「視窗可見性影響本環境 Computer Use 存取」的現象，支持 RecordStuff 受阻與無可見視窗有關。尚未取得工具內部堆疊，不能指定底層是哪個 API 等待逾時，也不能推論所有版本或所有選單列 App 都不支援。此測試沒有直接操作測試 Tray 圖示；File 選單是原生應用程式選單，不是 Tray 選單。

## 控制條件與重現方式

- 不修改 RecordStuff，不停止原有 PID 27012；fixture 不呼叫錄影 API。
- 使用同一份 Electron 執行檔、同一個 PID 80040、同一個完整 App 路徑及相同工具呼叫。
- fixture 隔離 userData，呼叫 app.dock.hide()，建立原生 Tray、原生 Menu 及一個可見 BrowserWindow。
- 由 Computer Use 點擊 fixture 的 Hide window for 30 seconds 按鈕，隱藏視窗；fixture 於 30 秒後自動還原，避免測試程式無法收尾。
- 檔案位於 fixture/；以已安裝 Electron 執行 fixture/main.cjs 即可重現。執行前須確保不會混淆其他 Electron 測試程序。fixture 會在其目錄寫入 user-data/ 及 probe.log。

## 結果

| 步驟 | 操作 | 實際結果 |
| --- | --- | --- |
| A：可見視窗 | getApp(完整 Electron.app 路徑) | 成功，約 1.07 秒，讀到標題、說明與兩個按鈕 |
| B1：隱藏視窗 | UI 點擊 Hide，接著 getAXState() | 約 5.62 秒，-10005 timeoutReached |
| B2：仍隱藏 | 同一路徑重新 getApp() | 約 5.07 秒，-10005 timeoutReached |
| C：視窗還原 | 同一路徑重新 getApp() | 成功，約 0.38 秒，再次讀到相同視窗與按鈕 |
| 原生選單 | 點擊 File，getAXState() | 成功，讀到 Close Window、關閉全部；以 Cancel 次要動作收合 |
| 收尾 | UI 點擊 Quit probe | 程式退出，唯讀程序檢查 PID 不存在 |

Escape 未收合測試中的 File 選單；之後使用 AX 明確提供的 Cancel 動作成功收合。沒有把 Escape 嘗試記為成功。

## 證據

- [fixture 主程式](fixture/main.cjs)
- [fixture preload](fixture/preload.cjs)
- [fixture UI](fixture/index.html)
- [狀態時間戳記](probe.log)
- [程序退出檢查](cleanup.txt)

介面結果取自本次 Computer Use 工具 AX 輸出，未保存截圖。報告與 fixture 只作重現證據，不屬於應用程式功能變更。本次没有執行 RecordStuff 錄製驗收，亦未宣稱其通過。
