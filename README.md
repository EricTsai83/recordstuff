# RecordStuff

選單列（Windows：系統匣）上一個按鈕。左鍵點一下開始錄主螢幕加系統音訊，再點一下停止，MP4 存進 `~/Movies/RecordStuff`（Windows：`~/Videos/RecordStuff`）。沒有視窗。

計畫都在 `plans/`：`plans/README.md` 是索引與執行狀態，`plans/001-first-version.md` 是第一版完整計畫，`plans/roadmap.md` 是第一版之後的功能。

## 目前進度

更新：2026-09-14。**Plan 006 已依本機範圍結案，macOS 自簽開發版可正常錄製。** 已完成的計畫為 001、002、003、004、006、007、008；下一個是 005 Windows 環境與驗收，尚未開始。009 Apple Developer ID／公證為擱置的選配。

本機已驗證自簽／DMG 安裝、更新後權限保留、通知點擊開 Finder、內建 Retina 原尺寸 3456×2234、首次授權與音訊拒絕、權限選單，以及錄影中撤銷權限後的檔案收尾。音訊權限開啟後本次需重啟；撤銷測試保留完整 47.59 秒 MP4，恢復權限後另錄 12.65 秒並由使用者確認可播。最後程式檢查為 211 測試、typecheck／build 通過。

通知設定清單舊圖示依使用者決定暫不阻擋，尚未確認修好；安裝包與系統圖示查詢已是正常新版。另一台 Mac／新帳號依要求跳過，不將本機結果稱為跨機器或 Windows 通過。Finder 前景排序仍受系統影響，不能僅以 reveal 日誌保證每次置頂。詳見 [006 結案與證據](plans/006-dev-app-bundle-and-signing.md)。

## 開發

```bash
pnpm install
pnpm start:app    # macOS：build → 指定本機自簽 RecordStuff.app → 驗證 → open（先結束 app）
pnpm open:app     # 驗證並重開既有 dist/dev app，不重建／不重簽
pnpm dist:mac:local # 指定本機自簽 app 驗證後產 DMG 至 dist/local，不公證／不發布
pnpm dev          # electron-vite dev（main / preload / capture host 皆熱重載）
pnpm check        # typecheck + vitest + build
pnpm icons        # 由 scripts/make-icons.mjs 重新產生 resources/ 與 build/ 的圖示
pnpm log          # macOS：tail -f 開發版的 log 檔（見下方「Log」）
pnpm probe -- <mp4>   # 開發用：用 ffprobe 印出成品的尺寸、平均 fps、位元率、取樣率、聲道、時長（需 brew install ffmpeg）
pnpm verify -- <mp4...> [--screen 1920x1080] [--sync] [--out]   # 開發用：對 plans/008 的門檻表逐項 ✅／❌，--out 附加到 plans/measurements/<日期>.md
pnpm matrix -- all|quick|levels|fps|long                         # 開發用（macOS）：自動開素材頁到主螢幕、自動錄製矩陣 + CPU 取樣 + 驗收，結果進 plans/measurements/；all 約 7 分鐘；long 為 3 分鐘漂移回歸（10 分鐘已於 2026-09-13 量過一次）
```

`pnpm verify`／`pnpm matrix` 是 TypeScript 腳本，由 Node 24 直接執行（不經 build）。`pnpm matrix` 靠環境變數 `RECORDSTUFF_AUTORECORD='{"seconds":30,"quality":{...}}'` 讓開發版 app 啟動後自動錄、到時停、存檔後結束；打包版忽略這個變數。跑矩陣時主螢幕要播 `scripts/test-material.html`：預設由 Chrome kiosk 自動全螢幕開在主螢幕、主螢幕尺寸自動偵測，自己開時加 `--no-open-material`。期間音量固定、不播其他聲音、不動主螢幕。細節見 `plans/008-recording-verification-toolkit.md`。

在 Claude Code 之類把 `ELECTRON_RUN_AS_NODE=1` 塞進環境的 shell 裡，啟動前要先 `unset ELECTRON_RUN_AS_NODE`，否則 Electron 會以純 Node 模式啟動。

macOS 上開發版（`node_modules` 裡的 Electron.app）需要在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」被授權；每次 Electron 升版 TCC 會重新要求。權限流程要用簽章版本測，ad-hoc 簽章會重置 TCC。

**系統音訊在 macOS 上是另一個權限。** Electron 39 起 Chromium 用 CoreAudio Tap 抓系統音訊（macOS 14.2+），需要 `NSAudioCaptureUsageDescription` 這個 Info.plist key，以及同一個設定頁下方「僅系統音訊錄製」的允許。缺任何一項時 Chromium **不會報錯**，只會給一條已結束的靜音音軌；capture host 會偵測到並回 `no_audio_track`。

這個權限是算在「負責程式」頭上：從 Terminal 用 `pnpm dev` 啟動時，負責程式是 Terminal，而 Terminal 沒有那個 key，所以永遠不會被詢問、也錄不到聲音。要測有聲音的錄製，用：

```bash
pnpm start        # build 後以 open 啟動 Electron.app，Electron 自己成為負責程式
```

第一次啟動錄製時 macOS 會跳「Electron 想要錄製系統音訊」，允許即可。VS Code／Cursor 內建終端機本身帶有這個 key，從那裡 `pnpm dev` 也可以，但授權對象會是 VS Code。

**日常測有聲錄影用 `pnpm start`，錄影權限開給 Electron.app。** `pnpm dev` 用於熱重載開發，權限可能歸於啟動它的終端機／編輯器；`pnpm start` 先 build 再透過 LaunchServices 開啟 Electron，讓 Electron 自己成為負責程式。驗證打包後的 App 才用 `pnpm start:app`／`pnpm open:app`，權限對象是 RecordStuff.app；安裝版則從「應用程式」啟動。同一時間只開一種，避免共用設定／lock 與不同身分混淆。

`pnpm start:app`、`pnpm open:app` 與 `pnpm dist:mac:local` 共用 `scripts/start-app.mjs`。預設精確選擇鑰匙圈中名為 `RecordStuff Dev` 的有效簽章身分，也可用 `RECORDSTUFF_SIGN_IDENTITY` 指定完整名稱或 40 位 SHA-1 指紋（名稱仍須唯一；electron-builder 最後以名稱簽署，重名時指紋也無法排除歧義）。這只是公開的憑證選擇資訊，不存私鑰；憑證與私鑰留在登入鑰匙圈。缺少、重名、過期、尚未生效、非自簽或成品簽章不符都會失敗，不會退回 ad-hoc。首次使用私鑰若出現系統提示，由使用者在 macOS 輸入密碼允許。

目前 Node 架構決定產物：arm64 使用 `dist/dev/mac-arm64/RecordStuff.app`，x64 使用 `dist/dev/mac/RecordStuff.app`；Rosetta 下的 x64 Node 會產 x64 包。DMG 模式改用 `dist/local`。所有模式先攔截正在執行的 RecordStuff.app 與本 checkout 的 Electron.app，請先從選單結束並存檔。`open:app` 不打包，適合固定產物的權限驗收；它也會重新核對憑證與簽章，不會啟動無法驗證的舊包。

本機流程清除 `ELECTRON_RUN_AS_NODE`、Apple／CSC 發行認證環境變數，停用憑證自動搜尋，明確指定所選指紋、停用時間戳與公證，強制簽章且 `--publish never`。簽完先 `codesign --verify --deep --strict`，抽取外層 app 與巢狀 app／framework 的公開憑證比對指紋，確認 app identifier、hardened runtime 與固定 certificate leaf 的 designated requirement，再開啟或製作 DMG。

RecordStuff.app 與 Electron.app 的執行期名稱均來自 package 的 `name: recordstuff`，因此設定／single-instance lock 共用 `~/Library/Application Support/recordstuff/`，log 共用 `~/Library/Logs/recordstuff/recordstuff.log`。預設錄影位置仍為 `~/Movies/RecordStuff`。

自簽憑證的固定身分是否保留 TCC 權限與通知能否顯示仍須實測；切換原 ad-hoc 包到自簽包應建立新的授權基線。之後的 A/B 重建測試保留同一憑證，刻意修改內容後比較 designated requirement 與權限，途中不預先重置。一般權限案例固定產物。任何 TCC 重置都只限已核對的 `com.recordstuff.app`，第一次授權流程不可用「關→開」的復原代替。

#音訊授權後若仍顯示拿不到系統音訊，請先結束並重新開啟 RecordStuff；本機驗收確認選「稍後」的原程序仍可能失敗。通知的桌面顯示及暫時／持續樣式由系統設定控制。

## Log

選單列 app 沒有 console，所有 log 除了 stdout 之外也寫到 `app.getPath('logs')/recordstuff.log`；`pnpm start` 與正式版只能從這裡看狀態轉移、session 失敗原因與權限驗證結果。macOS 上這是 `~/Library/Logs/<app 名稱>/`，Console.app 的「Log Reports」也會列出；Windows 是 `%APPDATA%\<app 名稱>\logs\`。開發版（Electron.app）的 app 名稱是 `recordstuff`，本機打包後的 RecordStuff.app 執行期名稱也是 `recordstuff`（bundle 顯示名稱仍是 RecordStuff）：

```bash
pnpm log                                                 # 等同下一行
tail -f ~/Library/Logs/recordstuff/recordstuff.log        # macOS，pnpm start
tail -f ~/Library/Logs/recordstuff/recordstuff.log        # macOS，pnpm start:app 也使用這個路徑
Get-Content -Wait "$env:APPDATA\recordstuff\logs\recordstuff.log"   # Windows
```

右鍵選單的「顯示 log」會在 Finder／檔案總管選取這個檔案。`tail -f` 先印最後 10 行，之後停在那裡等新內容；點圖示開始／停止錄製才會多出 `state → …` 與 `saved …` 幾行，`Ctrl+C` 結束。時間是 UTC。

每行格式是 `[ISO 時間] 訊息`；啟動時第一行是版本、Electron 版本、平台、儲存位置、`packaged` 與 `executable`，可區分共用 log 來自 Electron.app 或哪一份打包 app。main 程序的未捕捉例外與未處理的 Promise rejection 也會寫進去。檔案超過 5 MB 會輪替成 `recordstuff.1.log`、`.2`、`.3`，最多保留三個舊檔。寫檔失敗不影響 app：stderr 印一次後只寫 stdout。

### 錄製品質

右鍵選單「錄製品質」有三個單選子選單，標籤顯示目前值：

| 項目 | 選項 | 預設 |
|---|---|---|
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps | 30；60 fps 目前只在 macOS 開放，Windows 顯示停用。實測 60 fps 約 57 fps，檔案約為 30 fps 的四倍大（標準等級約 223 vs 58 MB/分：位元率公式因幀率加倍，Chromium 又給約兩倍目標） |

音訊不提供選項：固定要求 AAC 256 kbps，實測 Chromium 只給約 160 kbps，多一個選項也不會有差別（舊 settings.json 裡的 `audioQuality` 會被忽略）。選項存進 `settings.json`，重啟保留。每次開始錄製時固定一份設定快照，錄製中選單變灰、改動只影響下一次。解析度上限保持來源比例、不放大，直向螢幕交換長短邊；影像位元率依實際擷取尺寸 × 幀率 × 品質係數計算（標準 1080p30 約 8 Mbps，上下界 1.5–60 Mbps）。要求 60 fps 但系統只給 ≤ 30 時會跳通知說明實際幀率。

每次開始錄製 log 都有一行 `capture:`，列出要求的設定、track 回報的尺寸／幀率／取樣率／聲道，以及送給編碼器的目標位元率（不是成品實測值）。成品要用 `pnpm probe` 或 `pnpm verify` 量。尺寸取自實際影格（隱藏 `<video>` 的 `videoWidth`／`videoHeight`），不信 `track.getSettings()`；兩者不同時 log 有 warning。系統音訊在這台 macOS 26／Electron 44 上錄到的是兩聲道但左右內容相同（dual-mono），沒有立體聲分離；其他組態未測。

## 打包與簽章

**免費自簽分享用 `pnpm dist:mac:local`**：使用固定自簽憑證，產物在 `dist/local`，不購買 Apple 會員、不公證。收件者可能需要在「系統設定 → 隱私權與安全性」對單一 app 選「仍要打開」。不要求安裝私鑰、根憑證或停用 Gatekeeper；可分享性仍須另一台 Mac 實測，不代表 Apple 認證。

交付方式已確定為「DMG 內含已自簽 App」：簽章由開發者在本機完成，接收者只安裝 App，不安裝憑證；不需要與 Google 互動，也不需要 Apple 會員或公證服務。首次開啟的人工允許與錄影權限分開處理。DMG 本身不簽章，不產生自動更新 metadata／blockmap；固定憑證簽署的是裡面的 App。

本機專用設定 `electron-builder.local.yml` 繼承共用打包設定，輸出 `RecordStuff-<version>-<arch>-selfsigned.dmg`，附帶 [English installation instructions](resources/INSTALL.md) 與 [繁體中文安裝說明](resources/INSTALL.zh-TW.md)。DMG 內可把 RecordStuff 拖到 Applications，之後從「應用程式」啟動，避免繼續使用 DMG／開發包中的副本。arm64 包供 Apple 晶片 Mac、x64 包供 Intel Mac；不把目前產物稱為通用版。

故障紀錄：2026-09-13，舊 ad-hoc 授權在切換自簽後，即使開關開啟仍失敗。`tccd` 明確記錄舊 `cdhash` 與新 certificate requirement 不符；已針對 `com.recordstuff.app` 重置 ScreenCapture，重置後授權尚待使用者完成。這是身分切換復原，不是同一憑證 A/B 重建驗收；打包程式不會自動重置權限。

目前本機產物：`dist/local/RecordStuff-0.1.0-arm64-selfsigned.dmg`（約 126 MB），同目錄有本次驗收產生的 SHA-256 核對檔。只驗過本機成品完整性，尚未通過另一台 Mac 安裝／錄製。

以下是既有發行指令；Developer ID／公證驗收維持擱置的 [Plan 009](plans/009-apple-notarized-distribution.md)，本機流程不呼叫它們。

```bash
pnpm dist:mac     # DMG；有 Developer ID 就簽章，設定下列環境變數則公證
pnpm dist:win     # NSIS 安裝檔；有 CSC_LINK / CSC_KEY_PASSWORD 就簽章
```

macOS 公證需要 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。Windows 沒有簽章憑證時會產出未簽章版，第一次執行 SmartScreen 會警告「無法辨識的 App」，選「其他資訊 → 仍要執行」即可。

## 架構一覽

```text
src/main/index.ts        app 生命週期、Dock 隱藏、setDisplayMediaRequestHandler、退出處理、未捕捉例外寫 log
src/main/log.ts          stdout + 檔案 log（app.getPath('logs')/recordstuff.log），5 MB 輪替保留 3 個，寫檔失敗不影響 app
src/main/recorder.ts     狀態機、分段啟動期限與首片段診斷；無 Electron 依賴，可單元測試
src/main/capture-host.ts 隱藏 renderer 的建立、MessagePort、heartbeat、當機偵測
src/main/file-writer.ts  唯一的檔案 handle：append、每 5 秒 fsync、收尾改名
src/main/tray-model.ts   狀態 → 圖示 / 標題 / 選單（含「錄製品質」三個子選單、「顯示 log」）/ 通知文案的純函式
src/main/tray.ts         Electron Tray / Menu（含 submenu 與 radio）/ Notification
src/main/autorecord.ts   開發用 RECORDSTUFF_AUTORECORD：解析與驗證、自動開始／停止／結束（走 Tray 同一組 toggle／stop）；打包版忽略
src/main/settings.ts     settings.json v2（outputDir + quality；v1 相容），tmp + rename 原子寫入
src/main/permission.ts   macOS 螢幕錄製權限偵測與輪詢
src/preload/index.ts     只做 MessagePort 交換
src/renderer/            capture host：getDisplayMedia → 量實際影格尺寸 → 套用解析度上限 → MediaRecorder（MP4，依品質算位元率）→ 每秒一個 chunk
src/shared/quality.ts    品質設定型別／驗證、解析度上限計算、位元率公式、擷取回報與 log 文字（無 Electron／DOM）
src/shared/              RecordingState、ErrorCode、協定與 type guard
build/icon.icns              原生 macOS 多尺寸 App 圖示（pnpm icons 在 macOS 產生）
electron-builder.local.yml   免費 DMG 設定：自簽標示、停用公證、內附安裝說明
resources/INSTALL.md        英文安裝說明
resources/INSTALL.zh-TW.md  繁體中文安裝說明
scripts/start-app.mjs        macOS 本機自簽：唯一憑證解析、期限／自簽檢查、共用 lock 保護、build／巢狀憑證驗證／open／DMG；--open 只驗證重開
scripts/start-app.test.ts    macOS CLI 回歸：隔離臨時憑證／替身指令，測重名／期限／錯誤 helper 簽章、失敗不交付、憑證環境隔離、重開／DMG 與空白路徑
scripts/probe-recording.mjs  開發用：ffprobe 量測成品參數（pnpm probe），不打包
scripts/verify-recording.mts 開發用：pnpm verify CLI；scripts/lib/verify.mts 純邏輯（log 配對、掉幀／偏移／漂移、門檻判定、輸出）、media-tools.mts（ffprobe／ffmpeg）、verify-recording.mts（單檔流程、附加 plans/measurements/）
scripts/run-matrix.mts       開發用（macOS）：pnpm matrix 自動錄製矩陣、CPU 取樣、驗收
scripts/test-material.html   開發用錄製素材：捲動小字、紅藍細線、移動方塊、每秒閃光 + beep 同步標記；不進 app、不進 CSP
plans/measurements/          量測結果（Markdown + JSON），由 verify／matrix 附加，主觀比對由人填
```

### App 圖示再生

`pnpm icons` 保留跨平台 PNG／ICO 產生流程；在 macOS 額外以 `/usr/bin/iconutil` 將各尺寸 PNG iconset 轉成 `build/icon.icns`。此 ICNS 已產生、尚未 commit，之後需與本次變更一起提交；`electron-builder.yml` 的 `mac.icon` 明確使用它，避免 PNG 自動轉 ICNS 後 16／32 像素圖示出現彩色雜訊。其他平台不重製 ICNS；改 App 圖樣後需在 macOS 執行本指令並一併提交 PNG／ICNS。圖示只在打包前產生，不能直接改已簽好的 App。

若系統設定仍顯示舊圖示，檢查是否登錄了相同 bundle id 的舊開發包；本次僅取消舊 dist/dev App 的登錄、重新登錄 /Applications 安裝版，沒有清空系統資料庫或重置權限。舊開發產物再次啟動前，請用 `pnpm start:app` 重建，避免 `pnpm open:app` 重新登錄含舊圖示的包。
