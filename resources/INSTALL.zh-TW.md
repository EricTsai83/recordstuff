# RecordStuff — macOS 安裝、更新與移除

[English](INSTALL.md) | [繁體中文](INSTALL.zh-TW.md)

RecordStuff.app 已由開發者自己的憑證簽署，尚未經 Apple 公證。
使用者不需要購買 Apple 會員，也不需要安裝任何憑證。
檔名含 arm64 的版本適用 Apple 晶片 Mac。

DMG 裡只有 App 與 Applications（應用程式）捷徑，本頁就是安裝說明，
每個 GitHub release 都會連到這裡。

## 安裝與第一次開啟（全程可用滑鼠）

1. 開啟 DMG，把 RecordStuff 拖到旁邊的 Applications 資料夾。
   若要更新既有版本，請先看下方「手動更新」。
2. 在 Finder 退出 DMG，開啟「應用程式」，連按兩下 RecordStuff。
3. 若 macOS 阻擋開啟，確認來源可信後，手動開啟「系統設定 → 隱私權與安全性」。
   往下捲到「安全性」，找到 RecordStuff，點「強制打開」並確認。
   提示中的「完成」只會關閉提示，不會解除封鎖。
   受組織管理的 Mac 可能不允許此操作，請洽該機器的管理者。
   若系統明確警告惡意軟體或檔案損毀，請停止安裝並回報開發者。
4. RecordStuff 沒有一般主視窗，請在畫面上方選單列尋找它的圖示。
5. 依 App 提示到「隱私權與安全性 → 螢幕與系統錄音」，
   允許 RecordStuff；系統要求時選「結束並重新打開」。
   選單也提供「已經允許了？重新啟動 RecordStuff」。
   若另有系統音訊錄製提示，錄製電腦聲音時也需要允許。
6. 點選單列圖示開始錄製，再點一次停止；也可以在任何 App 中按
   Command-Shift-1（⌘⇧1），App 的「設定」可改用其他組合鍵或關閉快捷鍵。
   影片預設存放在使用者的「影片 → RecordStuff」，可由 App 選單開啟輸出資料夾。

## 手動更新

在「設定 → 一般」選「檢查更新…」可查看新版本並開啟下載頁。「啟動時檢查更新」預設開啟，每 24 小時最多檢查一次，也可關閉。錄製期間會延後檢查與結果顯示。手動檢查失敗時可開啟版本發布頁；啟動檢查失敗只寫入 log。不會自動下載或安裝。安裝新版本的方式：

1. 停止錄影，從 RecordStuff 選單列圖示選「結束」。
2. 從[最新版本](https://github.com/EricTsai83/recordstuff/releases/latest)下載新的 DMG，
   可選擇與 release 的 SHA256SUMS 比對 SHA-256。
3. 開啟 DMG，把 RecordStuff 拖到 Applications；Finder 詢問時選「取代」，
   讓新版位於與舊版相同的路徑。
4. 退出 DMG，從「應用程式」啟動 RecordStuff。
5. 更新後若被阻擋，也需依上方步驟到「隱私權與安全性 → 安全性」點「強制打開」。
   按「完成」不會解除封鎖。

每個版本都使用同一張憑證簽署並安裝在同一路徑，因此語言、輸出資料夾等設定會保留，
macOS 通常也會保留螢幕與系統錄音權限。若再次出現權限提示，允許後依上述方式重新啟動。

## 移除 RecordStuff

沒有另外的解除安裝程式，也沒有背景服務。

1. 停止錄影，從 RecordStuff 選單列圖示選「結束」。
2. 開啟「應用程式」，把 RecordStuff.app 拖到垃圾桶並清空。
   在 Finder 退出 DMG 不等於移除已安裝的 App。

移除 App 後你的資料會保留。只有在確定不再需要時才自行刪除，App 不會刪除任何錄影：

| 資料 | 位置 |
| --- | --- |
| 錄影 | 使用者的「影片 → RecordStuff」，或你自行選擇的輸出資料夾 |
| 設定與快取 | `~/Library/Application Support/recordstuff` |
| Log | `~/Library/Logs/recordstuff` |

在 Finder 選「前往 → 前往檔案夾」貼上路徑即可開啟。系統設定 → 隱私權與安全性 →
螢幕與系統錄音中若還留有 RecordStuff 的項目可自行移除；這是選擇性步驟，移除 App 不需要它。

## 若已授權仍重複要求權限

先確認開啟的是「應用程式」裡的 RecordStuff，結束後重開一次。
若仍無法錄製，請回報開發者並附上 App 選單「顯示 log」的相關紀錄。
舊版 ad-hoc 簽章改成自簽時可能留下舊授權；不必反覆切換開關，
也不要安裝憑證、關閉整台 Mac 的 Gatekeeper，或清除其他 App 的權限。

人工允許開啟 App 與授予錄影權限是兩件事，必須分別完成。

Apple 操作說明：https://support.apple.com/102445

## 語言

RecordStuff 預設英文。右鍵點選單列圖示，選 Settings → General → Language → 繁體中文即可切換，
下次開啟會保留選擇。App 診斷維持英文，macOS 原生權限提示依系統語言。
