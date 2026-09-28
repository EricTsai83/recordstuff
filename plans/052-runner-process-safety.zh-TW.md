# 052 — Runner 的 process 與環境安全

[English](052-runner-process-safety.md) | [繁體中文](052-runner-process-safety.zh-TW.md)

狀態：已規劃。建立日期：2026-09-29。佇列第一項，排在 053 之前。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

051 結案後，2026-09-29 以 `2088633` 為基準做了第二輪稽核，在 main 的 `ea86b99`…`7f1f3a8` 修正了 20 項 App、發布工具與網站的問題。同一輪也發現，好幾個桌面 runner 繞過了共用的 process 與環境 helper。修改 runner 流程時必須實際執行受影響的 runner，無法和那一輪一起驗證，所以維護者把這一組移到這裡。以下每一項都是以 `2088633` 的程式碼逐行確認，但都沒有重現。

- **`pgrep`／`pkill` pattern 沒有 escape Electron 路徑。** [run-matrix.mts](../scripts/run-matrix.mts)（`electronPids`、`electronMainPid`、SIGTERM 清掃與最後的 `pkill`）、[measure-finalization.mts](../scripts/measure-finalization.mts) 與 [diagnose-frame-cadence.mts](../scripts/diagnose-frame-cadence.mts) 直接把真實的 `Electron.app` 路徑放進 extended regular expression，而且各自的 `pgrep` helper 都不檢查結束碼。唯一的觸發條件是 checkout 路徑含有 regular expression 的特殊字元，例如 `~/Code (2026)/recordstuff`。這時括號比對不到括號本身，或是 pattern 不合法、以結束碼 2 回傳空輸出。兩種情況下「已經在執行」的檢查都會放行，`stopApp()` 找不到任何東西，runner 回報「every owned process exited」，但 Electron 其實還在執行。[processes.mts](../scripts/lib/processes.mts) 已經提供 `escapeRegExp`，以及會檢查結束碼的 `recordStuffPids`。
- **繼承下來的 Electron 環境變數會傳給開發版 App。** `run-matrix` 與 `measure-finalization` 用 `RECORDSTUFF_AUTORECORD` 啟動 `Electron.app` 之前，只刪掉 `ELECTRON_RUN_AS_NODE`。[runner-env.mts](../scripts/lib/runner-env.mts) 的 `scrubbedEnv()` 還會移除 `ELECTRON_RENDERER_URL`、`RECORDSTUFF_AUTORECORD` 與 `NODE_OPTIONS`。未打包的 App 會採用繼承來的 `ELECTRON_RENDERER_URL`，Electron 會採用 `NODE_OPTIONS`，而 VS Code 的 JavaScript Debug Terminal 會設定後者。[acceptance-controlled.mts](../scripts/acceptance-controlled.mts) 自己手抄了一份不含 `NODE_OPTIONS` 的清單；[acceptance-updates.mts](../scripts/acceptance-updates.mts)、[acceptance-runtime.mts](../scripts/lib/acceptance-runtime.mts)、[audio-quality-tools.mts](../scripts/lib/audio-quality-tools.mts) 與 [cpu-sampler.mts](../scripts/lib/cpu-sampler.mts) 都只刪 `ELECTRON_RUN_AS_NODE`。
- **共用的 RecordStuff pattern 又被重寫了好幾次。** `processes.mts` 說每個 runner 都會經過它，但 `recordStuffPids` 沒有任何呼叫端。`acceptance-controlled`、`acceptance-updates`、`acceptance-hotkey` 與 `measure-cpu` 各自內嵌同一個 pattern；後兩者少了 `(^|/)` 錨點，`measure-cpu` 也不理會 `pgrep` 失敗。`diagnose-frame-cadence` 與 `measure-finalization` 使用比較寬鬆、點號也沒有 escape 的 `RecordStuff.app/Contents/MacOS/`。[controlled-acceptance.mts](../scripts/lib/controlled-acceptance.mts) 的 `bundleProcessPattern` 重複了 `recordStuffPattern(bundleDir)` 的工作，但少了 `^` 錨點。
- **`measure:finalization` 在 build 中被中斷時以 1 結束。** Runner 先註冊 SIGINT／SIGTERM handler，再用阻塞的 `spawnSync` 執行 build。按 Ctrl-C 會結束 pnpm，`status` 變成 null，`process.exit(built.status ?? 1)` 會在排隊中的 handler 之前執行。這與文件寫的 130／143 不符，而且只對 runner 送 SIGTERM 也停不了 build。`run-matrix` 已經改成在獨立的 process group 裡非同步 build，並在收到訊號時停止它。
- **固定路徑的素材 profile。** `run-matrix` 與 `measure-finalization` 共用 `$TMPDIR/recordstuff-material-profile`，`diagnose-frame-cadence` 使用 `recordstuff-cadence-material-profile`，三者都不會刪除它。共用的那個會跨回合重複使用，2026-09-29 時裡面有 39 個項目。`measure-cpu`、`acceptance-hotkey` 與 `acceptance-updates` 已經用 `mkdtemp` 建立獨立的 profile 並在結束後刪除，這也是 [acceptance helper](../scripts/lib/acceptance.mts) 註解（「callers own the profile」）的預期。

不在範圍內：App、發布工具與網站的程式碼；新的 runner 功能；維護者沒有排入的其他稽核剩餘項目（`compareVersions` 的 pre-release 排序、重複的 `PermissionStatus` 型別、`isCaptureControl` helper、網站的字型 preload 與色彩 token）。

## 實作契約

- [ ] **單一 process 模組。** 把 Electron 路徑比對移進 `processes.mts`：一個以 `escapeRegExp` 建立的 `electronPattern(appPath, part)`，以及一個 `pgrepPids(pattern)`，遇到 spawn error 或 0、1 以外的結束碼就丟出錯誤（1 代表沒有 process）。`recordStuffPids` 也改用同一個 helper。上面列出的每個 runner 都改走這些 helper；刪除各自的 `pgrep` helper 與 `bundleProcessPattern`，原本的呼叫端改用 `recordStuffPattern(bundleDir)`。`pkill` 使用同一個 escape 過的 pattern。之後 `pgrep` 失敗會讓 runner 的 preflight 或清理明確失敗，而不是被當成「沒有東西在執行」。
- [ ] **單一啟動環境。** 每個啟動 Electron 或 App 的 runner 都從 `scrubbedEnv()` 開始，再加上自己負責的變數（`RECORDSTUFF_AUTORECORD`、fault point）。不再有 runner 自己維護變數清單。
- [ ] **可中斷的 finalization build。** `measure:finalization` 改用 `run-matrix` 的非同步、獨立 process group build，並由訊號 handler 停止它，讓 build 期間的 Ctrl-C 或 SIGTERM 在清理後以 130／143 結束。
- [ ] **自有的素材 profile。** `run-matrix`、`measure-finalization` 與 `diagnose-frame-cadence` 用 `mkdtemp` 建立 Chrome profile，並在清理時刪除。清理仍然要等素材瀏覽器結束，才能判定「every owned process exited」。
- [ ] **文件。** 中英文的[工具說明](../docs/zh-TW/system-design/tooling.md)（驗收清理與 runner 清單）說明：process 比對與啟動環境是共用的、`pgrep` 失敗會擋下該回合，以及 finalization runner 的中斷行為。

## 驗證與排除

- [ ] 單元測試：
  - `electronPattern` 與 `recordStuffPattern` 能照字面比對含有 `( ) [ ] + . $` 的路徑，且不會比對到相鄰的路徑。
  - `pgrepPids` 在結束碼 1 時回傳 `[]`，在結束碼 2 與 spawn error 時丟出錯誤。
  - `scrubbedEnv` 是每個 runner 啟動環境的唯一來源：若有 runner 檔案自己刪除變數，測試就失敗。
  - finalization runner 的中斷處理會把 build 期間的訊號對應成 130／143，並且執行清理。
- [ ] `pnpm check`。
- [ ] Runner 流程有改動，所以依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)後，在參考機上用同一個桌面回合把每個受影響的 runner 各跑一次：`pnpm matrix -- quick`、`pnpm measure:finalization -- --dir <tmp> --repeat 1`、`pnpm diagnose:cadence -- --runs 1`、`pnpm measure:cpu`、`pnpm acceptance` 與 `pnpm acceptance:updates -- --logic-only`；`pnpm acceptance:controlled` 跑一次 `pnpm acceptance:controlled -- selftest` 即可。
  - 每個 runner 都必須仍能找到、啟動並停止自己的 process，而且不留下素材 profile。
  - 從 VS Code Debug Terminal，或設定一個無害的 `NODE_OPTIONS` 值執行 `measure:finalization`，證明啟動的 App 沒有繼承它。
  - 分別在 build 期間與某次錄影期間中斷 `measure:finalization` 一次，記錄結束碼。
- [ ] 從路徑含有 `(` 與 `)` 的暫時 clone 執行一個 runner，證明它的 preflight 能看到該 clone 中已在執行的 Electron，而且清理時能停止它。
- [ ] 排除：完整的擷取 matrix、長時間錄影與音訊品質。擷取與編碼都沒有改變，所以上面的錄影只用來確認 runner 仍然能驅動它們。

## 完成與證據處理

遵守[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。每個回合只有一個桌面使用者。還原所有改過的設定、關閉測試 UI、結束受測 App，並確認 process 已經退出。

- [ ] 分開記錄檢查與結果、依範圍的排除，以及需要但未驗證的案例。執行 `git diff --check`。
- [ ] 把耐久的結論寫入中英文的設計與驗證文件，更新兩份索引，然後移除本計畫與其翻譯。沒有另外的要求時不 commit、push 或發布。

僅規劃階段的驗證：相對連結與錨點、指令名稱、中英文內容一致，以及 `git diff --check`。
