# RecordStuff

選單列（Windows：系統匣）上一個按鈕。左鍵點一下開始錄主螢幕加系統音訊，再點一下停止，MP4 存進 `~/Movies/RecordStuff`（Windows：`~/Videos/RecordStuff`）。沒有視窗。

計畫都在 `plans/`：`plans/README.md` 是索引與執行狀態，`plans/001-first-version.md` 是第一版完整計畫，`plans/roadmap.md` 是第一版之後的功能。

## 目前進度

更新：2026-09-13。**基本錄製已測通、檔案 log、錄製品質設定與錄製驗收工具已完成，第一版整體仍在進行中。** 使用者已確認停止錄製後有畫面、有聲音；畫質與音質的正式量測與係數調校用 Plan 008 的工具進行中。

- 已完成：Plan 001 初始實作與基本錄製；Plan 002 檔案 log（`~/Library/Logs/<app>/recordstuff.log`、輪替、右鍵選單「顯示 log」）；Plan 007 右鍵選單「錄製品質」（影像品質、解析度上限、幀率、音訊品質）、settings.json v2、每次開始錄製的品質快照與 `capture:` log、`pnpm probe`；Plan 008 的工具：`pnpm verify`（ffprobe／ffmpeg 對門檻表）、`pnpm matrix`（環境變數自動錄製矩陣 + CPU 取樣）、`scripts/test-material.html`（含音畫同步標記）。品質係數仍是未經真機驗證的起點，預設輸出與原本相同。
- 進行中：Plan 008 的正式量測（要主螢幕播素材頁，見 `plans/measurements/`）與 007 係數回填；第一次試跑發現套解析度上限後 log 的 `track size=` 不是實際尺寸、macOS 系統音訊是單聲道。Plan 003 已有基本錄製結果，完整驗收改用 Plan 008 的工具補。Plan 001 文件保留產品總規格。
- 下一步：Plan 008 量測與回填 → Plan 003 完整錄製驗收 → Plan 004 權限流程 → Plan 006 打包與簽章。
- Plan 005 Windows 環境可先準備，錄製驗收使用 Plan 007 的設定與 Plan 008 的工具；第一版發布前仍須完成兩平台驗收。

各項完成標準與狀態見 [計畫進度](plans/README.md)。

## 開發

```bash
pnpm install
pnpm dev          # electron-vite dev（main / preload / capture host 皆熱重載）
pnpm check        # typecheck + vitest + build
pnpm icons        # 由 scripts/make-icons.mjs 重新產生 resources/ 與 build/ 的圖示
pnpm log          # macOS：tail -f 開發版的 log 檔（見下方「Log」）
pnpm probe -- <mp4>   # 開發用：用 ffprobe 印出成品的尺寸、平均 fps、位元率、取樣率、聲道、時長（需 brew install ffmpeg）
pnpm verify -- <mp4...> [--screen 1920x1080] [--sync] [--out]   # 開發用：對 plans/008 的門檻表逐項 ✅／❌，--out 附加到 plans/measurements/<日期>.md
pnpm matrix -- quick|levels|fps|long [--open-material]           # 開發用（macOS）：自動錄製矩陣 + CPU 取樣 + 驗收，結果進 plans/measurements/
```

`pnpm verify`／`pnpm matrix` 是 TypeScript 腳本，由 Node 24 直接執行（不經 build）。`pnpm matrix` 靠環境變數 `RECORDSTUFF_AUTORECORD='{"seconds":30,"quality":{...}}'` 讓開發版 app 啟動後自動錄、到時停、存檔後結束；打包版忽略這個變數。跑矩陣時主螢幕要播 `scripts/test-material.html`（`--open-material` 會用 Chrome kiosk 自動開在主螢幕），細節見 `plans/008-recording-verification-toolkit.md`。

在 Claude Code 之類把 `ELECTRON_RUN_AS_NODE=1` 塞進環境的 shell 裡，啟動前要先 `unset ELECTRON_RUN_AS_NODE`，否則 Electron 會以純 Node 模式啟動。

macOS 上開發版（`node_modules` 裡的 Electron.app）需要在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」被授權；每次 Electron 升版 TCC 會重新要求。權限流程要用簽章版本測，ad-hoc 簽章會重置 TCC。

**系統音訊在 macOS 上是另一個權限。** Electron 39 起 Chromium 用 CoreAudio Tap 抓系統音訊（macOS 14.2+），需要 `NSAudioCaptureUsageDescription` 這個 Info.plist key，以及同一個設定頁下方「僅系統音訊錄製」的允許。缺任何一項時 Chromium **不會報錯**，只會給一條已結束的靜音音軌；capture host 會偵測到並回 `no_audio_track`。

這個權限是算在「負責程式」頭上：從 Terminal 用 `pnpm dev` 啟動時，負責程式是 Terminal，而 Terminal 沒有那個 key，所以永遠不會被詢問、也錄不到聲音。要測有聲音的錄製，用：

```bash
pnpm start        # build 後以 open 啟動 Electron.app，Electron 自己成為負責程式
```

第一次啟動錄製時 macOS 會跳「Electron 想要錄製系統音訊」，允許即可。VS Code／Cursor 內建終端機本身帶有這個 key，從那裡 `pnpm dev` 也可以，但授權對象會是 VS Code。

### Log

選單列 app 沒有 console，所有 log 除了 stdout 之外也寫到 `app.getPath('logs')/recordstuff.log`；`pnpm start` 與正式版只能從這裡看狀態轉移、session 失敗原因與權限驗證結果。macOS 上這是 `~/Library/Logs/<app 名稱>/`，Console.app 的「Log Reports」也會列出；Windows 是 `%APPDATA%\<app 名稱>\logs\`。開發版（Electron.app）的 app 名稱是 `recordstuff`，打包後的 RecordStuff.app 是 `RecordStuff`：

```bash
pnpm log                                                 # 等同下一行
tail -f ~/Library/Logs/recordstuff/recordstuff.log        # macOS，pnpm start
tail -f ~/Library/Logs/RecordStuff/recordstuff.log        # macOS，RecordStuff.app
Get-Content -Wait "$env:APPDATA\recordstuff\logs\recordstuff.log"   # Windows
```

右鍵選單的「顯示 log」會在 Finder／檔案總管選取這個檔案。`tail -f` 先印最後 10 行，之後停在那裡等新內容；點圖示開始／停止錄製才會多出 `state → …` 與 `saved …` 幾行，`Ctrl+C` 結束。時間是 UTC。

每行格式是 `[ISO 時間] 訊息`；啟動時第一行是版本、Electron 版本、平台與儲存位置。main 程序的未捕捉例外與未處理的 Promise rejection 也會寫進去。檔案超過 5 MB 會輪替成 `recordstuff.1.log`、`.2`、`.3`，最多保留三個舊檔。寫檔失敗不影響 app：stderr 印一次後只寫 stdout。

### 錄製品質

右鍵選單「錄製品質」有四個單選子選單，標籤顯示目前值：

| 項目 | 選項 | 預設 |
|---|---|---|
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps | 30；60 fps 目前只在 macOS 開放，Windows 顯示停用 |
| 音訊品質 | 標準（AAC 192 kbps）／高品質（AAC 256 kbps） | 高品質 |

選項存進 `settings.json`，重啟保留。每次開始錄製時固定一份設定快照，錄製中選單變灰、改動只影響下一次。解析度上限保持來源比例、不放大，直向螢幕交換長短邊；影像位元率依實際擷取尺寸 × 幀率 × 品質係數計算（標準 1080p30 約 8 Mbps，上下界 1.5–60 Mbps）。要求 60 fps 但系統只給 ≤ 30 時會跳通知說明實際幀率。

每次開始錄製 log 都有一行 `capture:`，列出要求的設定、track 回報的尺寸／幀率／取樣率／聲道，以及送給編碼器的目標位元率（不是成品實測值）。成品要用 `pnpm probe` 或 `pnpm verify` 量。注意：`track size=` 目前不是實際影格尺寸（1440p 上限回報 1440x1440、原尺寸回報 1920x1920），實際成品仍是正確比例（1440x810、1920x1080）；系統音訊在 macOS 上是單聲道。

## 打包與簽章

```bash
pnpm dist:mac     # DMG；有 Developer ID 就簽章，設定下列環境變數則公證
pnpm dist:win     # NSIS 安裝檔；有 CSC_LINK / CSC_KEY_PASSWORD 就簽章
```

macOS 公證需要 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。Windows 沒有簽章憑證時會產出未簽章版，第一次執行 SmartScreen 會警告「無法辨識的 App」，選「其他資訊 → 仍要執行」即可。

## 架構一覽

```text
src/main/index.ts        app 生命週期、Dock 隱藏、setDisplayMediaRequestHandler、退出處理、未捕捉例外寫 log
src/main/log.ts          stdout + 檔案 log（app.getPath('logs')/recordstuff.log），5 MB 輪替保留 3 個，寫檔失敗不影響 app
src/main/recorder.ts     狀態機（唯一的權威狀態），無 Electron 依賴，可單元測試
src/main/capture-host.ts 隱藏 renderer 的建立、MessagePort、heartbeat、當機偵測
src/main/file-writer.ts  唯一的檔案 handle：append、每 5 秒 fsync、收尾改名
src/main/tray-model.ts   狀態 → 圖示 / 標題 / 選單（含「錄製品質」子選單、「顯示 log」）/ 通知文案的純函式
src/main/tray.ts         Electron Tray / Menu（含 submenu 與 radio）/ Notification
src/main/autorecord.ts   開發用 RECORDSTUFF_AUTORECORD：解析與驗證、自動開始／停止／結束（走 Tray 同一組 toggle／stop）；打包版忽略
src/main/settings.ts     settings.json v2（outputDir + quality；v1 相容），tmp + rename 原子寫入
src/main/permission.ts   macOS 螢幕錄製權限偵測與輪詢
src/preload/index.ts     只做 MessagePort 交換
src/renderer/            capture host：getDisplayMedia → 套用解析度上限 → MediaRecorder（MP4，依品質算位元率）→ 每秒一個 chunk
src/shared/quality.ts    品質設定型別／驗證、解析度上限計算、位元率公式、擷取回報與 log 文字（無 Electron／DOM）
src/shared/              RecordingState、ErrorCode、協定與 type guard
scripts/probe-recording.mjs  開發用：ffprobe 量測成品參數（pnpm probe），不打包
scripts/verify-recording.mts 開發用：pnpm verify CLI；scripts/lib/verify.mts 純邏輯（log 配對、掉幀／偏移／漂移、門檻判定、輸出）、media-tools.mts（ffprobe／ffmpeg）、verify-recording.mts（單檔流程、附加 plans/measurements/）
scripts/run-matrix.mts       開發用（macOS）：pnpm matrix 自動錄製矩陣、CPU 取樣、驗收
scripts/test-material.html   開發用錄製素材：捲動小字、紅藍細線、移動方塊、每秒閃光 + beep 同步標記；不進 app、不進 CSP
plans/measurements/          量測結果（Markdown + JSON），由 verify／matrix 附加，主觀比對由人填
```
