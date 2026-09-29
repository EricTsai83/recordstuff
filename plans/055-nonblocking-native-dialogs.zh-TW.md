# 055 — 不會讓 main process 停擺的原生對話框

[English](055-nonblocking-native-dialogs.md) | [繁體中文](055-nonblocking-native-dialogs.zh-TW.md)

狀態：已規劃。建立日期：2026-09-29。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

`dialog.showMessageBox` 開出沒有視窗的訊息框時，main process 會停下自己的工作：計時器不觸發，排隊中的 log 也不寫入，直到使用者關閉它為止。延後退出通知（`createQuitFeedback`，「錄影仍在啟動、存檔或清理中…」）偏偏就在錄影工作尚未完成時出現，結果通知說它在等的工作，反過來在等這個通知。

2026-09-29 的觀察（簽署的開發版 bundle、macOS 26.6.2、M1 Pro）。當時是一輪錄影 smoke，擷取請求因與此無關的環境原因卡住：

- 11:37:04 一個 session 進入 `starting`；它的擷取請求期限（`DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS`，120 秒）應在 11:39:04 觸發。
- 11:38:33 退出被延後（`quit deferred: recording work is still pending`），通知出現。
- 直到 11:41:50 關閉通知前，log 檔都沒有任何新內容；11:38:33 那一行到這時才寫入，期限也在 11:41:50.921 才觸發，晚了 2 分 46 秒。之後 session 正常取消，下一次退出正常結束。

同一輪稍早，一次在 session 啟動中提出的退出，等到那個期限後就正常結束，沒有出現通知，所以停擺只在通知顯示後才發生。

main 裡所有沒有視窗的原生對話框都可能有同樣的問題，不只這個通知（[index.ts](../src/main/index.ts)）：儲存位置警告（`createOutputFolderOpener` 的 `show`）、`openScreenCaptureSettings` 失敗後的權限設定備援說明、延後退出通知、尚未存檔的失敗紀錄退出提示（`createHistoryQuit`）、資料夾選擇（`showOpenDialog`），以及未捕捉例外或啟動失敗時的 `showErrorBox`。其中哪些真的會暫停事件迴圈、暫停多久，還沒有量測；機制（Electron 在巢狀 modal run loop 中不執行 Node 的計時器與 I/O）只是依這一次觀察提出的假設。

影響：存檔期間出現的通知，可能讓收尾、停止期限與失敗紀錄的儲存都卡住，直到使用者回應。錄影期間若跳出對話框，也會讓 chunk 寫入與停滯偵測一起停擺。

不在範圍內：重新設計退出流程或其文案；尚未存檔紀錄的退出同意本身（它必須維持明確的選擇）；Windows，其 `showMessageBox` 行為不同且未經驗證。

## 工作項目

- [ ] **先量測。** 寫一個小 probe（丟棄式 Electron 腳本，不是 App 程式碼）：啟動每秒一次的 `setInterval`，每次寫一行 log，再依序開出 main 用到的各種對話框：沒有視窗的 `showMessageBox`、帶隱藏父視窗的 `showMessageBox`、`showOpenDialog` 與 `showErrorBox`。記錄每種對話框開著時 tick 是否繼續。結果寫進本計畫的紀錄，不存在本機檔案。
- [ ] **依量測結果選擇呈現方式。** 由實作者決定，偏好順序如下：probe 證實不會停下迴圈的形式（例如 sheet 或父視窗，前提是它們真的不會停）；否則把延後退出通知改成系統通知加上 tray 既有的「正在結束…」狀態，因為它只是告知，不需要回答。需要回答的提示（尚未存檔的紀錄、資料夾選擇）保留對話框，但不可在媒體工作尚未完成時顯示；失敗紀錄提示目前已在媒體 settle 之後才出現，修正必須維持這一點。
- [ ] **期限不可依賴對話框。** 不論選哪種呈現方式，對話框顯示期間，擷取請求、停止與失敗紀錄的期限都必須準時觸發。在可測的邊界補上單元測試（例如延後退出路徑在交回控制權前，不再 await 會阻塞的呼叫），並在[桌面設計](../docs/zh-TW/system-design/desktop.md)說明哪些對話框仍會阻塞及其原因。
- [ ] 更新變更後退出回饋的中英文設計說明。

## 驗證

- [ ] `pnpm check`；退出呈現有變更時執行 `pnpm acceptance:quit-dialog`（檢查中英兩種語言的截圖）。
- [ ] 原生案例，須先完成[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)：以 `pnpm acceptance:controlled -- fault cleanup=hold` 讓錄影工作保持待完成（不要用壞掉的擷取），提出退出使延後回饋出現，在有計時器應觸發時（例如 runner 定期的 status 指令或待觸發的期限）放著不回應至少一分鐘，再從 log 確認期限與 log 都準時出現。之後回應或關閉它，確認 App 正常結束。
- [ ] 若變更動到退出或停止路徑，在全新的 `pnpm start:app` bundle 上做一次錄影 smoke。
- [ ] 排除：capture matrix 與音訊保真度；擷取與編碼沒有改變。

## 完成與證據處理

遵循[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。以中英文把 probe 結果與原生案例寫入新的日期紀錄，更新兩個索引，再移除本計畫與其翻譯。未經另外要求，不 commit、push 或發布。
