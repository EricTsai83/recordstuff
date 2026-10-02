# 驗證歷史 — 2026 年 10 月

[English](../../verification/history-2026-10.md) | [繁體中文](history-2026-10.md)

[返回驗證索引](README.md)。以下是歷史證據；現行選測規則見[測試指南](../testing.md)。原始 measurements 連結僅本機可用，新 clone 不會包含。

## Plan 063 結案 — 2026-10-02

Plan 063 讓原生 Tray、設定入口與通知文字案例可以用腳本完成，並寫明何時用 runner、何時用 Computer Use。由 Claude 實作，Codex GPT-6.1 Sol review。在此之前，驗收 skill 要求所有原生操作都透過 Computer Use，但它無法存取純 tray 的程序（`-10005 timeoutReached`），因此 Tray 案例只能等維護者或記為受阻，也沒有文件說明何時該改用腳本。耐久規則見[選擇規則](../testing.md#腳本-runner-或-computer-use)、[runner 對照](../acceptance.md#腳本-runner-或-computer-use)、[腳本化原生驗收](../system-design/tooling.md#腳本化原生驗收)與[設計決策](../system-design/decisions.md)。

- **選擇規則與決定。** 測試指南與驗收案例現在寫明：有已提交的 runner 涵蓋就用 runner，觀察與沒有 runner 的操作用 Computer Use，主觀判斷與需要密碼的步驟交給維護者，並把腳本輸入、Computer Use 觀察與人工證據分開標示。維護者於 2026-10-02 允許已提交的 runner 在記錄的限制內操作 RecordStuff 自己的 Tray 選單、設定視窗與選單項目（以路徑與 pid 比對受測 bundle；狀態列項目用右鍵而非 `AXPress`；不碰權限提示、TCC 或隱私權清單；不用全域 kill 或測試 hook）。
- **App 變更。** Tray 每次彈出選單時，都會記錄 `tray: menu opened in <state>: <json>`，內容就是交給 Electron 的選單，讓 runner 能把讀到的 NSMenu 和正式 model 比對。App 其他部分沒有改；`DEFERRAL_MESSAGE` 改為 export，讓測試把通知 runner 預期的文字綁定到它。
- **Runner。** 一個 JavaScript for Automation helper 透過 C API 讀取輔助使用，約 0.1 秒（同一個選單用 System Events 要 29 秒），並送出 CoreGraphics 事件。`pnpm acceptance:tray` 操作真正的狀態列項目；`pnpm acceptance:settings-shortcut -- --observe` 斷言設定視窗的啟用、焦點、Tab、最小化、還原、關閉與重開；`pnpm acceptance:quit-dialog` 新增從通知中心讀取的橫幅文字層。驗收 skill 現在先選定並執行這些 runner，Computer Use 留給截圖的視覺判讀與沒有 runner 的操作。結案時，維護者決定讓它不限定執行者，並把名稱從 `astra-acceptance-with-computer-use` 改為 [`native-acceptance`](../../../.agents/skills/native-acceptance/SKILL.md)：任何能執行指令並看得到截圖的 agent（例如這次的 Claude）都能執行 runner，並自己判讀 `screencapture` 截圖；只有需要即時 Computer Use 操作時才委派 Codex GPT-6 Astra。
- **在真實桌面上發現的問題。** macOS 26 的狀態列項目位於控制中心的視窗中。`REC` 讓項目變寬後，1080 pt 直式螢幕上的那一份被前景 App 的選單擠掉（視窗不在畫面上），AX 卻仍回報它的 frame，因此第一輪的錄影選單始終沒有打開，錄影進行了約三分鐘，才以快捷鍵停止並存檔。現在 driver 在回報的那一份被隱藏時，改點主選單列上以 bundle identifier 命名、正在顯示的視窗。改把點擊直接送給程序（以 `CGEventPostToPid` 送給 RecordStuff 或控制中心，四種變化）時游標不動，但選單一次都沒有打開，所以點擊會移動真正的游標，每輪都需要桌面交接。第二輪找出三個 runner bug，在通過的那一輪之前已修正：巢狀的選單案例把它正在讀的倒數收尾掉了；結束後還在等一個已經讀不到的選單；繁體中文的未讀失敗只比對前綴。彈出選單的鍵盤導覽在 CoreGraphics 輸入下可用，和 048 當時的嘗試不同。

### 驗證

環境：M1 Pro、macOS 26.6.2、Electron 44.3.0，主螢幕 BenQ GW2785TC 1920 × 1080，旁邊一台 1080 × 1920 直式螢幕；來源為 HEAD `4ff3eb1` 加未提交的變更，使用全新簽章的 `pnpm start:app` bundle，以 `pnpm open:app` 重開；儲存的語言為繁體中文，倒數 3 秒，維護者的歷史中有四筆未讀失敗。

- `pnpm check`：typecheck、99 個檔案共 1471 項測試與 build 通過。新的單元測試涵蓋：以 2026-10-02 錄下的選單做比對、快捷鍵對應、各狀態規則、項目被擠掉時的點擊目標、driver 有上限且可取消的等待、Tray 判定與橫幅文字判定。
- `pnpm acceptance:tray`，先 zh-TW 再 en：15 項通過、1 項 not run，共 68 秒。兩種語言的 idle、倒數與錄影選單都與 model 一致；從選單開始與停止都已存檔；「顯示上一段錄影」讓 Finder 置前並選取該檔；第二次點擊與「取消錄影」取消後沒有檔案、失敗紀錄或通知；倒數中選「結束」會退出且沒有檔案；以 Down 加 Return 開啟「設定…」、⌘W 關閉；最後的「結束 RecordStuff」讓所有程序都退出。未讀失敗群組有顯示，涵蓋 N33a 的「有未讀失敗的 idle」狀態。第二種語言期間把儲存的語言設為英文，結束後已還原。App 沒有執行時會拒絕（exit 1）；錄影中送 SIGINT 時，錄影已存檔、App 已結束，結束碼 130。
- 套用 review pass 2 的修正後（見下方），使用同一個 bundle：App 沒有執行時拒絕且不碰任何東西；雙語回合第一次在錄影中漏掉一次右鍵，所以 driver 現在會重點沒有打開任何東西的點擊（最多三次，選單開著時絕不重點），重跑後 14 項通過、2 項 not run（stale-start；以及 keyboard，因為開始時有一個無法辨識名稱的 RecordStuff 視窗，現在改為只在設定視窗開啟時跳過）；在 en 錄影中中斷時，runner 存好錄影、結束 App、還原繁體中文，結束碼 130，該輪的 keyboard 案例也通過；`--observe` 與 `quit-dialog -- --language en` 再次通過。
- `pnpm acceptance:settings-shortcut -- --observe`：六項輔助使用檢查通過；設定已開啟時在送鍵前拒絕（exit 1）。
- `pnpm acceptance:quit-dialog` zh-TW 與 en：每一層都通過，包括橫幅文字。
- agent 以自己的截圖獨立觀察：zh-TW 錄影選單與 en 倒數選單呈現的群組、靠右的 ⇧⌘1 與 ⌥⌘,、灰色的儲存位置項目，與 runner 的判定一致；設定視窗在前景且為作用中；一則未截斷的 zh-TW 延後退出橫幅與輔助使用讀到的 body 相同。

未驗證：needsPermission 選單，需要撤銷權限（屬 TCC 修改）；狀態改變後才選的「開始錄製」回報 not run，因為 macOS 比排隊的快捷鍵早 8 ms 處理了選單的 Start，沒有東西被忽略（由單元測試與 035 的維護者回合涵蓋）；淺色與深色選單列只判讀了目前外觀的截圖；Retina 螢幕、其他機器與 CI；以及回合中有人操作的干擾，目前沒有偵測。在選單 Start 之後 8 ms、狀態為 `starting` 時送出的快捷鍵沒有作用；本輪沒有判斷這是否為預期行為。

Review：Codex GPT-6.1 Sol pass 1（步驟 1，約 76 秒）沒有 findings。Pass 2（步驟 2–7，約 9 分鐘）回傳六項 findings，全部接受並修正：語言還原使用了已中止的 signal；收尾會操作被拒絕的回合從未接管的 App；可能在另一個 App 位於前景時送出 ⌘W 與 ⌘M；中斷的「顯示上一段錄影」開啟的 Finder 視窗沒有被關閉；沒有 identifier 的橫幅被計數；缺少輔助使用權限時記為失敗而非受阻。這些修正與之後加入的重點點擊都沒有再經過 review pass。

收尾：所有 RecordStuff 與 fixture 程序都已退出，儲存的語言已回到繁體中文，沒有留下本輪的 Finder 視窗，`caffeinate` 讓螢幕保持喚醒。保留在 ~/Movies/RecordStuff 的錄影：23:08:36（約三分鐘，來自失敗的那一輪）、23:11:44（診斷）、23:14:50、23:17:42、23:18:18、23:19:10、23:34:22、23:35:27、23:36:39、23:37:14、23:38:19 與 23:38:54。沒有 commit、push 或發布。

## Plan 062 結案 — 2026-10-02

Plan 062 修好了隔離的延後退出通知檢查：過去即使 macOS 拒絕通知，它仍可能通過。由 Claude 實作，Codex GPT-6.1 Sol review。只改了開發工具與文件，App 沒有變更。長期規則見[引導式延期退出通知驗收](../system-design/tooling.md#引導式延期退出通知驗收)、[證據界線](../testing.md#證據界線與停止條件)的通知條目與[準備一輪驗收](../acceptance.md#準備一輪驗收)。

- **根本原因。** `pnpm acceptance:quit-dialog` 直接啟動 `node_modules` 裡的 Electron，它只有 linker／ad-hoc 簽章（`Identifier=Electron`、`Sealed Resources=none`）。macOS 以 `UNErrorDomain` error 1 拒絕通知，而 runner 只判斷生命週期、timer 與清理，所以九月的回合在沒有橫幅的情況下通過（[plan 055](history-2026-09.md#plan-055-結案--2026-09-29)）。2026-10-01 的 A/B/A 比對沿用同一個複製路徑、bundle identifier `com.github.Electron` 與 fixture，只改簽章：原簽章被拒、完整 RecordStuff Dev 簽章兩種語言都送達、還原後又被拒。這證明完整簽章是條件，但沒有分別拆開憑證、Info.plist 與資源封存。沒有變更任何通知設定、信任、TCC 或 entitlement。九月那些 blocked 結果維持原紀錄。
- **修復。** `node scripts/start-app.mjs --fixture-app` 把本 checkout 的 Electron.app 複製到每輪的暫存目錄，用 `pnpm start:app` 選取的 identity 簽署，再以同一個 `verifyBundle` 驗證。`verifyBundle` 改為可指定 identifier 與 hardened runtime，並明確拒絕 ad-hoc 簽章。一般模式保留原本的預設值、測試、階段計時與建置紀錄。runner 以 60 秒上限監督這段 setup，只啟動驗證過的副本。fixture 把通知事件附加到 `notification.jsonl`。[quit-dialog-acceptance.mts](../../../scripts/lib/quit-dialog-acceptance.mts) 分開判斷五層：簽章 App、生命週期、送達事件、視覺與清理。exit 0 是自動化證據，視覺層維持待補。

### 驗證

- **自動化。** review 修正前 `pnpm check` 通過（97 個檔案、1448 項測試）；修正後 `pnpm typecheck` 與相關測試通過（`start-app.test.ts` 49 項、`quit-dialog-acceptance.test.ts` 34 項）。測試涵蓋：identity 缺少、重複、過期、無法存取，以及金鑰需要有人操作（blocked，不複製也不簽章）；簽章失敗、ad-hoc、bundle 損壞、外層或 helper 憑證錯誤、identifier 與 designated requirement 錯誤（fail，不寫報告）；送達的 shown、太晚、缺少、拒絕與其他錯誤；依階段區分的 setup 逾時、生命週期與清理失敗、鎖定，以及失敗優先。`git diff --check` 通過。
- **不啟動的演練。** 不存在的 `RECORDSTUFF_SIGN_IDENTITY` 以 blocked（exit 2）結束，沒有啟動。在複製時、以及再一次在簽章時送出 SIGINT，都以失敗（exit 1）結束，沒有啟動。每次都沒有留下暫存副本、簽章 scratch 或程序。
- **桌面回合。** 維護者在開始前回覆「好了」；環境為 commit `41ae66d` 加上本次未提交的變更。`pnpm start:app` 建置、簽署並驗證 9 個 bundle identity（`identifier "com.ericts.record"`，RecordStuff Dev `01B37351…D637`），從 `dist/mac-arm64` 開啟後正常退出，所有 bundle 程序都已結束。`pnpm acceptance:quit-dialog -- --language zh-TW`（`2026-10-02T14-13-29-958Z-quit-dialog-zh-TW`）與之後的 `-- --language en`（`2026-10-02T14-14-00-328Z-quit-dialog-en`）都以 exit 0 結束。setup 約 1 秒（9 個 bundle；designated requirement `identifier "com.github.Electron" and certificate leaf = H"01b37351…d637"`）。`shown` 事件在請求後 9 ms 到達，timer 最多延遲 2 ms，精確 bytes 已儲存，副本與程序都已清除。
- **視覺。** Claude 在每次請求後 0.8 秒與 2.3 秒以 `screencapture` 被動截圖，沒有點擊，也沒有改變焦點。繁中：一則 RecordStuff 橫幅，可讀且文字完整。英文：一則可讀的英文橫幅，但 macOS 把正文截在第四行（“…retry the same action: Quit…”）。完整文字沒有看到，因為要在通知中心展開需要原生 UI 操作，本次 session 沒有這項能力；此項維持 **blocked**。橫幅使用 Electron 圖示，這是 fixture 的預期。
- **review 修正之後。** 上述回合都在修正之前執行。修正只改了 setup 的 `TMPDIR` 與讀取殘缺證據的方式：以私有 `TMPDIR` 直接執行 `--fixture-app`，簽署並驗證了副本，私有暫存目錄最後是空的；兩個演練也重跑了。維護者再次回覆準備就緒後，以已提交的修正 `6b075ca` 重跑兩種語言，不截圖（`2026-10-02T14-23-56-283Z-quit-dialog-zh-TW`、`2026-10-02T14-24-13-584Z-quit-dialog-en`）：都以 exit 0 結束，`shown` 分別在請求後 11 與 9 ms 到達，timer 最多延遲 2 ms，副本與程序都已清除。

Review：Codex GPT-6.1 Sol（medium reasoning、read-only）。Pass 1（234 秒）提出兩項，都接受並修正：

- 殘缺的 `signature.json`、timing 或 result 會在清理與寫報告之前拋出例外。
- `verifyBundle` 的憑證 scratch 不在本輪目錄內，setup 被中止時可能留下，而清理仍判定通過。

Pass 2（約 105 秒）審查修正後的 diff，沒有 findings。

清理：沒有殘留 RecordStuff、Electron fixture 或簽章程序，也沒有留下暫存副本或 scratch。報告與 agent 視覺紀錄保留在 `docs/verification/measurements/`；截圖含有無關的桌面內容，已依維護者要求刪除。本次工作期間執行了 `caffeinate -d -i -t 5400`。

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
