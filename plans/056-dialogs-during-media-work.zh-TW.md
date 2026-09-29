# 056 — 媒體工作未完成時的對話框與回饋

[English](056-dialogs-during-media-work.md) | [繁體中文](056-dialogs-during-media-work.zh-TW.md)

狀態：規劃中。建立：2026-09-29。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與邊界

Plan 055 量測到無視窗的 `dialog.showMessageBox` 與 `dialog.showErrorBox` 會卡住 main 的 timer、I/O 與 log 直到關閉（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-055-結案--2026-09-29)），並把延後退出提示改為通知。它的設計文件列出了仍會阻塞的對話框（[對話框與 main 的 event loop](../docs/zh-TW/system-design/desktop.md#對話框與-main-的-event-loop)）。其中兩個仍可能遇到進行中的錄影，而新的提示也有看不到的缺口：

- **未捕捉例外。** [index.ts](../src/main/index.ts) 的 `process.on("uncaughtException")` 會記 log，並在任何時候顯示 `showErrorBox`，每個程序最多一次。錄影期間這個對話框會卡住 chunk 寫入、stall guard 與所有期限，直到使用者關閉。
- **儲存位置警告。** `createOutputFolderOpener` 的警告（[output-folder.ts](../src/main/output-folder.ts)）從 tray 與設定只會在 settled 狀態出現，但「顯示最後一個錄影」與存檔通知的點擊在檔案不見時會改用它（`revealSaved`）。若在之後的錄影期間點擊先前錄影的通知、該檔案已不見且資料夾無法開啟，錄影會被卡住直到回答警告。尚未觀察到。
- **看不到的延後退出。** 當 macOS 拒絕 RecordStuff 的通知、專注模式隱藏它，或擷取螢幕時橫幅被靜音，延後退出只剩 tray 從「正在結束…」恢復與一行 log；App 就只是保持開啟。

不在範圍內：未存歷史提示與資料夾選擇器（055 保留了它們：提示在媒體 settle 後才出現且需要回答，選擇器不會阻塞）、啟動失敗的 `showErrorBox`（出現在任何媒體存在之前）、退出文案，以及 Windows。

## 工作

- [ ] **媒體工作期間的未捕捉例外。** 媒體工作未完成時不顯示模態對話框：照舊記 log，等媒體 settle 後再呈現（或改為可開啟 log 的通知），仍然每個程序最多一次。settled 的 App 維持現在的對話框。設計文件要說明：若故障本身也讓 settle 無法發生，如何讓使用者知道。
- [ ] **媒體工作期間的儲存位置警告。** 開啟資料夾時若在媒體工作未完成期間發現問題，不顯示模態警告；改以不阻塞的方式告知（例如標明資料夾的通知，選擇器留給 settled 狀態的 tray 與設定），並記 log。settled 路徑保留原本的警告與「更改儲存位置」選項。
- [ ] **看不到的延後退出。** 量測通知被拒時 log 與 Electron 會回報什麼（`failed`、`Notification.isSupported()`），並選一個在媒體工作未完成時不需要模態的 fallback，例如在下一次狀態變化或退出前，tray 顯示延後退出的狀態行。由實作者決定；維持 055 的規則：退出路徑上沒有任何東西等待使用者。
- [ ] 在每個邊界加上單元測試（例如媒體工作未完成時，例外 handler 與資料夾 opener 都不呼叫會阻塞的呈現方式），並更新列出仍會阻塞之對話框的中英設計文件。

## 驗證

- [ ] `pnpm check`。
- [ ] 原生案例，先完成[準備就緒交接](../docs/zh-TW/testing.md#測試前確認桌面交接)：在 controlled build 上，於錄影期間引發未捕捉例外（若實作者新增 controlled fault point），從 log 確認 chunk 寫入、stall guard 與停止都持續進行、錄影成功存檔，之後才呈現錯誤。
- [ ] 若延後退出的 fallback 改變了 tray，在 controlled build 以 `cleanup=hold` 用兩種語言檢查。
- [ ] 因為變更涉及錄影期間的呈現，在新的 `pnpm start:app` bundle 上做一次錄影 smoke。
- [ ] 排除：capture matrix 與音訊保真度；擷取與編碼沒有變更。儲存位置的組合若無法在原生環境製造，可只以單元測試涵蓋，並記錄此限制。

## 完成與證據處理

依[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)辦理。以中英兩種語言在有日期的驗證紀錄中記下原生案例，更新兩份索引，然後移除本計畫及其翻譯。沒有另外要求時，不 commit、push 或發布。
