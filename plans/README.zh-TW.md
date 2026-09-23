# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-23。v0.1.3 已由 tag `v0.1.3` 公開，附精簡 DMG；見 [0.1.3 證據](../docs/zh-TW/verification/releases/0.1.3.md)。013 與 016 已完成並移除；錄影快捷鍵與其無人值守驗收（`pnpm acceptance`）記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

017 已完成：儲存通知時序修正、連續兩輪 15/15 驗收，以及取消／重疊／播放檢查皆完成；詳見[驗證紀錄](../docs/zh-TW/verification/README.md#儲存通知時序2026-09-20)。

014 已完成並移除：維護者接受雙語通知矩陣 30/30 的本機結果作為計畫結案依據。歷史根因不確定性與未測項目保留於[驗證紀錄](../docs/zh-TW/verification/README.md#通知生命週期調查--2026-09-20)。發布及公開版檢查改由另行要求的發布流程處理。

012 已完成並移除：[官網](https://record.ericts.com)已上線，維護者於 2026-09-20 確認上線並要求文件收尾；結案依據與歷史驗證範圍見[驗證紀錄](../docs/zh-TW/verification/README.md#plan-012-結案--2026-09-20)。018 現已完成。

## 順序與狀態

019 已依維護者手動驗收與設定閃爍修正／回歸結果結案並移除。保留目前「通知總覽 → RecordStuff」的操作路徑；歷史發現與未測條件見[結案紀錄](../docs/zh-TW/verification/README.md#plan-019-結案--2026-09-23)。

020 已依維護者接受自動化驗收結案並移除。真實 OS 衝突與通知橫幅保留為未測限制；既有原生錄影／播放、14 項失敗與重啟自動化及清理證據見[結案紀錄](../docs/zh-TW/verification/README.md#plan-020-結案--2026-09-23)。

目前：[023 — 用全域快捷鍵開啟設定](023-settings-shortcut.zh-TW.md)（尚未開始）。讓 computer use 不需維護者點擊，就能自行開啟並聚焦真正的設定面板；包含註冊衝突處理與原生按鍵驗收。執行順序：023 → 021 → 022；既有計畫編號不變。

再接著：[021 — 選擇要錄哪一個螢幕](021-screen-selection.zh-TW.md)（尚未開始）。display-media handler 一律解析主要顯示器，第二台螢幕根本錄不到。021 在「設定 → 錄影」新增「螢幕」選擇，預設維持「主要顯示器」，儲存能撐過重新接上的指紋，並在已儲存的選擇無法解析時以明確理由拒絕開始，而不是改錄另一個螢幕。

再來：[022 — 設定面板的視覺設計](022-settings-visual-design.zh-TW.md)（尚未開始）。面板是 App 唯一的視窗，而每一項偏好 — 包括只有開與關的那兩項 — 都畫成同一個滿版下拉選單、包在同一張卡片裡。022 把列分成區段，讓 main 逐群組宣告開關、分段控制或彈出選單，把失敗回報在出問題的控制項旁邊，並改用系統強調色取代寫死的藍。一併統一細緻的 focus、整併自訂快捷鍵入口，加入行內捕捉、按鍵預覽、就近回饋與焦點還原；整體維持精緻的 macOS 風格。偏好、id、預設值與鎖定規則都不變。

018 的本機驗收、公開 feed 與 0.1.3 發布已完成；見[結案紀錄](../docs/zh-TW/verification/README.md#plan-018-結案--2026-09-20)。未測範圍仍保留在驗證文件。

發布由推送 tag 自動化；已安裝 App 的更新仍為手動。018 只新增「有新版就告知並連到下載頁」的檢查，不授權由 App 下載或安裝更新。公開發行說明維持全英文，App 與讀者指引保留雙語，不覆寫已發布的產物。

不規劃專用解除安裝器：結束後移到垃圾桶，使用者資料保留，清理另行處理。不排入僅為減小體積而原生重寫、Apple 認證、Windows／Linux／Intel 驗證或擴充。DMG 大小已說明主要來自 Electron 執行環境，討論本身不建立重寫專案。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
