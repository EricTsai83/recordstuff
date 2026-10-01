# 058 — Playwright Electron 基礎與試點

[English](058-playwright-testing.md) | [繁體中文](058-playwright-testing.zh-TW.md)

狀態：提案，依 [061](061-verification-iteration.zh-TW.md) 瓶頸決策判斷是否執行。相依：061 驗證成本拆解與 recipe，重用量測邊界而不重複 instrumentation。本計畫取代原 058 的基礎與試點部分；後續為 [059 — 行為測試遷移](059-settings-playwright-behavior.zh-TW.md)、[060 — 視覺覆蓋與流程切換](060-settings-playwright-cutover.zh-TW.md)。

## 問題與範圍

Settings fixture 把建立狀態、輸入、斷言與截圖放在一個長回合。固定等待與自製座標操作可能浪費時間，也讓失敗較難診斷。先建立小型 Playwright Test 試點，確認相容性、等價證據與實測效益，再遷移完整 suite。

靜態評估基於 revision `1108b031a317a1a2e12e1567c7edc34d1529cddf`；實作前重新確認來源及 locked Electron/Node 版本。Vitest 負責邏輯／DOM，既有原生驗收確認 OS 行為。本計畫僅變更測試工具；產品 runtime、Electron 升級、網站測試與其他驗收 runner 不在範圍內。

## 設計

| 元件 | 職責 |
| --- | --- |
| 提案 `playwright.config.ts` | 只選 Electron specs；`workers: 1`、關閉 full parallelism、`retries: 0` |
| 提案 `tests/electron/*.spec.ts` | 試點輸入與斷言；不進入 Vitest 的 `.test.ts` include |
| 提案 `tests/electron/support/` | 有型別的 Electron 啟動、page 選取、狀態控制與證據 fixture |
| 提案 `scripts/acceptance-settings-playwright.mts` | 環境、桌面狀態、有界執行、判定與 owned-process cleanup |
| 測試專用 Settings bootstrap | 載入正式 `out/renderer/settings.html`、`out/preload/settings.js`；提供受控 main-process IPC 與 save gate |

採用固定且實際驗證過的 Playwright 開發相依及既有 pnpm lockfile。使用專案 Electron executable，不需要其他瀏覽器引擎。明確將 config/support/specs 納入 typecheck，保持 renderer 不使用 Node API 的型別邊界。

從 `scripts/fixtures/settings-panel.ts` 抽出最小可重用 bootstrap，維持 legacy suite 可執行。測試控制放在 fixture main，不進入出貨 bundle 或 `window.settings`。保留 CSP、sandbox、context isolation、Node isolation 與 web security。以 URL 和 readiness 選 Settings，不假設第一個視窗就是它。保留 native-theme 傳遞，避免 browser 模擬覆寫跟隨系統主題。

使用 role/label locator 或既有穩定 ID，以及實際 Chromium 滑鼠／鍵盤輸入。DOM evaluation 用於幾何、節點身分與診斷。同步 sleep 改為可觀察 readiness 或有界斷言，保留刻意的故障延遲與觀察區間。用確定性 gate 暫停並檢查瞬間狀態，避免重試斷言只看到之後的穩定狀態。teardown 釋放所有 gate。

保留 `scripts/lib/settings-activation.mts` 的 activation-span 判定；元素可操作、DOM focus 都不代表 macOS activation。保留鎖屏偵測與未執行原因。runner 維持 0 = pass、1 = fail、2 = blocked；不能只用 Playwright skip 代表 blocked。cleanup 缺陷獨立報告，即使該輪 blocked 也須揭露。

正常 teardown 關閉 owned Electron App，再確認 main/helpers 退出。只有證明 Playwright 啟動的 descendant 留在 owned process group 後，才能直接重用 `runIsolatedProcess`；否則加入經驗證的程序樹 ownership tracking。失敗清理須有界，不得影響其他 Electron 程序。截圖／trace 前先保存部分案例結果，避免證據擷取失敗抹除先前結果。

自訂 fixture 明確管理 `electronApp.context()` tracing，不能假設標準 `{ page }` tracing 設定會涵蓋它。結果、耗時、錯誤、activation spans、必要截圖與 cleanup 存於 `docs/verification/measurements/` 的唯一資料夾。驗證 failure trace 保存，包括 renderer crash 前後可取得的證據。量測預設證據模式，完整 tracing 可另作診斷選項。

## 實作

- [ ] 盤點試點案例，將等待分類為同步、故障注入或觀察；分配穩定覆蓋 ID，對照斷言、輸入、IPC／安全邊界及語言／主題／尺寸格。
- [ ] 新增測試相依、typecheck/config、最小 bootstrap、外層 runner 與自訂 Electron fixture。新增提案命令 `pnpm acceptance:settings:playwright`，可選試點，需要既有 build；實作前命令不可用。現有預設命令繼續執行 legacy suite。
- [ ] 驗證 locked runtime 啟動、參數解析、page 選取、產品安全設定、IPC 與 native theme。官方 Electron 支援仍是 experimental，不為啟動 driver 弱化產品安全或變更 fuse（[Electron API](https://playwright.dev/docs/api/class-electron)）。
- [ ] 依案例使用實際 runner drill 或 controlled test，涵蓋正常退出、assertion failure、timeout、中斷、啟動失敗、renderer crash、截圖／trace 失敗、鎖屏／activation 分類；確認 owned-process 退出、資料隔離與部分結果保存。
- [ ] 建立代表性的啟動／安全、分頁鍵盤導覽、儲存成功／拒絕、暫停儲存遇到舊 push、一個歷史／失敗操作、依賴 activation 的焦點案例；涵蓋雙語與代表性的 light/dark 最小尺寸格。
- [ ] 在完全相同且未變更的 App artifact、機器與證據設定上比較新舊等價試點；記錄相依／artifact manifest 與各階段耗時。

## 量測與採用門檻

分別量測啟動、fixture 編譯、互動、截圖／報告、清理。另記 `pnpm check` 與完整 regression 耗時，不能把 UI 節省當成相同比例的整體節省。整體收益取決於遷移層占總時間的比例與實測節省，須包含新增成本。

以 061 已改善的驗證 recipe 為 baseline，避免把 orchestration 節省算成 Playwright 成果。每個 driver 暖身一次，再做五組交替成對量測，關閉 retries。失敗／blocked 嘗試與原因分開記錄，blocked 不算 pass。報告有效耗時的中位數／最大值、首次結果與 cleanup。每個 driver 五次樣本無法建立精確 p95 或罕見 flake 比率；未解釋失敗或接近門檻時，做有界追加比較與診斷。

目標：等價證據下試點中位數降低至少 20%。必要採用條件：覆蓋／安全／IPC 保留、沒有新增未解釋失敗、零 cleanup 缺陷。未達速度目標時，可因可重現的診斷改善或移除自製互動／報告機制採用，但中位數退步不得超過 5%，並明確標為維護效益。兩種門檻都未過，保留 legacy driver，改做針對性等待改善。拒絕試點後不進入 059／060。

## 驗證與完成條件

依[測試政策](../docs/testing.md)執行相關工具測試、`pnpm typecheck`、載入 `out/` 前 build、試點成功／失敗／清理路徑；共享 fixture 變更後執行 legacy Settings 驗收，檢查試點截圖。若引入產品／runtime 變更，另加其影響檢查。

完成條件：相容性、證據與程序 ownership 已驗證，試點有採用或拒絕結論。已完成計畫移除前，將共用設計契約與結果保存至耐久文件，供 059 使用。交付為可執行試點、覆蓋對照、量測結果與已驗證 harness；完整 Settings 遷移及預設命令切換交給後續計畫。
