# 060 — Settings 視覺覆蓋與 Playwright 流程切換

[English](060-settings-playwright-cutover.md) | [繁體中文](060-settings-playwright-cutover.zh-TW.md)

狀態：提案，須前置計畫成功。相依：058 採用的 harness 與量測契約，以及 [059 行為覆蓋](059-settings-playwright-behavior.zh-TW.md)。本計畫完成 Settings 遷移並切換預設 runner。

## 問題與範圍

只有行為遷移不足以證明完整驗收等價。保留語言／主題／尺寸／狀態矩陣，確認完整 suite 行為與耗時，再切換預設 runner，避免重複 build 或永久執行兩套 suite。

CI 擴充、網站測試、快捷鍵 fixture 與錄影 runner 遷移不在範圍內。保留既有 `pnpm check` CI。未來 Electron UI CI 計畫須先證明實際 runner 的 graphical session、activation、取消／cleanup 可用；browser mock 不是等價證據。

## 視覺設計

盤點每個既有截圖／版面案例，對應至參數化 Playwright 情境。保留雙語、native light/dark、最小／正常尺寸、設定狀態、overflow、focus 與歷史／失敗呈現。只有確認矩陣格走相同行為，且其獨特斷言已由其他案例涵蓋時才可合併；截圖變少本身不是改善證據。

以版面斷言檢查 overflow、幾何與必要控制項可見性，保留必要截圖供視覺檢視，使用穩定案例 ID／名稱。本次不加入容易受機器差異影響的 pixel baseline。等待可觀察狀態／主題 ready 及必要 frame 觀察後才截圖，不使用通用固定 sleep。依賴 active focus 的視覺狀態保留 activation-span 判定。

沿用 059 驗證過的 reset，避免每個矩陣格都重啟 App。預設證據模式保留 failure trace 與必要截圖，完整診斷 tracing 另行選取。截圖／trace 失敗時保留先前結果與正確 fail／blocked 分類。

## 命令與報告設計

以下新增命令在實作前都屬提案。以 `pnpm acceptance:settings:playwright` 執行新 suite，暫時提供 `pnpm acceptance:settings:legacy` 做等價比較／回退。兩者需要既有 build，比較時只 build 一次，再以相同 artifact 依序執行兩個 driver。

完整等價與效能驗證後，既有 `pnpm acceptance:settings` 委派給新 runner，保留 `--out` 與 0／1／2 結果語意。`pnpm acceptance:regression` 維持一次 `pnpm check`、一次 Settings suite、既有快捷鍵整合，不巢狀重複 build。

變更報告路徑／schema 前盤點 consumer。保留穩定案例 ID、部分結果、未執行原因、artifact／版本 manifest、activation spans 與 cleanup 證據；JSON／Markdown 報告區分 assertion failure、blocked 與 cleanup 缺陷。沿用 058 的程序 ownership 保證。

## 實作

- [ ] 完成視覺覆蓋對照，以版面斷言與必要截圖遷移語言／主題／尺寸／狀態矩陣。
- [ ] 執行完整新 Settings suite，檢查雙語截圖，確認全部行為與視覺覆蓋 ID 有對應。
- [ ] 依 058 的時間／證據契約比較等價新舊完整 Settings，先各跑一次；有未解釋退步或接近門檻才做有界成對比較。
- [ ] 保留參數／報告契約切換預設命令，驗證完整 regression 與 wrapper 變更影響的失敗／timeout／中斷／cleanup。
- [ ] 最終門檻通過後移除 legacy driver／斷言與暫時 legacy 命令，保留共享 bootstrap 及獨立必要 fixture；記錄 legacy revision 與證據作為回退參考。
- [ ] 更新中英測試／工具／貢獻文件，說明實際命令、類型選取與已驗證 Electron／原生證據邊界。

## 驗證與完成條件

在最終版本執行 `pnpm acceptance:regression`，已包含 TypeScript、Vitest、build，不重複執行。檢查必要雙語截圖與完整覆蓋對照。驗證受影響 runner 失敗／cleanup 路徑，包括證據擷取失敗時保留先前案例。純測試工具變更不要求新 capture baseline；產品／OS／runtime 實際變更則依[測試政策](../docs/testing.md)加上相應檢查。

必要門檻：完整行為／視覺等價、安全／IPC 證據保留、零 cleanup 缺陷、沒有未解釋新增失敗。等價 legacy 證據下完整 suite 中位數不得退步超過 5%；初次比較不明確時，依 058 做成對量測。報告秒數與完整 regression 節省，說明試點 20% 目標是否在完整 suite 成本下仍成立。最終速度收益較小時須如實說明，包含用來支持採用的維護效益。

若視覺／reset／啟動成本導致未達門檻，修改實作或保留 legacy 預設 runner，不能只因試點通過就切換。回退恢復已記錄 runner/config revision，不需要產品 runtime 變更。成功切換後有需要時從該 revision 恢復 legacy runner，不永久維護兩份實作。

完成條件：預設命令只執行一次全部必要 Settings 覆蓋、完整 regression 與受影響故障路徑通過、截圖已檢視、結果／cleanup 契約正確、量測已記錄。不代表全面測試框架遷移。
