# RecordStuff

[English](README.md) | [繁體中文](README.zh-TW.md)

選單列上的一個錄影按鈕：點一下錄製主螢幕與系統音訊，再點一下停止並儲存 MP4。沒有一般主視窗，不需要帳號。

## 平台狀態

Electron 支援 Windows、Linux、macOS。**因設備限制，RecordStuff 目前只有 macOS 版本經過驗證。** 已測環境為 Apple M1 Pro、macOS 26、Electron 44.3，安裝產物為 arm64。Windows、Linux、Intel Mac 與其他 macOS 版本未驗證；現有跨平台程式不代表錄製或安裝已通過。參見 [Electron 平台資訊](https://github.com/electron/electron#platform-support)。

交付目標是可下載的 macOS 自簽 App；不規劃 Apple 認證／公證，也不以 Windows／Linux 驗收作為發布條件。

## 下載與安裝

**目前尚未發布公開下載。** 已有本機打包與安裝驗證過的自簽 DMG；[下載版計畫](docs/zh-TW/plans/010-downloadable-macos-release.md) 追蹤新版產物、固定下載入口、checksum 與實際下載檔安裝流程。

發布後下載 arm64 DMG，拖曳到 Applications，依照 [繁體中文安裝說明](resources/INSTALL.zh-TW.md) 操作。收件者不需要 Node、pnpm、FFmpeg 或憑證。未公證 App 首次開啟可能需要在「系統設定 → 隱私權與安全性」選「仍要打開」；不保證免提示，參見 [Apple 說明](https://support.apple.com/102445)。

## 使用方式

1. 從 Applications 啟動，依提示允許螢幕與系統音訊錄製；授權未生效時重啟 App。
2. 左鍵點選單列圖示開始錄製，再點一次停止。
3. 預設影片存在 `~/Movies/RecordStuff`；點存檔通知或用選單尋找檔案。
4. 右鍵可調整品質、位置、語言、顯示 log 或結束。

**App 預設英文。** 從 **Language → 繁體中文** 切換，選擇會保存；錄製中切換不改動本次擷取設定。診斷日誌維持英文，macOS 原生權限提示依系統語言。

| 設定 | 選項 | 預設 |
| --- | --- | --- |
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps | 30；60 只在 macOS 開放 |

輸出 H.264／AAC MP4。音訊要求 256 kbps，並明確關閉語音處理；本機診斷錄音能保留高頻與左右聲道分離。實際位元率取決於編碼器與內容。60 fps 實測約 57 fps 且檔案明顯較大。

## 目前進度與設計

本機已驗證錄製與播放、3456×2234 Retina、權限拒絕與復原、部分檔案保留、自簽 DMG 安裝與同身分更新。通知縮圖已於 2026-09-14 重開機後由使用者確認正常。新語言功能有自動化檢查，下一份安裝包的介面驗證列入交付計畫。

- [System design](docs/zh-TW/system-design/README.md)：產品總覽、架構、錄製流程、桌面功能、函式細節、工具與決策。
- [驗證紀錄](docs/zh-TW/verification/README.md)：已取得證據與限制。
- [剩餘計畫](docs/zh-TW/plans/README.md)：只保留 macOS 下載交付。
- [貢獻與翻譯](docs/zh-TW/CONTRIBUTING.md)：英文正式文件、繁體中文對應版本與 App 翻譯規則。

## 開發

```bash
pnpm install
pnpm start             # 建置並以 macOS open 啟動 Electron.app
pnpm dev               # 熱重載；權限可能歸於啟動它的終端機／編輯器
pnpm start:app         # 建置、自簽、驗證並開啟 RecordStuff.app
pnpm open:app          # 驗證並開啟現有開發包，不重建
pnpm check             # typecheck、測試、build
pnpm icons             # 產生圖示；macOS 額外產生 ICNS
pnpm log               # 追蹤 macOS log
pnpm dist:mac:local    # 自簽 DMG → dist/local
```

開發者需有唯一名稱的有效自簽憑證，預設 `RecordStuff Dev`；可用 RECORDSTUFF_SIGN_IDENTITY 精確指定名稱或 SHA-1。重建前先結束 App。這條流程不公證、不發布；收件者不安裝憑證。既有 dist:mac 與 dist:win 不是目前選用的發行流程。

專案 Node 要求為 ≥22.12，TypeScript 量測工具使用 Node 24。FFmpeg 只供開發驗收：

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm matrix -- all
pnpm audio:quality -- record /tmp/audio-run-001 --repeat 3  # 音質迴歸測試（macOS；會播放測試音）
```

結果存至 `docs/verification/measurements/`；matrix 只供 macOS 未打包開發版。long 現為 3 分鐘漂移回歸，10 分鐘基準已完成。詳見 [工具文件](docs/zh-TW/system-design/tooling.md)。

## 目錄

src/main 是生命週期、錄製狀態機、寫檔、權限與原生 UI；renderer 是隱藏擷取宿主；preload 只轉交 MessagePort；shared 是狀態、協定、品質及語言 catalog。scripts 放開發工具，resources 放素材與雙語安裝指南，docs/system-design 是英文正式設計，docs/zh-TW 是翻譯，docs/verification 是證據，plans 只放尚未完成工作。

影片與設定留在本機；沒有雲端後端、遙測或自動更新。故障時盡力保留部分影片，不保證所有當機／斷電都可復原。

## 授權

本專案採用 [MIT License](LICENSE)。

音質測試背後的設計與原理：[教學文件](docs/zh-TW/system-design/audio-quality.md)。
