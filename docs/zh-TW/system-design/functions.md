# 函式與方法設計索引

[English](../../system-design/functions.md) | [繁體中文](functions.md)

以下按原始碼檔案說明具名函式及方法的契約。型別、參數的完整 TypeScript 宣告由各檔案連結查閱；這裡記錄輸入如何變成結果、狀態及副作用。constructor、getter 與流程內具名 helper 也列出；匿名 callback 的順序見 [錄製管線](recording.md) 與 [桌面功能](desktop.md)。

## App 組裝 — main/index.ts

[原始碼](../../../src/main/index.ts)。`main()` 裡的動作函式閉包共享 settings、recorder、tray；它們不是可由 renderer 任意呼叫的 API。

| 函式 | 輸入 → 結果與設計 |
| --- | --- |
| `defaultOutputDir()` | Electron videos 路徑 → 加上 RecordStuff；不在此建立資料夾 |
| `osSupported()` | process.platform／Darwin release → boolean；macOS major ≥22，其他平台目前直接 true |
| `isFirstRun(userDataDir)` | 以 wx 建 marker；首次成功為 true，已存在或 I/O 失敗為 false；只用於 Windows 提示 |
| `resourcesDir()` | packaged → resourcesPath；開發版 → appPath/resources |
| `chooseDisplayMedia(request, callback)` | 查 sources 與 primary id → callback(video, loopback)；無匹配用第一來源，無來源／拒絕走 deny |
| `deny(reason, why)` | 記 log 與 lastDenialReason，空 streams callback 拒絕；讓 renderer 泛用錯誤可還原具體原因 |
| `main()` | 等 ready、組裝依賴、建立 Tray／watcher、註冊動作與退出；錯誤事件寫 log |
| `quality()` | 開發記憶體 override 或已保存設定 → 平台可用的有效品質 |
| `handleAction(action)` | 字串 action、setQuality patch 或 setLanguage → 對應 stop／quit／設定／relaunch／Finder 動作 |
| `revealLog()` | 有 log 選檔，沒有則開 logs 目錄；開啟失敗留 log |
| `changeOutputDir()` | 系統對話框 → 保存使用者選擇，失敗通知；成功清位置錯誤並 refresh |
| `setQuality(patch)` | 僅 idle／needsPermission 保存合法 patch；失敗通知且保留舊值；成功 refresh |

事件：uncaughtException 留 log 並顯示對話框；unhandledRejection 留 log。Recorder state／saved／captureStarted／failed／permissionRequested 分別更新 Tray、發通知、處理降級與失效授權。before-quit 忙碌時等待 shutdown；will-quit 釋放資源。

## 狀態機 — main/recorder.ts

[原始碼](../../../src/main/recorder.ts)。所有依賴可注入，便於不用 Electron 測 session 競態、I/O 與計時。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `formatTimestamp(date)` | Date → 本地時間安全檔名，不使用 UTC |
| `errorCodeOf(cause, fallback)` | 已知 cause.code → ErrorCode；其他回 fallback |
| `delay(ms)` / `messageOf(cause)` | 退出 grace 等待 Promise／錯誤字串化 |
| `Recorder.constructor(deps)` | 補 clock、id、timeout、log 預設並訂閱 host 訊息／故障 |
| `state` getter | 回目前權威狀態；不得由 Tray 另外維護一份業務狀態 |
| `subscribe(listener)` | 加入事件集合 → unsubscribe 函式 |
| `toggle()` | idle 開始、recording 停止、needsPermission 發引導事件，其餘忽略 |
| `stop()` | 僅 matching recording session → stopping，設 stop timeout，送 stop |
| `shutdown()` | 等 starting 落定、停止 recording、等 stopping／failure；与退出 hard cap 競速 |
| `setPermission(status)` | idle／needsPermission 間更新；不覆蓋忙碌 session 狀態 |
| `outputDirChanged()` | 清 idle.outputDirUnavailable，其他狀態不改 |
| `start()` | preflight、建立快照與 session、驗位置、開 writer、start host；每階段處理 late 結果 |
| `openUniqueWriter(dir, stamp)` | 嘗試暫存／最終檔名 pair；暫存 EEXIST 最多 10 次，其他錯誤直接拋出 |
| `handleHostMessage(message)` | 過濾 session；處理 started／chunk／stopped／error；過期 started／chunk 回 stop |
| `handleChunk(session, seq, bytes)` | 驗連續 seq、清首片 timer、append；write reject 轉 fail |
| `finalize(session)` | 等 pending append，確認 session 未失效，finish writer；成功 idle＋saved |
| `handleHostFailure(code, detail)` | 有 session 才進 fail；idle 時不假造錄製錯誤 |
| `fail(id, code, detail, flags)` | 先 detach session／清 timer／stop／idle，後 abandon，最後 failed 帶 partialPath |
| `clearTimer(session)` | 取消 session deadline 並清欄位 |
| `setState(state)` / `emit(event)` | 替換狀態並發事件／依序呼叫 listeners |
| `nextStateChange()` | 一次性訂閱 state，收到後取消訂閱並 resolve |

## Host 監督器 — main/capture-host.ts

[原始碼](../../../src/main/capture-host.ts)。這個 CaptureHost 與 renderer 同名類別在不同程序。

| 方法 | 契約與副作用 |
| --- | --- |
| `constructor(options)` | 保存 preload／HTML／devUrl，預設 ping 5 秒、ready 8 秒 |
| `onMessage(listener)` / `onFailure(listener)` | 登錄有效訊息／host 故障 callback |
| `start(id, quality)` | await ensureReady，再送 start；建立／load 失敗 reject |
| `stop(id)` | 有 port 才送 stop，無 port 時無作用 |
| `destroy()` | 呼叫 teardown，供 App 退出 |
| `ensureReady()` | 重用存活視窗 ready Promise，否則 teardown＋create；失敗清資源 |
| `create()` | 建 sandbox 視窗／channel、裝 guards／crash handler、載頁／交 port、等 ready、啟動心跳 |
| `ping()` | 先查兩次未回覆，逾限 teardown＋failed；否則累計 missedPongs 並送 ping |
| `post(message)` | 透過目前 port 發 MainMessage |
| `emitFailure(code, detail)` | 發送程序失敗事件，由 Recorder 決定 session 收尾 |
| `teardown()` | 清 interval、close port、清 ready、destroy 視窗，允許下次重建 |

## 擷取與編碼 — renderer/capture-host.ts

[原始碼](../../../src/renderer/capture-host.ts)。沒有檔案或任意 Node API。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `measureFrameSize(stream, options)` | DOM video 量 intrinsic 尺寸；等待 metadata／resize／timeout，回尺寸或 undefined；finally detach video |
| `current()` / `matches(size)` / `check()` | 量測內 helper：讀正尺寸、比 expect、符合時 clear timer／resolve；timeout 回最後看到的尺寸 |
| `CaptureHost.constructor(port, options)` | 訂閱 message、start port、送 ready，量測器可注入 |
| `handle(data)` | isMainMessage 過濾，分派 ping→pong、start、stop |
| `start(id, quality)` | 拒絕重疊與不支援 MIME；等待 stream、取消檢查、音軌檢查、applyQuality、建 MediaRecorder、回 started |
| `cancelled()` | start 內檢查取消 id；取消時移除 pending、停 tracks、送 stopped |
| `refuse(code, detail)` | start 內拒絕路徑：移除 pending、停 tracks、送 error |
| `stop(id)` | pending 轉 cancelled；active matching id 只要求 stop 一次，inactive 時直接排 finish |
| `enqueueChunk(session, blob)` | 空 Blob 忽略；配置 seq，chain 中轉 ArrayBuffer 並複製送 port；轉換失敗回 error |
| `finish(session, then)` | finished 防重入；停 tracks、等全部 chunk 送完、清 active session，再執行 terminal callback |
| `fail(id, code, detail)` / `send(message)` | 建 error／發 HostMessage，不改 main 狀態 |
| `finiteOrUndefined(value)` | 有限 number → 原值，其他 → undefined |
| `applyQuality(stream, quality, measure)` | 量來源、fit cap、重送 fps constraint、重測、計目標 → CaptureReport；降級／fallback 寫 warnings |
| `stopTracks(stream)` | 對所有 MediaStreamTrack 呼叫 stop |
| `describe(cause)` | Error name/message 或 String，用於診斷 |
| `classifyGetDisplayMediaError(cause)` | NotAllowedError→permission_denied；NotFoundError→no_display；其他→capture_start_failed |

頁面 message listener 檢查 source／標記／port 後建立 host。MediaRecorder callbacks 的先後順序是 chunk chain → terminal message，詳見 [錄製管線](recording.md)。

## 影片儲存 — main/file-writer.ts

[原始碼](../../../src/main/file-writer.ts)。nodeFs 將 open／rename／unlink／mkdir／writeFile 適配成可替換 I/O。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `FileWriteError.constructor(code, filePath, cause)` | 附 code／路徑／原始 cause 的 Error |
| `describe(cause)` / `errnoCode(cause)` | 取得文字／errno，未知 errno 為 undefined |
| `classifyWriteError(cause)` | ENOSPC → disk_full，其他 → output_write_failed |
| `ensureWritableDir(dir, io)` | mkdir＋寫 probe；失敗拋 output_open_failed；probe 刪除 best effort |
| `FileWriter.constructor(...)` | 保存 handle／路徑／I/O，啟動週期 sync 佇列 |
| `FileWriter.open(recordingPath, finalPath, options)` | wx 開暫存檔 → writer，失敗包成 FileWriteError |
| `bytesWritten` getter | 回 append 成功後累計的 bytes 計數 |
| `append(bytes)` | closed 時 reject；enqueue write，成功累計 bytes |
| `finish()` | enqueue sync，release，再 rename → 最終路徑；失敗 reject |
| `abandon()` | 等佇列、best effort release；有 bytes 留暫存路徑，空檔盡力刪除；不拋出 |
| `release()` | 一次性 closed／清 fsync timer／close handle |
| `enqueue(task)` | 依序執行；首個 failure 被記住，後續回同一錯誤，內部 queue 保持可接續 |

## 設定、品質與協定

[SettingsStore](../../../src/main/settings.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `parseSettings(text)` | v1／v2 JSON → settings＋warnings；整體不合法回 undefined；壞 quality 保留 outputDir |
| `constructor(options)` / `load(defaultDir)` | 同步讀檔、檢查、fallback 與 log；不立刻把 fallback 回寫 |
| `outputDir` / `quality` / `language` getters | 讀目前已成功提交的設定 |
| `setLanguage(language)` | 驗 en／zh-TW，排入保存佇列，保留品質與位置 |
| `setOutputDir(dir)` | 驗絕對路徑 → save 更新 |
| `setQuality(patch)` | 驗合併值合法 → save；實際入列後再合併最新 committed 值 |
| `save(update)` | 序列化寫入；write 成功才換記憶體；失敗不阻斷後續 queue |
| `write(settings)` | mkdir、JSON.tmp、rename；不負責通知 |

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

[shared/protocol.ts](../../../src/shared/protocol.ts)：`isRecord()`、`isNonEmptyString()` 是 guards 的 helper；`isMainMessage()` 驗 start／stop／ping，`isHostMessage()` 驗六種 host 訊息，chunk 要求非負整數 seq 與 ArrayBuffer。[shared/state.ts](../../../src/shared/state.ts) 的 `isErrorCode()` 以 ERROR_CODES 白名單檢查字串。

[preload/index.ts](../../../src/preload/index.ts) 沒有具名函式：唯一 ipcRenderer callback 接收 `capture-host-port` 後將 event.ports 轉交 window，沒有 contextBridge API。

[shared/i18n.ts](../../../src/shared/i18n.ts)：`isLanguage(value)` 驗 en／zh-TW；`translate(key, language, values)` 預設英文，依 ZH_TW 取得中文模板並代入所有具名 placeholder。`notice(body)` 包裝通知標題與內文；trayModel 的 `text`／`model` helper 產生翻譯與呈現模型。通知函式接受 optional language，預設英文。

## 權限 — main/permission.ts

[原始碼](../../../src/main/permission.ts)。

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `screenCaptureGranted()` | Electron screen status 是否等於 granted |
| `openScreenCaptureSettings()` | shell.openExternal 固定設定 URL → Promise |
| `countCapturableScreens()` | getSources screens、無縮圖 → 數量，OS 拒絕則 reject |
| `constructor(onChange, options)` | 保存注入 API，預設 interval=5 秒、validateTimeout=4 秒 |
| `start()` / `stop()` | 立即 check、設 interval／activate callback；stop 清 interval |
| `markRelaunchRequired()` | OS 尚 granted 才清驗證快取並 check |
| `check()` | 未授權重設＋promptOnce；已驗證直接 emit；其餘排 validate |
| `promptOnce()` | 每程序至多一次 getSources 註冊／提示呼叫，結果僅記 log |
| `validate()` | 去重＋timeout，結束後再查 grant；有來源才 validated，其他 needsRelaunch |
| `emit(status)` | 相同 granted／needsRelaunch 不重送 |
| `withTimeout(promise, ms)` | timer 與 Promise 競速；settle 清 timer；不取消底層 OS 請求 |

## Tray 模型與原生呈現

[tray-model.ts](../../../src/main/tray-model.ts)：

| 函式 | 契約 |
| --- | --- |
| `abbreviateHome(path, home)` | 只縮寫相同 home 或完整路徑前綴，避免误縮其他同名字首資料夾 |
| `disabled(label)` / `item(label, action, tooltip?)` | 建灰色／可點模型項目 |
| `footer(language)` | 產生語言單選、顯示 log、結束，所有狀態皆可用 |
| `outputDirItems(ctx, enabled)` | 產生位置與更改位置項目，按狀態鎖定 |
| `radioGroup(key, current, choices, label, available)` | 建各 radio 的 checked／enabled 與 setQuality patch |
| `qualityMenu(ctx)` | 三個品質子選單；未驗平台的 60 fps 標示停用 |
| `permissionActions(needsRelaunch, language)` | 已判斷需重啟只給重啟；否則給設定與「已經允許了？」重啟 |
| `trayModel(state, ctx)` | 狀態 → 完整圖示／標題／tooltip／menu |
| `savedNotification(path)` | filename → 存檔文案 |
| `permissionNotification(needsRelaunch)` | 設定／重啟的提示文案 |
| `settingsWriteFailedNotification(dir, home)` | 說明位置設定未保存、仍使用原值 |
| `qualityWriteFailedNotification()` / `languageWriteFailedNotification()` | 說明品質／語言設定未保存 |
| `frameRateDowngradeNotification(requested, actual)` | 說明系統實際提供的 fps |
| `trayHintNotification()` | Windows 首次啟動尋找系統匣提示 |
| `errorNotification(code, partialPath, ctx)` | 各錯誤與部分檔的本地化說明；技術 detail 留在英文 log，不放通知摘要 |

[tray.ts](../../../src/main/tray.ts)：

| 函式／方法 | 契約與副作用 |
| --- | --- |
| `AppTray.constructor(options)` | loadIcons、建 Tray、忽略 double-click event、註冊左右鍵 |
| `render(state)` / `refresh()` | 保存呈現用 lastState，更新必要圖示／title／tooltip；refresh 用同狀態重讀 context |
| `destroy()` | 銷毀原生 Tray |
| `notifySaved(path)` | show 存檔通知，點擊 reveal |
| `notifyError(code, partial)` | show 錯誤，點擊優先部分檔，其次位置／權限 action |
| `revealFromNotification(path)` / `reveal()` | macOS setImmediate 後 showItemInFolder，記 requested／failed |
| `notifyPermission(needsRelaunch)` | 文案＋開設定／重啟 callback |
| `notifySettingsWriteFailed(dir)` / `notifyQualityWriteFailed()` / `notifyLanguageWriteFailed()` | 保存失敗通知，無設定 mutation |
| `notifyFrameRateDowngrade(requested, actual)` / `notifyTrayHint()` | 對應純文案的原生通知 |
| `show(text, onClick?)` | 檢查支援、建立 silent Notification、掛 click／failed、show |
| `log(message)` | 呼叫注入 logger（若有） |
| `popUpMenu()` | 依現在 state/context 重建 menu 後彈出 |
| `toTemplate(entry)` | 遞迴模型 → Electron MenuItemConstructorOptions，click 分派 action |
| `loadIcons(dir)` | Windows ICO；其他走 template PNG，macOS 配合 @2x 素材 |

## Log 與自動錄製

[log.ts](../../../src/main/log.ts)：`rotatedPath(path, index)` 組 archive 檔名；`rotateLog(path, keep)` 刪最舊再逆序搬移；`formatLine(message, now)` 加 ISO 前綴；`createFileLogger(options)` 回同步 Log closure。closure 內 `sizeOf()` 查長度（失敗視 0），`appendToFile()` 建目錄、必要時輪替、追加；回傳 logger 先 stdout，磁碟錯誤後停用檔案輸出。

[autorecord.ts](../../../src/main/autorecord.ts)：`parseAutoRecord(value, isPackaged)` 在打包版／空值回 undefined；其餘解析 seconds∈(0,3600] 與合法 quality patch，合併預設而非使用者設定。`runAutoRecord(config, deps)` 等預設 1.5 秒後由公開 toggle 開始，進 recording 才排計時停止，saved／failed／needsPermission 後由內部 `finish(message)` 一次性 log＋quit。用於開發量測，不在正式版提供遠端控制。

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

[make-icons.mjs](../../../scripts/make-icons.mjs)：`coverage(shape, px, py)` 做超取樣覆蓋；`circle()`／`ring()`／`roundedSquare()` 建幾何遮罩；`rasterize(size, layers)` 合成 RGBA；`chunk(type, data)` 建 PNG chunk（含 CRC）；`png(size, rgba)` 封 PNG；`ico(entries)` 封多尺寸 ICO；`idleShape()`／`recordingShape()` 建 tray 圖樣；`appIcon(size)` 建 App 圖樣。頂層輸出資產，macOS 使用 iconutil 生成 ICNS，其他平台保留現有 ICNS。

## 錄影驗收工具

工具資料流及門檻見 [tooling](tooling.md)。工具是開發端程式，不在 runtime bundle。

| 原始碼／函式 | 輸入 → 結果與副作用 |
| --- | --- |
| [probe-recording.mjs](../../../scripts/probe-recording.mjs) `probe(file)` | ffprobe JSON → stream／container 數據；CLI 逐檔列出 |
| 同檔 `ratio(text)`、`kbps(bps)`、`fixed(n, digits)` | 解析比例／格式化量測，未知以文字表示 |
| [verify-recording.mts](../../../scripts/verify-recording.mts) `usage()` | 列參數格式並 exit 2；頂層解析 CLI，逐檔驗證、輸出、以 fail 決定 exit 1 |
| [lib/media-tools.mts](../../../scripts/lib/media-tools.mts) `ToolMissingError.constructor(tool)` | 缺工具的明確 Error |
| 同檔 `run(tool, args)`、`hasTool(tool)` | spawnSync 包装／可啟動性檢查；有 maxBuffer，不載入影片到 App |
| 同檔 `probe(file)` | ffprobe count_frames／streams／format，返回 JSON 與 decodeErrors |
| 同檔 `frameTimes(file, duration, edgeSeconds)`、`read(interval?)` | 影格 PTS；長片分別讀頭尾區間，不把中間空隙算掉幀 |
| 同檔 `channelRms(file)` | ffmpeg astats → 每聲道 dBFS |
| 同檔 `syncMarkers(file, duration)` | 解碼測試頁閃光／短音，回 flashes／beeps 時間點 |
| [lib/verify-recording.mts](../../../scripts/lib/verify-recording.mts) `readLogText(path)` | active log＋最新 .1 archive，保留跨輪替 session |
| 同檔 `readLogPairs(path?)` | 有 log 則配對，無 log 返回空 Map |
| 同檔 `verifyRecording(file, pairs, options)` | probe／frame／RMS／optional sync→measure→judge→VerifyResult |
| 同檔 `parseDimensions(text)` | WxH 字串 → dimensions 或 undefined |
| 同檔 `tryExec(cmd, args)`、`environmentSummary()` | best effort 環境查詢；機器／OS／Electron／display／工具版本描述 |
| 同檔 `localDate(date)`、`measurementsPath(date)` | 本地日期 → docs/verification/measurements 日期檔名 |
| 同檔 `appendMeasurements(path, results, context)` | 新檔寫環境、附加 Markdown；同名 JSON 保存結構化數據 |
| [run-matrix.mts](../../../scripts/run-matrix.mts) `shorten(entries, seconds)`、`usage()` | 調矩陣時長／參數說明後退出 |
| 同檔 `mainDisplaySize()`、`outputDir()` | macOS 主螢幕／使用者設定或預設位置 |
| 同檔 `sleep(ms)`、`electronPids()`、`cpuPercent(pids)` | 回歸間隔與本專案 Electron 程序 CPU 取樣 |
| 同檔 `logPosition()`、`readFrom(path, offset)`、`logSince(start)` | 以檔案位置讀本次新 log，處理輪替 |
| 同檔 `recordOnce(entry)` | 用環境變數啟動開發 App，等待結果並取樣 CPU，回 outcome |
| 同檔 `main()` | 驗工具／平台、開素材頁、依序 recordOnce＋verify、寫結果、cleanup |

### 純量測邏輯 — scripts/lib/verify.mts

[原始碼](../../../scripts/lib/verify.mts)。所有數學／解析與判定集中於此，不直接 spawn 程式。

| 函式 | 契約 |
| --- | --- |
| `numberOrUndefined(text)`、`parseRatio(text)` | 字串／分數 → 有效數值，無效回 undefined |
| `parseCaptureLine(line)` | capture log → requested／track／target／warnings |
| `pairRecordingsWithLog(text)`、`basename(path)` | 以 session、saved 路徑將錄影檔名配對 capture report；basename 處理路徑分隔 |
| `parseAutorecordOutcome(text)` | autorecord log → saved 或 failed |
| `parseFrameTimes(csv)`、`frameStats(intervals, fps)` | PTS 解析，分區計算間隔／掉幀，不跨區間假算缺片 |
| `dropEofClosures(times, duration)` | 移除太靠近 EOF 的偵測器收尾假標記 |
| `parseBlackdetect(stderr, duration)`、`parseSilencedetect(stderr, duration)` | 解析閃光／音訊邊界並排除 EOF 假標記 |
| `parseChannelRms(stderr)` | 每聲道 RMS 字串 → dB 值 |
| `median(values)`、`syncStats(flashes, beeps, options)` | 配對至少 3 個有效標記，估偏移與頭尾漂移；不能只用單點巧合當同步 |
| `measure(file, bytes, probe, intervals, extras)` | 組合長度／尺寸／fps／碼率／音訊／decode／CPU／sync 成 Measurement |
| `fmt()`、`mbps()`、`kbps()`、`ms()` | 數值格式化，未知顯示破折號 |
| `pass(ok)`、`offsetWithinLimits(offsetMs)`、`aspectMatches(a, b)` | 判定 helper：boolean verdict、非對稱偏移範圍、長寬比容差 |
| `judge(measurement, entry, options)` | 對門檻逐列產出 Check；缺必要量測為 n/a，不臆測 pass |
| `overallVerdict(checks)` | 有 fail 即 fail；有 pass 且無 fail 為 pass；全不適用則 n/a |
| `describeRequested(entry)`、`formatText(file, entry, checks)` | 人可讀設定與終端表格 |
| `cell(text)`、`formatMarkdown(title, file, entry, checks, context)` | escape 表格分隔並產 Markdown；供追加證據 |

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

[release.mts](../../../scripts/release.mts) 的 `validateTag`、`validateDigest`、`assertUnreleased` 與 `assertPromotion` 定義發布閘門。`verifyDmg` 唯讀掛載、核對封裝與簽章，`assertDmgContents` 要求可見根目錄恰為 `Applications` 與 `RecordStuff.app`，並拒絕允許的 Finder 版面檔以外的隱藏項目，以 `lstat` 確認每個都是一般檔案而非目錄或符號連結，`verifyCandidate` 比對最終 checksum／metadata；`context` 取得來源／版本／repository，`notes` 產生英文發行說明。CLI `main` 分派 preflight、candidate、verify、draft 與 promote；僅最後兩者寫入 GitHub，只有 promote 可公開發布。`start-app.mjs --verify-app` 共用 `verifyBundle`，不需要 Keychain 私鑰。

`cleanup-release-keychain.py` 僅在 disposable GitHub-hosted runner 清理該次憑證信任與 keychain，每項命令最多等待 15 秒，逾時終止該程序群組並警告，最後移除公開憑證與加密封裝暫存檔。
