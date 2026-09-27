# 049 — CPU 預算：待機與錄影

[English](049-cpu-budget.md) | [繁體中文](049-cpu-budget.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-28。排在 [048](048-menu-and-settings-order.zh-TW.md) 之後、[035](035-guided-native-acceptance.zh-TW.md) 之前，035 仍在最後。本計畫與 045–048 沒有相依，可以在任何時間點執行；提早執行可讓 047 與 048 在「設定視窗開啟」情境下有比較基準。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

維護者於 2026-09-28 要求一份計畫，確保 RecordStuff 在選單列待機時的 CPU 使用率夠低；同一天又要求錄影時的 CPU 也要對照正常範圍檢查，並以 Cap 的做法為參考，把這些指標加入本計畫。

目前已有的：

- **待機：沒有。**`pnpm check` 看不到整個 App 持續在跑的東西，也沒有任何 runner 對待機中的程序取樣。
- **錄影：`pnpm matrix`。**它在每個案例錄影期間，每秒取樣開發用 Electron.app 所有程序的 `ps` `%cpu`，捨棄前三個樣本；若加總平均超過單一核心的 40%，該案例失敗（[門檻](../docs/zh-TW/system-design/tooling.md#驗收門檻)）。參考機 M1 Pro 的紀錄（[歷史](../docs/zh-TW/verification/history-2026-09.md#已取得的結果)）：1080p30 標準畫質錄十分鐘平均 17%、峰值 21%；60 fps 約 23%；系統硬體編碼器 VTEncoderXPCService 在編碼時約 1.4–1.9%。

錄影檢查有五個缺口。矩陣只在影格時序、解析度、影格率與音訊變更時才需要執行，而 `pnpm acceptance`（打包後 App 的錄影冒煙測試）完全不量 CPU。它量的是開發用 Electron.app，而不是 RecordStuff.app。macOS 的 `ps` 回報的 `%cpu` 是最長一分鐘的衰減平均，會抹平尖峰，也會把啟動負載帶進最初的樣本。系統輔助程序替 App 做的工作沒有顯示。而 40% 約是實測值的兩倍，所以只有用量翻倍才會失敗。

依目前原始碼，待機時在跑的東西：

- **程序。**主程序，以及 Electron 的 GPU 與 utility helper。設定視窗關閉時沒有任何 renderer：擷取用的隱藏視窗與倒數 overlay 在狀態回到穩定時都會銷毀（[index.ts](../src/main/index.ts)）。
- **計時器。**[PermissionWatcher](../src/main/permission.ts) 每 5 秒輪詢一次 `getMediaAccessStatus('screen')`，設計上是低成本的呼叫。擷取程序的 5 秒 ping 與寫檔的 fsync 計時器只在錄影期間存在。[更新檢查](../src/main/updates.ts)在啟動時執行，一天最多一次。
- **只有事件監聽。**螢幕變更、電源休眠與喚醒、全域快捷鍵與選單列點擊，只在事件發生時喚醒 App。
- **設定視窗若保持開啟。**一個閒置的 renderer，唯一的動畫是錄快捷鍵時的聆聽指示。

本計畫為兩種狀態訂定預算，新增一個由新 runner 與矩陣共用的 CPU 取樣器，以及在 `pnpm check` 中抓出殘留計時器的單元測試。只最佳化量測發現的問題。範圍外：記憶體上限（只回報，不設預算）、電池續航量測（`powermetrics` 需要 root），以及 Windows。

## Cap 參考

依固定 revision `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`（靜態原始碼檢視，未執行 Cap）。Cap 對 CPU 量得很仔細，但只在開發工具中：沒有任何 CI 工作或發布出去的程式碼會量 CPU，也沒有任何 CPU 數字會讓測試失敗。

- **外部的逐程序取樣器。**它的 macOS harness 會編譯一支小型 C 程式，每秒[對每個程序讀取 `proc_pid_rusage`](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/scripts/instant-mode-process-sampler.c#L101-L131)（CPU 時間、能耗、閒置與中斷喚醒等），加總 Cap、其 WebKit 輔助程序與子程序，並在[程序集合改變時把該階段標為無效](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/scripts/instant-mode-performance-macos.py#L466-L521)。每個階段（包括待機）以多次重複的中位數回報，而且[不把 macOS 共用的編碼與相機服務算在 Cap 頭上](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/scripts/instant-mode-performance.md#L96-L99)。
- **只有參考標籤，沒有門檻。**它的 profiler 會印出[低於 5% 為極佳、低於 15% 為良好、低於 30% 為中等](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/recording/examples/instant-mode-profile.rs#L82-L117)這類分級，並以所有核心平均計算，在多核心機器上相當寬鬆。它的測試 harness 真正強制的限制是[掉幀、影格率、延遲與影音同步](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/cap-test/src/config/types.rs#L204-L239)，每週的[效能工作流程](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/.github/workflows/performance-regressions.yml#L3-L15)也只測播放與匯出。
- **一個值得知道的 CPU 數字。**它在 M4 Max 上的編碼器 benchmark 量到：[經 VideoToolbox 零複製路徑每個 1080p30 影格約 763 µs CPU，退回 libx264 時每個 4K60 影格約 45 ms](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/recording/FINDINGS.md#L497-L505)，約為單一核心的 2.3% 對上約 270%。失去硬體路徑是數量級的跳升，不是小幅漂移。
- **待機完全沒有。**沒有任何待機或能耗目標，而且發布的 App [在整個生命週期中每 60 秒記錄一次記憶體](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/lib.rs#L727-L759)，這個計時器在待機時也持續觸發。

採用：讀取 `proc_pid_rusage` 的外部逐程序取樣器、在 CPU 之外一併記錄喚醒與能耗、捨棄程序集合改變的量測區間、以多次重複的中位數建立基準，以及把系統編碼服務與 App 分開回報。不採用：沒有門檻的標籤、以所有核心平均的百分比，以及在發布的 App 內加入任何監測計時器，因為它本身就會喚醒待機中的 App。Cap 的 2.3% 只涵蓋原生管線中的編碼器，所以不能當成 RecordStuff 整條 Chromium 管線的目標。

## 合理範圍

CPU 以單一核心的百分比表示，與「活動監視器」相同；參考機 M1 Pro 有十個核心，所以整台機器是 1000%。Wake-ups 是每秒計時器觸發次數，即「活動監視器」的「閒置喚醒」。這些數字適用於參考機；換一台機器時，要先建立該機器的基準，再判讀結果。

| 狀態 | 合理 | 測試門檻（初始目標） | 原因 |
| --- | --- | --- | --- |
| 待機，設定視窗關閉 | 約 0–0.2%，每秒幾次喚醒 | 平均 ≤ 0.2%，每秒樣本的第 95 百分位數 ≤ 1%，喚醒總計每秒 ≤ 5 次 | 沒有事情要做。Apple 的[能源效率指南](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)指出計時器會讓 CPU 無法閒置，App 應以回應事件取代輪詢；RecordStuff 唯一的週期性工作是每 5 秒的權限輪詢，每秒 0.2 次喚醒。高於此值的部分，若不是基準量測到的 Electron 下限，就是洩漏 |
| 待機，設定視窗開在其他 App 後方 | 低於 0.5% | 平均 ≤ 0.5% | 一個沒有動畫在跑的閒置 renderer |
| 錄影後 | 回到待機範圍 | 儲存後 30 秒內符合待機門檻，且程序與啟動後相同 | 殘留的計時器、renderer 或編碼器會在這裡現形 |
| 錄影，30 fps | 約 15–25% | 平均 ≤ 30%；在新基準確認 30% 之前，超過 40% 才失敗 | 擷取與 H.264 編碼由硬體執行；App 自己的部分是 Chromium 媒體管線、AAC 音訊、IPC 與寫檔。實測平均 17%、峰值 21% |
| 錄影，60 fps | 約 20–35% | 平均 ≤ 40% | 影格加倍，但固定成本不會加倍。實測約 23% |
| 錄影時的硬體編碼器 | VTEncoderXPCService 存在，約幾個百分比 | 只回報，不判定 | 若它不存在而 App 自己的 CPU 偏高，懷疑退回軟體編碼；在 Cap 的 benchmark 中，軟體編碼每個影格的成本是硬體路徑的數十倍 |

錄影案例的平均值若比同一台機器、同一設定的已記錄基準高出 25% 以上，即使仍在門檻內也會標記待調查，因為寬鬆的上限可能藏住退步。它是警告而非失敗，因為 CPU 在不同回合之間會漂移。

## 實作約定

- [ ] **待機計時器盤點。**列出 main 中每個 interval、timeout 與監聽器，以及它們是否可能在待機時執行；並新增單元測試，確認 session 結束後不留下任何計時器：Recorder 在儲存、失敗與取消後（以假計時器確認沒有待執行的計時器）、擷取程序在 teardown 與 destroy 後（ping interval 已清除）、寫檔器在 close 與 abandon 後（fsync interval 已清除），以及倒數 overlay 在 close 後。PermissionWatcher 是唯一預期存在的 interval，其測試確認恰好有一個依其間隔執行的計時器。這些測試在 `pnpm check` 中執行，所以洩漏會在任何原生回合之前就失敗。
- [ ] **共用 CPU 取樣器。**`scripts/lib/` 下一個僅供開發用的模組，參考 Cap 的 harness：以 Command Line Tools 的 `clang` 把一支小型 C 輔助程式編譯到該次量測的輸出資料夾，每秒對每個程序讀取 `proc_pid_rusage`：奈秒級的 CPU 時間、閒置與中斷喚醒、能耗與常駐記憶體。`ps` 的 CPU 時間只精確到百分之一秒，對待機的一秒來說太粗（0.2% 只有 2 ms）。模組每次取樣都重新解析 App 的主程序及其所有子程序，也能追蹤程序樹以外的指定系統輔助程序，例如 VTEncoderXPCService，並回報每個程序與總計的平均、第 95 百分位數與最大值。若某個判定區間內 App 的程序集合改變（錄影開始與結束的預期變化除外），該區間會被捨棄並記錄在報告中。沒有 Command Line Tools 時，CPU 量測屬於 blocked，而不是略過。其解析、程序樹解析與統計以錄下的樣本測試。
- [ ] **`pnpm measure:cpu`。**僅供開發、只在 macOS 執行的 runner，使用新的 `pnpm start:app` bundle。若已有其他 RecordStuff 在執行就拒絕開始；啟動 App 後，等待 log 顯示進入待機且啟動工作已完成（失敗紀錄已載入、更新檢查已結束或略過）。依序執行的情境：
  - **A．啟動後待機，**設定視窗關閉：暖機 60 秒後量測 5 分鐘。
  - **R．錄影：**像 `pnpm acceptance` 一樣，以錄影快捷鍵開始並停止一段 60 秒的錄影；被錄的螢幕上播放會動的測試素材，倒數設為關閉、畫質設為標準 30 fps，結束後全部還原；以第 5 到 55 秒判定，並追蹤 VTEncoderXPCService。`--fps 60` 會再加一段 60 fps 的錄影，`--repeat N` 會重複錄影情境。
  - **B．錄影後待機：**儲存後 30 秒開始量測 5 分鐘，並與 A 的程序集合比較（沒有殘留的 renderer，VTEncoderXPCService 已結束）。
  - **C．設定視窗開啟**並位於其他 App 後方：量測 3 分鐘。

  選項：`--minutes`、`--fps 60`、`--repeat N`、`--skip-recording`、`--skip-settings` 與 `--out`。報告以 Markdown 與 JSON 寫入 git 忽略的 `docs/verification/measurements/<time>-cpu/`，內容包括每個情境相對上述門檻的 CPU、喚醒與能耗、被捨棄的區間、各程序明細與程序清單、記憶體，以及機器、macOS、Electron、螢幕與電源資訊。與其他 runner 一樣，它會宣告使用者活動、在執行期間持有螢幕與閒置睡眠的 assertion、還原它改過的設定、正常結束 App，並確認其程序已結束。
- [ ] **矩陣改用共用取樣器。**`pnpm matrix` 以共用取樣器取代 `ps` `%cpu` 取樣，仍捨棄前三秒，為每個案例加上第 95 百分位數與 VTEncoderXPCService 數字；在第一次基準確認後，以上述依影格率區分的門檻取代單一的 40%，並依該案例上次記錄的基準顯示 25% 退步警告。
- [ ] **把預算寫入工具指南。**上述門檻以初始目標寫入[量測門檻](../docs/zh-TW/system-design/tooling.md#驗收門檻)。由新取樣器的第一次基準量測確認每個目標，錄影數字取三次重複的中位數，因為錄影 CPU 在不同回合之間會漂移：只有在基準量測有餘裕地通過時才保留該目標。基準量測未通過某個目標，代表有問題要調查，而不是在沒有書面證據與維護者同意的情況下放寬目標的理由。17%、21% 與 23% 來自開發用 Electron.app 上 `ps` 的衰減平均，所以新基準是取代它們，而不是與它們比較。
- [ ] **修正基準量測發現的問題。**若某個目標未通過，依各程序明細找出程序與原因，必要時使用 `sample` 或 Instruments，然後修正，或在維護者決定後記錄下來。每 5 秒的權限輪詢是已知的週期性喚醒來源；只有在有證據顯示它有影響時才修改，因為在沒有視窗開啟時，App 靠它發現權限被撤銷。
- [ ] **文件。**同步更新雙語文件：工具指南（取樣器、`pnpm measure:cpu`、其情境、門檻、如何閱讀報告，以及 CPU 量測需要 Command Line Tools）、[測試政策](../docs/zh-TW/testing.md)（新增一列：新增計時器、輪詢、監聽器、會持續存在的視窗、選單列變更與 Electron 升級時，需要 `pnpm check` 加上 `pnpm measure:cpu`；Electron 升級後要重新建立基準；本來就需要矩陣的變更，也要看矩陣的 CPU 數字），以及在[設計總覽](../docs/zh-TW/system-design/design-overview.md)加入一段待機行為說明，列出待機時允許執行的東西。在驗證歷史中記錄基準量測。

## 驗證與排除

- [ ] `pnpm check`：計時器測試，以及以錄下的樣本測試取樣器。
- [ ] 以新的 `pnpm start:app` bundle 執行一次 `pnpm measure:cpu -- --fps 60 --repeat 3`：待機情境各一次，兩段錄影各三次，以其中位數作為錄影基準。依測試政策，只有接近門檻的結果才重跑。另外測試 runner 在已有 RecordStuff 執行時會拒絕開始，以及中斷後的清理。
- [ ] 執行一輪 `pnpm matrix -- fps --repeat 3`（原始解析度、標準畫質，30 與 60 fps，各 15 秒），驗證矩陣改用新取樣器並以中位數建立其基準；矩陣的其他指標不變。
- [ ] 排除：記憶體預算、電池耗電、長時間浸泡測試（只有 5 分鐘待機結果接近門檻時才跑 30 分鐘）、參考螢幕以外的解析度，以及 Windows（只驗證 macOS）。不移交任何案例給 035：這些量測不需要維護者判斷。

## 完成與證據處理

依[共用測試政策](../docs/zh-TW/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占，因為錄影情境與矩陣會錄影並按下快捷鍵。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 參考是固定 revision 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
