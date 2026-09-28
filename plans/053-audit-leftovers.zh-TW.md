# 053 — 第三輪稽核的遺留項目

[English](053-audit-leftovers.md) | [繁體中文](053-audit-leftovers.zh-TW.md)

狀態：已規劃。建立日期：2026-09-29。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

2026-09-29 以 `09bb4c3` 為基準做了第三輪稽核，在 main 的 `ba8b651`…`4740520` 修正了 20 項錄影、桌面、設定、工具與文件的問題。同一輪也發現下列六項，但沒有放進那一輪，因為每一項都需要那一輪拿不到的證據（原生鍵盤檢查、量測基準的決定、GitHub 上的實際執行、第二次啟動的檢查或通知送達），或會改變 log 契約。以下每一項都是以 `4740520` 的程式碼逐行確認，但都沒有重現。

- **動作按鈕執行時鍵盤焦點會掉。** [settings.ts](../src/renderer/settings.ts) 在群組儲存期間停用該群組的所有選項（`setDisabled(el, !group.enabled || !choice.enabled, Boolean(saving))`，第 202 行），連剛按下的按鈕也包括在內；[settings-model.ts](../src/main/settings-model.ts) 則在整個檢查期間停用「檢查更新…」（`enabled: state.kind !== "checking"`，第 239 行）。`choose()` 只替 `-retry` 與 `-recovery` 控制項恢復焦點（第 793 行，`a69ddff`）。因此用鍵盤觸發「檢查更新…」、「重試註冊快捷鍵」或「開啟通知設定…」後，焦點會落到頁面上，下一次 Tab 又從分頁列開始。依照本 repo 自己的前提（[桌面設計](../docs/zh-TW/system-design/desktop.md)：停用的元素無法保有鍵盤焦點），Chromium 會發生這個情況；happy-dom 不模擬焦點修正，所以尚未驗證。
- **Frame cadence 用自己的百分位數算法。** [frame-cadence.mts](../scripts/lib/frame-cadence.mts) 以私有的線性內插 `quantile`（第 32 行）計算 p05 與 p95，但 [stats.mts](../scripts/lib/stats.mts) 說明所有量測工具共用 nearest-rank 百分位數，讓每份報告的「p95」意義相同。所以 `diagnose:cadence` 的 p95 和 `measure:cpu`、`measure:finalization` 的 p95 不同；中位數則一致。改用共用算法會改變報告數字，因此需要先決定和既有 cadence 報告的可比性。
- **只改網站的 pull request 沒有任何 CI。** [check.yml](../.github/workflows/check.yml) 在 push 與 pull request 都忽略 `website/**`，[website.yml](../.github/workflows/website.yml) 沒有 `pull_request` trigger。網站測試、`astro check` 與建置要到合併進 main 後，才第一次在 Vercel 正式建置中執行；`scripts/lib/release-manifest*.mts` 的網站測試也一樣。[CONTRIBUTING.md](../CONTRIBUTING.md) 說每個 pull request 都會執行 `pnpm check`，這句話正確，但容易讓人以為涵蓋完整。
- **第二次啟動沒有任何反應。** [index.ts](../src/main/index.ts) 沒有 `second-instance` handler，[permission.ts](../src/main/permission.ts) 的 macOS `activate` listener（第 140 行）只會查詢權限。App 執行中再開一次（例如選單列圖示被瀏海或擁擠的選單列擋住的使用者會這樣做）看不到任何回應；設定快捷鍵是唯一的其他入口。
- **錄影開始時的通知可能被靜音。** 解析度上限警告與降幀通知在 `captureStarted` 時顯示（[index.ts](../src/main/index.ts) 第 617、623 行），這時螢幕正在被分享。[儲存通知時序紀錄](../docs/zh-TW/verification/history-2026-09.md#儲存通知時序2026-09-20)顯示 macOS 在擷取期間判定 `resolutionReason: display shared`、`muted by DND suppression`，這也是儲存通知要等擷取結束的原因。解析度上限警告另外會保留在設定中；降幀除了 log 之外沒有其他呈現。[tray.ts](../src/main/tray.ts) 的 `notifyCaptureWarning`（第 260 行）也把標題寫死為 `"RecordStuff"`，沒有使用 `APP_NAME`。
- **收尾計時 log 少了 sentinel checkpoint。** [recorder.ts](../src/main/recorder.ts) 的 `finalize` 在 `writer.finish()` 之後、`saved` 之前呼叫 `sentinels.complete`（第 938 行），它會讀取 sentinel 並以含 fsync 的原子寫入重寫，但 `logFinalizeTiming` 沒有這一段的欄位。因此 `userData` 所在磁碟慢時，「儲存中…」會變長卻沒有紀錄，而 [finalization-timing.mts](../scripts/lib/finalization-timing.mts)（`TIMING`，第 37 行）解析的分段加總也無法等於 stop-to-ready。這行 log 是腳本契約，所以 recorder 與 parser 必須一起修改。

不在範圍內：[052](052-runner-process-safety.zh-TW.md) 的 runner 項目；第二輪稽核後維護者沒有排入的遺留項目（`compareVersions` 的 pre-release 排序、重複的 `PermissionStatus` 型別、`isCaptureControl` helper、網站字型 preload 與顏色 token）；新功能。

## 實作契約

- [ ] **執行中的動作保留焦點。** 忙碌中的動作按鈕仍可取得焦點：比照失敗紀錄列的動作，維持 `aria-disabled="true"` 與 `saving-disabled` 外觀，在其請求執行或檢查進行期間忽略觸發；真正無法使用的選項仍是 `disabled`。請求結束後，焦點留在使用者離開時的位置。這條規則適用於每個動作群組，不只「更新」。
- [ ] **統一百分位數定義，或明示例外。** 二選一：`cadenceStats` 改用 `stats.mts` 的 `percentileSorted` 與 `medianSorted`，並在工具文件註明從哪天起 cadence 的 p05／p95 採 nearest-rank；或在 `stats.mts` 與工具文件說明 cadence 百分位數採內插及原因。改變數字之前先與維護者決定。
- [ ] **網站 pull request 會被檢查。** 新增一個依路徑篩選的 job（放在 check.yml 或 website.yml），在修改 `website/**`、`scripts/lib/release-manifest*.mts`、`src/shared/version.ts` 或該 workflow 的 pull request 上執行：以 frozen lockfile 安裝、網站測試、`astro check`、離線建置與離線連結檢查。不需要 secrets。CONTRIBUTING（兩種語言）說明哪個 workflow 涵蓋網站。
- [ ] **第二次啟動會開啟設定。** 處理 `second-instance`（macOS 上另含從 Finder 或 Dock 重新開啟時的 `activate`），透過 `handleAction("openSettings")` 開啟設定，讓同一個退出關卡與視窗重用規則生效。通知點擊與權限查詢不得開啟設定；選定 listener 之前先確認 macOS 實際送出哪些事件。
- [ ] **錄影開始時的提示送達使用者。** 比照 `SavedNotification`，把降幀與解析度上限通知保留到擷取結束；或把降幀顯示在設定中既有的擷取警告旁。螢幕被分享期間不顯示通知。`notifyCaptureWarning` 改用 `APP_NAME`。
- [ ] **為 checkpoint 計時。** `finalize` 量測 `sentinels.complete`，計時 log 新增 `checkpoint N ms`；`finalization-timing.mts` 解析它，仍接受沒有這個欄位的舊 log，測試涵蓋兩種情況。另外決定 sentinel 寫入已失敗的 session 是否略過 `complete`（否則每次存檔都會以 ENOENT 失敗並記下 "completion checkpoint failed"）；若略過，旗標必須反映最近一次寫入，而不是任何一次較早的嘗試。
- [ ] **文件。** 兩種語言：桌面設計（焦點規則、第二次啟動、錄影開始時的提示）、工具（cadence 百分位數、收尾計時欄位）與 CONTRIBUTING（網站 CI）。

## 驗證與排除

- [ ] 單元測試：用鍵盤觸發的動作按鈕在執行期間不是原生停用，且忽略第二次觸發；`second-instance` 只開啟設定一次，退出期間不開啟；錄影開始時的提示排隊到 session 結束後只顯示一次；收尾計時 log 與 parser 在有、無 `checkpoint` 時都正確；cadence 百分位數的選擇。
- [ ] `pnpm check`；若修改網站 workflow 或其輸入，另跑 `pnpm site:check`。
- [ ] 設定的鍵盤行為有變，所以跑 `pnpm acceptance:regression`，在 fixture 中對「檢查更新…」送真實的 Tab 與 Enter，並檢查忙碌狀態的截圖。第二次啟動：再次開啟剛建置的 App，觀察設定是否出現。錄影開始時的提示：在比上限大的螢幕上以解析度上限錄一段，觀察提示是否在存檔後出現。收尾計時：跑一輪 `pnpm measure:finalization -- --repeat 1`，報告中要看得到 checkpoint。每一輪桌面測試都遵守[桌面交接確認](../docs/zh-TW/testing.md#測試前確認桌面交接)。
- [ ] 網站 CI：只修改 `website/**` 的 pull request 在 GitHub 上顯示新 job 通過；這無法在本機驗證。
- [ ] 排除：擷取矩陣、長時間錄影與音訊保真度；擷取與編碼不變。

## 完成與證據處理

依照[共用測試政策](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。每一輪只有一個桌面操作者。還原所有改過的設定、關閉測試 UI、退出受測 App 並確認程序已結束。

- [ ] 分開記錄檢查與結果、範圍排除，以及必要但未驗證的案例。執行 `git diff --check`。
- [ ] 將耐久結論保存到雙語設計與驗證文件，更新兩份索引，然後移除本計畫與其譯本。沒有另外要求時，不 commit、push 或發布。

僅規劃階段的驗證：相對連結與錨點、指令名稱、雙語涵蓋與 `git diff --check`。
