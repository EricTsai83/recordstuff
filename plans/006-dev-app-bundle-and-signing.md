# 006 RecordStuff.app 本機自簽開發包與驗收

狀態：已完成（2026-09-14；依使用者調整的本機驗收範圍結案）
前置：004（已完成）
對應：001 §8、§9、§11、§12、§15、§17、§20

## 結案範圍

固定使用者的 `RecordStuff Dev` 自簽憑證，建立、驗證並安裝 macOS arm64 App／DMG，完成本機錄製與權限驗收。另一台 Mac／新帳號依使用者要求跳過；Apple Developer ID／公證屬選配 009，維持擱置。通知設定清單舊圖示依使用者決定不阻擋結案，沒有聲稱已修好。本輪依指示不再執行 Fable review，也未 commit／push／發布。

## 驗收結果

| 項目 | 本機實測結論 |
| --- | --- |
| 自簽與產物 | 固定憑證／bundle id，深度嚴格簽章與巢狀身分核對通過。DMG 唯讀掛載、內容、安裝說明及無私鑰檔驗證通過。 |
| 重建與更新 | 同憑證、同 identifier、同 /Applications 路徑，內容改變後 requirement 保留；更新後螢幕授權保留，音訊以新包實錄確認。 |
| 6(a) 通知與點擊 | 錯誤及存檔通知均由使用者看到；點通知開 Finder 已有使用者回報，多次 reveal requested 日誌，最後使用者確認成品存在且能播放。不把 API 日誌當成 Finder 一定到最前景的證明，前景呈現仍保留觀察。 |
| 6(b) Retina | 內建 Liquid Retina XDR 為主螢幕，原尺寸兩段 22.55／17.43 秒，log 與 MP4 均為實體 3456×2234；最新段有聲且全段可解碼。 |
| 6(c) 首次螢幕授權 | 僅 reset com.recordstuff.app ScreenCapture／AudioCapture 後，首次系統提示、設定授權與 App 重啟完成；新程序立即 granted。此輪沒有證明首次螢幕授權一律必須重啟。 |
| 6(d) 首次音訊拒絕 | 使用者明確確認提示出現且按不允許；no_audio_track 通知、回 idle、不留空檔均通過。 |
| 6(e) 同程序音訊恢復 | 使用者開啟音訊並選稍後，同 PID 18310 兩次仍 no_audio_track；重啟為 PID 29544 後錄出 15.34 秒有聲影片。此情境結論為需要重啟，不假定必須「免重啟」才算驗到。 |
| 6(f) 權限選單 | 使用者截圖確認灰字、開設定與重新啟動選項，實際操作後新程序取得螢幕權限。 |
| 6(g) 錄影中撤銷／系統重啟 | 00:13:51 收到 quit，App 先停止收尾；保留完整 47.594271 秒 MP4（不是殘檔），全段可解碼。新程序正確 needsPermission。 |
| 最後恢復可用 | 00:17:12 重啟後 granted；`2026-09-14 00-17-33.mp4` 12.653633 秒／45,041,905 bytes，H.264 1920×1080＋AAC 48 kHz 雙聲道，全段解碼無錯誤，音量 mean -30.2／peak -10.7 dB。00:17:47 通知點擊有 reveal 日誌，使用者確認正常播放。App 最後為 idle、權限已恢復。 |

## 實測修正

- 啟動期限拆成檔案準備 8 秒、系統擷取／授權請求 120 秒、開始後首 chunk 8 秒；選單提醒注意系統提示。120 秒是本專案保護值，不是 Apple／Cap 標準。
- MP4 關鍵影格間隔與 timeslice 均設名義 1000 ms，修正 Retina 原尺寸首片段過晚而 8 秒自停；同條件開發版修正前重現、修正後 20 秒成功，安裝版再兩次通過。實際輸出間隔並非硬性一秒保證。
- 使用原生 iconutil 產生完整尺寸 ICNS，修正 16／32 像素破圖；安裝版與 NSWorkspace 圖示查詢均正常。
- macOS 通知點擊後延至下一輪事件循環再 reveal，增加 requested／failed 診斷。前景排序不僅憑呼叫成功宣稱驗證。

## 產物與檢查

- 安裝版：`/Applications/RecordStuff.app`，bundle id `com.recordstuff.app`。
- DMG：`dist/local/RecordStuff-0.1.0-arm64-selfsigned.dmg`，126,081,923 bytes；旁附 `.sha256`。
- DMG SHA-256：`a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc`。
- app.asar SHA-256：`c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274`。
- 公開憑證 SHA-1：`01B373511530BBF287CA35E54C10A5F017AAD637`；私鑰仍留在使用者鑰匙圈。
- 最後程式變更後 `pnpm check`：13 個測試檔、211 測試、typecheck、build 通過（/tmp/recordstuff-006-keyframe-check.log）。之後僅補驗收文件，未再變更程式；文件收尾 `git diff --check` 通過。
- 證據：`~/Library/Logs/recordstuff/recordstuff.log` 與本頁歷史紀錄。使用者可能自行刪除測試影片，時長／解碼結果為驗收當時記錄。

## 保留的限制

通知設定清單仍可能顯示舊圖示：已取消含破圖舊 dev 包的登錄、重登安裝版並重啟通知服務，未清除資料庫、修改通知偏好或繞過 SIP。依使用者決定不阻擋結案，日後方便登出／重開機時再確認，不能稱為已修復。舊 dev 產物下次使用前應重建，避免重新登錄舊圖示。

原生通知受使用者的桌面／暫時／持續／共享顯示器與專注模式偏好控制。App 不改全域設定；Finder 是否每次到最前景不作保證。自簽未公證，不能把本機通過推論成另一台 Mac、乾淨帳號或 Windows 通過。下一個待執行計畫為 005 Windows 環境與驗收，本次未啟動。

## 歷史執行紀錄

以下保留當時的觀察、待辦、早期完成標準與 review；其中「待驗」「進行中」「未完成」等文字是當時狀態，最新範圍與結論以上方結案表為準。

### 最新結案範圍（使用者 2026-09-13 調整，優先於下方歷史要求）

使用者明確要求：跳過另一台 Mac 的驗收，完成這台 Mac 上可做的驗收後收尾；本輪不再做 Fable review。

- 跨機器傳輸／下載、另一台 Mac 安裝與另一個使用者帳號不列為 006 結案條件，不聲稱它們已通過。Apple Developer ID／公證維持選配 009 擱置。
- 已完成的本機證據沿用：自簽／DMG／安裝／圖示、同憑證同路徑更新後螢幕權限保留、權限復原及正確的執行路徑。
- 本輪完成安裝版可執行的錄製／系統音訊、停止存檔與重啟、通知、權限拒絕／復原、撤銷時殘檔等案例。不能出現的系統提示、缺少的實體顯示環境或無法操作的情況要記下實測限制，不以猜測寫成通過。
- 使用者已打開上蓋；system_profiler 確認內建 Liquid Retina XDR（3456×2234）上線且為主螢幕，兩台外接 BenQ 仍上線。接著以原尺寸實錄驗證 Retina，目前 1440p 設定不足以驗證原生像素。
- Computer Use 取得 /Applications/RecordStuff.app 仍 timeout，不能控制它的無視窗 tray；保留真實安裝版，不開放 packaged autorecord 或改動簽章來冒充 UI 驗收。僅需使用者代點錄影／系統提示，檔案與 log 分析由 Codex 完成。

### 錄製中撤銷權限／系統重啟通過（2026-09-14 00:14）

使用者按指示在錄影中關閉上方 ScreenCapture 並選系統「結束並重新打開」。00:13:03.572 recording；00:13:51.172 quit requested during recording; stopping first；00:13:51.192 saved，約 20 ms 完成停止收尾。產物不是殘檔，而是成功完成的 `2026-09-14 00-13-03.mp4`：47.594271 秒／33,888,162 bytes，H.264 1920×1080＋AAC 48 kHz 雙聲道，全段解碼無錯誤，音訊 mean -41.9／peak -14.3 dB。沒有把正常完成的 MP4 寫成 `.recording.mp4`。

00:13:54 新 PID 40919，路徑仍 /Applications/RecordStuff.app，立即 needsPermission，與已撤銷權限相符。6(g) 實測通過；最後待恢復螢幕權限、重啟後短錄並確認 Finder 選取成品，將 App 留在可用狀態後收尾。此時不再要求重跑已完成的拒絕、同程序或 Retina 測試。

### 首次音訊提示拒絕已通過（2026-09-14）

使用者明確補充「有跳出，我按了不允許」。結合本輪 AudioCapture scoped reset 成功、00:06 首次請求約 6.3 秒後 no_audio_track／idle、桌面通知截圖與沒有新增檔案，6(d) 首次音訊提示拒絕正式通過。下方較早紀錄的「待補確認」至此已補齊，無須重跑。

### 音訊重啟恢復已通過（2026-09-14 00:10）

原 PID 18310 在使用者已開啟音訊權限、選稍後後仍兩次 no_audio_track。重啟為 PID 29544（00:09:11）後，使用者短錄成功：00:10:02 recording、00:10:17 saved，`2026-09-14 00-10-01.mp4` 15.338229 秒／48,185,769 bytes，H.264 1920×1080＋AAC 48 kHz 雙聲道，整段解碼無錯誤，音訊 mean -25.4／peak -6.2 dB。6(e) 此次實測結論為「同程序不立即恢復，重啟後恢復」，已完成；並非必須證明無需重啟。使用者明確回覆成功存檔，通知點擊於 00:10:35 有 reveal requested。

接續最後錄製中撤銷 ScreenCapture → 系統結束並重新打開、保留檔解碼與授權復原測試。已另請使用者補確認 00:06 首次音訊提示確實彈出且選不允許，避免將已拒絕狀態誤當首次提示完整驗收。

### 同程序音訊權限恢復結果（2026-09-14 00:09）

使用者明確確認已開啟「僅限系統錄音」RecordStuff，並在系統重啟提示選「稍後」。原 PID 18310 於 00:07:39／00:07:53 兩次重試，均約 0.12 秒以 no_audio_track 回 idle，沒有重新 start／ready。因此本機此情境「同一程序啟用音訊後直接錄」不成立；這是實測結論，不再要求它必須無須重啟才算驗到。已確認 idle 後結束原程序並重開同一路徑安裝版，接著待使用者短錄驗證重啟恢復。首次音訊提示是否親自選不允許仍待明確回覆。

### 第二輪音訊拒絕結果（2026-09-14 00:06）

AudioCapture scoped reset 後首次錄製嘗試：00:06:01.963 starting → 00:06:08.289 no_audio_track／idle，沒有新增 MP4 或殘檔（資料夾最新仍 23:53:45）。使用者截圖確認「拿不到系統音訊，沒有開始錄製」桌面通知、通知中的新版圖示正常。App 仍為 PID 18310，未重啟；接續同程序開音訊後錄製。尚需使用者明確確認本輪有出現系統音訊提示且按不允許，以區分首次提示拒絕與已拒絕狀態；拒絕結果本身已確認。

### 第二輪螢幕授權與選單已通過（2026-09-14 00:05）

Scoped ScreenCapture／AudioCapture 重置後，00:03:01 安裝版進入 needsPermission。使用者截圖確認首次螢幕錄影提示（打開系統設定／拒絕），接著截圖確認 tray 的灰色「需要螢幕錄製權限」、「開啟系統設定」、「已經允許了？重新啟動 RecordStuff」。依指示從選單開設定、首次開啟螢幕權限、選稍後，再點 App 重啟選項；使用者回覆已重新啟動。00:04:52 log 新 start／ready，立即 granted／2 screens，PID 18310，路徑仍 /Applications/RecordStuff.app。6(c) 首次螢幕授權及 6(f) 權限選單／重啟通過；尚未證明首次授權一定必須重啟（本輪未等待同程序狀態變化）。下方音訊尚待首次請求與拒絕／同程序復原測試。

### 使用者調整與第二輪授權驗收開始（2026-09-14）

使用者同意通知設定清單舊圖示暫不追查、不阻擋結案；記為未確認解決，不標通過。接續兩輪授權／撤銷測試。

確認 /Applications 安裝版 bundle id com.recordstuff.app、目前 idle 後結束 PID 68117；tccutil reset ScreenCapture com.recordstuff.app 與 reset AudioCapture com.recordstuff.app 均成功，沒有 reset All、沒有重置通知或其他 App。以已驗證的原安裝包重新啟動，待使用者檢查缺權限選單、開啟設定、首次授予螢幕權限與 App 重啟；系統音訊先保持未授權。此輪尚未完成。

### 通知清單舊圖示仍待確認（2026-09-14）

使用者再次截圖確認：取消舊 dev 登錄及重開設定後仍是破圖，此修正未解決通知清單顯示。後續已重啟本帳號 usernoted 與 NotificationCenter（新 PID 3343／3342），沒有刪資料庫或修改通知偏好。圖示服務 SIGTERM 後 PID 未變；launchctl kickstart 被 SIP 拒絕，未繞過。通知資料庫唯讀檢查也被 macOS 拒絕，未嘗試繞過或修改。

透過 NSWorkspace.icon(forFile:) 讀 /Applications/RecordStuff.app 的系統圖示並存到 /tmp/recordstuff-system-icon.png，實際查看為正常新版紅色錄影圖示。這確認安裝包及系統檔案圖示查詢正常，通知設定清單仍可能保留獨立快取；不能當成 UI 已修好。通知服務重啟後的畫面待使用者確認；若仍舊，保留此限制，日後方便登出／重開機再驗，不能擅自重新啟動整台 Mac 或清除所有通知資料。

### 通知設定清單舊圖示／重複 App 登錄（2026-09-13 23:57）

使用者截圖確認通知設定清單仍顯示損壞圖示，重啟系統設定無效。LaunchServices 同時登錄 dist/dev/mac-arm64/RecordStuff.app 與 /Applications/RecordStuff.app，兩者 bundle id 相同；舊 dev 的 ICNS SHA-256 為 cc33adb…，安裝版為已修好的 12e04df…。

已僅對舊 dev 執行 lsregister -u，對安裝版執行 -f，再重啟系統設定；重查 LaunchServices 只剩 /Applications 的 com.recordstuff.app。未刪 App、未重置 TCC、未改通知偏好、Computer Use 保持關閉。通知頁圖示是否更新待使用者確認，不能只憑登錄修正宣稱 UI 已修好。舊 dev 包再打開會重新登錄，日後使用前須以 pnpm start:app 重建新版，而非直接 open:app 啟動舊產物。

### 安裝版 Retina 驗收通過／桌面通知設定（2026-09-13 23:49）

- 新安裝版兩次手動錄製成功：23:47:37 開始的影片 22.548708 秒；23:48:26 開始的影片 17.428875 秒、13,652,608 bytes。兩段 log 與 MP4 都是 3456×2234，首 chunk 約 1.18／1.22 秒，正常停止存檔，8 秒自停已不再重現。第二段整段解碼無錯誤，AAC 48 kHz 雙聲道，音量 mean -23.7／peak -4.6 dB。6(b) Retina 通過，可關上上蓋繼續其餘外接螢幕測試；重建後音訊權限亦以實錄確認保留。
- 兩次通知點擊都有 reveal requested 日誌（23:48:08／23:48:50）。使用者回報「確實有出現」，另詢問通知是否只在通知中心；Finder 是否已到最前方／選中檔案尚未明確逐項確認，不只靠 API 呼叫日誌寫成通過。
- Computer Use 實際讀取：RecordStuff 允許通知 on、桌面／通知中心／鎖定螢幕均勾選、提示樣式「暫時」；全域「在鏡像輸出或共享顯示器時」為「關閉通知」。通知具備桌面提示設定，並非僅通知中心模式；共享狀態抑制是待驗假設，不能只憑設定判定唯一原因。未改動全域通知偏好。

### Retina 原尺寸 8 秒自動停止修正（2026-09-13 23:44）

- 安裝版 23:41:42／23:42:04 兩次錄製，均已回報 3456×2234 並進入 recording，但 8 秒後未收到首 chunk，main 以 capture_start_failed 中止；隨後停止 flush 才收到 stale chunk。無使用者停止／撤銷權限證據。23:43:12 以既有開發版 autorecord、相同原尺寸／60 fps 設定重現同一失敗；此開發版測試不是安裝版 UI 驗收。
- [Chromium 官方變更說明](https://chromium.googlesource.com/chromium/src/+/357dfa363d81c1f5f77a77f4f04d56de3a70eec1)：MP4 在 IDR 關鍵影格才有機會 flush，需將 videoKeyFrameIntervalDuration 與 timeslice 對齊。capture host 因此新增名義 1000 ms 關鍵影格間隔；8 秒首 chunk 保護與 120 秒授權請求期限維持。main 補首 chunk bytes 日誌，移除「任何時刻最多丟一秒」的錯誤保證。
- 修正後開發版實測 23:43:52 recording，23:43:53.514 首 chunk（約 1.31 秒）；之後檔案持續增長，依測試設定 20 秒正常停止。成品 `2026-09-13 23-43-51.mp4`：19.98825 秒、12,879,856 bytes、H.264 3456×2234、AAC 48 kHz 雙聲道，整段解碼無錯誤，音訊 mean -24.5／peak -4.8 dB；ffprobe 確認 16 個關鍵影格，間隔約 1.0–1.8 秒，符合名義間隔而非硬性一秒保證。此時主螢幕內容變動少，平均 13.67 fps，不將 requested 60 說成成品固定 60 fps。
- pnpm check 211 測試、typecheck／build 通過；新 DMG 通過唯讀掛載、內容與深度簽章驗證，已更新 /Applications；23:46:58 啟動即 granted／3 screens，指定簽章 requirement 保留。通知／安裝版 UI 仍待重驗。本輪沒有降低解析度／幀率設定或延長逾時。

- 最新關鍵影格修正版 DMG：126081923 bytes；SHA-256 `a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc`；app.asar SHA-256 `c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274`。

### 最後一輪本機驗收清單（2026-09-13）

使用者要求列清剩餘項目並完成結案。已通過的自簽／DMG／安裝更新、圖示、一般有聲錄製／存檔與音訊拒絕不重跑；依下列順序合併原七項，以本表追蹤最新結果。

| 輪次 | 待完成項目 | 證據與結案方式 |
| --- | --- | --- |
| 1 | 原尺寸 Retina ＋新版通知點擊（6a、6b） | Retina 已通過：兩段 22.55／17.43 秒的安裝版原尺寸有聲錄影，3456×2234，最新段完整可解碼；已可關上上蓋。最新內容更新後音訊權限亦保留。通知點擊已觸發 reveal，Finder 前景／選取與桌面提示呈現仍待明確確認。 |
| 2 | 乾淨授權、權限選單、首次音訊拒絕、同程序恢復（6c、6d、6e、6f，含 6a 權限通知） | 固定目前安裝包，只重置 com.recordstuff.app 的相關授權；確認 needsPermission 灰字、開設定與 App 自己的重啟選項。完整記錄首次提示拒絕結果，再試同一程序開音訊後錄製；若系統要求／實際必須重啟，記錄該限制並驗證復原，不強求「不需重啟」的預設答案。不能重現的提示如實記為限制。 |
| 3 | 錄製中撤銷權限／系統重啟與復原（6g） | 開始錄製後撤銷 RecordStuff 螢幕錄製權限，選系統「結束並重新打開」，核對檔案保留及能否解碼；最後恢復權限並短錄，將 App 留在可用狀態。 |

上述有具體結論後更新 006 狀態、索引／工作紀錄、README、001 對應驗收與規格，完成文件與必要檢查。另一台 Mac／新帳號依使用者要求不做；Developer ID／公證屬擱置 009；本輪不做 Fable review。不把目前未完成的項目提前標成通過。

### 本機授權等待修正與 Cap 參考（2026-09-13）

- 23:22:09 安裝版開始擷取，同時出現系統音訊與直接取用畫面／音訊提示；23:22:17 原 8 秒啟動期限先到而失敗。使用者已按畫面允許、音訊不允許，設定頁確認 RecordStuff 的「僅限系統錄音」關閉；此輪尚不能當作 `no_audio_track` 驗收通過。
- 分開三個期限：檔案準備 8 秒、擷取請求（含系統互動）120 秒、host 回報 started 後首筆影像資料 8 秒；選單顯示「啟動中，請留意系統權限提示…」。120 秒是本專案暫定的等待上限，不是 Apple 或 Cap 的規定；完成後立即繼續，不固定等待兩分鐘。
- 參考 [Cap permission 實作](https://github.com/CapSoftware/Cap/blob/17e17902691ca499de9e44b0dd7a19d8c4b630a8/apps/desktop/src-tauri/src/permissions.rs)：授權請求後最多 10 次、每次間隔 200 ms 重查（查詢本身另耗時），仍未允許則視權限種類開設定；ScreenCaptureKit 查詢本身限 4 秒、重試間隔 5 秒。這些不是要求使用者 2／4 秒內答覆。前端 [requestAndVerifyPermission](https://github.com/CapSoftware/Cap/blob/17e17902691ca499de9e44b0dd7a19d8c4b630a8/apps/desktop/src/utils/os-permissions.ts) 也將請求、驗證、開設定分開，沒有設定 120 秒的人機互動期限。
- `pnpm check`：13 個測試檔、210 個測試通過，typecheck／build 成功。新 DMG 已通過唯讀掛載、內容及深度簽章驗證，並更新 `/Applications/RecordStuff.app`。23:30:43 啟動即 granted／2 screens，未重置 TCC、designated requirement 相同。錄製實測仍待使用者點 tray；不再執行 Fable review。
- 本輪 DMG：126,082,001 bytes；SHA-256 `bae6a3ae886b9f03529ad311662c756f91d5d1d50f71d13ca5ad85cd4dd30390`；app.asar SHA-256 `c0513294448572b129e3570a26316eeec0de7c5c23c8026bc4b14048ad81ae1f`。系統設定「通知」列 RecordStuff 關閉，已請使用者啟用以便實測；Retina 等待使用者打開上蓋。

### 安裝版音訊拒絕實測（2026-09-13 23:32）

- 使用者先前拒絕系統音訊，並已開啟 RecordStuff 通知。23:31:50 與 23:32:05 兩次 tray 啟動分別約 324／130 ms 回到 idle，log 均為 `no_audio_track`（系統音訊軌已結束）。沒有新增 MP4 或 `.recording.mp4`，資料夾最新錄影仍為 17:59；拒絕後不開始錄製、不留空檔通過。
- 使用者截圖確認 RecordStuff 錯誤通知實際顯示、圖示正常。此證據只涵蓋錯誤通知；成功存檔通知及點擊開 Finder 仍待驗。
- 主程序 PID 4070，23:30:43 ready；接著請使用者保持同一程序，在「僅限系統錄音」啟用 RecordStuff 後錄製，以驗證同 process 權限復原。首次提示那一輪曾被舊 8 秒期限中斷，不把本次已拒絕狀態測試寫成首次提示完整通過。

### 安裝版成功錄製與 Finder 焦點（2026-09-13 23:34）

- 音訊啟用後 23:33:33 出現新的 start／ready，因此此輪是「重啟後權限復原成功」，不是同 process 復原；先前 PID 4070 已換成 11924。不得將步驟 6(e) 寫成通過。
- `2026-09-13 23-33-36.mp4`：23:33:36 開始、23:33:54 停止，18.0959 秒／61,861,988 bytes，H.264 1920×1080（平均約 53.57 fps）＋AAC 48 kHz 雙聲道。整段 decode 成功；音訊 mean -24.2 dB、peak -2.3 dB，非空白聲軌。ffmpeg null 輸出須用 `-fps_mode passthrough -enc_time_base:v 1:1000000`，避免 null encoder 粗時間基準產生重複 DTS 警告；此設定下無解碼錯誤。
- 使用者確認停止後 REC 消失，存檔通知點擊會開 Finder，但 Finder 沒有到最前方。成功通知顯示與開啟 Finder 通過；焦點體驗仍待修正驗證。
- 查 Electron v44.3.0 `notification_center_delegate.mm`：通知 click callback 先執行，completionHandler 在其後；`platform_util_mac.mm` 用 NSWorkspace selectFile。焦點競爭是目前假設，未當成已證實根因。macOS 通知顯示檔案改用 setImmediate 延後至 callback 返回後，新增 reveal requested／failed 診斷；沒有固定延遲或強行操作其他 App 的腳本。211 個測試、typecheck／build 通過。新版完成 DMG 內容／深度簽章驗證，更新到 /Applications，23:38:52 啟動即 granted／3 screens，designated requirement 保留。Finder 前景效果待使用者點通知實測。
- Finder 調整版 DMG：126081236 bytes，SHA-256 `a935ba06bbac0099d68aaba6d3d98ff2e54ed11ba764a53a8835fb2e31897168`；app.asar SHA-256 `c8e029a5fe38d4f2c0127efda670aeb69d8a2a6a16706f3579e3c57ea58823c0`。

### 目標與範圍

2026-09-13 使用者確認沒有付費 Apple Developer Program，並同意改按「本機自簽開發憑證」規劃。建立自己的固定 Code Signing 憑證與私鑰，每次使用同一身分簽 RecordStuff.app，支援本機開發與打包給少量使用者測試。無須申請 Apple 會員，不申請 Developer ID，也不送 Apple 公證。

付費 Developer ID、公證與免手動例外的 Gatekeeper 發行驗收移至 [009 選配的 Apple 認證發行](009-apple-notarized-distribution.md)，不再阻擋 006。原七項錄製／權限／通知驗收仍由 006 持有，不因改用自簽而豁免；自簽不保證通知中心接受，也不保證重建後 TCC 一定保留，必須實測。

**目前已接入本機自簽流程**：使用者實際建立的憑證名稱為 `RecordStuff Dev`（原規劃名稱 `RecordStuff Local Development` 不再要求）。`start:app`、`open:app`、`dist:mac:local` 共用公開指紋核對，不再要求 `Signature=adhoc`；真機與跨機器驗收仍未結案。

### 已確認的交付設計（2026-09-13）

- 使用者確認直接實作免費流程：開發者用 `RecordStuff Dev` 簽 App，再將 App 包成 DMG；接收者不安裝憑證，不接觸私鑰，無須 Apple 會員或與 Google 互動。
- 新增本機專用 `electron-builder.local.yml`，沿用共用 app 設定，DMG 本身不簽章，檔名包含架構與 `selfsigned`。DMG 附 `resources/安裝說明.txt`，說明拖到 Applications、首次人工允許、螢幕／音訊權限、重啟與故障回報；不要求停用全域保護。
- 另一台 Mac／新帳號與內建 Retina 環境仍未提供；保留驗收待辦，不將本機成品驗證冒充跨機器成功。

### 為什麼

`pnpm start` 使用共用的 `com.github.Electron`；RecordStuff.app 使用 `com.recordstuff.app`，可驗證自己的 Info.plist、資源與權限身分。目前 ad-hoc 的 designated requirement 使用 cdhash，內容變更後可能使授權失效。目標是固定憑證與 bundle identifier，驗證產物身分是否能跨重建保持，並如實記錄 macOS 的行為。

自簽憑證只代表我們自己的簽章身分，不是 Apple 為開發者背書。分享產物不得包含私鑰，也不要求收件者安裝根憑證或停用 Gatekeeper；應清楚說明未公證與 macOS 可能要求手動「仍要打開」。

### 步驟與驗收要求

1. **建立一次、持續重用憑證**。在登入鑰匙圈建立 `RecordStuff Dev`，類型為自簽的 Code Signing 憑證。記錄公開的憑證指紋、有效期與可簽章 identity；確認私鑰配對。憑證／私鑰不進 repo；需要備份時由使用者保管加密匯出檔。信任設定只處理本機程式碼簽章所需用途，不設成所有用途一律信任。之後不在每次 build 自動產生新憑證；缺少、過期或不唯一時明確失敗。
2. **改造開發啟動與簽章驗證**。保留 `pnpm start:app`、Node arm64／x64 路徑、`dist/dev`、共用 lock 的程序檢查、清除 `ELECTRON_RUN_AS_NODE` 與失敗不啟動的行為。已增加本機 identity 設定（`RECORDSTUFF_SIGN_IDENTITY`，預設精確名稱 `RecordStuff Dev`；可指定完整 SHA-1 指紋，非機密；名稱仍須唯一，builder 最後以名稱簽署，不以指紋承諾解決重名）；build 前解析為唯一憑證，核對指定指紋，禁止自動 fallback 到 ad-hoc 或其他憑證。略過公證，檢查現有 hardened runtime 與 entitlements；若 builder 對非 Apple 憑證需另設選項，以 v26 實際行為驗證，不能單純關掉驗證。將現有「必須 ad-hoc」改為「深度嚴格驗證通過且外層簽章憑證符合選定指紋」，檢查必要 helper 的簽章與 identifier；保留 Electron 巢狀簽章流程，不以 `codesign --deep --sign` 粗略覆寫。
3. **驗證重建身分與授權持續性**。第一次切換 ad-hoc → 自簽時建立新的授權基線，只重置已核對的 `com.recordstuff.app`。保存 A 包的 `codesign -d -r-`、公開憑證指紋、bundle id、版本與授權結果；確實修改 build 內容後製作 B 包，保持同一憑證與 identifier。比較兩包 requirement、有效簽章與身份，實測 B 啟動是否仍有螢幕／系統音訊權限。此案例中不可先重置權限，否則無法驗證持續性。若失效，記錄原因與復原流程，不宣稱自簽必然解決 TCC。憑證到期／換鑰匙視為身分變更另行處理。
4. **開發包與錄製實測**。log／設定仍使用小寫 `recordstuff`，與 Electron.app 共用；不隱含搬移或隔離。核對 `CFBundleIdentifier=com.recordstuff.app`、`LSUIElement`、螢幕／音訊 usage description，實際確認 Dock、tray、選單與重新啟動。用自簽包完成下列七項驗收。各案例固定產物，只有步驟 3 的 A/B 案例刻意重建；拒絕、復原與第一次授權分別記錄。
5. **少量分享用的自簽 DMG**。已新增明確的本機自簽打包指令 `pnpm dist:mac:local`，共用選定憑證與簽章檢查、略過公證，輸出 `dist/local`，避免與開發包／未來 Apple 發行產物混淆。README 標示「自簽、未公證」，提供 macOS 手動允許該 app 的操作，不要求安裝簽章私鑰／根憑證或關閉全域保護。本輪只驗本機產物與安裝；跨機器傳輸／首次啟動及新帳號依使用者最新要求跳過，不阻擋 006，也不宣稱外部接收端已測通。自簽不以 `spctl accepted` 為通過條件。
6. **004／003 移交的驗收**（004 於 2026-09-13 結案，這七項在那裡都沒有結論，全部由這裡負責，每項都要寫下實際觀察，不能只標「應該沒問題」）：
   - (a) **通知顯示與點擊**——開發版（ad-hoc、無 TeamIdentifier）2026-09-13 存檔後完全沒有顯示通知，診斷 log 是 `notification: failed (無法完成作業。（UNErrorDomain錯誤1 。）)`，代表通知中心拒收。本機自簽版要實測這行消失、「已儲存 …」通知會出現、點下去 Finder 會選到該檔；未授權時的「需要螢幕錄製權限」通知是否顯示同樣在這裡看。
   - (b) **HiDPI**——把內建 Retina 螢幕設為主螢幕錄一段，比對 `capture:` log 的 `track size=` 與成品尺寸，補完 001 §17 第 7 題。
   - (c) **乾淨 TCC 第一次授權的完整流程**（004 步驟 2–6 逐字）在 RecordStuff 名下重跑一次，包含 004 未驗到的「第一次授予螢幕錄製」這條路徑（004 只走到「開→關→開」的復原路徑）。
   - (d) **第一次系統音訊提示按「拒絕」**——預期 `no_audio_track` 通知且 `~/Movies/RecordStuff` 不留檔案。004 兩次嘗試（17:31、17:59）都沒能讓提示出現，原因未查明；這裡要記下提示到底有沒有彈、彈了按拒絕之後實際發生什麼。
   - (e) **同一個 process 開啟音訊權限後直接錄**——在設定頁打開「僅系統音訊錄製」，不重啟 app 直接點錄製，確認是否真的不需重啟。004 那次是開關打開後才啟動的 process，等於沒測到。
   - (f) **修正後的權限選單實地確認**——`needsPermission` 的第一行灰字、「開啟系統設定」、以及新增的「已經允許了？重新啟動 RecordStuff」按下去真的重啟並進 `idle`。目前只有單元測試涵蓋，沒在真機逐項點過。
   - (g) **錄製中撤銷螢幕權限選「結束並重新打開」**這條分支——app 被終止後殘檔還在不在、能不能播。004 只驗了「稍後」那條。

   重跑 TCC 重置時，參數要用這個 .app 實際的 bundle id（`com.recordstuff.app`），先確認過身分再重置；不要用不帶 bundle id 的 `tccutil reset AudioCapture` 或 `tccutil reset All`，那會波及其他 app。也不要預設「重置完提示就會彈」——004 針對 `com.github.Electron` 的兩次重置之後都沒等到音訊提示。
7. **檢查與文件收尾**。新增 identity 缺失／不唯一／過期／選錯、非預期簽章拒絕啟動、簽章失敗、略過公證、原有程序攔截與空白路徑案例；`pnpm check` 通過。同步本頁、plans 索引、README、001 §15／§20。Windows 錄製與安裝驗收仍由 005 持有；Windows 憑證與正式 Apple 發行不納入這次本機 macOS 工作。

### 完成標準

- 固定自簽憑證已建立並接入啟動／DMG 指令；身分核對與錯誤分支通過，無隱含 fallback，私鑰未進 repo／分享包。
- A/B 內容變更後的指定簽章要求與 TCC 持續性有具體結果；若不能保留，記錄可重現原因與可用復原流程，不把它寫成已解決。
- 七項 6(a)–(g) 仍須逐項有具體結論（保留原標準：通知能顯示／點 Finder，或查明失敗原因；HiDPI、第一次授權、音訊拒絕、同 process 復原、選單、撤銷後殘檔均實測）。「未重現」不算通過，仍阻擋 006，除非使用者另行調整範圍。
- 自簽 DMG 已在另一台 Mac 走過安裝、必要的單一 app 人工例外、權限與有聲錄製；不聲稱 Apple 認證或無提示安裝。
- 006 完成不等於 001 全部或兩平台驗收完成；005 仍是兩平台版本的前置。009 是選配，不阻擋自簽試用版。

### 2026-09-13 本機自簽實作紀錄

- 憑證 `RecordStuff Dev` 已由使用者建立並設定信任；`security find-identity -v -p codesigning` 列出唯一有效 identity。SHA-1 `01B373511530BBF287CA35E54C10A5F017AAD637`，有效期 2026-09-13 至 2036-09-10。此為公開指紋，私鑰未匯出。
- X509 驗證：subject 與 issuer 相同、自身公鑰可驗證簽章、Code Signing EKU；`CA=false`。程式以自身簽章核實 self-signed，不用要求 CA/keyCertSign 權限的 `checkIssued` 排除合法自簽 leaf。
- `scripts/start-app.mjs` 已接入唯一憑證解析、期限檢查、SHA-1 pin、成品與巢狀 app/framework 憑證核對、bundle id／runtime 檢查，並停用 timestamp／notarize／publish。`codesign --extract-certificates=<prefix>` 抽取的是公開憑證，暫存檔檢查後清除；不讀或匯出私鑰。
- 新增 `pnpm open:app` 只驗證重開既有 `dist/dev` app，方便固定產物驗收；`pnpm dist:mac:local` 在已核對的 app 上產 DMG 到 `dist/local`，不啟動 app。
- 測試使用測試期間生成的非 CA 自簽 Code Signing 憑證與替身工具，隔離在 tmp 目錄，不接觸使用者鑰匙圈或專案 dist；涵蓋選擇重名／缺少／空白／期限、外層或 helper 簽錯、ad-hoc／runtime／bundle id／損壞簽章拒絕、命令失敗、憑證環境隔離、僅驗證重開與 DMG 順序。測試 Node 路徑與專案路徑都含空白。

- 本機 A 包已完成自簽：`pnpm open:app` 對 9 個 bundle 全部驗證通過並啟動。外層 designated requirement 為 `identifier "com.recordstuff.app" and certificate leaf = H"01b373511530bbf287ca35e54c10a5f017aad637"`，不再只包含 ad-hoc cdhash；但這不是 TCC 持續性已通過的證據。
- 初次自簽接入時 `pnpm check` 通過 13 個測試檔／204 個測試、typecheck 與 build。初次成品檢查遇到 codesign optional argument 與 CodeDirectory 輸出格式差異，已修正並用真實成品驗證。
- main 啟動 log 增加 `packaged` 與 `executable`，用於辨識共用 log 來自 Electron.app、dist/dev 或 dist/local；這也是接下來 B 包的真實內容變更，不能只用重簽相同內容冒充 A/B 測試。

#### 授權診斷與打包 follow-up

- 19:28:07 曾出現 granted／2 screens，但 `packaged false` 且 executable 指向 pnpm 的 Electron，不能當作自簽包通過。
- 19:30:50 自簽 app 的 `tccd` 紀錄明確顯示 ScreenCapture 的舊 requirement `cdhash H"b02aed00a11b8046879d7e831beb056350e927de"` 不符目前的 certificate leaf requirement。使用者切換開關後仍失敗；已執行 `tccutil reset ScreenCapture com.recordstuff.app` 成功，後續授權尚未完成，不重複要求切換。
- 保留 A 開發包，app.asar SHA-256 `7cfa78b239ec53351a041421609f1fac3431ec98fe82b6326bcb2861273db732`。A/B 權限持續性須先有 A 授權基線，目前未通過。
- 修正程序保護：除 node_modules 的 symlink 路徑外，也檢查 realpath，避免漏掉 pnpm 實際啟動的 Electron。新增對應 CLI 回歸案例；此時完整檢查為 205 個測試。

#### 免費 DMG 成品驗證（2026-09-13）

- `pnpm check`：13 個測試檔、208 個測試、typecheck 與 build 通過（包含 macOS 原生 pgrep 的 POSIX ERE 語法檢查）。
- `pnpm dist:mac:local` 成功：`dist/local/RecordStuff-0.1.0-arm64-selfsigned.dmg`，125,976,937 bytes；只供 Apple 晶片 Mac。SHA-256 `8b5caebf6625f0a6d918e4476ae2d438b035e3e933c2aad9dd434b60c8965aa4`，同目錄另有 `.sha256` 核對檔（本次驗收產生）。
- 打包前 9 個 bundle 憑證核對通過；`hdiutil verify` checksum VALID。唯讀掛載後確認 RecordStuff.app、Applications → /Applications、安裝說明與來源一致，沒有獨立的憑證／私鑰匯出檔；掛載 App 的 deep strict 簽章驗證與指定 certificate leaf requirement 通過，Info.plist／app.asar 與原始 local 包一致；已卸載。
- local 包 app.asar SHA-256 `18effcc087a4a15e296612933c8d8f8655d663545c007abd32c79514c5d5d0dc`，與 A 開發包不同但指定簽章 requirement 相同。這只證明內容變更後身分一致，尚未測同路徑替換後 TCC 持續性。
- DMG 已建立並完成本機靜態驗證，未上傳／發送給其他人。跨 Mac 安裝、Gatekeeper 人工允許、七項真機驗收仍待完成，006 保持進行中。

#### 本機自簽與免費 DMG 的 Claude Fable 5.1 review

Pass 1（high、read-only，約 8 分鐘；輸出 `/tmp/recordstuff-selfsign-fable-review-1.log`）：

1. Medium，`scripts/start-app.mjs:125`：builder 以 SHA-1 選擇卻以名稱簽署，重名用指紋仍會失敗。接受；從安裝的 macPackager.js:334 證實，新增名稱唯一性檢查、改文件與重名測試，禁止此情況進入 build。
2. Low，`scripts/start-app.mjs:105`：designated requirement 只印出未核對。接受；明確要求固定 identifier + certificate leaf SHA-1，錯誤 requirement 不啟動／不交付，補回歸案例。
3. Low，`scripts/start-app.mjs:31`：Date.parse 若產生 NaN 可能放行。拒絕、未修改；目前輸入來自成功解析的原生 X509Certificate 的有效日期字串，reviewer 亦註明目前格式可解析，沒有可重現的壞輸入；不加入假設性未來格式相容分支。
4. Low，`scripts/start-app.test.ts:14`：非自簽與公開憑證不匹配分支未覆蓋。接受；新增臨時 CA／issued Code Signing leaf，以及錯誤 PEM 對照案例，均必須在打包前失敗。
5. Low，`electron-builder.local.yml`（未提供行號）：手動分享目錄含更新 metadata／blockmap。接受；`dmg.writeUpdateInfo: false`，清除本輪產生的舊更新檔後重製成品。
6. Low，`plans/README.md` 與 006（未提供完整行號）：工作紀錄格式與測試數混淆。接受表格整理；204 明確標為初次自簽歷史結果，後續 205 與 review 修正後的結果分開記錄。

Reviewer 未掛載 DMG；Codex 已實際唯讀掛載確認安裝說明存在。修正後 `pnpm check` 通過 208 個測試、typecheck 與 build；重製 DMG、hdiutil verify、唯讀掛載與簽章／內容檢查全部通過，且沒有 latest-mac.yml／blockmap。Pass 2 已完成（high、read-only，約 6 分鐘；輸出 `/tmp/recordstuff-selfsign-fable-review-2.log`），確認第一輪接受的修正無回歸；另有一項 finding：

- P2-1，Low，`electron-builder.local.yml:10`：extends 合併陣列導致 App／Applications 重複，DMG 雖正確但多複製一次 App。接受；實際呼叫已安裝 builder 的 getConfig 確認原先為 5 項，改成本機只加入安裝說明，沿用基底兩項。修正後斷言恰好 3 項、App／Applications／安裝說明各一項通過；沿用已驗證 App 重製 DMG，並重新執行映像檔、唯讀掛載及簽章／內容檢查。兩輪 review 已結束，不啟動第三輪。

#### 本機安裝驗證（2026-09-13，使用者調整優先順序）

使用者要求先在這台 Mac 安裝驗證，另一台 Mac 暫緩；沒有把本機結果當成跨機器結果，也未豁免其他錄製驗收。

- `/Applications/RecordStuff.app` 原先不存在，因此此次是從最終 DMG 安裝到 Applications，並非覆蓋既有安裝的重裝／更新測試。以唯讀掛載、ditto 複製、卸載完成；來源與安裝後 deep strict 簽章驗證均通過。
- 啟動時排除開發工具繼承的 ELECTRON_RUN_AS_NODE 後，23:04:34（UTC 15:04:34）log 確認 `packaged true`、executable `/Applications/RecordStuff.app/Contents/MacOS/RecordStuff`；已進 ready，停在 needsPermission，getSources 被系統拒絕。尚未開始錄製。
- 這台機器已信任開發憑證，DMG 為本機產物；此次不代表下載後 Gatekeeper／另一台 Mac 的體驗。沒有更動信任或再次重置權限，等待使用者在系統提示中授予螢幕錄製，接著測短錄製與重開。

#### 小尺寸圖示修正與日常開發說明（2026-09-13）

- 23:09:30 安裝版 log 已確認 `packaged true`、`/Applications/RecordStuff.app` 與 `permission: granted and capture sees 2 screen(s)`。這是本機授權成功，不代表七項驗收全部完成。
- 使用者截圖顯示權限頁圖示為彩色雜訊、Finder 圖示正常。抽出已安裝 icon.icns，16×16 與 32×32 的表示確實損壞，較大尺寸正常；三份 App 副本原先的 icon.icns SHA-256 均為 `cc33adb61d053dd0794a1414a963f13858002fe9d721a481a5bd84a640d5fde7`，不是只靠快取推測。
- `scripts/make-icons.mjs` 在 macOS 產生 16／32／128／256／512 的 1x、2x iconset（共 10 項），用系統 iconutil 產生 `build/icon.icns`；mac.icon 明確指定它。PNG／Windows ICO 保持原流程，其他平台沿用隨原始碼提供的 ICNS（本次新增、尚未 commit，提交時必須包含），圖樣改動需在 macOS 重製。
- 抽出新 ICNS 的 10 個 PNG，中央紅色、背景深色像素皆符合原圖；16／32 小圖視覺檢查正常。接著以相同憑證與 bundle id 更新 /Applications 的安裝版，不重置 TCC，驗證圖示變更後的螢幕授權是否保留。既有安裝保留備份，不刪錄影與設定。
- 日常測有聲錄影以 `pnpm start` 授權 Electron.app；`pnpm dev` 用於熱重載，權限可能歸於啟動它的終端機／編輯器，不能一律當成 Electron.app；打包驗收 `pnpm start:app`／`pnpm open:app`、安裝版授權 RecordStuff.app。同時只啟動一種。006 尚不能結案：另一台 Mac 暫緩，其他錄製／音訊／通知／Retina 驗收仍待完成。

##### 圖示修正結果與 review

- 新版從 DMG 安裝回 `/Applications/RecordStuff.app`，舊版備份在 `/tmp/recordstuff-before-icon-fix/RecordStuff.app`。更新前後 designated requirement 完全相同，新 ICNS SHA-256 `12e04df975f061366038aaafa8623fae3db804d1487b681e80ed8ed569da2f34`；圖示內容確實改變，app.asar 未變。
- 23:16:52 安裝版重新啟動，log 直接顯示 `permission: granted and capture sees 2 screen(s)`；過程沒有 tccutil reset 或重新授權。本次通過的是圖示資源改變後的同路徑更新與螢幕權限持續性，系統音訊與完整錄製仍待測。
- 系統設定重新開啟前仍顯示舊快取圖示，結束並重新開啟設定後，螢幕與系統錄音清單已顯示正確的紅色錄影圖示，開關保持 on；由 Computer Use 實際畫面確認。
- `pnpm icons`、`pnpm check`（13 檔／208 測試、typecheck、build）、自簽 DMG、hdiutil checksum、唯讀掛載內容與簽章、安裝後簽章驗證均通過。最終 DMG 為 126,082,537 bytes，SHA-256 `71010bf799fd981a6110d6ef7c38335215468277fb0752d86542a4b6ef1fb30e`；同目錄核對檔已更新。
- Claude Fable 5.1 high read-only review 已完成（約 3 分鐘，`/tmp/recordstuff-icon-fable-review-1.log`）。本次只 review 圖示 delta，沒有重跑先前自簽流程的 review。
  - I1，Low，001:414：建議將追加的開發說明移到「下一步」之前。拒絕、未修改該位置；沒有新的章節標題，該段仍屬 §20，屬排版偏好，沒有功能或規格缺陷。
  - I2，Low，build/icon.icns（未提供行號）：文件寫成已納入版本控制，但新檔尚未提交。接受文件澄清；已改為「已產生、尚未 commit，之後需一併提交」。沒有擅自 commit／push；圖示檔保留在工作區，實際打包已驗證使用它。
- Review 後只有文件澄清，沒有實質程式變更，不需第二輪。006 保持進行中；另一台 Mac 暫緩，音訊、錄製、通知、Retina 與其餘原驗收不能由圖示成功推定完成。

### 2026-09-13 T3 Code 參考調查

查核官方 repo `pingdotgg/t3code`，快照 `20363c32c9bfdbf49c2716ef11d1f18483fcc01b`：

- [build-desktop-artifact.ts](https://github.com/pingdotgg/t3code/blob/20363c32c9bfdbf49c2716ef11d1f18483fcc01b/scripts/build-desktop-artifact.ts)：`T3CODE_DESKTOP_SIGNED` 預設 false，可用 `--signed` 或 `T3CODE_DESKTOP_SIGNED=true` 啟用簽章／公證 discovery；非 signed 模式關閉 `CSC_IDENTITY_AUTO_DISCOVERY` 並清除憑證與 Apple API key 變數。此處沒有採用「專案固定自簽憑證」的設定，不能把它稱為 T3 Code 的自簽開發方案。
- [release.yml](https://github.com/pingdotgg/t3code/blob/20363c32c9bfdbf49c2716ef11d1f18483fcc01b/.github/workflows/release.yml)：macOS credentials 齊備時加 `--signed`，使用 `CSC_LINK`／`CSC_KEY_PASSWORD` 與 Apple API key，並要求 team id 與 provisioning profile（其 app 的 passkey 功能需要，RecordStuff 不應照搬）。缺少 Apple signing secrets 時有停用簽章的分支，不可僅憑 workflow 宣稱每個發行檔都已公證。
- [sign-macos.ts](https://github.com/pingdotgg/t3code/blob/20363c32c9bfdbf49c2716ef11d1f18483fcc01b/scripts/sign-macos.ts)：呼叫 `@electron/osx-sign`，啟用 `batchCodesignCalls`。
- 本機 `/Applications/T3 Code (Nightly).app` 實物檢查：`Authority=Developer ID Application: T3 Tools, Inc. (ARK85ZXQ4Z)`、`TeamIdentifier=ARK85ZXQ4Z`、`Notarization Ticket=stapled`、runtime flag；`spctl --assess --type execute --verbose=4` 為 `accepted`／`source=Notarized Developer ID`。因此這份 Nightly 確實是 Apple 認證發行包；不只是開源 repo 的設定推論。
- 可借鑑的是本機打包／認證發行分開、明確控制憑證來源；RecordStuff 目前選擇固定自簽憑證是自己的開發需求，不宣稱等同 T3 Code 官方發行身分。

### 2026-09-13 前階段紀錄（ad-hoc；保留歷史）

以下是改採本機自簽前的實作與 review 紀錄，其中「下一步 Developer ID」及「正式結果須 Developer ID」已由上方的新範圍取代；不代表自簽已完成。

- 已加入 `pnpm start:app` 與 `scripts/start-app.mjs`：限定 macOS arm64／x64、依架構決定路徑、執行中阻擋重建、清除 `ELECTRON_RUN_AS_NODE`、build／ad-hoc 打包／深度嚴格驗證簽章後才 `open`；失敗立即結束。開發輸出獨立在 `dist/dev`，正式 `electron-builder.yml` 不變。ad-hoc override 依 [electron-builder v26 簽章文件](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)。
- 本機 arm64 建置與 `codesign --verify --deep --strict` 成功。Info.plist：`CFBundleIdentifier=com.recordstuff.app`、`CFBundleName=RecordStuff`、`LSUIElement=true`、`NSAudioCaptureUsageDescription=RecordStuff 錄製系統播放的聲音。`；`codesign -dv --verbose=4`：`Signature=adhoc`、`flags=adhoc,runtime`、`TeamIdentifier=not set`。不是 Developer ID／公證通過證據。
- 18:24:39 啟動 log 寫到 `~/Library/Logs/recordstuff/recordstuff.log`，進入 `needsPermission`，`getSources` 回 `Failed to get sources.`。設定保留先前 standard／1440p／60 fps。此機大小寫路徑 inode 相同，且實際 log 顯示小寫路徑，不應宣稱建立了獨立設定目錄。
- app 執行中再跑 `pnpm start:app`：exit 1 並提示先從選單停止存檔與結束，沒有重建。`pnpm check`：12 個測試檔、183 個測試通過，typecheck／build 成功。
- UI 可讀到系統設定「螢幕與系統錄音」已有 RecordStuff.app 且開關為 on；僅限系統錄音區尚未列出 RecordStuff。這不是第一次授權的完整紀錄。Computer Use 取得 RecordStuff 無視窗 app 時逾時，無法經此介面操作 tray，因此 Dock／tray 視覺與選單點擊仍未驗收。未重置任何 TCC 權限。
- `security find-identity -v -p codesigning`：0 valid identities；三個 `APPLE_*` 公證環境變數均未設定（只檢查是否存在，未讀出機密）。使用者確認尚未建立憑證，下一步引導建立 Developer ID Application。`system_profiler SPDisplaysDataType` 只列兩台外接 BenQ 1920×1080／1080×1920，沒有可用的內建 Retina。

| 驗收 | 本次結果／仍需完成 |
|---|---|
| 6(a) 通知顯示／點擊 Finder | 待 Developer ID 簽章版實測；本次未錄製，不推論通知成功 |
| 6(b) HiDPI | 待內建 Retina 作主螢幕的環境 |
| 6(c) 乾淨 TCC 第一次授權 | 只觀察啟動 needsPermission 與設定頁已有項目；未完整走過，仍未驗證 |
| 6(d) 第一次音訊提示拒絕 | 未驗證 |
| 6(e) 同一 process 開音訊後錄製 | 未驗證 |
| 6(f) 權限選單與重啟 | Computer Use 無法取得無視窗 app；待可操作 tray 的真機驗收 |
| 6(g) 撤銷後「結束並重新打開」殘檔 | 未驗證 |

步驟 3–5 的 Developer ID、公證、DMG 安裝與另一台／新帳號驗收尚未完成；Windows 簽章／安裝檔尚未驗證，005 仍待執行。006 維持進行中，沒有豁免任何完成標準。

#### Review 後修正與驗證

- Claude Fable 5.1 Pass 1：接受 [1]（Medium，原 guard 漏掉共用 userData lock 的正式包與 Electron.app）與 [2]（Low，builder 26.15.3 可能將 `identity=-` 當名稱子字串匹配正式憑證）。腳本改檢查所有 RecordStuff.app 與本 checkout 的 Electron 主程序，並在深度驗證後要求 `Signature=adhoc` 才可啟動；main 在 single-instance lock 衝突退出時寫 log。README 同步說明。
- [3]（Low，Rosetta 下依 Node 架構產 x64）拒絕：README 已明寫跟隨 Node 架構，這符合 reviewer 的文件解法；再補 Rosetta 限制，沒有修改架構選擇。
- `scripts/start-app.test.ts` 以替身命令測 CLI，不打包／啟動 app：三種競爭程序皆在 build 前退出、正式簽章不得啟動、無關 Electron 不阻擋且成功路徑驗證在 open 前與清除 Node mode。macOS 才執行這五項，其他平台跳過。
- 修正後 `pnpm check`：13 個測試檔、188 個測試通過，typecheck／build 成功；真實執行中的 app 仍被新 guard 擋下。

- 修正後 `pnpm start:app` 再次完整成功：重新打包、深度嚴格驗證與 `Signature=adhoc` 檢查通過後啟動；18:33:25 新啟動 log、18:33:26 為 `needsPermission` 與 `Failed to get sources.`。沒有操作權限開關，也不視為權限流程驗收通過。

- Claude Fable 5.1 Pass 2：[P2-1] High 接受指定簽章要求與驗收基線風險，`codesign -d -r-` 確認是 `cdhash`。採用文件／驗收流程修正：固定產物、重建後重新建立授權基線，第一次流程不得以切換復原代替，正式結果使用 Developer ID 包。沒有改寫簽章要求，也未操作 TCC；不能只靠既有 log 歸因為每次拒絕皆由 cdhash 變更造成。[P2-2] Low 接受測試 shebang 不支援空白路徑，改成 `/bin/sh` wrapper 正確引用 Node 與 stub 路徑，五個案例均透過含空白的 Node 路徑執行。兩輪 review 結束，不再開第三輪。

- Pass 2 修正後最終 `pnpm check`：typecheck、13 個測試檔／188 個測試、build 全部通過；`git diff --check` 通過。未 commit、push 或發布。
