# 錄影管線與檔案設計

[English](../../system-design/recording.md) | [繁體中文](recording.md)

實作來源：[Recorder](../../../src/main/recording/recorder.ts)、[原生擷取 host](../../../src/main/recording/native-capture-host.ts) 與[其程序](../../../src/main/recording/native-host-process.ts)、[協定](../../../src/shared/protocol.ts)、[引擎檔案 writer](../../../src/main/recording/engine-file-writer.ts) 與[發布](../../../src/main/recording/file-writer.ts)、[健康門檻](../../../src/main/recording/recording-health.ts)、[倒數數值](../../../src/shared/countdown.ts)、[session sentinel](../../../src/main/recording/session-sentinel.ts)、[品質函式](../../../src/shared/quality.ts)、[螢幕選擇](../../../src/main/display/display-media.ts)、[Windows 的自身視窗排除](../../../src/main/recording/capture-exclusion.ts)；引擎位於 [native/capture](../../../native/capture/src)：[session 核心](../../../native/capture/src/core/mod.rs)、[節奏](../../../native/capture/src/pacing.rs)、[時鐘](../../../native/capture/src/timing.rs)、[混音器](../../../native/capture/src/core/mixer.rs)、[writer](../../../native/capture/src/writer.rs)、[muxer](../../../native/capture/src/mux/mp4.rs)，以及 [macOS](../../../native/capture/src/mac) 與 [Windows](../../../native/capture/src/win) 模組。

RecordStuff 只有一條錄影路徑：plan 076 的原生引擎。每次嘗試時，main 會 fork 一個 Electron `utilityProcess`（`RecordStuff Capture`），在其中執行擷取 host 並載入 Rust 模組（`recordstuff-capture.node`，以 napi-rs 建置，從 asar 封存檔解出）。引擎負責擷取（macOS 用 ScreenCaptureKit；Windows 用 Windows.Graphics.Capture 與 WASAPI）、以平台編碼器編碼（VideoToolbox 與 AudioToolbox；Media Foundation）、封裝，並自行寫出檔案（plan 076 的 D3，2026-10-14）。Main 保有檔案的生命週期：資料夾與檔名、剩餘空間檢查、session sentinel、以正式檔名發布、紀錄、通知，以及含期限、退出與睡眠處理的狀態機。原生程式當機只會結束擷取程序；main 讓該 session 失敗並保留已寫入的內容。先前的路徑是以 `getDisplayMedia` 與 `MediaRecorder` 錄影、每秒把一段資料交給 main 的 writer 的隱藏 Chromium renderer，已於 2026-10-16 移除。macOS 與 Windows 以外的平台沒有引擎：模組載入失敗，錄影也就失敗。

## 狀態與操作

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> needsPermission: 螢幕授權未就緒
    needsPermission --> idle: 授權與來源驗證成功
    idle --> starting: toggle
    starting --> countdown: prepared（開啟倒數）
    starting --> recording: prepared、record、started（關閉倒數）
    countdown --> recording: record、started
    countdown --> idle: cancelled（toggle／選單／退出／睡眠）
    starting --> idle: cancelled（1 秒後的 toggle／選單／退出／睡眠）
    recording --> stopping: stop / 退出
    stopping --> idle: stopped（存檔在背景繼續）
    starting --> idle: failed
    countdown --> idle: failed
    recording --> idle: failed
    stopping --> idle: failed
```

`needsPermission` 帶 `needsRelaunch`；`idle` 可帶 `outputDirUnavailable`。`countdown` 帶 `remaining`，為整數秒且至少為 1；`record` 等待 `started` 期間維持 1。最新權限狀態不是 granted 時，session 結束（stopped 或 failed）會進入 needsPermission 而不是 idle（見[螢幕權限](desktop.md#螢幕權限)）；`recording` 帶 ISO `startedAt`。錯誤是 `failed` 事件，沒有持久的 `failed` 狀態；取消既不是失敗也不是狀態。缺權限時點圖示只發 `permissionRequested`；stopping 期間與 starting 的第一秒內點擊無作用，並寫入 log。倒數期間，以及 start 已持續一秒後，點擊或按快捷鍵會取消（見[倒數](#倒數)）。Recorder 內部的階段比狀態更細：`opening`（資料夾與檔案）、`preparing`（等待 `prepared`）、`countdown`、`arming`（已送 `record`，等待 `started`）、`recording` 與 `stopping`。

## 開始流程

1. `Recorder.start()` 確認 idle、沒有 session，執行 OS preflight（macOS 13 以上）；建立 session id、品質與倒數快照，進入 starting 狀態（tray 顯示沙漏）。
2. `ensureWritableDir()` 只自動建立預設資料夾，自訂資料夾必須存在；實際寫入並刪除 probe，空間低於 200 MiB 時拒絕開始；查詢剩餘空間本身失敗時只記 log 並繼續開始，與錄影中的防護一致。不可用就報錯，不換到其他資料夾。檢查到該次嘗試的期限仍未返回時（網路磁碟不再回應），會佔住主程序四條檔案系統執行緒之一，因此同一資料夾的新嘗試改為等待同一個檢查，在它返回前不另起新的檢查。
3. 先寫入該 session 的中斷 sentinel 並記下暫存檔路徑，再預留 `YYYY-MM-DD HH-mm-ss.recording.mp4`（本地時間，或檔名範本）：`EngineFileWriter.open` 以排他的 `wx` 建立空檔後立即關閉，之後引擎開啟同一個檔案寫入，從不自行建立檔名。遇暫存檔撞名時改寫 sentinel 並改試 `-2` 至 `-10`。檔名是按下開始當下的本地時間，因此有倒數時會比第一個影格早「準備時間加倒數」。
4. 有倒數時此時就建立 overlay 視窗，讓第一個數字準時出現。`NativeCaptureHost.start` 結束先前的擷取程序、登記將回報結果的檔案、fork 新程序，並同時透過 `DisplayMedia` 決定螢幕（見[螢幕選擇](#螢幕選擇)），兩者互不等待。程序必須在 8 秒內回報 `ready`；心跳開始。螢幕被拒時成為 host 的 `capture_start_failed`，再由 main 的拒絕原因取代。Windows 上 main 會算出螢幕上的實體座標點，並把自己的視窗標記為不可擷取（見[自身視窗](#自身視窗與系統介面)）。接著 main 送出 `start`，帶品質快照與原生選項：螢幕 ID、Windows 的座標點、預留的路徑、RecordStuff 的程序 ID（main 在前）以及 D6 開關（只限 macOS）。
5. Host 請引擎 `probe` 螢幕的像素尺寸，套用品質規則決定輸出尺寸與影像位元率（見[品質與編碼](#品質與編碼)），再呼叫 `prepare`。macOS 的 prepare 會讀取可分享內容（自 probe 起保留 2 秒，所以一次嘗試只向系統要一次；上限 15 秒；缺少授權時在此以 `permission_denied` 失敗）、找出螢幕（不在可分享清單中則為 `no_display`）、建立內容過濾器、開啟預留的檔案、在 `SCStream` 啟動的同時於另一條執行緒建立編碼器（上限 10 秒），並等待第一個影格最多 3 秒。Windows 以自己的來源做同樣的事（第一個影格同樣 3 秒；音訊啟用 5 秒）。從此擷取開始運作，但只保留最新影格，不寫入任何東西。Host 以 CaptureReport 回 `prepared`，並記下 `timing: probe … ms, prepare … ms (content …, filter …, stream start …, …)`；main 則記下 `process ready` 與 `display chosen`。因此權限、螢幕、編碼器與音訊錯誤都會在倒數前出現。引擎準備期間收到的 stop，會讓 host 在 `prepare` 返回後立即取消它並回 `stopped`。
6. 倒數關閉時 main 立即送 `record`；否則先倒數（見[倒數](#倒數)），結束時才送 `record`。
7. 引擎以自己的時鐘取得錄影的時間零點、啟動 writer 執行緒並立即返回；host 回 `started`（2026-10-14 量到從 `record` 起 2 ms）。接著引擎的 refresh 執行緒把最新擷取的影格以關鍵影格編碼在時間零點，所以無論畫面多靜止，檔案都以一個畫面開始，之後才接收後續的影格與聲音。Main 進 recording，以 `prepared` 的報告發出 captureStarted，並啟動首份媒體期限、停滯保護與磁碟保護。REC 只在擷取開始後出現，所以最初幾格可能拍到選單列上的碼錶，一如以往會拍到 `…`；數字不會出現在其中。媒體持續送達時，引擎每秒回報一次已寫入的位元組數（`progress`）；第一個非零回報必須在首份媒體期限內到達，log 以 `first chunk … bytes (engine progress)` 標記它（名稱沿用自隱藏 renderer，因為驗收工具以它計時）。

在已簽署的 bundle 上量測（plan 076，2026-10-14 與 2026-10-15）：從按下快捷鍵到 `prepared` 為 457–535 ms，Chromium 為 347–369 ms；原生的時間由程序啟動（74–88 ms）、可分享內容查詢（59–83 ms）與 ScreenCaptureKit 的 `startCapture`（206–227 ms）組成。預先啟動程序可降到 437–439 ms，代價是一個約 73 MB 的閒置程序；維護者於 2026-10-15 決定不採用，因為約 50 ms 落在倒數之內，所以錄影之間不存在擷取程序。

## 倒數

「設定 → 錄影」可選關閉、3、5 或 10 秒；預設 3 秒，檔案沒有這個欄位時也是 3 秒。2026-09-25 的快捷鍵回合量到從點擊到開始擷取 318 ms（見 [plan 040 結案](../verification/history-2026-09.md#plan-040-結案--2026-09-26)），所以最初幾格會拍到滑鼠離開選單列，而 RecordStuff 沒有剪輯器可以剪掉。比照 Cap，倒數前先準備好擷取，歸零時才開始（見[設計決策](decisions.md)）。

- Recorder 以 N 進入 `countdown`，從 `prepared` 當下取得的同一個單調時間起點每秒 tick 一次；每個 tick 都依這個起點排程，timer 延遲不會累積。每個 tick 都重新發出狀態，App log 寫 `state → countdown (n)`。
- 在 N 秒前 300 ms 要求 overlay 離開：數字以 120 ms 淡出，main 再等一個穩定間隔（34 ms）後銷毀視窗。Recorder 最多等這個確認 500 ms；逾時就銷毀視窗、寫 log 並繼續擷取。`record` 在 N 秒送出；若 dismissal 更晚完成，則在它完成時送出。
- Overlay（見[桌面設計](desktop.md#倒數-overlay)）以具備 `show`、`update`、`dismiss`、`close` 的 presenter 注入，Recorder 因此不依賴 Electron。Presenter 錯誤只寫 log，永不讓錄影失敗；tray 仍會顯示倒數。
- 倒數音效（plan 046，預設開啟，可在「設定 → 錄影」切換）在每個 session 與倒數一起讀取一次並傳給 presenter；`prepared` log 行以 `sound on` 或 `sound off` 結尾。overlay 頁面在每個新數字時播放一聲 −20 dBFS、523 Hz 的柔和馬林巴般提示音，數字 1 升高五度；歸零、取消或倒數關閉時都不響。每聲從該數字的 tick 時間起持續 140 ms，因此最後一聲（數字 1）在 `record` 前 860 ms 就結束，遠早於 overlay 離開：錄影靠時間上的分離保持乾淨（與數字相同），此外引擎也會把 RecordStuff 自己的聲音排除在外（見[音訊](#音訊)）。`pnpm acceptance` 會以兩個音高檢查有音效的 session 錄影前 500 ms 的音訊。autorecord 永遠不發聲，因此矩陣與音訊品質錄影只有素材本身的聲音。
- 送出 `record` 前，toggle、tray 選單的「取消錄影」或快捷鍵都會取消這次嘗試：清除 timer、停止 host、關閉 overlay、abandon writer 讓空的暫存檔被刪除，並回到嘗試前的 idle。`cancelled` 事件帶取消原因（`toggle`、`menu`、`quit` 或 `sleep`），log 寫 `cancelled: session … (reason); no media was recorded`。不產生失敗狀態、歷史項目、通知或螢幕診斷。
- 送出 `record` 後，toggle 會變成既有的「開始後停止」要求，等 `started` 到達再套用，因此幾毫秒的競態不會讓擷取持續進行。若擷取在第一個 frame 之前就停止，表示什麼都沒錄到：這次嘗試以該取消（或結束、睡眠）收場，而非開始失敗。倒數設為「關」時，`record` 在 `prepared` 就送出，狀態仍是 starting，因此選單的「取消錄影」或超過寬限時間的 toggle 也會變成同一個要求。倒數期間開啟的 tray 選單在開著時不會更新（見[桌面設計](desktop.md#tray-與通知)），所以擷取開始後才點選其中的「取消錄影」，會停止錄影並存檔。
- starting 期間的 toggle（plan 065）：start 持續達 `START_CANCEL_GRACE_MS`（1 秒）後，toggle 會和「取消錄影」完全一樣地取消這次嘗試；時間以 Recorder 的 monotonic clock 從 session 請求起算，該時間點與進入 starting 在同一個同步步驟中取得。仍在開啟資料夾或準備擷取時，取消後不留檔案、失敗項目或通知；已送出 `record` 時則變成「開始後停止」。寬限時間內的按鍵視為連按而忽略，stopping 期間的按鍵也一律忽略；兩者都會寫入 log（`recorder: session <id> toggle ignored while starting (<n> ms after the start)` 與 `… while stopping (<n> ms after the stop)`），因此「快捷鍵沒反應」的回報可以和按鍵遺失區分。starting 選單的「取消錄影」會和倒數時一樣標出已註冊的快捷鍵（見[桌面設計](desktop.md#tray-與通知)）。
- Plan 065 的決定由維護者於 2026-10-03 做出，依據 2026-09-12 至 2026-10-02 經由隱藏 renderer 錄影時保留的 log：739 次 start，中位數 289 ms、第 95 百分位 396 ms；超過 1 秒的九次全部卡在準備階段（權限被拒、缺少音訊軌與舊的 8 秒時限造成 1.1–9.4 秒；擷取請求一直未回應時四次各 120 秒），沒有卡在開啟資料夾的，另有一次（2026-09-13）卡在 `record` 之後。log 中最快的連按間隔為 290 ms。寬限時間定為 1 秒，而非「starting 期間隨時可取消」或「只在準備期間可取消」；starting 的「取消錄影」標出快捷鍵；開啟資料夾或準備期間退出會立即取消（見[終止責任與正常退出](#終止責任與正常退出)），不再等待擷取請求，過去曾因此讓一次退出等了 286 秒。
- 所有時間與外觀數值都集中在 [countdown.ts](../../../src/shared/countdown.ts)，作為初始目標；只有書面證據支持時才調整。

## 期限與故障隔離

| 保護 | 預設值 | 失敗處理 |
| --- | --- | --- |
| 輸出資料夾／開檔階段 | 8 秒（`DEFAULT_START_TIMEOUT_MS`） | output_open_failed；late writer 回來後 abandon |
| host ready | 8 秒（`readyTimeoutMs`） | start 以 capture_start_failed 失敗；下次嘗試 fork 新程序 |
| 擷取／系統授權請求（`start → prepared`） | 120 秒 | capture_start_failed；停止該 session |
| 引擎 prepare 內部（macOS） | 可分享內容 15 秒、stream 啟動 10 秒、第一個影格 3 秒 | capture_start_failed（缺少授權時為 permission_denied） |
| 引擎 prepare 內部（Windows） | 音訊啟用 5 秒、第一個影格 3 秒 | capture_start_failed |
| 倒數 overlay 的 dismissal | 從 dismiss 要求起 500 ms；要求在 N 秒前 300 ms 發出 | 銷毀 overlay、寫 log，照常開始錄影 |
| `record → started` | 8 秒 | capture_start_failed（while starting capture） |
| started 後首個非零 `progress` | 8 秒 | capture_start_failed，保留已寫入資料 |
| 媒體開始後的下一個非零 `progress` | 10 秒記錄一次警告，30 秒判定失敗；每個非零回報重新計時，收到 stopped 或失敗時解除 | capture_failed，detail 註明停滯；保留部分檔 |
| 輸出資料夾可用空間 | 從 started 到停止前每 5 秒查詢；低於 1 GiB 記錄一次 | 低於 200 MiB 時只要求一次正常停止；以「磁碟即將滿」原因存檔，不算失敗 |
| stop 回應（`stop → stopped`） | 10 秒 | stop_timeout |
| 停止前的聲音 | 引擎最多等 250 ms | 尚未送達的部分以靜音補上；寫入 log |
| `stopped` 後完成檔案 | 引擎 120 秒；host 程序 150 秒（`FINISH_BOUND_MS`） | output_write_failed（引擎），或結束程序（host）；兩者都保留檔案 |
| 存檔過慢 | 30 秒（`saveSlowMs`） | 記 log 並告知一次（`savingSlow`）；不放棄 |
| 讓自身視窗恢復可擷取（Windows） | 擷取程序結束時；要求結束後最多 5 秒 | 視窗恢復可擷取 |
| 退出等待 | 每次嘗試 13 秒（停止期限另加 3 秒） | 尚有工作時延後退出並顯示在地化提示，不截斷存檔 |
| 心跳 | session 進行中每 5 秒送 ping | 檢查時已有 2 次未回 pong 就 teardown：capture_host_unresponsive |

`record` 之前沒有擷取任何內容，因此準備或倒數期間的來源結束、螢幕移除、host 當機或無回應，以及 `record` 被拒或逾時，都是啟動失敗：`capture_start_failed`，detail 註明階段（`while preparing capture`、`while counting down`、`while starting capture`），仍發出螢幕診斷，結果為 empty。已脫離的 session 若送來遲到的 `prepared`、`started` 或 `progress`，會要求 host 停止，避免被放棄的嘗試仍暗中擷取。

這些是專案的等待上限，不是 OS 標準或精準的全流程耗時保證。磁碟 I/O 不能因此被真正取消。main 端的健康檢查各列（停滯、可用空間、存檔過慢）是初始目標，集中在 [recording-health.ts](../../../src/main/recording/recording-health.ts)；只有書面證據支持時才調整。心跳只證明擷取程序的 JavaScript 仍會回應；停滯保護才證明引擎仍在寫入媒體。引擎的 writer 只在過去一秒內有媒體送達時才送 `progress`，而正常但畫面靜止的錄影仍會持續送出，因為畫面靜止時引擎每秒會再編碼一次最後的影格（見[影格節奏](#影格節奏)），音軌也隨時鐘前進。可用空間查詢失敗只記錄一次，永不因此停止錄影。`powerMonitor` 的 suspend 與 resume 會連同進行中的 session id 寫入 log，讓之後的失敗能對照睡眠判讀；睡眠本身如何停止錄影或取消嘗試，見[寫檔與失敗](#寫檔與失敗)。

## 終止責任與正常退出

每一層都以第一個失敗為準。引擎只回報一次第一個擷取或編碼失敗：錄影中或排空到停止點期間為 `capture_failed`，僅 prepared 時為 `capture_start_failed`，排空結束後則一律不回報。Host 只在自己的 session 存續期間轉送引擎事件，並在送出 `stopped` 時放下該 session，因此之後的擷取事件不屬於任何人；此後引擎只為檔案負責，以 `finished` 或 `writeError` 回覆。Main 驗證每一則傳入訊息（`isHostMessage`），丟棄格式錯誤的訊息；host 若送來只有 main 才能發現的代碼（資料夾、磁碟期限、監督、啟動），會被視為格式錯誤而不採信。Recorder 不在 stopping 時收到的 `stopped` 是 `capture_failed`（「capture host ended capture without a stop request」）。

Recorder 接受 `stopped` 後由 finalizer 獨占該次收尾，錄影也就結束了：自 2026-10-09 起狀態立即回到 idle、釋放防止螢幕睡眠，檔案在背景完成收尾（引擎把它轉成一般 MP4，接著 main 檢查大小並發布），和其他錄影工作一樣被持有，所以退出仍會等它，下一段錄影則可以先開始。`NativeCaptureHost` 在嘗試 teardown 後仍讓正在收尾的程序存活，把結果交給 writer 後再結束它，或在 150 秒後結束（引擎自己的上限是 120 秒）；程序在回報前就結束時，存檔以失敗收場並保留檔案。在桌面上量到 Recorder 在 `stopped` 後 0–1 ms 回到 idle，檔案再過 19–22 ms 完成（2026-10-15）。`Recorder.saving` 為 tray 與設定列出這些收尾；超過 `saveSlowMs`（30 秒，磁碟不再回應）仍未完成的會記 log 並告知一次（`savingSlow`），main 絕不放棄它：仍在運作的慢速磁碟會在引擎的上限內完成。其結果（已存、失敗並保留部分檔，或第一個 frame 前停止的開始以取消收場）在回報時不碰狀態，因為那時狀態可能已屬於下一段錄影；在那段錄影期間完成的收尾，其已存通知會保留到錄影結束才送出，與擷取提醒的保留方式相同。遲到的 host crash／error、重複 stop 或螢幕移除不能 abandon 正在發布的檔案；引擎的寫入錯誤仍進入失敗清理。所有開檔、存檔、清理工作在同步 subscriber 執行前登記。開檔逾時立即讓 UI 回到 idle，但結果保持 pending，直到遲到的開檔與關閉完成。多次失敗各自保留清理工作的責任。

所有 `before-quit`（包含 idle）共用 `installQuitCoordinator`。重複退出加入同一嘗試，退出判定期間拒絕開始新錄影，並自動停止擷取。`record` 前不存在任何媒體，所以退出永遠不會錄下尚未開始的 session（plan 040，任何倒數設定皆然）：倒數期間、開啟資料夾期間或準備期間退出，都會和「取消錄影」一樣立即取消（plan 065；在此之前，準備期間退出會等到 `prepared` 或 120 秒的擷取請求期限）。host 會收到停止指令，並在 prepare 返回後立即取消引擎，因此遲到的 `prepared` 屬於過期 session，會再被停止一次；仍在進行的資料夾檢查由已取消的嘗試持有，退出會等它結束。要求退出時也會標記這次嘗試，因此在協調器檢查前結束它的任何原因都算作這次取消。只有已送出 `record` 的 session 保留停止意圖，擷取一開始就停止並收尾。必須沒有 session 與未完成工作，包含遲到開檔、先前失敗清理與失敗結果查核／發布，才允許退出。退出期限只延後退出；已開始擷取的失敗仍由既有停止回應 timer 判定。未完成的磁碟／結果發布工作仍被持有，App 保持開啟，使用者可重試退出。不為滿足退出期限摧毀 host 或宣稱未確認的保留路徑。強制退出、程序終止與斷電不受此保證保護，事後也不修復任何內容；引擎已寫入的部分仍是可讀到最後一個完整片段的分段 MP4（見[存檔時轉成一般 MP4](#存檔時轉成一般-mp4)）。唯一不等待媒體的退出，只在退出只剩背景收尾在等時提供：「不等待儲存直接結束」（2026-10-09，[桌面設計](desktop.md#延後退出)）會在有時限地寫入中繼資料後結束，並留下那些收尾的 sentinel。下次啟動會透過中斷 sentinel 回報這類 session（見[寫檔與失敗](#寫檔與失敗)）。只有在此媒體階段完成後，退出才嘗試保存失敗歷史；其明確的「只放棄提醒」退出永遠不會放棄媒體工作（見[桌面設計](desktop.md#延後退出)）。Windows 結束 session（關機、重新開機、登出）時不會送出 `before-quit`，因此改由每個視窗的 `query-session-end` 處理（[session-end.ts](../../../src/main/app/session-end.ts)，2026-10-05）：錄影工作仍在進行時會拒絕結束，並執行同一個退出流程；App 結束後 Windows 就會繼續。沒有進行中的工作時，照使用者的選擇結束。只有在有可見視窗時（例如 Settings 開著）才一定擋得住：沒有可見視窗的 App 拒絕結束時，若沒有透過 ShutdownBlockReasonCreate 註冊原因，Windows 會直接終止它，而 Electron 沒有提供這個 API；因此只從選單列錄影時，停止與存檔會立刻開始，但可能在完成前就被終止。未在 Windows 實機驗證。

## 品質與編碼

| 設定 | 實作規則 |
| --- | --- |
| 影像等級 | economy 0.07、standard 0.13、high 0.24 bits / pixel / frame |
| 位元率 | 輸出 width × height × 幀率設定 × 係數，四捨五入至 100 kbps，限制 1.5–60 Mbps；作為編碼器的平均位元率 |
| 解析度 | probe 得到的來源像素尺寸不縮放；1080p／1440p／4K 上限按來源方向交換長短邊，不放大，縮小時取偶數。由引擎縮放到該尺寸：macOS 用 `SCStreamConfiguration` 的寬高，Windows 用 Direct3D 11 視訊處理器 |
| 幀率 | 30／60；目前只有 darwin 開放 60；其他平台有效值為 30，不覆寫使用者檔案。設定值即編碼器的幀率與 pacer 的格線（見[幀率要求](#幀率要求)） |
| 影像編碼 | H.264：不重排影格（解碼順序即顯示順序，因此沒有組成時間偏移）、依顯示時間至少每秒一個關鍵影格（每個片段都從關鍵影格開始）、BT.709 標記 |
| 音訊 | AAC-LC、48 kHz 立體聲、目標 256,000 bps；Windows 的編碼器最高 192 kbps，因此以 192 錄製並在 warnings 註明 |
| 格式 | H.264 + AAC 的 MP4（`video/mp4;codecs=avc1,mp4a.40.2`，於 `prepared` 回報），以 hybrid MP4 寫入（見[存檔時轉成一般 MP4](#存檔時轉成一般-mp4)） |

引擎 probe 出來源尺寸後，host 依 [quality.ts](../../../src/shared/quality.ts) 的設定計算尺寸與位元率，再傳給 `prepare`；引擎從不讀取設定。編碼器（plan 076 的 D4）：macOS 用 VideoToolbox（Mac 有媒體引擎時會使用它）與 AudioToolbox 的 AAC 轉換器；Windows 用 Media Foundation 的 H.264 與 AAC transform。Windows 使用 Microsoft 的軟體 H.264 編碼器，所有具備媒體功能的版本都有，在沒有 GPU 的裝置上也能執行；GPU 的硬體編碼器（非同步 transform）尚未實作（[video.rs](../../../native/capture/src/win/video.rs)）。沒有 Media Foundation 的 Windows 版本會以 `capture_start_failed` 開始失敗，detail 為 `Media Foundation could not start`；沒有專屬代碼。60 fps 仍只限 macOS（`isFrameRateAvailable`）：其他平台的 60 fps 未經驗證。

CaptureReport 保留原有欄位，因此 Recorder 的 log 與提醒不變：輸出寬高、幀率設定、48,000 Hz 與 2 聲道、要求的位元率，以及 warnings；warnings 包含引擎自己的警告（無法排除選單列的 macOS、可分享 App 中找不到 RecordStuff、Windows 降低的 AAC 位元率）與一行摘要（`native engine: source WxH, AAC priming N frames, X own app(s) excluded, Y system window(s) hidden`）。由於回報的幀率就是設定值，60 降為 30 的降級提醒（`frameRateDowngrade`）在原生引擎下不會觸發；引擎也會縮放到指定的尺寸，因此從不設定 `capUnconfirmed`；兩條路徑仍保留在程式中。位元率是目標而非量測結果；成品仍需 ffprobe 量測。

### 幀率要求

幀率設定原封不動交給引擎，作為編碼器的幀率與 [pacer](#影格節奏) 的格線。擷取本身要求得更多：最小影格間隔為影格間隔的四分之一（`Pacer::capture_interval_ns`，30 fps 為 8.3 ms，60 fps 為 4.2 ms），在 macOS 設為 `SCStreamConfiguration.minimumFrameInterval`、在 Windows 設為 `MinUpdateInterval`，遠低於這些幀率下任何螢幕的更新週期，因此擷取會送出每一次更新，每個格位附近都有影格。ScreenCaptureKit 的最小間隔是下限而非週期，且依螢幕更新送出影格：要求接近幀率的間隔時，每個影格都落在上一個之後的第二或第三次更新，60 Hz 螢幕上的 30 fps 就會出現 33 或 50 ms 的間隔。在已簽署的 bundle 上量測：要求兩倍幀率時，30 fps 有 1.8% 的影格間隔 50 ms（2026-10-14）；直接要求每次更新（不設最小間隔）在 30 與 60 fps 都掉 0.17%，四分之一則為 0.06% 與 0.11%，CPU 大致相同（30 fps 為一個核心的 10.8% 對 10.4%，60 fps 為 14.4% 對 15.0%；2026-10-15）。因此維持四分之一。

隱藏 renderer 透過 Chromium 遇到同樣的下限，曾要求 30.3 與 62.5 fps 才錄到設定值（plan 041；結果見[驗證歷史](../verification/history-2026-09.md#plan-041-結案--2026-09-26)）；這個要求已隨它移除。

## 影格節奏

引擎在以錄影時間零點為起點、間隔為影格間隔的格線上，每個格位保留一個擷取到的影格（[pacing.rs](../../../native/capture/src/pacing.rs)），做法與 OBS 的幀率除數和 Cap 的節奏控制相同：60 Hz 螢幕因此剛好得到 30 fps，每個保留的影格都在上一個之後兩次更新。比下一個格位早超過半個間隔的影格會被略過；在那之後的影格則保留給最近的格位，並以其後一個格位作為下一個。被略過的影格仍是最新畫面：若畫面隨後靜止，refresh 執行緒會在該格位的時間到達後把它編碼在該格位（`Pacer::due`），絕不晚於現在，因此之後擷取到的變化仍然較新。

- **顯示時間。**影格沿用 ScreenCaptureKit 的顯示時間，約比送達早 11 ms（Windows 為影格的 `SystemRelativeTime`）。改以送達時間標記時，閃光與嗶聲的偏差從 −7 與 −15 ms 變為 +5 與 +3 ms，但掉了 1.4% 與 16% 的影格，因為送達時間隨 callback 排程抖動，格線會保留錯的影格（2026-10-15）。
- **閒置更新。**畫面沒有變化的更新，ScreenCaptureKit 會以沒有畫面的 idle 影格回報。若它落在某個格位，就把最新畫面在該處再編碼一次（`frame_unchanged`），與 Chromium 重複一格的做法相同，而不是讓該格位晚一次更新才拿到下一個畫面。2026-10-16 停止報告新增的計數顯示，擷取從未漏掉任何一次更新（畫面之間最長 33.3 ms），但每 15 秒送出 15–37 個 idle 影格，而 60 Hz 螢幕上 30 fps 的每一個 50 ms 間隔都落在 idle 更新上。
- **靜止畫面。**畫面沒有變化時，每秒再編碼一次最後的影格（`REFRESH_NS`），因此仍然每秒有一個關鍵影格、片段持續關閉，`progress` 也持續送到停滯保護。
- **停止。**只保留時間早於停止點的影格。pacer 略過的最新變化會以它自己的擷取時間編碼在停止點之前，因此持續到影像結束；muxer 自己丟棄較晚樣本的機制仍保留作為防護。

停止報告與 host 的 timing 行一起寫入 log：影格比主機時鐘提前多少被標記（平均與最大值），以及 `capture delivered N pictures and M frames without one, X ms apart at most`。在 60 Hz、1920×1080 的螢幕上量測：掉格在 30 fps 為 0.00%、60 fps 為 0.06–0.22%（2026-10-14，Chromium 為 0.00% 與 0.14–0.22%）；`pnpm matrix -- quick` 中 30 fps 有 0.66–2.17% 的影格間隔 50 ms，Chromium 為 0（2026-10-15），修正閒置更新後為 0.22–0.44%，CPU 不變（2026-10-16）。剩下部分的原因尚未找到；plan 078 會追蹤，並處理原生的節奏診斷，目前除了停止報告之外還沒有。同一台機器的錄影 CPU（2026-10-16，`pnpm measure:cpu -- --fps 60 --repeat 3`）：30 fps 為一個核心的 10.4%，60 fps 為 14.0%，Chromium 為 15.3% 與 23.3%。

## 音訊

音軌的輸入是系統音訊（預設為系統播放的所有聲音，RecordStuff 除外）、選定 App 的聲音或不收系統音訊，以及麥克風；全部混入同一條 AAC 音軌。只有預設值面向使用者：選定 App 的聲音只存在於引擎與其測試中（`RECORDSTUFF_CAPTURE_AUDIO` 是開發用開關）；麥克風（預設裝置或指定 ID，由 `microphones()` 列出輸入）已為 plan 074 建進引擎，其設定、macOS 的使用說明與音訊輸入 entitlement 由 074 加入。在 macOS 上，系統尚未詢問過存取權時麥克風會拒絕開啟，因為 AVFoundation 此時只會送出靜音；兩個平台都尚未測試麥克風的聲音。

- **擷取。**macOS 的系統音訊來自畫面的 `SCStream`（48 kHz 立體聲浮點、`excludesCurrentProcessAudio`），其過濾器已排除 RecordStuff 的 App，因此也排除了它們的聲音；當畫面的過濾器不是聲音的過濾器時（單一視窗、選定 App，或選定 App 的聲音），改由另一條有自己過濾器、只收音訊的 stream 提供。Windows 為 WASAPI process loopback（Windows 10 2004 以上），收錄 RecordStuff 程序樹以外的一切，以 48 kHz 立體聲浮點開啟，由音訊引擎轉換。兩條路徑都不做語音處理；隱藏 renderer 需要明確的條件才能關閉它（見[音質設計](audio-quality.md)）。2026-10-15 的 `pnpm audio:quality` 在原生與 Chromium 下都通過所有檢查，時鐘偏差原生為 −0.07 ppm，Chromium 為 −1.45 ppm。
- **單一時鐘。**所有時間戳都是以奈秒計的主機時間（mach absolute time；QueryPerformanceCounter），從 `record` 時的零點起算（[timing.rs](../../../native/capture/src/timing.rs)）。比照 Cap，音訊以累計樣本數定位：第一個緩衝區精確定位，之後每個都接在上一個結束處，除非其時間戳偏差超過 10 ms（480 個 frame），此時以靜音填補空隙或丟棄重疊部分。因此不論錄多久，音訊相對影像的漂移都不會超過這個容許值：10 分鐘的錄影量到 0 ms 漂移，600 組閃光與嗶聲全部對上，每個檔案的音訊與畫面長度都相同（2026-10-14）。
- **混音器。**音軌是各輸入在單位增益下的立體聲總和：不重新取樣、不合併聲道、不調整音量；只有一個輸入時就是該輸入的樣本本身（[mixer.rs](../../../native/capture/src/core/mixer.rs)）。它推進到每個輸入都已送達的位置，因此延遲不同的輸入仍能對齊；同時也隨時鐘推進，落後時鐘 500 ms，把輸入到那時仍未送達的部分視為靜音：WASAPI 的 loopback 在沒有聲音播放時不送封包，沒有這一點音訊片段就得等下一個聲音。送達時對應部分已混好的聲音會被丟棄並計數；有這種遲到的 frame 時，停止的 log 行會依輸入列出。
- **Edit list。**檔案的 edit list 跳過 AAC 編碼器的 priming，因此顯示時間 0 就是第一個擷取到的影格。AudioToolbox 會回報它的 priming；Media Foundation 的則在建立編碼器時量測（CI runner 上為 0 個 frame，未在 Windows 實機確認）。
- **到停止為止。**`stop` 時音軌在停止點的樣本數處截斷；擷取繼續執行，直到停止前的聲音都已送達，最多 250 ms，因為擷取交出音訊會晚幾十毫秒。到那時仍未送達的部分是靜音，log 會記下排空花了多久、補了多少 frame。因此音軌與影像一樣長。

## 訊息與停止順序

<a id="分片與停止順序"></a>

```mermaid
sequenceDiagram
    participant U as 使用者
    participant R as Recorder
    participant N as NativeCaptureHost
    participant P as 擷取程序（引擎）
    participant W as EngineFileWriter
    U->>R: toggle 開始
    R->>W: 預留 .recording.mp4
    R->>N: start(id, quality, path)
    N->>P: fork；ready
    N->>P: start(id, quality, native)
    P-->>R: prepared(capture)
    Note over R: 倒數 N 秒（歸零前 300 ms overlay 離開）
    R->>P: record(id)
    P-->>R: started(id)
    loop 媒體送達期間約每秒一次
      P-->>R: progress(id, bytes)
    end
    U->>R: toggle 停止
    R->>P: stop(id)
    P-->>R: stopped(id)
    Note over R: idle；存檔在背景繼續
    R->>W: finish
    P-->>N: finished(id, file) 或 writeError
    N-->>W: 檔案的結果
    W-->>R: 正式路徑（連結或複製）
    R-->>U: saved 通知
```

每則訊息都帶 session id，Recorder 只處理目前 session 的訊息；其他 session 的 `prepared`、`started` 或 `progress` 會讓它停止那個 session。程序只對自己的嘗試回應：已有 session 時的 `start`，或對未 prepared 的 session 送來的 `record`，都以 `capture_start_failed` 拒絕；重複的 `record` 會被忽略。協定沒有序號，因為沒有媒體經過它：檔案由引擎寫入，`progress` 只回報目前已寫入的位元組數。

引擎準備期間收到 `stop` 會把 session 標記為已取消；host 在 `prepare` 返回後取消引擎並回 `stopped`。prepared 時收到 `stop` 會立即取消；檔案保持空白，由 main 刪除。錄影中收到 `stop` 時呼叫引擎的 `stop`：它在那一刻結束兩條音軌（見[音訊](#音訊)、[影格節奏](#影格節奏)）、停止擷取、flush 編碼器並要求 writer 完成檔案；擷取結束時它就回覆，host 寫下停止報告並送出 `stopped`，接著呼叫 `finish`，它在檔案轉成一般 MP4、或確知為何沒有轉成時回覆，host 再送出 `finished`（位元組數、停止後經過多久，以及仍為分段格式時的原因）或 `writeError`。兩者分開（2026-10-15）讓慢速磁碟的存檔不受 10 秒停止期限約束：plan 076 的第一個原型在 `stopped` 前就完成檔案，這種存檔會被當成 `stop_timeout` 終止。錄影中的擷取失敗會送出帶 `capture_failed` 的 `error`；寫入失敗會送出帶 `disk_full` 或 `output_write_failed` 的 `writeError`；兩種情況下，除非 finalizer 已接手，Recorder 都會讓 session 失敗。

## 寫檔與失敗

引擎的 writer（[writer.rs](../../../native/capture/src/writer.rs)）是一條擁有檔案與 muxer 的執行緒。擷取與編碼器的 callback 透過 channel 把編碼後的樣本交給它，從不等待磁碟，因此緩慢或卡住的磁碟無法拖住擷取，忙碌的 main 事件迴圈也不會延遲寫入。它每 5 秒 sync 一次檔案（與 main 的 FileWriter 過去相同），並在媒體送達期間每秒回報一次已寫入的位元組數。第一個 I/O 錯誤依 main 的 `classifyWriteError` 的命名分類（ENOSPC、Windows 的磁碟已滿錯誤與 Rust 的 `StorageFull` 為 disk_full，其餘為 output_write_failed），以 `writeError` 回報一次，之後不再寫入任何東西；已寫入的內容保留。等待寫入磁碟的媒體上限為 64 MiB（`BACKLOG_LIMIT_BYTES`）：超過後 writer 拒絕之後的所有媒體，因此檔案不會出現缺口，並以 output_write_failed 與積壓 detail 回報。不暫停、不丟棄、不重試，因此持續低於位元率的磁碟吞吐量會以保留部分檔結束錄影，而不是無限制占用記憶體。沒有磁碟空間預留、切換資料夾、降低品質或無限長錄影承諾。

收到引擎的結果後，`EngineFileWriter.finish` 檢查檔案大小，以硬連結把它發布成 `.mp4`；正式檔撞名時依序嘗試 `-2`、`-3` 等尾碼（[publishRecording](../../../src/main/recording/file-writer.ts)）。連結不會取代既有名稱（EEXIST 就換下一個尾碼，最多到 `-100`；之後存檔以 output_write_failed 失敗並保留 `.recording.mp4`），耗時固定且不需要剩餘空間，因此 15 秒與一小時的錄影儲存所需時間相同，低空間提前停止也仍能儲存。儲存的檔案就是錄影寫入的那個檔案，所以建立時間是錄影開始的時間。若磁碟區因其他原因拒絕連結，例如 exFAT（ENOTSUP）或部分網路磁碟區，這個與之後每個尾碼都改用排他複製（`COPYFILE_EXCL`），複本 sync 後才移除暫存名稱；複製耗時與檔案大小成正比，且需要與檔案同樣大小的剩餘空間。發布失敗時，ENOSPC 與其他寫入一樣回報 disk_full，其餘回報 output_write_failed。程式仍要求 `COPYFILE_FICLONE`，但在 macOS 上從不會 clone：libuv 在 macOS 沒有實作 clone（Electron 44 中 `COPYFILE_FICLONE_FORCE` 回傳 ENOSYS），所以 plan 037 之前每次儲存，包括 APFS，都是完整複製。發布後盡力刪除暫存名稱，之後 Recorder 才以實際存檔路徑發 saved。清理失敗會留下暫存名稱，它是已儲存檔案的第二個連結（改用複製時則是完整副本），但不影響已成功儲存的影片。log 的 `finalize timing` 行記錄 host 停止、等待引擎結果、引擎的收尾（`to plain MP4`，或 `kept fragmented (<原因>)`）、main 的大小檢查、發布（`by link` 或 `by copy (link <code>)`）、清理與 checkpoint 各花多少時間，以及位元組數；其中 `flush` 一律為 0，因為引擎自行 sync 它的檔案。

成功必須有非空媒體，而唯一的發布步驟 `EngineFileWriter.finish` 就是關卡。引擎在第一個影格編碼前不寫入任何東西，因此在那之前停止會留下零位元組。引擎的寫入錯誤，或它沒有完成檔案就結束的原因，優先以原代碼回報（沒有代碼的原因為 output_write_failed）。否則零位元組的檔案會被刪除，finish 以 `capture_start_failed` 與 detail `capture ended without media; no bytes were written` 拒絕，與首份媒體期限使用同一代碼；若取消或退出曾要求開始後停止，則這次嘗試改以該取消收場。Recorder 把這個拒絕導入單一失敗流程，因此不發 saved，也不產生 `.mp4`，可立即重試。Abandon 具冪等性，失敗流程稍後的清理不會刪掉在同一秒內重用該檔名的重試錄影。沒有最短錄影秒數；非常短但非空的錄影照常儲存。

非空只是必要的最低門檻，不代表檔案可播放。引擎以時間零點的關鍵影格開始檔案，並在停止點結束兩條音軌；Cap 的 AVFoundation writer 同樣[在沒有最後影格時拒絕 finish](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/enc-avfoundation/src/mp4.rs#L961-L990)（該 revision 的靜態檢視），但執行期沒有任何東西會解碼檔案。可播放性只由驗收時的媒體檢查（如 ffprobe 與完整解碼）確立。

失敗時先清除 session、清除期限、stop host 並讓 UI 回到 idle，再 abandon writer：它讀取檔案大小，非空檔案以暫存名稱保留並回報為部分檔路徑，空檔案盡力刪除，無法讀取大小（檔案已不存在除外）則標記保留狀態無法確認。錄影中失敗留下的部分檔通常就是寫入時的分段檔，因為嘗試 teardown 時擷取程序會被結束。部分檔案沒有自動修復或重新封裝。排他建立保護暫存名稱與每一個正式檔名。完整寫入與 fsync 耐久性是不同保證，不承諾所有 crash、斷電或檔案系統故障都可復原；更完整的耐久性需求應先建測試，再改實作。

可用空間保護讀取輸出資料夾的 `fs.statfs`。低於停止門檻時要求正常停止，讓檔案在仍有空間時完成並發布；saved 事件帶有 `stoppedEarly: "lowDisk"`，log 會註明，存檔通知顯示「已儲存 {file}。磁碟空間即將用盡，已提前停止錄影」。這類錄影屬於成功，不進入失敗紀錄。若發布仍失敗，沿用一般失敗流程與部分檔保留。

睡眠也用同樣的方式處理（plan 050）。從 `starting` 到狀態回到穩定之前，main 會持有一個類型為 `prevent-display-sleep` 的 `powerSaveBlocker`（[keep-awake.ts](../../../src/main/recording/keep-awake.ts)），因此閒置造成的螢幕睡眠與系統睡眠不會結束擷取；每一條回到 idle 或 needsPermission 的路徑與 `will-quit` 都會釋放它，log 會記下每個 blocker。使用者要求的睡眠（Apple 選單 →「睡眠」、沒有外接螢幕時闔上筆電、電源鍵），以及低電量或過熱造成的睡眠都無法拒絕，035 的 N31 量到擷取在睡眠開始後約 150 ms 結束。所以 `powerMonitor` 的 `suspend` handler 只先設定 tray 的通知保留，接著在任何 log 之前呼叫 `Recorder.systemWillSleep()`，而 `stop()` 會在 `stopping` 狀態傳給訂閱者之前就把停止送到 host：錄影中時以 `stoppedEarly: "sleep"` 要求正常停止，因此檔案會像一般停止一樣發布，存檔通知顯示「已儲存 {file}。Mac 進入睡眠，已停止錄影。」；倒數會立即以 `sleep` 為原因取消，仍在準備的嘗試則在 `prepared` 到達時取消，因為睡眠不像退出（plan 065）會停止待處理的擷取請求（已被睡眠標記的嘗試，若在 `prepared` 前因其他原因結束，例如 host 錯誤或遺失、螢幕被移除、擷取請求逾時或被拒，或資料夾未在時限內開啟或回報錯誤，也會取消，因為尚未擷取任何內容），已送出 `record` 的嘗試會在擷取開始後立刻停止。引擎只在排空到停止點的過程結束後（最多 250 ms）才忽略擷取失敗；在排空期間結束的 stream 仍會回報 `capture_failed`，仍在 stopping 的 Recorder 會讓 session 失敗。經由隱藏 renderer 時，macOS 在 `suspend` 約 5 秒後才進入睡眠，存檔只花 13 ms（plan 050 的驗收），所以通常會在睡眠前完成；若 Mac 睡著時存檔仍在進行，會在醒來後完成，但計時器在睡眠期間照常計時，停止期限可能已經到期。錄影中睡眠尚未經由原生引擎執行過（plan 077）。醒來後不會接續同一個檔案；Cap 則是把自己的擷取重建回同一段錄影。

`record` 之前不寫入任何東西：引擎在 `prepare` 時開啟預留的檔案，但在 `record` 時才啟動 writer，因此開始失敗或取消只會留下空檔並被刪除，結果為 empty。（隱藏 renderer 的 writer 在可能等待 120 秒的擷取請求之前就開啟並持續 sync，所以它的開始失敗會先排空 writer 最多 2 秒，以回報已保留的磁碟錯誤；現在已不需要。）

中斷證據是每個 session 一個 sentinel 檔，位於 `userData/recording-sessions/`，檔名為 session id，內容為 session id、開始時間與暫存檔路徑。它在建立暫存檔之前以原子寫入完成，因此當機不會留下沒有任何 sentinel 記錄的暫存檔；寫入失敗只記錄一次，不阻擋錄影。為撞名改用後綴時若改寫 sentinel 失敗，會移除前一次嘗試的 sentinel，因為它指向的撞名檔屬於另一個 session。每個終止結果在發布結果後移除該 session 自己的 sentinel，正常退出會等待移除完成。啟動時、在紀錄還原前，先前程序留下的每個 sentinel 都會成為一筆 `app_terminated` 失敗紀錄（「RecordStuff 在錄影期間未正常結束」），其路徑是查找線索，以還原部分檔的相同方式重新檢查：只有該處存在非空檔案時才是 partial，否則為 unknown。紀錄時間為該 session 的開始時間。只有該紀錄已寫入磁碟（包含之後歷史自動重試成功）後，才移除 sentinel，讓失敗紀錄先接手證據，已確認並移除的紀錄也不會再出現；紀錄 ID 由 session 推導，因此紀錄始終未能保存時，下次啟動會重試而不重複新增。單一執行個體鎖與本程序自己的 session 清單確保被回報的 sentinel 都屬於已結束的程序。中斷的 sentinel 寫入或無效內容沒有指向任何媒體，會直接捨棄；啟動時暫時無法讀取的 sentinel，以及較新版本寫下的 sentinel，則保留到之後的啟動。不掃描輸出資料夾中的其他檔案，也不復原、重新封裝或修復任何內容。

### 存檔時轉成一般 MP4

引擎寫的是 hybrid MP4（[mp4.rs](../../../native/capture/src/mux/mp4.rs)、[session.rs](../../../native/capture/src/mux/session.rs)），依 ISO/IEC 14496-12、-14 與 -15 撰寫，沒有取用其他 muxer 的程式碼（plan 076 的 D4 與 D5）。錄影期間，檔案是一個初始化片段（`ftyp`，接著是帶 `mvex`、樣本表為空的 `moov`），之後是一個個片段（`moof` + `mdat`），每個片段以一次附加寫入。各軌獨立分段，依 ISO BMFF 的允許一個片段只含一軌，因此遲到的音訊封包不會拖住影像：影像片段在滿一秒後的第一個關鍵影格關閉，所以每個片段都從關鍵影格開始，音訊片段則每秒關閉。檔案在任何位置被截斷，仍是播放器能讀到最後一個完整片段的分段 MP4，這也就是當機或失敗時保留下來的內容：錄影中終止擷取程序，留下一個 8.0 秒可播放的部分檔，兩軌長度差 147 ms，因為每軌的片段約每秒才寫出一次（2026-10-14）；`pnpm acceptance:lifecycle` 的 `native-crash` 模式持續檢查部分檔有被保留。

分段檔開啟很慢。2026-10-10 實測一支來自隱藏 renderer、36 分鐘、2.7 GB（2,106 個片段，沒有 `sidx` 或 `mfra`）的錄影：Chromium 顯示第一個畫面前，經由 `recordstuff-media:` 花了約 1.1 秒、1,722 次範圍請求、讀取 358 MB，而且每次開啟都重來一次，包括進度條的畫格預覽與全螢幕視窗；同樣的媒體改成一般 MP4 只要 27–41 ms、14–17 次請求、14–19 MB。在檔尾補上 `mfra` 沒有幫助，Chromium 仍會讀過每個片段。AVFoundation（QuickTime、快速查看）完全無法開啟那個分段檔（`-11832`），一般 MP4 則可以。所以檔案在發布前就地轉成一般 MP4，做法與 OBS 的 hybrid MP4 相同（[`mp4_mux_finalise`](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/plugins/obs-outputs/mp4-mux.c#L2967-L3028)，該 revision 的靜態檢視）。錄影期間 muxer 記下每個樣本的大小、長度與同步旗標，並把每個片段當成一個 MP4 chunk（`stsc` 的一段）；`finish` 時，先 sync，然後：

1. 在檔尾附加完整的 `moov`：每個樣本在原處的樣本表（超過 4 GiB 用 `co64`）、實際長度、跳過 AAC priming 的 edit list，並拿掉 `mvex`。接著 sync。
2. 把舊 `moov` 的前 16 個位元組改寫成 64 位元的 `mdat` 標頭，涵蓋從該處到新 `moov` 之前的全部內容，讓檔案依序為 `ftyp`、`mdat`、`moov`。接著再 sync 一次。

過程中不複製也不搬移資料，除了索引本身不需要額外空間，所以存檔時間仍然固定。若在兩步之間中斷，檔案是「分段檔加上未使用的檔尾索引」，播放器仍照以前讀取。muxer 絕不留下播放器讀不了的檔案：索引寫不進去時，把檔案截回原本的分段檔；標頭寫不進去時，放回原本的 16 個位元組；這些情況下都以分段格式發布，並在 `finished` 與 `finalize timing` 行寫出原因（`index not written: …`、`header not written: …`、`header not confirmed: …`）。因積壓而拒絕過媒體的 writer 不會完成任何東西：檔案照寫入時的樣子保持分段格式，存檔以失敗收場。OBS 沒有任何寫入屏障，這裡每一步都先 sync 才進行下一步，存檔通知也在兩步之後才發出。暫存的 `.recording.mp4` 自始至終是同一個檔案，所以任何時間點中斷留下的證據都相同。部分檔案仍是分段格式，不會被改寫。

Cap 走另一條路：它把 DASH 片段錄進一個資料夾，停止後在背景複製成新的 MP4（[remux.rs](https://github.com/CapSoftware/Cap/blob/8d808e09e0541efdf5e8318f57bbf3b2ed88bc76/crates/enc-ffmpeg/src/remux.rs)，該 revision 的靜態檢視），期間由編輯器直接播放片段；RecordStuff 存的是使用者可以立刻打開的單一檔案，所以採用 OBS 的就地收尾。同樣的收尾最初以 TypeScript 針對 MediaRecorder 的片段實作（`mp4-finalize.ts`，2026-10-10 以四支真實錄影串流通過它、並以 ffmpeg `framemd5` 比對每個封包驗證）；引擎的 muxer 在 Rust 測試中延續了它的案例（64 位元 `mdat`、索引、索引寫入失敗時維持分段），TypeScript 模組則隨隱藏 renderer 移除。

## 錯誤分類

| 類型 | code | 對使用者的結果 |
| --- | --- | --- |
| 權限／環境 | permission_denied、unsupported_os_version | 引導系統設定／重啟或說明版本 |
| 來源／編碼 | no_display、display_unavailable、no_audio_track、mp4_unsupported | 不開始錄影，說明缺少能力 |
| 擷取 | capture_start_failed、capture_failed、capture_host_crashed、capture_host_unresponsive | 回 idle；有部分檔則提供位置；`record` 前任何擷取中斷都是 capture_start_failed，結果為 empty |
| 檔案 | output_open_failed、output_write_failed、disk_full | 說明位置／磁碟問題，盡力保留 bytes |
| 停止 | stop_timeout | 停止等待擷取回覆並盡力保留部分檔 |
| 先前程序 | app_terminated | 只在啟動時依中斷 sentinel 回報；說明 App 未正常結束、檔案可能不完整；擷取 host 永遠不會送出 |

各代碼的來源：引擎以 `code|detail` 拒絕，host 只轉送 `HOST_ERROR_CODES` 中的擷取代碼（其他一律成為 `capture_start_failed`），寫入錯誤也只轉送 `disk_full` 或 `output_write_failed`。

- `permission_denied`：macOS 上可分享內容的查詢被拒，或 stream 以 `-3801` 拒絕啟動。macOS 回報已授權卻仍收到 `permission_denied` 時，將目前的程序標記為需要重新啟動（PermissionWatcher）。
- `unsupported_os_version`：main 的 preflight，macOS 13 之前。
- `no_display`：引擎找不到 main 選定的螢幕（macOS：其 ID 不在可分享的螢幕中；Windows：沒有螢幕包含該座標點）。`display_unavailable` 是 main 自己的拒絕（見[螢幕選擇](#螢幕選擇)）。
- `no_audio_track`：Windows 上系統音訊 loopback 沒有給出 client。`mp4_unsupported` 仍是 host 代碼，但沒有任何引擎路徑會回報它。
- `capture_start_failed`：`record` 之前的其他所有失敗，包括無法建立的來源或編碼器、無法啟動的 stream、3 秒內沒有第一個影格、Media Foundation 無法啟動、模組載入失敗（程序在 `ready` 前以代碼 3 結束），以及無媒體關卡。
- `capture_failed`：stream 帶錯誤停止、擷取的項目關閉、錄影中編碼器失敗；main 也以它表示停滯、螢幕被移除，以及非它要求的 `stopped`。
- `capture_host_crashed`（session 期間程序結束）與 `capture_host_unresponsive`（兩次 ping 未回）是 main 自己的判定，資料夾、磁碟與期限代碼也是。

Main 只在自己的拒絕能解釋時才以拒絕原因取代 host 錯誤：`DisplayMedia.explain` 把 `capture_start_failed`、`permission_denied` 與 `no_display` 換成 main 這次拒絕螢幕的原因，且只換一次。

## 螢幕選擇

`display-source.ts` 分開處理 Screen API 的目前目標與錄影來源配對。指定螢幕保存 `{ kind: "display", id, label }`，名稱只供顯示。目標缺失或 id 重複立即拒絕；來源缺失／重複或配置變更每隔 150 ms 重試，最多列舉三次。列舉例外經 `failed` 回報，並以 `capture_start_failed`（`source_missing`）拒絕這次嘗試，不當成權限問題。掛住的列舉仍受 recorder 的開始逾時限制；作業結束或被新作業取代會取消 callback 與重試計時器，延遲結果不能授予錄影或覆寫診斷。`display-media.ts` 保存跨作業的狀態：偏好快照、用來解釋下一個 host 錯誤的拒絕原因、監看是否被移除的使用中螢幕（也是倒數 overlay 出現的螢幕），以及螢幕診斷。Recorder 在 session 開始時啟動一次 `DisplayMedia` 作業，`NativeCaptureHost` 在擷取程序啟動的同時向它取得螢幕；為已 teardown 的嘗試選出的螢幕，會被 host 的世代檢查丟棄。

`display_unavailable` 表示無法安全解析精確目標，另以 `target_missing`、`source_missing` 或 `topology_changed` 區分原因。不按名稱、尺寸或位置配對，也不自動改寫 id；id 被重用並不能證明同一實體硬體。引擎收到的是 Electron 的螢幕 ID，在 macOS 上就是 ScreenCaptureKit 列出的 `CGDirectDisplayID`；在 Windows 上這些 ID 不對應任何顯示器，因此 main 另外傳入螢幕中心的實體座標點（`screen.dipToScreenPoint`），引擎錄製包含該點的顯示器。螢幕資料是 DIP 邏輯尺寸與縮放比例；輸出尺寸來自引擎以像素 probe 的結果與解析度上限。

螢幕移除由 main 的拓樸監看發現，它以 `target_removed` 診斷走 recorder 的冪等 `capture_failed` 路徑，保留部分檔而不切換來源；引擎也可能先回報自己的結束（macOS：stream 帶錯誤停止；Windows：擷取的項目關閉）。隱藏 renderer 在 video track 結束時送出的結構化 `displayFailure: "track_ended"` 仍為協定所接受，但原生 host 從不送出。正常停止已送出後（不論 host 是否已回覆、檔案是否已在 finalize）的螢幕移除不產生失敗或診斷：由停止回覆或其期限決定結果，檔案保留停止前錄到的內容。經由原生引擎的螢幕移除尚未在實機測試（plan 077）。

失敗呈現獨立於終止事件：failureStatus 立即回報 pending，清理後回報 partial／empty／unknown；saved／failed 仍為終止契約。無法讀取大小會設定 preservationUncertain，不得顯示為已確認保留。見[錄影失敗結果](desktop.md#錄影失敗結果)。

失敗 ID 使用跨 Recorder 實例的 UUID。清理中事件在已知時帶入 writer 候選路徑；完成事件在沒有內容時移除候選資訊，無法確認時保留為查找線索，只有確認保留才提供部分檔案路徑。保存的各筆結果在重啟後將中斷清理呈現為無法確認，不會一直處理中或宣稱儲存成功。

## 自身視窗與系統介面

RecordStuff 自己的視窗（包括開始後才開的，例如倒數 overlay 與 Settings）會被排除在每一段錄影之外，且無法關閉（075 的 D14，於 2026-10-15 移入 plan 076）。

- **macOS。**螢幕的 `SCContentFilter` 排除 RecordStuff 的 App：main 傳入的程序 ID 所屬的 App，以及 bundle identifier 以 main 的 bundle identifier 開頭的所有 App，涵蓋其 helper。排除整個 App 而非列出視窗，也會排除之後才開的視窗及其聲音。畫面外的視窗也會讀取，因為沒有可見視窗的選單列 App 否則不會出現在可分享的 App 中。找不到 RecordStuff 時，報告會警告其視窗可能被錄進去；從開發用 Electron App 錄影時會記下這個警告，已簽署的 bundle 則回報 `1 own app(s) excluded`，原因由 plan 078 追查。2026-10-16 在主螢幕錄影開始一秒後開啟的 Settings 出現在截圖上，卻不在同一時刻的錄影影格中，該影格顯示的是它後方的視窗；選單列上 RecordStuff 的 App 選單也被排除，但它的狀態列項目仍在，075 的 D14 指出沒有產品會隱藏自己的狀態列項目。
- **Windows。**Windows.Graphics.Capture 錄的是整個螢幕，無法排除其他程序的視窗，因此 main 從 `start` 起到嘗試 teardown 為止，以 `setContentProtection(true)` 標記自己的視窗，在 Windows 上即 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`（Windows 10 2004 之前顯示為黑色）；期間建立的視窗會在出現時標記。擷取程序結束後，或要求結束後最多 5 秒，視窗恢復可擷取，因此錄影之間仍能截取 Settings；之後嘗試的排除絕不會被較早嘗試的恢復解除。未在 Windows 實機測試。

D6「隱藏選單列與 Dock」（「設定 → 錄影」中「螢幕」之後，預設關閉，錄影中鎖定，以 `hideSystemUi` 保存；2026-10-14 決定）讓錄影排除系統外框，而使用者仍看得到它們：選單列與其狀態列項目、Dock、桌面圖示與小工具。過濾器把它們的視窗（位於 Dock、主選單與狀態視窗層級的視窗，以及 Finder 與通知中心位於一般層級以下的視窗）列為例外，並在 macOS 14.2 以上關閉 `includeMenuBar`；較舊的 macOS 會在 warnings 說明無法這樣做。App 開啟中的選單是該 App 位於這些層級之上的視窗，所以仍會被錄進去，設定的 ⓘ 也這樣說明。預設關閉，是因為更新後既有的錄影結果不應改變，而使用者預期錄下的就是螢幕上的內容。2026-10-15 引擎回報隱藏了 35 個系統視窗，影格中原本選單列的位置顯示的是桌布；該回合 Dock 不在畫面上，因此 Dock 的排除由 plan 077 驗證。只有 macOS 會把這個開關交給引擎；Windows 上該列顯示為「隱藏工作列」且不可用，因為 Windows.Graphics.Capture 無法排除工作列，也不做任何裁切。

## Windows 細節

Windows 模組（[native/capture/src/win](../../../native/capture/src/win)）與 macOS 共用核心、時鐘、混音器、writer 與 muxer；不同之處如下：

- 擷取：以 Windows.Graphics.Capture 擷取包含 main 座標點的顯示器，包含游標，系統允許時不顯示黃色邊框。每個 BGRA 影格立即在 GPU 上由 Direct3D 11 視訊處理器轉成錄影尺寸的 NV12（縮放、BT.709 limited range）；只有要編碼的影格才讀回記憶體。沒有視訊處理器的裝置（WARP，例如虛擬機或沒有 GPU 的 runner）會把每個影格複製到 staging texture，編碼的影格再於 CPU 上轉換。擷取的項目關閉時，錄影以 `capture_failed` 結束。
- 編碼：Media Foundation 的軟體 H.264 編碼器在自己的執行緒上執行，其 Annex B 輸出轉成 muxer 用的長度前綴樣本；AAC 編碼器只接受 16 位元 PCM 與 96–192 kbps，因此 256 kbps 的目標會降為 192 kbps 並附上警告，其 priming 在建立時量測。
- 聲音：WASAPI process loopback 收錄 RecordStuff 程序樹以外的一切，與 macOS 一樣讓倒數提示音不進入錄影；沒有聲音播放時它不送任何東西，由混音器的時鐘補上。
- 幀率：只有 30 fps（`isFrameRateAvailable`）。
- 驗證只靠 CI（plan 076 的 D8，維護者於 2026-10-14 決定）。`windows-2025` 上的 `native-windows` job 執行 `cargo test`、解碼合成檔案，並以 live test 錄製螢幕、區域、視窗與單一程序的聲音；`pnpm check` 載入模組，安裝程式 smoke 載入已安裝的模組。在 runner 上（沒有 GPU，1024×768 的螢幕走 CPU 轉換）三秒的錄影得到可解碼的檔案，兩軌都是 3000 ms，AAC priming 為 0 個 frame。未在 Windows 上測試：真實的擷取品質與影格時序、視訊處理器與任何硬體路徑、影格中是否沒有自身視窗、系統音訊內容與音畫同步、麥克風（runner 沒有）、多螢幕的 DPI、CPU、長時間錄影，以及 session 結束時的阻擋。這些留待使用者回報。

## 稽核加固

「取消錄影」也可取消資料夾開啟與擷取準備；重複的開始切換在 start 的第一秒內忽略，之後會取消這次 start（plan 065）。失敗的 prepare 會停止它已啟動的 stream。`EngineFileWriter.finish` 只執行一次並共用同一個 Promise；abandon 具冪等性，且在 finish 之後只有 finish 失敗時才保留檔案，避免重複的終止呼叫刪到較新的錄影。

完整複製發佈前，先確認可用空間至少有整個錄影大小加 8 MiB。複製後的 open／sync／close 失敗會移除目的檔，保留原始錄影。成功發佈後先持久化 finalized-path checkpoint 再刪 sentinel；下次啟動遇到完成 checkpoint 不再誤報中斷。發佈與 checkpoint 之間的小型崩潰空窗無法證明完成，因此未完成 sentinel 明確說明完成狀態未知，可能已有正式檔。失敗時也一樣，會在發布失敗紀錄之前先把它的 id 記到 sentinel（`failureId`）：失敗的清理還在進行時程序就結束了（例如分享磁碟卡住後被強制結束），下次啟動會以同一個 id 回報留下的 sentinel，因此失敗紀錄只有一筆：已儲存的那筆，或在它沒能儲存時改用 sentinel 的那筆（2026-10-05）。

退出保護在第一次可互動的非同步等待之前安裝。媒體安全後，設定、視窗尺寸與 log 佇列最多等待五秒 flush；逾時延後退出並重新開放操作。解析度上限無法確認時，會在設定的「螢幕」列顯示，直到下一次錄影開始或改選其他螢幕或解析度上限為止，並在該次錄影結束後以通知告知（[desktop](desktop.md#tray-與通知)），詳細擷取警告則保留於 log；但只有報告帶 `capUnconfirmed` 時才會出現，而原生引擎從不設定它（見[品質與編碼](#品質與編碼)）。
