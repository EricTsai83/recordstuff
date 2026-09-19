# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-20。v0.1.2 已由 tag `v0.1.2` 公開，附精簡 DMG；見 [0.1.2 證據](../docs/zh-TW/verification/releases/0.1.2.md)。013 與 016 已完成並移除；錄影快捷鍵與其無人值守驗收（`pnpm acceptance`）記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

## 順序與狀態

| 順序 | 計畫 | 狀態 | 交付目標 |
| --- | --- | --- | --- |
| 接續 | [017 儲存通知時序](017-saved-notification-timing.zh-TW.md) | 已規劃；已在對應案例確認系統抑制 | 修復並驗證擷取停止後的通知時序，完成兩輪本機完整測試 |
| 017 與剩餘點擊調查之後 | [014 Finder 通知焦點](014-finder-notification-focus.zh-TW.md) | 已在本地實作；驗收未完成 | 解決未完成驗收；收到發布指示後才發布，驗證公開版並移除計畫 |
| 可開始實作 | [012 官方網站](012-download-website.zh-TW.md) | 已規劃 | 雙語產品／說明網站、DMG 直接下載與版本／checksum 資訊 |
| 優先改善更新便利性時 | [015 App 更新評估](015-app-update-assessment.zh-TW.md) | 僅延後決策 | 比較手動、主動檢查、自動更新及固定自簽可行性 |

014 不依賴官網。發布由推送 tag 自動化；已安裝 App 的更新為手動。015 不代表已選定實作更新器。公開發行說明維持全英文，App 與讀者指引保留雙語，不覆寫已發布的產物。

不規劃專用解除安裝器：結束後移到垃圾桶，使用者資料保留，清理另行處理。不排入僅為減小體積而原生重寫、Apple 認證、Windows／Linux／Intel 驗證或擴充。DMG 大小已說明主要來自 Electron 執行環境，討論本身不建立重寫專案。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
