# 027 — 權限狀態同步與查詢生命週期

[English](027-permission-state-and-query-lifetime.md) | [繁體中文](027-permission-state-and-query-lifetime.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍與證據

處理 bug **2、6**，排在 026 後，整合 025 的終止生命週期。[Recorder.setPermission](../src/main/recorder.ts) 忽略忙碌時的 denied，回 idle 後 [PermissionWatcher](../src/main/permission.ts) 又永久去重。另一個案例讓 countScreens 一直 pending，預設 timer 在 30 秒送出七個未完成請求。兩者均未修改 macOS TCC，也未量測原生記憶體洩漏。

## Cap 評估

Cap 採用[廉價 preflight、成功快取、昂貴驗證序列化、in-flight guard 與完成後開始的重試退避](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/permissions.rs#L320-L490)；其[權限要求 helper 會重新檢查實際狀態](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src/utils/os-permissions.ts#L40-L74)。可參考這些設計，但檢視路徑中沒有找到與 Recorder 事件遺失完全相同的修正。

Cap 也會讓 ShareableContent::current 逾時。本次未證明丟棄該 future 會取消底層 macOS 呼叫，因此不能拿它當作完全防止 bug 6 的證據。RecordStuff 必須在 UI 期限到後，仍持有真正 Electron getSources promise，直到它結束。

## 實作與測試

- [ ] 獨立保存最新 granted／needsRelaunch，不與錄製狀態混為一談。成功、擷取失敗與啟動失敗回到非忙碌時，依最新權限決定 idle 或 needsPermission；狀態模型須適當保留最近存檔與失敗資訊。不只因權限通知就中斷進行中錄製。重新授權可恢復，不依賴重複通知。
- [ ] 分開追蹤真正列舉 promise 與 UI deadline。Watcher 發出的 countScreens，包括首次權限登記提示，最多只能有一個未完成。逾時可顯示恢復指引，但不能釋放底層 in-flight 名額；清旗標不等於取消。
- [ ] 真正失敗結束後，從完成時間計算有界重試退避。永久 pending 時維持廉價狀態輪詢及手動恢復／重啟指引，不送替代原生請求。不承諾底層永不返回時仍可自動恢復。
- [ ] 用 generation／lifetime token 防止 stop()、撤銷／重授權、晚到結果或舊權限世代套用過時成功。只能釋放自己請求的名額；dispose 移除 activate listener 與 timer。整合首次提示與嚴格驗證，避免偷偷產生第二個列舉。
- [ ] 測 starting／recording／stopping 撤銷後成功／失敗回穩定狀態、忙碌中授權、needsRelaunch 切換、成功存檔仍可找到；逾時／stop／撤銷重授權前後 pending、晚到成功與拒絕。多次模擬輪詢仍只有一個底層未完成請求，不只檢查 wrapper；結束後驗證退避與恢復。
- [ ] 更新雙語權限／錄製設計及符合實際能力的恢復指引。

必要：`pnpm check`、全新 `pnpm start:app` smoke、開發 App 的原生撤銷／重新授權／重啟恢復，記錄 OS 提示或強制重啟行為；完成後恢復權限／設定。macOS 不允許互動重現的忙碌時序以注入測試另列，不混為原生證據。設定投影若改變，加入 `pnpm acceptance:regression`。不做完整媒體矩陣、長錄製、拔除硬體或殺系統服務。缺少權限操作前提屬 blocked，不代表已證明安全。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 評估是固定 revision `ce785e705e79652adba4b8bf752669c4093499e0` 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
