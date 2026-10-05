# RecordStuff — macOS 與 Windows 安裝、更新與移除

[English](INSTALL.md) | [繁體中文](INSTALL.zh-TW.md)

RecordStuff.app 已由開發者自己的憑證簽署，尚未經 Apple 公證。
使用者不需要購買 Apple 會員，也不需要安裝任何憑證。
檔名含 arm64 的版本適用 Apple 晶片 Mac。

DMG 裡只有 App 與 Applications（應用程式）捷徑，本頁就是安裝說明，
每個 GitHub release 都會連到這裡。「語言」以前的各節說明 macOS；
尚未驗證的 Windows x64 安裝程式見文末的 [Windows](#windows)。

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
   若另有系統音訊錄製提示，錄下電腦聲音時也需要允許。
6. 點選單列圖示開始錄影，再點一次停止；也可以在任何 App 中按
   Shift-Command-1（⇧⌘1），「設定 → 一般」可自訂組合鍵或關閉快捷鍵。
   「設定 → 錄影設定 → 螢幕」可選一個完整螢幕，預設跟隨主螢幕；指定的螢幕必須可用。
   影片預設存放在使用者的「影片 → RecordStuff」，可由 App 選單開啟輸出資料夾。

## 手動更新

在「設定 → 一般」選「檢查更新…」可查看新版本並開啟下載頁。「啟動時檢查更新」預設開啟，每 24 小時最多檢查一次，也可關閉。錄影期間會延後檢查與結果顯示。手動檢查失敗時可開啟版本發布頁；啟動檢查失敗只寫入 log。不會自動下載或安裝。安裝新版本的方式：

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
若仍無法錄影，請回報開發者並附上 App 選單「顯示 log」的相關紀錄。
舊版 ad-hoc 簽章改成自簽時可能留下舊授權；不必反覆切換開關，
也不要安裝憑證、關閉整台 Mac 的 Gatekeeper，或清除其他 App 的權限。

人工允許開啟 App 與授予錄影權限是兩件事，必須分別完成。

Apple 操作說明：https://support.apple.com/102445

## 語言

RecordStuff 預設英文。右鍵點選單列圖示，選 Settings → General → Language → 繁體中文即可切換，
下次開啟會保留選擇。App 診斷維持英文，macOS 原生權限提示依系統語言。

## Windows

自 1.1.1 之後的第一個版本起，GitHub Releases 會發布 Windows x64 安裝程式，
檔名為 `RecordStuff-<version>-x64-unsigned-setup.exe`。不支援 Windows on Arm。

**尚未在 Windows 實機上驗證。** CI 會建置安裝程式，在 GitHub 的 Windows runner 上
靜默安裝與解除安裝，並檢查版本、架構與檔案；但螢幕擷取、系統音訊、通知與系統匣
都尚未在 Windows 實機上驗證，App 的 Windows 文字（例如以「系統匣」取代
「選單列」）也一樣。需要 Windows 10 以上。上方各節是針對 macOS 撰寫並在 macOS 上驗證的。

### 安裝

1. 從[最新版本](https://github.com/EricTsai83/recordstuff/releases/latest)下載安裝程式並執行。
   它只為目前的 Windows 帳號安裝 RecordStuff，不會要求系統管理員權限，
   並建立「開始」功能表捷徑；Windows 通知需要這個捷徑。
2. 安裝程式沒有程式碼簽章，檔名已標明這一點。若 Windows SmartScreen 顯示
   「Windows 已保護您的電腦」，確認來源可信後，點「其他資訊」，再點「仍要執行」。
   受組織管理的電腦可能不允許此操作，請洽該機器的管理者。
3. RecordStuff 沒有一般主視窗，圖示在系統匣中；點一下開始錄影，再點一下停止。
   右鍵點圖示可開啟設定、輸出資料夾、log 與「結束」。影片預設存放在「影片 → RecordStuff」。

### 驗證下載檔

SHA256SUMS 同時列出 DMG 與安裝程式，各占一行。在 PowerShell 執行：

```powershell
Get-FileHash $HOME\Downloads\RecordStuff-<version>-x64-unsigned-setup.exe
```

`Get-FileHash` 會以大寫字母輸出雜湊值；比對時忽略大小寫，與 SHA256SUMS 中安裝程式那一行比對。
release 中的 `release-win32-x64.json` 記錄安裝程式的來源 commit、版本、大小與 SHA-256。
安裝程式另附 GitHub build provenance attestation，可用 GitHub CLI 檢查：

```bash
gh attestation verify RecordStuff-<version>-x64-unsigned-setup.exe --repo EricTsai83/recordstuff
```

### 更新

「設定 → 一般」的「檢查更新…」在 Windows 上同樣可用，它會讀取 GitHub 上的最新版本。
安裝仍需手動完成：

1. 停止錄影，從 RecordStuff 系統匣選單選「結束」。
2. 從[最新版本](https://github.com/EricTsai83/recordstuff/releases/latest)下載新的安裝程式，
   可依上述方式驗證後再執行。

設定與錄影都會保留。

### 解除安裝

1. 停止錄影，從 RecordStuff 系統匣選單選「結束」。
2. 開啟「設定 → 應用程式 → 已安裝的應用程式」，找到 RecordStuff 並選「解除安裝」。

解除安裝不會刪除你的資料，App 也不會刪除任何錄影。App 把資料存放在下列位置；
只有在確定不再需要時才自行刪除：

| 資料 | 位置 |
| --- | --- |
| 錄影 | 使用者資料夾中的 `Videos\RecordStuff`，或你自行選擇的輸出資料夾 |
| 設定與歷史紀錄 | `%APPDATA%\recordstuff` |
| Log | `%APPDATA%\recordstuff\logs` |

在檔案總管的網址列貼上路徑即可開啟。
