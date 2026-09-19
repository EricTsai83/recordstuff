# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-19。v0.1.1 已公開；見[本版證據](../docs/zh-TW/verification/releases/0.1.1.md)。013 的原始碼變更已實作並在本機驗證；本機驗收、移除檢查與 tag 觸發的 0.1.2 發布尚待完成，記錄於 [0.1.2 證據](../docs/zh-TW/verification/releases/0.1.2.md)。操作見 [發布自動化](../docs/zh-TW/system-design/releases.md)。

## 順序與狀態

| 順序 | 計畫 | 狀態 | 交付目標 |
| --- | --- | --- | --- |
| 接續 | [013 安裝體驗](013-macos-installation-experience.zh-TW.md) | 原始碼已實作；待發布 | 本機驗收安裝／取代／錄影、在可丟棄副本驗證移除、推送 tag v0.1.2 |
| 配合下版 | [014 Finder 通知焦點](014-finder-notification-focus.zh-TW.md) | 已規劃 | 重現並修正明確點擊後的置前，驗證原生焦點 |
| 可開始實作 | [012 官方網站](012-download-website.zh-TW.md) | 已規劃 | 雙語產品／說明網站、DMG 直接下載與版本／checksum 資訊 |
| 優先改善更新便利性時 | [015 App 更新評估](015-app-update-assessment.zh-TW.md) | 僅延後決策 | 比較手動、主動檢查、自動更新及固定自簽可行性 |

013 與 014 可合併新版本，皆不依賴 CI 或官網。011 自動化發布，不更新使用者的 App；015 不代表已選定實作更新器。公開發行說明維持全英文，App 與讀者指引保留雙語，不覆寫已發布的 v0.1.0 產物。

不規劃專用解除安裝器：結束後移到垃圾桶，使用者資料保留，清理另行處理。不排入僅為減小體積而原生重寫、Apple 認證、Windows／Linux／Intel 驗證或擴充。DMG 大小已說明主要來自 Electron 執行環境，討論本身不建立重寫專案。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
