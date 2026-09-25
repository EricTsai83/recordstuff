# 040 — 錄影前倒數與可區分的選單列狀態

[English](040-recording-countdown.md) | [繁體中文](040-recording-countdown.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-25。排在 033 之後、[034](034-windows-tray-icons.zh-TW.md) 之前；因為與 [038](038-recording-health-guards.zh-TW.md) 都會修改 Recorder 的開始階段，所以排在 038 之後。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

按下選單列圖示或快捷鍵後約 0.3 秒就開始錄影：[2026-09-25 快捷鍵驗收](../docs/verification/measurements/2026-09-25T08-32-13-558Z-hotkey-acceptance/report.md)中 `starting → recording` 為 318 ms。因此影片開頭會錄到游標離開選單列的過程，而 RecordStuff 沒有編輯器可以剪掉。本計畫在擷取前加入短暫倒數，並讓每個選單列狀態各有圖示，讓未錄影、準備中／儲存中、倒數中與錄影中一眼就能分辨。不加入開始音效、全螢幕覆蓋層、暫停、編輯器、依觸發方式區分的行為，也不新增錄影格式。

維護者決策（2026-09-25，依討論與靜態 HTML 草稿；草稿不是 repo 內的檔案）：

- 倒數預設 3 秒；「錄影設定」提供關閉、3、5、10 秒。預設值也套用到既有使用者：沒有此欄位的設定檔讀為 3 秒。
- 只在被錄螢幕右上角顯示高度透明的數字（3、2、1），直接畫在畫面上，沒有方框、底色或外框（維護者當天追加的決定）。不加圓環、文字、取消提示、音效或全螢幕變暗。
- 選單列圖示：未錄影維持圓環；準備中與儲存中改用沙漏，取代「圓環加 `…` 標題」（先試過圈內三個小點，因為在選單列尺寸下不夠明顯而放棄）；倒數中用碼錶且不加標題，因為右上角已經顯示數字；錄影中維持實心圓加 `REC`。所有圖示都是同尺寸的 16 pt template 圖片，只有 `REC` 會改變項目寬度。
- 倒數可用左鍵點選單列圖示、錄影快捷鍵、選單列選單的「取消倒數」或結束 App 取消。取消不算失敗。

責任檔案：[Recorder](../src/main/recorder.ts)、[protocol](../src/shared/protocol.ts)、[renderer 擷取 host](../src/renderer/capture-host.ts)、[main 擷取 host](../src/main/capture-host.ts)、新的倒數覆蓋層（main 擁有的視窗、renderer 頁面與 preload）、[tray model](../src/main/tray-model.ts)、[tray](../src/main/tray.ts)、[設定](../src/main/settings.ts)、[設定 model](../src/main/settings-model.ts)、[翻譯](../src/shared/i18n.ts)、[App 串接](../src/main/index.ts)、[autorecord](../src/main/autorecord.ts)、[圖示產生器](../scripts/make-icons.mjs)、受影響的驗收 runner 及其測試。所有時間與外觀數值集中在同一個共用模組並寫明初始目標值，只憑書面證據調整。

## Cap 參考

固定 revision `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`（靜態原始碼檢視，未執行 Cap）：

- Tauri 桌面版[預設 3 秒](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/general_settings.rs#L338)，提供[關閉、3、5、10 秒](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src/routes/%28window-chrome%29/settings/general.tsx#L515-L525)。它[在最後一秒預熱擷取管線](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/recording.rs#L2465-L2498)，並[在起始閘門開啟前丟棄畫格](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/recording/src/output_pipeline/start_gate.rs#L17-L22)，讓擷取剛好從 0 開始。
- 該版本[倒數期間忽略停止](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src/routes/in-progress-recording.tsx#L566-L569)；GPUI 重寫版則[讓停止可以取消倒數](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop-gpui/src/session.rs#L1056-L1060)。
- Chrome 擴充的覆蓋層[在擷取前 140 ms 移除，並有 220 ms 淡出](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/chrome-extension/src/content/countdown-overlay.tsx#L10-L16)，否則倒數尾巴會出現在影片開頭。
- Cap [等開始音效從裝置播完才開閘](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/recording_start_sound.rs#L5-L14)；在 macOS 上[不對錄影控制列套用系統的內容保護](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/windows.rs#L3793-L3795)。

採用：預設值與選項、倒數前先準備擷取並在 0 時開始、擷取前移除覆蓋層、可取消的倒數。不採用：開始音效（RecordStuff 錄的就是系統聲音，而 `restrictOwnAudio` 能否排除 App 自己的聲音尚未驗證）、丟棄畫格的閘門（此處 `MediaRecorder.start()` 就是閘門）、全螢幕覆蓋層，以及內容保護（`getDisplayMedia` 無法排除個別視窗；靠時間錯開保護）。

## 實作契約

- [ ] **開始流程。** 從 idle 觸發後進入 `starting` 並顯示忙碌圖示；preflight、資料夾探測與獨占建立暫存檔都不變。檔名維持「要求開始時」的當地時間，因此有倒數時會比第一個畫格早「準備時間加倒數」，須寫入文件。main 送出 `start`；renderer 取得串流、檢查音訊、量測畫格、套用品質、重查 track 存活、建立尚未啟動的 MediaRecorder，然後以 CaptureReport 回覆 `prepared`。既有 120 秒擷取請求期限改為界定 `start → prepared`，因此權限提示、缺少音訊、不支援 MP4 與螢幕錯誤都會在倒數前出現。倒數關閉時，main 立即送出 `record`。否則 Recorder 進入 `countdown`、顯示覆蓋層，並以單一單調時鐘錨點每秒跳一次，不累積 timer 誤差。在 N 秒減去覆蓋層提前量（初定 300 ms）時要求覆蓋層消失，並在上限內等待確認（初定 500 ms；逾時就銷毀視窗、記 log 後繼續）。在 N 秒時送出 `record`；若覆蓋層消失得更晚，就等它完成再送。renderer 呼叫 `recorder.start(CHUNK_INTERVAL_MS)` 並回覆 `started`。Recorder 進入 `recording`，以保存的 report 發出 `captureStarted`，並如現況啟動首個媒體期限與 038 的停滯 timer；`record → started` 使用 8 秒的開始期限。REC 要等擷取開始後才出現，所以影片最前面幾格可能錄到選單列的碼錶，就像現在會錄到 `…`；右上角的倒數數字則不可出現在影片中。
- [ ] **取消。** 在送出 `record` 之前，點擊、「取消倒數」或快捷鍵都會取消這次嘗試：清除 timer、停止 host、關閉覆蓋層、abandon writer 讓空的暫存檔被移除、回到嘗試前的 idle 狀態（保留 `lastSavedPath`），並發出帶有原因的 `cancelled` 事件與 log。不發出 `failureStatus`、失敗歷史、通知或螢幕診斷。送出 `record` 之後的點擊視為停止要求，在 `started` 到達時執行（沿用既有 `stopOnStart`），避免幾毫秒的競態讓擷取持續進行。`starting` 與 `stopping` 期間的點擊仍然忽略。
- [ ] **結束 App。** 倒數中結束 App 會立即取消倒數。開檔或準備期間結束 App 則標記這次嘗試，讓 `prepared` 到達時直接取消，不倒數也不錄影。這取代目前「starting 的 session 會先錄再存檔」的規則：此時還沒有任何媒體，不論倒數設定為何都一樣。退出協調的其他安全條件不變；同步修改錄影與桌面設計中描述舊規則的文字。
- [ ] **擷取前的失敗。** 準備或倒數期間發生 track 結束、螢幕移除、host 崩潰或無回應，或 `record` 被拒／逾時，都屬於開始失敗：使用 `capture_start_failed` 並以 detail 指明階段，仍發出螢幕診斷，結果為 empty。保留 038 的規則：writer 已保留的磁碟錯誤以其自身代碼回報。已脫離的 session 收到過時的 `prepared` 或 `started` 時，依既有過時規則停止 host。
- [ ] **狀態與協定。** `RecordingState` 新增 `{ type: "countdown"; remaining: number }`，`remaining` 至少為 1，且在 `record → started` 的間隔中保持。每跳一次重新發出狀態，App 記錄 `state → countdown (n)`。`MainMessage` 新增 `record { sessionId }`；`HostMessage` 新增 `prepared { sessionId, mimeType, capture }`，`started` 可移除 report；同步更新型別檢查與測試。renderer 保存已準備的 session（串流存活、recorder 未啟動）：`stop` 釋放 track 並回覆 `stopped`，track `ended` 回覆錯誤，其他 session 的 `record` 一律拒絕。session 快照新增 `countdownSeconds`，與品質一樣只讀一次。Recorder 維持不依賴 Electron：注入一個倒數呈現介面，提供 `show(remaining)`、`update(remaining)` 與 `dismiss(): Promise<void>`。呈現錯誤只記 log，絕不讓錄影失敗；選單列仍會顯示倒數。檢查所有依狀態型別判斷的地方，把 `countdown` 當成進行中的 session：設定鎖定、螢幕媒體請求的回應、快捷鍵與更新的 flush、儲存通知的取消、輸出資料夾的防護（目前也沒涵蓋 `starting`）、settled 時銷毀 host，以及 autorecord。
- [ ] **倒數覆蓋層。** 由 main 擁有的視窗，在準備期間建立，倒數結束、取消或失敗時銷毀；錄影之間不保留，App 在任何 settled 狀態也會再銷毀一次作為保險。視窗透明、無邊框、尺寸與位置固定、無陰影、不出現在工作列、不可取得焦點、以不啟用的方式顯示（macOS 優先使用不啟用的 panel）、忽略滑鼠事件，並位於一般視窗與全螢幕 App 之上（`screen-saver` 層級，全螢幕 Space 可見）。它絕不可啟用 RecordStuff，也不可搶走前景 App 的鍵盤焦點。顯示在 DisplayMedia 為本 session 解析出的螢幕（無法得知時用主螢幕並記 log）：88 × 88 pt 的全透明視窗，距工作區右緣 16 pt、頂端下方 12 pt，只畫數字本身：沒有底色、方框、外框、圓環或模糊。數字後面沒有任何襯底，因此在白色與深色畫面上都靠數字自身的描邊與陰影維持可讀性。初始外觀：SF Pro Rounded semibold 56 pt、等寬數字、置中，白色 28% 透明度，1 px 黑色 10% 描邊，陰影 `0 0 1px` 黑 20%、`0 1px 3px` 黑 14% 與 `0 0 14px` 黑 8%。維護者比較 80%、55%、40% 與 28% 的草稿後選擇最透明的版本，並接受它在亮色照片上會變淡；由 N32 在實際 App 上判斷。動態：淡入 120 ms、數字交替 150 ms、淡出 120 ms 並在視窗隱藏前完成；`prefers-reduced-motion` 時取消淡入淡出，`prefers-reduced-transparency` 時數字改為不透明並加強描邊，仍不加底色。頁面為本機檔案、sandbox、context isolation，沿用設定頁的 CSP，preload 只提供數值訂閱；main 送出數值，頁面只負責顯示。新增對應的 renderer 與 preload build entry。不套用內容保護。
- [ ] **選單列。** `TrayIcon` 新增 `busy` 與 `countdown`。`starting` 與 `stopping` 使用 `busy`、標題留空，沿用既有 tooltip 與選單文字。`countdown` 使用碼錶、標題留空，tooltip 說明幾秒後開始錄影、點一下可取消，選單為一行停用的狀態文字、「取消倒數」（快捷鍵已註冊時其 tooltip 會列出快捷鍵）與原本的結尾項目。idle、needsPermission 與 recording 不變；警告徽章仍只取代 idle 的圓環。產生器新增 16 與 32 px 的 macOS template：busy 為沙漏外框，上下各一條橫桿（x 為尺寸的 0.22–0.78，y 0.10–0.19 與 0.81–0.90），以兩條寬 0.09 的斜筆畫相連，在中央收窄到 0.07 寬的腰部；碼錶為圓心 y 0.56、半徑 0.31／0.20 的圓環，錶冠 x 0.40–0.60、y 0.05–0.14，連桿 x 0.46–0.54、y 0.13–0.27，指針 x 0.46–0.54、y 0.40–0.56，中心點半徑 0.07。Windows 以既有灰色產生 16、24、32、48 px 的 ICO，讓狀態在 Windows 也能區分；Windows 圖示的正式設計屬於 034，本計畫不宣稱任何 Windows 外觀。產生結果維持可重現，其他資產保持位元組相同。
- [ ] **設定。** `Settings.countdown` 為 `0 | 3 | 5 | 10`，寬鬆讀取：缺少時為 3，無效時為 3 並記警告，不提升版本號。「錄影設定」在「螢幕」之後新增「開始前倒數」群組，使用分段控制（關閉／3 秒／5 秒／10 秒），並附說明：數字會出現在被錄螢幕的右上角，點選單列圖示或按快捷鍵可取消。錄影期間與其他錄影設定一樣鎖定。新增 `setCountdown` 動作與選單列動作 `cancelCountdown`。群組、選項、說明、選單列狀態行、tooltip 與選單項目都提供英文與繁體中文。
- [ ] **開發與驗收工具。** autorecord 在記憶體中使用倒數 0，除非其設定另外指定，讓矩陣與音訊品質量測維持原有時序。每個會實際開始錄影的 runner，都要在其隔離或會還原的設定中明確指定倒數，或刻意等待倒數；不可把倒數悄悄算進延遲門檻。`pnpm acceptance` 使用真實設定：分別回報準備延遲、每次倒數跳動與 `record → started`，並新增取消案例（第二次按下即取消，沒有檔案也沒有失敗紀錄）。通知與更新 runner 指定為 0 並在結束後還原。lifecycle fixture 的 host 支援 prepare 與 record。倒數驗收把前 15 個畫格中數字區域的裁切圖存入報告；若測試素材在該區域是靜態的，另與兩秒後同區域的裁切比較，並以寫明的門檻判定。
- [ ] **文件與網站。** 同步更新雙語文件：錄影設計（狀態圖、開始步驟、期限表、終止擁有權與退出）、桌面設計（含新圖示的選單列狀態表、覆蓋層、設定）、產品總覽（狀態列）、架構／函式／repo 結構文件中關於新視窗與模組的說明、工具指南（autorecord 與 runner）、驗收指南（倒數案例），並新增一則設計決策，記錄上述預設、呈現方式與排除項目。英文網站的使用步驟、首頁動畫與說明文字目前描述「點一下就立即顯示 REC」；改為在 REC 之前先顯示碼錶與右上角數字，並說明如何取消。

## 驗證與排除

- [ ] 以注入時鐘與假 host 測試 Recorder：關閉倒數的路徑；依錨點時間跳動；只在覆蓋層消失或達到上限後才送出 `record`；在 `record` 之前以點擊、選單與結束 App 取消；`record` 之後的點擊在開始時停止；準備期間結束 App 會在 `prepared` 時取消；準備與倒數期間的失敗代碼與 empty 結果；取消時沒有失敗狀態；保留 `lastSavedPath`；過時訊息；倒數設定快照。renderer 測試 prepare／record 拆分、準備後停止、準備後 track 結束，以及拒絕 `record`。另測協定型別檢查；選單列狀態、圖示、標題、選單與警告優先順序；設定解析（缺少、無效、每個值）、群組、鎖定與動作；翻譯覆蓋；以假視窗測覆蓋層依工作區計算的位置、視窗選項與每條路徑的銷毀；產生器的尺寸與可重現性；autorecord 預設 0。檢查實際事件、檔案與視窗呼叫，不只計算呼叫次數。
- [ ] `pnpm acceptance:regression`（設定有變更；已包含 `pnpm check`），並檢查兩種語言的設定畫面截圖。
- [ ] 以新的 `pnpm start:app` bundle：透過快捷鍵 runner 與一次選單列點擊測試預設 3 秒；關閉；10 秒一次（兩位數）；第二次按下取消。每個存檔都做媒體驗證與播放，保存數字區域裁切圖與 log 時間（準備、每次跳動、消失到 `record`、`record` 到 `started`、`started` 到第一個 chunk）。
- [ ] 以[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)做代理可觀察的原生檢查：淺色與深色選單列的圖示且寬度不變、數字位置與可讀性、選單中的「取消倒數」，以及倒數期間文字編輯器仍保有鍵盤焦點。需要維護者判斷或特定硬體的案例列為 035 的 N32–N35。
- [ ] `pnpm site:check` 並檢查變更的頁面。
- [ ] 排除：品質與音訊矩陣（MediaRecorder 選項與編碼不變）、長時間錄影、權限重設（擷取請求本身不變，只移動其後的步驟），以及 Windows 原生外觀（屬 034）。VoiceOver 無法可靠朗讀不可取得焦點的視窗；在 035 記錄實際行為，不宣稱支援。

## 完成與證據處理

依[共用測試政策](../docs/zh-TW/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 參考是固定 revision 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
