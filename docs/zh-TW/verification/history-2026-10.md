# 驗證歷史 — 2026 年 10 月

[English](../../verification/history-2026-10.md) | [繁體中文](history-2026-10.md)

[返回驗證索引](README.md)。以下是歷史證據；現行選測規則見[測試指南](../testing.md)。原始 measurements 連結僅本機可用，新 clone 不會包含。

## Plan 090 結案 — 2026-10-23

Plan 090（相機慢出第一格）源自 083 的相機回合，2026-10-23 在 `pnpm start:app` 從 `406132fc` 加上本計畫變更所建置的簽章 bundle 上執行（M1 Pro 參考機，macOS 26.6.2，兩台 BenQ 螢幕，MacBook 闔上蓋子；維護者同意後使用其 iPhone 的接續互通相機）。由 Claude 實作，並在維護者回覆「好了」後執行兩個桌面回合；維護者看過 baseline 後依建議選擇 D1。報告：`docs/verification/measurements/090-r1-before` 與 `090-r2-after`（僅本機）。

- **Baseline（步驟 1）。** 相機的狀態行現在會在結尾寫出第一格何時到。倒數關閉時：相機剛用過，第一格在開啟後 0.73–0.76 秒（相對錄影開始 +0.19 至 +0.26 秒；`measure:cpu` 的四段錄影，其中兩段在錄影工作室關閉後立刻開始）；App 閒置後第一次開始為 2.05–2.08 秒（+1.55 秒，兩段）；錄影工作室的即時預覽剛放掉相機就開始錄影時為 2.75–3.09 秒（+2.19 至 +2.61 秒），這兩段都在 2 秒後被判為中斷並在存檔時標記。預設 3 秒倒數時，同樣的四種情況第一格都在錄影開始前 0.80–1.75 秒就到。延遲跟著「相機的前一個使用者剛放掉它」（錄影工作室）走，而不只是裝置本身。083 的 12 秒案例沒有重現：當時的 log 顯示，在第一格到之前，中斷規則的 2 秒與 4 秒退避已把相機重開了兩次，而這些重開正是誤判中斷引發的。
- **D1。** 立即開始、從不等待；第一格從相機開啟起算，上限為 `CAMERA_FIRST_FRAME_NS`（10 秒，約為量到最慢第一格的三倍）；這段時間內都沒有送出影格的相機回報為尚未就緒（`cameraNotReady`，存檔後發出通知，儲存的紀錄帶 `"cameraNotReady":true`），絕不算中斷，之後像中斷的相機一樣重新開啟；送過影格後才適用 2 秒的中斷規則。第一格之前不合成任何東西。Windows 保留既有的行為，在 `prepare` 中最多等 3 秒，等第一次讀取的結果或拒絕（D11）。說明見[錄影設計](../system-design/recording.md#相機)。
- **變更後（步驟 4）。** 在新的 bundle 上，即時預覽之後立刻開始的兩段錄影，第一格在 +2.22 與 +3.23 秒，都沒有被判為中斷，也沒有標記；閒置後開始為 +0.99 秒。選用闔蓋中的 FaceTime HD 相機代表永遠不送畫面的相機：它在開啟後 10.0 秒回報尚未就緒，從未被判為中斷，存檔行寫著「(the camera was not ready at the start)」，log 記錄通知「錄影開始時相機尚未就緒，在相機送出畫面前只錄到螢幕畫面。」已顯示（截圖上最上層是「已儲存」橫幅，沒有看到另一則的橫幅）。含相機的 `measure:cpu` 通過：R 在 30／60 fps 為 12.2%／17.2%，S 比 R 多 6.9／6.1 點，L 為 15.9%／16.2%，每段錄影從第一秒就有相機；這組數據取代[管線 baseline](../system-design/tooling.md#管線-baseline) 中 083 的相機數據。第一輪的 `measure:cpu` 只因 S 的份額（8.0／8.6 點，D18 為 8 點）失敗，當時維護者在背景播放影片，其 CPU 數據僅供參考。每段 `measure:cpu` 錄影都通過 `pnpm verify`（變更後那一輪加 `--test-material`，因為只有素材的稀疏嗶聲）；手動案例的檔案錄的是靜止且無聲的桌面，都能完整解碼，只在假設有素材的位元率與音量檢查上失敗。
- **檢查與審查。** `pnpm check` 通過（176 個檔案、2096 個 TypeScript 測試；151 個 Rust 測試、7 個 ignored；Clippy、fmt、建置與引擎載入），Windows target 的 Clippy 也通過。Codex GPT-6.1 Sol 以 medium（fast service tier）唯讀審查找到一個問題：Windows 在 `prepare` 中最多 3 秒的第一次讀取等待，仍會延後慢相機的開始。沒有修改：這段等待有上限、早於本計畫、讓拒絕的相機直接讓開始失敗（D11），且沒有 Windows 實機無法驗證；設計文件現在寫明了這一點。
- **執行環境註記。** agent 的 shell 帶有 `ELECTRON_RUN_AS_NODE=1`，`open` 因此把 bundle 當成 Node 啟動，立即結束且沒有任何 log；runner 的 `scrubbedEnv()` 會移除它，本輪自己的啟動也已清除它。
- **清理。** 每輪結束後都還原了 `settings.json`（最後一輪後內容與開始時相同：相機關閉、倒數 3、60 fps）；RecordStuff 已結束，沒有殘留程序；`caffeinate` 已停止。錄影在 ~/Movies/RecordStuff（2026-10-23 16-40 至 17-28）。
- **未測試。** 開蓋時的內建相機（維護者略過）；實機上第一格在 3 到 10 秒之間到的相機，以及回報尚未就緒後才開始送畫面的相機（只有核心測試）；Windows 只由 CI 檢查，依 076 的 D8。

## Plan 093 結案 — 2026-10-23

Plan 093（相機恢復訊息寫出實際間隔）依維護者要求從 090 拆出，2026-10-23 在 `fab860fb` 的工作樹上執行。由 Claude 實作；依計畫不需要桌面回合，也沒有跑。

- **缺陷。** `CameraFeed::deliver` 從 `heard_ns` 計算恢復的間隔，而相機送出第一格前 `heard_ns` 為 0，所以直到被判中斷後才送出畫面的相機，會回報主機的開機時間：083 的相機回合把約 2.5 秒記成 2478244.7 秒（[紀錄](#plan-083-結案--2026-10-23)）。這個問題從 plan 075 就存在。
- **修正。** feed 保存 refresh 執行緒呼叫 `judge` 時告知的錄影開始時間（`since_ns`），`deliver` 改從 `heard_ns.max(since_ns)` 計算，與 `judge` 判斷中斷時用的基準相同（[camera.rs](../../../native/capture/src/core/camera.rs)）。訊息文字、事件格式、`CAMERA_SILENT_NS` 與各平台的呼叫都不變；沒有改動 090 的開始規則。
- **測試。** `core/tests.rs` 新增一個以明確主機時間撰寫的案例：在開機 1000 秒時開始的錄影中，從一開始就沒有畫面、2.5 秒後恢復的相機回報 2.5 秒；送出過畫面後靜默 4.3 秒的相機回報 4.3 秒（剛好 2 秒時不算中斷）；錄影前送出一格、之後靜默的相機，從錄影開始計算。既有的中斷案例不變且通過。
- **檢查。** `pnpm test:scope -- pipeline-diagnostics`（其篩選下 67 個 Rust 測試、Clippy、fmt）與 `pnpm check` 通過（176 個檔案、2093 個 TypeScript 測試；149 個 Rust 測試、7 個 ignored；建置與引擎載入）。
- **未測試。** 實機上的訊息，由 090 的相機回合觀察；平台在錄影開始後、refresh 執行緒第一次 judge 之前（前 100 ms 內）以 `lose` 回報的中斷，若相機還沒送出任何畫面，仍會從 0 計算；Windows 只由 CI 檢查，依 076 的 D8。

## Plan 083 結案 — 2026-10-23

Plan 083（媒體管線量測與預算）是 Glide 參考系列 083–088 的第一個，2026-10-23 在 `pnpm start:app` 從 `3b76a8cb` 加上本計畫變更所建置的簽章 bundle 上執行（M1 Pro 參考機，macOS 26.6.2，兩台 BenQ 螢幕，MacBook 闔上蓋子）。維護者同意後，由 Claude 實作並執行每個回合；沒有相機的回合都把「相機」開關保持關閉，維護者同意後的第七輪使用其 iPhone 的 Continuity Camera。報告：`docs/verification/measurements/083-r1-off` 至 `083-r7-camera`（僅本機）。

- **新增的內容。** 開發用開關 `RECORDSTUFF_DIAGNOSTICS=1`：每個擷取工作階段在引擎中保留有上限的各階段直方圖（每個 128 個計數器）與佇列最高水位（[diagnostics.rs](../../../native/capture/src/core/diagnostics.rs)），capture host 每 5 秒與工作階段結束時把它們記成 `diagnostics:` 行，錄影工作室頁面只在被要求後才在 Studio 的 port 上回報預覽數據；`pnpm diagnose:pipeline` 把它們讀成 `recordstuff.pipeline-diagnostics/1`，`pnpm measure:cpu -- --diagnostics`、`--material still`、`--studio-active`（以及不加 `--camera` 的 `--studio`）用它們量測（見[管線數據](../system-design/tooling.md#管線數據)）。開關關閉時不計時任何階段，頁面也不為此讀取時鐘。不保留任何畫面、裝置名稱或輸入文字，錄影的資料也不經過 renderer。
- **Baseline 與預算。** 記在工具指南的[管線 baseline](../system-design/tooling.md#管線-baseline)：錄影 CPU 在 30 fps 為 10.1–10.5%、60 fps 為 14.2–14.8%；編碼延遲 p50 18.4 ms；writer 積壓最多 0.6 MB；capture 程序最多 109 MB；預覽從引擎到 canvas 沒有遺失；靜態素材 3.3–3.5%；以及 084–088 對照的預算。本計畫沒有嘗試任何優化，所以沒有採用任何優化：本計畫的成果就是量測本身。
- **開關的成本。** 依序關、開、再關，每種幀率各錄三段：開啟時的各次都落在兩個關閉回合的範圍內（九次合計 30 fps 為 10.09–10.46%、60 fps 為 14.17–14.79%），所以成本在 baseline 範圍內。只看第一次比較（60 fps 關 14.3%、開 14.7%）像是多了 0.4 點；第二個關閉回合（14.17–14.74%）顯示那是漂移。
- **錄影工作室。** 沒有合成相機時，只是看著（每秒 5 格）S 在 30／60 fps 比 R 多 7.3／6.2 點，游標停在上面（每秒 10 格）時多 11.2／10.1 點，D18 是 8 點：操作中的情況超出，與 plan 081 的量測及其 D1 接受的情況一致，所以 `measure:cpu` 的 S 檢查在那裡失敗，該回合只因此判為 FAIL。L 為 14.4–15.1%。
- **相機（第 7 輪）。** 合成 iPhone 相機時：R 在 30 fps 為 12.3%；S 在 30／60 fps 比 R 多 6.9／7.2 點（符合 D18）；L 為 16.8–17.1%；每格合成 p50 1.7–1.9 ms；相機畫面比所在影格舊 112–124 ms；capture 程序最多 113 MB；沒有任何丟棄。該回合判為 PASS。
- **觀察到、未修改。** 錄影工作室關閉後立刻開始的兩段錄影中，iPhone 分別在 2.5 秒與 12 秒後才送出第一格，所以都先被判為中斷（`cameraLost`，存檔後通知）再恢復；是否因錄影工作室放開自己的擷取後 Continuity 重新連線，目前不清楚。每次恢復的訊息都把間隔寫成約 2,478,000 秒（2478244.7 與 2478495.7）：還沒送出任何畫面的相機，是從 0 而不是從錄影開始計算（`CameraFeed::deliver`，自 plan 075 起）。兩者留給之後的計畫。
- **回合中發現並修正。** 即時預覽的數據缺少（1 次中 0 次有記錄）：主程序以結束 capture 程序的方式取消它，所以 host 現在每 5 秒記一次累計快照，parser 保留每個工作階段的最後一次。第一個錄影工作室回合中，L 之後的 ⌘W 沒有關掉錄影工作室，所以該回合的 R（21.3%／25.2%）與 B 的程序角色無效；runner 現在在 ⌘W 無效時按視窗的關閉按鈕，仍關不掉就讓該輪失敗，第二個錄影工作室回合確認了這點。合併情境的標題誤寫「no engine figures」，已更正。
- **檢查與審查。** `pnpm check` 在回合前與回合中修正後都通過（176 個檔案、2093 個 TypeScript 測試；148 個 Rust 測試，7 個略過；Clippy、fmt、建置與引擎載入），Windows target 的 Clippy 也通過，審查修正後 `pnpm test:scope -- pipeline-diagnostics studio` 連同其 11 個 UI 案例也通過。唯讀的 Codex GPT-6.1 Sol（medium）審查找到兩個問題，都已修正：B 拿錄影工作室的錄影比較程序角色，以及開關關閉時頁面仍讀取時鐘。回合中的修正沒有再審查。
- **清理。** 每個 runner 都還原了 `settings.json`（最後一輪後已確認：相機與麥克風關閉，倒數 3，60 fps），正常結束 RecordStuff 且沒有殘留程序，並關閉素材；QuickTime 已關閉；`caffeinate` 已停止。各回合的錄影在 ~/Movies/RecordStuff（2026-10-23 13-01 至 14-33）。
- **未測試。** 計畫列為可選、沒有製作的合成相機素材；相機的數據只來自第 7 輪每種幀率各一段錄影。Windows，依 076 的 D8（其預覽數據與編碼延遲的接法相同但未執行）。開著但被隱藏的錄影工作室；執行期間的 NTP 時鐘跳動；聆聽檔案。

## Plan 089 結案 — 2026-10-23

Plan 089（及時的權限拒絕與闔蓋時的麥克風）從 077 回合的兩項觀察而來，2026-10-23 在 `pnpm start:app` 從 `75ff6c10` 加上本計畫變更所建置的簽章 bundle 上執行（macOS 26.6.2，兩台 BenQ 螢幕，MacBook 全程闔上蓋子）。每次撤銷由維護者按 Touch ID；依維護者要求，其餘桌面操作都由 Claude 完成，並依計畫對原生驗收 skill 的單次例外，以 Computer Use 關閉與重新開啟授權。維護者看過量測後，D1 與 D2 都依建議。筆記、log 與截圖：[2026-10-23T0033-089-step1](../../verification/measurements/2026-10-23T0033-089-step1/task-note.md)（僅本機）。

- **量測拒絕（步驟 1）。**log 中每筆 `display media:` 的授予或拒絕現在都以耗時結尾。授權正常時 `getSources` 花 15–17 ms，第一次就找到來源。撤銷後（關閉時沒有出現「稍後」提示）每次空的 `getSources` 都等約 3 s，所以第一次開始在 `total 9310 ms` 後才被拒絕；`PermissionWatcher` 到拒絕後 3 s 才懷疑授權，因此步驟原本的建議幫不了第一次開始。2026-09-12 至 2026-10-22 的 App log 有 1046 次授予，全部在第一次列舉。
- **D1。**在 macOS 上，capture 程序就緒後，引擎的 `probe` 與列舉賽跑（`checkScreenAccess`），ScreenCaptureKit 回 `-3801` 就立即以 `permission_denied` 拒絕；有螢幕卻列不出來源時，第一次回答就拒絕，除非請求期間螢幕有變化，那時維持三次嘗試。簽章 bundle 上撤銷的授權 92 ms 就被拒絕（`engine access denied 92 ms`），0.5 s 後顯示通知，先前是 9.3 s；授權正常的四次開始都在第一次列舉的 15–17 ms 內授予，每次都排除 RecordStuff 自己的視窗，檔案有畫面與聲音。
- **量測闔蓋的麥克風（步驟 3）。**闔蓋時 IOKit 的 `AppleClamshellState` 為 true，HAL 卻照舊列出內建輸入、狀態存活、資料來源 `imic`。它的 9.93 s 全是剛好為零的樣本；BenQ 麥克風在安靜房間沒有任何零樣本（RMS −53.2 dBFS），而只有系統音訊時混音後也全是零，所以判斷要放在麥克風自己的輸入上。有一次闔蓋時開啟內建麥克風花了 36.2 s，下一次 58 ms，原因不明（觀察）。
- **D2。**內建傳輸類型的輸入在蓋子闔上時由引擎標記 `lidClosed`；設定列為「（蓋子已闔上）」，沒有錄影時若下一次錄影會用到它就加註提示，也會和「未連接」的退回提示一起顯示；HAL 不會通知，所以設定的監看程序每秒讀一次蓋子狀態。錄影中，麥克風連續 2 s 送出每個樣本都是零的緩衝（在音量與靜音之前判斷），就是既有的 `microphoneLost`，原因為「only digital silence (every sample zero)」。簽章 bundle 上設定顯示了標記與提示；內建麥克風的錄影在 2.09 s 時記錄中斷，存檔後顯示中斷通知；10 s 的 BenQ 錄影沒有中斷；蓋子監看隨監看程序執行並正常停止，沒有錯誤。
- **檢查與審查。**`pnpm check` 通過（2077 個 TypeScript 測試、140 個 Rust 測試、Clippy、fmt、建置與引擎載入）；最後一次只改提示條件，之後 `pnpm test:scope platform recording recording-settings` 連同 30 個 UI 案例通過。每個決定各做兩輪唯讀的 Codex GPT-6.1 Sol 審查（medium）：D1 的兩項發現已修正，第二輪沒有發現；D2 的三項發現（設定不跟隨蓋子、退回提示旁沒有蓋子提示、錄影中提示可能指錯輸入）都已修正，最後一項在最後一輪之後修正，因此沒有再審查。
- **收尾。**授權已重新開啟並以重開 bundle 確認；`settings.json` 依回合前的副本還原；RecordStuff 正常結束、沒有殘留程序；`caffeinate` 已停止。
- **未驗證，經維護者接受。**開蓋時以內建麥克風錄影（一般聲音不會被當成靜音）；藍牙輸入；實際開闔蓋子時設定是否跟著更新；授權正常時螢幕喚醒或拓樸變化會不會列不出來源，D1 現在除非請求期間螢幕有變化，否則會立即拒絕；Windows（依 076 的 D8）。

## Plan 077 結案 — 2026-10-22

Plan 077（原生錄影引擎與麥克風控制的親手驗收）於 2026-10-22 在 `pnpm start:app` 從 `c4dbc2c3` 建置的簽章 bundle 上執行（macOS 26.6.2，兩台 BenQ 螢幕，MacBook 闔上蓋子）。硬體與「系統設定」由維護者操作；Claude 讀取 log 與檔案，並在維護者中途要求下自行完成其餘操作：以 System Events 送快捷鍵、以 CoreGraphics 點擊受測 bundle 的設定，以及在 App 結束時寫入 `settings.json` 的設定。筆記、影格與截圖：[2026-10-22T2314-077-hands-on](../../verification/measurements/2026-10-22T2314-077-hands-on/notes.md)（僅本機）。

- **睡眠（步驟 1）。**兩段錄影都以 Apple 選單 → 睡眠停止。第一段 macOS 關螢幕後 361 ms 又打開，沒有真的睡眠；錄影仍以 `stoppedEarly: "sleep"` 停止並存檔。第二段在 `suspend` 後 304 ms host 停止、再 21 ms 存檔，早於約 5 s 後的睡眠；「已儲存…Mac 進入睡眠，已停止錄影」通知在睡眠期間暫緩、醒來後顯示。沒有留下 sentinel，兩段都沒遇到已知的 drain 風險（stream 在 drain 期間結束仍回報 `capture_failed`）。兩個檔案都可解碼，影音等長。
- **移除螢幕（步驟 2）。**「螢幕」設為 BenQ BL2480T，錄影 18 s 時拔掉它：記錄 `target_removed`，以 `capture_failed`（recording display removed）結束，保留 fragmented 的 5.3 MB 殘檔（可解碼），顯示「錄影中斷」。殘檔影像 16.6 s、音訊 18.0 s：畫面在 main 的監看發現移除前約 1.4 s 就停了，聲音繼續。保存的螢幕仍不在時兩次開始都以 `display_unavailable`（`target_missing`）拒絕，沒有留下任何東西；改選剩下的螢幕後下一段錄影正常存檔。螢幕已接回。
- **權限被拒（步驟 3）。**在「螢幕與系統錄音」關閉 RecordStuff 後，開始錄影以 `permission_denied` 失敗，沒有檔案或 sentinel，狀態變成 needsPermission，顯示「錄影失敗／需要螢幕錄製權限」；失敗前在 `starting` 停了 9.3 s，三次來源列舉各自等待（觀察）。設定中的權限卡沒有查看。重新開啟權限時，macOS 的重開打開了 /Applications 裡較舊的 RecordStuff（同一 bundle ID）：它把目前的紀錄讀成無效並拒絕覆寫，也沒改設定；已結束它並以 `pnpm open:app` 重開 bundle，下一段錄影正常存檔。舊版的錄影不算證據。
- **D6 與 Dock（步驟 4）。**關閉 Dock 自動隱藏後，「隱藏選單列與 Dock」關閉的錄影有 Dock 與選單列（`0 system window(s) hidden`），開啟的錄影兩者都沒有（`35 system window(s) hidden`），由 Claude 判讀各一張影格。
- **藍牙耳機（步驟 5）。**第一次 FreeClip 2 沒有連上 Mac，什麼也沒列出。從控制中心連上後，連線與收回充電盒都讓監看程序重新列出輸入（`devices: listing the inputs`），期間沒人碰視窗，視窗還在其他視窗後面；選單隨後列出 HUAWEI FreeClip 2，「搜尋裝置」立即再列出它，收回盒子後選單不再有它。macOS 列出其麥克風花了多久沒有量到：macOS 的藍牙 log 沒有連線時間。
- **錄影中切換（步驟 6）。**系統音訊設為 0%（寫入設定）、由 MacBook 喇叭播 `say`，一段 52.5 s、從 BenQ Monitor 麥克風開始的錄影顯示「會立即切換這次錄影的麥克風。」，並依序切到 MacBook Pro 麥克風（77 ms）、HUAWEI FreeClip 2（325 ms，16 kHz）再回到 BenQ Monitor（129 ms），每次都記錄 `microphone switched from … to …`；選「跟隨系統」而它指向正在錄的耳機時記錄為保留，之後的選擇仍會切換。存檔行與紀錄依序列出 `microphones`；影像與音訊都是 52.547 s，每個切換點的音量都隨之改變。內建麥克風那 13 s 是數位靜音，因為蓋子闔上：macOS 仍列出並允許開啟它，但只送出零，而且不會被判定為遺失（觀察，未變更）。
- **收尾。**每段錄影都已停止並存檔；RecordStuff 正常結束、沒有殘留程序；`settings.json` 依回合前的副本逐位元組還原；維護者已把 Dock 自動隱藏改回、耳機收回盒中；`pnpm acceptance:cleanup-audit` 通過；`caffeinate` 已停止。步驟 6 改過輸出音量，原值沒有記下。回合結束後依維護者同意，本回合的錄影（含殘檔）與 /Applications 裡較舊的 RecordStuff 已移到垃圾桶。
- **未驗證。**權限卡；macOS 列出藍牙麥克風的時間；內建麥克風在切換點兩側的人聲（蓋子闔上）；Windows（依 076 的 D8）。

## Plan 082 結案 — 2026-10-19

Plan 082（錄影工作室的第一次點擊與它的量測 runner）從 081 的結案而來，2026-10-19 在簽署的 bundle 上執行，不需要相機。維護者在第 1 步後決定 D1：維持 macOS 對不在前景的視窗第一次點擊的慣例，改修 runner；D2 依建議。

- **第一次點擊（第 1 步）。**`pnpm acceptance:studio`（新增；報告 `2026-10-19T13-54-59-134Z-studio-acceptance`），素材全螢幕在前景、錄影工作室在第二個螢幕：讀完輔助使用樹後立即按一次「即時預覽」沒有啟動任何東西（a），2 秒後按也沒有（b），先讓 RecordStuff 到前景再按則啟動了即時預覽（c）。(a) 與 (b) 在 App 的 log 中沒有任何紀錄：在 macOS 上點擊不在前景的視窗只會啟用它，除非 view 接受第一次滑鼠事件，Electron 以視窗為單位設定（`acceptFirstMouse`），所以其他 App 在前景時，錄影工作室的控制項要第二下才作用。D1 維持現狀，因為大多數 Mac 視窗都是如此，而且整個設定視窗都會接受第一下點擊，包括錄影卡片的「丟到垃圾桶」；`measure:cpu` 的 L 改為按下前先把 RecordStuff 帶到前景。
- **角色規則（D2）。**`cpu-sampler.mts` 的 `afterStudio` 在 `--studio` 執行中，於 R 之後允許一個 `utility:video_capture` 與一個 `utility:audio`，其他必要角色仍然必要（單元測試：兩者都在、任一不在、第二個音訊服務或 renderer 被拒、缺少 main 被拒）；檢查名稱會註明這項允許。
- **Hover。**`NativeAx.move` 只移動游標不點擊。即時預覽進行中、素材在前景時，把游標移到錄影工作室的預覽上，log 記下 `studio: preview at 10 a second`，移開後記下 `at 5`，runner 兩次執行都是如此：Chromium 在 macOS 上會把 `pointerenter` 送給不在前景的視窗，plan 081 只以單元測試檢查過這點。
- **閘門（第 3 步）。**`pnpm measure:cpu -- --minutes 1 --camera preview=0 --skip-settings --skip-playback --studio`（`2026-10-19-p082-measure`）：整份判 PASS，是第一份如此的 `--studio` 報告；L 第一次按下就啟動（log 沒有重試），角色檢查依 D2 通過，S 19.1% 對 R 11.1%（8.0 點，單次），L 15.4%。重新建置的 bundle 上的 `pnpm acceptance:studio`（`2026-10-19-p082-studio-acceptance`）：PASS，與第 1 步相同。
- **檢查。**typecheck；每次修改後 `pnpm test:scope -- tooling`（54 個單元測試檔）；錄影工作室的 3 秒移到 `studio-port.ts` 供 runner 共用後，`src/renderer/settings/tabs` 與 `src/shared` 的 13 個檔案、89 個測試。
- **Review。**Codex GPT-6.1 Sol 的兩次唯讀 review 在新 runner 的失敗路徑找到五個問題，都在原生回合之後修正，並在 bundle 上再跑一次 `pnpm acceptance:studio` 確認（`2026-10-19-p082-studio-acceptance-after-review`：PASS，結果相同，清理完成）：中斷時清理會用已失效的 signal 按「停止預覽」（現在由結束 App 釋放預覽）；素材清理時 `pgrep` 失敗會跳過結束 App 與報告；素材沒有開啟或沒有到前景時，RecordStuff 在前景也可能通過（現在判 blocked）；缺少第二個螢幕或 bundle 時以 1 而非 2 結束；中斷時素材仍在啟動，可能留下 Chrome（現在會等啟動結束，和 `measure:cpu` 相同）。
- **清理。**每個 runner 都正常結束 App、確認已退出並關閉素材；`measure:cpu` 還原了它預設的設定，`acceptance:studio` 沒有改任何設定。閘門量測的兩段錄影已移到垃圾桶。

## Plan 081 結案 — 2026-10-19

Plan 081（錄影工作室顯示錄影時頁面本身的成本）於 2026-10-19 歸因錄影工作室的額外成本，並把 30 fps 時的成本降到 D18 的 8 點之內。維護者在歸因後決定 D1：有人在錄影工作室操作時每秒顯示 10 格，只是看著時 5 格，並把音量移到預覽的 port；D2 改為沒有人操作時的這個閘門，以及有人操作時預覽的頻率與延遲不變。歸因與第一次閘門量測中相機都沒有送出影格（參考機的上蓋闔著，也沒有接其他相機）；之後以經 Continuity Camera 出畫面的 iPhone 重新量測閘門，兩種幀率都通過。

- **歸因（第 1 步）。**報告 `2026-10-19-p081-1-profile` 到 `-7-video-nometers`，每次都是 `pnpm measure:cpu -- --minutes 1 --camera preview=0 --skip-settings --skip-playback --studio`，第一次加 `--profile`，並以暫時的開關（`RECORDSTUFF_STUDIO_PROBE`，已移除）隱藏預覽、音量表或兩者。30 fps 時 S 比 R 多：兩者都顯示 10.8 點（renderer 5.7、GPU 程序 3.4、擷取程序 1.3、VTEncoder 0.3、main 0.4），隱藏預覽 8.8 點，隱藏音量表 11.3 點，兩者都隱藏 2.4 點。Chromium 合成的每一格，不論由誰觸發，都讓 renderer 與 GPU 程序多花約每秒每格半點，而預覽與音量表共用時脈時不比其中一個貴；預覽另外加上軟體解碼（約 1.8 點，`sample` 中 renderer 的 `Media` 執行緒）與編碼（約 1 點）；main 為 0.4 點，幾乎都是轉送音量，080 的 2.2 點沒有再出現。App 外的基準測試（Electron 44，640×360 的 H.264 每秒 10 格以軟體解碼，30 秒三次；`2026-10-19-plan-081-bench`）：只有視窗 0.14%、解碼不顯示 2.36、canvas 8.36、`bitmaprenderer` 9.28、以 `MediaStreamTrackGenerator` 餵 `<video>` 5.71；在 App 裡，`<video>` 在音量表旁比 canvas 多 2.2 點，沒有音量表時少 0.8 點，因此沒有保留（`plan-081-video-preview.patch` 在第 6 份報告旁）。
- **實作內容。**頁面要求每秒 5 格時，引擎的預覽執行緒每兩個 tick 產生一格（`PREVIEW_RESTING_FPS`、`preview_tick_shows`、`NativeCapture.setPreviewRate`，macOS 與 Windows 皆然）；頁面依游標是否在視窗上、或 3 秒內是否有輸入決定（`studio-pace.ts`），並在錄影工作室的 port 上告知，這個 port 現在也傳音量：main 的 `CameraPreviewLink` 改為 `StudioLink`，在頁面觀看預覽或音量表時接上頁面，`LevelsLink`、擷取程序送給 main 的 `levels` 訊息與頁面的 `onLevels` IPC 都已移除。音量表依經過時間下降並畫到整數像素；經過時間每秒更新一次。`measure:cpu` 新增 `--profile`。
- **閘門（第 3 步）。**`pnpm measure:cpu -- --minutes 1 --repeat 3 --camera preview=0 --skip-settings --skip-playback --studio --fps 60`（`2026-10-19-p081-final-repeat3`）：30 fps 時 R 10.7%（11.0、10.0、10.7），S 18.3%（18.5、18.3、17.8），比 R 多 7.6 點，通過；L 13.8%。60 fps 時 R 13.5%、S 23.1%，多 9.6 點，僅回報：頁面的 renderer（約 4.0）與 GPU 程序（2.6）與 30 fps 時相同，而同一天不同次啟動、只錄 60 fps 時擷取程序就在 13.3% 到 16.0% 之間。先前的單次量測（`2026-10-19-p081-final`）為 8.7 與 6.2 點。App 的 log 在每段 S 開始時記下 `studio: preview at 5 a second`（游標在選單列圖示上），每段 L 開始時記下 `at 10`（按下即時預覽後游標停在錄影工作室上）。
- **有相機出畫面時的閘門。**同一個 runner，以 iPhone 經 Continuity Camera（每分鐘 1,430 到 1,820 格，沒有掉格，也沒有遺失）。`2026-10-19-p081-camera30-repeat3`，只量 30 fps：R 11.6%（11.4、11.6、11.6），S 18.9%（18.9、18.9、19.0），比 R 多 7.4 點，通過；L 15.7%。`2026-10-19-p081-camera-repeat3`，`--fps 60`：60 fps 時 R 16.1%、S 23.8%，7.7 點，通過；L 17.3%。這份報告的 30 fps 那組，在第一段錄影 40 秒時游標停到了錄影工作室上（截圖可見側邊欄的 tooltip；runner 在那段時間不會移動游標），所以 log 記下 `preview at 10 a second`，S 以完整頻率執行：21.6%，比 R 的 11.7% 多 9.9 點，記為有人操作時的成本，而不是閘門。截圖顯示兩種頻率下預覽中都合成了相機的 bubble。
- **原生觀察。**單次量測期間每 30 秒截一次第二個螢幕上的錄影工作室，由 Claude 判讀：S 期間預覽顯示移動的素材、音量表顯示音量，並有「錄影中 0:46」與「停止錄影」；L 期間預覽持續更新，並有「預覽中」「停止預覽」與「開始錄影」。程序角色檢查和以前一樣失敗（錄影工作室之後留下 `utility:video_capture` 與 `utility:audio`），與 080 的量測相同。
- **檢查。**134 個引擎測試、Clippy 與 rustfmt；第一次完整執行時 1,990 個 Vitest 測試，之後 `pnpm test:scope -- recording-settings settings-bridge recording`：typecheck、39 個單元測試檔（826 個測試）、build 與 34 個背景 UI 案例，錄影工作室的音量表改由 port 提供；簽署 bundle 的引擎載入時方法清單包含 `setPreviewRate`。
- **Review。**Codex GPT-6.1 Sol 的一次唯讀 review 找到一個問題，於量測後修正：使用 `--profile` 時，若在取樣前的等待期間中斷，會留下一個尚無人 await 的 rejected promise，讓 Node 在 runner 清理完成前結束；現在在產生處就處理等待的 rejection，以重現腳本（修正前 exit 1、清理未完成；修正後清理完成）與 tooling scope 的 54 個單元測試檔驗證。
- **清理。**每個 runner 都正常結束 App 並確認已退出，還原預設的設定並關閉素材。各輪的 48 段錄影留在輸出資料夾。

## Plan 080 結案 — 2026-10-19

Plan 080（macOS 上以共用 GPU 貼圖顯示錄影工作室的預覽）於 2026-10-19 依維護者採納建議的決定執行第 2 步原型：D1，獨立的 Rust napi-rs 模組（`native/preview-receiver`）；D2，只有 30 fps 時錄影工作室的額外成本至少降 2 點、且 main 事件迴圈延遲的 p99 不比現在多超過 2 ms 才保留；D3，只有保留時才修訂 076 的 D2。閘門未通過；依維護者要求，計畫結案，保留編碼後的預覽，076 的 D2 不變，原型從程式碼中移除。量測顯示錄影工作室的額外成本大多來自頁面本身，這部分移到 [081](#plan-081-結案--2026-10-19)。

- **做了什麼。**在開發開關（`RECORDSTUFF_SHARED_PREVIEW=surface|encoded`）之後：main 以接收模組向 launchd check in 一個名稱（`bootstrap_check_in`，含 bundle id、程序 id 與隨機部分），模組只在第一次觀看預覽時載入；擷取程序把每張 640 像素 NV12 預覽畫面的 IOSurface 以 Mach send right 送出，再送該格的 JavaScript 訊息，並持有到 main 釋放為止（同時一格，最多 1 秒）；main 以零逾時與 audit trailer 接收，丟棄不是該 session 擷取程序送來的訊息，以 `sharedTexture.importSharedTexture` 匯入、`sendSharedTexture` 送到錄影工作室，沙箱化的 preload 再把 `VideoFrame` 交給頁面的 canvas；任何失敗都讓該 session 的預覽退回編碼串流。檢查：管道的 6 個 Rust 測試（沒有訊息時立即返回、其他程序的訊息被丟棄且 surface 被釋放、佇列滿時立即失敗且不留下 right）、133 個引擎測試、2,001 個 Vitest 測試、模組已簽署並通過驗證的簽署 bundle。Codex GPT-6.1 Sol 一輪唯讀 review 找出四個問題，皆在量測前修正：接收模組的測試相依在 Windows 上無法建置、傳送失敗不會退回、每次觀看都重新編號而 main 以 id 持有 surface、逾時的傳送會漏掉 kernel 退回的 right。原型以本機 patch 保存在 surface 報告旁（`plan-080-prototype.patch`，連同下述 benchmark），不進 repository。
- **簽署 bundle 上。**以動態名稱 `bootstrap_check_in` 成功，擷取程序也找得到；錄影工作室畫出共用影格並持續更新，素材顏色正確（BT.709 video range 的 NV12）；沒有被跳過、送不到或持有超過 1 秒的影格，也沒有被拒絕的訊息。
- **CPU（D2 閘門：未通過）。**`pnpm measure:cpu -- --camera preview=0 --skip-settings --skip-playback --studio --fps 60 --minutes 2`，分別加 `--shared-preview encoded` 與 `surface` 各跑一次（報告 `2026-10-19T03-39-22-185Z-cpu` 與 `2026-10-19T03-28-06-172Z-cpu`），各錄一次。兩次相機都沒有送出影格（`0 frame(s) delivered`），因此 R 在編碼路徑那次是 10.7%／15.9%，共用貼圖那次是 10.3%／15.9%，不是 075 的 15.5%／19.4%；兩次條件相同，每個 S 都和同一次的 R 比較。30 fps 的 S 在編碼路徑是 24.4%，共用貼圖是 24.3%，比 R 多 13.6 與 13.9 點：沒有省到。60 fps 是 10.0 與 11.0 點；L 在編碼路徑 16.5%／16.1%，共用貼圖 17.8%／17.7%。main 的事件迴圈延遲（10 ms 解析度，各 26 個 10 秒區間）沒有變差：p99 中位數編碼路徑 17.4 ms、共用貼圖 16.4 ms。兩份報告都因 D18 的 8 點顯示 FAIL，該超出已由 D21 接受；兩次的 L 都要按第二次「即時預覽」，是 runner 的時序問題，與路徑無關。
- **原因。**30 fps 時，共用貼圖讓擷取程序省 1.1 點（不用預覽編碼器）、VTEncoder 省 0.9、renderer 省 2.1（不用解碼），但 main 多 1.5、Chromium 的 GPU 程序多 1.6。App 外的 benchmark（Electron 44，每秒 10 張 640×368 NV12 IOSurface，同時一張，透明的視窗）拆開了成本：只匯入是 main 0.6、GPU 程序 0.7 點；匯入加傳送、不繪製比閒置多 3.3 點；繪製影格時 GPU 程序 5.9–6.9 點，不論用 2D canvas 的 `drawImage`、WebGL、WebGPU 的 `importExternalTexture` 或 `bitmaprenderer`；收到影格但不繪製是 1.0 點，影格照樣送達但不畫、改由 CPU 像素重畫 canvas（`putImageData`）是 4.5 點：單是重畫約 3.5 點，畫共用影格再多 1.5–2.5 點；subtle API 沒有比較省；每個池中 surface 只匯入一次、之後重複傳送，約省 1 點（main 2.0 降到 1.1，GPU 程序約 0.6），還不到閘門，而且還沒確認 Chromium 看得到合成器寫進已匯入 surface 的內容。30 fps 時錄影工作室的 13.6 點大多是頁面本身：canvas 每秒重畫 10 次，以及 main 比沒有錄影工作室的錄影多 2.2 點（2.36% 對 0.13%），雖然編碼後的影格根本不經過 main。
- **清理。**每個 runner 都正常結束 App 並確認退出、還原種入的設定並關閉素材；原型程式碼已還原。兩次量測的八段錄影留在輸出資料夾。

## Plan 079 結案 — 2026-10-19

Plan 079（麥克風控制）於 2026-10-19 依維護者採納建議的 D1–D3 實作：設定中的「輸入音量」、跟著連接變化並有「搜尋裝置」的裝置清單，以及錄影中切換麥克風（[錄影](../system-design/recording.md#音訊)、[桌面](../system-design/desktop.md)）。這裡記錄簽署 bundle 上的回合與計畫結案：維護者同日要求，下列兩項需要動手的案例移到 [077](#plan-077-結案--2026-10-22)，由它集中所有需要動手的案例，079 隨之結案。

- **自動化。**`pnpm acceptance:regression`：check（1,985 個 Vitest 測試、133 個原生測試、建置）與 168 個背景案例，其中包括 S139–S141（輸入音量、搜尋裝置、錄影中的選擇器）。引擎以 `cargo check` 編譯 `x86_64-pc-windows-msvc`；未觸發 CI。Codex GPT-6.1 Sol 兩輪唯讀 review 找出五個問題，皆已修正：一次只送一個切換，回覆不會被當成之後的選擇；倒數中的回覆也會接受；錄影中仍跟著裝置清單；切換到正在錄的裝置時回報為保留；開始監看時先送一次清單。
- **桌面回合（依維護者要求無人值守）。**維護者回覆「好了」後要求 agent 代為進行；設定由 Codex GPT-6 Astra 的 computer use 操作，聲音由喇叭播放、經 BenQ 螢幕的麥克風收音。證據為 Computer Use 觀察、App log 與 agent 的截圖。
  - **輸入音量（D1）：通過。**開啟麥克風後 log 記下 `microphone monitor: reading BenQ Monitor`；音量條的綠色長度安靜時 0 px，播放系統 Submarine 音效時 101 與 134 px，停止 4 秒後 0 px。
  - **清單跟著連接變化（D2）：以替代方式通過。**沒有人能插耳機，因此建立並移除一個以螢幕麥克風組成的公開 aggregate 輸入裝置（`AudioHardwareCreateAggregateDevice`，儲存庫外的一次性工具）。每次變化約 1 秒後就重新列出（`devices: listing the inputs`），不需啟用視窗，「輸入裝置」選單隨後列出「RecordStuff Test Input」。第一次誤把螢幕的輸出裝置組進 aggregate，它沒有輸入，正確地沒被列出。
  - **開著麥克風的錄影 smoke：通過。**`pnpm acceptance -- --seconds 12`（報告 `2026-10-19T01-17-24-349Z-hotkey-acceptance`）：12.4 秒、60 fps，音訊與影像等長，兩聲道約 −42 dB，可解碼；`mic on (BenQ Monitor)`；倒數取消案例通過。
  - **CPU：通過。**開著麥克風執行 `pnpm measure:cpu -- --skip-recording --skip-playback`（報告 `2026-10-19T01-23-02-288Z-cpu`）：A 0.044%；C（設定開在 Finder 後面）0.229%，上限 0.5%，角色包括監看程序（`utility:node ×1`）。視窗有焦點、音量表讀取中時，以 `ps` 量 60 秒：監看程序 1.4%、main 1.05%、設定 renderer 1.05%、GPU 程序 0.25%（粗略，非 runner）。
  - **移到 077（此處未驗證）。**藍牙耳機的連接與斷開（需要人手）；錄影中的實際切換：Astra 無法操作選單列（`Computer Use was not approved to use SystemUIServer`），之後連續三次存取 RecordStuff 逾時（`-10005`；每次都啟動了第二個實例，因 userData 鎖而結束），因此切換只靠引擎的 core 測試、Recorder 測試與 S141。Windows 未在實機上測試。
- **清理。**aggregate 裝置已移除，App 正常結束且程序都已退出，`microphone` 還原為關閉、未選裝置，與回合前相同。錄影檔 `2026-10-19 09-17-31.mp4` 留在輸出資料夾。

## Plan 075 結案 — 2026-10-18

Plan 075 把使用者的相機放進錄影。2026-10-17 依維護者要求改採 OBS 的做法重新設計：由引擎在編碼前於 GPU 上把相機合成進畫面，而不是錄下一個浮動視窗；新的「錄影工作室」分頁在即時預覽上安排相機，錄影前與錄影中都可以。設計見[錄影](../system-design/recording.md#相機)、[桌面](../system-design/desktop.md#錄影工作室)與[相機權限](../system-design/desktop.md#相機權限)，決策見[設計決策](../system-design/decisions.md)，CPU 預算見[工具](../system-design/tooling.md#cpu-預算)。

- **行為（步驟 1，D1–D21）。** 寬、高（較短邊的 5–60%）與圓角可自由調整的泡泡，依螢幕記住位置，只有選擇時才鏡像；預設關閉，開啟時詢問權限；開始時無法使用即以 `camera_unavailable` 拒絕；錄影中變更從下一格生效；可從 tray 或工作室隱藏與顯示；2 秒沒有畫面即判定中斷，錄影不含相機繼續。依維護者選擇而改變最初建議的有：即時預覽按鈕（D5）、以小型 H.264 串流傳送預覽（D17）、錄影工作室（D19）、即時預覽與錄影共用同一個 session（D20），以及各輸入的音量推桿與 10 fps 的預覽（D21）。
- **原型門檻（步驟 2）。** 以 Core Image 合成在 30 fps 約佔一個核心的 10 個百分點；Metal compute 在 30 fps 約 4、60 fps 約 7。預覽最初的形式（以 WebGL 繪製 NV12 畫面）佔 12.7 個百分點；改用 640 像素、以 WebCodecs 解碼的 H.264 串流後通過，預覽的份額由維護者接受。
- **引擎（步驟 5–6）。** macOS 使用 AVFoundation，「跟隨系統」選擇 macOS 偏好的相機並略過暫停中的相機；Windows 使用 Media Foundation 的 source reader。同一個 WGSL kernel 由 naga 轉成 Metal 與 HLSL；Windows 上以 Direct3D 11 compute 寫入各平面的貼圖，再繪製到 NV12 render target，並有 WARP 路徑。沒有相機或隱藏時，畫面與螢幕逐位元相同。每次停止時記錄相機畫面在所在影格中的落後時間。
- **工作室（步驟 7）。** 上方是預覽，下方是相機、音訊（音量表、靜音、推桿）與錄影控制；側邊欄可收合成圖示列。回合中發現並修正：「跟隨系統」在引擎與設定中開到不同的相機（兩者現在都詢問 `systemPreferredCamera` 並略過暫停中的相機），以及使用者允許後，執行中的 App 仍顯示未允許取用相機（卡片現在提供「已經允許了？重新啟動 RecordStuff」，麥克風的卡片也是）。
- **量測（步驟 8）。** 見下方驗證。

### 驗證

2026-10-17 至 2026-10-18 的桌面回合，在參考機 MacBook Pro M1 Pro（macOS 26，Darwin 25.6）上進行，使用 `pnpm start:app` 產生的簽章 bundle、60 Hz 1920×1080 主螢幕、iPhone 的接續互通相機與 FaceTime HD 相機。Claude 執行 runner 與分析並操作 App；維護者重設相機權限、回應詢問、在系統設定中允許，並操作 iPhone。

- **開啟相機錄影。** 每個回合讀回的影格中，泡泡都位於 log 記錄的版面；錄影中寬度、比例、鏡像與位置的變更在 4 ms 內落在 log 記錄之處；6.7 秒隱藏、10.8 秒顯示，依序得到泡泡、只有螢幕、再次出現的泡泡；開在被錄螢幕上的工作室不在影格中。開啟相機的 60 fps：20.77 秒 1,247 格，沒有超過 17.5 ms 的間隔。相機畫面平均比所在影格舊 113.9 ms（1,005 格中 87.7–138.7 ms，接續互通相機；Windows 以抵達時間標記，因此不含相機本身的延遲）。
- **不開相機的時序。** `pnpm matrix -- fps`：30.03 fps、無掉格、閃光對嗶聲 −23 ms；59.35 fps、掉格 1.22%（最長間隔 33 ms）、−7 ms；兩者皆通過。
- **CPU**（`pnpm measure:cpu -- --camera preview=0 --skip-settings --skip-playback --studio --fps 60 --minutes 2`）。待命 0.042%；開啟相機錄影在 30／60 fps 佔一個核心的 15.5%／19.4%；工作室顯示時 24.5%／30.7%；即時預覽 16.9%。所有絕對預算都通過；工作室的份額為 8.9 與 11.3 個百分點，超過 D18 的 8，由 D21 接受。工作室關閉後 Chromium 的 video capture 與 audio 服務仍在，但量不到 CPU 使用；維持現狀。
- **音訊。** 系統聲音推桿拉到底後即無聲，音量表在 4.5 秒內降到無聲；麥克風推桿使麥克風無聲（檔案峰值 −23 dB，接著只剩麥克風的 −31 與 −41 dB，16 秒起無聲）。靜音、音量表與推桿都在 3 ms 內由設定與引擎記錄。
- **即時預覽。** 783 ms 準備好一個 session；「開始」接手它進入倒數，相機只開啟一次（912 格，無掉格），檔名以按下開始的時間命名；切換分頁離開的預覽被取消，暫存檔刪除，沒有記錄失敗。
- **權限**（執行 `tccutil reset Camera com.ericts.record` 後）。從 tray 的「錄製相機」跳出附使用說明的詢問；按「不允許」後顯示卡片，「開啟相機設定…」打開「隱私權與安全性 → 相機」（RecordStuff 為關閉），工作室預覽要求允許，開始錄影在倒數前以 `camera_unavailable` 拒絕並發出通知。允許後，執行中的 App 在重新啟動前仍顯示未允許，由上述修正處理（單元與 UI 測試；重新啟動按鈕本身未在簽章 bundle 上按過）。
- **中斷。** 從 tray 取消倒數，相機指示在 2.5 秒內消失。錄影中在 iPhone 上按「中斷連線」，2 秒後判定中斷，錄影繼續，存檔時標記相機中斷，結束時才通知；引擎嘗試開啟同一台相機 9 次，因 iPhone 維持中斷而沒有接回，維護者判斷使用者自己中斷連線時這是正確的。拿起或解鎖 iPhone 不會暫停，其「暫停」送出黑畫面，因此兩者都不算中斷。
- **自動化。** `pnpm check`（159 個檔案、1963 項測試；`cargo test --lib` 129）、`pnpm test:scope -- recording-settings`（29 個背景 UI 案例）、`pnpm acceptance:tray`（15 項通過，`stale-start` 未執行：macOS 先送出選單的開始）、依 pull request job 的步驟在本機執行網站檢查（24 項測試、`astro check`、離線建置與連結）。工作分支上的 `check.yml`：run 39062657993（`windows-2025` 上 Windows 合成器的六個 WARP 像素測試與預覽串流測試），以及結案 commit 的 run 39107006058，十二個 job 全部通過（macOS 與 Windows 的 check、八個 UI 分片、原生引擎與 Windows 安裝程式）。前一次 run 39106467749 在 macOS 上有一個依實際時間判斷的測試失敗（`with_every_slot_the_first_slots_are_encoded_on_time_not_in_a_burst`）：影格都落在各自的格子上，但測試從它的執行緒看到第一格時才開始計時，在忙碌的 runner 上看得較晚；現在改從第一格本身的時間開始計算。之後 pull request #19 的檢查在忙碌的 macOS runner 上又有三個依實際時間判斷的測試失敗（靜止畫面的重新編碼相隔 1.2046 秒，超過 1.2 秒的上限；相機的節奏以固定的睡眠時間計數；078 的 host time 測試在兩次讀取時鐘之間被搶走 39 ms）；三者現在都依量到的時間判斷（觀察的時間、影格本身的間隔、等待期間取樣的延遲、在兩次讀取之間讀取），整組測試在參考機上與十二個忙碌迴圈並行時連續通過三次。合併的 commit 上，run 39109109091 的所有 job 都通過，網站的 pull request 檢查（run 39109109090）也在 GitHub 上通過。
- **審查。** Codex GPT-6.1 Sol，唯讀，逐項審查：包括 Windows 相機的 stride、沒有畫面的來源重新開啟與其競態（已修正）、錄影前預覽卡住（記錄為已知限制）、在 refresh 執行緒 join 前讀取相機落後時間（已修正），以及 Windows 以抵達時間標記（已記錄）。

未完成：Windows 上的實體相機（只有 CI）；裝置清單在沒有 run loop 時是否跟著相機變化（手邊沒有 USB 相機；中斷連線後 iPhone 仍在清單中）；錄影中相機在實機上接回（只有核心測試）；在簽章 bundle 上按下重新啟動按鈕。已知限制：即時預覽中卡住的相機，要到開始錄影才會判定中斷。macOS 上規劃的零複製預覽是 [080](#plan-080-結案--2026-10-19)，量測後沒有保留。

## Plan 078 結案 — 2026-10-17

076 與 074 留下了原生擷取引擎的幾個問題：相隔 50 ms 的影格、開發版 App 錄到自己的視窗、沒有逐影格的診斷、Chromium 路徑留下的決定、Windows UI shard 關閉 App 時逾時，以及 macOS 麥克風重新連上後從未被收回。Plan 078 把它們結案。設計見[錄影](../system-design/recording.md)、[音質第 19 節](../system-design/audio-quality.md#19-coreaudio-hal-上的麥克風結果2026-10-17)、[工具](../system-design/tooling.md)與[桌面](../system-design/desktop.md)。

- **步驟 1，影格間隔。**逐影格 log 顯示 ScreenCaptureKit 在 60 Hz 下每 15 秒約跳過五次更新，既不送畫面也不送 idle 影格；被跳過的若是某個格位的更新，檔案中就會先有一個 50 ms 的間隔，再有一個 17 ms 的間隔。最初猜測是格位邊界上的抖動，試過之後依 log 的證據還原。引擎現在在被跳過的格位編碼最新畫面（`Pacer::skipped`、`fill_skipped`，並有一個少了它就會失敗的測試）。在簽署 bundle 上執行 `pnpm matrix -- quick`：同一個 build 不補時，接連量到 30 fps 影格有 0.44–0.66% 相隔 50 ms；補上後三個案例都是 0.00%，最長間隔 33 ms，30.05–30.12 fps，閃光到嗶聲 −6、−6 與 −22 ms，錄影 CPU 約 10%。
- **步驟 2，自身視窗。**ScreenCaptureKit 只在 App 擁有視窗時才列出它，而什麼都沒開的選單列 App 沒有任何視窗；先前每一段簽署 bundle 的錄影都有倒數 overlay。main 現在在準備擷取之前建立一個隱藏的 1 像素 `BaseWindow`。之後兩種 build 在 matrix 的三次錄影中都記下 `1 own app(s) excluded`，沒有倒數；找不到時的警告若再出現，會附上原因的證據。
- **步驟 3，診斷（維護者的決定，2026-10-17：開發用開關）。**`RECORDSTUFF_FRAME_LOG=<資料夾>` 會為每段錄影在該資料夾寫入 `<file>.frames.jsonl`，記錄每次送達與每個編碼的影格以及 pacer 的決定，`pnpm diagnose:frames` 加以彙整；沒有設定或 UI。
- **步驟 4，Chromium 路徑留下的部分。**Windows 能用時以 GPU 的硬體 H.264 transform 編碼（依 LUID 選 adapter，絕不用 WARP 或 AMD，每個 adapter、驅動程式與尺寸快取一次灰色自我測試，watchdog，第一個樣本之前默默退回軟體編碼，`RECORDSTUFF_SOFTWARE_ENCODER=1` 強制軟體編碼）。沒有 Media Foundation 的 Windows 是 `media_components_missing`，在啟動時檢查（「開始錄影」不可用，托盤與設定提供「開啟選用功能」；模組無法載入時結束代碼為 4）。`mp4_unsupported` 已移除。歷史無法讀取時，設定提供「重設失敗紀錄」，並把原檔保留為備份。幀率降級與解析度上限無法確認的提醒已移除，大小估計在 60 fps 時也不再加倍。
- **步驟 5，Windows 的關閉。**fixture 關閉的每個階段都計時寫入 `test-results/ui-close-timings.jsonl`，並由 CI 的「Slowest closes」步驟彙整。在 Windows 上，main 在關閉開始後 70–100 ms 就已結束，而 Playwright 自己的關閉要等 helper 程序，最長等了 7.7 s。正常關閉現在以 main 的結束為準，與 Playwright 的關閉競速，Windows 上 helper 的等待為 15 s。Run 38953840602：兩個平台都沒有任何關閉被砍掉，Windows 最慢 3.5 s（每個 shard 的中位數 215–394 ms）。
- **步驟 6，麥克風（維護者的決定，2026-10-17：只收回同一個裝置）。**macOS 改以 AUHAL 單元（CoreAudio 的 HAL）擷取，取代 `AVCaptureSession`；即時執行緒上的緩衝區來自預先配置的 pool，以 AudioConverter 轉成 48 kHz。桌面回合發現，離開的裝置不會讓它的單元停止：HAL 會把單元移到另一個輸入，繼續送出聲音（iPhone 麥克風與 FreeClip 2 耳機之後接著錄到的都是另一支麥克風收到的房間聲音，因取樣率錯誤丟了 290 萬個 frame），所以從未回報中斷。讀取執行緒現在每 250 ms 檢查單元是否仍在錄它的裝置，不是就立即關閉，等 HAL 列出同一個 UID 時重新開啟，退避從 2 秒到 30 秒。Windows 在 `AUDCLNT_E_DEVICE_INVALIDATED` 之後重新開啟同一個 endpoint ID（只經過 CI 編譯）。維護者也在 2026-10-17 決定，錄影中中斷的麥克風絕不會被另一支取代。
- **攝影機，供 075 參考。**`probe_cameras_coming_and_going`（不用 run loop，每秒讀一次 CoreMediaIO 與 AVFoundation 的清單）在兩份清單中都看到 iPhone 的接續互通相機，但在它從 iPhone 端斷線並再次選取的 180 秒內都沒有看到任何變化，因此清單能否在沒有 run loop 的情況下追蹤攝影機仍未確定；075 的步驟 2 會用 USB 攝影機再做一次。
- **新計畫。**這個回合帶出維護者想之後再做的麥克風控制：設定中的輸入音量表、「搜尋裝置」按鈕、跟著連接變化的裝置清單，以及使用者能否在錄影中切換麥克風（[079](#plan-079-結案--2026-10-19)）。

### 驗證

2026-10-16 與 2026-10-17 在參考用 MacBook Pro（macOS 26，Darwin 25.6）上進行桌面回合，使用 `pnpm start:app` 的簽署 bundle 與 60 Hz 1920×1080 螢幕。Claude 執行 runner 與分析；維護者按快捷鍵、操作裝置並回應麥克風提示。

- **錄影。**`pnpm matrix -- quick` 與 `pnpm acceptance` 在步驟 1 與 2 的最終引擎上通過（見上文）。`pnpm measure:cpu -- --minutes 1 --skip-settings --skip-playback`：麥克風關閉時佔一個核心的 10.1%，開啟時 10.0%（074 在 AVFoundation 上為 9.9% 與 13.3%）。第一次開啟麥克風的量測停在 `starting`，等待 macOS 對重新建置的 bundle 跳出的提示，直到 runner 在 60 秒後取消（回報為清理未完成）；維護者允許之後重跑通過。
- **麥克風保真度、同步與重新連接。**在 HAL 上三次靜音量測：通過、一段安靜間隔差 1.4 dB、通過；增益在 0.007 dB 內，時鐘在 0.83 ppm 內，殘餘與聲道分離比 074 好 5–7 dB；輸出可聽見或有說話聲的四次錄音不列入，另有一次較早的靜音錄音只在右聲道未通過（[第 19 節](../system-design/audio-quality.md#19-coreaudio-hal-上的麥克風結果2026-10-17)）。按鍵同步：聲音比畫面早 10–74 ms，中位數 −44 ms。在最終引擎上把 FreeClip 2 放回充電盒再取出：立即關閉、2 秒後判定中斷、以 16 kHz 重新開啟、20.8 秒後恢復收音，中間是靜音，影像與音訊都是 44.785 秒。收回 iPhone 麥克風未能驗證（從 iPhone 端斷線後，macOS 就一直無法使用它）。
- **自動化。**`pnpm check`（155 個檔案、1861 個測試，`cargo test --lib` 89 個）、`pnpm acceptance:regression`（check 與 159 個背景 UI 案例）、`pnpm test:ui:drills`（13 個）與 failures scope；最後幾次引擎修改之後執行 `cargo test --lib`（89 個）、沒有新警告的 clippy，以及 Windows target 的 `cargo check`。工作分支上的 `check.yml` 在 run 38949603111、38950688234、38953840602 與 39009719723 通過，最後一個建置了 Windows 麥克風的修改。`runner-interrupt.test.ts` 在負載下的完整本機執行中失敗兩次，單獨執行與之後的完整執行都通過。
- **審查。**Codex GPT-6.1 Sol，唯讀，三輪。第 1 輪：LUID 以 UINT64 傳遞（不採納：Chromium 設定的是 8 bytes 的 blob，文件記載的型別是 LUID）、watchdog 沒有涵蓋等待輸入的影格、串流改變後沒有重試、第一個輸出之前被拒的影格遺失、關閉時的循環，以及 HAL 即時執行緒上的記憶體配置；後五項已修正。第 2 輪確認這些修正，並發現 resampler 錯誤時會漏掉一個 pool 緩衝區，已修正。結案後依維護者要求做了第三輪，審查在前兩輪之後才加入的步驟 6 裝置檢查與 Windows 重新開啟：沒有 findings。
- **證據。**原始檔在 `docs/verification/measurements/`（僅本機）：`2026-10-17-078-microphone/`（保真度報告、同步頁面與分析、攝影機探測 log、CPU log）、當天的 matrix 與 CPU 報告目錄，以及步驟 1 的逐影格 log。

未完成：真實的 Windows GPU 與硬體編碼器產生的畫面；拔除並收回 Windows 麥克風；收回 iPhone 麥克風；攝影機離開時能否在沒有 run loop 的情況下察覺（075 的步驟 2）；人耳聆聽。

## Plan 074 結案 — 2026-10-16

錄影原本只有系統音訊，錄有旁白的螢幕錄影得另開一個 App。Plan 074 透過 076 的引擎加入麥克風，預設關閉，與系統音訊混進同一條 AAC 音軌。設計見[錄影](../system-design/recording.md)、[音質](../system-design/audio-quality.md)、[錄影為何離開 Chromium 的 WebRTC 擷取](../system-design/webrtc.md)與[桌面](../system-design/desktop.md)。

- **決定（2026-10-16，維護者）。** 「錄影設定」分頁新增「音訊」區塊與「麥克風」開關，托盤 idle 選單另有「錄製麥克風」勾選項；「輸入裝置」選擇器（跟隨系統或列出的輸入裝置）；開關開啟時，權限被拒或輸入裝置無法開啟，會在倒數之前拒絕開始（`microphone_unavailable`）；錄影中失去麥克風時繼續錄影，只留系統音訊；原始麥克風以單位增益與未處理的系統音訊混音，不使用平台的語音處理，喇叭回音的建議是戴耳機。
- **與計畫文字不同之處。** `microphone_unavailable` 不歸入螢幕權限失敗，因為那裡的「開啟系統設定」會開到螢幕錄製的設定頁；macOS 的拒絕改由「麥克風」卡片與拒絕通知提供自己的動作。選定的裝置未連接時，依選擇器的替代方案改用系統預設並在 prepared 警告中註明，而不是拒絕。托盤項目在 idle 以外不顯示，而不是停用。`pnpm autorecord` 新增 `microphone`（預設關閉）。實際開啟的裝置名稱寫在 capture 紀錄（`CaptureReport.microphone`），沒有寫進 capture log 那一行，因為 `pnpm verify` 會讀那一行的格式。
- **引擎。** 錄影中麥克風 2 s 沒有送來聲音時，回報一次遺失；之後送來的聲音會丟棄，不再混回去；麥克風的轉換錯誤（macOS）或 pump 錯誤（Windows）只會失去麥克風，不會讓整個 session 失敗。Windows 在選定的端點不存在或未啟用時改用預設端點，`Initialize` 之後的失敗對應到 `microphone_unavailable`。裝置清單在自己的短命 utility process 中列出，只在沒有錄影時執行，開始錄影會取消它。
- **打包。** `NSMicrophoneUsageDescription` 與 `com.apple.security.device.audio-input` entitlement，都以 `codesign -d --entitlements` 與 bundle 的 Info.plist 確認。開發版 Electron 沒有使用說明，macOS 不跳提示就直接拒絕：`pnpm audio:quality -- record` 無法錄麥克風，以下的音質測試改用打包版 App 搭配 `audio:quality -- verify`。
- **學習文章。** [音訊時脈、混音與影音同步](../../learning/audio-clocks-mixing-and-av-sync.html)，來源（076 與 074）至此都已結案；「媒體權限與隱私」等 075。

### 驗證

2026-10-16 在參考用 MacBook Pro（macOS 26，Darwin 25.6）上進行桌面回合，使用新的 `pnpm start:app` bundle，預設輸入是 BenQ Monitor 的 USB 麥克風，輸出到有線耳機。Claude 執行 runner 並判讀截圖；維護者回應系統提示並完成需要動手的步驟。

- **錄影 smoke。** 麥克風關閉與開啟各跑一次 `pnpm acceptance`：每次都是 10 個閃光、10 個嗶聲、完整性通過、取消案例通過；log 的 prepared 行結尾是 `mic off` 或 `mic on (BenQ Monitor)`。對麥克風開啟的檔案執行 `pnpm acceptance:playback` 通過（時長、即時播放、seek、seek 後畫面、播到結尾）。第一次以麥克風開始時，macOS 跳出帶使用說明的提示，App 停在 `starting`、沒有倒數，直到維護者允許；那次 session 之後錄了 11 分 51 秒，視訊與音訊都是 711.20 s，沒有遺失。
- **指示燈。** 倒數時出現橘色麥克風指示燈，取消後 3 s 內消失（截圖）。
- **托盤。** 兩種語言的 `pnpm acceptance:tray`：idle 選單在「開始錄影」之後列出「錄製麥克風」，方向鍵移得到它。zh-TW 的 keyboard 案例因 Open RecordStuff 之後焦點被 Cursor 搶走而失敗一次；只用 zh-TW 重跑後全部通過。
- **音質與 ducking**（fixture v2，各三次，`audio:quality -- verify`）。麥克風關閉：通過，增益差在 0.001 dB 內，residual −49.8 至 −54.0 dB，separation ≥116.6 dB。麥克風開啟且輸出有聲：麥克風收到耳機漏音與房間的聲音（其中一次 marker gap −3.6 dB），所以分析失敗是因為真實的麥克風聲音，不是混音器。麥克風開啟且輸出靜音（ScreenCaptureKit 在輸出音量之前取得 App 的音訊，所以麥克風只收到房間）：通過，維持 48 kHz 立體聲，時鐘在 ±0.3 ppm 內，增益差在 0.035 dB 內，residual −34.9 至 −35.9 dB、separation 36.1 至 41.0 dB，是加上房間底噪（單獨量為 −59.9 dBFS RMS）的結果。混音器沒有重新取樣、沒有把立體聲合成單聲道、也沒有改變音量，系統聲音部分沒有 ducking。限制：這台 Mac 沒有靜音的虛擬輸入，所以「靜音」是以靜音輸出模擬。
- **同步。** 按鍵時會變白的頁面，在麥克風開啟下錄影：用力敲五下空白鍵，聲音比白畫面早 20 至 40 ms，中位數 −30 ms（解析度 10 ms）。畫面還要經過 Chrome 繪製、合成與擷取（60 Hz 下一到兩個影格），所以麥克風沒有延遲；按鍵到畫面亮起的時間沒有另外量。
- **CPU。** `pnpm measure:cpu -- --minutes 2 --skip-settings --skip-playback`：30 fps 錄影時，麥克風開啟佔一個核心的 13.3%（95th 14.2%），同日關閉時為 9.9%（10.6%），差異全在擷取程序；低於 30% 的預算，對照記錄的 baseline +25%（13.0%）為 warn。閒置 0.048%，錄影後 0.041%，沒有留下擷取程序。
- **失去裝置。** 選定 iPhone 的接續互通麥克風後，維護者在錄影中關閉 iPhone 的藍牙：2 s 後 log 記下 `microphone lost; recording continues without it`，錄影繼續；停止時先後出現麥克風中斷與已儲存的通知；視訊與音訊都是 98.98 s，存檔紀錄帶有 `microphoneLost`。
- **拒絕。** 執行 `tccutil reset Microphone com.ericts.record` 後開始錄影，跳出提示；選「不允許」後以 `microphone_unavailable` 拒絕開始，沒有產生檔案並送出失敗通知；「錄影設定」分頁的「麥克風」卡片顯示拒絕、說明與「開啟麥克風設定…」。之後再次 reset 回「尚未詢問」，即驗收前的狀態。開發版 Electron 不跳提示就被拒，走的也是同一條拒絕路徑。
- **自動化。** `pnpm check`（152 個檔案、1847 個測試）、`cargo test --lib`（70 個），包括新的 core 與 mixer 案例（遺失只回報一次，之後的聲音丟棄；十分鐘有抖動的麥克風緩衝區保持對齊）、Windows target 的 `cargo check`，以及背景 UI 套件 159 個案例，其中 S117–S120 涵蓋「音訊」區塊。文件步驟沒有改動 App 程式碼：`pnpm site:check`、學習文章的 validator、對變更文件的連結與錨點檢查，以及 `git diff --check` 都通過。
- **審查。** Codex GPT-6.1 Sol，唯讀，兩輪。第 1 輪：遺失的麥克風之後的聲音仍被混入；Windows 在 `Initialize` 之後的失敗被歸為 `capture_start_failed`；capture 紀錄缺少實際開啟的裝置。第 2 輪確認這些修正，並發現裝置列舉可能延續到錄影期間，現在可以取消且只在 idle 時執行。四項都已修正；最後一項修正沒有再審。
- **證據。** 原始檔在 `docs/verification/measurements/`（僅本機）：`2026-10-16-074-microphone-fidelity/`（音質報告、同步頁面與分析、指示燈與拒絕的截圖）、`2026-10-16-074-audio-off/`，以及當天 tray、hotkey、playback 與 CPU 的報告目錄。這些回合在維護者的歷史紀錄中新增了失敗紀錄（未讀 8 → 10）。

### 結案後：與 OBS、Chromium、Cap 比對（2026-10-16）

依維護者要求，把桌面回合無法涵蓋的部分（Windows、靜音的麥克風、拔除裝置、時鐘）以只讀程式碼的方式，與 obs-studio `1ad6110`、Chromium `e545d1e` 和 Cap `d7d36a3` 比對；Cap 的 AGPL 程式碼只供參考設計。每一項發現在修改前都先對照我們的程式碼確認。

- **修正的缺陷。**麥克風的聲音先遇到音訊編碼器錯誤時，兩個平台都會把它當成麥克風中斷；現在改為讓錄影失敗（`capture_failed`），並加上測試。Windows 原本直接相信麥克風的 QPC 時間：驅動程式給出偏差數秒的位置時，整個麥克風會被無聲地丟掉，或在音軌遠處填滿靜音；現在依 Chromium 的做法（crbug.com/1439283），第一個 packet 與抵達時間相差超過 500 ms 的裝置，以及帶有 `AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR` 的 packet，都改用抵達時間（`PacketTimes`，有測試）。
- **維護者的決定，已實作。**麥克風中斷後聲音回來就重新收音（`microphoneResumed`；通知改為「錄影途中麥克風曾中斷，中斷期間只錄到系統音訊。」）。兩個以上的輸入相加超過 −1 dBFS 時改為軟限幅，不再削波（之前兩個平台的行為不同）；只有一個輸入或相加沒有超過時不變。只超過 10 ms 容差一點（最多 2 ms）的偏差，每個 buffer 修正 1 個 frame，取代一次跳 10 ms；在 100 ppm 下原本約每 100 秒就有一次空洞或切斷。麥克風以單聲道擷取、放到兩個聲道，錄音介面 input 1 的麥克風不再只在左耳。stop log 會記錄每個輸入的修正量與限幅樣本數。
- **補強。**Windows 的麥克風 stream 退出系統 ducking（`SetDuckingPreference`），`E_ACCESSDENIED` 回報為隱私權設定。
- **修改後引擎的桌面回合**（Claude 執行，維護者操作）。Settings 的開關觸發了 macOS 的提示，選擇允許。麥克風開啟時的 `pnpm acceptance` 通過：10 個閃光、9 個嗶聲（第一個落在檔案開頭、前面沒有靜音，偵測方式無法計入）、完整性與取消案例。iPhone 麥克風的錄影中，35 秒內左聲道減右聲道為 −inf dB：麥克風以單聲道放在兩個聲道。iPhone 麥克風斷線一次、HUAWEI FreeClip 2 藍牙耳機斷線兩次：每次 2 秒後判定中斷，錄影繼續，存檔紀錄帶有 `microphoneLost`，新通知在結束時出現，視訊與音訊等長（362.84 s、135.45 s、154.72 s）。
- **重新連上後沒有接回。**兩種裝置重新連上（耳機甚至成了預設輸入）後都沒有被接回：AVFoundation 的連線通知一則都沒送到，回合中嘗試的每秒依 `uniqueID` 查詢版本也沒用，這段程式碼已移除。App 外的實驗（每秒查一次）說明了原因：沒有 run loop 時，CoreAudio 的裝置清單立刻少了耳機，`AVCaptureDevice(uniqueID:)` 與新建的 `DiscoverySession` 在 27 秒後仍回報它在線；主執行緒有 run loop 時，AVFoundation 也立刻跟上。AVFoundation 的裝置狀態靠主 run loop 更新，而引擎所在的 utility process 沒有執行它。Cap 透過 cpal（CoreAudio）擷取，且跑在有 run loop 的 Tauri 程序裡，所以不會遇到；Chromium 的 audio service 和我們的引擎一樣在瀏覽器主程序之外，用 CoreAudio AUHAL 擷取並以 `AudioObjectAddPropertyListener` 監聽。改用 CoreAudio 重開成為 078 的步驟 6（[結案紀錄](#plan-078-結案--2026-10-17)）；在那之前只有同一個 session 的停擺會被接回（有單元測試，實機上尚未遇到）。
- **檢查。**`pnpm check`（152 個檔案、1848 個測試；`cargo test --lib` 74 個，新增編碼器錯誤、packet 時間、逐格修正、限幅與重新收音的案例）、Windows target 的 `cargo check --tests` 與 clippy、文件連結與學習文章的 validator。這一輪使用的 bundle 仍含後來移除的重連程式碼；最終原始碼與它的差別只有這段移除，並已重新建置與測試。審查：Codex GPT-6.1 Sol，唯讀，兩輪。第 1 輪：麥克風的中斷與恢復可能以錯誤順序送出，watchdog 也可能把過時的送音時間當成靜音而標記錄影，因此送音時間、中斷狀態與兩種事件改用同一把鎖；響亮的相加在 `f32` 下限幅結果可能剛好等於滿刻度，因此改為停在略低於滿刻度，並加上嚴格的測試。第 2 輪確認兩項修正，沒有新的 findings。

未完成：人耳聆聽；Windows 麥克風（只有 CI）；重開重新連上的麥克風（078）；在限幅、漂移與單聲道修改後重跑音質、同步與 CPU（078 步驟 6）；CPU 多 3.4 個百分點的原因。

## Plan 076 結案 — 2026-10-16

錄影原本透過隱藏 renderer 裡 Chromium 的 `getDisplayMedia` 與 `MediaRecorder` 進行，只能錄一個螢幕或一個視窗，也只能排除本 App 受保護的視窗；它無法隱藏選單列或 Dock，無法錄指定區域或選定的 App，也無法只錄一個 App 的聲音。Plan 076 在 macOS 與 Windows 上以原生 Rust 引擎（napi-rs）取代這條路徑：引擎在 Electron 的 `utilityProcess` 中擷取、編碼、封裝並寫檔，Chromium 路徑則已移除。設計見[錄影](../system-design/recording.md)、[架構](../system-design/architecture.md)與[設計決策](../system-design/decisions.md)中十列原生引擎的決策；[錄影為何離開 Chromium 的 WebRTC 擷取](../system-design/webrtc.md)是舊路徑的設計紀錄。

- **決定（2026-10-14，維護者）。** D1 兩個平台都用 Rust；D2 每次嘗試一個 `utilityProcess`；D3 由引擎寫檔，main 保留檔名、資料夾、剩餘空間檢查、sentinel、歷史紀錄與通知；D4 使用平台的編碼器（VideoToolbox 與 AudioToolbox；Media Foundation），搭配為本專案撰寫的 hybrid MP4 muxer，錄影路徑不使用 FFmpeg；D5 可改寫 Cap 的 MIT crate，其 AGPL 程式碼只供閱讀；D6「隱藏選單列與 Dock」開關，僅 macOS，預設關閉；D7 Chromium 路徑在 macOS 驗收前留在開發旗標之後，之後移除；D8 Windows 只由 CI 驗證。2026-10-15 維護者決定不預先啟動擷取程序（約省 50 ms，代價是約 73 MB 的閒置程序）。
- **原型關卡（2026-10-14，M1 Pro，括號內為 Chromium）。** 快捷鍵到 `prepared` 457–535 ms（347–369 ms）；每個檔案的音訊與畫面長度相同，包括 10 分鐘的錄影（+13 至 +15 ms）；10 分鐘漂移 0 ms，600 組閃光與嗶聲全部對上；錄影中結束擷取程序，留下 8.0 s 可播放的部分檔案。較慢的啟動落在倒數之內，已被接受。
- **引擎（步驟 3–4）。** 兩個平台共用一個 session 核心，負責 pacer、停止規則與停止前的聲音；音訊時間由樣本數計算，在同一個時鐘上補入靜音；所有輸入混成一條 AAC 音軌，某個輸入沒有聲音時，mixer 落後它 500 ms 繼續前進。引擎把 `stopped` 與 `finished` 分開，慢速磁碟的收尾不再受 10 s 停止期限限制：在桌面上，`stopped` 後 0–1 ms recorder 即回到閒置，19–22 ms 後檔案完成。視窗、區域與 App 來源、單一 App 的聲音和麥克風目前只在引擎與其測試中；面向使用者的部分由 074 與 075 加入。
- **Windows（D8）。** `native-windows` job 在 `windows-2025` 上錄下螢幕、區域、視窗與單一程序的聲音；安裝程式 smoke 會載入安裝後的模組。未在 Windows 實機上測試：擷取品質與影格時序、錄影中不出現自己的視窗、系統聲音內容、CPU、麥克風，以及 077 的所有案例。編碼器是 Microsoft 的軟體 H.264；硬體編碼器與剩下的 Chromium 時期提示移到 078（[結案紀錄](#plan-078-結案--2026-10-17)）。
- **macOS 驗收（2026-10-15/16，60 Hz 1920×1080 螢幕，簽署 bundle）。** `pnpm acceptance` 在 60 fps 通過。`pnpm matrix -- quick`：閃光到嗶聲 −25 ms，Chromium 為 +68 至 +74 ms；間隔 50 ms 的影格在 idle 影格修正（PR #12）前為 0.66–2.17%，修正後 0.22–0.44%，Chromium 為 0，剩下部分的原因尚未找到。`pnpm audio:quality` 兩個引擎都通過所有檢查。`pnpm measure:cpu -- --fps 60 --repeat 3`：錄影在 30／60 fps 佔一個核心的 10.4%／14.0%，Chromium 為 15.3%／23.3%；錄影後閒置 0.036%，Chromium 為 0.054%，且不留下 renderer 或音訊服務；這些中位數是參考 Mac 的 baseline。`pnpm acceptance:tray` 通過 14 個案例（兩個因輸入競態而未執行）；錄影中開啟的設定視窗出現在螢幕截圖上，卻不在同一時刻的錄影影格中；錄影中結束 App 會把錄影存檔。維護者在移除 Chromium 路徑前接受了這些結果與剩下的影格間隔（2026-10-16）。
- **過程中發現。** `pnpm measure:cpu` 的設定視窗情境最高量到一個核心的 39%：一張卡片的 hover 預覽在其他 App 後方不斷循環。runner 會先移開游標（PR #7），設定視窗失去焦點時也會停止預覽（PR #8）。
- **移到其他計畫。** 錄影中睡眠、移除螢幕、權限被拒以及 D6 的 Dock 需要維護者動手：[077](#plan-077-結案--2026-10-22)。剩下的影格間隔、開發版 App 自己的視窗、原生節奏診斷，以及 Chromium 路徑留下的部分：078（[結案紀錄](#plan-078-結案--2026-10-17)）。
- **學習文章。** 來源都隨 076 結案的三篇：[原生 API 與技術選擇](../../learning/native-apis-and-tech-stack-choices.html)、[編解碼器、容器與不怕當機的錄影](../../learning/codecs-containers-and-crash-safe-recording.html)與[開源授權實務](../../learning/open-source-licenses-in-practice.html)，依維護者要求，每篇都以選擇的取捨為中心。
- **Pull request。** #5 Windows 引擎、#6 引擎、#7 與 #8 hover 預覽、#9 macOS 整合與 D6 開關、#10 兩個平台的建置、#11 驗證工具、#12 idle 影格修正、#13 `pnpm acceptance` 的結束與自身視窗案例、#14 移除 Chromium 路徑；文件另以一個 pull request 完成。

### 驗證

- 每個 pull request 都在 macOS 與 Windows 上通過 `check.yml`，兩個不穩定的 Windows 案例重跑後通過（#11 的 recorder 測試等待真實 writer、#13 的 UI 分片關閉逾時）。移除後，`pnpm check` 在本機通過；在新的簽署 bundle 上，`pnpm acceptance -- --seconds 10 --skip-cancel --settings-open --quit-while-recording` 每個案例都通過，log 中沒有隱藏 renderer 的痕跡。
- 審查：Codex GPT-6.1 Sol 審查了每個 pull request；其發現（controlled pin 與錄影路徑、重新驗證舊版本、收尾的引擎檢查與 launchd 還原、四個 runner 防護、launchd 擷取開關防護）都在合併前修正。
- 文件：連結與錨點、中英文一致、學習文章的 validator 與 `git diff --check`。

未完成：077 的動手驗收案例、078 的後續事項，以及上面列為未在 Windows 測試的項目。

## Plan 073 結案 — 2026-10-14

App 裡原本沒有任何地方列出所有快捷鍵：Shortcut 卡片只顯示錄影快捷鍵，tray 與「錄影」選單只顯示錄影與開啟的快捷鍵，播放器、縮放與視窗的按鍵則沒有任何地方寫出來。Plan 073 新增一個地方列出這些快捷鍵，以及每一個現在能否使用（[桌面設計](../system-design/desktop.md#鍵盤快捷鍵分頁)）。

- **決定（2026-10-14，維護者）。** 採用獨立的「鍵盤快捷鍵」分頁，位於「一般」與「疑難排解」之間，而不是「一般」裡的群組；macOS 新增「輔助說明」選單，其「鍵盤快捷鍵」會開啟視窗並切到該分頁，項目本身沒有快捷鍵；不列入範圍照計畫（平台的編輯與選單按鍵、清單與對話框的一般導覽、編輯器錄入時按下的按鍵）。依維護者要求，本計畫在獨立 worktree 中，從 072 步驟 4 之前的 commit 開始進行，072 結案後再 rebase 到 main。
- **清單。** 五個唯讀區段：任何地方、RecordStuff 視窗、錄影檔、播放器、全螢幕影片，共 16 列。由 main 產生（`shortcutListGroups`），因為只有 main 知道全域快捷鍵的註冊狀態：錄影列顯示目前的組合、「關閉」或「無法使用」；「開啟 RecordStuff」在註冊失敗或被錄影快捷鍵佔用時顯示「無法使用」，原因沿用 Shortcut 卡片的說明。「更改…」會切到「一般」並聚焦 Shortcut 卡片；錄影或儲存中控制項停用時，改聚焦該列。
- **單一來源。** `src/shared/shortcut-catalog.ts` 存放各列，以及各 handler 比對的常數：播放器透過 `playerKeyAction`，另有 `ZOOM_KEYS`、`CLOSE_KEY` 與 `UNDO_KEY`。按鍵透過 `acceleratorKeys` 顯示；macOS 上的 Space 也顯示為文字，因為 `␣` 會被當成符號唸出。沒有任何快捷鍵改變按鍵或行為。

### 驗證

- `pnpm typecheck` 通過。review 前的 `pnpm test:scope -- general shortcut player layout failures`：unit 路徑與 `pnpm build` 通過，背景套件 142 項通過 141 項；`settings-results.spec.ts` 的 S095–S096 原本寫死四個分頁（實際量到五個分頁都放得下），更新後 10 項全數通過。`src/main/settings`、`src/main/menus`、`src/main/actions`、`src/renderer` 與 `src/shared` 的 unit 與 page tests：56 個檔案、566 項；加入 Help action 案例後 `src/main/actions` 7 項全數通過。review 修正後重新建置執行 `pnpm test:scope -- general shortcut`：22 個檔案、161 項 unit tests 與 37 項背景案例。rebase 到 main 後重新建置再跑同樣五個 scope：35 個檔案、286 項 unit tests，背景案例 142 項全數通過（398.2 秒）。
- 新增測試：catalog 雙向檢查（清單上的每個播放器與縮放按鍵都會觸發 handler，播放器處理的每個按鍵都在清單上）及其例外；model 在 darwin 與 win32 下，錄影快捷鍵為預設、自訂、關閉與註冊失敗，以及「開啟 RecordStuff」註冊失敗或衝突；頁面（入口、唸出文字、狀態、未鎖定與鎖定時的「更改…」、zh-TW）；有無視窗時的「輔助說明」選單；結束中拒絕該 action。
- 原生（macOS），以全新的 `pnpm start:app` bundle（zh-TW），由 Codex GPT-6 Astra 以 computer use 操作，Claude 判讀其截圖：「輔助說明 → 鍵盤快捷鍵」把同一個視窗切到該分頁，五個區段、macOS 符號、Space 與「更改…」皆正確（pass）；「更改…」回到「一般」並聚焦 Shortcut 列（pass）；選單列顯示「輔助說明」，其輔助使用樹中有「鍵盤快捷鍵」項目，但未截到展開的選單，因此「沒有快捷鍵」只有 unit test 證據。從 tray 開啟與結束受阻：自動核准拒絕 Computer Use 存取 SystemUIServer；App 以 ⌘Q 結束，程序已確認退出。Computer Use 工具留下的 Software Cursor 浮層已由維護者關閉。
- Review：Codex GPT-6.1 Sol，第 1 輪兩項 findings——唸出的文字是符號（部分接受：Space 改為文字；未另寫一套唸法，因為計畫指定 `describeAccelerator` 的文字，VoiceOver 也會把修飾鍵與方向鍵符號唸成按鍵名稱），以及錄影中「更改…」無法聚焦已停用的控制項（接受）；第 2 輪無 findings。

未完成：展開後「輔助說明」選單的外觀、該輪的 tray 路徑，以及 Windows 實機（僅 CI）；網站說明頁未變更，計畫本就排除。

## Plan 072 結案 — 2026-10-14

2026-10-13 維護者看到已安裝的 App 在播放器播放一段 2 小時 21 分的錄影時，有一個 renderer 用掉單核 74–77%，暫停後降到 0%。Plan 072 找出兩個原因、都已修正，並把播放納入 CPU 預算（[工具](../system-design/tooling.md#cpu-預算)的播放成本）。

- **容器。**那段長錄影一直是 fragmented MP4：capture host 停止時可能寫出 `tfdt` 為 0 的空音訊 run，`FragmentIndex` 因此讓整個檔案失敗（`track 1 goes back to 0, before its last sample`）。現在略過 run 中沒有任何 sample 的 `traf`，這類錄影會存成 plain MP4；兩個單元案例涵蓋它，包括最後一個 fragment 為空時的 ffmpeg packet 比對。播放 fragmented 檔案時，renderer 的成本增加得比長度還快：Chromium 的 demuxer 透過 `recordstuff-media:` 的 range request 讀取每一個 `moof`，媒體緩衝區保有數千段不相連的區間。在同一個 Electron 中，同一個檔案從 `file://` 播放是 3.5%，透過與 `RecordingsLibrary.handle` 相同方式提供 range 的 handler 是 72.8%；加上快取驗證標頭沒有差別，限制 4 MiB 的 206 無法播放，`net.fetch(file://)`（4.4%）會忽略 `Range`。維護者決定不修復已存成 fragmented 的檔案（2026-10-14）：本機的 47 支是測試錄影，已移到垃圾桶。舊版存成 fragmented 的檔案仍有這個成本與開啟緩慢。
- **模糊。**播放 plain 檔案時，設定視窗的播放器比全螢幕和 Chrome 多耗 GPU 程序的 CPU，因為對話框背景的 `backdrop-filter` 會隨每個影片畫格重畫。維護者比較過不模糊的較暗背景後同意（2026-10-14）：背景現在只負責變暗，ui.css 改為模糊下方的頁面（`.player[data-open]` 時對 `#root` 套用 `filter: blur(3px)`），Chromium 只畫一次；外觀相同。
- **解碼器。**不論 fragmented 或 plain，每個檔案的影片都由 `VideoToolboxVideoDecoder` 解碼、音訊由 `FFmpegAudioDecoder` 解碼，所以原因不是軟體解碼。
- **防止退步。**`pnpm measure:cpu` 新增情境 P：最後一段 30 fps 錄影，從系統匣的 Show last recording 開啟，透過 Chromium 的輔助使用樹以元素 id 確認焦點在它卡片的播放按鈕（量測前再關閉輔助使用樹），按 Return 播放，依角色判定 50 秒：App ≤22%、GPU 程序 ≤11%、renderer ≤10%，兩者各需至少 0.5% 作為確實播放的證據，且檔案必須存成 plain MP4。`--skip-playback` 會略過它。

### 驗證

在 M1 Pro 參考機（Electron 44.3.0）上以共用取樣程式依 Chromium 角色量測，單位是單核百分比。2026-10-13 的錄影不在這台 Mac 上，經維護者同意改用 `2026-10-10 01-11-43.mp4`（36 分鐘，相同的 H.264 Baseline 屬性），以 ffmpeg 轉成 fragmented，並串接四次（2 小時 25 分、10,186 個 fragment），各自附一份 plain 複本。開發版，診斷 fixture 載入建置好的設定頁面，經由正式的 `RecordingsLibrary.handle` 提供檔案；暖機 10 秒後量 59 秒，數字是 renderer / App 合計：

| 檔案 | 設定視窗播放器 | 全螢幕 | 暫停 |
| --- | --- | --- | --- |
| 10,186 個 fragment | 73.7 / 79.0 | 70.9 / 74.0 | ≤ 0.6 |
| 同內容，plain | 5.6 / 17.6 | 5.6 / 13.8 | ≤ 0.8 |
| 2,547 個 fragment（36 分鐘） | 11.7 / 22.0 | 11.6 / 18.4 | ≤ 0.6 |
| 同內容，plain | 5.1 / 16.4 | 5.6 / 13.6 | ≤ 0.5 |
| 10,186 個 fragment，從 75% 開始 | 98.2 / 102.5 | — | ≤ 0.9 |
| 同內容，plain，從 75% 開始 | 5.4 / 16.7 | — | ≤ 0.6 |
| 60 秒 plain 錄影；High 30 fps 重新編碼（44 秒） | 5.9 / 19.6；5.9 / 19.7 | — | ≤ 0.6 |

- fragmented 的 2 小時 25 分檔案：第一個畫面在 4.47 秒、7,308 個 range request 之後，進度列縮圖 11.4 秒、再 7,039 個 request，從 75% 開始播放會跟不上（60 秒只播了 57.9 秒的內容）；plain 複本是 0.29 秒、3 個 request，縮圖 70 ms、4 個。同一個檔案與其 plain 複本的參考：Chrome 155（`file://`）合計 11.2% 與 11.5%，renderer 2.8% 與 2.9%；QuickTime Player 播放 plain 複本 4.8%，無法開啟 fragmented 檔案。renderer 主執行緒在跑 native 程式碼（V8 profile 71.6% `(program)`，JavaScript 不到 0.1%）；native 函式沒有找出名稱，因為 1.4 GB 的符號檔無法在合理時間內下載。
- 模糊，plain 檔案、設定視窗播放器、GPU 程序：有背景模糊 10.9%、關閉後 6.4%、關閉所有 `backdrop-filter` 6.5%、隱藏靜止的控制項 10.8%；全螢幕與 Chrome 6.4%。在下面那段 60 秒錄影上，修改後對照原本的背景：6.7% 對 13.5%（App 13.9% 對 21.5%），截圖中頁面模糊、畫面清楚。
- 步驟 0：在一支 host 寫出的錄影複本中插入空的音訊 `traf`，修改前重現 log 中的原因，修改後存成 plain，`framemd5` packet 與 ffprobe 長度相同；AVFoundation 能開啟。在新的 `pnpm start:app` bundle 上執行 `pnpm acceptance -- --seconds 10 --skip-cancel`，存成 `finalize 14 ms to plain MP4`，在播放器中 247 ms、3 個 request 就開啟。
- 打包後的 App，`pnpm measure:cpu -- --minutes 1`（[報告](../../verification/measurements/2026-10-13T17-08-46-740Z-cpu/report.md)）：PASS；A 0.049%、R 30 fps 14.3%、B 0.053%、C 0.114%、P 16.6%（GPU 8.3%、renderer 6.6%，檔案存成 plain）。Review 之後，加上播放按鈕確認的 `pnpm measure:cpu -- --minutes 1 --skip-settings`：PASS（[報告](../../verification/measurements/2026-10-13T17-25-20-816Z-cpu/report.md)）；P 16.9%（GPU 7.6%、renderer 6.4%）、R 16.0%、A 0.059%、B 0.067%。
- 檢查：`mp4-finalize.test.ts` 7/7，兩個新案例在沒有修改時失敗；步驟 0 之後 `pnpm check`（147 個檔案、1,852 個測試）；步驟 4 之後 `pnpm test:scope -- player tooling`：619 個單元測試與 13 個背景案例；review 修正後 `scripts/lib` 470 個。步驟 4 的建置與執行期間，工作目錄中同時有另一項工作尚未提交的預覽聲音修改。
- Review：Codex GPT-6.1 Sol，pass 1 審查步驟 0，沒有 findings；pass 2 審查步驟 4，指出送出 Return 前沒有確認焦點在播放按鈕上（接受；以元素 id 確認，並在量測前關閉輔助使用樹）。

未做：全螢幕播放器不在 `measure:cpu` 中（量測時它與沒有模糊的設定視窗播放器相同）；舊版存成 fragmented 的檔案不修復。

## Plan 070 結案 — 2026-10-10

為本機「修改－驗證」循環提供聚焦入口（[聚焦 scope](../testing.md#聚焦-scope)、[工具指南](../system-design/tooling.md#聚焦測試-scope)），依維護者要求接在 071 之後完成。

- **入口。** `pnpm test:scope -- <scope 或測試檔>…`：typecheck、選到的 Vitest 檔案、只有選到 UI 案例且 `out/` 過期時才建置，接著以一次 Playwright 執行跑選到的背景案例；另有 `--list`，以及透過 `vitest list --filesOnly` 與 `playwright test --list` 列出、不建置也不啟動 Electron 的 `--dry-run`。未知 scope、不存在的檔案與空的選取以 exit 2 結束；子程序的結果沿用配方 runner 的階段處理。
- **目錄。** `scripts/lib/runner/test-scopes.mts` 有十一個 scope：每個設定分頁一個（`recording-settings`、`general`、`library`、`failures`），以及 `layout`、`player`、`countdown`、`shortcut`、`settings-bridge`，和只有單元測試的 `recording` 與 `tooling`。混合型 spec 的案例各自帶 Playwright tag（`components` 18 個、`settings-panel` 14 個、`settings-layout` 7 個、`player` 5 個、`settings-results` 1 個）；`test-scopes.test.ts` 會在檔案不存在、tag 沒被使用、單元過濾條件比對不到任何檔案，或 spec 不屬於任何 scope 時失敗。
- **拆分。** 設定矩陣原本 12 個案例，每個都跑遍所有分頁的十種狀態，再於最小尺寸跑播放器與卡片選單；現在拆成 36 個案例（語言、外觀、尺寸、分頁）與 4 個疊加層案例（語言、外觀、最小尺寸）。所有斷言都保留：每個狀態的 S023 與 S024、各分頁案例中的 S025 到 S028、S035 與 S036，以及先畫出 library 狀態的疊加層案例中的 S029 到 S034。完整執行時矩陣花 69.2 秒，之前是 44.3 秒：多出的 25 秒是能單獨選取分頁的代價。
- **政策。** `AGENTS.md`、中英文測試與貢獻指南、工具指南與配方說明，現在都把聚焦入口列為迭代時使用，大範圍組合則用於共用或跨範圍的改動與最終執行；CI 與發布關卡不變。

### 驗證

- 最終遷移執行，在最終原始碼上跑 `pnpm acceptance:recipe -- settings`：147 個檔案、1,850 個單元測試、建置、背景 156/156；總時間 463.6 秒（typecheck 1.2 秒、單元測試 21.3 秒、建置 2.8 秒、背景 437.6 秒）。`pnpm test:ui:drills` 13 個通過、1 個略過，同時涵蓋當天稍早全螢幕變更在 boundary 中記錄的 `setBounds`。
- 在同一份建置上的代表性工作：General 分頁的視覺修改（`general`：5 個單元測試檔、34 個案例，不含 library、播放器、失敗紀錄、倒數或快捷鍵案例）68.9 秒，比完整執行少 85 %；獨立 helper（`src/shared/file-name.test.ts`）2.8 秒，不建置也不啟動 Electron；持久化路徑（`settings-bridge`：8 個單元測試檔、4 個案例）11.1 秒。Dry run：共用 token（`layout`）99 個案例；`recording-settings` 21 個。依政策，純文案修改不執行任何測試 runner。
- 沒有最佳化 global setup：在 `general` 執行中，34 個案例花 60.5 秒，typecheck 與單元測試共 6.3 秒，setup 並不是主要開銷。

未做：不從 diff 自動選取（不在範圍內）；tag 靠審查與目錄測試維持，不會自動推斷。

## Plan 071 結案 — 2026-10-10

錄影檔分頁的分類與搜尋（[桌面設計](../system-design/desktop.md#錄影檔)），2026-10-09 以 `b9f7f111` 實作，同日依維護者檢視以 `ef9eda4b` 改版；2026-10-10 依維護者要求結案。

- **契約。** 分類就是儲存位置本身的子資料夾，只有一層（隱藏資料夾、套件、連結與只有其他檔案的資料夾不列出，空的會顯示）；卡片以「移到」搬移，絕不取代其他檔案；分類可新增、重新命名（絕不取代其他項目），空的分類可刪除並移到垃圾桶；單一選擇器列出全部、未分類、最愛與所有分類，並可篩選；目前顯示的分類與最愛會記住（`libraryShown`、`libraryFavorites`）；搜尋依檔名篩選；只有視窗開著時才遞迴監看儲存位置；main 只處理已列出的 id 與資料夾。
- **改版時移除。** 把卡片拖到分類：在桌面上放開後沒有移動（`webContents.startDrag` 沒有以 drop 送回同一頁面），因此計畫中尚未驗證的原生拖曳限制已不適用。
- **審查。** Codex GPT-6.1 Sol 對第一個 commit 做兩輪唯讀審查，對後續修改再做一輪；八項 findings 全部修正。

### 驗證

- 實作時：typecheck、1,827 及後來 1,831 個單元測試、126 個背景 UI 測試與 drills 通過；有遞迴監看時 `pnpm measure:cpu -- --skip-recording` 通過。
- 2026-10-10，原始碼包含兩個 commit：`pnpm acceptance:regression`（1,843 個測試、背景 128/128）；`pnpm measure:cpu` 的 C（設定視窗開著，因此遞迴監看正在監看維護者的儲存位置）0.149 %，上限 0.5 %。

未驗證：大型或很深的儲存位置下遞迴監看的 CPU（量測的是維護者自己的資料夾）；toast 保持焦點只靠程式碼檢查，因為 happy-dom 無法呈現；選擇器搭配 VoiceOver。

## 存檔時轉成一般 MP4 與預先載入的全螢幕頁面 — 2026-10-10

維護者要求，排在 plan 071 之前：一支 36 分鐘的錄影開啟時黑屏約一秒，全螢幕也會卡頓。兩項變更（[存檔時轉成一般 MP4](../system-design/recording.md#存檔時轉成一般-mp4)、[桌面設計](../system-design/desktop.md#錄影檔)）；比較時閱讀了 OBS `7d98bebe` 與 Cap `8d808e09`。

- **原因。** 擷取 host 寫的分段 MP4 沒有索引：Chromium 在第一格之前讀了 2.7 GB 檔案（2,106 個片段）的 1,722 個範圍、358 MB，約 1.1 秒；AVFoundation 完全無法開啟（`-11832`）。補上 `mfra` 沒有幫助。
- **存檔時轉成一般 MP4。** `FragmentIndex` 跟著已寫入的位元組讀；finish 時 `FileWriter` 附加完整 `moov` 並 sync，再把 16 位元組的 `mdat` 標頭寫在舊 `moov` 上並 sync，與 OBS 的 hybrid MP4 相同，但 OBS 沒有這兩次 sync。同一支 36 分鐘錄影：建立索引 16 ms、索引 1.5 MB、第一格 41 ms、14 次請求，AVFoundation 也能開啟。若在兩步之間中斷，檔案仍以分段格式播放。
- **全螢幕。** 以新的 `video fullscreen timing` log 行量測：第一格之前的 200 ms 中，有 140 ms 花在建立視窗與載入頁面；150 ms 的淡入本來就平順（最長一步 23 ms）。現在在 macOS 上，設定視窗開著時會有一個頁面隱藏載入待命：第一格 74–75 ms、顯示 82 ms、淡入完成 233–238 ms，之前分別是 168–192、175–199 與 331–357 ms。

### 驗證

- 維護者的四支錄影（10 秒到 36 分鐘）以隨機大小分段送進 `FragmentIndex`：每個封包的串流、解碼與顯示時間、大小與校驗碼都與原檔相同（ffmpeg `framemd5`），只有被修正的長度不同；ffprobe 長度相同；AVFoundation 都能開啟並在 80 % 處畫出影格。依維護者要求，那支 36 分鐘錄影已換成重新封裝的版本（原檔移到垃圾桶）。
- `pnpm acceptance:regression`：146 個檔案、1,843 個測試、build、背景 128/128（P11 另外確認播放的就是待命的頁面）。
- 第一輪桌面實測，使用新的 `pnpm start:app` bundle：`pnpm acceptance` 通過（60 fps 錄 10.3 秒、所有完整性檢查、倒數取消案例）；log 顯示 `finalize 14 ms to plain MP4`，檔案為 ftyp、mdat、moov；`pnpm acceptance:playback` 在 QuickTime 通過；`pnpm acceptance:player` 4/4，取得上述基準計時。
- 第二輪桌面實測，使用重新建置的 bundle：`pnpm acceptance:player` 4/4，兩次進入都是 `warm page`；`pnpm measure:cpu`：A 0.052 %、30 fps 錄影 R 15.1 %（編碼器 2.1 %）、B 0.052 % 且錄影後程序角色正確，接著 C 的前置檢查失敗，因為它要求恰好一個 renderer；改成至少一個後，`pnpm measure:cpu -- --skip-recording --minutes 1` 通過：A 0.063 %、C 0.149 %，renderer ×2（上限 0.5 %）。

未驗證：這項變更之前存的錄影仍是分段格式；存檔瞬間當機只在複本上模擬，沒有在 App 裡實際造成；Windows（不會預先載入頁面）；主觀聽感。

## 統一焦點線、shadcn 前的紅色與素面狀態卡 — 2026-10-07

同日維護者的第三輪（[桌面設計](../system-design/desktop.md#設定視窗)）。證據：`measurements/2026-10-06T16-30-24Z-restore-look/iter6` 與回歸測試 `test-results/ui/` 中的焦點圖片。

- **紅色。** 恢復 shadcn 前的 `--chosen`（`3210ae2f` 的 `settings.css`）：淺色 #fa2d48，深色 #e85a62。
- **焦點。** 所有控制項統一：一條選中紅的細線（`--focus-width`）畫在控制項邊緣，沒有外暈；有底色的控制項畫在外側，播放器內為白色；只在鍵盤操作且視窗為作用中時顯示（`ui.css` 的 `focus-ring`、`focus-ring-within`、`focus-ring-field`）。錄影卡片改為圍繞整張卡片並順著圓角，不再是被裁切在卡片內的框。
- **狀態卡。** 任何狀態都是素面卡片，沒有底色、標題前也沒有圓點；修正按鈕橫跨卡片，第二個選項改為低調的連結。
- **失敗紀錄。** 圖示為灰色，顏色改由結果文字呈現（沒有保留為紅色，保留部分為琥珀色）。
- **捲軸。** 7 px。
- **Review。** Codex GPT-6.1 Sol 兩輪（約 3 分鐘）：[1] 紅色結果文字在深色 hover 底上只有 4.1:1（改用 `--outcome-red`，≥5:1）；[2] Base UI 的滑桿把手會阻止方向鍵事件傳遞，頁面因此以為最後是滑鼠操作而隱藏鍵盤焦點線（改以 capture 階段的監聽標記鍵盤輸入；Chromium 本身在滑鼠點過 range 後仍不把它視為 focus-visible，所以該情境與以往相同不顯示線）；[3] 卡片與把手的 `:has()` 外框在非作用中視窗仍顯示（現已排除）；[4] 新錄影卡片的高亮會讓同一張卡片的鍵盤焦點線淡出（高亮現在讓位給焦點）。全部接受並修正；[4] 沒有再經 review。樣式護欄對 `var(--outcome-red)` 的誤判也已修正並加上植入案例。

### 驗證

- 最終原始碼上的 `pnpm acceptance:regression`：131 個檔案 1,743 項測試、建置，背景套件 67/67，含 S110–S115（每個控制項的線：實線、1 或 1.5 px、選中紅、無外暈）、U070-3（卡片的線），以及檢視後重新產生的 matrix 基準。

未進行桌面回合：只涉及頁面內的顏色、焦點繪製與版面，視窗選項、左上角、全螢幕與原生輸入都未改動。未手動驗證：強制色彩、VoiceOver。

## Apple Music 配色、失敗紀錄卡片與選單 — 2026-10-07

同日維護者檢視恢復後的外觀後的第二輪（[桌面設計](../system-design/desktop.md#設定視窗)）。證據：`measurements/2026-10-06T16-30-24Z-restore-look/iter5`。

- **配色。** 只調顏色、更貼近 Apple Music（維護者從三個方向中選定）：純白內容區、#f5f5f7 側欄與 #e8e8ed 選中底塊、#1d1d1f 文字、無陰影的細框群組、Apple 的深灰，紅色 #fa2d48（深色 #fc3c44）。次要文字（#636368）與紅色文字（#cc0e2c，深色 #ff7a80）比 Apple 原值略調，以在凹槽與底塊上維持 4.5:1。
- **失敗紀錄。** 每天一張卡片（維護者從三種版面中選定）：每列有狀態圖示（保留部分為琥珀色，沒有保留為紅色，未確認加紅點），詳情在卡片內展開，說明放在提示框。
- **選單。** 依維護者選擇，設定的 NativeSelect 改為 shadcn Select。過程中發現並修正兩個缺陷：Base UI 會插入被 CSP 拒絕的 style 標籤（建置時移除，規則改放 `ui.css`）；頁面的 Escape 會在選單開啟時關掉整個視窗（現在交給選單處理）。觸發鈕的焦點框只在鍵盤操作時顯示，因此滑鼠選完後不再留下框（即維護者在原生選單上看到的殘留焦點框）。
- **閃爍。** 儲存一項設定時，其他控制項都被 disable 並變成 50% 透明（shadcn 會讓 disabled 控制項變淡）；現在保持不動且不變淡，與 shadcn 前的 `.saving-disabled` 相同。側欄選取改為瞬間切換，不再交叉淡入淡出。
- **邊緣。** 內容捲動後上緣也以模糊漸層融入視窗，與下緣相同；頁面標題下移 22 px。
- **Review。** Codex GPT-6.1 Sol 一輪（約 2 分鐘）：無 findings。

### 驗證

- 最終原始碼上的 `pnpm acceptance:regression`：131 個檔案 1,743 項測試、建置，背景套件 66/66，含 U070-2（選單焦點框、焦點回歸、Escape），以及檢視後重新產生的 matrix 基準。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4（`2026-10-06T18-03-24-982Z-player-acceptance`）；`pnpm acceptance:shortcut-native` 通過，其 fixture 改由新選單啟動擷取；`pnpm start:app` 之後 `pnpm acceptance:settings-shortcut -- --observe --quit` 第二次執行通過（`2026-10-06T18-04-46.651Z-settings-entry-fZI2C3`）。第一次因為在剛開啟的 bundle 寫入啟動記錄前就讀取 app log 而停止，並留下 app，重跑同一個已驗證 bundle 前已從其選單結束。沒有殘留程序。

未執行：錄影、CPU、通知與網站檢查。未手動驗證：VoiceOver 搭配新選單、強制色彩、減少動態效果。

## 恢復外觀與動態 — 2026-10-07

Plan 069 之後應維護者要求，在 069 的 token 分層上，恢復 React／shadcn 改寫（`3e0f58e3`）遺失的外觀與動態，以其上一版 `3210ae2f` 為對照（[桌面設計](../system-design/desktop.md#設定視窗)）。這次沒有另開計畫，本紀錄即為結案。本機證據：`measurements/2026-10-06T16-30-24Z-restore-look/`（gallery `iter1`…`iter4`）。

- **配色。** 舊值改以 shadcn token 表達：墨色 `--primary`、安靜的灰、`--card-border`／`--card-shadow`、`--chosen`（#fa2d48，深色 #e85a62）用於開啟的分頁、開啟的開關、數量、未讀失敗、卡片播放鈕與焦點框，另有 `--sidebar*`、`--selected` 與錄影、警告、成功狀態。紅色文字使用 `--chosen-text`（#dc1a38，深色 #f06b73），因為 #fa2d48 在白底只有 3.8:1，低於 plan 067 的 4.5:1。
- **版面。** 寬版側欄從視窗頂端到底部有自己的灰底，開啟的分頁以淺色底塊浮起、不畫線；在 macOS 上側欄承接視窗按鈕的角落，品牌位於按鈕下方，只有側欄頂端可拖曳視窗，內容從頂端開始。內容在視窗右緣捲動，捲軸較細。macOS 窄視窗在標題列顯示 App 名稱；窄分頁列保留紅線。分段控制恢復為凹槽中浮起的選項；卡片選單每項一行。
- **動態。** 擷取中的跳動條、失敗紀錄箭頭的旋轉、新錄影外框 2.4 秒淡出（原本因 `Clip` 只在 `animationend` 重設而永不消失）、卡片紅色播放鈕放大淡入、播放器把手與加粗的軌道只在滑鼠移上時出現、快轉提示的邊緣弧形與依序亮起的箭頭、音量數值與快轉提示淡出，以及新增的點擊畫面、Space 或 K 時的播放／暫停閃現。減少動態效果時閃現不動。
- **播放器細節。** 畫面與進度列為手指游標，畫面不畫焦點框，控制項 38 px、圖示 24 px（全螢幕 52／32），恢復舊的漸層與文字陰影。
- **Toast。** 每個 toast 的生命週期交給 Sonner：每次開啟一個 Sonner toast（`toastState.show`），「已復原」原地更新，關閉時滑出；它填滿 Sonner 的位置，保留角落的關閉鈕與陰影，並位於對話框之下。
- **Review。** Codex GPT-6.1 Sol 兩輪（約 4 分鐘）：[1] 上一個 toast 滑出時顯示的新 toast 被合併進去而消失；[2] unstyled toast 在寬視窗沒有寬度；[3] 離場中的 toast 換成新 toast 的文字。三項都接受並以回歸測試修正；[3] 的修正與之後的版面調整（內容從頂端開始、捲軸貼齊右緣）沒有再經 review。

### 驗證

- 最終原始碼上的 `pnpm acceptance:regression`：131 個檔案 1,743 項測試、建置，背景套件 65/65，含新增的 U070-1（側欄、開關、卡片選單、播放鈕）與 P20（游標、焦點、閃現），以及檢視後重新產生的 36 張 matrix 基準。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4（`2026-10-06T17-07-08-657Z-player-acceptance`）；`pnpm start:app` 與 `pnpm acceptance:settings-shortcut -- --observe --quit` 通過（`2026-10-06T17-08-25.491Z-settings-entry-Uc5wg0`）；Claude 判讀其 `settings-window.png`：視窗按鈕位於側欄頂端、品牌在其下方，內容從頂端開始，細捲軸貼齊右緣。沒有殘留程序。

未執行：錄影、CPU、通知與網站檢查（只涉及外觀與 renderer 行為）。未手動驗證：強制色彩、減少動態效果與 VoiceOver。

## Plan 069 結案 — 2026-10-06

Plan 069 依維護者要求，把 renderer 的樣式移到 shadcn 的三層，保留 067 定下的所有值，預期畫面完全不變（[分層](../system-design/desktop.md#設定視窗)）。改動前，`ui.css` 的每條功能規則都沒有 layer，因此會蓋過 primitive 的 utilities；移進 `@layer components` 後會輸給它們，所以凡是與 primitive 自身 utility 設定同一屬性的規則，都改成呼叫端的 utilities 或 primitive 的 variant。證據保存在本機的 `measurements/2026-10-06T15-31-12Z-shadcn-layers/`（`before`、`before-repeat`，以及 HEAD 上成對的 `run-a`／`run-a2` 與變更後的 `run-b`／`run-b2`）。

- **Token。** `light-dark()` 配對改為數值相同的 `:root` 與 `.dark` 區塊；`card-`、`popover-`、`secondary-`、`accent-foreground` 各有自己的變數；29 個寫死的顏色改為 `--indicator`、`--brand`、`--brand-foreground`、`--media`、`--media-foreground`、`--media-scrim`、`--media-veil`、`--media-hover` 與 `--toast-shadow`。全螢幕頁原本從未設定 `.dark`、依賴 `light-dark()`，現在以設定頁的 hook（`lib/color-scheme.ts`）設定它。
- **Primitive。** Button 的 `wrap` 與 `icon-xl`（全螢幕頁 52px 的控制項，經由 Player 的 `large`）、Card 的 `size="xs"`、Badge 與 Kbd 的尺寸及 Kbd 的 `inline`、Slider 的 `variant="media"` 與 `growOnHover`、Switch 與 Toggle 的強制色彩狀態，以及 NativeSelect 的省略號，取代了 `.section > [data-slot="card"]`、`.controls > [data-slot="button"]`、`.pc [data-slot="slider-*"]`、強制色彩下的 `[data-slot="switch*"]` 規則，以及 `.tab-badge`、`.toast-key` 與 `.pc-row button` 的覆寫。每個改過的檔案開頭都寫明與 shadcn 的差異。
- **Feature。** 頁面版面放在 `@layer components`；`wide`、`narrow`、`compact`、`darwin` variant 精確承接原本的 media query。非作用中視窗的焦點隱藏與失敗紀錄內的焦點外框維持 unlayered，旁邊寫明理由。
- **前後對照。** Gallery 每次執行並不完全相同（輸出資料夾路徑、檔名範例的時間、影片畫格、動畫與縮圖），因此以 HEAD worktree 與變更後的程式成對同時繪製。252 張中有 190 張至少有一組前後完全相同；其餘 62 張在遮掉同一份程式兩次執行間本來就不同的部分後，剩下的只有路徑中每輪不同的字母、播放器移動中的畫格與提示圈，以及一個 hover 轉場中的分頁圖示，而它在 HEAD 自己的兩次執行間也會變動。`measurements.json`（字級、對比、點擊區、overflow、截斷）在 252 張全部相同。
- **護欄。** `tests/style-guard.test.ts` 在 token 以外出現顏色（CSS 值、Tailwind 色票與任意顏色 utility、原始碼中的顏色字串；允許 shadcn 的 `bg-black/80` overlay 與 `bg-white` 滑桿把手），或樣式表出現 `[data-slot]` selector 時失敗，`countdown.css` 豁免。植入 `color: #ef4444`、`.section > [data-slot="card"]` 與 `text-white` 都會讓它失敗；還原後通過。
- **Review。** Codex GPT-6.1 Sol 一輪（約 2 分鐘），確認沒有視覺回歸；[1] 護欄放過 inline 的 `rgb(…)` 或具名顏色。已接受並以植入 inline 案例修正；該修正只改測試，沒有再經 review。

### 驗證

- 最終 App 原始碼上的 `pnpm acceptance:regression`：typecheck、131 個檔案 1,743 項測試、建置，背景套件 63/63，含 `settings-layout` U067-0…3，36 張 matrix 基準未變。Review 修正 [1] 只改測試，之後護欄 2/2 與 typecheck 通過。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4，沒有 console 錯誤，cleanup `groupGone`（`2026-10-06T16-04-16-461Z-player-acceptance`）；全螢幕截圖顯示畫面上的白色控制項與漸層。

未執行：錄影、matrix、CPU、通知與網站檢查（只改樣式），以及 `settings-shortcut --observe`（視窗選項與左上角繪製未變）。圖片未涵蓋：只在 hover 出現的狀態（進度列變粗、音量滑桿、卡片的播放遮罩）、強制色彩與非作用中視窗，這些依賴搬移後的規則與背景套件。

## Plan 067 結案 — 2026-10-06

Plan 067 依維護者要求盤點整個設定視窗（四個分頁、側欄、狀態卡、頁尾、說明、選單、改名、內嵌播放器、全螢幕、對話框與暫時回饋），修正截圖與量測確認的問題。多數問題來自同一個 token：`ui.css` 把根字級設為 13px，而 shadcn 元件以 rem 計算尺寸，因此每個控制項都以 9.75px 的文字畫在 22.75px 的框內，badge 只有 8px。根字級現在是 16px，`text-xs` 重新定義為 13px（[字級](../system-design/desktop.md#設定視窗)）。證據保存在本機的 `measurements/2026-10-06T14-22-44Z-settings-ui-audit/`（before、各次迭代、after、`compare.html`、`regression.log`）。

- **矩陣。** `pnpm preview:ui` 現在畫出 252 張圖，附 `shots.json` manifest 與 `measurements.json`（computed 字級與對比，含欄位值與 opacity；點擊區；overflow 與被截斷的文字）：兩種語言、兩種主題在預設、窄與最小尺寸下的 48 張分頁圖與各自捲到底的畫面、599/600/601 與 419/420/421 px 斷點、1440×900、125% 與 150%（App 最大 zoom）以及 200% reflow 探測，還有暫時狀態（說明、無效檔名、卡片選單、改名與被拒、空資料夾與無法讀取、鍵盤焦點、zoom 通知、toast、失敗紀錄、錄影中、權限、播放器、全螢幕）。依 manifest 配對 252 組，前 → 後：小於 12px 的文字 3,628 → 0，低於對比下限的文字 665 → 0，超出視窗的控制項 30 → 0，overflow 0 → 0，小於 24px 的控制項 2,812 → 200（全是開關與滑桿把手，gallery 未計入其 `::after` 點擊區，以及周圍留白的 toast 20px 關閉鈕）。前值使用 review 修正 [1]–[3] 之前的量測，未涵蓋欄位值與 opacity；後值使用修正後的量測。
- **問題清單。** 15 項確認問題全部修正，沒有延後。P1：L01 控制項、分頁、選單、對話框、toast 與狀態文字 9.75px，badge 8px；L02 控制項高 22.8px，ⓘ 16.3px；L03 失敗紀錄主標（9.75px）比次要文字（12px）小；L04 在 380×360 視窗 150% 時，分頁（原本就有）以及字變大後的長按鈕與分段控制超出視窗或被卡片裁掉。P2：L05 淺色 muted 文字 4.4:1（現為 `#68686f`，5.0:1）；L06 錄影中狀態 3.76:1（`--recording`）；L07 列自己的按鈕（開啟通知設定…）貼在圖示邊緣而非標籤欄；L08 檔名列標籤對著欄位與範例的中線、欄位靠在欄的左側；L09 無效檔名格式沒有標示（現為 `aria-invalid` 與錯誤色）；L10 窄視窗只顯示圖示的分頁 hover 時沒有名稱；L11 空資料夾狀態的長路徑在最小尺寸撐寬面板（迭代中發現）。P3：L12 區段卡片上下 padding（16 + 12px）與左右 14px 不一致；L13 metadata 11px；L14 改名欄位錯誤時未標 invalid；L15「技術細節」高 19.5px。接受的取捨：卡片 ⋯ 在 hover 或焦點時出現，選單也能以右鍵開啟；macOS 為視窗按鈕保留的 52px 在所有尺寸與 zoom 下維持；開關、滑桿把手與 toast 關閉鈕保持繪製尺寸，以擴大或留白的點擊區達標；最小尺寸兩欄網格中的長時間戳標題會換行；App zoom 上限 150%，200% 只是探測（可 reflow、沒有 overflow）。
- **各頁。** 錄影檔、錄影設定、一般、失敗紀錄、側欄與窄分頁、狀態卡、選單、改名、說明、toast、zoom 通知、內嵌播放器與全螢幕頁，改動前後都以原解析度逐張檢視；修正後沒有未解決的問題。另修正一個 fixture 缺陷：gallery 會點擊分頁已自動展開的未讀失敗，反而把它收起。
- **回歸斷言。** `tests/ui/settings-layout.spec.ts`：U067-0 以注入的探針檢查兩條量測（有背景又半透明的容器、小字欄位值）；U067-1 預設尺寸下兩種語言與主題的每個分頁沒有小於 12px 的文字、小於 24px 的控制項或低於對比下限的文字；U067-2 最小視窗 150% 時沒有東西超出視窗或卡片、沒有 overflow；U067-3 被拒的檔名格式會標示，Escape 還原。換回原本的 `ui.css` 會讓 U067-1 失敗。36 張 matrix 基準重新產生並逐張檢視；S016 改為在列的 `.row-actions` 中找通知按鈕。
- **Review。** Codex GPT-6.1 Sol 兩輪（約 3.5 分鐘）：第一輪 [1] 欄位與選單未量測、[2] 忽略 opacity；第二輪 [3] opacity 在第一個背景擁有者就停止累乘。三項都接受並在 gallery 量測與 spec 中修正；[3] 的修正沒有再經 review。未回報任何 App 回歸。

### 驗證

- 最終 App 原始碼上的 `pnpm acceptance:regression`：`pnpm check` 通過（typecheck、130 個檔案 1,741 項測試、建置）；背景套件 61 通過、1 失敗（S016 只讀列的直接子元素），修正測試後 S016 在同一份 `out/` 通過。review 修正 [1]–[3] 只改測試與腳本，之後 `settings-layout` 8/8 與最終 gallery（252 張，cleanup `groupGone`）都在同一份 `out/` 上執行。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4（`2026-10-06T15-13-33-893Z-player-acceptance`）；`pnpm start:app` 建置並簽署 bundle；`pnpm acceptance:settings-shortcut -- --observe --quit` 所有檢查通過（含視窗按鈕角落），⌘Q 後沒有殘留程序（`2026-10-06T15-14-41.736Z-settings-entry-nWWT6G`）。Claude 判讀 `settings-window.png`：視窗按鈕沒有壓到品牌與分頁，新字級在 Retina 密度下清楚可讀。

未執行：錄影、matrix、CPU、通知與網站檢查（純外觀變更）。不宣稱：VoiceOver、既有覆寫以外的強制色彩、Windows 繪製，以及 App 無法到達的 200% zoom。

## Plan 066 結案 — 2026-10-06

Plan 066 依維護者要求，把例行的 renderer 與 Electron 整合驗收移出桌面：`pnpm acceptance:regression` 現在是 `pnpm check` 加上背景 Playwright 套件（`pnpm test:ui`），不顯示視窗、不搶焦點、不送 OS 輸入、不註冊全域快捷鍵、不播放聲音、不送出通知，也不擷取任何畫面（[背景 UI 套件](../system-design/tooling.md#背景-ui-套件)）。每個舊案例都有 ledger ID 與去向（[遷移帳本](playwright-migration-066.md)）：設定 fixture 的 516 個案例有 513 個移到背景、3 個保留為原生；快捷鍵 fixture 的 57 個與播放器的 19 個都已移動，以 OS 為主張的部分有原生對應；沒有移除任何案例。App 原始碼沒有變更（前後 `out/` digest 都是 `a2965ca06e8e`）。

- **Host 與邊界。** 三個 Electron host（正式 main、以真實 model 與 library 為底的 view host、正式倒數覆蓋層）在邊界後執行：每個視窗都以隱藏、離屏、靜音的方式建立，顯示、聚焦、最小化、還原與全螢幕由虛擬狀態回答；Tray、通知、快捷鍵、對話框、shell、Dock、擷取與電源是會記錄的 adapter。teardown 稽核邊界、在 macOS 取樣視窗伺服器、正常結束，並從程序表確認這次啟動擁有的每個程序都已結束。
- **過程中的發現。** 離屏視窗的原生 `isVisible()` 會隨頁面變成 true，因此以視窗伺服器作為圍堵檢查；Playwright 的 CDP 按鍵到不了 Electron 的 `before-input-event`，因此 main 攔截的按鍵改用 `sendInputEvent`；Playwright 預設模擬淺色主題，曾讓深色基準畫成淺色；`BrowserWindow.getAllWindows()` 依建構子名稱辨識視窗。
- **原生對應。** `pnpm acceptance:settings-native`、`pnpm acceptance:shortcut-native` 與縮減後的 `pnpm acceptance:player`，可用 `pnpm acceptance:recipe -- native-ui` 一起執行。測試片段已簽入（tests/ui/media），套件與播放器 runner 都不需要 FFmpeg。
- **Review。** Codex GPT-6.1 Sol 進行兩輪 review。第一輪 8 項（Playwright 預設 `updateSnapshots` 下 CI 的基準、未回報的監督錯誤、只拍一次的程序快照、以資料夾路徑收編程序、未防護的真實對話框／通知／啟用／Tray、取消靜音只在最後檢查、App 自行結束時違規遺失、缺少 Electron 被報為失敗）與第二輪 3 項（註冊配方缺原生 runner、原生 fixture 少了真實註冊恢復、blocked 時沒有摘要）都已修正；演練 D08–D10 涵蓋圍堵與所有權修正。

### 驗證

- 沿用、未重新量測的基準：同日配方 `settings` 在 182.26 秒中佔用桌面 127.95 秒（設定 fixture 88.59 秒、快捷鍵 fixture 39.36 秒；`2026-10-06T05-27-52-850Z-recipe-settings`，revision `bcf744af`）。
- 最終 `pnpm acceptance:recipe -- settings` 在 240.67 秒內通過，沒有桌面階段：typecheck、130 個測試檔與 1,741 項測試、建置，以及 210.25 秒的 `pnpm test:ui` 53/53（`2026-10-06T10-20-38-990Z-recipe-settings`）。圍堵：54 次啟動、265 次視窗伺服器取樣，沒有視窗上螢幕、沒有成為前景、沒有違規、沒有強制清理、沒有殘留程序、沒有監督錯誤。`pnpm test:ui:drills` 通過 13 項，演練目標依設計略過。
- 視覺基準：36 張 macOS 26 圖，逐一看過兩種主題、語言與尺寸後採用；移除一張基準時會加註記且不寫入，換錯一張時會失敗，都已實測。
- 桌面回合（維護者回覆準備好之後）：`acceptance:settings-native` 4/4（`2026-10-06T10-17-51-998Z-settings-native`）；`acceptance:shortcut-native` 的 windows 階段第一次失敗，原因是縮減後的 fixture 把舊格式的錄影快捷鍵留在 ⌥⌘,，callback 因而開始一次錄影嘗試，邊界提供的空螢幕清單讓它以 `no_display` 結束，沒有擷取任何畫面；改為寫入 fixture 自己的按鍵後 9/9 通過，收尾完成（`2026-10-06T10-18-38-132Z-shortcut-native`）。`acceptance:player` 4/4：全螢幕蓋住 1920 × 1080 的螢幕，F 與 Escape 之後焦點回到設定視窗（`2026-10-06T10-18-46-321Z-player-acceptance`）。觀察中的背景執行（播放器、倒數、快捷鍵整合，6/6）在 29 次取樣中前景始終是 Google Chrome，抽查的截圖也沒有出現 RecordStuff 視窗；截圖含有維護者的螢幕內容，事後已刪除。

- 鎖定的工作階段（結案後依維護者要求）：維護者於當地時間 18:35:51 至 18:37:27 鎖定螢幕（96 秒，每秒經 `CGSSessionScreenIsLocked` 讀取），期間的完整背景執行仍在 3.5 分鐘內通過 53/53，涵蓋元件、倒數、播放器與截圖矩陣測試；該次以 `--reporter=line` 啟動，因此沒有寫出逐次啟動的摘要，但每個測試的 teardown 仍執行圍堵檢查。

- 結案後在 `plan-066-background-playwright` 分支的 Windows CI：套件第一次在 Windows 執行就發現一個 App bug。設定頁 40 px 的視窗拖曳條（`.titlebar`）在 macOS 不會蓋到內容，在 Windows 卻蓋住頁面最上方 40 px，因此窄視窗的分頁點不到；這也是 plan 066 之前 Windows 上三個位置測試失敗的原因。依維護者決定，拖曳條現在只在 macOS 繪製（`src/renderer/ui.css`），S116 檢查兩種版面；改回舊樣式時它會失敗。同一次執行的其他 Windows 失敗屬測試本身：Windows 無法回溯的檔案建立時間、平台的設定快捷鍵與訊息，以及被縮到工作區內的隱藏全螢幕視窗；現在都依平台判定。macOS CI 也找出兩個對 runner 的假設並已修正：比 1024 × 768 螢幕更大的視窗尺寸，以及在過渡動畫中量測的焦點環。
- `ce685175` 的最終 CI（[run 37454636049](https://github.com/EricTsai83/recordstuff/actions/runs/37454636049)）兩個 job 都通過：Windows 上 1,643 項單元測試（98 項略過）、背景套件 55/55（4.7 分鐘）、演練 11 項（D07、D10 與演練目標依設計略過）與安裝檔閘門；macOS 上同樣的套件與演練。

未執行：沒有螢幕的機器。不宣稱：Windows job 通過不代表 Windows 原生視窗、Tray 或擷取有證據。不宣稱：Windows UI job 通過不代表 Windows 原生視窗、Tray 或擷取有證據。

## Plan 068 結案 — 2026-10-06

Plan 068 完成維護者在 2026-10-06 要求的模組邊界工作；同日稍早 `src/main/` 與 `src/renderer/` 已依模組分成資料夾（[模組邊界](../system-design/repository.md#模組邊界)）。維護者要求立即執行，而不是排在 066 與 067 之後。開始時的 working tree 同時含有尚未 commit 的 React／shadcn 遷移，因此單憑 HEAD `bcf744af` 無法辨識它的輸入。

- **Action handler。** `handleAction` 的 29 個 case 原封不動地從 `src/main/index.ts` 的 closure 移到 `src/main/actions/actions.ts`（`createActionHandler`），協作者由外部傳入。`index.ts` 只保留一行宣告提升的轉交函式，從 1,033 行降到 871 行。`actions/` 是位於 `menus/` 與 `index.ts` 之間的新區域：handler 需要設定 store、設定視窗與 tray，若在 `app/` 用結構型別表達，會複製約 40 個成員。沒有任何 runner 錨點移動，`controlled-acceptance.test.ts` 與 `update-acceptance.test.ts` 也確認了這點。新的測試固定了結束閘門、各偏好設定的鎖、錄影中搶先按下的更新連結與拖曳。
- **設定頁。** 約 1,800 行的 `settings-app.tsx` 逐行拆成外框，加上 `tabs/library.tsx`、`tabs/preferences.tsx`、`tabs/shortcut-editor.tsx`、`tabs/failures.tsx` 與 `undo-toast.tsx`。錄影與一般分頁共用同一個依 model 繪製的元件，所以分頁模組是三個而不是四個。`settings-controller.ts` 變成 `controller/`（core、shortcut、results、library、player、info、toast）之上的單一 `export *` 介面。跨職責的寫入改成擁有該狀態的模組提供的小函式（`dismissLibraryOverlays`、`forgetMissingItems`、`clearFeedback`、`forgetInfo`、`playerHidden`）。頁面測試是透過入口驅動整個頁面，因此留在入口旁邊。
- **開發者工具。** `scripts/lib/` 的 83 個檔案分成 `runner/`、`acceptance/`、`verification/`、`audio/` 與 `release/`；入口檔留在頂層。`lineTime` 移到 `runner/log-reader.mts`，`command` 移到 `runner/processes.mts`，因此 `runner/` 與 `verification/` 不再匯入 `acceptance/`。網站的匯入與 `website.yml` 的路徑過濾跟著改到 `release/`。`pnpm audio:quality` 報告的實作 hash 改以新路徑（`./lib/audio/…`）為 key，因此 2026-10-06 之前的報告無法依 key 對應。
- **邊界。** `tests/source-boundaries.test.ts` 現在也涵蓋 `scripts/`：`src/` 不匯入 `scripts/`，`scripts/lib/` 各分組只朝一個方向匯入且不匯入入口檔，fixture 只匯入 `src/`、`scripts/lib/` 與其他 fixture。在兩棵樹各放一個刻意違規的匯入時，測試都會失敗。
- **搬移造成的缺陷。** 路徑改寫也改到了 update 與受控 runner 注入 `index.ts` 副本的 import 文字（`../../scripts/fixtures/…`），把它當成 runner 自己的 import。沒有單元測試會建置被修改的副本，所以只有 `runtime-inputs.test.ts` 中類似的字串失敗。三處都在任何 runner 執行前改回，兩個 runner 之後也都建置出修改後的副本並通過。

### 驗證

- 修改前 `pnpm typecheck` 與 `pnpm test` 通過（127 個測試檔、1,734 個測試），同一份建置的兩次離屏 `pnpm preview:ui` 圖庫逐像素相同（60/60），可作為確定性的基準。
- 拆分設定頁後，圖庫與基準逐像素相同（60/60）。
- 最後一次修改後，`pnpm acceptance:recipe -- settings` 通過：typecheck、130 個測試檔與 1,741 個測試、build、`pnpm test:ui` 13/13、設定 516/516 與快捷鍵整合（`2026-10-06T05-27-52-850Z-recipe-settings`）。每個 script 入口都能以 esbuild 打包且沒有無法解析的匯入（27/27），`pnpm site:check` 通過（5 個頁面、65 個內部參照、15 個外部網址）。
- 桌面驗收（維護者回覆準備好之後）：`pnpm acceptance` 在新建的 `pnpm start:app` bundle 上以全域快捷鍵錄了 10.4 秒，所有完整性檢查通過，倒數取消案例也通過（`2026-10-06T05-36-51-803Z-hotkey-acceptance`）。`pnpm acceptance:tray` 15 個通過、1 個未執行：macOS 先送達選單的 Start、後送達佇列中的快捷鍵，所以 stale-start 案例沒有可判定的狀態變化。`pnpm acceptance:updates` 每個案例都通過，包括實際錄影；`pnpm acceptance:controlled -- selftest` 8/8 通過；兩者都建置了被修改的副本。每一輪結束後都沒有殘留 RecordStuff 程序。
- 播放器：`pnpm acceptance:player` 起初 16:9 舞台案例在四次中失敗三次、進度條拖曳案例失敗一次；以當天早上的備份建置的重整前 working tree，同一個舞台案例三次中也失敗一次。兩者出問題的都是 fixture 而不是 App：影片 metadata 一到就量舞台，正好在 dialog 100 ms 的放大動畫期間（寬 826–851 px）；拖曳的移動事件固定間隔 100 ms 送出，機器忙時有一次拖曳停在 8 秒中的 4 秒。fixture 現在等 dialog 的動畫結束才量，並在前一次移動確實帶動影片後才送下一次，記錄每一步落在哪裡。之後連續五次都是 19/19：兩次開啟每次都量到 860 px，每次拖曳的每一步都落地（2.8、4、5.2、6 秒），滑桿全程保持拖曳狀態。
- `settings-library.test.ts` 在八次完整執行中失敗一次，失敗點是選單打開後的焦點位置。同時執行三份測試套件時六次全部重現：共用的 `menu` helper 在 Base UI 把選單標為打開時就返回，比 Base UI 把焦點移進選單早一幀。helper 現在也等選單取得焦點，這也消除了另一個在打開選單後立刻按 Escape 的測試中的同類競態；同樣的加壓下不再有任何斷言失敗。加壓時仍有部分頁面測試超過 5 秒時限；它們單獨執行只要 2.0–2.4 秒，因此沒有調高時限。

未執行：`check.yml` 的 Windows job，需要 push 或手動觸發；這次沒有修改打包。

## Plan 064 結案 — 2026-10-03

Plan 064 讓同一個 tag 在 macOS DMG 旁一起發布 Windows x64 安裝檔。2026-10-03 維護者先確認沒有 Windows 機器，接著決定仍然發布，Windows 只由 GitHub Actions 檢查，流程與 Mac 相同（[設計決策](../system-design/decisions.md)）。耐久規則見[發布自動化](../system-design/releases.md#發布契約)、[交付](../system-design/delivery.md)、[簽章](../system-design/signing.md)、[桌面設計](../system-design/desktop.md#錄影快捷鍵)與[工具](../system-design/tooling.md)。[1.2.0](releases/1.2.0.md) 是第一個雙平台正式版，之前先以 [1.2.0-rc.1](releases/1.2.0-rc.1.md) 演練。

- **決定。** 每位使用者的一鍵 NSIS（不需管理員權限、開始選單捷徑帶 AppUserModelID `com.ericts.record`、解除安裝保留使用者資料），只有 x64，不簽章，以 SHA256SUMS、`release-win32-x64.json` 與 build-provenance attestation 承擔完整性；Windows 失敗時整個 tag 失敗。除了 Electron 44 的 Windows 10 以外，不設 Windows 最低版本。
- **建置與 CI。** `electron-builder.yml` 新增 `win`／`nsis` 與 `build/icon.ico`；`pnpm dist:win` 建置安裝檔；`.gitattributes` 與依平台處理的測試讓 `pnpm check` 在 Windows 上通過；`check.yml` 新增 `windows-2025` 上的 `check-windows`（`pnpm check`、`pnpm dist:win`、`release.mts windows-smoke`）。
- **App。** Windows 上的更新檢查讀 GitHub latest release，並要求有 Windows 資產；`feedVersion` 與 `githubVersion` 接受的內容與已安裝的 macOS App 完全相同。Windows 文案改稱系統匣、電腦進入睡眠、預設播放裝置與 Ctrl；保留快捷鍵依平台而定，補上 Windows 編輯器的 `Control+Q` 能通過只列 Command 清單的缺口。macOS 文案不變。
- **發布工具與 workflow。** 1.1.1 之後的版本帶五個資產（DMG、安裝檔、SHA256SUMS 與兩份紀錄）；`build-windows` 與 `verify-published-windows` 在發布前後檢查安裝檔（每位使用者安裝、一筆 HKCU 登記、版本、x64、`NotSigned`、系統匣 ICO、捷徑、`app.asar` hash、乾淨解除安裝）。workflow 名為「Release」，屬於 `recordstuff-delivery` group。
- **網站與指南。** 下載頁、Help、Support、`resources/INSTALL.md`、兩份 README 與 release notes 都涵蓋 Windows、其 SmartScreen 步驟與只有 CI 的證據。

### 驗證

- CI：Check run 37040450544 在 `windows-2025` 上通過 `pnpm check`、`pnpm dist:win` 與 `windows-smoke` 閘門；run 37115590280（`5fae167`）、37118120707（`0fa2a0a`）與 37122157756（`c19d5eb`，即 1.2.0 原始碼）兩個 job 都通過。
- 預發布：[run 37045588224](https://github.com/EricTsai83/recordstuff/actions/runs/37045588224) 為兩個平台建置、公開並重驗 `v1.2.0-rc.1`；其紀錄讓 package.json 維持 1.1.1，穩定版 manifest 與 README 都未變動。
- 正式版：[run 37122799887](https://github.com/EricTsai83/recordstuff/actions/runs/37122799887) 建置並以 latest 公開 `v1.2.0`，通過 `verify-published` 與 `verify-published-windows`，紀錄寫回 main 並部署網站；網站的 `/release.json` 提供 1.2.0，下載頁同時連結 DMG 與安裝檔。
- 每次打 tag 前的 macOS：`pnpm acceptance` 與 `pnpm acceptance:playback` 在乾淨且已推送的原始碼上通過（[1.2.0-rc.1](releases/1.2.0-rc.1.md#打-tag-前的本機驗收)、[1.2.0](releases/1.2.0.md#打-tag-前的本機驗收)）。
- 已安裝的 macOS App：1.0.0 與 1.1.1 的更新解析器把線上 feed 與 GitHub release 讀為 1.2.0，已安裝的 1.0.0 記錄 `updates: available; remote 1.2.0`（[紀錄](releases/1.2.0.md#發布後已安裝-app-的更新檢查)）。設定仍是 version 3，歷史格式不變，因此 1.2.0 不需要資料 migration；1.2.0 原始碼讀取真實設定與九筆歷史紀錄時沒有任何警告。

未驗證：Windows 實機上的一切。step 3 的案例（SmartScreen、AppUserModelID、首次執行提示、系統匣 ICO 與點擊、含畫面與系統音訊的錄影、`MediaRecorder` MP4、`restrictOwnAudio`、通知與檔案總管顯示、設定、單一執行個體、睡眠、結束、保留資料重新安裝）都在每份發布紀錄中列為未測試，035 的 N17 系統匣矩陣在有 Windows 機器前仍未結案。未觀察已安裝 App 在「設定 → 一般」中的更新結果，也沒有執行已安裝的 1.1.1。在 1.2.0 之後執行比 1.1.0 更舊的 App，會刪掉它不認得的 `countdown` 與 `countdownSound` 設定並重設為預設值；1.1.0 與 1.1.1 會保留它們（只影響降版）。

依決定豁免：Windows 實機回合（step 3）、從公開網址在實機安裝（step 8）與 Windows 驗收 runner（step 9）。

## Plan 065 結案 — 2026-10-03

Plan 065 讓錄影快捷鍵與狀態列項目的左鍵點擊，可以在 start 持續一秒後取消它，和選單的「取消錄影」一樣。由 Claude 實作，Codex GPT-6.1 Sol review。在此之前，`Recorder.toggle()` 在 starting 期間忽略所有按鍵：因擷取請求未回應而等待 120 秒的 start 只能從選單取消，按鍵也不留 log；這段期間退出則要等擷取請求結束（曾經長達 286 秒）。耐久規則見[錄影設計](../system-design/recording.md#倒數)、[桌面設計](../system-design/desktop.md#錄影快捷鍵)、[驗收](../acceptance.md#依影響追加案例)與[工具](../system-design/tooling.md#tray-驗收)。

- **量測與決定。** 2026-09-12 至 2026-10-02 保留的 log 有 739 次 start：中位數 289 ms，第 95 百分位 396 ms。超過 1 秒的九次全部卡在準備階段（權限被拒、缺少音訊軌與舊的 8 秒時限造成 1.1–9.4 秒；擷取請求未回應時四次各 120 秒，其中一次讓退出等了 286 秒），沒有卡在開啟資料夾的，另有一次（2026-09-13）卡在 `record` 之後。917 次快捷鍵按壓中，一秒內的人工連按間隔為 290、365 與 393 ms；約 600 ms 的配對是 runner 在取消倒數；落在 starting 期間的按鍵只有 plan 063 的 runner，在 start 後 4–8 ms。維護者於 2026-10-03 決定：(a) 寬限一秒；(b) starting 的「取消錄影」標出快捷鍵；(c) 開啟資料夾或準備期間退出立即取消，納入本計畫。計畫中的長時間 start 受控重現改由下方的原生回合承擔，因為 log 已能把每次長時間 start 歸到所在階段。
- **Recorder。** starting 期間，從 session 請求起以 monotonic clock 計算，toggle 若晚於 `START_CANCEL_GRACE_MS`（1000 ms），就走「取消錄影」的路徑：開啟或準備中的嘗試會被取消，不留檔案、失敗項目或通知；已送出 `record` 時則變成「開始後停止」。寬限內的按鍵與 stopping 期間的按鍵都會被忽略並寫入 log。`shutdown()` 在延後的檢查中取消仍在開啟或準備的嘗試，因此同步的狀態變化不會再開啟第二次退出嘗試，標記仍保留作為後援；睡眠仍只標記。
- **Tray。** starting 選單的「取消錄影」帶已註冊的快捷鍵作為 accelerator，提示文字也標出它，中英文皆同，與倒數時一致。
- **工具。** 受控 build 新增 `prepare=hold` 故障與 `release prepare`，在 main 暫停 capture host 的 `prepared` 回覆。`pnpm acceptance:tray -- --long-start <run>` 操作該 build 真正的快捷鍵、狀態列項目與「結束」；命令通道 client 移到 `scripts/lib/acceptance/controlled-client.mts`。

### 驗證

環境：M1 Pro、macOS 26.6.2、Electron 44.3.0，主螢幕 BenQ GW2785TC 1920 × 1080，另有直立的 1080 × 1920 螢幕；HEAD `1657fdc` 加上未提交變更；桌面交接由維護者回覆「好了」確認。

- `pnpm check`：typecheck、99 個檔案的 1479 個測試與 build 通過。新增測試：start 後 8 與 999 ms 的按鍵被忽略並寫入 log；寬限後的按鍵在準備期間取消（保留「顯示上一段錄影」、沒有失敗、存檔或通知事件，遲到的 `prepared` 以過期 session 停止）與開啟期間取消（沒有擷取請求、沒有檔案）；倒數設為「關」時，`record` 後的按鍵變成「開始後停止」並存檔；stopping 期間被忽略的按鍵寫入 log；準備期間退出立即完成，而不是等 120 秒期限；開啟期間退出會等它持有的資料夾檢查；延後檢查前到達的 `prepared` 仍會取消；starting 選單的 accelerator 與提示文字（雙語，以及沒有註冊快捷鍵時）；以真正的 Recorder 測 `prepare=hold`；starting 選單規則；instrumentation anchor 與參數。
- 在新的 `pnpm start:app` bundle 上做錄影 smoke：`pnpm acceptance` 以 ⌘⇧1 開始與停止，存下 10.3 秒、1920 × 1080 的檔案並通過媒體驗證，數字未出現在錄影中，倒數取消案例通過；`pnpm acceptance:playback` 在 QuickTime 通過（未判定聽感）。
- 以 `pnpm open:app` 重新開啟同一 bundle，`pnpm acceptance:tray` 先 zh-TW 後 en：15 通過、1 not run（狀態改變後才選的「開始錄製」，與 063 相同）。該案例中快捷鍵在選單「開始錄製」後 4 ms 到達，現在會記錄 `toggle ignored while starting (4 ms after the start)`：也就是 plan 063 的案例，在原生環境中於寬限內被忽略。
- 對受控 build（`pnpm acceptance:controlled -- launch`）執行 `pnpm acceptance:tray -- --long-start`：14 秒內 3 個案例通過。相隔 0.2 秒的兩次按鍵中，第二次在 start 後 213 ms 被忽略；start 後約 2 秒的按鍵記錄 `cancelled (toggle) while preparing capture`；starting 選單與 model 那一行一致，「取消錄影」帶 ⇧⌘1，寬限後的左鍵點擊取消了 start；在 start 被暫停時選「結束 RecordStuff」記錄 `cancelled (quit) while preparing capture`，App 在 0.9 秒後結束。每個放行的回覆都以過期 session 停止；沒有出現檔案、通知或歷史項目。agent 自行檢視 starting 選單截圖，看到「Cancel recording」右側對齊 ⇧⌘1（Computer Use 式的觀察，不是腳本結果）。

未驗證：真實擷取請求未回應造成的長時間 start，任何 build 都無法隨時產生（暫停發生在 main，因此屬於受控狀態證據）；繁體中文的長時間 start 案例（文字由單元測試涵蓋）；淺色與深色選單列；寬限內以左鍵點擊而非快捷鍵按下（兩者呼叫同一個 `toggle`，由單元測試涵蓋）。

Review：Codex GPT-6.1 Sol pass 1（約 261 秒）沒有發現 Recorder regression，回報三項 runner finding，全部接受並修正：收尾在取消 start 之前就放行被暫停的 `prepared`，倒數設為「關」時會因此錄影（收尾現在先用「取消錄影」取消）；退出計時在 `select()` 之後才開始，而 `select()` 可能等到 App 結束才返回；點擊案例的寬限邊際從點擊尋找目標之前起算，而不是從 log 記錄的 start 起算。Pass 2（約 135 秒）沒有 findings，並確認三項修正正確。修正後的收尾路徑沒有在原生環境執行，因為沒有案例失敗。

收尾：每一輪後 RecordStuff 的所有程序都已結束，儲存的語言已改回繁體中文，受控 workspace 已移除並保留證據，`caffeinate` 讓螢幕保持喚醒。測試錄影（smoke 回合的 2026-10-03 00-31-16，tray 回合的 00-32-14 與 00-32-49）已依維護者要求刪除。依維護者要求 commit 到 main；沒有 push 或發布。

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
- **修復。** `node scripts/start-app.mjs --fixture-app` 把本 checkout 的 Electron.app 複製到每輪的暫存目錄，用 `pnpm start:app` 選取的 identity 簽署，再以同一個 `verifyBundle` 驗證。`verifyBundle` 改為可指定 identifier 與 hardened runtime，並明確拒絕 ad-hoc 簽章。一般模式保留原本的預設值、測試、階段計時與建置紀錄。runner 以 60 秒上限監督這段 setup，只啟動驗證過的副本。fixture 把通知事件附加到 `notification.jsonl`。[quit-dialog-acceptance.mts](../../../scripts/lib/acceptance/quit-dialog-acceptance.mts) 分開判斷五層：簽章 App、生命週期、送達事件、視覺與清理。exit 0 是自動化證據，視覺層維持待補。

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

- **計時。** [verification-timing.mts](../../../scripts/lib/runner/verification-timing.mts) 讓每個 leaf 指令在自己的程序群組執行，每個階段記錄 monotonic 耗時、結果、exit code 與清理狀態。`pnpm start:app` 透過 `RECORDSTUFF_TIMING_FILE` 回報自己的 preflight、build、package、verify 與 open，這些時間顯示在所屬階段內，不重複計入。報告也記錄 revision、未提交內容的摘要、runtime 輸入、`out/` 與 `app.asar` 的摘要，以及工具版本。Agent 協作空檔與桌面交接等待記為 unknown。
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
