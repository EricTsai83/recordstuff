# 函式與方法設計索引

[English](../../system-design/functions.md) | [繁體中文](functions.md)

以下按原始碼檔案說明具名函式及方法的契約。型別、參數的完整 TypeScript 宣告由各檔案連結查閱；這裡記錄輸入如何變成結果、狀態及副作用。constructor、getter 與流程內具名 helper 也列出；匿名 callback 的順序見 [錄影管線](recording.md) 與 [桌面功能](desktop.md)。

## App 組裝 — main/index.ts

[原始碼](../../../src/main/index.ts)。`main()` 裡的動作函式閉包共享 settings、recorder、tray；它們不是可由 renderer 任意呼叫的 API。

| 函式 | 輸入 → 結果與設計 |
| --- | --- |
| `defaultOutputDir()` | Electron videos 路徑 → 加上 RecordStuff；不在此建立資料夾 |
| `osSupported()` | process.platform／Darwin release → boolean；macOS major ≥22，其他平台目前直接 true |
| `isFirstRun(userDataDir)` | 以 wx 建 marker；首次成功為 true，已存在或 I/O 失敗為 false；只用於 Windows 提示 |
| `renderUi(state)` / `refreshUi()` | 狀態改變或 context 改變時，Tray 與設定面板一起更新 |
| `resourcesDir()` | packaged → resourcesPath；開發版 → appPath/resources |
| `displays()` | 將 Electron 已連接螢幕轉成共用模型，不列舉擷取來源 |
| `displayChanged()` | 把目前連線的螢幕 id 交給 DisplayMedia；使用中的螢幕移除時讓錄影失敗，並刷新 UI |
| `main()` | 等 ready、組裝依賴、建立 Tray／watcher、註冊動作與退出；錯誤事件寫 log |
| `quality()` | 開發記憶體 override 或已保存設定 → 平台可用的有效品質 |
| `handleAction(action)` | 字串 action、失敗紀錄動作，以及每一種偏好變更 → 對應 stop／quit／設定／relaunch／Finder 動作；偏好一律經 `savePreference` 或 `AppShortcuts.set` |
| `savePreference(what, save)` | 單一偏好寫入：`locked` 的偏好需要 recorder 已 settle；等待寫入，失敗留 log 並在 tray 有對應通知時通知；之後兩個投影一起 refresh |
| `focusApp()` | 對話框或視窗出現前先讓選單列 App 取得前景（macOS），避免開在最前面的 App 後方 |
| `showSavedRecording(path)` | 存檔通知的點擊：重新列出資料夾並開啟「錄影檔」、帶出那段錄影；若之後被移動或刪除，則顯示資料夾目前的內容 |
| `revealLog()` | 有 log 選檔，沒有則開 logs 目錄；開啟失敗留 log |
| `changeOutputDir()` | 系統對話框 → 保存使用者選擇，失敗通知；成功清位置錯誤並 refresh |
| `openOutputDir()` | 設定中儲存位置的「在 Finder 中顯示」：以 `shell.openPath`、原生警告、App focus 與經 settled 檢查的 `changeOutputDir` 組成 `createOutputFolderOpener` |

[main/output-folder.ts](../../../src/main/output-folder.ts)：`createOutputFolderOpener` 回傳同時只進行一次的開啟動作。先 stat 資料夾：是資料夾就開啟；不存在的已知預設資料夾，只在上層資料夾存在時以非遞迴 `mkdir` 建立；不存在的自訂資料夾、檔案、建立被拒、無法讀取的路徑或 Finder 失敗，都變成一則附路徑、詳細資訊與「更改儲存位置／取消」的在地化警告；錄影工作仍在進行時，改為記入 log 並由 `CaptureNotices` 保留成通知告知，因為模態警告會卡住那些工作。存取被拒時仍先請 Finder 開啟。永遠不寫入設定；重複點擊會併入進行中的那次，警告開著時把它帶到前景。`nodeOutputFolderFs` 是真正的 stat／mkdir 邊界。

事件：uncaughtException 留 log，第一次另顯示對話框；unhandledRejection 留 log；`main()` 失敗時留 log、顯示對話框並結束程序。Recorder state／saved／captureStarted／failed／permissionRequested 分別更新 Tray、發通知、處理降級與失效授權。tray 左鍵與全域快捷鍵共用同一個 `toggle` closure。Recorder 取得 `fs.statfs` 可用空間與 `userData/recording-sessions` sentinel；啟動時經由歷史還原回報遺留 sentinel，`powerMonitor` 的 suspend／resume 連同進行中 session 寫入 log。before-quit 忙碌時等待 shutdown；will-quit 釋放快捷鍵與其他資源。

## 螢幕選擇

[main/display-source.ts](../../../src/main/display-source.ts)：`resolveDisplayPreference` 解析保存的主螢幕或指定目標；`selectScreenSource` 要求恰好一個來源的 display id 與解析出的主螢幕或指定螢幕相符，不做回退。`DisplayRequest.run` 在來源列舉前後檢查配置，兩種偏好在來源缺失或配置變更時都最多嘗試三次，callback 只結算一次，途中拋出例外時也一樣（經可選的 `failed` 依賴回報）。`cancel` 結算等待中的 callback 並清除重試延遲。`displayResolution` 讓 tray 與設定共用可用性判定。

[main/display-media.ts](../../../src/main/display-media.ts)：`DisplayMedia` 保存跨錄影嘗試的 display-media 狀態。`begin(sessionId)` 取消前一個請求並快照保存的螢幕偏好；`answer(owns, callback)` 只替本次嘗試擁有的 frame 執行 `DisplayRequest`，否則不給來源；`explain(code)` 以 main 的拒絕原因取代一個可解釋的 host 錯誤；`settle()` 取消未完成的工作並停止監看使用中的螢幕；`topologyChanged(connectedIds)` 推進配置世代，並回報錄影中的螢幕是否已中斷連線。`failure` 是 tray 與設定顯示的螢幕診斷。

## 狀態機 — main/recorder.ts

[原始碼](../../../src/main/recorder.ts)。所有依賴可注入，便於不用 Electron 測 session 競態、I/O 與計時。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `formatTimestamp(date)` | Date → 本地時間安全檔名，不使用 UTC |
| `errorCodeOf(cause, fallback)` | 已知 cause.code → ErrorCode；其他回 fallback |
| `Recorder.constructor(deps)` | 補 clock、id、timeout、log 預設並訂閱 host 訊息／故障 |
| `state` getter | 回目前權威狀態；不得由 Tray 另外維護一份業務狀態 |
| `sessionId` getter | 進行中的 session id，供睡眠／喚醒 log 等診斷使用 |
| `subscribe(listener)` | 加入事件集合 → unsubscribe 函式 |
| `toggle()` | idle 開始、recording 停止、倒數中取消、needsPermission 發引導事件、已啟動至少 1 秒（`START_CANCEL_GRACE_MS`）的開始會被取消，其餘忽略 |
| `cancelCountdown(reason)` | `record` 前取消這次嘗試；之後改為擷取開始後停止；錄影中才到達的選單「取消錄影」會停止錄影；其餘忽略 |
| `stop()` | 僅 matching recording session → stopping（記下要求停止時間），設 stop timeout，送 stop，再發布 stopping |
| `systemWillSleep()` | Mac 即將睡眠（plan 050）：錄影中以 `stoppedEarly: "sleep"` 停止，倒數中或準備中的嘗試以 `sleep` 取消，arming 中的嘗試在擷取開始後停止；stopping 或沒有 session 時不動作 |
| `shutdown()` | 立即取消開檔、準備中或倒數中的嘗試（plan 065）、`record` 後保留停止意圖、停止 recording、等 stopping／failure，並與退出期限競速 |
| `setPermission(status)` | 一律保存最新狀態；idle／needsPermission 時狀態有變才重新落定，不覆蓋忙碌 session 狀態 |
| `outputDirChanged()` | 清掉記住的 outputDirUnavailable（needsPermission 時也清）；只有 idle 才更新狀態 |
| `start()` | preflight（拒絕時送出標記 `preflight`、不指名 session 的 failed 事件）、建立品質與倒數快照與 session、驗位置、開 writer、準備 overlay、start host；每階段處理 late 結果 |
| `openUniqueWriter(session, stamp)` | 每個暫存檔名先寫中斷 sentinel，再嘗試暫存／最終檔名 pair；暫存 EEXIST 最多 10 次，其他錯誤直接拋出 |
| `markInFlight` / `clearInFlight` | 寫入 session sentinel（失敗只記錄一次、不阻擋）／每個終止結果都移除它 |
| `handleHostMessage(message)` | 過濾 session；處理 prepared／started／chunk／stopped／error；擷取前的 capture_failed 改為註明階段的 capture_start_failed；過期 prepared／started／chunk 回 stop |
| `beginCountdown(session)` | 進入 countdown N、顯示 overlay，並從同一個單調時間起點排好每個 tick、dismissal 與 N 秒 |
| `dismissOverlay` / `recordAfterCountdown` | 在上限內等 overlay 確認離開（逾時則關閉並寫 log）／N 秒已過且 overlay 已消失才送 `record` |
| `record(session)` | 進入 arming、設 `record → started` 期限並送 `record`；被拒即啟動失敗 |
| `cancel(session, reason)` | detach session、清 timer、關 overlay、停 host、回到嘗試前的 idle、abandon writer、發 `cancelled`、移除 sentinel |
| `present` / `closeOverlay` / `clearCountdown` | 呼叫 presenter 並記錄其錯誤／只關閉 overlay 一次／清除倒數 timer |
| `handleChunk(session, seq, bytes)` | 驗連續 seq、清首片 timer、started 後的非空媒體重設停滯保護、append；write reject 轉 fail |
| `finalize(session)` | 等 pending append，確認 session 未失效，finish writer；成功 idle＋saved（附提前停止原因與 session trace），再移除 sentinel |
| `armStall(session)` | 媒體開始後的 chunk 間隔 timer：警告門檻記錄一次，第二門檻以 capture_failed 失敗 |
| `watchDisk(session)` | 錄影中以單一不重疊 timer 查詢可用空間；低於警告門檻記錄一次，低於停止門檻只要求一次正常停止；查詢失敗記錄一次 |
| `retainedWriteError(session)` | 在上限內排空 writer，回傳其保留的寫入／sync 錯誤；只用於改報 capture_start_failed |
| `handleHostFailure(code, detail)` | 有 session 才進 fail；`record` 前改為註明階段的 capture_start_failed；idle 時不假造錄影錯誤 |
| `cancelMarked(session, cause, detail)` | 已在 `prepared` 前被睡眠或退出標記的嘗試，遇到 host 錯誤或遺失、螢幕移除、請求逾時或被拒時，以該原因取消而非失敗 |
| `fail(id, code, detail, flags)` | 先 detach session／清 deadline、倒數與健康 timer／關 overlay／stop／idle，writer 已保留磁碟錯誤時取代 capture_start_failed，後 abandon，最後 failed 帶檔案結果、session trace 與 partialPath，再移除 sentinel |
| `trace(session)` | captureStarted、saved、failed 帶的 session id、暫存路徑與錄影／要求停止時間（plan 029） |
| `clearTimer` / `clearDisk` / `clearHealth` | 取消並清除 session deadline／可用空間查詢／查詢與停滯 timer |
| `setState(state)` / `emit(event)` | 替換狀態並發事件／依序呼叫 listeners；某個 listener 拋出時只記 log，其他 listener 與 recorder 自身的清理照常執行 |

## Host 監督器 — main/capture-host.ts

[原始碼](../../../src/main/capture-host.ts)。這個 CaptureHost 與 renderer 同名類別在不同程序。

| 方法 | 契約與副作用 |
| --- | --- |
| `constructor(options)` | 保存 preload／HTML／devUrl，預設 ping 5 秒、ready 8 秒 |
| `onMessage(listener)` / `onFailure(listener)` | 登錄有效訊息／host 故障 callback |
| `start(id, quality)` | 先 teardown 既有 host，為本次嘗試建立新視窗並等待 ready；啟動本次 session 的心跳，再送 start；建立／load 失敗時清掉新視窗並 reject |
| `record(id)` | 對被監看的 session 送 record；沒有 host 接收時拋錯 |
| `stop(id)` | 有 port 才送 stop，無 port 時無作用 |
| `destroy()` | 呼叫 teardown，供嘗試結束與 App 退出 |
| `create()` | 建 sandbox 視窗／channel、裝 guards／crash handler、載頁／交 port、等 ready；格式錯誤的訊息只記錄欄位名稱與值的種類 |
| `stopHeartbeat()` | 被監看的 session 回報 stopped／error 時，以及 teardown 時停止心跳 |
| `ping()` | 先查兩次未回覆，逾限 teardown＋failed；否則累計 missedPongs 並送 ping |
| `post(message)` | 透過目前 port 發 MainMessage |
| `emitFailure(code, detail)` | 發送程序失敗事件，由 Recorder 決定 session 收尾 |
| `teardown()` | 停心跳、close port、清 ready、destroy 視窗，允許下次重建 |

## 擷取與編碼 — renderer/capture-host.ts

[原始碼](../../../src/renderer/capture-host.ts)。沒有檔案或任意 Node API。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `measureFrameSize(stream, options)` | DOM video 量 intrinsic 尺寸；等待 metadata／resize／timeout，回尺寸或 undefined；finally detach video |
| `current()` / `matches(size)` / `check()` | 量測內 helper：讀正尺寸、比 expect、符合時 clear timer／resolve；timeout 回最後看到的尺寸 |
| `CaptureHost.constructor(port, options)` | 訂閱 message、start port、送 ready，量測器可注入 |
| `handle(data)` | isMainMessage 過濾，分派 ping→pong、start、record、stop |
| `start(id, quality)` | 拒絕重疊與不支援 MIME；等待 stream、取消檢查、音軌檢查、applyQuality、建立未啟動的 MediaRecorder、監看軌道並回 prepared |
| `record(id)` | 只接受已準備且軌道存活的該 session；掛事件、啟動 MediaRecorder、回 started；重複的 record 忽略 |
| `release(prepared)` | 丟棄已準備的 session 並停止其軌道 |
| `cancelled()` | start 內檢查取消 id；取消時移除 pending、停 tracks、送 stopped |
| `refuse(code, detail)` | start 內拒絕路徑：移除 pending、停 tracks、送 error |
| `stop(id)` | pending 轉 cancelled；已準備的 matching session 釋放並回 stopped；active matching id 只要求 stop 一次，inactive 時直接排 finish |
| `enqueueChunk(session, blob)` | 空 Blob 忽略；配置 seq，chain 中轉 ArrayBuffer 並複製送 port；轉換失敗回 error |
| `finish(session, then)` | finished 防重入；停 tracks、等全部 chunk 送完、清 active session，再執行 terminal callback |
| `fail(id, code, detail)` / `send(message)` | 建 error／發 HostMessage，不改 main 狀態 |
| `finiteOrUndefined(value)` | 有限 number → 原值，其他 → undefined |
| `applyQuality(stream, quality, measure)` | 量來源、fit cap、重送 fps constraint、重測、計目標 → CaptureReport；降級／fallback 寫 warnings |
| `stopTracks(stream)` | 對所有 MediaStreamTrack 呼叫 stop |
| `describe(cause)` | Error name/message 或 String，用於診斷 |
| `classifyGetDisplayMediaError(cause)` | NotAllowedError→permission_denied；NotFoundError→no_display；其他→capture_start_failed |

頁面 message listener 檢查 source／標記／port 後建立 host。MediaRecorder callbacks 的先後順序是 chunk chain → terminal message，詳見 [錄影管線](recording.md)。

## 影片儲存 — main/file-writer.ts

[原始碼](../../../src/main/file-writer.ts)。nodeFs 將 open／link／排他複製／unlink／mkdir／writeFile 適配成可替換 I/O。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `FileWriteError.constructor(code, filePath, cause)` | 附 code／路徑／原始 cause 的 Error |
| `errnoCode(cause)` / `messageOf(cause)`（[main/errors.ts](../../../src/main/errors.ts)） | 取得 errno／文字，未知 errno 為 undefined；main 所有讀 Node 錯誤的模組共用 |
| `classifyWriteError(cause)` | ENOSPC → disk_full，其他 → output_write_failed |
| `classifyOpenError(cause)` | ENOSPC → disk_full，其他 → output_open_failed（資料夾 probe 與獨占開檔） |
| `ensureWritableDir(dir, io)` | mkdir＋寫 probe；失敗依 `classifyOpenError` 拋出錯誤碼；probe 刪除 best effort |
| `FileWriter.constructor(...)` | 保存 handle／路徑／I/O，啟動週期 sync 佇列 |
| `FileWriter.open(recordingPath, finalPath, options)` | wx 開暫存檔 → writer，失敗包成 FileWriteError |
| `bytesWritten` getter | 回傳每次 write 確認寫入量的總和，包含 append 失敗前的部分進度 |
| `backlogBytes` getter | append 已接受、但尚未確認寫入或因失敗釋放的位元組數 |
| `append(bytes)` | closed 或已拒絕時 reject；會超過積壓上限的 append 立即拒絕且不排入佇列（沿用先前的磁碟錯誤）；否則在佇列中補完剩餘 buffer 並累計確認進度；空輸入不 write，零／無效計數 reject |
| `drain()` | 等待佇列作業後回傳已保留的失敗或拒絕（若有） |
| `finish()` | enqueue sync；曾拒絕 append 時 reject；release、排他硬連結並以尾碼避撞名（連結因 EEXIST 以外的原因被拒後改用排他複製）、盡力刪除暫存名稱 → 實際最終路徑與 `finishTimings`；失敗 reject |
| `finishTimings` | 成功 finish 後的 flush、close、發布與清理毫秒數，`link` 或 `copy`，以及改用複製時連結的錯誤碼；僅供診斷 |
| `abandon()` | 等佇列、best effort release；有 bytes 留暫存路徑，空檔盡力刪除；不拋出 |
| `release()` | 一次性 closed／close handle；fsync timer 已由 `beginTerminal` 停止 |
| `enqueue(task)` | 依序執行；首個 failure 被記住，後續回同一錯誤，內部 queue 保持可接續 |

## 錄影檔資料庫 — main/recordings-library.ts

[原始碼](../../../src/main/recordings-library.ts) 為「錄影檔」分頁列出儲存位置，也是沙箱頁面取得錄影內容的唯一途徑；片長由 [main/mp4-duration.ts](../../../src/main/mp4-duration.ts) 讀取。見[桌面設計](desktop.md#錄影檔)。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `isListedName(name)` | 分頁會列出的影片：`.mp4`、`.m4v` 或 `.mov`，非隱藏檔，也不是仍在寫入的 `.recording.mp4` |
| `stampedTime(name)` | App 自己的 `YYYY-MM-DD HH-MM-SS[-n].mp4` 檔名所記的本地時間；其他檔名為 undefined |
| `fileId(path)` | 路徑的穩定 id（截短的 SHA-256），頁面只拿 id、不拿路徑，重新列出時卡片得以保留 |
| `parseRange(header, size)` | size 內的單一 `bytes=` 範圍；沒有 header 為 undefined，無法提供的範圍為 null（416） |
| `RecordingsLibrary.refresh()` | 由新到舊列出資料夾並發布；同時只列一次，期間的請求共用其後的一次列出；未知片長之後再讀（`lengths`）並一起發布；已不在清單的檔案，其片長與縮圖從記憶體移除；無法讀取的資料夾會說明，而不是顯示為空 |
| `RecordingsLibrary.act(id, action)` | 對已列出的 id 執行「顯示」、「開啟」或「丟到垃圾桶」；任何失敗都先重新列出資料夾再回傳 false，讓已離開的檔案不出現在回覆中 |
| `RecordingsLibrary.thumbnail(file)` | 已列出檔案的 PNG 縮圖；在最近顯示的 `THUMBNAILS_KEPT`（64）張之內時，同一版本只產生一次 |
| `RecordingsLibrary.watch()` / `unwatch()` | 視窗開著時監看資料夾（不輪詢），對已列名稱的一串事件結束 `WATCH_SETTLE_MS`（250 毫秒）後重新讀取；儲存位置改變時跟著換；視窗關閉時 `unwatch`，不留下監看或計時器；無法監看的資料夾只記一次 log |
| `RecordingsLibrary.handle(request)` | `recordstuff-media:` 的 handler：只為已列出的 id 提供可依 byte range 讀取的 `video/<id>` 與 `thumb/<id>`，其餘一律 404 |
| `mp4Duration(path)` | 只讀 box 算出秒數：分段檔取最後一個 `tfdt` 加上其 sample 時長，否則用 `mvhd`；box 沒有資訊時為 undefined；不拋出 |

## 設定、品質與協定

[SettingsStore](../../../src/main/settings.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `parseSettings(text)` | v1／v2／v3 JSON → settings＋warnings；整體不合法回 undefined；壞 quality／hotkey 保留 outputDir |
| `constructor(options)` / `load(defaultDir)` | 同步讀檔、檢查、fallback 與 log；不立刻把 fallback 回寫 |
| `outputDir` / `quality` / `language` / `hotkey` getters | 讀目前已成功提交的設定 |
| `defaultOutputDir` | 建構時給定的 fallback 資料夾；開啟儲存位置時唯一可能建立的資料夾 |
| `setHotkey(hotkey)` | 驗 enabled 布林與自訂組合鍵，正規化後排隊保存 |
| `setLanguage(language)` | 驗 en／zh-TW，排入保存佇列，保留品質與位置 |
| `countdown` / `setCountdown(value)` | 讀已提交的倒數／驗 0、3、5、10 後排入保存佇列 |
| `countdownSound` / `setCountdownSound(enabled)` | 讀已提交的開關（缺少欄位時為開啟）／驗布林值後排入保存佇列（plan 046） |
| `setOutputDir(dir)` | 驗絕對路徑 → save 更新 |
| `setQuality(patch)` | 驗合併值合法 → save；實際入列後再合併最新 committed 值 |
| `save(update)` | 序列化寫入；write 成功才換記憶體；失敗不阻斷後續 queue |
| `write(settings)` | `writeFileAtomic`：mkdir、寫入並 fsync JSON.tmp，再 rename；不負責通知 |

[main/atomic-file.ts](../../../src/main/atomic-file.ts)：`writeFileAtomic`／`writeFileAtomicSync` 建立父目錄、寫入 `<file>.tmp` 並 fsync，再 rename 覆蓋目標；失敗時移除暫存檔並保留原內容。設定、設定視窗尺寸與失敗歷史使用 `writeFileAtomic`；`writeFileAtomicSync` 只供驗證腳本使用。

[shared/hotkey.ts](../../../src/shared/hotkey.ts)：`DEFAULT_HOTKEY` 啟用 ⌘⇧1；舊版曾提供的組合仍然有效，由 `hotkey.test.ts` 檢查。`validateAccelerator` 驗證支援的自訂組合，要求 Command 或 Control 並排除保留鍵；`canonicalizeAccelerator` 正規化修飾鍵順序與 Shift 符號。`isAccelerator` / `isHotkeySettings` 驗證保存值，不限於選單提供的選項；`describeAccelerator(accelerator, platform)` 在 darwin 顯示 `⌘⌥⇧R`、其他平台 `Ctrl+Alt+Shift+R`，供選單、通知與 log 使用。

[main/hotkey.ts](../../../src/main/hotkey.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `RecordingHotkey.constructor(options)` | 注入 `globalShortcut` 子集（register／unregister）、tray 的 toggle 動作與 logger |
| `status` | `disabled`、帶組合鍵的 `registered`，或帶組合鍵與原因的 `failed` |
| `apply(settings)` | 丟棄 pending 請求、釋放現有註冊，啟用時再註冊；回傳新狀態；被拒絕或 register 擲出時記 log 並回 `failed` |
| `request(settings, settled)` | recorder 在 idle／needsPermission 時直接 `apply`；否則暫存請求、記 log 並回 `deferred` |
| `flush(settled)` | settled 時套用暫存請求；沒有 pending 時回 undefined |
| `dispose()` | 釋放並重設為 disabled；可重複呼叫 |
| `pressed(accelerator)` | 記 `hotkey: <accelerator> pressed` 後呼叫 toggle |
| `release()` | 只對 `registered` 狀態 unregister；失敗留 log |

[shared/quality.ts](../../../src/shared/quality.ts)：

| 函式 | 契約 |
| --- | --- |
| `isQualitySettings(value)` | 驗三個列舉欄位，額外欄位不影響 |
| `isFrameRateAvailable(fps, platform)` | 30 可用；60 只有 darwin 可用 |
| `effectiveQuality(settings, platform)` | 必要時回 fps=30 的副本，不改原設定 |
| `even(value)` | 四捨五入後往下調至偶數，供縮小尺寸 |
| `fitWithinCap(source, cap)` | 保比例、不放大；縮小時按橫直方向限制與偶數化 |
| `videoBitsPerSecond(size, fps, quality)` | pixels×fps×係數，100 kbps 取整，套最小／最大值 |
| `isOptionalFiniteNumber(value)` | 只接受 undefined 或有限 number |
| `isCaptureReport(value)` | optional 數值與 required bitrate／warnings 形狀檢查；不是完整合理值範圍檢查 |
| `frameRateDowngrade(requested, report)` | 60 requested 且 actual≤30 → rounded fps；其他 undefined |
| `unknown(value, unit)` / `describeCapture(requested, report)` | 格式化未知欄位／本次要求、track、目標與 warnings 日誌 |

[shared/protocol.ts](../../../src/shared/protocol.ts)：`isRecord()`、`isNonEmptyString()` 是 guards 的 helper；`isMainMessage()` 驗 start／record／stop／ping，`isHostMessage()` 驗七種 host 訊息：`prepared` 必須帶 mime type 與 CaptureReport，`started` 可兩者皆無；chunk 要求非負整數 seq 與 ArrayBuffer。

[shared/countdown.ts](../../../src/shared/countdown.ts)：`COUNTDOWN_CHOICES`（0、3、5、10）、`DEFAULT_COUNTDOWN`（3）與 `isCountdownSeconds`；`COUNTDOWN_TIMING`（tick、overlay 提前量、dismissal 上限、淡化、穩定間隔）與 `COUNTDOWN_OVERLAY`（字級占螢幕短邊的比例與 56–216 pt 上下限、視窗與字級的比例、邊距、字型、數字、以 56 pt 為基準的外框與陰影、減少透明度的數值），提示音數值 `COUNTDOWN_TICK`（523 Hz 正弦波、最後一個數字 ×1.5、小聲的四倍泛音、attack 4 ms、140 ms、−20 dBFS）、`DEFAULT_COUNTDOWN_SOUND`（開啟）、`tickFrequencyHz(digit)` 與頁面的 `COUNTDOWN_SOUND_QUERY`（plan 046），是所有時間、外觀與聲音數值唯一的定義處；`overlayFontPt(displayBounds)` 算出某個螢幕上的字級，`overlayBounds(displayBounds, workArea)` 以整數 pt 算出位於工作區右上角的正方形視窗；另定義 overlay preload 的數值 channel 與 bridge 型別。

[main/countdown-overlay.ts](../../../src/main/countdown-overlay.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `overlayWindowOptions(bounds, preload, platform)` | 透明、無邊框、無陰影、固定、不可聚焦、sandbox 並設定 `autoplayPolicy: "no-user-gesture-required"` 的視窗選項；macOS 為 non-activating panel |
| `prepare(presentation)` | 在主螢幕只建立一次隱藏視窗，位於 `screen-saver` 層級、出現在每個 Space、點擊穿透；載入頁面，session 有提示音時帶 `?sound=1`（旗標不同就重建頁面）；當機或載入失敗即關閉 |
| `show(n, presentation)` / `update(n)` | 放到被錄影的螢幕（不知道時用主螢幕並寫 log）、連同螢幕範圍記錄位置、傳送數字，頁面載入後不啟動 App 地顯示／傳送下一個數字 |
| `dismiss()` | 傳 `null` 讓數字淡出，淡出與穩定間隔後銷毀視窗再 resolve；尚未畫出任何內容時立即銷毀 |
| `close()` / `destroy()` | 立即銷毀並讓等待中的 dismissal resolve；`destroy` 是 App 在穩定狀態與退出時的保險 |

[renderer/countdown.ts](../../../src/renderer/countdown.ts)：`overlayStyle()` 把共用外觀數值轉成 CSS custom properties；`createCountdownView(stage, onDigit?)` 在兩個疊放的面之間交叉淡化，收到 `null` 時整體淡出，每個新數字呼叫一次選填的 `onDigit`；`playTick` 依 `COUNTDOWN_TICK` 以 Web Audio 合成一聲提示音；`soundRequested` 讀取頁面的 query（plan 046）。[preload/countdown.ts](../../../src/preload/countdown.ts) 只提供 `countdown.onValue`，只轉交正整數或 `null`。[shared/state.ts](../../../src/shared/state.ts) 的 `isErrorCode()` 以 ERROR_CODES 白名單檢查字串。

[preload/index.ts](../../../src/preload/index.ts) 沒有具名函式：唯一 ipcRenderer callback 接收 `capture-host-port` 後將 event.ports 轉交 window，沒有 contextBridge API。

[shared/i18n.ts](../../../src/shared/i18n.ts)：`isLanguage(value)` 驗 en／zh-TW；`translate(key, language, values)` 預設英文，依 ZH_TW 取得中文模板並代入所有具名 placeholder；編譯器要求 key 的每個 placeholder 都有值，標籤表使用 `PlainMessageKey`（沒有 placeholder 的文案）。`notice(body)` 包裝通知標題與內文；trayModel 的 `text`／`model` helper 產生翻譯與呈現模型。通知函式接受 optional language，預設英文。

## 權限 — main/permission.ts

[原始碼](../../../src/main/permission.ts)。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `screenCaptureGranted()` | Electron screen status 是否等於 granted |
| `openScreenCaptureSettings()` | shell.openExternal 固定設定 URL → Promise |
| `countCapturableScreens()` | getSources screens、無縮圖 → 數量，OS 拒絕則 reject |
| `constructor(onChange, options)` | 保存注入 API，預設 interval=5 秒、validateTimeout=4 秒、退避上限 60 秒 |
| `start()` / `stop()` | 立即 check、設 interval 與 activate listener；stop 開新世代並移除 interval、listener、deadline 與 retry，未完成的呼叫仍保留 |
| `markRelaunchRequired()` | 執行中且 OS 尚 granted 才開新世代、清驗證快取並 check |
| `check()` | 未授權時重設（新世代、清 deadline／retry／退避）＋promptOnce；已驗證直接 emit；其餘 validate |
| `promptOnce()` | 每程序至多一次 getSources 註冊／提示呼叫，且只在列舉名額空出時送出 |
| `validate()` | retry 等待中則略過；設指引 deadline；沒有未完成呼叫才列舉 |
| `overdue()` | deadline 到：emit needsRelaunch 指引，不釋放 in-flight 名額 |
| `enumerate()` / `settle()` | 持有唯一呼叫直到它結束；只釋放自己的名額；忽略舊世代；成功快取或排入倍增退避 |
| `emit(status)` | 相同 granted／needsRelaunch 不重送 |

## 共用 UI 語彙 — main/ui-model.ts

[原始碼](../../../src/main/ui-model.ts)。Tray 與設定面板共同的基礎；兩個投影互不衍生。

| 函式／型別 | 契約 |
| --- | --- |
| `AppAction` / `AppContext` / `AppHotkey` | 所有介面能發出的 action union，以及兩者共同投影的唯讀 context 快照 |
| `preferencesUnlocked(state)` | 設定能否更改的唯一規則：只有 idle 與 needsPermission |
| `abbreviateHome(path, home)` | 只縮寫相同 home 或完整路徑前綴，避免誤縮其他同名字首資料夾 |

## 設定面板模型 — main/settings-model.ts

[原始碼](../../../src/main/settings-model.ts)。每項偏好設定只宣告一次，並配穩定 id。

| 函式 | 契約 |
| --- | --- |
| `qualityGroups(ctx, enabled)` | 影像品質、解析度上限、幀率；此平台未驗證的幀率仍列出但不可選 |
| `hotkeyGroup(ctx, enabled)` | 建議的預設鍵、不同於預設的已存自訂值與「關閉」；renderer 加上「自訂快捷鍵…」；註冊失敗顯示診斷，設定快捷鍵（⌘⌥,）註冊失敗或被錄影快捷鍵佔用時也會顯示；關閉保留記住的組合鍵 |
| `updateChecksGroup(ctx, enabled)` | 啟動檢查的開／關 |
| `languageGroup(language)` | 英文與繁體中文；永不鎖定，因為語言不影響擷取 |
| `settingsView(state, ctx)` | 面板完整 view：標題、說明、失敗文案、四個分頁（失敗紀錄分頁計算未確認筆數）、附媒體 URL 的錄影檔清單，以及移除 action 後的群組；失敗列帶日期、短時間、檔名與完整路徑 |
| `formatDuration(seconds)` | 錄影長度寫成 `1:23`，滿一小時為 `1:02:03` |
| `dayHeading` / `shortTime` | 失敗列與錄影檔共用的日期標題（今天、昨天、日期，不是今年才加年份），以及失敗列或 App 命名錄影的短時間，以 `ctx.now` 為基準（plan 047） |
| `settingsAction(state, ctx, group, choice)` | 當下有提供且可用的 group/choice 才回傳對應 action，否則 undefined |
| `settingsChecked(state, ctx, group, choice)` | 該選項是否為實際提交值；main 用它回報保存是否生效 |

## 設定視窗 — main/settings-window.ts、renderer/settings.ts

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `SettingsWindow.constructor(options)` | 註冊三個 IPC handler（`settings:capture`、`settings:read`、`settings:choose`），非設定視窗 main frame 的來源一律拒絕；`capture` 在快捷鍵編輯器擷取新組合時暫停全域快捷鍵 |
| `show()` | 先讓選單列 App 取得前景，已有視窗就聚焦，否則建 sandbox 視窗並帶當前語言載入頁面 |
| `refresh()` | 推送目前 view 並更新標題；視窗關閉時不做事；與頁面已持有的 view（經推送或 invoke 回覆，由 `deliver` 記錄）相同時不再推送 |
| `destroy()` | 退出時移除 handler 與視窗 |
| `apply(group, choice)` | 解析 id、呼叫共用 action handler，回傳新 view 與是否真的提交 |
| `settings:choose` 佇列 | 依請求順序序列化保存，第二個請求是等待而不是失敗 |
| 面板 `draw()` / `row()` | 畫出 view，並把焦點還給重建後取代的同一個控制項；明確的失敗入口會切到失敗紀錄分頁；每個分頁離開時保存捲動位置，重建的面板穩定後還原 |
| 面板 `updateRecordingResult()` / `resultRow()` / `fillRow()` | 失敗紀錄分頁（plan 047）：依 ID 保留、依日期分組的收合列，同時只展開一列，上下鍵、Home、End 在標題間移動，入口目標展開並聚焦，移除後焦點移到相鄰列，移除最後一列後移到分頁 |
| 面板 `choose()` | 送出 id；保存期間正在操作的控制項保持可用、其餘暫時停用；未提交時顯示失敗文案 |

## Tray 模型與原生呈現

[tray-model.ts](../../../src/main/tray-model.ts)：扁平指令選單，不含任何偏好設定。

| 函式 | 契約 |
| --- | --- |
| `disabled(label)` / `item(label, action, tooltip?)` | 建灰色／可點模型項目 |
| `windowsGroup(ctx)` / `appGroup(language)` | 「開啟 RecordStuff」（開啟它的快捷鍵已註冊時附上，無法使用時下方附說明）／「結束 RecordStuff」，所有狀態皆可用 |
| `outputDirItems(ctx, enabled)` | 產生位置與更改位置項目，按狀態鎖定 |
| `shortcutHint(ctx, key)` | 「開始／停止」或「取消錄影」的 tooltip 提示已註冊組合鍵；關閉或未註冊時為 undefined |
| `permissionActions(needsRelaunch, language)` | 已判斷需重啟只給重啟；否則給設定與「已經允許了？」重啟 |
| `trayModel(state, ctx)` | 狀態 → 完整圖示／標題／tooltip／menu；每個狀態一個圖示（圓環、沙漏、碼錶、實心圓點；警示標記只取代 idle 圓環），只有錄影中有標題；tooltip 含狀態與右鍵提示 |
| `savedNotification(path)` | filename → 存檔文案 |
| `permissionNotification(needsRelaunch)` | 設定／重啟的提示文案 |
| `settingsWriteFailedNotification(dir, home)` | 說明位置設定未保存、仍使用原值 |
| `qualityWriteFailedNotification()` / `languageWriteFailedNotification()` / `hotkeyWriteFailedNotification()` | 說明品質／語言／快捷鍵設定未保存 |
| `hotkeyRegistrationFailedNotification(accelerator, platform)` | 本地化的佔用提示，含平台顯示形式的組合鍵，並指向設定視窗 |
| `frameRateDowngradeNotification(requested, actual)` | 說明系統實際提供的 fps |
| `trayHintNotification(platform)` | 首次啟動時指向 macOS 選單列或其他平台系統匣的提示；在 macOS 上也藉此觸發唯一一次通知授權詢問 |

[recording-result.ts](../../../src/main/recording-result.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `RecordingResults.receive / act` | 確認部分檔案、拒絕過期結果與操作、保留未讀狀態並提供復原操作；每次確認、移除與重試在完成時寫一行含 ID 與結果（saved、附儲存錯誤類別的 failed，或附原因的 refused）的 log |
| `RecordingResults.restore` | 納入尚未在歷史中的啟動時中斷紀錄，與保存路徑一起限時重新檢查；恢復已讀狀態，不發通知、不覆蓋新狀態；回傳這次嘗試是否保存了歷史 |
| `RecordingResults.saved` | 所有指定 ID 都曾寫入已保存的檔案後 resolve（包含之後的自動重試）；本身不觸發保存 |
| `isOutputFolderFailure` / `isPermissionFailure` | 共用的復原分類：輸出資料夾類失敗提供變更資料夾；權限類失敗（含 no_audio_track）在 macOS 提供系統設定與重新啟動 |

[session-sentinel.ts](../../../src/main/session-sentinel.ts)：`SessionSentinels.write` 在暫存檔存在前以原子寫入記下它；`remove` 刪除且不拋出；`leftovers` 列出先前程序留下的 sentinel，略過本程序的 session，捨棄中斷寫入與無效內容，暫時無法讀取的則保留。`interruptionFailure` 將其轉為 ID 由 session 推導的 `app_terminated` 紀錄；`reportInterruptions` 在啟動時交給 `RecordingResults.restore`，待 `RecordingResults.saved` 確認紀錄已保存後才移除 sentinel。

[recording-health.ts](../../../src/main/recording-health.ts)：`RECORDING_HEALTH` 是停滯、可用空間、writer 積壓與啟動排空門檻的唯一位置。

[keep-awake.ts](../../../src/main/keep-awake.ts)：`KeepAwake.update` 從 `starting` 到狀態回到穩定前持有一個 `prevent-display-sleep` 電源 blocker，並記錄每次開始與停止；blocker 丟出錯誤時只記錄；`dispose` 在結束時釋放（plan 050）。

[recording-result-store.ts](../../../src/main/recording-result-store.ts)：驗證並原子替換版本化失敗歷史，升級舊單筆資料但不覆寫舊檔。精確 ID 的重試不改未讀狀態，移除僅刪已確認資訊。

[tray.ts](../../../src/main/tray.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `AppTray.constructor(options)` | loadIcons、建 Tray、忽略 double-click event、註冊左右鍵 |
| `render(state)` / `refresh()` | 保存呈現用 lastState，圖示／title／tooltip 各自只在改變時更新；refresh 用同狀態重讀 context |
| `destroy()` | 只銷毀一次原生 Tray，並丟棄保留中的通知；之後的 render、refresh、右鍵與通知都不動作 |
| `systemWillSleep()` / `systemDidWake()` / `userDidUnlock()` | 從 `suspend` 起保留通知；`resume` 後每秒檢查，閒置時間在 2 秒內或顯示喚醒後已有輸入時依序顯示；解鎖時立刻顯示（plan 050） |
| `notifySaved(path)` | show 存檔通知，點擊 reveal |
| `notifyRecordingFailure(code)` | 開啟設定失敗歷史並定位最新未確認紀錄，不自動標成已讀 |
| `revealFromNotification(path)` / `reveal()` | macOS setImmediate 後 showItemInFolder，記 requested／failed |
| `notifyPermission(needsRelaunch)` | 文案＋開設定／重啟 callback |
| `notifySettingsWriteFailed(dir)` / `notifyQualityWriteFailed()` / `notifyLanguageWriteFailed()` / `notifyHotkeyWriteFailed()` | 保存失敗通知，無設定 mutation |
| `notifyHotkeyRegistrationFailed(accelerator)` | 目前語言的快捷鍵佔用通知 |
| `notifyFrameRateDowngrade(requested, actual)` / `notifyTrayHint()` | 對應純文案的原生通知 |
| `show(text, onClick?)` | 睡眠中先保留；之後檢查開關與支援、建立 silent Notification、掛 click／failed、show |
| `log(message)` | 呼叫注入 logger（若有） |
| `popUpMenu()` | 依現在 state/context 重建 menu 後彈出 |
| `toTemplate(entry)` | 分隔線或指令項目 → Electron MenuItemConstructorOptions，click 分派 action |
| `TRAY_ICON_FILES` / `loadIcons(dir, log)` | 每個狀態的素材／每個狀態載入 Windows ICO；其他走 template PNG，macOS 配合 @2x 素材；載入成空圖時留 log，因為圖示會看不見 |

## Log 與自動錄影

[log.ts](../../../src/main/log.ts)：`rotatedPath(path, index)` 組 archive 檔名；`rotateLog(path, keep)` 刪最舊再逆序搬移；`formatLine(message, now)` 加 ISO 前綴；`createFileLogger(options)` 回傳帶 `flush()` 的 logger：每行立即寫 stdout，並加入一條序列化、上限 1 MiB 的非同步檔案佇列（超過上限的行只從檔案捨棄，並回報一次）。第一次寫入建立目錄並在每個程序只查一次長度；之後累計寫入位元組、超過 `maxBytes` 時先輪替；磁碟已滿或 logs 資料夾被刪除時只略過這些行，之後寫入成功時記下檔案漏掉幾行，其他檔案錯誤則停用檔案輸出。`flushBeforeExit(log, timeoutMs)` 有上限地等待佇列寫完，讓啟動失敗或第二個實例結束前，原因已寫進檔案。

[session-log.ts](../../../src/main/session-log.ts)：`createRunId(launchedAt, pid)` 由啟動時間與 pid 組成每次啟動的 run id；`logSessionEvent(log, run, event)` 對 captureStarted、saved、failed 與 preflight 拒絕先寫人類可讀的 `saved`／`failed:` 行，再寫有版本的 session record；取消的倒數只寫一行記下暫存檔的 `cancelled:`，不寫 record；其他事件忽略。[shared/session-record.ts](../../../src/shared/session-record.ts) 定義 record schema、前綴與版本並格式化一筆 record；只有 type import，scripts 可直接載入。

[autorecord.ts](../../../src/main/autorecord.ts)：`parseAutoRecord(value, isPackaged)` 在打包版／空值回 undefined；其餘解析 seconds∈(0,3600]、合法 quality patch 與選填的 countdown（未指定為 0），不論輸入為何都設 `countdownSound: false`（plan 046），合併預設而非使用者設定。`runAutoRecord(config, deps)` 等預設 1.5 秒後由公開 toggle 開始，進 recording 才排計時停止，saved／failed／cancelled，或按下開始前的 needsPermission 後，由內部 `finish(message)` 一次性 log＋quit。絕對路徑的 `outputDir` 只在這次執行取代已存的資料夾，不寫入設定。用於開發量測，不在正式版提供遠端控制。

## 簽章與圖示工具

[start-app.mjs](../../../scripts/start-app.mjs)：

| 函式 | 契約與副作用 |
| --- | --- |
| `run(command, args, capture)` | 以過濾過的 env 在 repo spawnSync；非零／spawn 失敗即拋錯 |
| `fingerprint(cert)` | 公開憑證 SHA-1 去冒號、轉大寫 |
| `checkCertificate(cert)` | 驗有效期、subject=issuer、自簽驗證；不符即停止 |
| `resolveIdentity()` | 精確名稱／SHA-1 找唯一有效身分與公開憑證；拒絕同名衝突 → hash／name／expires |
| `assertNotRunning()` / `escapeRegex(value)` | escape 路徑後 pgrep RecordStuff 或本專案 Electron；偵測到執行中就拒絕重建 |
| `verifyBundle(appPath, identity)` / `walk(dir)` | 深度 codesign 驗證，walk 巢狀 bundle 不追 symlink；核對每個簽署憑證、identifier／runtime 與最外層 designated requirement |

頂層 CLI 驗平台與 --open／--dmg，清除 Apple／CSC 環境、禁止自動尋找憑證與發布，先 build app 再 verify，之後開啟或封 DMG；暫存抽出的公開憑證最後刪除。

[make-icons.mjs](../../../scripts/make-icons.mjs)：`coverage(shape, px, py)` 做超取樣覆蓋；`circle()`／`ring()`／`roundedSquare()` 建幾何遮罩；`rasterize(size, layers)` 合成 RGBA；`chunk(type, data)` 建 PNG chunk（含 CRC）；`png(size, rgba)` 封 PNG；`ico(entries)` 封多尺寸 ICO；`box()` 建比例矩形；`idleShape()`／`busyShape()`（沙漏）／`countdownShape()`（碼錶）／`recordingShape()`／`warningShape()` 建 tray 圖樣；`appIcon(size)` 建 App 圖樣。Windows 系統匣圖示（plan 034）依 `WINDOWS_TRAY` 逐一繪製每個 ICO 尺寸，這張表記錄 16、20、24、32、48 px 的像素幾何：`rect()`／`union()`／`offset()` 組合像素遮罩；`exclamation()`／`hourglass()`／`stopwatch()` 繪製警示記號、busy 與倒數符號；`windowsTrayLayers(state, size)` 把帶灰色邊緣的深色底座與該狀態的符號疊在一起。頂層輸出資產，macOS 使用 iconutil 生成 ICNS，其他平台保留現有 ICNS。

## 錄影驗收工具

工具資料流及門檻見 [tooling](tooling.md)。工具是開發端程式，不在 runtime bundle。

| 原始碼／函式 | 輸入 → 結果與副作用 |
| --- | --- |
| [acceptance-settings.mts](../../../scripts/acceptance-settings.mts) 頂層 | 要求已有建置產物與本機 Electron；以 90 秒上限在全新證據目錄執行 fixture；印出每個案例；寫 report.md；缺前置或無結果以 2 退出，任一 fail 以 1 退出 |
| [fixtures/settings-panel.ts](../../../scripts/fixtures/settings-panel.ts) | 在隱藏的 sandbox 視窗載入已建置的 preload 與頁面，自備 view 與 IPC handler；判定 CSP／console、暴露的 bridge、沒有 Node API、URL 語言、畫出的控制項、不可用選項、被拒絕快捷鍵的註解、真實變更往返，以及未提交的選擇；寫出 results.json 與 panel.png |
| [acceptance-hotkey.mts](../../../scripts/acceptance-hotkey.mts) 頂層 | 要求 ffmpeg／ffprobe 可用，且 RecordStuff 執行中、idle、有 run id 且有 `hotkey: registered`；開 kiosk 素材；以 System Events 送組合鍵；從 rotation-aware cursor 各 30 秒內等 `pressed`、`state → recording`、本次的 capture record、第二個 `pressed` 與該 session 的終止 record；以 `testMaterial` 並要求聲道能量驗完整性層級，並要求檔案 metadata 配到該 session；寫 report.md／verify.json／app-session.log；缺 ffmpeg／ffprobe 時在送鍵前以 2 退出，任一檢查 fail、blocked 或 incomplete 以 1 退出 |
| [lib/acceptance.mts](../../../scripts/lib/acceptance.mts) `acceleratorToKeystroke` / `keystrokeScript` | Electron accelerator → System Events `keystroke … using {…}`；無法輸入的鍵回 undefined |
| 同檔 `lastStartIndex` / `registeredAccelerator` / `currentState` / `currentRunId` / `lineTime` | 只讀目前程序的 log（略過被 lock 拒絕的第二次啟動的 `start:` 行）與其 run id；解析行時間戳 |
| [lib/log-reader.mts](../../../scripts/lib/log-reader.mts) `LogReader.end` / `since` / `all`、`readRetainedLog`、`evidenceSince` | 最後一個完整行之後的 rotation-aware cursor（檔案身分＋byte offset）；跨保留 archive 讀 cursor 之後的完整行、每行一次，retention 或截斷移除歷史時丟 `LogGapError`（cursor 的 64 bytes 標記也能抓到截斷後又長回的檔案）；由舊到新的所有保留行；以標記取代遺失歷史的證據行 |
| [lib/session-records.mts](../../../scripts/lib/session-records.mts) `parseSessionRecord` / `startLineRun` / `logMessage` | 驗證已知版本的 session record（格式錯誤或未來版本忽略）；`start:` 行的 run id；去掉時間戳 |
| [lib/acceptance-runtime.mts](../../../scripts/lib/acceptance-runtime.mts) `waitForLog` / `waitForRecord` / `recordingOutcome` / `finishRecording` / `settleRecording` | 從 cursor 起算的有時限等待，遇 evidence gap 立即 reject；App 有寫 record 時由 record、否則由人類可讀行判斷本次錄影結果，可限定單一 session；不重複切換的中斷錄影收尾；runner 對從未離開 idle 的 App 的退路 |
| [probe-recording.mjs](../../../scripts/probe-recording.mjs) `probe(file)` | ffprobe JSON → stream／container 數據；CLI 逐檔列出 |
| 同檔 `ratio(text)`、`kbps(bps)`、`fixed(n, digits)` | 解析比例／格式化量測，未知以文字表示 |
| [verify-recording.mts](../../../scripts/verify-recording.mts) `usage()` | 列參數格式並 exit 2；頂層解析 CLI，要求能量證據（帶 `--sync` 時也要求標記），逐檔驗證、輸出，依 `verdictExitCode` 退出：fail、incomplete 或無法讀取為 1，blocked 為 2 |
| [lib/media-tools.mts](../../../scripts/lib/media-tools.mts) `ToolMissingError.constructor(tool)`、`MeasurementError.constructor(message)` | 缺工具的明確 Error；工具有執行但沒有產出有效量測 |
| 同檔 `completed(what, result)`、`stderrTail(stderr)` | 只有 exit 0 才算量測；非 0 或被 signal 結束時丟 MeasurementError，附 stderr 最後幾行 |
| 同檔 `run(tool, args)`、`hasTool(tool)` | spawnSync 包装／可啟動性檢查；有 maxBuffer，不載入影片到 App |
| 同檔 `probe(file)` | ffprobe count_frames／streams／format，返回 JSON 與 decodeErrors；JSON 格式錯誤為 MeasurementError |
| 同檔 `frameTimes(file, duration, edgeSeconds)`、`read(interval?)` | 影格 PTS；長片分別讀頭尾區間，不把中間空隙算掉幀 |
| 同檔 `channelRms(file, channels)` | ffmpeg astats → 每聲道 dBFS；須回報串流的每個聲道才算完整 |
| 同檔 `syncMarkers(file, duration)` | 解碼測試頁閃光／短音，回 flashes／beeps 時間點；偵測器須 exit 0 |
| [lib/verify-recording.mts](../../../scripts/lib/verify-recording.mts) `readLogText(path)` | 所有保留檔案，由舊到新 |
| 同檔 `readLogPairs(path?)` | 有 log 則依身分配對，無 log 返回空的 LogPairs |
| 同檔 `attempt(measurement)`、`verifyRecording(file, pairs, options)` | 查檔案的配對，再 probe／frame；能量（僅有音軌時）與 optional sync 轉為 Evidence（缺 ffmpeg 為 `unavailable`，其他失敗為 `error`）→measure→依呼叫端的必要證據 judge→帶配對狀態的 VerifyResult |
| 同檔 `parseDimensions(text)` | WxH 字串 → dimensions 或 undefined |
| 同檔 `tryExec(cmd, args)`、`environmentSummary()` | best effort 環境查詢；機器／OS／Electron／display／工具版本描述 |
| 同檔 `localDate(date)`、`measurementsPath(date)` | 本地日期 → docs/verification/measurements 日期檔名 |
| 同檔 `appendMeasurements(path, results, context)` | 新檔寫環境、附加 Markdown；同名 JSON 保存結構化數據 |
| [run-matrix.mts](../../../scripts/run-matrix.mts) `shorten(entries, seconds)`、`usage()` | 調矩陣時長／參數說明後退出 |
| 同檔 `mainDisplaySize()`、`outputDir()` | macOS 主螢幕／使用者設定或預設位置 |
| 同檔 `sleep(ms)`、`electronPids()`、`electronMainPid()` | 回歸間隔；本 checkout 的 Electron.app 所有程序，以及它的主程序（CPU 取樣程式追蹤的根） |
| 同檔 `logSince(start)` | 從本案例的 cursor 跨輪替讀 log；遺失歷史視為案例失敗 |
| 同檔 `recordOnce(entry, key)` | 用環境變數啟動開發 App，以共用 CPU 取樣程式追蹤它的程序樹，等待結果，回 outcome；CPU 以錄影第 3 秒之後判定（lib/matrix.mts 的 `cpuWindow`），並附第 95 百分位、VTEncoderXPCService 與本機 baseline |
| 同檔 `main()` | 驗工具（先 ffmpeg／ffprobe，再檢查 CPU 取樣程式需要的 clang，缺少即在任何動作前 blocked exit 2）／平台、開素材頁、以能量與同步為必要證據依序 recordOnce＋verify、寫結果、cleanup，依 `verdictExitCode` 退出 |
| 同檔 `unmetChecks(result)` | 案例判定與每個讓它未通過的檢查及原因 |
| [lib/cpu-sampler.mts](../../../scripts/lib/cpu-sampler.mts) `compileSampler(dir)`、`CpuSampler` | 以 clang 編譯 [cpu-sampler.c](../../../scripts/lib/cpu-sampler.c)（沒有 Command Line Tools 時丟出 `SamplerBlockedError`）；持續讀取它每秒輸出的 `proc_pid_rusage` 計數，範圍是根程序、其子孫程序與追蹤的系統 helper（例如 VTEncoderXPCService），直到停止 |
| 同檔 `parseSample`、`intervals`、`summarize`、`percentile` | 解析 helper 的一行；逐程序的每秒 CPU、喚醒與能耗，並標出 App 程序組合的變化；計算一段範圍的平均、nearest-rank 第 95 百分位與最大值，除非預期有變化，否則捨棄有變化的區間 |
| 同檔 `CPU_BUDGET`、`judgeIdle`、`judgeSettingsOpen`、`judgeRecording`、`judgeCoverage`、`cpuBaseline`、`machineModel` | plan 049 的預算與判定（錄影門檻、編碼器回報、25% baseline 警告與 80% 取樣覆蓋）；從 cpu-baselines.json 讀本機記錄的 baseline |
| 同檔 `processRole`、`rolesFromPs`、`readRoles`、`IDLE_ROLES`、`judgeRoles`、`judgeSteadyState` | 從命令列判斷 Chromium 程序的角色；App 程序樹的角色；各情境的待機契約；每次錄影後角色相同 |
| [measure-cpu.mts](../../../scripts/measure-cpu.mts) `launch()`、`seed()`／`restoreSettings()`、`main()` | 啟動已結束的打包 App，等啟動工作結束；只在 App 結束時寫入倒數、錄影螢幕與品質，並在沒有程序後只把這三個鍵設回原值；執行 A、R、B、C 情境，寫出 report.md／report.json，結束 App 並確認退出，以 0／1／2／130／143 結束 |

### 純量測邏輯 — scripts/lib/verify.mts

[原始碼](../../../scripts/lib/verify.mts)。所有數學／解析與判定集中於此，不直接 spawn 程式。

| 函式 | 契約 |
| --- | --- |
| `numberOrUndefined(text)`、`parseRatio(text)` | 字串／分數 → 有效數值，無效回 undefined |
| `parseCaptureLine(line)` | capture log → requested／track／target／warnings |
| `pairRecordingsWithLog(text)`、`LogPairs.lookup(file)`、`normalizeRecordingPath(path)` | session record 依 run 與 session id 配對，舊版啟動用保守的舊版關聯；以正規化完整路徑查檔，只有單一 session 指名同名檔時才用檔名；回報 matched／legacy／ambiguous／conflict／unknown |
| `parseAutorecordOutcome(text)` | autorecord log → saved 或 failed |
| `parseFrameTimes(csv)`、`frameStats(intervals, fps)` | PTS 解析，分區計算間隔／掉幀，不跨區間假算缺片 |
| `dropEofClosures(times, duration)` | 移除太靠近 EOF 的偵測器收尾假標記 |
| `parseBlackdetect(stderr, duration)`、`parseSilencedetect(stderr, duration)` | 解析閃光／音訊邊界並排除 EOF 假標記 |
| `parseChannelRms(stderr)` | 每聲道 RMS 字串 → dB 值 |
| `median(values)`、`syncStats(flashes, beeps, options)` | 配對標記；一律回報整體與各端點窗口的閃光／短音／配對數，至少 MIN_SYNC_PAIRS 組配對才估偏移與頭尾漂移；不能只用單點巧合當同步 |
| `measure(file, bytes, probe, intervals, extras)` | 組合長度／尺寸／fps／碼率／音訊／decode／CPU／sync 成 Measurement；能量與 sync 為會說明缺席原因的 Evidence；CPU（`CpuFigures`）來自 matrix runner |
| `fmt()`、`mbps()`、`kbps()`、`ms()` | 數值格式化，未知顯示破折號 |
| `pass(ok)`、`offsetWithinLimits(offsetMs)`、`aspectMatches(a, b)` | 判定 helper：boolean verdict、非對稱偏移範圍、長寬比容差 |
| `judge(measurement, entry, options)`、`unmeasured()`、`markerShortage()`、`energyProblems()`、`dbText()` | 對門檻逐列產出 Check；依證據狀態、呼叫端的必要證據、標記覆蓋與各聲道數值判 pass／fail／blocked／incomplete／n/a 並附原因，不臆測 pass |
| `overallVerdict(checks)`、`blocksSuccess(verdict)`、`verdictExitCode(verdicts)` | fail > blocked > incomplete > pass > n/a；會阻止執行成功的判定；程序 exit 1／2／0 |
| `describeRequested(entry, pairing)`、`formatText(file, entry, checks, pairing)` | 人可讀設定（或 metadata 缺少的原因）與終端表格 |
| `cell(text)`、`formatMarkdown(title, file, entry, checks, context)`、`resultLine(checks)` | escape 表格分隔並產 Markdown；供追加證據；結果列寫出判定名稱 |

`test-material.html` 的頁面事件、動畫迴圈與 Web Audio callback 提供持續動態畫面、閃光和短音；它不是產品視窗或正式版功能。


### 音質診斷 v2

[設計教學](audio-quality.md)說明數學、門檻與限制。

| 模組／函式 | 契約 |
| --- | --- |
| [audio-quality.mts](../../../scripts/lib/audio-quality.mts): fixture, wav | 產生 v2 已知雙聲道素材並序列化 PCM16 WAV |
| 同上：fit, estimateFrequency | 含 DC 的最小平方正弦模型，以及有範圍限制的頻率搜尋；不呼叫外部程序 |
| 同上：markerOnset, energy, analyze | 辨識標記、量功率、判定格式／頻率／聲道／連續性；回傳 pass、fail 或 invalid |
| [audio-quality-tools.mts](../../../scripts/lib/audio-quality-tools.mts): inspectAudio | 先檢查格式，限時解碼前 60 秒，不重取樣、不混音 |
| 同上：recordAudio | 建置並驅動開發版程式，擷取開始後播放素材，驗證完成並只清理自有子程序 |
| [audio-quality-summary.mts](../../../scripts/lib/audio-quality-summary.mts): summarize | 預期／完成 run 數、結果計數、min／median／max 與缺少值數；未完成為 incomplete |
| [CLI](../../../scripts/audio-quality.mts): inspect, context, read, exitCode | 報告來源、環境快照、有限外部讀取與結束碼；頂層負責新目錄及 1–10 次重跑 |

## 簽署身分建立

[create-signing-identity.mts](../../../scripts/create-signing-identity.mts) 將身分檔建立與鑰匙圈配置分開。`createIdentity(name, output, password, days)` 驗參數與輸出位置、排他建立私人目錄、產生並核對自簽 Code Signing 身分、匯出加密 PKCS#12，回傳公開 metadata；成功移除中間檔，失敗清理新目錄。`openssl(args, password)` 以子程序環境傳密碼並隱藏敏感診斷。`main()` 解析 CLI、保留既有符合名稱的憑證，要求明確新建參數；不修改鑰匙圈。

## 發布驗證工具

[release.mts](../../../scripts/release.mts) 的 `validateTag`（等於 tag 的穩定或 pre-release 版本）、`isPrerelease` 與 `assertUnreleased` 定義發布閘門；`latestFlag` 只在沒有更新的正式版已公開時，才把正式版標為 latest。`verifyDmg` 唯讀掛載、核對封裝與簽章，`assertDmgContents` 要求可見根目錄恰為 `Applications` 與 `RecordStuff.app`，並拒絕允許的 Finder 版面檔以外的隱藏項目，以 `lstat` 確認每個都是一般檔案而非目錄或符號連結，`verifyCandidate` 比對最終 checksum／metadata；`context` 取得來源／版本／repository，`notes` 產生英文發行說明。`assertPublishedAssets` 要求 release 非 draft 且 assets 的名稱、大小與 digest 與已驗證檔案相符。`compareVersions`、`setPackageVersion`、`replaceMarked`、`renderDownloadSection` 與 `renderVerificationRecord` 是 record 步驟的純函式。CLI `main` 分派 preflight、version、candidate、verify、publish、published 與 record；只有 publish 寫入 GitHub，只有 record 寫入 repo 檔案，在重驗候選版與 tag 的 commit 後建立公開 release（latest、歷史版本或 pre-release）。`start-app.mjs --verify-app` 共用 `verifyBundle`，不需要 Keychain 私鑰。

`cleanup-release-keychain.py` 僅在 disposable GitHub-hosted runner 清理該次憑證信任與 keychain，每項命令最多等待 15 秒，逾時終止該程序群組並警告，最後移除公開憑證與加密封裝暫存檔。
