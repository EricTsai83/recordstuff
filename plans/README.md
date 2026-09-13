# Plans

每個計畫一個檔案，檔名 `NNN-slug.md`，編號是穩定識別；實際執行順序以本頁依賴為準。開始一個計畫前先在這裡把狀態改成「進行中」，做完改成「已完成」並填日期；計畫內容有變就直接改該檔，不另開版本。

狀態只有四種：**待執行**、**進行中**、**已完成**、**擱置**（寫原因）。

## 目前進度

**001 初始實作、002 檔案 log、007 錄製品質設定、008 錄製驗收工具與量測、003 第一次有聲音的真實錄製已完成。** 003（2026-09-13）：`pnpm matrix -- long` 1080p30 十分鐘 569.6 MB、CPU 平均 17%、結尾漂移 3 ms，錄製時出現 `VTEncoderXPCService` 確認硬體編碼；QuickTime Player 是 `.mp4` 預設 app、開檔與拖曳正常；錄製中 `kill -9` capture host 留下的 `.recording.mp4` 全部影格可解碼、QuickTime 與 Chrome 可播；錄製中「結束」會先停止存檔改名；`REC` 字樣會錄進非全螢幕影片的選單列。001 §17 第 1、2、3、5、8 題 macOS 已答，里程碑 1 的兩題（MP4 可行、當機殘檔可播）答案皆為可行，不需退路。008 先前量到係數維持、60 fps 開放、dual-mono、固有延遲 45–80 ms 不補償。權限、Windows 與發行驗收尚未完成。

**下一個執行項目是 004 乾淨 TCC 下的權限流程測試**：`tccutil reset ScreenCapture com.github.Electron` 後跑第一次授權、系統音訊第二個權限、是否需重啟，回答 §17 第 6 題。使用者仍可自行看 `plans/measurements/2026-09-13.md` 的主觀比對欄並覆寫 Claude 的影格觀察。

## 完成一個計畫後的收尾（每次都要做）

計畫的程式碼與測試通過後，還沒把下面五項做完就不算完成：

1. 該計畫檔第 2 行的「狀態」改成「已完成（日期）」；計畫內容若在執行中有變（範圍、決定、路徑），直接改該檔。
2. 本頁「順序與狀態」表：改狀態與日期、更新備註、標出新的「下一個」，並確認順序欄仍正確。
3. 本頁「目前進度」兩段與「已完成的工作紀錄」表。
4. 根目錄 `README.md`：「目前進度」段落（已完成、進行中、下一步）、「架構一覽」若有新增或刪除檔案、「開發」段落若有新指令或路徑。
5. `plans/001-first-version.md` 若該計畫改變了規格（選單內容、協定、設定 schema、§20 開發流程），同步對應章節。

## 順序與狀態

依執行順序排列，不是依編號。編號只是檔名識別；「順序」欄才是實際先後，狀態改變時要一併檢查這張表的順序是否仍正確。

| 順序 | # | 計畫 | 狀態 | 更新 | 備註 |
|---|---|---|---|---|---|
| 1 | 001 | [初始實作與基本錄製（含產品規格）](001-first-version.md) | 已完成 | 2026-09-12 | 程式骨架、狀態機、檔案寫入、Tray、設定與權限偵測已完成；使用者確認停止後有聲有影。品質、完整驗收與發布工作由 002～007 追蹤 |
| 2 | 002 | [檔案 log](002-file-logging.md) | 已完成 | 2026-09-12 | `src/main/log.ts`：stdout + `app.getPath('logs')/recordstuff.log`（macOS `~/Library/Logs/<app>/`），5 MB 輪替保留 3 個，寫檔失敗不影響 app；main 未捕捉例外寫 log；右鍵選單「顯示 log」 |
| 3 | 007 | [錄製品質與可調設定](007-recording-quality-settings.md) | 已完成 | 2026-09-13 | 範圍縮小為設定能力與診斷：`shared/quality.ts`、Tray「錄製品質」四個單選子選單、settings v2（v1 相容）、`start`/`started` 協定快照與回報、`capture:` log、60 fps 降級通知、`pnpm probe`。係數為未驗證起點，預設輸出同原 8 Mbps／30 fps；量測與回填移交 008 |
| 4 | 008 | [錄製驗收工具與量測流程](008-recording-verification-toolkit.md) | 已完成 | 2026-09-13 | 工具：`pnpm verify`（ffprobe／ffmpeg 對門檻表，結果進 `plans/measurements/`）、`pnpm matrix`（`RECORDSTUFF_AUTORECORD` 自動錄製矩陣 quick／levels／fps／long，含 CPU 取樣）、`scripts/test-material.html`（閃光／beep 同步標記）。`all` 矩陣（約 7 分鐘）有效量測：係數維持、60 fps 開放（檔案約四倍）、CPU 門檻 ≤ 40%、固有延遲 45–80 ms。修了 `getSettings()` 尺寸錯誤（1080p 錄成 1080x606），加 `channelCount: 2`（成品 stereo 但 dual-mono）。主觀比對與 10 分鐘交 003 |
| 5 | 003 | [第一次有聲音的真實錄製](003-first-real-recording.md) | 已完成 | 2026-09-13 | `pnpm matrix -- long` 10 分鐘影像／同步／CPU 各列過（CPU 17%、漂移 3 ms、硬體編碼；音訊位元率列 ❌ 為 beep 素材限制，工具總結因此為 fail）；QuickTime 雙擊／拖曳、當機殘檔可播、錄製中結束、`REC` 會錄進去皆以 AppleScript／`kill -9`／quit event 驗過。§17 第 1、2、3、5、8 題已答。未由人做、延後到 004：點通知開 Finder、內建 Retina 主螢幕的 §17 第 7 題；親眼親耳比對由使用者覆寫 Claude 的影格觀察 |
| 6 | 004 | [乾淨 TCC 下的權限流程測試](004-permission-flow-clean-tcc.md) | 待執行 | 2026-09-13 | **下一個。** 回答 §17 第 6 題；驅動 §11 的最後修正 |
| 7 | 006 | [RecordStuff.app 開發包與簽章](006-dev-app-bundle-and-signing.md) | 待執行 | 2026-09-12 | 里程碑 3 的前半；完成後第一版可發布 |
| 平行 | 005 | [Windows 環境與驗收](005-windows-environment.md) | 待執行 | 2026-09-13 | 環境建置可隨時做；錄製驗收用 007 的設定與 008 的工具。只有 Mac，需先建 VM。006 的 Windows 部分依賴它 |
| — | — | [Roadmap（第一版之後）](roadmap.md) | 擱置 | 2026-09-12 | 第一版發布前不動 |

依賴：002 → 007（設定與診斷）→ 008（驗收工具，並完成 007 遺留的量測與係數回填）→ 003 → 004 → 006。005 的環境建置可隨時進行，錄製驗收使用 007 的設定與 008 的工具，並補 Windows 品質／60 fps 驗證；發布仍須完成兩平台驗收。

001 的執行範圍調整為初始實作與基本錄製，已完成結案；文件繼續保留第一版總規格供後續計畫引用。007 於 2026-09-13 縮小範圍結案，量測移交 008。整體發布尚未完成：002 負責 log、007 負責品質設定、008 負責驗收工具與量測、003／004／005 負責驗收、006 負責打包與發行。007 為已同意提前的第一版品質工作，其餘 Roadmap 項目仍維持第一版之後。

## 已完成的工作紀錄

沒有獨立計畫檔、但已完成並影響後續計畫的工作，記在這裡以免重做。

| 日期 | 工作 | 結果 |
|---|---|---|
| 2026-09-11 | 001 的初始實作（骨架、狀態機、檔案寫入、tray、設定、capture host、協定） | 89 個測試；兩輪獨立 review，17 個 findings 全部處置 |
| 2026-09-11 | MessagePort transfer 實測 | Electron 44.3 transfer ArrayBuffer 會讓 main 卡死，改為複製（001 §9） |
| 2026-09-12 | 權限偵測改為兩段式（借 Cap 的設計） | `permission.ts` 重寫，12 個測試；未授權時觸發系統提示（001 §11） |
| 2026-09-12 | 查明「錄得到但沒聲音」 | macOS 14.2+ 的系統音訊是第二個權限、算在負責程式頭上；加死音軌偵測與 `pnpm start`（001 §11、§20） |
| 2026-09-12 | Windows loopback 無聲時是否斷資料 | 查 Chromium 原始碼：已內建 keepalive，不需自做（001 §17 第 4 題） |
| 2026-09-12 | 002 檔案 log | `createFileLogger`；輪替與寫入失敗各有單元測試；README 補 log 路徑與 `tail -f` |
| 2026-09-12 | 使用者確認基本錄製測通 | 停止後有畫面、有聲音；觀察到影像與音訊品質差距，交由 007 量測。未提供時長、播放器、同步、CPU 或 Windows 驗收數據 |
| 2026-09-13 | 007 程式部分（A1、B1–B4） | `src/shared/quality.ts`（型別、驗證、`fitWithinCap`、位元率公式）、settings.json v2 與 v1 相容、Tray「錄製品質」子選單、`start { quality }`／`started { capture }` 協定、capture log、60 fps 降級通知、`pnpm probe`；152 個測試；兩輪 Codex GPT-6 Astra review，4 個 findings 全部修正。係數為起點，待 008 量測修正 |
| 2026-09-13 | 008 工具（A、B、C） | `scripts/lib/verify.mts` 等 TypeScript 腳本以 Node 24 直接執行；`src/main/autorecord.ts`；`pnpm matrix -- quick` 試跑三段成功寫入 `plans/measurements/2026-09-13.md`（該輪畫面不是素材頁，不算有效量測）；175 個測試。發現：套上限後 `track size=` 是約束值非實際尺寸（1440x1440 vs 成品 1440x810）；macOS loopback 音訊單聲道；靜態內容位元率遠低於目標。同步偵測器以合成檔驗證，偏差約 +10 ms；兩輪 Codex GPT-6 Astra review，7 個 findings 全部修正 |
| 2026-09-13 | 008 第二輪：`levels` 量測與 capture host 尺寸修正 | 1080p × 三等級成品 1080x606，源頭是 `getSettings()` 回報 1920x1920；`src/renderer/capture-host.ts` 新增 `measureFrameSize`（隱藏 `<video>` 讀實際影格），真機 5 秒實錄確認 1920x1080／8.1 Mbps；`pnpm matrix -- all` 縮為約 7 分鐘；177 個測試。CPU 1080p30 平均 15%；音畫偏移固有約 50–60 ms |
| 2026-09-13 | 008 第三輪：`all` 量測與結案 | 九段有效量測；係數 0.07／0.13／0.24 維持（實測 99–100%）；60 fps 開放（57 fps、31 Mbps 為兩倍目標、CPU 23%）；CPU 門檻 ≤ 40%；3 分鐘漂移 3 ms；固有延遲 45–80 ms；`channelCount: 2` 給 stereo 容器但 dual-mono；AAC 夾約 160 k。使用者決定：移除音訊品質選單（固定 256 k 目標）、音畫偏移門檻改採 ITU-R BT.1359（晚 < 125／早 < 45 ms）不補償 |
| 2026-09-13 | 003 驗收（10 分鐘、QuickTime、當機、結束、`REC`） | `pnpm matrix -- long`：600 s、569.6 MB、7.92 Mbps、29.30 fps、掉幀 0.39%、CPU 17%／21%、漂移 3 ms、固有延遲 91 ms；`VTEncoderXPCService` 1.4–1.9% CPU 證實硬體編碼。AppleScript 操作 QuickTime（預設 app）開檔、跳 30%／90%、播放三個檔皆正常；`kill -9` renderer → `capture_host_crashed`、殘檔 17.6 s 全可解碼、QuickTime／Chrome 可播；quit event → 14 ms 內停止存檔改名；`REC` 錄進非全螢幕影片。程式碼無需修改 |
| 2026-09-13 | 使用者決定 `long` 矩陣縮為 3 分鐘 | 10 分鐘已量過一次（3 與 10 分鐘漂移同為 3 ms），之後回歸只跑 3 分鐘；`scripts/run-matrix.mts` 的 `long` 改 180 s、`all` 的漂移段改為引用同一筆，001 §17／§4 檢查表、008 使用方式、README 同步註記 |
| 2026-09-13 | 查 Cap 的驗收方式並寫成 008 | Cap `crates/cap-test` 用真機錄 + ffprobe 對門檻（30 ± 2 fps、掉幀 < 2%、音畫 < 50 ms、時長差 < 100 ms），無 PSNR／SSIM，畫質靠人眼；bpp 常數 0.15／0.30／1.0（錄製）、0.04～0.30（匯出）。007 縮小範圍結案，量測交 008 |
