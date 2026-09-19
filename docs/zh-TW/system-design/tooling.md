# 建置、打包與驗收工具

[English](../../system-design/tooling.md) | [繁體中文](tooling.md)

## 開發流程

專案使用 pnpm，package.json 的 Node 要求為 ≥22.12；TypeScript 量測腳本使用 Node 24 直接執行。FFmpeg／ffprobe 只供開發量測，不隨 App 安裝。

| 指令 | 用途 |
| --- | --- |
| pnpm install | 安裝依賴 |
| pnpm dev | 熱重載；授權對象可能歸於啟動的終端機／編輯器 |
| pnpm start | build 後透過 macOS open 開啟 Electron.app，供音訊測試 |
| pnpm start:app | 建置、自簽、驗證、開啟 RecordStuff.app |
| pnpm open:app | 驗證並開啟既有開發包，不重建 |
| pnpm check | typecheck、完整 Vitest、build |
| pnpm icons | PNG／ICO、DMG 背景圖（1x／2x）；macOS 額外產 native ICNS |
| pnpm log | 追蹤 macOS log |
| pnpm dist:mac | 自簽 App 驗證後封成 dist/local 中的 DMG |

main、preload、renderer 分別建置，打包只納入 out、package metadata 與指定 resources。測試、量測與文件不屬 runtime；App 不呼叫 FFmpeg。

## 資源與產生的輸出

- `build/` 是納入版本控制的打包資源：`icon.png`、macOS 原生 `icon.icns`，以及 DMG 背景 `background.png` 與 Retina 配對 `background@2x.png`（540×380 點）。打包設定以此作為 `buildResources`，明確指定 macOS 使用 ICNS，並用 `tiffutil` 把背景配對合成多解析度 TIFF。請保留；修改圖案後以 `pnpm icons` 重新產生。所有圖像都由程式產生，repo 沒有手繪二進位檔。
- `resources/` 包含執行時使用的選單列圖示、macOS entitlements，以及雙語安裝／更新／移除指南（`INSTALL.md`、`INSTALL.zh-TW.md`）。指南是由 GitHub release 與 README 連結的文件；打包 filter 只複製 PNG／ICO，因此指南不會進入 App 或 DMG。
- `out/` 由 `pnpm build` 產生；`dist/` 放產生的 App 與安裝檔。兩者都由 Git 忽略，可以重新產生。清理 `dist/` 前應保留仍需要的安裝檔；`pnpm open:app` 需要已有的 App bundle。
- `node_modules/` 放已安裝的開發依賴，可透過 `pnpm install` 還原。

品質選項與錯誤碼各自只維護一份常數清單，TypeScript 型別由清單推導，選單也共用品質清單。型別檢查會拒絕未使用的區域變數與參數。設定檔 v1 遷移仍保留，以延續既有的輸出資料夾偏好。

`pnpm signing:create` 保留既有符合名稱的憑證，或依明確輸出位置與密碼建立加密身分檔，見 [身分設定](signing.md)。不匯入私鑰或設定信任。

## 簽章與打包

身分設計、憑證建立／備份、故障排除與待實作 CI 配置，見 [macOS 簽署身分與自簽設計](signing.md)。

[start-app.mjs](../../../scripts/start-app.mjs) 預設精確挑選 RecordStuff Dev，可用 RECORDSTUFF_SIGN_IDENTITY 的完整名稱或 SHA-1 指定。缺少、重名、過期、非自簽、成品身分不同均停止。憑證用 SHA-1 辨識，下載檔完整性用 SHA-256。

重建前檢查 RecordStuff／本專案 Electron 是否仍執行。子程序環境移除 Apple／CSC 發行變數，停用身分自動搜尋，強制簽章、公證 false、publish never。不重置權限、不匯入私鑰、不發布。

驗證深度 codesign、巢狀 app／framework 公開憑證、identifier、runtime 與最外層 designated requirement；不追 symlink。先驗過 App 才封 DMG。

[共用設定](../../../electron-builder.yml) 定義安裝介面：540×380 的 Finder 視窗、程式產生的箭頭背景、128 點圖示，以及恰好兩個項目——App 在 x=130、`/Applications` 連結在 x=410，中心皆在 y=190。[local 設定](../../../electron-builder.local.yml) 繼承它並停用公證／timestamp／DMG 簽章與更新 metadata；不得再加 `dmg.contents`，因為 `extends` 會串接陣列，而發布閘門拒絕 `Applications`、`RecordStuff.app` 與隱藏 Finder 版面檔以外的任何根目錄項目。刻意不附任何格式的說明檔，安裝、更新與移除指引放在線上。檔名為 RecordStuff-版本-架構-selfsigned.dmg，arm64 與 x64 非 universal；目前只有 arm64 驗過。pnpm dist:mac 是發行指令（取代舊的 dist:mac:local 別名）；共用設定停用公證。dist:win 尚未驗證，不代表已支援發行。

收件者可能需要單一 App 的「仍要打開」，受管理 Mac 也可能不允許；依 [安裝指南](../../../resources/INSTALL.zh-TW.md) 與 [Apple](https://support.apple.com/102445) 正常操作，不修改全域安全設定。同一份指南也說明手動更新（結束、下載、在相同 Applications 路徑取代；身分與設定保留）與移除（結束、把 App 移到垃圾桶；錄影、`~/Library/Application Support/recordstuff` 與 `~/Library/Logs/recordstuff` 除非使用者自行刪除否則保留）。沒有解除安裝器、背景服務或自動權限重置。

## 量測工具

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm matrix -- quick
pnpm matrix -- all
pnpm matrix -- long
```

verify 支援多檔、log、來源尺寸、同步標記、Markdown／JSON 與指定 JSON 輸出。結果預設存至 docs/verification/measurements；讀 active log 與最新 .1 archive，以免 session 因輪替無法配對。

matrix 只支援 macOS 開發環境。預設 Chrome kiosk 在主螢幕開素材頁，可用 --no-open-material 自行開；固定音量與來源螢幕。以 RECORDSTUFF_AUTORECORD 驅動未打包 App，打包版忽略。seconds 範圍 (0,3600]，quality override 合併固定預設，不讀使用者品質作為基準。

| 矩陣 | 內容 |
| --- | --- |
| quick | 三段 30 秒：1440p 標準／高品質、原尺寸標準 |
| levels | 三段 30 秒 1080p：精省／標準／高品質 |
| fps | 原尺寸標準 30／60 fps，各 30 秒 |
| long | 180 秒 1080p 標準 30 fps 漂移回歸 |
| all | 縮短至 15 秒的案例加 long，含間隔約七分鐘 |

10 分鐘基準已做過，long 改 3 分鐘是使用者決定，不更改舊結果。

## 驗收門檻

media-tools 呼叫 ffprobe／ffmpeg；verify.mts 純解析／計算／判定；verify-recording.mts 配對與寫結果；CLI／matrix 編排。長片分開取頭尾影格時間戳，不把未取樣中間區間算掉幀。素材頁提供持續動態畫面與同一 audio clock 上的閃光／短音。

| 指標 | 目前專案門檻 |
| --- | --- |
| 尺寸 | 符合 capture report、上限與已知來源比例 |
| 時長 | 有指定時長時 ±2 秒 |
| fps | 要求 ±2 fps；素材需持續動態 |
| 掉幀 | <2% |
| 音訊／影像時長差 | 絕對值 <100 ms |
| 音訊−影像偏移 | 嚴格介於 −45 與 +125 ms |
| 結尾漂移 | 絕對值 <100 ms，需足夠同步標記 |
| 音訊 | 48 kHz、2 聲道；有量時各聲道 RMS >−60 dBFS |
| 碼率 | 要求值 ±30% |
| CPU | Electron 合計平均 ≤40% |
| 解碼 | ffprobe 全影格無錯；播放器操作另驗 |

這些是 THRESHOLDS 常數，不是任意素材的品質保證。缺 ffmpeg 時可能只有格式檢查通過而無能量量測；需讀 notes／n/a。beep 素材碼率低，dual-mono 也會通過雙聲道能量檢查。任一 fail 整體 fail，有 pass 且無 fail 為 pass，全部無法判定則 n/a。

新 log 與量測輸出以英文為主；歷史 raw 記錄保留當時語言與判定，由雙語摘要解釋，不改數字或舊 fail。

## 音質迴歸測試

[音質測試：我們測什麼，為什麼要測](audio-quality.md)完整說明第 2 版素材、數學、門檻理由、迴歸案例與限制。

```bash
pnpm audio:quality -- record /tmp/audio-run-001
pnpm audio:quality -- record /tmp/audio-repeat-001 --repeat 3
pnpm audio:quality -- fixture /tmp/audio-reference-v2.wav
pnpm audio:quality -- verify /absolute/path/recording-of-v2.mp4
```

`record` 建置並驅動真正的開發版程式錄製 16 秒，擷取開始後以 macOS `afplay` 播放 12.1 秒測試音。先結束此專案的開發版程式；需要螢幕／系統音訊權限，以及 FFmpeg／ffprobe。保持輸出裝置與音量固定，暫停其他聲音；工具不更改設定。它會錄製主螢幕，並播放可聽見的聲音。`--repeat` 接受 1–10 次，預設 1 次；需要桌面環境，不能在無桌面的 CI 執行。

使用父目錄已存在的新目錄。每次保存 `reference.wav`、`capture.log`、`report.json`；多次量測分別存入 `run-1`、`run-2` 等子目錄。MP4 留在程式設定的輸出目錄，報告內有路徑。根目錄保存 `summary.json` 與前後環境快照，包括版本、原始碼／素材雜湊，以及能讀取的裝置資訊與音量。摘要提供最小值／中位數／最大值與缺少值數量，不隱藏任何失敗；前後裝置／音量快照改變時標為 invalid。整個 batch 與環境檢查完成前，部分摘要維持 `incomplete`；錯誤另寫入 `error.json`。

`fixture` 產生新 WAV，不覆寫既有檔案。`verify` 輸出 JSON；重新導向 stdout 時，直接用 Node 可避免 pnpm 標頭。只接受第 2 版測試素材的錄音，不適用一般音樂／語音或第 1 版錄音。只解碼前 60 秒，格式檢查不做重新取樣或混成立體聲。自有擷取子程序 60 秒逾時，解碼與外部工具呼叫也有時間界限。

結束碼 0 代表通過，1 代表量測未達門檻，2 代表量測無效或執行／輸入錯誤。PCM／標記不明確時，不輸出缺乏依據的頻率判定。新機制包含頻率擬合、同時 pilot、結尾標記、各成分重疊斷音視窗，以及局部削波／間隔檢查。設計章節解釋所有門檻與保護區；它們都不是經產品全面校準的品質保證。

`pnpm test` 執行正常／劣化 PCM 與多次摘要測試。安裝 FFmpeg／ffprobe 時，也驗證實際 AAC、低通、單聲道／44.1 kHz 與 CLI 契約；缺少工具時明確跳過整合案例。這些對照驗證偵測器，真正的 `record` 才驗證本機程式／OS 路徑。素材或分析器版本變更時，保留[歷史證據](../verification/README.md)原貌。

v0.1.0 已在本機完成瀏覽器下載／安裝驗證，Gatekeeper 需要單一 App 的「仍要打開」放行。詳見[本版證據](../verification/releases/0.1.0.md)。自簽不會消除此首次啟動阻擋；若重新考慮範圍，Developer ID 簽署及 Apple 公證是另一條發行路徑。

乾淨環境安裝依賴後，執行 `node node_modules/electron/install.js` 安裝 Electron 44 runtime（套件沒有 postinstall）。CI 發布流程已包含此步驟，見 [發布自動化](releases.md)。
