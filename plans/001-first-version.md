# RecordStuff 第一版計畫：選單列上的一個按鈕

狀態：已完成（初始實作與基本錄製，2026-09-12）

執行範圍已拆分：001 以初始實作與使用者確認有聲有影作為結案範圍。下列 §4、§16、§17 繼續作為第一版整體發布的規格與驗收依據，並非全部已通過；剩餘工作由 002（log）、007（品質與設定）、003／004／005（驗收）、006（打包與發行）追蹤。

版本：v9，2026-09-12

v9 變更：區分 001 初始實作結案與整體第一版發布；001 標為已完成，未完成驗收仍保留並交由後續計畫追蹤。

v8 變更：記錄使用者已確認基本有聲有影；將品質量測與 Tray 可調設定提前納入第一版（007）。其餘驗收未宣告完成。

v7 變更：依實作與真機測試更新。§9 chunk 改為複製；§11 改寫為兩段式權限偵測並加入「系統音訊錄製」這個第二個權限；§13 新增 `capture_failed`；§17 記錄已有答案的題目；新增 §20 開發流程與下一步。
v6 變更：預設輸出改為 MP4（H.264 + AAC），WebM 降為退路（ADR-3）；套件版本改為當下最新穩定版（§6、ADR-8）；§17 以 MP4 驗證為首要問題。
第一版之後的功能全部在 `roadmap.md`，本檔只寫第一版。其他獨立計畫與執行狀態見 `plans/README.md`。

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
- 右鍵：一個小選單，內容是目前狀態的一行文字、儲存位置、錄製品質、必要時的權限動作、「顯示 log」、「結束」
- 錄製品質（007）：Tray 子選單調整影像品質、解析度上限、30／60 fps；永久保存，開始時固定設定，錄製期間停用。60 fps 依平台驗證後開放，不新增視窗。音訊固定一個 AAC 目標（008 實測 Chromium 夾在約 160 kbps，選項無意義，已移除）。
- 更改儲存位置：右鍵選單「更改儲存位置…」開系統的選資料夾對話框，選了之後之後的錄影都存那裡，重開 app 仍記得
- 停止後一則系統通知：「已儲存 2026-09-11 14-30-00.mp4」，點通知在 Finder / 檔案總管顯示
- 失敗時一則系統通知，一行白話錯誤
- macOS 螢幕錄製權限的處理：沒權限時選單多一項「開啟系統設定」，授權後若需要重啟則多一項「重新啟動」
- 錄製中結束 app：先停止並收尾，再退出
- macOS 與 Windows 各一個可安裝、已簽章的版本

**第一版沒有**（全部在 roadmap.md）
- 任何視窗：錄影庫、設定頁、歡迎頁
- 全域快捷鍵
- 計時器、音量表
- 選螢幕、選視窗、區域
- 麥克風
- 當機修復、FFmpeg、轉檔
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

- macOS 13 以上與 Windows 10 20H2 以上，各錄出 10 分鐘有畫面有聲音的 MP4，在 Finder 雙擊用 QuickTime Player 開、在檔案總管雙擊用「媒體播放器」開，都能直接播放
- 10 分鐘錄製結束時音畫偏移小於 100 ms（用畫面上的節拍器與聲音對照）
- 從點下到圖示變錄製中少於 1.5 秒
- 1080p 錄製時，錄製程序總 CPU 在 M1 與近三年 x86 筆電上低於 25%
- 新使用者在 macOS 第一次就能完成權限流程，包括需要重啟的情況
- 簽章打包後的版本行為與開發版相同
- 錄製中從選單「結束」或 Cmd+Q，檔案完整
- 待命時記憶體低於 150 MB（capture host 尚未建立）
- 007 的品質調校、設定保存與平台能力驗證完成；003／005 使用最終設定驗收

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
│  │  MediaRecorder → MP4（H.264 + AAC），每秒送一個 chunk │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  macOS：ScreenCaptureKit（Electron 39+ 內建）             │
│  Windows：Windows.Graphics.Capture + WASAPI loopback     │
└──────────────────────────────────────────────────────────┘
```

兩個程序、一條資料流。UI 是原生的 `Tray`、`Menu`、`Notification`，全部在 main，沒有 React、沒有 UI renderer。唯一的 renderer 是隱藏的 capture host，它只做擷取與編碼。Main 決定一切、寫檔。

**為什麼要有 capture host 而不在 main 錄**：`getDisplayMedia` 與 `MediaRecorder` 只存在於 renderer。這是 Electron 的限制，不是設計選擇。

**為什麼第一版走 Chromium 內建擷取而不是原生**：抓畫面用的 OS API（ScreenCaptureKit、Windows.Graphics.Capture）與硬體編碼器（VideoToolbox、Media Foundation）兩條路是同一套，1080p30 下 CPU 差距估計在兩到三倍以內，兩邊都遠低於 §4 門檻。差距在 60fps、4K、編碼參數與音畫同步的控制權，第一版都不需要。Capture host 是唯一碰擷取與編碼的模組，main 只認 §9 的協定，將來換成原生 sidecar 只換這一層（ROADMAP 第 20 項）。

## 6. 技術選擇

| 領域 | 選擇 | 備註 |
|---|---|---|
| 外殼 | Electron 44（2026-09 穩定版），最低 39 | 39 起 macOS loopback 內建；43 起 `restrictOwnAudio` 修好，app 自己的聲音不會被錄進去 |
| 語言 | TypeScript 7，`strict` + `noUncheckedIndexedAccess` | |
| UI | Electron `Tray` + `Menu` + `Notification` | 沒有 HTML UI |
| 建置 | electron-vite 5 | main / preload / renderer 三個入口，renderer 就是 capture host |
| 打包 | electron-builder 26 | 公證與 Windows 簽章成熟，一個設定檔 |
| 擷取 | `session.setDisplayMediaRequestHandler` 回傳 `{ video: 主螢幕, audio: 'loopback' }` | 兩個平台同一段程式碼 |
| 編碼 | `MediaRecorder`，MP4，`video/mp4;codecs=avc1,mp4a.40.2`（H.264 + AAC，走系統硬體編碼器） | 見 ADR-3。WebM 只是退路 |
| 訊息驗證 | 手寫 type guard | 訊息只有幾種，不引入 schema 庫 |

**版本策略**：每個里程碑開始時把所有套件升到當下的最新穩定版，不用 alpha / beta（ADR-8）。上表的版本是 2026-09-11 查到的。

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
├── plans/                     # 計畫：README 是索引與狀態，001 是本檔，roadmap 是第一版之後
├── electron-builder.yml
└── electron.vite.config.ts
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
| needsPermission | 待命圖（灰） | 無 | 顯示權限通知 | 「需要螢幕錄製權限」（灰字）、「開啟系統設定」或「重新啟動」、「儲存位置：RecordStuff」、「更改儲存位置…」、「錄製品質 ▸」、「顯示 log」、「結束」 |
| idle | 待命圖 | 無 | 開始 | 「待命中」（灰字）、有的話「顯示最後一個錄影」、「儲存位置：RecordStuff」、「更改儲存位置…」、「錄製品質 ▸」、「顯示 log」、「結束」 |
| starting | 待命圖 | `…` | 忽略 | 「啟動中…」（灰字）、「錄製品質」（灰字）、「顯示 log」、「結束」 |
| recording | 錄製圖（紅） | `REC` | 停止 | 「錄製中」（灰字）、「停止」、「儲存位置：RecordStuff」（灰字）、「更改儲存位置…」（灰字）、「錄製品質」（灰字）、「顯示 log」、「結束」 |
| stopping | 待命圖 | `…` | 忽略 | 「儲存中…」（灰字）、「錄製品質」（灰字）、「顯示 log」、「結束」 |

- macOS 用 template 圖示，自動適應深淺色選單列。`tray.setTitle('REC')` 只在 macOS 有效，Windows 靠換圖示。
- 不用 `tray.setContextMenu`，否則 macOS 左鍵會彈選單。左鍵走 `tray.on('click')`，右鍵走 `tray.on('right-click')` 再 `tray.popUpContextMenu(menu)`。
- 選單每次彈出時依目前狀態重建，不快取。
- 通知用 Electron `Notification`。「已儲存」通知的 click 用 `shell.showItemInFolder`。
- 「顯示 log」（002）：每個狀態都有，`shell.showItemInFolder` 選取 log 檔；檔案不存在時改開 log 資料夾。放在「結束」正上方、與儲存位置同一組之後，低頻除錯用途不搶眼。
- Windows 可能把圖示收進系統匣溢位區。第一次啟動送一則通知「RecordStuff 在系統匣待命」。

- 「錄製品質 ▸」（007）：三個單選子選單，各自的標籤帶目前值——「影像品質：標準」（精省／標準／高品質）、「解析度上限：原尺寸」（1080p／1440p／4K／原尺寸）、「幀率：30 fps」（30／60；60 只在 macOS 開放，Windows 顯示「60 fps（此平台尚未驗證，暫不開放）」停用）。選一項即寫入 settings.json 並重繪選單；寫入失敗保留原值並通知「無法儲存錄製品質設定」。starting／recording／stopping 只顯示停用的「錄製品質」，進行中的錄製沿用開始時的快照。

## 9. Capture host 協定

Main 與 capture host 用 `postMessage` 交換一對 `MessagePort`。

**Main → capture host**：`start { sessionId, quality }`、`stop { sessionId }`、`ping`

- `quality`（007）是 main 在建立 session 時讀取的設定快照 `{ videoQuality, resolutionCap, frameRate }`；host 不自己讀設定。音訊位元率固定 `AUDIO_BITS_PER_SECOND`（008 移除了音訊品質選項）。type guard 拒絕不支援的值。

**Capture host → main**
- `ready`
- `started { sessionId, mimeType, capture }`；`capture`（007）= `{ width?, height?, frameRate?, sampleRate?, channelCount?, videoBitsPerSecond, audioBitsPerSecond, warnings: string[] }`：前五項來自 `track.getSettings()`，平台沒給的欄位省略（log 印「未知」）；兩個位元率是送給 `MediaRecorder` 的目標值，不是成品實測；`warnings` 是非致命問題（例如解析度上限的 `applyConstraints` 被拒，改以來源尺寸錄）
- `chunk { sessionId, seq, bytes: ArrayBuffer }`，結構化複製。原本打算 transfer，但 Electron 44.3 實測 transfer 的 ArrayBuffer 會讓 main process 卡死；每秒約 1 MB 的複製可忽略
- `stopped { sessionId }`
- `error { sessionId?, code, detail }`
- `pong`

規則：
- `MediaRecorder` timeslice 1000 ms。每個 chunk 到 main 就 append，任何時刻最多丟 1 秒。
- 品質套用順序（007）：`getDisplayMedia({ video: { frameRate: { ideal, max } } })` → 讀 video track 尺寸 → `fitWithinCap` 算不放大、保持比例、直向交換長短邊的目標尺寸 → 需要時 `applyConstraints({ width, height, frameRate })`（`applyConstraints` 會整組取代約束，所以幀率要重帶）→ 重新確認所有 track 仍為 live（套用期間結束的音軌不能錄成無聲檔）→ 依實際尺寸 × 幀率 × 品質係數算 `videoBitsPerSecond`（1.5–60 Mbps）、`audioBitsPerSecond`（192k／256k）→ 建立 `MediaRecorder`。套用期間 session 仍算 pending，`stop` 到達會取消並釋放串流。
- 要求 60 fps 而 `capture.frameRate` ≤ 30 時，main 記 log 並通知「系統只提供 N fps」；track 未回報幀率不視為降級。
- 建立 `MediaRecorder` 前先 `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')`。回 false 就回 `error { code: "mp4_unsupported" }`，不默默改錄 WebM。第一版支援的 OS 版本都有系統 H.264 與 AAC 編碼器，這個錯誤理論上不會發生，發生了就是要查的 bug。
- 沒拿到 audio track、或拿到的 audio track 一開始就是 `ended` 狀態，都回 `error { code: "no_audio_track" }`，不錄無聲影片。後者是 macOS 沒給「系統音訊錄製」權限時 Chromium 的實際行為：不報錯，只給一條死的音軌（§11）。
- `ping` 每 5 秒一次，連續兩次沒 `pong`、或 `render-process-gone`，視為當機：進 failed，保留 `.recording.mp4`。不自動重啟。
- Capture host 在第一次 start 時建立，之後保留待命。`show: false`、`sandbox: true`、`webSecurity: true`，只載入打包好的檔案。

## 10. 檔案

- Main 是唯一持有檔案 handle 的程序。
- 先寫 `<時間>.recording.mp4`，收到 `stopped` 且最後一個 chunk 寫完後改名為 `<時間>.mp4`。
- 每 5 秒 fsync 一次。
- 資料夾不存在就建立。建立失敗或寫入失敗：進 failed，通知說明。
- Chromium 的 MediaRecorder 寫的是 fragmented MP4：`moov` 在檔頭，之後每個 chunk 是自成一體的 `moof + mdat` 片段。所以當機留下的 `.recording.mp4` 理論上多數播放器能播，但 duration 可能缺、拖曳可能不準。§17 第 2 題要實測。修復工具在 ROADMAP。

## 10.1 儲存位置

**預設**：`~/Movies/RecordStuff`（Windows 是 `~/Videos/RecordStuff`）。第一次啟動不問，直接用預設，保持一個按鈕就能開始。

**更改**：右鍵選單「更改儲存位置…」→ `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: 目前位置 })`。不需要視窗。macOS 上沒有視窗的 app 開對話框可能不會到最前面，開之前先 `app.focus({ steal: true })`。取消就什麼都不變。

**顯示**：選單裡「儲存位置：<資料夾名稱>」，滑鼠移上去 tooltip 是完整路徑（Windows 支援；macOS 選單沒有 tooltip，就直接顯示 `~` 縮寫的完整路徑）。點這一項用 `shell.openPath` 開該資料夾。

**儲存**：`app.getPath('userData')/settings.json`，version 2（007）：

```json
{
  "version": 2,
  "outputDir": "/Users/eric/Movies/RecordStuff",
  "quality": { "videoQuality": "standard", "resolutionCap": "source", "frameRate": 30 }
}
```

`videoQuality`：`economy | standard | high`；`resolutionCap`：`1080p | 1440p | 4k | source`；`frameRate`：`30 | 60`。2026-09-13 前寫入的 `audioQuality` 鍵照讀忽略，版本不變。存絕對路徑。寫入用先寫 `settings.json.tmp` 再 rename，避免寫一半當機留下壞檔。讀取：version 1（只有 outputDir）照讀並補預設 quality，下次儲存改寫成 version 2；version 2 的 `quality` 缺少或含不支援的值時只把 quality 重設為預設、保留 outputDir 並記 log；檔案不存在、JSON 壞掉、outputDir 不對、版本不認得則整份回預設值並記 log，不彈通知。Windows 上讀到 `frameRate: 60` 不改檔，開始錄製時以 30 執行（60 fps 尚未在 Windows 驗證）。

**錄製中**：「更改儲存位置…」變灰字。改了位置只影響下一次錄製，進行中的錄製寫到開始時決定的路徑。

**位置不可用**（外接硬碟拔掉、資料夾被刪、沒有寫入權限）：
- 在「開始」時檢查：`mkdir -p` 該路徑，再試寫一個空檔並刪掉。
- 失敗就不錄，通知「儲存位置無法寫入：<路徑>。右鍵選單可以更改儲存位置」，選單第一行顯示「儲存位置無法使用」。
- **不自動退回預設值**。使用者選了外接硬碟就是要存那裡，默默存到別處違反 §1.1 第一條。

**不做的事**：不支援 iCloud / OneDrive 資料夾的特別處理（能寫就寫）、不支援多個位置、不支援檔名模板。

## 11. 權限（僅 macOS）

macOS 上有**兩個**獨立權限，都在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」這一頁：上半是螢幕錄製，下半「僅系統音訊錄製」是 macOS 14.2 起 CoreAudio Tap 用的第二個權限。Electron 39 起 Chromium 用 CoreAudio Tap 抓系統音訊，沒有 fallback。

設計原則借自 Cap：OS 回報的授權狀態只是線索，擷取實際看得到什麼才是真相；而驗證有成本，所以要有界、要快取、要退避。

**螢幕錄製，兩段式偵測**

1. 每 5 秒與 `activate` 時查 `systemPreferences.getMediaAccessStatus('screen')`，便宜、不會彈框。
2. 第一段回 granted 且尚未驗證過時，呼叫 `desktopCapturer.getSources({ types: ['screen'] })` 確認至少看得到一個螢幕，包 4 秒 timeout，同時間只跑一次。成功後整個程序生命週期快取，之後不再呼叫。失敗（零個螢幕、拋 `Failed to get sources`、超時）就是「剛授權但 TCC 還沒生效」：`needsRelaunch: true`，選單改「重新啟動」，點了 `app.relaunch()` 再 `app.quit()`；每次輪詢仍重驗，暫時性故障會自行復原。

- 未授權：狀態 `needsPermission`，送通知，選單多「開啟系統設定」，開 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`。同時呼叫一次 `getSources`（每個程序最多一次），讓 macOS 把 app 列進清單並跳出系統提示，使用者不用手動按「+」。Electron 沒有包 `CGRequestScreenCaptureAccess`，這是零依賴的替代；若真機發現它只註冊不彈框，再換 `node-mac-permissions`。
- 進入 `needsPermission`、或 `needsRelaunch` 由 false 變 true 時各送一則通知；狀態沒變不重發。
- 錄製失敗且原因是 `permission_denied`、而 OS 仍說 granted，同樣進 `needsRelaunch`。

**系統音訊錄製**

- 需要 Info.plist 的 `NSAudioCaptureUsageDescription`（electron-builder `extendInfo` 已帶）加使用者在「僅系統音訊錄製」允許。第一次 `getDisplayMedia` 時 macOS 會自己彈框。
- 缺任何一項時 Chromium 不報錯，回一條一建立就 `ended` 的音軌。Capture host 檢查 `readyState` 後回 `no_audio_track`，通知文字直接指向設定頁。沒有「granted 但要重啟」的問題。
- 這個權限算在**負責程式**頭上。從 Terminal 啟動時負責程式是 Terminal，它沒有那個 key，永遠不會被詢問，開發時一定錄不到聲音。見 §20。

**共同**

- 錄製中系統會亮紫色錄製指示燈，這是正常的。
- 要用簽章版本測，ad-hoc 簽章會重置 TCC。macOS 15 起每月會再確認一次，這是系統行為。

Windows 不需要任何權限。

## 12. 生命週期

**啟動**：ready → macOS `app.dock.hide()` → 建 Tray → 註冊 `setDisplayMediaRequestHandler`（回主螢幕 + `audio: 'loopback'`）→ 偵測權限 → 更新圖示。沒有任何視窗被建立。

**開始**：確認 idle → 檢查儲存位置可寫（§10.1）→ 開檔 → 建立或喚醒 capture host → `start` → 8 秒內要收到 `started` 與第一個 chunk，否則 failed → `recording`。

**停止**：`recording → stopping` → `stop` → 10 秒內要收到 `stopped`，否則 failed → 關檔 → 改名 → `idle` 帶 `lastSavedPath` → 通知。

**退出**：選單「結束」或 Cmd+Q → `before-quit` 時若在錄製，攔下來先跑停止流程，完成後再 quit。超過 10 秒就直接關檔留 `.recording.mp4`。

**沒有視窗**：`window-all-closed` 不做任何事，capture host 關閉不等於退出。只有選單「結束」與 Cmd+Q 會退出。

## 13. 錯誤

全部轉成一行白話文送通知。代碼：

`permission_denied`、`permission_needs_relaunch`、`unsupported_os_version`、`no_display`、`no_audio_track`、`mp4_unsupported`、`capture_start_failed`、`capture_failed`、`capture_host_crashed`、`capture_host_unresponsive`、`output_open_failed`、`output_write_failed`、`disk_full`、`stop_timeout`

`capture_failed` 是擷取在錄製中自己結束（螢幕或音軌 `ended`、MediaRecorder error）。不是使用者要求停止，就不能當成功。

## 14. 測試

- `recorder.ts` 狀態機單元測試：合法與非法轉移、timeout、並行點擊。
- `file-writer.ts`：append 順序、fsync、改名、磁碟錯誤。
- `tray.ts` 的狀態對應表：每個狀態產生的圖示、標題、選單項目，純函式可測。
- `settings.ts`：不存在、壞 JSON、舊版本、正常讀寫、原子寫入（tmp 檔殘留時的行為）。
- 錄製驗收（008）：`pnpm verify` 用 ffprobe／ffmpeg 對成品逐項對 008 的門檻表（尺寸、幀率、掉幀、時長差、起始偏移、閃光／beep 同步與漂移、取樣率／聲道、位元率、可解碼），`pnpm matrix` 用 `RECORDSTUFF_AUTORECORD` 無人值守錄一組矩陣並取 CPU，結果進 `plans/measurements/`。純邏輯有假 ffprobe 輸出的單元測試。
- 手動檢查表（每次發版前，兩個 OS 各跑一次）：錄 10 分鐘、在 Finder / 檔案總管雙擊用系統預設播放器播放、音畫偏移、CPU、權限拒絕與允許、需重啟、錄製中結束、更改位置到外接硬碟後拔掉、資料夾不存在、硬碟滿、深淺色選單列圖示。錄 10 分鐘、音畫偏移與 CPU 改用 `pnpm matrix -- long`。

自動化端對端與當機注入在 ROADMAP。

## 15. 發行

- macOS：Developer ID 簽章、hardened runtime、公證。DMG。Info.plist 設 `LSUIElement: true`，不出現在 Dock 與 Cmd+Tab。
- Windows：程式碼簽章、NSIS 安裝檔，安裝後啟動並可選「登入時啟動」。無簽章憑證時先出未簽章版並在 README 註明 SmartScreen 警告。
- 沒有自動更新。

## 16. 里程碑

| # | 里程碑 | 交付 | 完成標準 |
|---|---|---|---|
| 1 | Spike | 未打包的 app，選單列一個圖示，兩個 OS 各錄出 60 秒有聲 MP4，QuickTime Player 與 Windows 媒體播放器雙擊可開 | §17 問題有答案，且第 1、2 題答案為可行 |
| 2 | 收斂 | 狀態機、capture host 監督、progressive write、權限流程、退出處理、通知文案、圖示、檔案 log、品質調校與可調設定（007） | §4 除簽章外全部達成 |
| 3 | 發行 | 簽章、公證、安裝檔、LSUIElement | **第一版發布** |

里程碑 1 有兩層退路，依序：
1. MP4 不可行（不支援、CPU 高、當機半成品不能播）但 Chromium 擷取本身沒問題：第一版改出 WebM（VP9 + Opus），MP4 轉檔進 ROADMAP。要接受 macOS 上 QuickTime 打不開，通知文案要說明用瀏覽器開。
2. Chromium 擷取本身不可行（拿不到系統音、掉幀嚴重、音畫漂移無法接受）：停下來看 ROADMAP 第 20 項的原生 sidecar 備案，不要硬撐。

## 17. 里程碑 1 要回答的問題

前兩題決定第一版的輸出格式，先答。

1. `MediaRecorder` 在 Electron 44 於 macOS 13、14、15 與 Windows 10、11 上，`isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')` 是否都回 true？實際錄出的檔案是否真的走硬體編碼（macOS 用 Activity Monitor 看 VTEncoderXPCService，Windows 看 GPU 使用率）？1080p30 錄 10 分鐘的 CPU 與檔案大小。
   **部分已答**：macOS 26 / Electron 44.3 / Chrome 152 回 true。2026-09-13（008，M1 Pro）：1080p30 三等級 Electron 各程序 CPU 合計平均 14–16%、峰值 ≤ 19%，1080p60 平均 23%；1080p30 標準 ≈ 58 MB/分（10 分鐘 ≈ 580 MB），高品質 ≈ 106 MB/分，60 fps 標準 ≈ 223 MB/分。硬體編碼（VTEncoderXPCService）與 10 分鐘實跑由 003 用 `pnpm matrix -- long` 補；Windows 未測。
2. 錄製中強制殺掉 capture host，留下的 `.recording.mp4` 在 QuickTime Player、Windows 媒體播放器、Chrome 是否能播？duration 是否正確？
3. `audio: 'loopback'` 在上述 OS 版本是否穩定拿到系統音訊？
   **部分已答（2026-09-12 使用者回報）**：目前測試環境錄製停止後有聲音也有畫面；使用者觀察到品質差距，交由 007 量測。尚未提供長時間穩定性、音畫同步與 Windows 驗收結果。
4. Windows 上系統沒聲音在播時，loopback 是否停止送資料、導致音軌漂移？Cap 用一條靜音輸出串流當 keepalive，我們是否需要？
   **已答，不需要**：Chromium 的 `audio_low_latency_input_win.cc` 在 loopback 模式會自己開一條 event-driven 的 render stream（註解：「to ensure that we can deliver a loopback stream … also when no output audio is playing」），並對 `AUDCLNT_BUFFERFLAGS_SILENT` 補零。Cap 與 OBS 要自己做是因為它們直接碰 WASAPI。Windows 實測時仍要看一次前十秒無聲的檔案音畫是否對齊，當作驗證而不是問題。
5. 10 分鐘錄製結束時音畫偏移多少？
   **部分已答（2026-09-13，008）**：3 分鐘漂移 3 ms；固有延遲 45–80 ms（音訊晚，每段內穩定）。10 分鐘由 003 用 `pnpm matrix -- long` 補。
6. macOS 螢幕錄製權限第一次授權後是否必須重啟 app？沒有視窗的 app，TCC 提示是否仍正常出現？
   **部分已答**：系統音訊是另一個權限，缺了會拿到死音軌而非錯誤（§11）。螢幕錄製是否需重啟、無視窗時提示是否出現，尚未在乾淨的 TCC 狀態下測（要先 `tccutil reset ScreenCapture com.github.Electron`）。
7. HiDPI 下 `getDisplayMedia` 給的是邏輯還是實體解析度？
   **部分已答（2026-09-13，008）**：外接 1:1 螢幕下實際影格 1920x1080（邏輯 = 實體）。另發現 `track.getSettings()` 在多螢幕下回報錯誤高度（1920x1920），capture host 已改讀實際影格。HiDPI 內建螢幕為主螢幕時再看 `capture:` log。
8. 錄主螢幕時選單列圖示本身會被錄進去，`REC` 字樣是否會出現在影片裡？可接受，還是要在錄製中改用不顯眼的圖示？

## 18. 決策摘要

**ADR-1：Electron。** 一個 TypeScript 開發者能獨立完成全部功能。Tauri + Rust 的路線與理由在 ROADMAP。

**ADR-2：兩個平台都用 Chromium 內建的 `getDisplayMedia` loopback，不寫原生程式。** 產品要錄螢幕，螢幕錄製權限本來就要，沒有理由再為系統音訊另闢原生路徑。代價：最低 macOS 13、抓的是混音後的音訊、macOS 會亮紫色指示燈、目前程式將幀率限制為 30fps；007 將驗證 60fps 與品質設定，實際能力以平台測試為準。這是「先驗證產品」的選擇，不是品質上限的選擇；原生路線的觸發條件與做法在 ROADMAP 第 20 項。

**ADR-3：第一版出 MP4（H.264 + AAC），不出 WebM。** 理由兩個。第一，macOS 的 QuickTime Player 與 Finder 預覽打不開 .webm，使用者雙擊就失敗，違反 §1.1 第一條。第二，WebM 的 VP9 是軟體編碼，1080p 會吃掉 30% 以上 CPU；MP4 的 H.264 走系統硬體編碼器，CPU 低一個量級。Chromium 從 126 起支援 MediaRecorder 出 MP4，Electron 44 遠高於此。代價：Linux 沒有 AAC 編碼器（第一版不做 Linux），檔案是 fragmented MP4。WebM 是 §16 第一層退路，只在 §17 第 1、2 題失敗時啟用。不用 FFmpeg。

**ADR-4：沒有 UI renderer。** UI 是原生 Tray、Menu、Notification，全在 main。這砍掉 React、UI preload、IPC bridge 三層，且媒體資料天然不可能進 UI。將來需要視窗（錄影庫、設定）時再加 renderer，那時它一樣碰不到媒體資料。

**ADR-5：第一版不用 Effect、不用 schema 庫、不做 monorepo。** 訊息只有幾種、狀態只有五個，手寫夠了。這是 §1.1 第二條的直接結果。何時引入在 ROADMAP。

**ADR-6：electron-builder，不用 Forge。** 與 electron-vite 配套、一個設定檔。可接受的偏好選擇。

**ADR-7：左鍵切換、右鍵選單。** 一個按鈕的產品，主要動作必須是單擊。選單只放狀態、權限動作、結束，不放任何功能。

**ADR-8：套件一律用最新穩定版。** 每個里程碑開始時升到當下最新穩定版，不用 alpha / beta，不刻意停在舊版。Electron 每兩個月一個大版，loopback、`restrictOwnAudio` 這類擷取相關修正都在新版，停在舊版只會累積要繞的 bug。

## 19. 守則

1. 媒體資料只存在 capture host 與 main 的 FileWriter 之間。
2. 權威狀態在 `recorder.ts`，Tray 只是它的投影。
3. 錄製失敗一定產生明確的 failed 狀態與保留的部分檔案，絕不假成功。圖示絕不顯示假的錄製中。
4. 每個 port、stream、檔案 handle 都有確定的釋放路徑。
5. 在簽章打包版本裡能正常運作。
6. 任何不在 §2「第一版有」清單裡的東西，寫進 ROADMAP，不寫進程式碼。
7. 檔案只寫到使用者選的位置。位置不可用就失敗並說明，絕不默默改存別處。

## 20. 開發流程

三種啟動方式，各有用途；差別在 macOS 把權限記在誰頭上，以及看不看得到 log。

| 方式 | 指令 | 負責程式 | log | 用途 |
|---|---|---|---|---|
| 開發 | `pnpm dev` | 啟動它的終端機 | 終端機 | 改邏輯、改 UI，熱重載。從 Terminal／iTerm 啟動時**錄不到系統音訊**（它們沒有 `NSAudioCaptureUsageDescription`）；從 VS Code／Cursor 內建終端機可以，權限記在 VS Code 名下 |
| 近似真機 | `pnpm start` | Electron.app（`com.github.Electron`） | 檔案 log（見下） | 測權限、系統音訊、通知。build 後用 `open` 啟動，`open` 立刻返回，app 由 launchd 接管，關掉終端機也不影響。改了程式要重跑 |
| 真機 | `electron-builder --dir` | RecordStuff.app | 檔案 log | 權限提示與設定頁顯示的是 RecordStuff，與使用者看到的一致。驗證簽章、公證、`LSUIElement` 時用 |
| 自動錄製 | `pnpm matrix -- <矩陣>` | Electron.app | 檔案 log + `plans/measurements/` | 008：build 後帶 `RECORDSTUFF_AUTORECORD` 用 `open -W` 啟動，app 自己開始、停止、存檔、結束；runner 取 CPU 並跑 `pnpm verify`。只有開發版讀這個變數 |

- 檔案 log（002）：所有 log 同時寫 stdout 與 `app.getPath('logs')/recordstuff.log`，超過 5 MB 輪替成 `.1`／`.2`／`.3`；macOS 開發版在 `~/Library/Logs/recordstuff/`，RecordStuff.app 在 `~/Library/Logs/RecordStuff/`，Windows 在 `%APPDATA%\<app>\logs\`。main 的未捕捉例外也寫進同一個檔。指令見 README「Log」一節。
- 這些 shell 若帶著 `ELECTRON_RUN_AS_NODE=1`（Claude Code 等工具會設），Electron 會以純 Node 模式啟動而崩潰；`pnpm start` 已在腳本內清掉，`pnpm dev` 要自己 `unset`。`open` 會把 shell 環境變數傳給 app，所以同樣要清。
- 升級 Electron 版本後 TCC 對 Electron.app 的授權會失效，用 `tccutil reset ScreenCapture com.github.Electron` 清掉重授權比在清單裡找快。

**下一步**：拆成獨立計畫，順序與狀態見 `plans/README.md`。
