# RecordStuff — macOS 自簽試用版

[English](INSTALL.md) | [繁體中文](INSTALL.zh-TW.md)

這份 DMG 裡的 RecordStuff.app 已由開發者自己的憑證簽署，尚未經 Apple 公證。
使用者不需要購買 Apple 會員，也不需要安裝任何憑證。
檔名含 arm64 的版本適用 Apple 晶片 Mac；x64 版本適用 Intel Mac。

## 安裝與第一次開啟（全程可用滑鼠）

1. 開啟 DMG，把 RecordStuff 拖到 Applications（應用程式）。
   更新既有版本前，請先停止錄影，從 RecordStuff 選單結束程式。
2. 在 Finder 的「應用程式」中連按兩下 RecordStuff。
3. 若 macOS 因無法驗證開發者或未公證而阻擋，在確認檔案來源可信後，
   開啟左上角 Apple 選單 → 系統設定 → 隱私權與安全性，
   找到 RecordStuff 被阻擋的訊息，點「仍要打開」，依系統提示確認。
   受組織管理的 Mac 可能不允許此操作，請洽該機器的管理者。
   若系統明確警告惡意軟體或檔案損毀，請停止安裝並回報開發者。
4. RecordStuff 沒有一般主視窗，請在畫面上方選單列尋找它的圖示。
5. 依 App 提示到「隱私權與安全性 → 螢幕與系統錄音」，
   允許 RecordStuff；系統要求時選「結束並重新打開」。
   選單也提供「已經允許了？重新啟動 RecordStuff」。
   若另有系統音訊錄製提示，錄製電腦聲音時也需要允許。
6. 點選單列圖示開始錄製，再點一次停止；影片預設存放在
   使用者的「影片 → RecordStuff」，可由 App 選單開啟輸出資料夾。
7. 安裝完成後可在 Finder 退出 DMG，日後從「應用程式」啟動。

## 若已授權仍重複要求權限

先確認開啟的是「應用程式」裡的 RecordStuff，結束後重開一次。
若仍無法錄製，請回報開發者並附上 App 選單「顯示 log」的相關紀錄。
舊版 ad-hoc 簽章改成自簽時可能留下舊授權；不必反覆切換開關，
也不要安裝憑證、關閉整台 Mac 的 Gatekeeper，或清除其他 App 的權限。

人工允許開啟 App 與授予錄影權限是兩件事，必須分別完成。
本機打包驗證不代表已完成另一台 Mac 的安裝／錄製驗收。

Apple 操作說明：https://support.apple.com/102445
