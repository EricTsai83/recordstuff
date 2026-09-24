# 031 — 正式版本下載指標不可倒退

[English](031-stable-release-recording.md) | [繁體中文](031-stable-release-recording.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍、證據與獨立原因

R2-04（P2）。[release record](../scripts/release.mts) 無條件更新 stable manifest 與雙語 README 下載區塊，只有 package.json 有版本比較。在可丟棄 checkout，用本地網路／gh fixture 執行真實 CLI，依序記錄 0.1.4、0.1.3，結果 package.json 保留 0.1.4，但 manifest 與 README 倒退為 0.1.3。沒有變更遠端 release 或官網。

另開計畫：發布資料的版本順序與 024–030 的擷取收尾、設定、媒體驗收獨立。遵守[發布契約](../docs/zh-TW/system-design/releases.md)。範圍為 record 輸出選擇、manifest 驗證、真實 CLI 測試與雙語發布文件；保留已發布位元組與人工驗證紀錄。本計畫沒有新增 Cap 類比結論。

## 實作契約

- [ ] 分開補寫歷史證據與更新目前正式版下載指標。舊正式版本可補缺少的歷史紀錄，但不能倒退 stable manifest 或任一 README；prerelease 維持只寫歷史。
- [ ] 以語意版本順序比較已驗證候選正式版本與已驗證的 committed stable manifest。package.json 可能是無關的開發／候選版本，不能單獨決定下載指標是否更新；保留它既有的不降版行為。
- [ ] 同版本重試在 release 身分與產物資料相符時須可重複執行；source commit／digest／asset 身分矛盾須在寫入前失敗。較新正式版本以同一份驗證 snapshot 更新 manifest 與兩份 README。明確回報僅補歷史、未變更或已更新指標。
- [ ] 所有寫入前先驗證現有 manifest 與預定輸出。缺少／損壞 stable 基準須失敗並提供可操作診斷，不能默默採用較舊候選；若需要首次 bootstrap，須是另行明確定義且有測試的路徑。保留先驗完輸入才寫出的契約，不宣稱跨檔案崩潰原子性。
- [ ] 可丟棄 checkout 的真實 CLI 測試涵蓋新→舊、同版本重試／衝突、新版更新、prerelease、package 高於／低於 manifest、基準缺失／損壞、README marker 錯誤與已有人工紀錄。檢查所有輸出及失敗時未變更檔案；網路使用固定本地回應，不發布。
- [ ] 雙語發布設計補上僅記錄歷史、stable 指標基準與重試契約。保留 workflow 序列化；此修正不需要改發布／權限流程。

## 必要驗證與排除

執行 release-record／manifest 相關測試、`pnpm typecheck` 與 `git diff --check`；以既有離線消費端斷言檢查產生的 manifest／README 一致性。不改 App 行為、官網版面、簽章或打包，因此排除錄製、DMG build、線上發布與部署。若實作超出資料輸出選擇而修改官網程式／build 輸入，結案前追加適用官網政策。此計畫不授權 tag、commit、push 或 release。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。
