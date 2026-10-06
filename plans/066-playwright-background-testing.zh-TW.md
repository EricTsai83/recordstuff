# 066 — 將日常驗收遷移到不接管桌面的 Playwright

[English](066-playwright-background-testing.md) | [繁體中文](066-playwright-background-testing.zh-TW.md)

建立：2026-10-06。狀態：已規劃，尚未開始實作。來源：維護者希望自動測試期間仍能使用自己的鍵盤與滑鼠，本次先要求完整遷移計畫。依[計畫索引](README.zh-TW.md)與[共用測試規範](../docs/zh-TW/testing.md)順序執行。

## 目標與限制

讓 `pnpm acceptance:regression` 成為全自動背景檢查，涵蓋日常 renderer 與 Electron 整合行為。不得顯示視窗、取得 OS 焦點、移動系統游標、註冊全域快捷鍵、播放聲音、送出原生通知、開啟 Finder／瀏覽器／系統設定，或錄製使用者的螢幕與音訊。維護者執行這個命令時可以繼續工作。凡宣稱涵蓋正式 renderer、CSP、sandbox preload、IPC、持久化與媒體協定的案例，必須真的測到那些路徑。

將現有設定、快捷鍵與播放器 fixture 中所有可遷移的斷言移到背景路徑。保留一組範圍明確、精簡的桌面測試，驗證真正的 OS 行為與實際錄影。能由既有專案 runner 操作的桌面案例繼續自動化；自動化本身不代表可以與正在使用的桌面共用。主觀聆聽、首次權限核准、Touch ID／密碼與實體硬體變更仍保留需要人的前置條件。

技術基礎為 Playwright 的 [Electron API](https://playwright.dev/docs/api/class-electron) 與 Electron 的 [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)。Playwright 的 Electron 支援仍屬 experimental，offscreen 視窗沒有原生視窗框。因此本計畫不宣稱能涵蓋原生視窗框，或在任何沒有圖形工作階段的環境執行。獨立的隱藏 Electron fixture 也不同於 headless Chromium 瀏覽器。鎖定工作階段與 CI 相容性必須量測，不能假設。若某項行為必須顯示／聚焦視窗才能測，其 OS 部分留在桌面測試，其他斷言仍移到背景。

本次規劃變更只加入本計畫、翻譯與索引項目；不實作遷移、不修改測試政策、不啟動 App，也不豁免既有驗收要求。工作樹已有大範圍 React/shadcn 與 Playwright 修改；實作前保留它們並記錄精確輸入身分，不假設 HEAD 就代表基準。

## 已檢視的起點

以下盤點描述 2026-10-06 檢視的工作樹，不代表本次已執行並通過那些測試。

| 既有入口／實作 | 目前證據與桌面依賴 | 遷移目的地 |
| --- | --- | --- |
| `pnpm check`；就近 Vitest 與整合測試 | 型別、邏輯與建置，不是桌面驗收 | 保留；Playwright 不取代快速單元測試或正式建置 |
| `pnpm test:ui`；`tests/ui/components.spec.ts`、`tests/ui/fixture.cjs`、`playwright.config.ts` | 已有隱藏 offscreen Electron，使用真實設定 preload/page 與合成 view/handler；單 worker；元件輸入、幾何與 DOM 焦點 | 擴充成共用 Playwright fixtures。簡化 handler 本身無法取代 main 整合證據 |
| `pnpm acceptance:settings`；`scripts/fixtures/settings-panel.ts` | 正式 renderer/CSP/preload/IPC、真實 `RecordingsLibrary` 與 `recordstuff-media:`；大部分 handler 由 fixture 提供。`activate()` 會顯示與聚焦視窗；plan 057 將啟用受干擾判為 blocked | 遷移渲染、互動、協定／檔案斷言；真正的啟用案例抽到明確選用的桌面 fixture |
| `pnpm acceptance:shortcut`；`scripts/acceptance-shortcut.mts`、`scripts/fixtures/shortcut-failure.ts` | 正式 main/actions/SettingsWindow/持久化；normal/restart 使用真實 globalShortcut 註冊。settings 階段控制註冊，但仍顯示、最小化與聚焦視窗，並測 crash 與延遲存檔 | 用受控 OS adapters 遷移確定性的 ownership／save／restart／crash 斷言；真實註冊、啟用／最小化／還原留在桌面 runner |
| `pnpm acceptance:player`；`scripts/fixtures/player-panel.ts` | FFmpeg 可解碼片段經過真實 library/protocol；頁面輸入、真實播放與覆蓋螢幕的正式全螢幕視窗 | 控制、解碼／時間前進、時間／標題交接移到靜音隱藏視窗；實際全螢幕進出、位置與原生控制留在桌面 |
| `pnpm preview:ui`；`scripts/fixtures/ui-preview.ts` | 已在背景繪製雙語／主題／尺寸圖庫；不做判定，缺 FFmpeg 時可能省略播放圖片 | 共用情境／資料準備；必要視覺斷言加入 Playwright。保留圖庫工具；可選預覽的省略不能讓必要播放案例通過 |
| `pnpm acceptance:lifecycle` | 正式 Recorder/FileWriter/quit/history，合成 bytes 與腳本回答提示、隔離程序；不證明螢幕擷取 | 沒有具體重疊就獨立保留；標為免桌面前先稽核隱藏視窗／OS 邊界，不只為使用 Playwright 而重寫 |
| `pnpm acceptance:shortcut-layout`、`pnpm acceptance:settings-shortcut -- --observe`、`pnpm acceptance:tray` | OS 註冊／送鍵、原生入口／選單／框／焦點與真正狀態列輸入 | 保留桌面檢查；只移確定性的 model/controller 斷言，不搬走 OS 證明 |
| `pnpm acceptance:notification`、`pnpm acceptance:quit-dialog`、`pnpm acceptance:playback` | 簽章通知送達／橫幅／Finder 與真正播放觀察 | 保留原生證據；通知政策與動作請求也可在背景 adapters 測 |
| `pnpm acceptance`、`pnpm matrix`、`pnpm audio:quality`、CPU／收尾／cadence 工具 | 真實擷取、媒體輸出、音訊路徑或正式效能；可能使用可見素材／全域輸入 | 保留依影響選用的桌面／錄影回合；合成媒體或 Playwright 影片不能取代 |
| `pnpm acceptance:updates`、`pnpm acceptance:controlled` | 部分邏輯／合成狀態路徑；其他模式啟動簽章 App、使用 tray／快捷鍵或擷取 | 逐模式與 caller 分類；現有 `--logic-only`／selftest 名稱不會自動讓整個 runner 免桌面 |
| `.github/workflows/check.yml` | macOS／Windows 已跑 check + test:ui；Windows 另測打包與安裝 | 在兩種 CI 平台擴充背景涵蓋；保留安裝門檻與既有發布政策 |

## 證據與架構契約

命令與報告明確使用三種測試範圍：

| 範圍 | 執行方式 | 通過能證明什麼 |
| --- | --- | --- |
| 邏輯 | Vitest／Node；受控輸入與檔案系統 | 實際測到的狀態轉移、ownership、驗證、失敗復原與 bytes／file 斷言 |
| 背景 UI／整合 | Playwright 操作隱藏 offscreen Electron、正式 `out/` page 與 preload；沒有 OS 互動 | 瀏覽器輸入、DOM 焦點、渲染、真實 IPC 與選定的正式 main／file／media 路徑 |
| 桌面／擷取 | 新鮮簽章 bundle 或適當原生 fixture 與已提交 runner，單一桌面執行者 | 真正的 OS 輸入、框／焦點／通知與所測錄影／播放；截圖與聆聽另列 |

背景實作限制：

1. 抽出 Playwright `test.extend` fixtures，每個 test 有獨立暫存 userData／output／media 目錄與受監督的 Electron 程序樹。使用已安裝的 Electron，清除繼承的 runner／signing 環境；隔離成立前保留單 worker。建置一次後載入正式產物，不使用 dev server、假 HTML、放寬 CSP、`nodeIntegration` 或替代 preload。
2. 提供輕量 view/component host 與正式 main 整合 host。宣稱那些路徑的案例共用 `settingsView`、`RecordingsLibrary`、正式設定 action/storage 與 window controller。只替換環境邊界：OS 快捷鍵註冊、Tray、原生通知／對話框、外部開啟與實際螢幕擷取。測試專用控制可 seed、延遲／拒絕操作、重啟程序與讀取 adapter 呼叫。使用既有 fixture tooling 建置；不把測試 IPC 或入口放進正式 App。
3. 所有設定／影片／倒數視窗建立為隱藏 offscreen，音訊靜音，測試時關閉 background throttling，平台支援時隱藏 Dock。以小範圍、只用於測試的 window／OS 邊界阻止正式 show／focus／full-screen 呼叫碰到桌面；這類請求記錄為 adapter 證據，不宣稱實際啟用／全螢幕。避免用廣泛 Electron mock 取代待測 IPC 或 storage。
4. fixture 邊界加入防護：任何自有視窗變可見、OS focus／show／full-screen 操作漏出、真實 globalShortcut／Tray／notification／external-open／capture 邊界被呼叫，或音訊解除靜音，都失敗。包含啟動後新建視窗；檢查 caller 而不只初始 BrowserWindow options。違反限制要有診斷與清理，不能默默忽略。這些防護證明 fixture 隔離，不宣稱偵測每次人為桌面操作。
5. 待測互動用 Playwright locator／mouse／keyboard；優先角色／名稱，結構與 race 案例使用穩定 ID。`evaluate` 留給準備／觀察、精確故障注入與受控 clock/state，不以直接呼叫正式 handler 取代必要點擊／按鍵。DOM 焦點與 OS 啟用分開；瀏覽器事件無法重現觸發方式時保留原生案例。
6. 等待具體狀態／事件，以自動重試斷言取代大範圍 sleep；測量經過時間本身時仍保留真實時間。renderer clock 不能代替 main timers、media time 或原生生命週期；held-save 與 race gate 要有明確 start／release／settled 訊號。
7. teardown 涵蓋通過、斷言失敗、啟動失敗、renderer crash、timeout、SIGINT／SIGTERM。正常關閉自有視窗／App；卡住的 fixture 使用有期限的程序樹清理並回報強制停止。確認自有 main/helpers 都離開後才刪暫存狀態；無法確認清理時保留診斷並讓回合失敗。背景測試不關閉無關 App。

## 涵蓋清單與遷移對照

移植前在遷移證據建立案例清單。列出舊 runner 每個斷言，包含迴圈展開的語言／主題／尺寸／狀態／delay 組合，給穩定 ID。記錄行為、舊來源／斷言、fixture 邊界、新 spec/test ID、證據種類、必要原生對應與最終處置。以行為身分而非測試總數判斷：一個舊案例可拆成多個新斷言，重複案例只能在完整契約保留時合併。故意移除斷言必須說明哪個行為已過時，無法移植不是理由。

| 行為群組 | 必要背景涵蓋 | 保留的 OS 證據 |
| --- | --- | --- |
| 設定載入／view／持久化 | 正式 bundle/CSP、sandbox API、IPC read/ready/change/choose、committed views、async stale completion、錯誤、重啟持久化、light/dark/system 與語言 | macOS 繪製的框／紅黃綠按鈕；真正 startup／focus |
| 版面／無障礙 | 所有分頁、default/narrow/minimum、長文／捲動、disabled/busy、labels/roles、Tab 順序、DOM 焦點返回、tooltip/menu 位置與 escape/hover | 需要時的 VoiceOver／主觀可讀性；真正失去啟用 |
| Library／檔案 | 真實隔離檔案、長度／大小／日期、自訂 protocol/ranges、thumbnail/fallback、空／失敗資料夾、rename 驗證與檔案變更、延後 trash/undo 語意 | 測到的 OS Trash／Finder／外部播放器效果；檔案證據與 adapter 呼叫分開 |
| 錄影結果 | 確認／移除、獨立展開、舊 mouse press 對新結果、延後儲存、pending/unsaved/final、保留與焦點路由 | 跨 App 的原生重新進入／焦點；需要時的通知／真實錄影失敗 |
| 快捷鍵編輯／ownership | candidate capture/preview/confirm/cancel/timeout、保留鍵／legacy collision、adapter 註冊失敗／retry、無意外存檔、held save 橫跨 close/reopen/crash、restart／註冊恢復 | 真實註冊成功／失敗、鍵盤配置、OS 全域送鍵與 App 選單 accelerator |
| 設定生命週期 | 重複建立／關閉／重開、不重複視窗、geometry 存檔、crash 清除／重建、committed key 恢復、入口請求不啟動 Recorder | 實際 visible/minimized/focused 與 tray／shortcut 送達；保留原生鍵盤關閉 |
| Player／media | controls 與無障礙值、drag/keys、mute/volume、overlay 休息／喚醒、關閉後焦點、真實可解碼媒體／metadata／時間前進／seek/errors、隱藏 settings/video 的 title/time 交接 | 真正全螢幕／位置／Escape、原生控制、可見播放與主觀聲音 |
| 倒數 | 隱藏 host 的 renderer ready/state、digits/progress、取消／完成呈現、靜音 adapter 的聲音偏好請求 | 真正快捷鍵／倒數不被錄入與音訊路徑 |
| 通知／權限／退出／更新狀態 | 適當正式邏輯的 copy/view/action 請求、policy、blocked、排隊工作與失敗轉移 | TCC／系統設定、signing/delivery/banner/Finder、原生退出互動與真實 update/capture 生命週期 |

媒體測試使用確定性的短片段（每輪由 FFmpeg 產生一次，或來源明確的小型已提交片段）。Phase 1 決定並在兩種 CI 平台提供前置條件。缺少必要媒體是 blocked，不是可選 skip。簡單 video property 合成測試仍屬 controls 測試，另加真實 decode/progression。允許解碼但強制靜音。輸出 samples／analyzer 測試保留既有工具。

## 順序實作

每階段完成交付物與檢查才進下一階段。尚不存在的檔名為提案，可依專案慣例調整，不能改變行為契約。

### Phase 0 — 固定基準與範圍

- 記錄 source/dependency/configuration/environment digest，包含未提交與未追蹤的 React/Playwright 工作、runner 版本、舊命令圖與可用產物。不重設或重做那份遷移。
- 產生完整案例清單，拆開混合 UI/OS 斷言並記錄重複；檢查本計畫每種範圍對應的測試選擇列與驗收案例。
- 有符合政策重用規則的可比證據才記錄現有命令時間；舊桌面回合要交接，不因只需計數斷言就重跑。不要只為測速度另錄基準影片。
- 定義任務本地驗證 recipe：check/build 一次、新背景案例、受影響 runner/cleanup drills、最終原生證據；只有實作影響正式相依時才加 CPU/錄影。不能只因麻煩就省昂貴檢查。

完成條件：每個既有行為都有目的地，已知缺口與重用證據明列；尚不刪桌面 runner。

### Phase 1 — 證明背景 host 可行

- 將 `tests/ui/fixture.cjs` setup 抽成共用 fixtures，加入 typed seeds、adapter log、產物身分、防護與程序監督。提議 `tests/ui/fixtures.ts`、fixture host modules、focused specs；按需要調整 `playwright.config.ts`。
- 先跑具代表性的 click/key/drag、DOM focus、正式 IPC、隱藏視窗替換、截圖與真實靜音媒體；在本機 macOS 與 macOS/Windows CI 驗證。不假設 `_electron.launch` 適用 browser 專用 `headless` 設定。
- 用邊界 instrumentation 與一次觀察的代表性隔離檢查，證明 host 不顯示／聚焦視窗或移動系統游標。觀察共用桌面狀態的檢查遵守交接；隔離成立後一般背景執行免交接。驗證其他 App 在前景時的行為，不自行對維護者 App 送輸入。
- 演練 launch failure、assertion failure、timeout、renderer crash、interruption 清理；確認正常通過走正常清理、清理不完整不能 pass。觀察 child/helper 真正離開，不只看 `application.close()` 完成。
- 判定並記錄目前 Electron 能否在鎖定或無 display 時執行。不自動鎖維護者工作階段，也不從隱藏視窗結果宣稱這些環境通過。無法測時留具體未驗證環境；不支援時回報前置條件，只有有用時才提供另有範圍的 headless renderer host；瀏覽器證據不取代 Electron/preload/IPC。

完成條件：支援環境已證明背景 host 可行，OS 案例與平台限制列明。某能力失敗時保留桌面對應，遷移其可行部分。

### Phase 2 — 設定與 library

- 依案例群組將 `settings-panel.ts` 移至 Playwright settings/layout/library/results specs。保留真實 file/library/media protocol 與 race 斷言；適當共用 `ui-preview.ts` 資料 helper。宣稱 persistence 的案例使用實際 storage/action handler。
- activation/blur/foreground-window 案例移到明確桌面 fixture，保留 plan 057 的 blocked 分類。DOM 焦點留在背景。offscreen 截圖不能斷言原生控制；原生框觀察與頁面角落避讓分開保留。
- 移植雙語、主題、尺寸與動態狀態，不縮成單一英文 happy path。案例對等通過後才改 `acceptance:settings` wrapper；保留 report/output 契約或記錄支援的替代方式。

完成條件：每個設定／library 斷言都有通過的對等證據或保留原生案例；設定背景 runner 不再需要 `beginDesktopRound`。

### Phase 3 — Main 整合與快捷鍵

- shortcut-failure 的確定性 normal/restart/settings 行為與真實註冊／啟用拆開。背景整合 host 用正式 main/settings handler/persistence，OS registration 受控；真實註冊失敗／恢復仍有明確桌面案例。
- 移植 held-save races、timeout、close/reopen/crash/restart、通知請求與重複入口契約。host 不註冊真實全域鍵；記錄的 ownership 只證明 adapter 整合，Tray callback 只證明請求路由。
- 真正 minimize/restore/focus、原生 keyboard-close/menu 與 OS registration/delivery 留在既有 runner 或小範圍抽出的原生 fixture。recipe 保留直接 leaf 命令，使組合只建置相同輸入一次。

完成條件：確定性快捷鍵整合只使用背景，原生涵蓋保留，normal 與刻意 failure/timeout cleanup drills 都有證據。

### Phase 4 — Player 與倒數

- player controls 與真實靜音 decoding 移植到 Playwright。使用正式 library/protocol、video preload/page；隱藏視窗測時間／標題交接與返回 acknowledgement。若 `VideoFullScreen` 需要 OS seam，只隔離啟用／full-screen 操作並檢查所有 caller。
- 真正 OS full-screen/Escape/focus/placement/window controls 留在桌面 player runner，以短生成片段操作。精簡不得移除原生斷言；真正已儲存錄影的播放證據與生成媒體解碼分開。
- 新增載入正式 countdown preload/page 的隱藏 host。audio 建立經靜音 adapter，錄影排除仍在真實 smoke 測。保留適用單元測試，不將所有 timer/state logic 轉成 UI 測試。

完成條件：日常 player/countdown 變更可在無可見視窗／聲音下測；真實全螢幕／擷取保留 native runner。

### Phase 5 — 視覺檢查、命令、CI 與政策

- 選定圖庫情境加入幾何斷言與經檢視的截圖基準，含雙語／主題／尺寸／相關狀態。固定 seed/date/font/scale/animation，不隱藏待測暫態 UI。按 platform/runtime 區分基準，更新要觀察，不自動接受失敗圖片。幾何斷言驗證跨渲染差異仍必須成立的契約。遵循 Playwright [視覺比較指引](https://playwright.dev/docs/test-snapshots)。
- 為手動 launch 的 Electron pages 設定 trace、page screenshots、console/page errors、adapter events、process logs 與機器可讀報告；以刻意失敗證明證據可檢視，不能只因 config 寫了預設值就認為手動 context 有 trace。Playwright 影片是 UI 診斷，不是 RecordStuff 擷取證據。
- Phase 1–4 對等成立後才切換 `acceptance:regression`：一次 `pnpm check` build，加完整背景 suite，不包含桌面 leaf。`test:ui` 留作 CI/recipe 無建置 leaf。`acceptance:settings`／`acceptance:shortcut` 明確限背景，或保留有範圍報告的相容 wrapper。`acceptance:player` 仍明確屬桌面，普通 UI 案例加入 `test:ui`。
- 新增可發現的小型 OS subset 原生 recipe，使用既有 runner，需要時共用一次新鮮簽章產物。提議名稱 `native-ui`，目前尚不存在。報告執行前宣告桌面使用；agent 仍先取得「好了」。廣泛原生 recipe 是可用組合，不代表每次變更都重跑所有 OS 案例。
- 更新 `scripts/lib/runner/verification-timing.mts` 與 `scripts/acceptance-recipe.mts` 的 recipe/timing tests／cleanup。保留 stopped/blocked/failed/invalid、source/artifact 身分。不要將所有非零 Playwright exit 都判 blocked；缺前置與斷言失敗不同。停用前檢查既有 `--out`／cleanup drill flags 與 caller。
- 擴充 macOS/Windows `check.yml` 背景檢查，失敗保留 traces/reports/screenshots/logs。提供選定媒體工具，保留固定 actions 與 Windows installer gates；最終程式 revision 跑一次 CI，不發布。GitHub 不能測未推送的本機 diff；若將該 revision 放到遠端需要 commit/push，另取得使用者對這些動作的要求，在那之前將最終 revision 的 CI 列為必要但未執行，不沿用歷史 pass。UI job 通過不宣稱 Windows native capture/tray 驗收。
- 依影響更新中英文 CONTRIBUTING、testing、acceptance、tooling/repository/desktop 文件與 native acceptance skill。按行為改選擇列：renderer/IPC/storage 跑背景 regression；OS focus/frame/menu/full-screen/notification/input 跑明確 native checks；capture/quality/audio/performance 保留錄影列。替代證據與原生對應成立後才改政策，保留交接／鎖定／清理／證據種類規則。

完成條件：日常命令沒有桌面相依，命令／報告明確標範圍，兩種支援 CI runner 平台通過，政策為每項 OS 邊界要求正確原生檢查。

### Phase 6 — 最終對等、量測與結案

- 對照每個 ledger ID 的最終通過證據、明確保留桌面案例或同意的過時斷言。必要證據缺少／blocked 時不能宣稱整體遷移完成。替代與剩餘原生案例都驗證前保留舊 runner，之後才刪重複 fixture/input helpers。
- 未變動輸入上跑一次最終 covering recipe，收集隔離、涵蓋、清理與時間。對照 Phase 0 的總時間與桌面實際占用時間，將 readiness 等待／未知區間分開。日常 regression 桌面占用目標為零，不捏造加速百分比；不因無關證據已有效仍要求完整舊／新矩陣重跑。
- 收到 readiness 回覆後，為受影響抽出的 window/shortcut/player 操作做一次獨占原生回合。使用 [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md)、已提交 runner 與截圖觀察。實作任務會有桌面回合時，在第一次實作修改前背景啟動 `caffeinate -d -i -t 5400`，最終清理後停止並回報；還原設定、關測試 UI、正常退出受測 App，確認程序離開。
- 最終實作影響哪些正式相依，才依共用政策加 recording/CPU/build checks。修改正式 window controller 或 live renderer 生命週期必須重新分類；新增測試 host 不自動要求擷取。實際驗過的螢幕／系統音訊行為與缺口分開回報。
- 寫入耐久 architecture/tooling 結論與雙語 verification 結案，更新索引，依[完成規則](README.zh-TW.md#完成計畫)移除計畫／翻譯。沒有另外使用者要求，不 commit/push/PR/tag/publish。

完成條件：必要檢查與清理有證據，剩餘 native/human/platform 限制明確，不縮減宣稱涵蓋即可結案。

## 遷移後命令契約

以下是目標契約，不是現在要執行的指令。各遷移階段通過、政策／文件更新前，既有命令仍遵守目前要求。

| 命令 | 目標桌面使用 | 涵蓋／建置規則 |
| --- | --- | --- |
| `pnpm check` | 無 | 既有型別、Vitest 與一次正式建置 |
| `pnpm test:ui` | 已驗證環境中無 | 所有遷移的背景 UI/integration/media/選定 visual cases；需要正式 `out/`，不另建置 |
| `pnpm acceptance:regression` | 已驗證環境中無 | check/build 一次 + 完整背景 suite；失敗停止並回報 |
| `pnpm acceptance:recipe -- settings` | 已驗證環境中無 | 相同背景 regression，加身分／時間證據 |
| `pnpm acceptance:settings`、`pnpm acceptance:shortcut` | 遷移後限背景 | 相容／篩選命令明確排除原生證據；composite recipe 避免第二次 build |
| 提議 `pnpm acceptance:recipe -- native-ui` | 獨占桌面 | 適用 native entry/frame/focus/registration/player；recipe 宣告前置，需要時用簽章 bundle |
| 既有 tray/settings-shortcut/shortcut-layout/player/notification/quit-dialog/playback | 選定操作需要時獨占桌面 | 保留真正 OS 證據，依受影響行為選用 |
| 既有 recording/matrix/audio/performance | 依真實 capture/material 路徑 | 保留 hardware/media/performance 證明與重用規則 |
| `pnpm preview:ui` | 既有背景圖庫 | 可選預覽仍是便利工具，必要 visual/media 斷言在 suite |

## 驗證 recipe 與驗收條件

實作開始跑檢查前必須寫最終任務本地 recipe，依實際 diff 調整以下基準：

| 影響 | 必要最終證據 | 條件式排除 |
| --- | --- | --- |
| Test hosts/specs/wrappers/recipe | `pnpm typecheck`、focused runner tests、UI 前一次正式 build、新背景 suite、failure/timeout/crash/interruption cleanup 與必要報告 | `pnpm acceptance:regression` 已涵蓋 typecheck/build/suite 時不再分開重跑 |
| 任何 App/preload/window-controller 修改 | 最終 regression 內的 `pnpm check` 與改動互動、相關 native window/full-screen/shortcut | 正式 capture／錄影協調或受影響 OS action 能啟動／停止／干擾擷取時才加錄影 |
| Live timers/renderers/window lifecycle | 適用 shared CPU row 時，用新鮮 `pnpm start:app` 產物測 CPU | 只用於測試的 fixture polling 不要求正式 CPU baseline |
| CI/runtime/build | 最終 macOS/Windows jobs 與受影響 package checks、artifact/debug 證據 | 不 release/tag/publish；除非另經影響評估有必要，Electron 版本不變 |
| 文件／skill | 受影響連結／anchor、真實 script/flag、翻譯、修改 skill 時的 metadata；`git diff --check` | 不只為文件啟動 App 或錄影 |

驗收必須全部成立：

- 日常 regression 自動且無 OS 桌面效果，所有建立視窗／adapter 有隔離證據；維護者可繼續工作。
- 舊的可遷移斷言都有等效涵蓋，剩餘 OS 斷言都有可執行原生對應或明確必要但未驗證項。沒有隱藏刪除或整批 skip。
- 真實 Electron CSP/preload/IPC/storage/media 證據保留；adapter calls、合成媒體、真實 decode、原生觀察與真實 capture 分開回報。
- 報告可診斷缺前置、fail、blocked native round、interruption、過期輸入與不完整清理；成功不依賴刪 log 或留 helpers。
- 最終 macOS／Windows 背景證據可用；Windows hardware/native 缺口保留。鎖定／無 display 只能按實際驗證或具體限制標示。
- 政策、命令圖、recipe 與雙語文件一致；日常命令不會意外呼叫剩餘桌面 fixture。

## 風險與替代決策

| 風險 | 處理 |
| --- | --- |
| 隱藏輸入／DOM 焦點不同於 active window | Phase 1 證明代表性互動，真正啟用留 native；不偽造 document focus 讓 OS 契約過關 |
| Main startup 重建可見 window／shortcut／tray | 小範圍 test-only boundary + 強制防護，稽核 creation/routes；宣稱正式 main 的案例保留該邏輯 |
| 簡化 IPC 測試過了、正式卻壞 | component/integration hosts 分開，ledger 標邊界；持久化／race 用實際 storage/actions |
| Offscreen 缺原生控制或 OS/font/GPU 圖片差異 | 保留 native frame，穩定 geometry 與經檢視的平台 baseline；不為 snapshot 改正式渲染 |
| Playback mocked、靜音錯誤或缺工具 | 加可解碼 media progress/seek，確認 mute，提供前置，必要媒體無法建立則 blocked |
| Offscreen Electron 仍需 GUI／鎖定停止渲染 | 量測支援環境並記限制；不相容環境用專用 CI/session，不默默擴大 browser-only 證據 |
| Crash/timeout 留 helper/timer/state | 監督自有 process tree、drills、保留診斷、清理不全 fail；不全域殺程序 |
| 過渡期間重複 build/test 或丟失原生證明 | 案例清單 + 一次 build recipe；對等後才退役舊可移案例，保留剩餘 native assertions |

本實作不包含另外機器／VM 架設。專用 macOS 測試機／工作階段可將原生回合移出維護者桌面，但需獨立驗證 signing/TCC/notification/display/audio/hardware；這是後續選項，不是 Playwright 功能或背景遷移前提。

## 本次只寫計畫的驗證

本輪檢查連結／anchor、目前命令與雙語結構，再對四個 plan/index 檔案跑 `git diff --check`。純文件計畫不需要 source 修改、build、tests、桌面交接、App 啟動、capture 或 caffeinate。實作時才建立執行證據；上述盤點與官方參考是設計輸入，不是 pass 結果。
