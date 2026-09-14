# 013 macOS 安裝體驗

[English](013-macos-installation-experience.md) | [繁體中文](013-macos-installation-experience.zh-TW.md)

狀態：010 之後、下一份安裝包發布前的後續工作。更新：2026-09-15。本次僅規劃，不替換已發布的 v0.1.0 資產。

## 目標

DMG 清楚呈現 RecordStuff → Applications，不附任何安裝／說明文件。使用者下載前可找到首次開啟、手動更新與解除安裝說明。不依賴發布自動化（011）或官網（012）。

## 工作

1. 從 electron-builder.local.yml 的可見 DMG 內容移除 INSTALL.md 與 INSTALL.zh-TW.md。安裝介面只保留 App、Applications 捷徑及清楚的拖曳安裝背景。調整 Finder 視窗與圖示排列，避免捲動、裁切及多餘圖示造成混淆。Markdown 保留為文件來源，不刪除說明內容。
2. 英文 GitHub Release 說明提供簡短安裝與自簽指引，連到持續維護的英文／繁中說明。包含「仍要打開」、螢幕／系統音訊權限與重新啟動。012 官網完成後沿用這些說明，不讓官網成為此調整的前置條件。
3. 不附任何格式的安裝／說明檔（Markdown、PDF、TXT、HTML 或網頁捷徑）。使用者已明確要求安裝檔不附說明文件；指引放在 GitHub 與官網，不以藏在 DMG 其他位置代替移除。此要求不移除 App 內執行環境所需的授權聲明。
4. 說明現有手動更新：停止錄影、結束 App、下載新版 DMG，於相同 Applications 路徑替換。保留固定簽章身分與使用者設定。目前沒有自動更新，本計畫不新增；011 只自動化產物建置／發布。
5. 說明一般 macOS 移除方式：停止錄影、結束 App，把 Applications 中的 RecordStuff.app 移到垃圾桶。說明設定／快取 ~/Library/Application Support/recordstuff、log ~/Library/Logs/recordstuff，以及錄影（預設 ~/Movies/RecordStuff 或使用者自選資料夾）會保留。個人資料清理另列選用步驟，絕不自動刪除錄影。不新增專用解除安裝器、背景服務或自動 TCC 重置。
6. 變動產物使用未用過的新版本、來源提交／標籤、新 checksum 及既有簽章檢查。實際驗證掛載版面、說明入口、瀏覽器下載／安裝、覆蓋既有安裝後設定保留，以及本機短錄影／播放。用隔離且可丟棄的副本檢查移除流程，不刪使用者錄影／設定。更新 README、工具文件、驗證紀錄及翻譯；與 010 尚未完成的下載路徑證據分開記錄。

## 參考及驗收

2026-09-15 已查看 T3 Code [目前官方打包設定](https://github.com/pingdotgg/t3code/blob/main/scripts/build-desktop-artifact.ts)：DMG contents 只有 App 與 /Applications 連結，搭配主題背景。這是原始設定證據，不代表逐一檢查所有已發布 DMG；實作時若沿用參考應重新確認。

下一版 DMG 不包含安裝／說明文件、拖曳安裝動線清楚且說明仍可取得。更新／移除說明符合實際行為，v0.1.0 既有產物保持不變。不包含自動更新、Apple 認證、其他平台或 Finder 通知置前修正。

通知修正與 [014](014-finder-notification-focus.zh-TW.md) 協調；App 更新可行性另列延後的 [015](015-app-update-assessment.zh-TW.md)。退出 DMG 不等於解除安裝。測試暫存備份需記錄用途，驗證及設定還原後清理，不動使用者錄影。
