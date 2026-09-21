# 019 — 通知權限引導

[English](019-notification-permission.md) | [繁體中文](019-notification-permission.zh-TW.md)

狀態：開關已實作並通過單元檢查；原始成因未重現，原生驗收待進行。優先順序：進行中。建立：2026-09-21。

## 問題與目標

使用者回報下載的 release 既未顯示通知，也沒有提供啟用通知權限的引導。該特定版本與 macOS 成因至今仍未重現。

提供可見的雙語方式讓使用者控制「錄影儲存完成」與「錯誤」通知，並在 macOS 阻擋時明確指出恢復路徑。無論通知狀態為何，錄製都必須維持可用。範圍限於支援的 macOS App；其他平台維持既有行為，不宣稱已驗收。

## 設計決策 — 2026-09-21

Electron 無法讀取通知授權狀態。`systemPreferences.getMediaAccessStatus` 的型別只接受 `microphone | camera | screen`，而隨附的 `Electron Framework` 二進位中不存在 `getNotificationSettingsWithCompletionHandler`。其中確實存在 `requestAuthorizationWithOptions:completionHandler:`，所以 `Notification.show()` 本來就會向 macOS 請求授權 — 通知缺的從來不是授權請求，而是恢復路徑。

因此 App 不映射作業系統權限，而是沿用 Cap 的設計提供單一 `notifications` 布林值，並在設定說明中標示恢復路徑，而非顯示一個無法佐證的狀態列。通往 `UserNotifications` 的 Node-API 橋接曾先被實作後撤回；原因見[驗證記錄](../docs/zh-TW/verification/README.md#通知開關取代原生橋接--2026-09-21)，程式碼保存在 `wip/019-native-notification-bridge`。

## 預期體驗

- 「設定 → 一般」顯示「通知」開／關，預設開啟；macOS 另有「開啟通知設定…」。說明文字交代通知用途，並指出 macOS 另外還要在「系統設定 → 通知」中允許 RecordStuff。
- macOS 的「開啟通知設定…」按鈕放在開關自己的卡片內，讓改開關與確認系統權限讀起來是同一個決定。
- macOS 只在狀態為 `notDetermined` 時提供授權提示，每個 bundle ID 一次，重新安裝也不會重置。App 把這唯一一次機會花在啟動時的首次執行提示上 — 那時 macOS 已經在索取螢幕錄製權限 — 而不是使用者第一次錄影結束的瞬間。開關維持預設開啟。
- 把開關關掉再打開會送出一則確認通知，那是使用者可重複執行的送達測試。
- 關閉開關會在詢問 Electron 之前丟棄 App 要送出的每一則通知，每次丟棄寫一行 log。說明文字此時改為交代代價 — 錄影中斷或存檔失敗不會自己出聲 — 並指向儲存位置，部分檔案本來就在那裡。App 不保存任何自有的錯誤狀態：使用者的選擇是照辦，不是補償。
- 錄製進行中這個開關與其他偏好一樣鎖定；任何通知狀態都不會阻擋存檔或改變錄製狀態。

## 執行順序

### 1. 確立實際授權行為

- [ ] 記錄受影響的版本、macOS 版本、安裝路徑、bundle ID、簽章身分、通知偏好與可得的送達 log。區分使用者證據與獨立重現的結果。
- [x] 檢查 repo 解析到的 Electron 版本與其 macOS 通知實作。以 Electron 44.3.0 的二進位符號檢查完成，非於已簽章打包版本上實際觀察。
- [x] 判斷是否需要原生橋接。結論為不需要：缺少的能力是狀態讀取，屬加分項，而橋接載入失敗壓制掉的比它帶來的更多。

### 2. 實作開關

- [x] 於[設定](../src/main/settings.ts)新增相容的 `notifications` 布林值，預設開啟，寬鬆讀取，舊檔不記 warning。
- [x] 在任何 OS 呼叫之前以該開關管控 [`AppTray.show`](../src/main/tray.ts)，並為每次丟棄寫 log。
- [x] 新增設定群組、macOS 設定面板操作與啟用確認通知，含英文與繁體中文字串。
- [x] 執行 `pnpm check` 與 `git diff --check`。

### 3. 驗證行為

- [x] 單元測試涵蓋預設值、往返、非布林值；關閉時丟棄的路徑；確認通知；以及設定模型的已提交值、錄製鎖定、說明文字與僅 macOS 的面板操作。
- [ ] 啟動 App 確認開關確實通到真實送達：打開會出現可見的確認橫幅、關閉後錄影儲存通知停止、「開啟通知設定…」能開到 RecordStuff 面板。使用[原生 computer-use 驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 搭配 `pnpm start:app`。重建或結束 App 前先確認沒有使用者正在進行的錄影。
- [ ] 在全新的通知授權狀態下確認打開開關會跳出 macOS 提示。僅重新安裝不等於全新權限狀態，需使用測試帳號或受控環境。
- [ ] 回歸測試螢幕與系統音訊的開始／停止／存檔／播放、儲存橫幅點擊與 Finder 顯示。記錄實際測試與未測試的項目。
- [ ] 以 release 打包路徑產生的已簽章安裝版驗證。記錄版本／commit、簽章事實、作業系統與證據。

## 完成條件與範圍

本計畫不授權任何 commit、push、tag 或發布。不包含 APNs 服務、自動更新機制、螢幕權限重新設計或平台擴充。不得僅為製造測試情境而重設使用者既有的通知偏好。

長期結論已寫入[桌面設計](../docs/zh-TW/system-design/desktop.md#通知開關)與[驗證記錄](../docs/zh-TW/verification/README.md#通知開關取代原生橋接--2026-09-21)。本計畫在上述原生驗收完成前維持開放，之後依[計畫完成流程](README.zh-TW.md)處理。重現原始回報一併追蹤於此，且不受開關實作阻擋。

## 技術參考

- [Apple：請求通知權限](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)：原生授權請求與情境引導。
- [Electron：通知](https://www.electronjs.org/docs/latest/tutorial/notifications)：macOS 簽章要求。
- [Electron：Notification API](https://www.electronjs.org/docs/latest/api/notification)：送出 API 與生命週期事件。
- [Cap：桌面通知](https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/src/notifications.rs)：本設計沿用的單一布林值送出路徑。
