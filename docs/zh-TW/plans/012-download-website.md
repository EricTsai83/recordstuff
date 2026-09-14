# 012 官網與下載入口

[English](../../../plans/012-download-website.md) | [繁體中文](012-download-website.md)

狀態：後續選項；010 完成且需要獨立產品入口時啟動。更新：2026-09-15。

## 目標與依賴

公開的英文／繁體中文產品頁，介紹 RecordStuff 並引導使用者取得已驗 GitHub Release。依賴 010 完成與真實可下載版本；不依賴 011，本機打包的版本同樣能供官網下載。

## 工作

1. 實作時選定 hosting 與可用網址；GitHub Pages 可作候選，自訂網域為選配。採用前確認 hosting 流程與成本，本計畫不包含購買網域。
2. 建立小型靜態頁，提供產品用途、真實截圖、macOS arm64 下載、安裝步驟、自簽指引、已驗平台限制、原始碼與問題回報入口。英／繁中內容一致，不暗示未驗平台已有下載。
3. GitHub Releases 作為安裝檔來源。第一版主按鈕連到 github.com 的 `/EricTsai83/recordstuff/releases/latest`；若提供直接檔案下載，使用已驗 asset URL，不猜版本檔名，也不寫死會過期的「最新版本」。若顯示版本／checksum，須隨每次發布更新或取自已確認的 release metadata。初版不必引入 API。
4. 依執行授權部署，驗公開頁的桌面／手機版面、鍵盤操作、雙語內容與下載／原始碼／回報連結。循入口下載實際 DMG 並核 checksum，記錄部署網址，更新雙語 README。

## 完成標準

- 公開頁能說明已交付產品，並連到真實已驗 GitHub 下載，沒有 placeholder 連結。
- 雙語內容與安裝限制符合發行版，版面與連結已檢查。
- 記錄 hosting／更新方式、部署網址及下載驗證。

不要求帳號、後端、付款、分析追蹤、安裝檔鏡像或 App 自動更新。參考 T3 Code 的 [下載頁](https://t3.codes/download)，將產品入口與 GitHub 檔案託管分開。
