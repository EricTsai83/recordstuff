# 驗證歷史 — 2026 年 10 月

[English](../../verification/history-2026-10.md) | [繁體中文](history-2026-10.md)

[返回驗證索引](README.md)。以下是歷史證據；現行選測規則見[測試指南](../testing.md)。原始 measurements 連結僅本機可用，新 clone 不會包含。

## Plan 061 結案 — 2026-10-02

Plan 061 量測 `pnpm check` 之後的驗收工作，並移除其中發現的重複執行。由 Claude 實作，Codex GPT-6.1 Sol review。只改了開發工具與文件，App 本身沒有改動。長期規則見[選定一次並對每個版本驗證一次](../testing.md#選定一次並對每個版本驗證一次)與[驗證配方與計時](../system-design/tooling.md#驗證配方與計時)。

- **計時。** [verification-timing.mts](../../../scripts/lib/verification-timing.mts) 讓每個 leaf 指令在自己的程序群組執行，每個階段記錄 monotonic 耗時、結果、exit code 與清理狀態。`pnpm start:app` 透過 `RECORDSTUFF_TIMING_FILE` 回報自己的 preflight、build、package、verify 與 open，這些時間顯示在所屬階段內，不重複計入。報告也記錄 revision、未提交內容的摘要、runtime 輸入、`out/` 與 `app.asar` 的摘要，以及工具版本。Agent 協作空檔與桌面交接等待記為 unknown。
- **配方。** `pnpm acceptance:recipe -- <check|settings|shortcut-registration|recording>` 跑的 leaf 檢查與它取代的組合指令相同，相同輸入只建置一次。單元測試確保每個配方與它取代的 package scripts 相同。
- **沿用 bundle。** `pnpm start:app` 在 bundle 旁記錄其 runtime 輸入；輸入改變時 `pnpm open:app` 會拒絕開啟。因此只改測試、腳本或文件之後的下一輪，可以重開已驗證的 bundle，不必重新建置。
- **量測中發現並修正的 runner 問題。** 第一次跑配方時，`pnpm acceptance` 在 `open` 返回後 0 秒就開始，結果拿前一個 App 的 log session（run `…-49210`）去判斷新的 pid 71654，送出開始鍵後以「the app restarted」中止。只有在 `start:app` 之後立刻開始的回合會遇到。Runner 現在最多等 30 秒，直到 log 最新 session 的 run id 以執行中的 pid 結尾、且該 session 已 idle。`sessionBelongsTo` 有單元測試。
- **指示稽核。** AGENTS.md 與測試規則原本就禁止重跑組合指令裡的 `check`，實作 skill 也只重跑受影響的檢查，沒有 skill 要求無條件全部重跑。測試規則現在明文規定任務內的驗證配方與證據作廢規則，AGENTS.md 引用它們；驗收 skill 允許在改動不會影響 bundle 時使用 `pnpm open:app`。

### `pnpm check` 之後的成本拆解

M1 Pro、macOS 26.6.2、Node 24.21.0、pnpm 10.33.4、Electron 44.3.0，版本為 `e1949be` 加上未提交的變更。每條路徑跑一次；這些是單次觀察，不是預算。

| 路徑 | 階段 | Wall time |
| --- | --- | --- |
| 純邏輯（`check` 參考） | typecheck／測試／建置 | 0.71–0.84 s／18.70–21.01 s／0.77–0.89 s；四次皆通過，wall 20.36–22.64 s |
| 設定修改（check 之後） | 設定 fixture，176/176 | 55.29 s |
| | 快捷鍵整合，三個 phase | 37.89 s |
| 註冊方式或 Electron 修改 | 鍵盤配置（注音），已還原為 ABC | 6.17 s |
| 建置／打包／簽章 | `pnpm start:app`：preflight／build／package／verify／open | 0.07／0.77／36.34／0.30／0.15 s（階段 37.70 s）；前一次 40.58 s，package 39.12 s |
| | 同一個 bundle 的 `pnpm open:app`：preflight／freshness／verify／open | 0.07／0.01／0.30／0.07 s（wall 0.66 s） |
| 錄影 | `pnpm acceptance`，10 秒錄影加取消案例 | 29.70 s |
| 播放 | 對同一檔案的 `pnpm acceptance:playback` | 14.33 s |
| 原生入口（`acceptance:settings-shortcut` 加 Computer Use） | — | 未量測；由 start:app（約 38 s）、上限 30 秒的 callback 和時間未知的觀察組成 |
| Agent 重複執行 | — | 未知；沒有可用的 session log 區間 |

已量測的 check 後成本排序：設定回歸 fixture 93.18 s；bundle 建置與簽章 37.7–40.6 s，幾乎都花在 electron-builder 打包；錄影回合 29.70 s；播放 14.33 s；鍵盤配置檢查 6.17 s。

### 修正前後對照（覆蓋範圍相同）

- **重建已驗證的 bundle**（確認過的過度執行）。這次之前，`pnpm open:app` 無法分辨 bundle 是新是舊，所以任何修改之後要再跑原生回合，唯一安全的做法就是重建。現在，改動不會影響 bundle 時，下一輪只要 0.66 s，而不是 37.7–40.6 s，每輪省下約 37–40 秒。重開的是同一個簽章 bundle，簽章驗證通過、runtime 輸入紀錄相符。會影響 bundle 的修改仍會要求重建。
- **重複建置**（確認存在）。`pnpm acceptance:regression && pnpm acceptance:shortcut-layout` 與 `pnpm check && pnpm start:app` 都會對相同輸入建置兩次，配方只建置一次。`pnpm build` 單獨執行三次為 0.75–0.78 s，作為階段時為 0.77–0.89 s，所以每條路徑省下不到 1 秒。確實存在，但和 fixture 相比可以忽略。
- **錄影。** 一次錄影同時提供開始／停止／存檔、媒體驗證、倒數證據、取消案例與播放檢查，沒有為了計時重錄。因 stale session 失敗的那一輪是真實缺陷，不是重複執行；修正後重跑的那一輪才是證據。

### 對 058 的影響

已量測的 check 後成本中，最大的是設定 UI 的兩個 fixture：每次設定修改 93 秒。這一輪兩者每個案例都通過，沒有觀察到不穩定。兩個 runner 都沒有拆出啟動、互動與截圖的邊界，所以換 driver 能省下多少比例仍是未知數。058 維持條件式：如果維護者決定進行，它的 pilot 要先把設定 fixture 的 55 秒拆成啟動、互動與截圖矩陣，再拿 Playwright pilot 和這份拆解比較。否則 058–060 延後，沿用現有 driver。

### 驗證

- **自動化。** `pnpm acceptance:recipe -- check` 通過四次：96 個檔案，測試數依序為 1390、1390、1396、1397，因為修正 review 時補了測試。聚焦測試涵蓋計時函式庫、配方、runtime 輸入、`start-app` 與 `sessionBelongsTo`；`git diff --check` 通過。第一次執行發現 `start-app.test.ts` 把配方的計時檔傳給它啟動的 start-app 程序，測試裡的執行因此被記成巢狀階段；現在每次執行使用自己的檔案，並斷言寫入的內容。
- **受控中斷。** 在測試階段送 SIGINT，以 130 結束：該階段記為 interrupted，build 未執行，沒有殘留 vitest。以受控程序的單元測試涵蓋通過、失敗、blocked exit 2、逾時、由子程序自行收尾的中斷、exit 0 後的強制清理，以及 App 清理。
- **桌面回合。** 回合開始前維護者回覆「好了」。`shortcut-registration` 以 122.10 s 通過：設定 176/176、快捷鍵整合 PASS、鍵盤配置 PASS 且輸入法已還原。`recording` 第一次因上述 stale session 失敗；修正後以 87.07 s 通過，錄到 10.2 秒 1920×1080、59.94 fps、10 次閃光與 10 次嗶聲，完整性與取消案例都通過。App 由 runner 自行退出，配方的 App 清理不需要動作。播放檢查的時長、尺寸、即時播放、跳轉、畫面變化與播放到結尾都通過。`pnpm open:app` 重開了 bundle，之後正常退出，bundle 的所有程序都已結束。
- **未執行。** 在真實桌面 runner 執行中中斷配方，以及配方自身對執行中 App 的清理；這兩項只由單元測試涵蓋。原生設定入口、Computer Use 觀察、聽感與擷取矩陣不在本 plan 範圍內。

Review：Codex GPT-6.1 Sol（medium reasoning、read-only），兩輪分別 148 秒與 82 秒。Pass 1 回報四項，全部接受並修正：

- 強制清理後的階段仍可能判為通過。
- `recording` 可能讓 `start:app` 開啟的 App 留著不退出。
- 插樁 workspace 會 import `scripts/fixtures`，runtime 輸入摘要沒有涵蓋。
- symlink 只雜湊目標路徑。

Pass 2 再回報三項，全部接受並修正，沒有再跑下一輪：

- App 清理沒有等 helper 程序。
- 中斷且清理不完整的階段回報 130/143，而不是失敗。
- 開頭的 identity 雜湊不在 wall time 內。

Hotkey runner 的修正發生在兩輪 review 之後，沒有經過 review。

收尾：沒有殘留的 RecordStuff、Electron fixture、素材瀏覽器 profile 或 QuickTime 程序。輸入法為 ABC。錄影與報告保留。任務期間有執行 `caffeinate -d -i -t 5400`。
