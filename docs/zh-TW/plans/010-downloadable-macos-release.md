# 010 macOS 可下載版本

[English](../../../plans/010-downloadable-macos-release.md) | [繁體中文](010-downloadable-macos-release.md)

狀態：執行中。更新：2026-09-15。

執行偏好：使用者要求 GitHub Release 說明統一英文；DMG 安裝指南及專案文件仍保留雙語。

## 執行進度 — 2026-09-15

已由乾淨來源 2746d1b 發布 [v0.1.0](https://github.com/EricTsai83/recordstuff/releases/tag/v0.1.0)，255 個測試、簽章／內容及已安裝候選版錄影／語言檢查通過。詳見[產物與驗證證據](../verification/releases/0.1.0.md)。通知可定位檔案，但 Finder 未置前，已揭露於發行說明。瀏覽器下載遇到 ERR_BLOCKED_BY_CLIENT，實際瀏覽器下載後的雜湊／安裝／錄影仍待驗證；完成前保留本計畫。

## 目標

收件者能從固定網址下載具版本的 macOS arm64 DMG，安裝到 Applications，完成一般單一 App 的安全例外與錄影授權後直接錄製。不需要開發工具或安裝憑證。App 預設英文，提供可保存的繁體中文。

不要求 Apple 認證／公證、App Store、Windows／Linux 發行、另一台 Mac 驗收或自動更新。「直接使用」不代表完全沒有系統提示，自簽版可能需選「仍要打開」。

## 優先順序與發布目的地

先執行本計畫。010 本身就是第一次 GitHub 發布，不需要先完成一個打包計畫、再另開第一次發布計畫。沿用現有固定自簽身分，在本機打包與驗證，再把同一份已驗 bytes 發布到 `EricTsai83/recordstuff`。2026-09-15 已確認 repo 公開且尚無 Release；目前也沒有 release workflow。CI 自動化與官網都不是本次交付的前置條件。

未來固定入口為 `https://github.com/EricTsai83/recordstuff/releases/latest`；驗證紀錄另外保留具版本的 Release 網址。這些是預定目的地，不代表目前已有可下載版本。規劃本身不代表授權公開發布；實作時依使用者的執行授權處理，已授權發布則不重複詢問。

## 已具備

既有腳本可固定自簽、核對巢狀 App 簽章，再建立附雙語安裝指南的 DMG。先前 arm64 包已有本機安裝、錄製、權限、Retina 與同身分更新證據。新語言功能尚未進入驗證過的發行產物，也尚未聲稱有公開下載。

## 剩餘工作

1. **明確打包入口。** 讓公開／預設 Mac 發行指令對應目前自簽流程；移除主要設定中過時的公證假設或清楚隔離未使用指令。保留固定身分、entitlements、簽章失敗即停止與本機 publish never；不降低驗證、不自動重置 TCC。
2. **準備最終產物。** 確定能辨識內容的版本、pnpm check、打 arm64 DMG、驗簽與掛載內容、附雙語安裝指南，再對最終 bytes 產 SHA-256。記版本、source revision／工作目錄狀態、平台、大小與 hash，私鑰不可進產物；不可沿用舊包 checksum。
3. **驗雙語安裝版。** 在現有 Mac 安裝候選包，以可行的隔離設定驗英文預設、中文切換、重啟保存、短錄存檔／有聲播放與通知動作、退出／更新。沿用有效歷史證據，但舊包不算新語言功能的驗證；不增加新帳號／第二台 Mac 要求。
4. **準備 GitHub Release。** 發行相關修改先形成 source commit，再建置候選包；版本 tag 必須對應同一份原始碼。選擇未使用、與 package.json 一致的版本。在 `EricTsai83/recordstuff` 準備 draft，附 arm64 自簽 DMG、SHA256SUMS 與英／繁中 release notes，說明變更、安裝、支援／已驗平台及限制。記錄 tag、source commit、檔名、大小與 checksum。上傳已驗 bytes，不重新打包；核對 draft 資產後依授權發布，draft 不算公開交付。本機保留 `--publish never`，上傳作為獨立且明確的步驟。
5. **驗實際下載流程。** 獲授權發布後，在現有 Mac 用瀏覽器下載實際資產，核 checksum、正常掛載／複製／開啟，記 quarantine／Gatekeeper 與人工允許步驟，再短錄播放。同機既有授權／快取限制如實註記，不推論為所有新機通過；不移除 quarantine 製造成功。
6. **完成入口文件。** README 放真實下載網址、版本／架構／checksum、雙語 release notes、安裝更新方法、僅 macOS 已驗聲明與問題回報方式。不可留下假連結或未驗 Windows／Linux 保證。

## 失敗處理與後續工作

簽章、checksum、安裝或錄影驗證失敗時，不得宣告完成。公開下載後若驗證失敗，記錄問題並及時修正下載指引；修復產物使用新版本，不默默覆蓋已發布資產。未驗證的第一版不能宣稱可直接使用。

完成後可執行 [011 發布自動化](011-github-release-automation.md)，降低重複工作；[012 官網下載入口](012-download-website.md) 則提供產品介紹入口。兩者都不是 010 的完成條件，012 也不依賴 011。

## 完成標準

- 最終 DMG 與 checksum 可由預定收件者從固定網址下載。
- 下載 bytes 與已驗產物一致，現有 Mac 的安裝／錄製／播放與授權歷史限制有記錄。
- App 與雙語指南對應實際產物；README 有真實下載及自簽限制。
- 收件者不需要開發依賴或憑證。

發布及下載驗證仍是未完成工作，寫下本計畫不算已交付。
