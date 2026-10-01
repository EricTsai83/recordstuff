# 061 — 最佳化 pnpm check 之後的驗收

[English](061-verification-iteration.md) | [繁體中文](061-verification-iteration.zh-TW.md)

狀態：提案。相依：無。排在 [058 Playwright 試點](058-playwright-testing.zh-TW.md)之前，先用量測判斷 Settings UI 遷移是否能改善重要瓶頸。

## 問題與基準

目標是縮短 `pnpm check` 之後的驗收：Electron UI fixture、原生桌面操作、bundle 重建／簽署、錄影、播放，以及 AI 重複執行已通過的檢查。先量測這些路徑，不預設它們各自的成本。TypeScript／Vitest／build 內部加速不在本計畫範圍；移除意外重跑的第二次 check 在範圍內，削減其覆蓋則不在範圍內。

本對話一次本機 `/usr/bin/time -p pnpm check` 實測全部通過，共 **20.36 秒**，**93 檔／1353 測試**通過。Vitest 回報 **17.85 秒**；三個 Vite build 階段合計 **321 ms**。其餘約 **2.19 秒**包含型別檢查與命令／工具啟動，並非獨立量測的 typecheck 時間。這只是一次觀察，不是穩定效能預算，也不能證明後續哪個檢查最慢。

保留 `pnpm check` 作為 App 最終修改基準，以及[共同測試政策](../docs/testing.md)要求的必要驗收。本計畫不需要修改 Vitest isolation、升級 Electron、建立持久測試結果 cache、依檔名自動選測或替代原生 capture 證據。Playwright 實作仍由 058–060 處理。

## 設計

### 量測實際驗證路徑

在既有 runner orchestration 加入輕量時間／報告支援，重用程序與環境 helper。提案支援位置為 `scripts/lib/verification-timing.mts`；選擇能取得必要資料的最小整合，不建立新通用測試框架。不為量測改變輸入投遞、增加錄影或在產品加入 polling。

記錄 monotonic elapsed time、runner／階段、revision 加 working-tree 內容識別、相依版本、artifact 身分、要求範圍、結果與 cleanup，包含失敗、blocked、中斷。依既有 runner 可觀察邊界，區分命令啟動、type／unit／build、打包／簽署、Electron fixture 編譯／啟動、互動、截圖、媒體分析、清理。量測 composite parent wall time 與 child phase，避免巢狀時間重複加總。

若 session log 有對應區間，區分機器執行、AI orchestration 空檔與桌面 readiness 等待；缺資料就標未知，不算零，也不從 tool output 猜測。沿用已取得的 20.36 秒觀察，直到實作變更或未解量測問題需要另一份 baseline。

量測 Settings 修改的 check 後成本（`acceptance:regression` 扣除其中實測 check 階段）、原生入口／焦點修改、錄影修改。純邏輯路徑以已取得 check 觀察作參考，不需要新的加速 benchmark。優先用保留 log 與必要真實開發回合，只補缺少的代表路徑；不只為時間資料跑完整 capture matrix 或重複錄影。controlled runner 樣本只能量到該 runner，不能代表整個 AI 工作流程。

### 最佳化五類驗收成本

| 路徑 | 具體檢查與修改邊界 |
| --- | --- |
| Electron UI | 分別量測 Settings 與快捷鍵整合的 fixture 啟動、互動／等待、截圖矩陣。保留必要最終 regression，安全時提供既有範圍選取。替換 driver 或重整案例由 058–060 處理。 |
| 原生桌面 | 每個 OS 操作對應修改需求；controlled 互動用 fixture，實際 OS 邊界用原生觀察。不重跑無影響的完整原生矩陣；必要案例集中於同輪，但完整回合之間仍清理。把 Computer Use 操作轉為腳本 runner 屬於 [063](063-scripted-native-acceptance.zh-TW.md)；本盤點用來排定其 runner 步驟順序。 |
| Build／打包／簽署 | 檢查 `scripts/start-app.mjs` 與 bundle consumer。runtime 輸入不變只 build／sign 一次，後續回合可用 `pnpm open:app` 重開已驗證同一 artifact。不重用 stale bundle 或跳過簽署驗證。 |
| 錄影／播放 | 每份錄影先指定問題，一份適合的 take 同時提供 smoke、變更行為、媒體分析與播放，檢查同一存檔。保留特定時長案例及真實播放觀察，不能以自動媒體分析取代。 |
| AI 重複執行 | 檢查 `AGENTS.md`、共同政策與相關實作／驗收 skill，是否對未變更證據、僅測試／文件後續修改要求整套重跑。記錄已通過項目及變更，僅重跑受影響要求，證據完整即停止。 |

結果須指出高成本路徑與前後必要案例集合；移除仍必要的原生或播放案例造成的假加速無效。桌面 blocked、程序清理、artifact 新鮮度保留為技術不變條件。

### 每個相關版本選一次、驗證一次

依修改行為、受影響 caller 與政策合併列，建立精簡驗證 recipe，記錄必要檢查、涵蓋它們的 composite command、artifact 需求與有理由的排除。人與 AI 採同一選測規則，不能只依檔名分類。新命令不能默默降低既有最終驗收要求。

| 情況 | 執行規則 |
| --- | --- |
| 修改／除錯中 | 用局部測試／型別檢查回答當前問題，不取代最終必要檢查 |
| 最終版本 | 有涵蓋範圍的 composite 就只執行一次，例如 `pnpm acceptance:regression`，不先重跑它包含的 `check`／build |
| 獨立 runner 需要 `out/` | 最終輸入只 build 一次，依序消費該 artifact，避免 wrapper 重建相同輸入 |
| 原生驗收需要 signed bundle | 針對相符最終 runtime 輸入 build／sign 一次，`out/` 證據不能取代 signed-bundle 證據 |
| 後續 edit 或 review 修正 | 重新分類影響，讓相關證據／artifact 失效並重跑必要項目，不自動重跑整個桌面矩陣 |
| 檢查失敗或環境改變 | 解決失敗／不確定性後重跑受影響範圍，不當成成功證據重用 |

任務內重用須明確且受來源／相依／設定身分、證據範圍、artifact、環境限制。後續 edit 只有在 caller／相依能證明無影響且政策允許時，才保留不相關證據。無法確認 artifact 新鮮度就重建；timestamp 或 HEAD 不能單獨證明未提交 working tree 的新鮮度。不建立跨任務 skip cache。

一份錄影符合所有必要案例時，可提供 start／stop／save、媒體分析與播放證據。只有檔案／analyzer／選項相同才重用媒體分析。必要檢查通過後即停止，額外重跑須有 edit、失敗、不確定性或明確新增要求。保留設定恢復、程序清理與結果契約，不為速度移除。

## 實作

- [ ] 盤點五類 check 後路徑的必要案例、命令展開與 artifact 相依，找出重複 UI／原生回合、bundle 重建、錄影／播放或已通過檢查。
- [ ] 在既有階段邊界加入輕量計時，產生包含結果／artifact 身分的成本拆解；先以 controlled process 驗證時間／輸出，再用於真實驗收。
- [ ] 在中英測試／工具／貢獻文件與精簡 repository agent instructions 定義任務內 recipe、證據失效規則；引用共同政策而不複製，檢查相關實作／驗收 skill 是否有衝突的無條件重跑。
- [ ] 移除已確認冗餘 wrapper 呼叫或 rebuild，保留 standalone command 行為與 fresh-artifact 驗證。只修改已量到的 orchestration 問題，大型 driver 變更留給 058–060。
- [ ] 驗證代表性執行圖與受影響 runner 失敗／中斷／cleanup，對照等價前後總時間。證據符合條件就重用；缺少時間就如實報告，不擴大無關驗收。
- [ ] 記錄實測瓶頸排序與 058 試點範圍。只有 UI 遷移能改善實測成本、不穩定或診斷負擔才進入 058，否則延後該鏈、保留既有 driver。

## 驗證與完成條件

依實際實作做[影響選測](../docs/testing.md)：相關工具測試、TypeScript 的 `pnpm typecheck`、fixture 載入 `out/` 前 build，以及變更 orchestration 的失敗／timeout／中斷／cleanup。改到真實輸入或錄影 orchestration 就需驗證該真實路徑，前提不足標 blocked。純指示文件修改檢查命令／連結／翻譯與空白，不測桌面行為。

驗收條件：必要覆蓋與證據邊界完整；選定 recipe 沒有冗餘最終 composite 或相同 artifact 輸入的 rebuild；資料區分總 wall time、巢狀階段、等待；controlled failure／cleanup 不能變成 pass。至少一個已確認重複／過廣執行路徑須提供等價覆蓋下的時間節省；若實際沒有這種路徑，記錄該結果及成本排序，不宣稱改善。baseline 前不設任意百分比目標。

交付為 check 後五類成本拆解、最小計時支援、已驗證驗收 recipe 與確認必要的 orchestration 修正。耐久結果提供 058 瓶頸優先序與可重用量測邊界。本計畫可獨立於採用 Playwright 完成，不需要全面遷移。
