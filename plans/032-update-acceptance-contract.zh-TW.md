# 032 — 修正更新驗收的設定鎖定契約

[English](032-update-acceptance-contract.md) | [繁體中文](032-update-acceptance-contract.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍、證據與獨立原因

R2-06（P2）。[assertNoUpdateActions](../scripts/acceptance-updates.mts) 假定錄製中只有 language 可用，但 production 設定模型也允許 appearance 與 about。將真實 settingsView／trayModel 的錄製 snapshot 交給實際斷言，會在 appearance 失敗；該重現未執行完整原生 runner。

這是獨立的 runner 契約錯誤，不屬 028 的產品快捷鍵／視窗生命週期，也不屬 030 的媒體證據。範圍為更新驗收斷言、針對性回歸與驗證指引。不能為迎合過時測試而鎖住原本正確的 appearance／about；本項沒有新增 Cap 類比。

## 實作契約

- [ ] 按產品意圖明列 group 期望：影響錄製的偏好與更新操作維持鎖定；appearance、language、about 維持可用。保留 tray REC／stop 與更新操作隱藏檢查；必要時同時檢查 group 與個別 action enablement。
- [ ] 抽出／共用 production runner 斷言供直接測試，以真實 settingsView／trayModel snapshot 驅動；不可直接抄回傳 enabled 值當期望。新出現 group 必須明確決定政策，不默默放行。
- [ ] 涵蓋正常錄製、錄製／更新控制錯誤解鎖、允許控制錯誤鎖定與有新版變體。相關 starting／stopping／idle／permission snapshot 依各自狀態契約覆蓋，不把錄製限定的 REC 斷言套到所有狀態。
- [ ] 預設錄製段須走到完成，包含失敗清理與還原。保留 feed／更新行為，說明修正斷言的證據範圍；instrumented snapshot 不能宣稱證明原生瀏覽器／tray 投遞。

## 必要驗證與排除

執行針對性測試、`pnpm typecheck`、`git diff --check` 與真正 `pnpm acceptance:updates`，包含其必要的全新 fixture build。不可用 --logic-only，因為錯誤斷言在錄製段才觸發；觀察所存錄影播放並記錄清理。Feed filtering／timeout 未變，不需要完整 feed 矩陣或重複一般錄製輪次；若另改 App runtime 再合併適用政策。原生 UI 操作依驗收 skill；契約有文件說明處同步雙語驗證／工具指引。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。
