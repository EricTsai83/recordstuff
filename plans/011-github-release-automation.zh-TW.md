# 011 GitHub 發布自動化

[English](011-github-release-automation.md) | [繁體中文](011-github-release-automation.zh-TW.md)

狀態：CI 與 draft 已驗；待候選包人工驗收、公開提升與瀏覽器下載核對。更新：2026-09-15。

簽署原理與配置契約見 [macOS 簽署身分與自簽設計](../docs/zh-TW/system-design/signing.md)；CI 配置仍屬本計畫待辦。

## 目標與依賴

透過明確的版本 tag 或手動 GitHub Actions，產生可追溯的 macOS arm64 候選版本，保持一致簽署、checksum 與英文發行說明與雙語安裝指引連結。沿用 010 確立的發布規格，第一次交付不等待本計畫。官網可獨立進行。

## 工作

1. 沿用 010 已驗的 Node／pnpm 版本、lockfile 安裝、打包指令、產物檔名與驗證步驟，本機和 CI 使用同一個主要打包入口。拒絕 tag 與 package 版本不一致，以及重用已發布版本。
2. 先解決簽署身分再選 runner。現有腳本依賴 Keychain 的固定自簽身分；能安全提供憑證時，在 CI 暫存 keychain 使用同一身分。憑證與密碼存 repository／environment secrets，遮蔽輸出，失敗也清理。不可提交憑證私鑰、每版換身分，或降低憑證／App 驗證來通過 CI。若無法提供身分，保留本機建置，只自動化已驗候選包的檢查與上傳，明確標示為部分自動化。
3. 新增 macOS arm64 workflow，執行既定檢查與打包，核簽章、掛載內容，對最終 bytes 產生 SHA256SUMS，保存 source commit、版本、平台、大小與 checksum。明確固定工具／action 版本。不向不受信任的 PR 提供簽署 secrets，只有發布 job 取得 release 寫入權限，並避免並行發布覆蓋版本。
4. 必要檢查成功後才建立 draft Release。公開發布是明確提升已檢查、已安裝候選包的步驟，不重新打包。CI 無法證明的錄影／播放與語言操作仍需人工驗證，保留 010 的 release notes 與自簽安裝指引。
5. 以非公開候選包或針對性檢查驗證正常 draft，以及版本不符、缺少身分、簽章／checksum 錯誤和版本重複的失敗路徑；確認失敗不能公開發布。完成一次已授權的真實發布與瀏覽器下載／hash 核對，才宣告自動交付流程已驗。

## 完成標準

- 指定觸發方式可產生來源可追溯、簽署正確的 arm64 候選包與 checksum，無憑證洩漏。
- 必要檢查失敗不能提升發布，也不覆蓋既有公開 bytes。
- 至少一版真實發布與下載產物通過驗證；人工檢查及剩餘本機建置步驟如實記錄。
- 更新工具／設計、驗證紀錄、README 操作指引與翻譯。

## 範圍與參考

不包含 Windows／Linux／Intel Mac 擴充、Apple 認證／公證、Nightly、npm 發行或 App 自動更新。參考 T3 Code 的 [發布流程](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml) 與 [桌面打包](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release-desktop.yml)：建置後彙整資產並發布 GitHub；不需搬入它整套跨平台流程。執行時重新確認上游實作。

App 端更新機制另見 [015](015-app-update-assessment.zh-TW.md)；[013](013-macos-installation-experience.zh-TW.md) 交付後沿用其最新封裝規格。

實作與操作：[發布自動化](../docs/zh-TW/system-design/releases.md)。實際成功／失敗證據：[0.1.1](../docs/zh-TW/verification/releases/0.1.1.md)。目前未完成最後人工驗收，保留此計畫。
