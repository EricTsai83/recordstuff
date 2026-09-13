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
| pnpm icons | PNG／ICO；macOS 額外產 native ICNS |
| pnpm log | 追蹤 macOS log |
| pnpm dist:mac:local | 自簽 App 驗證後封成 dist/local 中的 DMG |

main、preload、renderer 分別建置，打包只納入 out、package metadata 與指定 resources。測試、量測與文件不屬 runtime；App 不呼叫 FFmpeg。

## 簽章與打包

[start-app.mjs](../../../scripts/start-app.mjs) 預設精確挑選 RecordStuff Dev，可用 RECORDSTUFF_SIGN_IDENTITY 的完整名稱或 SHA-1 指定。缺少、重名、過期、非自簽、成品身分不同均停止。憑證用 SHA-1 辨識，下載檔完整性用 SHA-256。

重建前檢查 RecordStuff／本專案 Electron 是否仍執行。子程序環境移除 Apple／CSC 發行變數，停用身分自動搜尋，強制簽章、公證 false、publish never。不重置權限、不匯入私鑰、不發布。

驗證深度 codesign、巢狀 app／framework 公開憑證、identifier、runtime 與最外層 designated requirement；不追 symlink。先驗過 App 才封 DMG。

[local 設定](../../../electron-builder.local.yml) 繼承 [共用設定](../../../electron-builder.yml)，停用公證／timestamp／DMG 簽章與更新 metadata，附兩種安裝說明。檔名為 RecordStuff-版本-架構-selfsigned.dmg，arm64 與 x64 非 universal；目前只有 arm64 驗過。舊 dist:mac 公證設定與 dist:win 不屬目前交付流程；剩餘計畫需把主要入口整理明確。

收件者可能需要單一 App 的「仍要打開」，受管理 Mac 也可能不允許；依 [安裝指南](../../../resources/INSTALL.zh-TW.md) 與 [Apple](https://support.apple.com/102445) 正常操作，不修改全域安全設定。

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
