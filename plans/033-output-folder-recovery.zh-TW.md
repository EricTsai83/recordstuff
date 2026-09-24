# 033 — 開啟錄影資料夾與可見錯誤恢復

[English](033-output-folder-recovery.md) | [繁體中文](033-output-folder-recovery.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍、證據與獨立原因

R2-08（P3）。[主程序](../src/main/index.ts) 可用的 openOutputDir 操作呼叫 shell.openPath，失敗只寫 log。全新 SettingsStore 指向 Movies/RecordStuff，但該資料夾到開始錄製才建立。真實 store／tray／action 路徑搭配不存在路徑的 shell boundary，重現按鈕可用、目錄未建立、沒有可見回饋；未測原生 Finder 行為。

與 FileWriter 計畫分開：這是明確開啟資料夾的操作與使用者恢復，不是錄影發布。範圍包含 tray action、檔案系統／shell 邊界、雙語提示及針對性測試；沒有新增 Cap 類比結論。

## 實作契約

- [ ] 已存在目錄正常開啟。已知預設資料夾不存在時，先驗證父目錄，再只建立預期目錄後開啟；建立失敗須顯示清楚且可處理的提示。不能因開啟資料夾而改變已存輸出設定。
- [ ] 自訂目錄不存在（包含外接磁碟離線）須提供在地化失敗提示與選擇／恢復路徑；不可無條件重建設定路徑而誤寫系統碟。沿用既有選資料夾流程與錄製鎖定；取消不改設定。
- [ ] shell.openPath 回傳錯誤及 promise rejection 都須顯示具路徑／情境的有用回饋，同時保留診斷。優先使用既有可見錯誤 UI，不引入存檔通知行為。限制／共用重複點擊中的工作，避免重複對話框與未處理錯誤。
- [ ] 測首次錄製前的全新預設、既有目錄、預設父目錄不存在、自訂目錄被刪、外接磁碟離線路徑、權限拒絕、路徑其實是檔案、shell 失敗及連點。斷言不建立意外目錄、不誤改設定，恢復後重試成功。
- [ ] 同步雙語桌面／使用指引與文案，保留錄製本身的輸出目錄驗證。

## 必要驗證與排除

執行 `pnpm check`，在全新 `pnpm start:app` 上操作 tray：隔離的全新預設、既有資料夾與不存在自訂資料夾；觀察雙語 Finder／錯誤 UI 與重試／取消。使用隔離路徑，不刪使用者目錄。若修改設定 UI／IPC，追加 `pnpm acceptance:regression`；若修改選擇資料夾或錄製驗證，追加新輸出路徑的錄製 smoke。限於 open-only 操作時，錄製、媒體矩陣、硬體拔除、通知與發布不在範圍。模擬 shell 不能取代原生 Finder 觀察。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。
