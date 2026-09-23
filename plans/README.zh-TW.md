# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-23。v0.1.3 已由 tag `v0.1.3` 公開，附精簡 DMG；見 [0.1.3 證據](../docs/zh-TW/verification/releases/0.1.3.md)。013 與 016 已完成並移除；錄影快捷鍵與其無人值守驗收（`pnpm acceptance`）記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

017 已完成：儲存通知時序修正、連續兩輪 15/15 驗收，以及取消／重疊／播放檢查皆完成；詳見[驗證紀錄](../docs/zh-TW/verification/README.md#儲存通知時序2026-09-20)。

014 已完成並移除：維護者接受雙語通知矩陣 30/30 的本機結果作為計畫結案依據。歷史根因不確定性與未測項目保留於[驗證紀錄](../docs/zh-TW/verification/README.md#通知生命週期調查--2026-09-20)。發布及公開版檢查改由另行要求的發布流程處理。

012 已完成並移除：[官網](https://record.ericts.com)已上線，維護者於 2026-09-20 確認上線並要求文件收尾；結案依據與歷史驗證範圍見[驗證紀錄](../docs/zh-TW/verification/README.md#plan-012-結案--2026-09-20)。018 現已完成。

## 順序與狀態

019 已依維護者手動驗收與設定閃爍修正／回歸結果結案並移除。保留目前「通知總覽 → RecordStuff」的操作路徑；歷史發現與未測條件見[結案紀錄](../docs/zh-TW/verification/README.md#plan-019-結案--2026-09-23)。

020 已依維護者接受自動化驗收結案並移除。真實 OS 衝突與通知橫幅保留為未測限制；既有原生錄影／播放、14 項失敗與重啟自動化及清理證據見[結案紀錄](../docs/zh-TW/verification/README.md#plan-020-結案--2026-09-23)。

023 已結案並移除；維護者於 2026-09-23 碼率重測後要求正式收尾。驗收包含混合原生入口、雙語／擷取／錄製回歸、25 項受控整合斷言、三次通過的 30 秒完整性重測及視窗清理確認。歷史失敗與證據限制保留於[結案紀錄](../docs/zh-TW/verification/README.md#plan-023-結案--2026-09-23)。022 亦已結案。

021 已依維護者人工驗收結案並移除：拔除拒絕、改選主螢幕恢復、重接直接恢復，以及錄製中拔除後結束／存檔／播放與提示均已確認。錯誤辨識度改善由 022 承接；證據範圍與未驗情境見[結案紀錄](../docs/zh-TW/verification/README.md#plan-021-結案--2026-09-23)。

022 已依維護者確認結案並移除：自訂快捷鍵的滑鼠確定修正已由維護者實測成功；最終底部改為左側作者署名、右側官方網站／GitHub 圖示。其餘人工驗收由維護者明確決定不再補測，作為接受的未測限制保留；詳見[結案紀錄](../docs/zh-TW/verification/README.md#plan-022-結案--2026-09-24)。目前沒有待執行的開發計畫。

018 的本機驗收、公開 feed 與 0.1.3 發布已完成；見[結案紀錄](../docs/zh-TW/verification/README.md#plan-018-結案--2026-09-20)。未測範圍仍保留在驗證文件。

發布由推送 tag 自動化；已安裝 App 的更新仍為手動。018 只新增「有新版就告知並連到下載頁」的檢查，不授權由 App 下載或安裝更新。公開發行說明維持全英文，App 與讀者指引保留雙語，不覆寫已發布的產物。

不規劃專用解除安裝器：結束後移到垃圾桶，使用者資料保留，清理另行處理。不排入僅為減小體積而原生重寫、Apple 認證、Windows／Linux／Intel 驗證或擴充。DMG 大小已說明主要來自 Electron 執行環境，討論本身不建立重寫專案。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
