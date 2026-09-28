# 050 — 錄影時保持喚醒，睡眠時停止並存檔

[English](050-sleep-during-recording.md) | [繁體中文](050-sleep-during-recording.zh-TW.md)

狀態：已於 2026-09-28 實作並完成原生檢查；第一次睡眠測試後，醒來後放出通知的方式由計時器改為確認使用者回來，已於同日複驗（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-050-保持喚醒與睡眠時停止--2026-09-28)）；結案等待維護者確認。建立日期：2026-09-28。目前佇列唯一的一項。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

RecordStuff 錄影時，沒有任何機制讓 Mac 保持喚醒。長時間不操作的錄影（例如錄影片播放或簡報）可能碰到「螢幕關閉」或閒置睡眠的時間。Cap 對同一種情況的訊息（「Screen capture stopped because macOS made the display unavailable. This commonly happens when the lid is closed or the display sleeps.」）顯示擷取會因此結束，而 RecordStuff 會把它記成擷取失敗；這在本專案尚未原生觀察，由本計畫的驗收記錄。使用者在錄影中讓 Mac 睡眠時，035 的 N31 於 2026-09-27 觀察到：`power: suspend` 之後 146 ms 出現 `capture_failed capture source ended (display or audio track stopped)`，保留一段 8.9 秒的 partial，失敗通知在睡眠當下送出，醒來後沒有看到（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-035-引導驗收回合--2026-09-28)）。

維護者決定（2026-09-28，比較 Cap 之後）：錄影期間讓螢幕與系統保持喚醒；若 Mac 仍然睡眠，就停止並存檔，而不是記成失敗；睡眠期間的通知在醒來後才顯示。此處先假設、實作前維護者可改：保持喚醒沒有設定開關，所有錄影都適用。

使用者主動的睡眠無法阻止：macOS 不讓 App 否決 Apple 選單 →「睡眠」、沒有外接螢幕時闔上筆電、電源鍵，以及低電量或過熱造成的睡眠。不在範圍內：醒來後接續同一個檔案（`MediaRecorder` 無法替換軌道，需要分割檔案再合併）；沒有系統睡眠、只是強制讓螢幕睡眠或鎖定螢幕的情況，只記錄結果（錄影仍會失敗，維護者已於 2026-09-28 接受）；保持喚醒的設定；Windows，Electron 有相同的 API，但不宣稱任何結果。

## 與 Cap 的比較

以下是 Cap 在 [`20c224073bece3fbebed8acb631bd2df97cd6f40`](https://github.com/CapSoftware/Cap/tree/20c224073bece3fbebed8acb631bd2df97cd6f40)（2026-09-27）的靜態原始碼檢視，並未執行：

- **沒有保持喚醒。** 整個 repository 沒有 `IOPMAssertion`、`caffeinate`、`SetThreadExecutionState` 或任何保持喚醒的相依套件，所以 Cap 錄影時仍會閒置睡眠與螢幕睡眠。
- **知道睡眠，但不停止錄影。** [`power_observer.rs`](https://github.com/CapSoftware/Cap/blob/20c224073bece3fbebed8acb631bd2df97cd6f40/apps/desktop/src-tauri/src/power_observer.rs) 監聽即將睡眠、已喚醒，以及螢幕的睡眠與喚醒；睡眠時暫停權限、相機與麥克風的監看，醒來 0.5 秒後重新暖機 ScreenCaptureKit 並刷新裝置。它不會停止或儲存錄影。
- **系統停止後重啟。** [`screen_capture/macos.rs`](https://github.com/CapSoftware/Cap/blob/20c224073bece3fbebed8acb631bd2df97cd6f40/crates/recording/src/sources/screen_capture/macos.rs) 收到 ScreenCaptureKit 的「系統停止串流」錯誤時，2 秒後重建擷取，最多 3 次，接回同一段錄影並留下空白；螢幕消失或重試失敗時，以上面引用的訊息結束。預設開啟可從當機救回的錄影，以分段檔案寫入，中斷後片段仍在。

RecordStuff 採用睡眠與喚醒的感知，以及說明原因的訊息，並補上 Cap 沒有的部分：錄影期間保持喚醒。基於上述 `MediaRecorder` 的原因，不採用重啟；RecordStuff 的 partial 本來就能播放（N31 的 8.9 秒 partial 可以完整解碼），所以乾淨地停止是較小的改動。

## 實作契約

- [x] **保持喚醒。** 新增 `src/main/keep-awake.ts`，從 `starting` 開始持有一個 Electron `powerSaveBlocker`（類型 `prevent-display-sleep`），直到狀態回到 `idle` 或 `needsPermission`，因此倒數、錄影與存檔都涵蓋在內；螢幕睡眠同樣會結束擷取，而螢幕的 assertion 也會一併阻止閒置時的系統睡眠。它不會同時持有兩個；每一條回到穩定狀態的路徑（存檔、失敗、取消、啟動失敗）與 `will-quit` 都會釋放；每次開始與停止都記錄 blocker id。blocker 啟動失敗只會記錄，不影響錄影。main 依 Recorder 的狀態事件驅動它，autorecord 也走同一條路徑。
- [x] **睡眠時停止並存檔。** `Recorder.systemWillSleep()` 在 main 的 `powerMonitor` `suspend` handler 中緊接在 tray 的通知保留（只是一個旗標）之後、任何 log 之前執行；`stop()` 會在 `stopping` 狀態傳給訂閱者之前就把停止送到 host。錄影中時，把 session 標為 `stoppedEarly: "sleep"`、記錄並呼叫 `stop()`：擷取程序會在軌道結束前記下這是要求的停止，之後就忽略軌道結束（[`sourceEnded`](../src/renderer/capture-host.ts)），因此檔案會像一般停止一樣完成並發布。倒數中時以 `sleep` 為原因取消（沒有檔案、失敗或通知）；已送出 `record` 時設定 `stopOnStart`，和較晚的切換相同；準備中時比照結束，準備好後取消。stopping、idle 與 needsPermission 時不做任何事。若軌道先結束，維持現在的失敗路徑，並在 log 說明。驗收時 macOS 在 `suspend` 約 5 秒後才進入睡眠，存檔只花 13 ms。若 Mac 睡著時存檔仍在進行，會在醒來後完成，但計時器在睡眠期間照常計時，停止期限可能已經到期。
- [x] **型別、文案與紀錄。** `EarlyStop` 與 `CancelReason` 新增 `sleep`。存檔通知為「已儲存 {file}。Mac 進入睡眠，已停止錄製。」／"Saved {file}. Recording stopped because the Mac went to sleep." `src/shared/session-record.ts` 與 [session-records.mts](../scripts/lib/session-records.mts) 的 session 紀錄 `stoppedEarly` 接受 `sleep`（後者目前只接受 `lowDisk`）；recorder 與 session log 的行寫成「(stopped early: the Mac went to sleep)」，[finalization-timing.mts](../scripts/lib/finalization-timing.mts) 接受兩種提前停止的後綴。
- [x] **醒來後才顯示通知。** 在 `suspend` 與 `resume` 之間，`AppTray` 會保留所有通知而不顯示，並記錄 `notification: held during sleep`；`resume` 之後每秒檢查一次，當 `powerMonitor.getSystemIdleTime()` 在 2 秒內時依序顯示，收到 `unlock-screen` 則立刻顯示。第一次睡眠測試顯示計時器在睡眠期間照常計時（10 秒保險在清醒時間不到 7 秒時、剛醒來就觸發），而 macOS 會定期在螢幕不亮的情況下醒來做維護，所以不能單靠計時器放出通知，沒有使用者輸入的維護喚醒不會顯示任何通知。
- [x] **文件。** 兩種語言：錄影設計（睡眠時 session 的結束方式與保持喚醒）、桌面功能設計（睡眠期間保留通知、存檔通知的睡眠說明與新的 log 行）、設計決策新增一列（錄影期間保持喚醒、睡眠時停止並存檔、不重啟，附 Cap 比較）、函式參考，以及驗收指南的錄影列。

## 驗證與排除

- [x] 單元測試：保持喚醒在 starting、countdown、recording、stopping 之間只啟動一次；在 idle、needsPermission、啟動失敗、取消與 dispose 時釋放；不同時持有兩個；blocker 丟出錯誤時只記錄。`systemWillSleep` 在各狀態的行為：錄影中會存檔，saved 事件與 session 紀錄帶有 `stoppedEarly: "sleep"`；倒數中以 `sleep` 取消且沒有失敗；arming 時設定 `stopOnStart`；準備中在準備好後取消；stopping、idle 與 needsPermission 不動作。擷取程序在要求停止後才結束軌道時，仍維持一般停止。兩種語言的存檔通知。session log 與紀錄接受 `sleep`。finalization 解析器讀得懂兩種後綴。`AppTray` 在睡眠期間保留；沒有輸入的 resume 之後、或只靠計時器經過一小時都不顯示；輸入夠近或解鎖時依序顯示，並在那時套用開關；清醒時不保留；`destroy` 時丟棄。
- [x] `pnpm check`。
- [x] 在新的 `pnpm start:app` bundle 上由 agent 操作：倒數與錄影期間，`pmset -g assertions` 列出 RecordStuff 的 `PreventUserIdleDisplaySleep` assertion；存檔、取消、失敗（唯讀資料夾）與結束之後就消失。沒有做「不操作到螢幕關閉」的測試：Chrome 與另一個 Electron App 都持有螢幕 assertion，無法證明是 RecordStuff 的效果；以個別程序的 assertion 作為證據（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-050-保持喚醒與睡眠時停止--2026-09-28)）。
- [x] 由維護者操作，因為喚醒需要維護者的密碼或 Touch ID：錄影中從 Apple 選單選「睡眠」再喚醒：存下一般的 `.mp4` 且可以播放，沒有新增失敗，log 顯示睡眠停止發生在軌道結束之前，醒來後出現帶睡眠說明的存檔通知。倒數中睡眠：不存任何東西，也不顯示任何通知。只記錄、不作為門檻：錄影中強制讓螢幕睡眠（`pmset displaysleepnow`）與鎖定螢幕。
- [x] 排除：Windows；低電量與過熱造成的睡眠，走相同的 `suspend` 路徑；畫質與音訊矩陣，因為擷取與編碼沒有改變；CPU 預算，因為 blocker 不加計時器，確認使用者回來的檢查每秒一次，只在喚醒到使用者回來之間執行。

## 完成與證據處理

遵守[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。每輪只有一個桌面操作者；還原「螢幕關閉」時間與所有改過的設定，關閉測試 UI，正常結束受測 App 並確認程序已結束。

- [x] 分開記錄檢查與結果、範圍排除，以及必要但尚未驗證的案例；mock 的邊界不是原生證據。執行 `git diff --check`。
- [ ] 把耐久結論寫入兩種語言的設計與驗證文件，更新兩份索引，然後移除本計畫與翻譯。未另行要求前，不 commit、push 或發布。

僅規劃階段的驗證：相對連結與錨點、指令名稱、雙語涵蓋與 `git diff --check`。Cap 參考是固定 revision 的靜態原始碼檢視，不是執行結果，也不保證 Cap 的每種模式或平台。
