# 008 錄製驗收工具與量測流程

狀態：待執行
前置：007（設定選單、`capture:` log、`pnpm probe`）
後續：003、005 的錄製驗收改用本計畫的工具與門檻；007 的係數由本計畫的量測回填
對應：001 §14 測試、§17 第 1、2、3、5、7 題；借鏡 Cap `crates/cap-test` 與 `crates/recording/BENCHMARKS.md`

## 問題與目標

真機驗收目前全靠人手：啟動 app、點圖示、看 log、開 QuickTime、對照 Activity Monitor，再把數字抄進計畫檔。每次調一個係數就要重做一輪，003 與 005 也各自要再做一次。Cap 用一個 test runner 把「錄一段 → ffprobe 讀成品 → 對門檻 → 寫結果檔」串起來，並把驗收門檻寫成表格；我們的規模小得多，但同樣需要一套可重複、結果有紀錄的流程。

目標：一條指令跑完一組錄製矩陣並產出結果表，人只負責兩件事——讓螢幕上播著測試素材，以及對成品做主觀比對。工具只在開發環境使用，不隨 app 打包；不做客觀畫質指標（PSNR／SSIM），Cap 也沒做，主觀比對加成本數字已足夠回答我們的問題。

## 驗收門檻

起點取自 Cap 的 BENCHMARKS.md，並依我們的需求調整；A 階段實測後可改，但改動要寫在本檔。

| 指標 | 門檻 | 來源 |
|---|---|---|
| 成品尺寸 | 等於 `capture:` log 的 `track size=`；有上限時 ≤ 上限且比例與來源一致 | 007 |
| 平均幀率（實際張數 ÷ 時長） | 要求值 ± 2 fps；靜態素材不適用，測試素材必須持續動態 | Cap 30 ± 2 |
| 掉幀 | < 2%（以 ffprobe 影格時間戳的間隔異常計） | Cap |
| 音訊與影像時長差 | < 100 ms | Cap |
| 音訊−影像起始偏移 | < 50 ms；超過但穩定則記為固有延遲，交 003 判斷 | Cap 21.5～50 ms |
| 10 分鐘結尾音畫漂移 | < 100 ms | 001 §17 第 5 題 |
| 取樣率／聲道 | 48 kHz、2 聲道，左右聲道皆有能量 | 007 |
| 位元率 | 成品實測位元率在目標的 ±30% 內；超出則記錄 Chromium 實際夾住的值 | 007 |
| CPU | Electron 各程序合計；1080p30 標準等級記錄數字，門檻由第一次量測後定 | 001 §17 第 1 題 |
| 檔案可播 | ffprobe 能解碼全部影格；QuickTime／Chrome 雙擊能播、能拖曳（人工） | 001 §17 第 2 題 |

## A. 驗收腳本（不改 app）

1. `scripts/verify-recording.mjs`：輸入一個或多個 mp4 與 log 檔路徑。從 log 找出對應 session 的 `capture:` 行（以檔名時間戳與 `saved` 行配對），把要求設定、track 回報、目標位元率和 ffprobe 實測放在同一列，逐項對上表門檻標 ✅／❌／—（不適用）。輸出人可讀的表格與一份 JSON。
2. 掉幀與偏移用 `ffprobe -show_frames -select_streams v` 讀 pts；長檔只取頭尾各 60 秒避免太慢。
3. 結果附加到 `plans/measurements/<日期>.md`：機器、OS、Electron 版本、螢幕尺寸、素材、每列數字與判定，以及一段留給人填的主觀比對欄位。這個資料夾是 Cap `BENCHMARKS.md` 的對應物，計畫檔只引用它的結論。
4. `pnpm probe` 保留為單檔快速查看；`pnpm verify -- <mp4...> --log <path>` 是完整驗收。

## B. 自動錄製模式（app 的開發用開關）

1. 環境變數 `RECORDSTUFF_AUTORECORD='{"seconds":30,"quality":{...}}'`：app ready 後自動開始錄製、到時間自動停止、儲存後結束。只在 `!app.isPackaged` 時讀取；打包版忽略。以覆寫 `quality()` 的方式注入設定，不寫 settings.json。
2. `scripts/run-matrix.mjs`：讀一份矩陣（例如 `quick`：1440p 標準／1440p 高品質／原尺寸 標準 192k；`fps`：30 與 60；`long`：10 分鐘一段），逐一 `electron-vite build` 後以 `open` 啟動 app 帶環境變數，等它結束，再對新產生的檔案跑 A 的驗收。每段之間停 10 秒避免熱節流（Cap 的教訓）。
3. 執行期間讀 `ps` 取 Electron 各程序 CPU，取平均與峰值寫進結果。
4. `pnpm start` 現有的 `ELECTRON_RUN_AS_NODE` 清除與 `open` 啟動方式沿用；系統音訊權限仍算在 Electron.app 頭上。

## C. 測試素材與同步標記

1. `scripts/test-material.html`：一頁純靜態 HTML，開在瀏覧器全螢幕當錄製對象。內容：持續捲動的小字文章、紅藍細線與彩色文字（4:2:0 色彩邊緣）、一個每秒移動的方塊（動態與幀率）、右上角每秒閃一次白框並用 WebAudio 同時發一聲短音（左右聲道交替）。
2. 閃光與短音用 `ffmpeg` 的 `blackdetect`／`silencedetect` 反向偵測，或以亮度與音量的時間序列求相關，得到音畫偏移與 10 分鐘漂移；若偵測不穩定，就退回人工對照秒表，並把不穩定的原因記下。
3. 素材頁不放進 app、不上 CSP 名單；只是一個檔案。

## 使用方式（完成後）

```bash
brew install ffmpeg
pnpm verify -- ~/Movies/RecordStuff/*.mp4 --log ~/Library/Logs/recordstuff/recordstuff.log
pnpm matrix -- quick        # 錄三段並驗收，結果進 plans/measurements/
pnpm matrix -- long         # 10 分鐘一段，回答 §17 第 1、5 題
```

跑之前把 `scripts/test-material.html` 開到全螢幕、音量固定；跑完打開結果檔，把並排比對的主觀結論填進去。

## 完成標準

- `pnpm verify` 對一個現有成品能產出對照表與 JSON，門檻判定與上表一致，並有針對假 ffprobe 輸出的單元測試（幀率、偏移、掉幀計算）。
- `pnpm matrix -- quick` 在這台 Mac 能無人值守錄完三段並寫出結果檔；打包版不受 `RECORDSTUFF_AUTORECORD` 影響（有測試）。
- 用工具完成 007 遺留的量測：三個影像等級、兩個音訊等級、60 fps 的實測數字進 `plans/measurements/`，係數與 60 fps 開放決定回填 `src/shared/quality.ts` 與 007 檔；001 §17 第 7 題（HiDPI 尺寸）標「已答」。
- 003、005 的步驟改為引用本工具與門檻，不再各自描述手動流程。
- 執行 `pnpm check`。

## 界線

- 不做 PSNR／SSIM／VMAF；主觀畫質靠並排比對，工具只提供成本與時序數字。
- 不自動操作 Tray；自動錄製走環境變數，不模擬點擊。
- 工具與素材不打包、不進 CSP、不影響正式版行為。
- 不在本計畫內決定是否換原生管線；那是 Roadmap 第 20 項，用本計畫的數字判斷。
