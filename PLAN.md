# RecordStuff 第一版計畫：選單列上的一個按鈕

版本：v5，2026-09-11
第一版之後的功能全部在 `ROADMAP.md`，本檔只寫第一版。

---

## 1. 一句話說明

macOS 選單列（Windows 是系統匣）上一個圖示。點一下開始錄主螢幕加系統音訊，再點一下停止，影片存進固定資料夾。沒有視窗。

## 1.1 設計理念

架構要夠 robust，performance 要夠好，codebase 要夠簡潔易懂。四者衝突時，依此順序取捨：

1. **正確性。** 錄出來的檔案要有畫面、有聲音、長度對、能播。圖示顯示的狀態一定是真的。
2. **整潔度。** 一個人讀完全部程式碼不超過一個下午。沒有為了將來而寫的抽象。
3. **Robust。** 當機、退出、權限被收回，都要留下明確狀態與可用的檔案。
4. **Performance。** 錄製時不拖慢使用者正在做的事。達標即可，不追求極致。

實際意義：寧可多寫一個明確的 if 也不引入框架；寧可少一個功能也不留一條沒測過的路徑；效能問題先量測再動手。

## 2. 範圍

**第一版有**
- 選單列 / 系統匣一個圖示，沒有視窗，macOS 不顯示在 Dock
- 左鍵點一下：開始錄主螢幕加系統音訊
- 再點一下：停止，檔案存到 `~/Movies/RecordStuff`（Windows 是 `~/Videos/RecordStuff`），檔名用時間
- 圖示反映狀態：待命、錄製中（macOS 圖示旁多一個 `REC` 字樣，Windows 換紅色圖示）、儲存中
- 右鍵：一個小選單，內容是目前狀態的一行文字、儲存位置、必要時的權限動作、「結束」
- 更改儲存位置：右鍵選單「更改儲存位置…」開系統的選資料夾對話框，選了之後之後的錄影都存那裡，重開 app 仍記得
- 停止後一則系統通知：「已儲存 2026-09-11 14-30-00.webm」，點通知在 Finder / 檔案總管顯示
- 失敗時一則系統通知，一行白話錯誤
- macOS 螢幕錄製權限的處理：沒權限時選單多一項「開啟系統設定」，授權後若需要重啟則多一項「重新啟動」
- 錄製中結束 app：先停止並收尾，再退出
- macOS 與 Windows 各一個可安裝、已簽章的版本

**第一版沒有**（全部在 ROADMAP.md）
- 任何視窗：錄影庫、設定頁、歡迎頁
- 全域快捷鍵
- 計時器、音量表
- 選螢幕、選視窗、區域
- 麥克風
- 當機修復、FFmpeg、MP4 轉檔
- 自動更新
- 休眠、拔螢幕的特別處理

## 3. 使用流程

```text
啟動
  → 選單列出現圖示，沒有視窗，沒有 Dock 圖示
  → macOS 第一次：通知「RecordStuff 需要螢幕錄製權限，點這則通知開啟系統設定」
     → 右鍵選單也有「開啟系統設定」
     → 授權後若 app 仍抓不到畫面：通知與選單改成「重新啟動」
  → 有權限：圖示待命，右鍵選單第一行「待命中」

錄製
  → 左鍵點圖示
  → 1.5 秒內圖示變錄製中
  → 再點圖示
  → 圖示變儲存中，幾秒內回到待命，通知「已儲存 …」

失敗
  → 任何失敗：圖示回到待命，一則通知說明原因
  → 錄製中出錯：已寫入硬碟的部分保留，檔名帶 .recording 後綴，通知說明檔案在哪
```

## 4. 完成標準

- macOS 13 以上與 Windows 10 20H2 以上，各錄出 10 分鐘有畫面有聲音、可用系統播放器或瀏覽器播放的檔案
- 從點下到圖示變錄製中少於 1.5 秒
- 1080p 錄製時，錄製程序總 CPU 在 M1 與近三年 x86 筆電上低於 25%
- 新使用者在 macOS 第一次就能完成權限流程，包括需要重啟的情況
- 簽章打包後的版本行為與開發版相同
- 錄製中從選單「結束」或 Cmd+Q，檔案完整
- 待命時記憶體低於 150 MB（capture host 尚未建立）

## 5. 架構

```text
┌──────────────────────────────────────────────────────────┐
│ Electron                                                 │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Main                                                │ │
│  │  Tray（圖示、選單、通知）                            │ │
│  │  Recorder（狀態機）                                  │ │
│  │  FileWriter（append）                                │ │
│  │  Permission（macOS）                                 │ │
│  └───────────────────────▲─────────────────────────────┘ │
│                          │ MessagePort                    │
│  ┌───────────────────────┴─────────────────────────────┐ │
│  │ 隱藏的 capture-host renderer                        │ │
│  │  getDisplayMedia(video + loopback)                  │ │
│  │  MediaRecorder，每秒送一個 chunk                    │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  macOS：ScreenCaptureKit（Electron 39+ 內建）             │
│  Windows：Windows.Graphics.Capture + WASAPI loopback     │
└──────────────────────────────────────────────────────────┘
```

兩個程序、一條資料流。UI 是原生的 `Tray`、`Menu`、`Notification`，全部在 main，沒有 React、沒有 UI renderer。唯一的 renderer 是隱藏的 capture host，它只做擷取與編碼。Main 決定一切、寫檔。

**為什麼要有 capture host 而不在 main 錄**：`getDisplayMedia` 與 `MediaRecorder` 只存在於 renderer。這是 Electron 的限制，不是設計選擇。

## 6. 技術選擇

| 領域 | 選擇 | 備註 |
|---|---|---|
| 外殼 | Electron 39 以上 | 39 起 macOS loopback 內建，不需 flag |
| 語言 | TypeScript，`strict` + `noUncheckedIndexedAccess` | |
| UI | Electron `Tray` + `Menu` + `Notification` | 沒有 HTML UI |
| 建置 | electron-vite | main / preload / renderer 三個入口，renderer 就是 capture host |
| 打包 | electron-builder | 公證與 Windows 簽章成熟，一個設定檔 |
| 擷取 | `session.setDisplayMediaRequestHandler` 回傳 `{ video: 主螢幕, audio: 'loopback' }` | 兩個平台同一段程式碼 |
| 編碼 | `MediaRecorder`，WebM（VP9 + Opus） | 見 ADR-3 |
| 訊息驗證 | 手寫 type guard | 訊息只有幾種，不引入 schema 庫 |

初始化：

```bash
pnpm create @quick-start/electron@latest . -- --template vanilla-ts
```

然後刪掉範本的 `index.html` 內容與 renderer 範例，把 renderer 入口改成 capture host。

## 7. 專案結構

```text
recordstuff/
├── src/
│   ├── main/
│   │   ├── index.ts           # app 生命週期、Dock 隱藏、setDisplayMediaRequestHandler
│   │   ├── tray.ts            # 圖示、狀態對應、右鍵選單、通知
│   │   ├── recorder.ts        # 狀態機：idle / starting / recording / stopping / failed
│   │   ├── capture-host.ts    # 建立隱藏視窗、MessagePort、heartbeat
│   │   ├── file-writer.ts     # append chunk、fsync、收尾改名
│   │   ├── settings.ts        # 讀寫 settings.json，只有 outputDir
│   │   └── permission.ts      # macOS 螢幕錄製權限偵測與開設定
│   ├── preload/
│   │   └── index.ts           # capture host 的 preload，只做 MessagePort 交換
│   ├── renderer/
│   │   ├── index.html         # 空頁，只載入 capture host 腳本
│   │   └── capture-host.ts    # getDisplayMedia、MediaRecorder、送 chunk
│   └── shared/
│       ├── state.ts           # RecordingState 型別
│       └── protocol.ts        # capture-host 訊息型別與 type guard
├── resources/                 # tray icon（macOS template 圖、Windows ico）、entitlements
├── electron-builder.yml
├── electron.vite.config.ts
├── PLAN.md
└── ROADMAP.md
```

單一 app，不做 monorepo。`shared/` 不 import Electron。

## 8. Tray 行為

```ts
export type RecordingState =
  | { type: "needsPermission"; needsRelaunch: boolean }
  | { type: "idle"; lastSavedPath?: string }
  | { type: "starting" }
  | { type: "recording"; startedAt: string }
  | { type: "stopping" };
```

| 狀態 | 圖示 | macOS 標題 | 左鍵 | 右鍵選單 |
|---|---|---|---|---|
| needsPermission | 待命圖（灰） | 無 | 顯示權限通知 | 「需要螢幕錄製權限」（灰字）、「開啟系統設定」或「重新啟動」、「儲存位置：RecordStuff」、「更改儲存位置…」、「結束」 |
| idle | 待命圖 | 無 | 開始 | 「待命中」（灰字）、有的話「顯示最後一個錄影」、「儲存位置：RecordStuff」、「更改儲存位置…」、「結束」 |
| starting | 待命圖 | `…` | 忽略 | 「啟動中…」（灰字）、「結束」 |
| recording | 錄製圖（紅） | `REC` | 停止 | 「錄製中」（灰字）、「停止」、「儲存位置：RecordStuff」（灰字）、「結束」 |
| stopping | 待命圖 | `…` | 忽略 | 「儲存中…」（灰字）、「結束」 |

- macOS 用 template 圖示，自動適應深淺色選單列。`tray.setTitle('REC')` 只在 macOS 有效，Windows 靠換圖示。
- 不用 `tray.setContextMenu`，否則 macOS 左鍵會彈選單。左鍵走 `tray.on('click')`，右鍵走 `tray.on('right-click')` 再 `tray.popUpContextMenu(menu)`。
- 選單每次彈出時依目前狀態重建，不快取。
- 通知用 Electron `Notification`。「已儲存」通知的 click 用 `shell.showItemInFolder`。
- Windows 可能把圖示收進系統匣溢位區。第一次啟動送一則通知「RecordStuff 在系統匣待命」。

## 9. Capture host 協定

Main 與 capture host 用 `postMessage` 交換一對 `MessagePort`。

**Main → capture host**：`start { sessionId }`、`stop { sessionId }`、`ping`

**Capture host → main**
- `ready`
- `started { sessionId, mimeType }`
- `chunk { sessionId, seq, bytes: ArrayBuffer }`，transfer 不複製
- `stopped { sessionId }`
- `error { sessionId?, code, detail }`
- `pong`

規則：
- `MediaRecorder` timeslice 1000 ms。每個 chunk 到 main 就 append，任何時刻最多丟 1 秒。
- 沒拿到 audio track 就回 `error { code: "no_audio_track" }`，不錄無聲影片。
- `ping` 每 5 秒一次，連續兩次沒 `pong`、或 `render-process-gone`，視為當機：進 failed，保留 `.recording.webm`。不自動重啟。
- Capture host 在第一次 start 時建立，之後保留待命。`show: false`、`sandbox: true`、`webSecurity: true`，只載入打包好的檔案。

## 10. 檔案

- Main 是唯一持有檔案 handle 的程序。
- 先寫 `<時間>.recording.webm`，收到 `stopped` 且最後一個 chunk 寫完後改名為 `<時間>.webm`。
- 每 5 秒 fsync 一次。
- 資料夾不存在就建立。建立失敗或寫入失敗：進 failed，通知說明。
- 已知限制：當機留下的 `.recording.webm` 缺 duration 與 seek 索引，多數播放器仍能播但不能拖曳。修復工具在 ROADMAP。

## 10.1 儲存位置

**預設**：`~/Movies/RecordStuff`（Windows 是 `~/Videos/RecordStuff`）。第一次啟動不問，直接用預設，保持一個按鈕就能開始。

**更改**：右鍵選單「更改儲存位置…」→ `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: 目前位置 })`。不需要視窗。macOS 上沒有視窗的 app 開對話框可能不會到最前面，開之前先 `app.focus({ steal: true })`。取消就什麼都不變。

**顯示**：選單裡「儲存位置：<資料夾名稱>」，滑鼠移上去 tooltip 是完整路徑（Windows 支援；macOS 選單沒有 tooltip，就直接顯示 `~` 縮寫的完整路徑）。點這一項用 `shell.openPath` 開該資料夾。

**儲存**：`app.getPath('userData')/settings.json`，內容只有一個欄位：

```json
{ "version": 1, "outputDir": "/Users/eric/Movies/RecordStuff" }
```

存絕對路徑。寫入用先寫 `settings.json.tmp` 再 rename，避免寫一半當機留下壞檔。讀取時任何錯誤（檔案不存在、JSON 壞掉、欄位不對、版本不認得）都回預設值並記 log，不彈通知。

**錄製中**：「更改儲存位置…」變灰字。改了位置只影響下一次錄製，進行中的錄製寫到開始時決定的路徑。

**位置不可用**（外接硬碟拔掉、資料夾被刪、沒有寫入權限）：
- 在「開始」時檢查：`mkdir -p` 該路徑，再試寫一個空檔並刪掉。
- 失敗就不錄，通知「儲存位置無法寫入：<路徑>。右鍵選單可以更改儲存位置」，選單第一行顯示「儲存位置無法使用」。
- **不自動退回預設值**。使用者選了外接硬碟就是要存那裡，默默存到別處違反 §1.1 第一條。

**不做的事**：不支援 iCloud / OneDrive 資料夾的特別處理（能寫就寫）、不支援多個位置、不支援檔名模板。

## 11. 權限（僅 macOS）

- 啟動時用 `systemPreferences.getMediaAccessStatus('screen')` 偵測。
- 未授權：狀態 `needsPermission`，送通知，選單多「開啟系統設定」，開 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`。
- 授權後 app 收到 `activate` 或每 5 秒輪詢一次重新偵測（沒有視窗，沒有 focus 事件可靠）。若狀態是 granted 但 `getDisplayMedia` 仍失敗，設 `needsRelaunch: true`，選單改成「重新啟動」，點了 `app.relaunch()` 再 `app.quit()`。
- 錄製中系統會亮紫色錄製指示燈，這是正常的。
- 要用簽章版本測，ad-hoc 簽章會重置 TCC。

Windows 不需要任何權限。

## 12. 生命週期

**啟動**：ready → macOS `app.dock.hide()` → 建 Tray → 註冊 `setDisplayMediaRequestHandler`（回主螢幕 + `audio: 'loopback'`）→ 偵測權限 → 更新圖示。沒有任何視窗被建立。

**開始**：確認 idle → 檢查儲存位置可寫（§10.1）→ 開檔 → 建立或喚醒 capture host → `start` → 8 秒內要收到 `started` 與第一個 chunk，否則 failed → `recording`。

**停止**：`recording → stopping` → `stop` → 10 秒內要收到 `stopped`，否則 failed → 關檔 → 改名 → `idle` 帶 `lastSavedPath` → 通知。

**退出**：選單「結束」或 Cmd+Q → `before-quit` 時若在錄製，攔下來先跑停止流程，完成後再 quit。超過 10 秒就直接關檔留 `.recording.webm`。

**沒有視窗**：`window-all-closed` 不做任何事，capture host 關閉不等於退出。只有選單「結束」與 Cmd+Q 會退出。

## 13. 錯誤

全部轉成一行白話文送通知。代碼：

`permission_denied`、`permission_needs_relaunch`、`unsupported_os_version`、`no_display`、`no_audio_track`、`capture_start_failed`、`capture_host_crashed`、`capture_host_unresponsive`、`output_open_failed`、`output_write_failed`、`disk_full`、`stop_timeout`

## 14. 測試

- `recorder.ts` 狀態機單元測試：合法與非法轉移、timeout、並行點擊。
- `file-writer.ts`：append 順序、fsync、改名、磁碟錯誤。
- `tray.ts` 的狀態對應表：每個狀態產生的圖示、標題、選單項目，純函式可測。
- `settings.ts`：不存在、壞 JSON、舊版本、正常讀寫、原子寫入（tmp 檔殘留時的行為）。
- 手動檢查表（每次發版前，兩個 OS 各跑一次）：錄 10 分鐘、播放、CPU、權限拒絕與允許、需重啟、錄製中結束、更改位置到外接硬碟後拔掉、資料夾不存在、硬碟滿、深淺色選單列圖示。

自動化端對端與當機注入在 ROADMAP。

## 15. 發行

- macOS：Developer ID 簽章、hardened runtime、公證。DMG。Info.plist 設 `LSUIElement: true`，不出現在 Dock 與 Cmd+Tab。
- Windows：程式碼簽章、NSIS 安裝檔，安裝後啟動並可選「登入時啟動」。無簽章憑證時先出未簽章版並在 README 註明 SmartScreen 警告。
- 沒有自動更新。

## 16. 里程碑

| # | 里程碑 | 交付 | 完成標準 |
|---|---|---|---|
| 1 | Spike | 未打包的 app，選單列一個圖示，兩個 OS 各錄出 60 秒有聲影片 | §17 問題有答案 |
| 2 | 收斂 | 狀態機、capture host 監督、progressive write、權限流程、退出處理、通知文案、圖示 | §4 除簽章外全部達成 |
| 3 | 發行 | 簽章、公證、安裝檔、LSUIElement | **第一版發布** |

里程碑 1 若發現 Chromium 內建路線不可行（拿不到系統音、CPU 太高、同步問題），停下來看 ROADMAP 的備案，不要硬撐。

## 17. 里程碑 1 要回答的問題

1. Electron 目前穩定版在 macOS 13、14、15 與 Windows 10、11 上，`audio: 'loopback'` 是否穩定拿到系統音訊？
2. Windows 上系統沒聲音在播時，loopback 是否停止送資料、導致音軌漂移？Cap 用一條靜音輸出串流當 keepalive，我們是否需要？
3. macOS 螢幕錄製權限第一次授權後是否必須重啟 app？沒有視窗的 app，TCC 提示是否仍正常出現？
4. `MediaRecorder` 在兩個平台是否支援 `video/mp4; codecs=avc1,mp4a.40.2`？（第一版仍出 WebM，這題是為 ROADMAP 收集資料）
5. 1080p30 錄製的 CPU 與檔案大小。
6. HiDPI 下 `getDisplayMedia` 給的是邏輯還是實體解析度？
7. 錄主螢幕時選單列圖示本身會被錄進去，`REC` 字樣是否會出現在影片裡？可接受，還是要在錄製中改用不顯眼的圖示？

## 18. 決策摘要

**ADR-1：Electron。** 一個 TypeScript 開發者能獨立完成全部功能。Tauri + Rust 的路線與理由在 ROADMAP。

**ADR-2：兩個平台都用 Chromium 內建的 `getDisplayMedia` loopback，不寫原生程式。** 產品要錄螢幕，螢幕錄製權限本來就要，沒有理由再為系統音訊另闢原生路徑。代價：最低 macOS 13、抓的是混音後的音訊、macOS 會亮紫色指示燈。

**ADR-3：第一版出 WebM。** `MediaRecorder` 一定支援 WebM，不需要 FFmpeg。MP4 與轉檔在 ROADMAP。

**ADR-4：沒有 UI renderer。** UI 是原生 Tray、Menu、Notification，全在 main。這砍掉 React、UI preload、IPC bridge 三層，且媒體資料天然不可能進 UI。將來需要視窗（錄影庫、設定）時再加 renderer，那時它一樣碰不到媒體資料。

**ADR-5：第一版不用 Effect、不用 schema 庫、不做 monorepo。** 訊息只有幾種、狀態只有五個，手寫夠了。這是 §1.1 第二條的直接結果。何時引入在 ROADMAP。

**ADR-6：electron-builder，不用 Forge。** 與 electron-vite 配套、一個設定檔。可接受的偏好選擇。

**ADR-7：左鍵切換、右鍵選單。** 一個按鈕的產品，主要動作必須是單擊。選單只放狀態、權限動作、結束，不放任何功能。

## 19. 守則

1. 媒體資料只存在 capture host 與 main 的 FileWriter 之間。
2. 權威狀態在 `recorder.ts`，Tray 只是它的投影。
3. 錄製失敗一定產生明確的 failed 狀態與保留的部分檔案，絕不假成功。圖示絕不顯示假的錄製中。
4. 每個 port、stream、檔案 handle 都有確定的釋放路徑。
5. 在簽章打包版本裡能正常運作。
6. 任何不在 §2「第一版有」清單裡的東西，寫進 ROADMAP，不寫進程式碼。
7. 檔案只寫到使用者選的位置。位置不可用就失敗並說明，絕不默默改存別處。
