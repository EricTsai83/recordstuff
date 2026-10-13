# 072 — App 內播放時 Renderer 的 CPU 用量

[English](072-playback-cpu.md) | [繁體中文](072-playback-cpu.zh-TW.md)

狀態：已規劃，尚未開始排查。建立：2026-10-13。優先順序：下一項。硬性相依：無。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與邊界

查出 RecordStuff 內建播放器播放錄影時，為什麼有一個 renderer 吃掉約 75% 的單核 CPU，並把播放負載降到和其他硬體解碼播放器相近的程度；做不到的話，要寫明原因。成功的標準是：有證據支持的明確原因、修正或書面限制，以及同一支檔案修正前後的播放 CPU 數據。

範圍是 app 內的播放器，也就是 Settings 錄影分頁的播放器和全螢幕播放視窗。除非步驟 3 證明原因出在檔案格式，否則不改錄影、編碼或輸出格式；即使證明了，要不要改錄影也是交給維護者決定的決定點，不在本計畫內直接執行。不放寬既有的 [CPU 預算](../docs/zh-TW/system-design/tooling.md#cpu-預算)。

## 現況與證據

2026-10-13 在維護者的 Mac 上，以已安裝的正式版（`/Applications/RecordStuff.app`，不是開發版）觀察到：

- App 內播放錄影時，Activity Monitor 和 `top` 顯示 renderer PID 40051 用了 74–77% CPU。GPU 程序（29546）只有 1.5% CPU、3.0% GPU，音訊服務 0.5%，主程序 0.2%。當時沒有在錄影：主程序以唯讀開著檔案，檔案大小從 13:26 之後就沒變過。
- 按下暫停後，同一個 renderer 降到 0.0%，其他程序也都是 0 或接近 0。所以負載來自播放，不是計時器或殘留的閒置 renderer。
- 該 renderer 已執行 3 小時 48 分，累計 CPU 時間 19 分 14 秒，平均約 8%。高負載是最近才開始的，與播放的時間吻合。
- 檔案：`~/Movies/RecordStuff/2026-10-13 11-05-02.mp4`，3.14 GB，8467.5 秒；H.264 **Baseline** profile、Level 4.0、yuv420p、BT.709 TV range、1920×1080、無 B 幀、約 3.46 Mbps、time base 1/62500、平均約 19.8 fps（可變影格率）；AAC 約 63 kbps。
- 對正式版 renderer 做 `sample` 時沒有可用的符號，而且主執行緒的取樣數包含等待時間，因此看不出實際在忙的是哪個執行緒、哪段程式。
- Chromium 硬體解碼時，解碼工作在 GPU 程序裡進行。Renderer 很忙、GPU 程序卻幾乎閒置，看起來像是 renderer 在做軟體解碼，但還沒確認。其他可能：影片上方的效果造成每格都要重新合成或重繪（例如 `src/renderer/ui.css:1289` 的 `backdrop-filter`、對話框遮罩的 `backdrop-blur`）；播放帶動的頁面工作（`src/renderer/player/player.tsx` 的 `timeupdate`、`src/renderer/settings/tabs/clip-preview.tsx` 中錄影卡片預覽的 `requestAnimationFrame` 迴圈）；或媒體協定處理 range 請求的方式。
- 目前不知道 PID 40051 是哪個播放器視窗（Settings，或在 Settings 旁隱藏待命的全螢幕頁面），也不知道全螢幕視窗是否有一樣的情況。
- `pnpm measure:cpu` 和 CPU 預算都沒有播放情境，所以這個成本之前不可能被抓到。

### 長錄影存成 fragmented MP4（2026-10-13 補充）

維護者接著回報：當天錄的長影片播放時 CPU 比短影片更高。當天兩支錄影的差別不只是長度，檔案結構也不同：

| 檔案 | 長度 | 頂層 box | `~/Library/Logs/recordstuff/recordstuff.log` 的 `finalize timing` |
| --- | --- | --- | --- |
| `2026-10-13 09-45-57.mp4` | 16 分 53 秒，211 MB | `ftyp`、`mdat`、`moov`（plain） | `finalize 32 ms to plain MP4` |
| `2026-10-13 11-05-02.mp4` | 2 小時 21 分，3.14 GB | `ftyp`、`moov`，之後 8,057 組 `moof`／`mdat`（fragmented） | `finalize 0 ms kept fragmented (track 1 goes back to 0, before its last sample)` |

- 長檔的最後一個 fragment（位元組 3,140,040,590）中，音訊 `traf`（track 1，timescale 48000）**有 0 個 sample、`tfdt` 為 0**，旁邊的影像 `traf` 有 8 個 sample。前一個 fragment 的音訊 `tfdt` 是 406,388,735（8,466 秒）。看起來是 capture host 停止時的最後一次 flush 寫入了一段空的音訊 run。
- `src/main/recording/mp4-finalize.ts` 的 `FragmentIndex.readFragment` 在檢查 sample 數之前，就先用每個 `traf` 的 `tfdt` 呼叫 `align`。`align` 丟出 `goes back to 0`，整個存檔就退回 fragmented。空的 `traf` 不會增加任何 sample，它的 decode time 不該被檢查。
- [存檔時轉成一般 MP4](../docs/zh-TW/system-design/recording.md#存檔時轉成一般-mp4) 已記錄 fragmented 檔在 Chromium 中為何昂貴：播放器要讀完每個 fragment 的標頭（2026-10-10 量到 2,106 個 fragment 需要 1,722 次 range 請求、讀取 358 MB；每次開啟、進度列畫面預覽和全螢幕視窗都會重複），AVFoundation 則完全打不開。這支檔案的 fragment 數將近四倍。這能解釋開啟較慢；是否也能解釋播放**期間**的 CPU，還要量測確認。
- 目前不知道空音訊 run 是只出現在長錄影，還是停止時隨機出現。只檢查了當天這兩支錄影，更早的沒有檢查。
- 已存成 fragmented 的檔案會維持原樣，沒有任何機制會改寫它們。
- 維護者另外回報長檔的兩個症狀：第一個畫面出現前黑屏明顯較久，以及滑鼠停在進度列上時縮圖一直不出現。兩者都符合上述 fragmented 檔的成本：畫面預覽是第二個 video 元素，必須先讀完所有 fragment 標頭才能 seek。步驟 1 要在 fragmented 原檔與 plain 複本上量測第一個畫面和縮圖出現的時間。
- 同一天用 `ffmpeg -c copy` 產生的 plain 複本（`2026-10-13 11-05-02 plain.mp4`，內容相同）在 app 中播放時，renderer 是 **6.1%**，不是 74–77%；GPU 程序為 9.3% CPU、5.6% GPU，原本是 1.5% 與 3.0%。維護者回報開啟與反應都非常快。工作從 renderer 移到了 GPU 程序，表示 fragmented 檔可能是在 renderer 裡解碼或解析，plain 檔則走硬體路徑。所以容器格式是主因；步驟 2 仍要確認解碼器名稱。數據來自 Activity Monitor 截圖，不是 CPU sampler。

## 排查順序

### 0. 讓空的最後 fragment 也能存成 plain MP4

- [ ] 在 `FragmentIndex.readFragment` 中，若某個 `traf` 的 `trun` 都沒有 sample，就略過它的 `tfdt` 檢查，讓空 run 既不對齊、也不讓該 track 失敗。在 `mp4-finalize.test.ts` 加一個案例：最後一個 fragment 的音訊 `traf` 為空且 `tfdt` 為 0；既有的 packet 比對要繼續通過。
- [ ] 對 `2026-10-13 11-05-02.mp4` 的**複本**執行 finalize（索引可以處理已寫完的檔案；不改原檔），確認結果是 plain MP4、packet 用 ffmpeg `framemd5` 比對除修正後的 duration 外都與原檔相同、ffprobe 長度不變，且 AVFoundation 能開啟。
- [ ] 統計輸出資料夾中已存檔錄影有幾支是 fragmented，以及其中有幾支的 `finalize timing` 是這個原因，判斷是否與長度有關。只回報數量，不改寫使用者的檔案。是否要為已存成 fragmented 的檔案提供修復，由維護者決定。

產出：新錄影不會再因為最後一段空的音訊 run 而維持 fragmented；長檔的 plain 複本可供步驟 1 使用。

### 1. 重現並量測基準

- [ ] 用開發版，分別在 Settings 播放器和全螢幕視窗播放同一支檔案（或其複本），各暖機 10 秒後量測至少 60 秒。用 [CPU sampler](../docs/zh-TW/system-design/tooling.md#cpu-預算) 依 Chromium 角色量每個程序，不用 `ps`。暫停與播放分開記錄。
- [ ] 記下播放器在哪個 renderer 裡，以及在 Settings 旁隱藏待命的全螢幕頁面是否也在用 CPU。
- [ ] 參考組：用 QuickTime Player 和 Chrome（單一分頁，`file://` 或本機伺服器）播放同一支檔案，分別量測 CPU。
- [ ] 比較長檔的 fragmented 原檔與步驟 0 產生的 plain 複本：內容相同，CPU 差異就來自容器格式。另外用短的 plain 錄影 `2026-10-13 09-45-57.mp4`，以及重新編碼成 H.264 High profile、固定影格率的檔案（`ffmpeg … -profile:v high -r 30`）重複量測，區分是檔案特性還是播放器造成的。

產出：播放器 × 檔案 × 程序的 CPU 表，附參考播放器數據。

### 2. 確認解碼路徑

- [ ] 在開發版 DevTools 的 Media 面板（或 Chrome 的 `chrome://media-internals`），記錄步驟 1 每支檔案的 `kVideoDecoderName`、`kIsPlatformVideoDecoder` 以及任何 fallback 訊息。
- [ ] 如果用的是軟體解碼器（`FFmpegVideoDecoder` 或其他非平台解碼器），查出為什麼不走硬體路徑：profile、level、影格率或 time base 等檔案特性；主程序設定的命令列參數與功能旗標（`--enable-features`／`--disable-features`）；或 sandbox。和相同 Chromium 版本的 Chrome 比較。
- [ ] 如果用的是平台解碼器（VideoToolbox），進入步驟 3 的繪製分支。

產出：每支檔案使用的解碼器；如果是軟體解碼，附上原因。

### 3. 找出成本所在

- [ ] 軟體解碼分支：依成本由低到高逐一嘗試並量測：如果有安全可用的 Chromium 參數或功能旗標能啟用硬體路徑，先試它；如果協定的回應方式會影響解碼器選擇，改變檔案的提供方式；最後才考慮修改錄影輸出，讓新檔能用硬體解碼。最後這項會改到錄影，所以本計畫會停在這個決定點，交由維護者決定。
- [ ] 繪製分支：錄一段 10 秒播放的 DevTools Performance trace。用繪製統計（paint flashing、layer borders）檢查影片上方是否一直重繪。只在開發版中，一次關掉一項：播放器上的模糊效果、控制列浮層、卡片預覽的動畫迴圈、播放帶動的 React state，並逐項量測。
- [ ] 確定原因後，不在產品中留下診斷用的旗標、log 或樣式覆寫。

產出：原因，以及證明它的量測結果。

### 4. 修正並防止回歸

- [ ] 用能消除成本的最小改動修正，保持播放器的外觀與行為。若需要改變外觀（例如拿掉模糊效果），要先取得維護者同意。
- [ ] 在 `pnpm measure:cpu` 加入播放情境（提議中，尚未存在）：在播放器中播放一支已存檔案 60 秒，依角色判定；門檻依修正後的量測結果和步驟 1 的參考播放器訂定。同步更新預算表及其翻譯。
- [ ] 只在能檢查實際行為時才加單元測試或背景 UI 測試（例如播放器隱藏時動畫迴圈會停止）。CPU 本身由量測檢查，不用 UI 測試檢查。

## 完成條件與驗證界線

完成條件：原因已有證據並寫明；修正或書面限制已落實；兩個播放器修正前後播放同一支檔案的 CPU 數據，連同參考播放器的數據，都已記錄。缺少工具或權限視為 blocked。

步驟 0 改變錄影的存檔方式，所以檢查依測試政策的錄影列：finalize 單元測試，加上一支實際錄影存成 plain MP4 的桌面回合。步驟 1–3 需要用開發版跑桌面回合（在可見視窗中播放、使用 DevTools）。每回合開始前都要依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)確認，並依 `AGENTS.md` 執行 `caffeinate`。修正的檢查依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)：CPU 列（`pnpm check`，以及含新情境的 `pnpm measure:cpu`），加上播放器的背景 UI scope；若維護者同意修改錄影輸出，還要加上錄影相關的列。播放時的音質不在判定範圍內。

撰寫本計畫時只需：檢查連結與錨點、既有與提議中的指令、中英一致與 `git diff --check`；不跑測試、不建置、不啟動 app、不錄影。

結案時，把原因和播放預算寫進 tooling 文件，量測結果連同翻譯記入驗證紀錄，更新兩份索引，並依專案的完成規則移除計畫檔。未經使用者要求，不 commit、push 或發布。
