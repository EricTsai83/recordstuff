# 013 macOS 安裝體驗

[English](013-macos-installation-experience.md) | [繁體中文](013-macos-installation-experience.zh-TW.md)

狀態：原始碼變更已於 2026-09-19 實作並在本機驗證；打 tag 前的本機驗收與 0.1.2 發布尚待完成。更新：2026-09-19。不替換已發布的 v0.1.0 與 v0.1.1 資產。

## 目標

DMG 清楚呈現 RecordStuff → Applications，不附任何安裝／說明文件。使用者下載前可找到首次開啟、手動更新與解除安裝說明。不依賴發布自動化（011）或官網（012）。

## 已在原始碼完成（0.1.2）

永久說明見[發布自動化](../docs/zh-TW/system-design/releases.md)、[工具鏈](../docs/zh-TW/system-design/tooling.md)、[設計決策](../docs/zh-TW/system-design/decisions.md)與[安裝指南](../resources/INSTALL.zh-TW.md)；本機證據見 [0.1.2 驗證](../docs/zh-TW/verification/releases/0.1.2.md)。

- DMG 只含 `RecordStuff.app` 與 `/Applications` 連結，背景為程式產生的箭頭；不附任何格式的文件。發布閘門（`assertDmgContents`）遇到其他可見根目錄項目即失敗。
- 發行說明提供簡短的安裝、「仍要打開」、權限／重新啟動、手動更新與移除指引，並以固定到 commit 的連結指向雙語指南。
- 指南說明手動更新（同一身分與路徑；設定保留）與移除（垃圾桶；錄影、設定與 log 保留；列出選用清理；絕不自動刪除）。
- package.json 為 0.1.2；本機候選建置通過 `pnpm dist:mac`、候選閘門與 Finder 版面檢查。

## 剩餘工作

1. 打 tag 前的本機驗收，依[發布檢查清單](../docs/zh-TW/system-design/releases.md#操作)：`pnpm start:app`、短錄影並播放。因本計畫變更了打包，另開一次本機 0.1.2 DMG 確認 Finder 版面（實作者已於 2026-09-19 完成；維護者再看一次為選做）。
2. 已於 2026-09-19 完成：在可丟棄副本上驗證移除，錄影、設定與 log 未變；見 [0.1.2 驗證](../docs/zh-TW/verification/releases/0.1.2.md)。
3. 推送 tag `v0.1.2`；CI 建置、驗證並公開。把 run 連結、大小與 SHA-256 記入 [0.1.2 驗證](../docs/zh-TW/verification/releases/0.1.2.md)；瀏覽器下載 checksum 是選做的抽查。
4. 更新 README 下載區、計畫索引與翻譯。所有結論收錄後移除本計畫及其翻譯。

## 參考及驗收

2026-09-15 已查看 T3 Code [目前官方打包設定](https://github.com/pingdotgg/t3code/blob/main/scripts/build-desktop-artifact.ts)：DMG contents 只有 App 與 /Applications 連結，搭配主題背景。本專案實作形式相同；箭頭背景由 `pnpm icons` 產生，而非手繪素材。

驗收：公開的 0.1.2 DMG 不包含安裝／說明文件、拖曳安裝動線清楚且說明仍可取得，更新／移除說明符合實際行為，既有版本保持不變。不包含自動更新、Apple 認證、其他平台或 Finder 通知置前修正。

通知修正與 [014](014-finder-notification-focus.zh-TW.md) 協調；App 更新可行性另列延後的 [015](015-app-update-assessment.zh-TW.md)。退出 DMG 不等於解除安裝。測試暫存備份需記錄用途，驗證及設定還原後清理，不動使用者錄影。
