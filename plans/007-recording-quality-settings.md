# 007 錄製品質與可調設定

狀態：已完成（2026-09-13；範圍縮小為設定能力與診斷資料，量測與調校移至 008）
前置：002（檔案 log）；基本有聲有影錄製已由使用者確認
後續：008 用工具完成本計畫遺留的 A2–A5 量測並回填係數 → 003 完整驗收 → 004；005 的錄製品質驗收使用本計畫的設定與 008 的工具
對應：001 里程碑 2；由 Roadmap 第 7 項提前

## 問題與目標

使用者已確認錄製停止後有畫面、有聲音，但觀察到影像與聲音質感不如來源。現行程式固定 H.264 目標 8 Mbps、最高 30 fps，未指定解析度與 AAC 位元率。這些是待量測的可能原因，尚不能把差異全歸因於壓縮。

先量測並調校，再讓使用者從 Tray 右鍵「錄製品質」選擇適合的品質與檔案大小。保留一鍵開始／停止、不新增視窗。改善原始錄製，不新增編輯器或錄完再轉檔流程。

## 使用者設定

| 項目 | 選項 | 預設 |
|---|---|---|
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps | 30；60 依平台真機驗證後開放 |
| 音訊品質 | 標準／高品質 | 高品質，先以 AAC 256 kbps 驗證；標準以 192 kbps 驗證 |

- 影像品質與音訊品質獨立；選精省影像不降低音訊品質。
- 解析度保持來源比例、不放大小來源。上限以長邊／短邊界定為 1920×1080、2560×1440、3840×2160，直向來源交換邊界，超寬來源等比例縮小。原尺寸仍受擷取端與編碼器能力限制，實際尺寸必須量測。
- 位元率依實際擷取尺寸、目標幀率與品質等級決定，設合理上下界。以像素數 × 幀率 × 品質係數作為調校起點；係數與上限由 A 階段決定，不直接照搬 Cap 或承諾固定輸出位元率。
- 選項存入 settings.json，重啟仍保留；舊設定補品質預設且保留 outputDir。驗證無效欄位、未支援值與寫入失敗，不顯示假成功。
- 每次開始錄製時固定一份設定快照。starting／recording／stopping 期間品質子選單停用；待命修改只影響下一次錄製。
- 60 fps 是目標上限，不保證每秒持續 60 張。不支援的平台停用並說明；偵測到明確降級時顯示實際限制，不能只在 log 中默默降級。內容靜止造成較少影格不等於不支援。
- 第一輪不開放 24／25／120 fps、自訂 Mbps、取樣率、聲道數或 BPP 滑桿。

## A. 品質量測與預設調校

1. 接上 002 log，記錄 session、要求的設定、track.getSettings() 提供的尺寸／幀率／取樣率／聲道數，以及 MediaRecorder 的影像與音訊目標位元率。欄位不存在標為未知；目標值不當作檔案實測值。不記錄媒體內容。
2. 保留現行 8 Mbps／30 fps 作為基準，用同一素材比較文字、捲動、快速動態、音樂及左右聲道。記錄來源、OS、Electron 版本、播放軟體與測試音量；播放比較保持相同輸出裝置與音量。
3. 量測輸出檔案的尺寸、平均幀率、位元率、取樣率、聲道、時長與大小；分析工具僅作開發驗收用途，不隨 app 打包。檢查縮放、音量、失真、聲道與色彩差異，不能只提高位元率便宣告解決。
4. 對 1080p30 與本機原尺寸測試三個影像等級；驗證 AAC 192／256 kbps。記錄成品差異、CPU、檔案大小，定出品質係數與上下界。音訊處理／聲道需求先驗證擷取端支援，不能假設 constraints 一定生效。
5. 以持續動態素材測試 60 fps：比較要求值、track 設定與成品影格時間戳，記錄 CPU、掉幀與同步。macOS／Windows 各自驗證，未驗證的平台先保留 30 fps。

## B. 設定選單與保存

1. 擴充 shared 設定型別與驗證、main 設定讀寫、Tray 單選子選單，使用 A 階段定出的預設。
2. Main 將開始時的設定快照經 start 協定傳給 capture host；host 取得實際尺寸後計算編碼目標。擴充必要的實際設定回報與診斷，維持 main 為狀態權威。
3. settings.json 原子寫入，保存失敗時保留先前選擇並明確回饋。更新協定 type guard 與舊設定相容性測試。
4. 更新 001 的協定、設定 schema 與 README 操作說明，使其反映最終實作。

## 範圍調整（2026-09-13）

使用者決定：本計畫只負責「使用者能選、程式能套用、log 能看出實際結果」這三件事，並以此結案；原 A2–A5 的真機量測、係數調校、60 fps 開放決定與使用者確認，移交 [008 錄製驗收工具與量測流程](008-recording-verification-toolkit.md)，用可重複的工具一次完成，避免 003、005 再各自手動量一輪。因此下面「目前的調校起點」表中的係數**尚未經真機驗證**，預設輸出與原本 8 Mbps／30 fps 基準相同，不會比之前差；量測結果由 008 回填本檔與 `src/shared/quality.ts`。

## 執行紀錄（2026-09-13）

已完成（程式與測試）：

- **A1 診斷 log**：每次 `started` 寫一行 `recorder: session <id> capture: requested …; track size/fps/sampleRate/channels …; target videoBps/audioBps …`。track 未回報的欄位寫「未知」；位元率標為 target，不當作實測值。啟動 log 也印目前 quality 設定。
- **B1 設定與選單**：`src/shared/quality.ts` 定義四個欄位的型別、驗證、`fitWithinCap`、`videoBitsPerSecond`、`audioBitsPerSecond`。Tray 在 idle／needsPermission 顯示「錄製品質 ▸」，內含四個單選子選單，標籤帶目前值（例如「影像品質：標準」）；starting／recording／stopping 顯示停用的「錄製品質」。Windows 的 60 fps 顯示為停用並註明「此平台尚未驗證，暫不開放」；settings.json 內若存了 60，Windows 啟動時以 30 錄製（`effectiveQuality`），檔案不改寫。
- **B2 快照與協定**：`Recorder` 建立 session 時讀一次 quality，`start { sessionId, quality }` 傳給 capture host；host 用 `getDisplayMedia` 要求幀率，取得 track 尺寸後以 `fitWithinCap` 算目標尺寸，需要時 `applyConstraints`，再依實際尺寸算編碼位元率，`started { …, capture }` 回報實際尺寸／幀率／取樣率／聲道與目標位元率及警告。要求 60 而 track 回報 ≤ 30 時，main 記 log 並送通知「系統只提供 N fps」。
- **B3 保存**：settings.json 升為 version 2（`quality` 區塊），version 1 讀入補預設並保留 outputDir；quality 欄位無效時只重設 quality、保留 outputDir 並記 log。寫入失敗保留原選項並送通知「無法儲存錄製品質設定」。
- **B4 文件**：001 §8、§9、§10.1 與 README 已同步。
- **量測工具**：`pnpm probe -- <mp4>`（`scripts/probe-recording.mjs`，需 `brew install ffmpeg`）印出尺寸、平均 fps、位元率、取樣率、聲道、時長、大小與音訊起始偏移；只在開發用，不打包。

目前的調校起點（待 A2–A4 真機量測後修正）：

| 影像品質 | bits/pixel/frame | 1080p30 | 4K30 |
|---|---|---|---|
| 精省 | 0.07 | 4.4 Mbps | 17.4 Mbps |
| 標準 | 0.13 | 8.1 Mbps（≈ 原本 8 Mbps 基準） | 32.3 Mbps |
| 高品質 | 0.24 | 14.9 Mbps | 59.7 Mbps |

上下界 1.5–60 Mbps；音訊 標準 192 kbps／高品質 256 kbps。

移交 008 的項目（本計畫不再追蹤）：

- A2 用同一素材比較基準與各等級；A3 量成品並比對縮放、音量、失真、聲道、色彩；A4 定出最終係數與上下界（改 `BITS_PER_PIXEL`、`VIDEO_BITRATE_*`）並記錄 CPU；A5 macOS 60 fps 真機驗證，Windows 交 005。
- 使用者確認原先觀察到的畫質與音質差異已改善或有具體剩餘原因；標準為「YouTube 1440p 播放的觀感」。
- §17 第 7 題（HiDPI 邏輯／實體解析度）從 capture log 的 `track size=` 讀出後標「已答」。

## 完成標準（2026-09-13 縮小後）

- 選單選擇、重啟保存、舊設定載入、無效值處理、寫入失敗回饋、錄製中鎖定與下一次生效有單元測試覆蓋。✅
- 每次錄製有 `capture:` log 行：要求設定、track 回報（缺的標未知）、目標位元率、警告。✅
- 檔案保持比例、不放大來源、直向交換長短邊；位元率計算有邊界測試。✅
- 60 fps 僅在 macOS 可選，Windows 停用並說明；明確降級時通知使用者，不只寫 log。✅（開放／停用的最終決定由 008 量測後做）
- 協定 type guard 與舊設定相容性測試；`pnpm check` 通過；兩輪 Codex GPT-6 Astra review 的 findings 全部處置。✅
- 001 §8、§9、§10.1 與 README 已同步。✅

移交 008：比較紀錄、各等級實際參數／大小／CPU、使用者確認品質改善、係數回填、60 fps 決定。本計畫不代替 003、005 的驗收，也不宣告第一版整體發布完成。

## 參考與界線

Cap 原始碼參考版本：8d1c4b41b1e31e70f1525646be70cb82ae98427f。借鏡品質等級與錄製／匯出分層，不直接移植程式碼。

- [錄製品質選單](https://github.com/CapSoftware/Cap/blob/8d1c4b41b1e31e70f1525646be70cb82ae98427f/apps/desktop/src/routes/%28window-chrome%29/settings/quality.tsx)
- [擷取幀率選項](https://github.com/CapSoftware/Cap/blob/8d1c4b41b1e31e70f1525646be70cb82ae98427f/apps/desktop/src/routes/%28window-chrome%29/settings/general.tsx)
- [匯出品質與 BPP](https://github.com/CapSoftware/Cap/blob/8d1c4b41b1e31e70f1525646be70cb82ae98427f/apps/desktop/src/routes/editor/ExportPage.tsx)

不做 Cap 的編輯器、雲端分享、軟體二次編碼或原生 sidecar。只有現有擷取端經調校仍無法滿足品質／同步／效能需求，才評估 Roadmap 第 20 項。
