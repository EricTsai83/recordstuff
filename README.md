# RecordStuff

選單列（Windows：系統匣）上一個按鈕。左鍵點一下開始錄主螢幕加系統音訊，再點一下停止，MP4 存進 `~/Movies/RecordStuff`（Windows：`~/Videos/RecordStuff`）。沒有視窗。

計畫都在 `plans/`：`plans/README.md` 是索引與執行狀態，`plans/001-first-version.md` 是第一版完整計畫，`plans/roadmap.md` 是第一版之後的功能。

## 目前進度

更新：2026-09-13。**基本錄製已測通、檔案 log 已完成，第一版整體仍在進行中。** 使用者已確認停止錄製後有畫面、有聲音；畫質與音質差距交由 Plan 007 改善。

- 已完成：Plan 001 初始實作與基本錄製；Plan 002 檔案 log（`~/Library/Logs/<app>/recordstuff.log`、輪替、右鍵選單「顯示 log」）。
- 進行中：Plan 003 已有基本錄製結果，完整驗收待 007 完成後補。Plan 001 文件保留產品總規格。
- 下一步：Plan 007 品質調校與設定 → Plan 003 完整錄製驗收 → Plan 004 權限流程 → Plan 006 打包與簽章。
- Plan 005 Windows 環境可先準備，錄製驗收使用 Plan 007 最終設定；第一版發布前仍須完成兩平台驗收。

各項完成標準與狀態見 [計畫進度](plans/README.md)。

## 開發

```bash
pnpm install
pnpm dev          # electron-vite dev（main / preload / capture host 皆熱重載）
pnpm check        # typecheck + vitest + build
pnpm icons        # 由 scripts/make-icons.mjs 重新產生 resources/ 與 build/ 的圖示
pnpm log          # macOS：tail -f 開發版的 log 檔（見下方「Log」）
```

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
src/main/tray-model.ts   狀態 → 圖示 / 標題 / 選單（含「顯示 log」）/ 通知文案的純函式
src/main/tray.ts         Electron Tray / Menu / Notification
src/main/settings.ts     settings.json（只有 outputDir），tmp + rename 原子寫入
src/main/permission.ts   macOS 螢幕錄製權限偵測與輪詢
src/preload/index.ts     只做 MessagePort 交換
src/renderer/            capture host：getDisplayMedia → MediaRecorder（MP4）→ 每秒一個 chunk
src/shared/              RecordingState、ErrorCode、協定與 type guard
```
