# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-15。v0.1.1 已由 CI 建立、人工安裝驗收並公開原產物；[本版證據](../docs/zh-TW/verification/releases/0.1.1.md)。011 僅剩公開瀏覽器下載檔 checksum，因 macOS 存取限制待使用者協助。

## 順序與狀態

| 順序 | 計畫 | 狀態 | 交付目標 |
| --- | --- | --- | --- |
| 接續 | [013 安裝體驗](013-macos-installation-experience.zh-TW.md) | 已規劃 | DMG 不附說明文件、線上指引、手動更新／移除與資料保留指引 |
| 配合下版 | [014 Finder 通知焦點](014-finder-notification-focus.zh-TW.md) | 已規劃 | 重現並修正明確點擊後的置前，驗證原生焦點 |
| 進行中 | [011 發布自動化](011-github-release-automation.zh-TW.md) | 已公開，待瀏覽器檔案 checksum | 可重現候選版與明確發布流程 |
| 可開始實作 | [012 官方網站](012-download-website.zh-TW.md) | 已規劃 | 雙語產品／說明網站、DMG 直接下載與版本／checksum 資訊 |
| 優先改善更新便利性時 | [015 App 更新評估](015-app-update-assessment.zh-TW.md) | 僅延後決策 | 比較手動、主動檢查、自動更新及固定自簽可行性 |

013 與 014 可合併新版本，皆不依賴 CI 或官網。011 自動化發布，不更新使用者的 App；015 不代表已選定實作更新器。公開發行說明維持全英文，App 與讀者指引保留雙語，不覆寫已發布的 v0.1.0 產物。

不規劃專用解除安裝器：結束後移到垃圾桶，使用者資料保留，清理另行處理。不排入僅為減小體積而原生重寫、Apple 認證、Windows／Linux／Intel 驗證或擴充。DMG 大小已說明主要來自 Electron 執行環境，討論本身不建立重寫專案。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
