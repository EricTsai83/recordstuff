# 008 錄製驗收工具與量測流程

狀態：已完成（2026-09-13；工具、`all` 矩陣有效量測、係數與 60 fps 決定、capture host 尺寸與聲道修正皆完成；主觀比對與 10 分鐘 `long` 交 003）
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
| 音訊−影像起始偏移 | 音訊晚 < 125 ms、早 < 45 ms（ITU-R BT.1359 察覺門檻，晚比早耐受）；原本借 Cap 的對稱 50 ms，2026-09-13 實測固有延遲 45–80 ms 後改採標準 | ITU-R BT.1359；Cap 21.5～50 ms |
| 10 分鐘結尾音畫漂移 | < 100 ms | 001 §17 第 5 題 |
| 取樣率／聲道 | 48 kHz、2 聲道，左右聲道皆有能量（注意：此檢查分不出 dual-mono；Electron 44 macOS loopback 實測為 dual-mono） | 007 |
| 位元率 | 成品實測位元率在目標的 ±30% 內；超出則記錄 Chromium 實際夾住的值 | 007 |
| CPU | Electron 各程序合計，平均 ≤ 40%（2026-09-13 定：M1 Pro 1080p30 實測 14–16%、1080p60 23%） | 001 §17 第 1 題 |
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

## 使用方式

```bash
brew install ffmpeg
pnpm verify -- ~/Movies/RecordStuff/*.mp4 --screen 1920x1080   # log 預設讀 ~/Library/Logs/recordstuff/recordstuff.log
pnpm verify -- <mp4> --sync --out                                # 加閃光／短音偵測，並附加到 plans/measurements/<日期>.md
pnpm matrix -- quick     # 1440p 標準／1440p 高品質／原尺寸 標準 192k，各 30 s
pnpm matrix -- levels    # 1080p 精省／標準／高品質（007 §A4）
pnpm matrix -- fps       # 原尺寸 30 與 60 fps（007 §A5）
pnpm matrix -- long      # 1080p 標準 30 fps 3 分鐘（漂移回歸；10 分鐘已於 2026-09-13 量過一次，使用者決定之後以 3 分鐘為準）
caffeinate -dims pnpm matrix -- all   # 一次坐下跑完：三個等級、60 fps、quick 三段各 15 s，加一段 3 分鐘量漂移，約 7 分鐘；caffeinate 讓螢幕不睡、不鎖，人可離開
```

`pnpm matrix` 預設就會做對兩件事，不需要記 flag：用獨立 profile 的 Chrome kiosk 在主螢幕（全域座標 0,0 所在的螢幕，也就是 app 錄的那個）全螢幕開 `scripts/test-material.html?auto=1`，跑完自動關閉；並從 `system_profiler` 讀主螢幕尺寸做比例檢查。要自己開素材頁時加 `--no-open-material`（把頁面開到主螢幕全螢幕並點一下開始）；偵測不到或要覆寫尺寸時加 `--screen WxH`。音量固定、不要同時播其他聲音（silencedetect 需要 beep 之間是靜音）。每段之間休息 10 秒。`--dry-run` 只列出矩陣內容。跑完打開 `plans/measurements/<日期>.md`，把並排比對的主觀結論填進「主觀比對」。

`RECORDSTUFF_AUTORECORD='{"seconds":30,"quality":{"resolutionCap":"1080p"}}'` 也可以自己配合 `pnpm start` 的 `open` 指令使用：`quality` 可以只給部分欄位，缺的補 `DEFAULT_QUALITY`（不是 settings.json 的值，讓矩陣可重現）；只在 `!app.isPackaged` 時讀取；無效值寫一行 `autorecord: ignoring …` 後照常啟動。結束時 log 有 `autorecord: saved <path>` 或 `autorecord: failed: …`。

## 執行紀錄（2026-09-13）

已完成（程式與測試，`pnpm check` 通過）：

- **A 驗收腳本**：`scripts/lib/verify.mts`（純邏輯：`capture:` log 解析與 `saved`／`kept` 配對、ffprobe／ffmpeg 輸出解析、掉幀與偏移計算、門檻判定、文字與 Markdown 輸出）、`scripts/lib/media-tools.mts`（只負責跑 ffprobe／ffmpeg）、`scripts/lib/verify-recording.mts`（單檔驗收流程、環境摘要、附加到 `plans/measurements/<本地日期>.md` 與同名 `.json`）、`scripts/verify-recording.mts`（`pnpm verify` CLI）。長檔只讀頭尾各 60 秒的影格時間戳。`scripts/lib/verify.test.ts` 用假 ffprobe／ffmpeg 輸出測幀率、掉幀、偏移、漂移、聲道能量與各項判定。腳本是 TypeScript，用 Node 24 內建的型別去除直接執行（`.mts`，不經 build），並直接 import `src/shared/quality.ts` 的 `fitWithinCap`，所以上限判定與 app 同一份程式。
- **驗收判定的補強（Codex review pass 1）**：解析度上限用 `fitWithinCap(成品, cap)` 是否等於成品本身判定，不需要 `--screen`；`--screen` 只負責比例。log 配對追蹤每個 session 的 `recorder: session <id> failed:` 標記，`saved` 配最後一個未失敗 session、`kept` 配最早的已失敗 session，避免失敗行晚於下一個 session 的 `capture:` 時配錯。矩陣 runner 只以 log 的 `autorecord: saved <path>` 為成功依據（部分檔 `.recording.mp4` 不算），並多一列「錄製時長 vs 要求秒數 ± 2 s」。Pass 2 再補：沒有 kept 路徑的 `failed:` 行也讓失敗 session 退場；runner 與 `pnpm verify` 讀 log 時把 `recordstuff.1.log` 接在前面、以 inode 判斷錄製中是否輪替，避免跨檔漏掉 `saved`。
- **B 自動錄製**：`src/main/autorecord.ts`（`parseAutoRecord` 驗證環境變數、`runAutoRecord` 走與 Tray 相同的 `toggle`／`stop`，`autorecord:` log），`index.ts` 只在解析成功時以記憶體覆寫 `quality()`，settings.json 不動；打包版一律忽略（有測試）。`scripts/run-matrix.mts`（`pnpm matrix`）：build 一次、`open -W` 啟動並等 app 自己結束、每秒 `ps` 取 Electron 各程序 CPU（用 `realpath` 比對 pnpm 的 `.pnpm/…` 實體路徑）、找新檔跑 A 的驗收（含 `--sync`）、休息 10 秒、附加結果；四個矩陣 `quick`／`levels`／`fps`／`long`。macOS only。
- **C 測試素材**：`scripts/test-material.html`：捲動小字、紅藍 1 px 線與彩色文字、每 4 秒橫掃一次的方塊、右上角 15vmin 黑框每秒 100 ms 白閃 + 同一個 AudioContext 時鐘上每秒 60 ms 的 1 kHz beep（左右交替）。偵測用 `crop` 取黑框內 8% 高的區域跑 `blackdetect`，音訊跑 `silencedetect`，閃光配最近的 beep（±400 ms）取中位數，頭尾 60 秒之差為漂移。用 ffmpeg 合成的已知 30 ms 延遲檔驗證，量到約 40 ms：偵測器約 +10 ms 偏差，判讀時要扣。ffmpeg 在檔尾會把未結束的黑／靜音區間收尾並印出 end，parser 會丟掉距結尾 0.1 s 內的 end，且少於 3 對配對視為無偵測（全黑全靜音檔不會誤判為同步）；尾窗以實際時長錨定最後 60 秒。

第一次試跑（`pnpm matrix -- quick`）的結果與備註在 `plans/measurements/2026-09-13.md`。那一輪 kiosk 開到了第二個螢幕、主螢幕是靜態畫面，**不算有效量測**，但工具流程（自動錄製 → 結束 → 找檔 → 驗收 → 寫檔）已走通，並暴露了三件事：

1. `capture:` log 的 `track size=` 不是實際影格尺寸：套 1440p 上限時回報 1440x1440（成品 1440x810），連原尺寸也回報 1920x1920（成品 1920x1080）；`getSettings()` 的 height 疑似是兩個螢幕中的較大邊。門檻表第一列因此暫時必定 ❌；正確做法是 capture host 改回報實際影格尺寸（例如從第一個 `VideoFrame` 或 `MediaStreamTrackProcessor` 讀），列入 007 回填項目。
2. macOS loopback 系統音訊是**單聲道**（track `channels=1`、成品 1 聲道），與音訊品質設定無關；門檻「2 聲道、左右皆有能量」目前必定 ❌。要決定：要求 `channelCount: 2` 試試、或接受單聲道並改門檻。
3. 位元率門檻「目標 ±30%」對靜態內容不成立（編碼器用不滿目標）；只有在素材頁這種持續動態的畫面上才有意義。音訊 AAC 亦然（靜音時 33–47 kbps）。門檻保留，但判讀時要看素材。

門檻表的調整（依上面）：「成品尺寸」在 `track size=` 修正前，以「≤ 上限且比例與 `--screen` 一致」為主要依據；「取樣率／聲道」在單聲道決定前記錄實測、不作為整體 ❌ 的依據。工具本身維持嚴格判定，讀結果時對照本段。

尚未完成（需要主螢幕空出來、由人啟動，每輪約 2–12 分鐘）：

- ~~`pnpm matrix -- levels`、`fps`、`quick`（正式）、`long`~~ → 第三輪以 `all` 完成；`long` 交 003。
- ~~回填係數、60 fps 決定、§17 第 7 題~~ → 見第三輪表格。
- ~~CPU 門檻~~ → 平均 ≤ 40%。

### 2026-09-13 第二輪：`levels` 有效量測與 capture host 修正

使用者跑 `pnpm matrix -- levels`（1080p × 三等級）成功：素材頁在主螢幕、同步標記偵測到（27–30 對）、CPU 平均 15%／峰值 20%、幀率 29.3、掉幀 ≤ 0.23%、位元率達目標的 98%。但成品是 **1080x606**：`track.getSettings()` 把 1920x1080 主螢幕回報成 1920x1920（另一台直向螢幕的長邊），`fitWithinCap` 據此算出 1080x1080 的約束，Chromium 保持真實比例後輸出 1080x606；位元率也照假尺寸算，「標準 1080p30 ≈ 8 Mbps」實際只給 4.5 Mbps。這是使用者原本感受畫質差的直接原因之一。

修正（`src/renderer/capture-host.ts`）：新增 `measureFrameSize`，把 video track 接到隱藏 `<video>` 讀 `videoWidth`／`videoHeight` 取得實際影格尺寸；`applyQuality` 以實際影格為來源尺寸算上限與位元率，`getSettings()` 只在讀不到影格時作為退路（各有 warning 寫進 `capture:` log）；套用約束成功後再量一次影格（等到等於目標或 1.5 秒逾時），回報實際量到的尺寸；與目標不同或量不到時各寫 warning（Codex review：接受的 max 約束不等於實際送出的尺寸）。測試：回報 1920x1920 而影格 1920x1080 時不再套約束、位元率 8.1 Mbps；量不到影格時退回 `getSettings()` 並警告。這也讓門檻表第一列「成品尺寸 = track size」重新有效。

同一輪的音畫偏移穩定 60–71 ms（音訊晚；扣偵測器約 10 ms 仍超 50 ms），三段一致，記為固有延遲交 003。

### 2026-09-13 第三輪：`pnpm matrix -- all` 有效量測與決定

使用者跑 `caffeinate -dims pnpm matrix -- all`，九段全部成功，結果在 `plans/measurements/2026-09-13.md`「pnpm matrix -- all」一節。結論與決定：

| 項目 | 實測 | 決定 |
|---|---|---|
| 成品尺寸 | 九段皆 1920x1080，等於 `track size=`；log 每段帶 warning「getSettings() 回報 1920x1920，實際影格 1920x1080」 | 尺寸修正有效；門檻表第一列恢復有效 |
| 影像位元率（30 fps） | 精省 4.40／標準 8.05／高品質 14.74 Mbps，各為目標的 100／99／99%；1440p 上限在 1080p 來源上不放大，數字同 1080p | **係數 0.07／0.13／0.24 與上下界維持不變**（編碼器如實遵守；好不好看由主觀比對決定） |
| 60 fps | 57.3 fps（門檻 60 ± 2 差一點）、掉幀 0.23%、CPU 23%、位元率 31.2 Mbps 為目標 16.2 的 193%（Chromium 在 60 fps 給約兩倍） | **macOS 維持開放**；文件標明 60 fps 檔案約為 30 fps 的四倍大（223 vs 58 MB/分：公式因幀率加倍，Chromium 再給約兩倍目標）且位元率不受目標控制；Windows 仍待 005 |
| 幀率 | 30 fps 要求下 29.3 fps，各段一致 | 在門檻內 |
| 掉幀 | 0–0.23% | 通過 |
| 音畫偏移 | 每段內穩定（頭尾差 ≤ 2 ms），段間 56–92 ms，扣偵測器約 10 ms 為 45–80 ms（音訊晚） | **不補償**：ITU-R BT.1359 的察覺門檻是音訊晚 125 ms／早 45 ms，我們在察覺不到的範圍；門檻表改採此標準，這列變 ✅。QuickTime／Loom／Zoom 也不補償，OBS 只提供手動位移欄位 |
| 3 分鐘漂移 | 3 ms | 通過；10 分鐘由 003 用 `pnpm matrix -- long` 補 |
| CPU（M1 Pro） | 1080p30 三等級平均 14–16%、峰值 16–19%；1080p60 平均 23% | 門檻定為**平均 ≤ 40%**（`THRESHOLDS.maxCpuAveragePercent`） |
| 檔案大小 | 1080p30 標準 14.5 MB／15 s ≈ 58 MB/分 ≈ 580 MB/10 分；高品質 ≈ 106 MB/分；60 fps 標準 ≈ 223 MB/分 | 記入 001 §17 第 1 題 |
| 聲道 | 未加約束時 track 與成品皆單聲道。加 `audio: { channelCount: { ideal: 2 } }` 後 track 回報 2、成品 stereo，但左右內容完全相同（左聲道 3 秒→右聲道 3 秒的測試音，兩聲道每一段 RMS 一致）：**dual-mono** | 保留 `channelCount: 2`（`ideal` 不會讓 getDisplayMedia 失敗；將來 Chromium 若給真立體聲即可用），文件與 README 標明系統音訊在 macOS／Electron 44 為單聲道內容；門檻「左右皆有能量」對 dual-mono 會過，無法辨識真立體聲，註記於此 |
| 音訊位元率 | 要求 256 k 實得 160–167 kbps（有內容時）；素材頁 beep 幾乎靜音時 25–42 kbps | Chromium 的 AAC 夾在約 160 k；兩個選項錄出來一樣。**移除「音訊品質」子選單**（Cap／Loom／QuickTime 都沒有此選項；一個選了沒差別的選項是對使用者的錯誤承諾），固定 `AUDIO_BITS_PER_SECOND = 256_000`，舊 settings.json 的 `audioQuality` 照讀忽略、版本不變；`capture:` log 不再印 `audio=`，`pnpm verify` 兩種格式都讀 |
| HiDPI（001 §17 第 7 題） | 本機主螢幕為外接 1:1 顯示器，實際影格 1920x1080 = 邏輯 = 實體 | 部分已答；HiDPI 內建螢幕為主螢幕時再看 `capture:` log 的 `track size=` |

仍交給人／後續計畫的：`plans/measurements/2026-09-13.md` 各段的「主觀比對」欄位（並排看畫質、聽聲音）、QuickTime 雙擊與拖曳、`pnpm matrix -- long` 的 10 分鐘（003 步驟 4–6）。

## 完成標準

- `pnpm verify` 對一個現有成品能產出對照表與 JSON，門檻判定與上表一致，並有針對假 ffprobe 輸出的單元測試（幀率、偏移、掉幀計算）。
- `pnpm matrix -- quick` 在這台 Mac 能無人值守錄完三段並寫出結果檔；打包版不受 `RECORDSTUFF_AUTORECORD` 影響（有測試）。
- 用工具完成 007 遺留的量測：三個影像等級、兩個音訊等級、60 fps 的實測數字進 `plans/measurements/`，係數與 60 fps 開放決定回填 `src/shared/quality.ts` 與 007 檔；001 §17 第 7 題（HiDPI 尺寸）標「已答」。✅（係數維持、60 fps 維持開放並記錄約四倍檔案大小；第 7 題部分已答，HiDPI 內建螢幕待測；主觀比對欄由使用者填，交 003）
- 003、005 的步驟改為引用本工具與門檻，不再各自描述手動流程。
- 執行 `pnpm check`。

## 界線

- 不做 PSNR／SSIM／VMAF；主觀畫質靠並排比對，工具只提供成本與時序數字。
- 不自動操作 Tray；自動錄製走環境變數，不模擬點擊。
- 工具與素材不打包、不進 CSP、不影響正式版行為。
- 不在本計畫內決定是否換原生管線；那是 Roadmap 第 20 項，用本計畫的數字判斷。
