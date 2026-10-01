# 059 — Settings 行為測試遷移至 Playwright

[English](059-settings-playwright-behavior.md) | [繁體中文](059-settings-playwright-behavior.zh-TW.md)

狀態：提案，須 058 採用後才執行。相依：[058](058-playwright-testing.zh-TW.md) 已驗證 harness 與採用結果；058 拒絕採用則不執行。預設驗收命令切換由 [060](060-settings-playwright-cutover.zh-TW.md) 處理。

## 問題與範圍

將已驗證試點擴充到完整 Settings 行為測試，以可獨立選取的情境類型提供等價 IPC／輸入證據。本計畫不遷移視覺截圖矩陣，也不替換預設驗收命令。既有快捷鍵整合、原生 OS／capture 測試仍獨立執行。

## 覆蓋與隔離設計

將 058 的覆蓋對照擴充至目前全部 Settings 行為斷言，記錄穩定 ID、setup、輸入、預期中間／最終狀態、產品／受控邊界、activation 相依與替換案例。每個斷言須保留、等價替換或說明合理合併，測試總數不能證明等價。

| 類型 | 必要行為 |
| --- | --- |
| 啟動／安全／在地化 | 正式 page/preload、bridge 暴露、Node 隔離、初次讀取失敗與在地化回饋 |
| 控制項與 IPC | 儲存成功／拒絕、disabled 操作、真實 round trip 與狀態同步 |
| Pending／error／競態 | Busy、交錯請求、舊 push、暫停儲存、節點／焦點穩定與中間 frame 觀察 |
| 鍵盤／焦點 | Tab／方向鍵／Enter／Space、取消、blur、active-window 焦點框與從 owned window 返回 |
| 歷史／失敗 | 展開、確認、重試／移除、較晚更新、過期 mouse-down/up 與獨立項目 |

使用 058 的真實正式 renderer/preload、fixture IPC 與 typed main controls。正式 model／持久化斷言保留在既有測試；fixture handler 無法證明完整 production-main 整合。獨立快捷鍵 fixture 已驗證的註冊、恢復、crash／restart 持久化，維持原證據邊界。

同類型內重用 App 前，須驗證資料、請求、gate、listener、timer、window state reset。suite 若含生命週期／crash 案例，使用新 App。spec 應可獨立執行，也能改變類型順序，不依賴前一測試副作用。沿用 058 的 main/helpers cleanup 與 blocked 判定。

一般互動使用 locator action。disabled 控制項驗證 disabled 狀態，需要時才刻意使用低階輸入確認不投遞。保留過期 mouse-down/up 交錯。無閃爍、節點身分、焦點保留須在 held gate／frame 區間觀察，只檢查最終穩定 DOM 不足。可觀察等待只能在保留這些語意時替換。

## 實作

- [ ] 完成行為覆蓋對照，包含試點已有案例及保留於獨立 fixture 的案例。
- [ ] 將控制項／IPC、pending／error／競態、鍵盤／焦點、歷史／失敗遷移成可選取的 `.spec.ts` 類型；保留試點的啟動／安全案例。
- [ ] 實作明確 family reset 與 gate release，驗證獨立執行／順序變更，保留依賴輸入案例前後的 activation 證據。
- [ ] 比較一次新舊等價行為選集，診斷未解釋失敗或時間退步，包含 launch／reset／trace 成本。
- [ ] 060 切換前保留 legacy 完整 suite，提供遷移對照，讓 060 能移除過時行為 driver 而不移除視覺案例或共享 bootstrap。

## 驗證與完成條件

執行改動 helper 的相關測試與 `pnpm typecheck`。Electron fixture 前只 build 一次，再執行完整新行為選集與受影響 legacy 路徑。驗證變更的故障／輸入／reset／cleanup，檢查相關雙語截圖。共享 Settings fixture 變更後執行既有快捷鍵整合；OS／capture 行為未變更不增加錄影驗收。實際 diff 跨越這些邊界時，才依[測試政策](../docs/testing.md)增加檢查。

完成條件：全部行為覆蓋 ID 有對應、必要情境提供等價安全／IPC／輸入證據且通過、獨立執行已驗證，沒有未解釋新增失敗或程序殘留。若時間退步尚未釐清，依 058 方法比較行為中位數成本。預設命令與視覺矩陣仍可使用 legacy suite，這是交給 060 的明確輸入，不代表完整遷移已完成。
