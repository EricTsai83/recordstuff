# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

畫面與聲音，僅此而已。一個選單列 App，把一個螢幕（預設主螢幕）連同系統音訊錄成一般的 MP4：從選單選「開始錄影」或按 ⌘⇧1 開始，用同樣方式停止。不需要帳號。

## 平台狀態

Electron 支援 Windows、Linux、macOS。**因設備限制，recordstuff 目前只有 macOS 版本經過驗證。** 已測環境為 Apple M1 Pro、macOS 26、Electron 44.3，安裝產物為 arm64。自 1.1.1 之後的第一個版本起，每個版本另附未簽章的 Windows x64 安裝程式，由 CI 建置並檢查，但未在 Windows 實機上驗證：CI 會在 GitHub 的 Windows runner 上靜默安裝與解除安裝，並檢查版本、架構與檔案；螢幕擷取、系統音訊、通知與系統匣在 Windows 上仍未測試，App 的 Windows 文字（例如以「系統匣」取代「選單列」）也一樣。Electron 需要 Windows 10 以上。Windows on Arm、Linux、Intel Mac 與其他 macOS 版本未驗證，也沒有發布版本；現有跨平台程式不代表錄影或安裝已通過。參見 [Electron 平台資訊](https://github.com/electron/electron#platform-support)。

交付目標是可下載的 macOS 自簽 App，以及尚未驗證的 Windows x64 安裝程式；不規劃 Apple 認證／公證與 Windows 程式碼簽章，也不以 Windows／Linux 驗收作為發布條件。

## 下載與安裝

[官方網站](https://record.ericts.com) · [下載頁](https://record.ericts.com/download) · [使用說明](https://record.ericts.com/help)（網站為英文）。

<!-- release-download:start -->
下載 **[RecordStuff 1.4.0：macOS Apple silicon（arm64）](https://github.com/EricTsai83/recordstuff/releases/download/v1.4.0/RecordStuff-1.4.0-arm64-selfsigned.dmg)**（127,442,004 bytes）。[英文發行說明](https://github.com/EricTsai83/recordstuff/releases/tag/v1.4.0) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v1.4.0/SHA256SUMS) · [最新版本](https://github.com/EricTsai83/recordstuff/releases/latest)。

SHA-256：`5dbfccb517c2c8cb26b73aa420e63be1315ed5af1badc5f054e80634a6e9d548`。

Windows：**[RecordStuff 1.4.0：Windows x64](https://github.com/EricTsai83/recordstuff/releases/download/v1.4.0/RecordStuff-1.4.0-x64-unsigned-setup.exe)**（100,316,478 bytes），未簽章、由 CI 建置；錄影尚未在 Windows 實機上驗證。

SHA-256：`572d7cd241e7e231db5758871923d697b0e2d3ae79ab22a41386fad5b7228fa1`。
<!-- release-download:end -->

1.0.0 已由 CI 建置、簽署、發布並重新驗證公開下載。本機錄影與 QuickTime 播放使用該 tag 原始碼檢查；詳見 [1.0.0 證據與未測項目](docs/zh-TW/verification/releases/1.0.0.md)。

下載 arm64 DMG，把 RecordStuff 拖到磁碟映像檔中顯示的 Applications 資料夾；DMG 只有 App 與該 Applications 捷徑。[安裝指南](resources/INSTALL.zh-TW.md)涵蓋首次開啟、手動更新（結束、下載、在相同路徑取代；設定保留）與移除（結束、把 App 移到垃圾桶；錄影、設定與 log 除非自行刪除否則保留）。「設定 → 一般」提供「檢查更新…」與可關閉的啟動檢查（預設開啟，每 24 小時最多一次）。安裝仍需手動完成，macOS 版沒有自動安裝器或解除安裝器。收件者不需要 Node、pnpm、FFmpeg 或憑證。初次安裝或更新若被 macOS 阻擋，請手動開啟「系統設定 → 隱私權與安全性」，往下捲到「安全性」，找到 RecordStuff 並點「強制打開」；提示中的「完成」不會解除封鎖；不保證免提示，參見 [Apple 說明](https://support.apple.com/102445)。

Windows x64 請執行 `RecordStuff-<version>-x64-unsigned-setup.exe`：這是只為目前使用者安裝的一鍵安裝程式，不要求系統管理員權限，會建立「開始」功能表捷徑（Windows 通知需要），並在「設定 → 應用程式 → 已安裝的應用程式」登錄解除安裝程式。它沒有程式碼簽章，SmartScreen 可能顯示「Windows 已保護您的電腦」，請點「其他資訊」再點「仍要執行」。SHA256SUMS 同時列出兩個安裝檔（可在 PowerShell 以 `Get-FileHash` 的輸出與對應那一行比對），`release-win32-x64.json` 記錄安裝程式的資訊，安裝程式另附 GitHub build provenance attestation。更新時從系統匣選單結束 RecordStuff，再下載並執行新的安裝程式；設定與錄影會保留。解除安裝不會刪除錄影、設定或 log。細節與資料位置見[安裝指南](resources/INSTALL.zh-TW.md#windows)。

## 使用方式

1. 從 Applications 啟動，依提示允許螢幕與系統音訊錄製；授權未生效時重啟 App。
2. 在任何 App 中按 **⌘⇧1**，或點選單列圖示並選「開始錄影」，錄影所選螢幕與系統音訊；再按一次快捷鍵或從選單選「停止」即可停止。從「設定 → 錄影設定 → 螢幕」選擇螢幕；預設跟隨主螢幕。想點一下圖示就開始／停止，可在「設定 → 一般 → 點擊圖示」選「開始／停止錄影」（這個選項出現前就在用的人維持此行為）。
3. 預設影片存在 `~/Movies/RecordStuff`；點存檔通知，或從選單選「開啟 RecordStuff」，就能在「錄影檔」看到它（由新到舊），可在那裡播放（全螢幕會佔滿整個螢幕）、拖曳到其他 App，或用卡片的 **⋯** 選單或右鍵在 Finder 中顯示、用其他 App 開啟或丟到垃圾桶。在 Finder 刪除的錄影會立刻從清單消失。
4. 選單（按右鍵一律開啟）只留當下要做的事：開始或停止、未確認的失敗、「開啟 RecordStuff」與結束；儲存位置、log 與已確認的失敗都在 RecordStuff 裡。預設資料夾不存在時，顯示儲存位置會先建立它；不存在的自訂資料夾（例如在未連接的磁碟上）一律不重建，RecordStuff 會說明原因並提供「更改儲存位置」（它擋住錄影時選單也會出現）。開啟 RecordStuff 可連續調整螢幕、錄影品質、語言、外觀、通知、快捷鍵與更新檢查，設定視窗不會因選取而關閉。

**App 預設英文。** 從 **Settings → General → Language → 繁體中文** 切換，選擇會保存；錄影中切換不改動本次擷取設定。診斷日誌維持英文，macOS 原生權限提示依系統語言。

| 設定 | 選項 | 預設 |
| --- | --- | --- |
| 螢幕 | 主螢幕／已連接螢幕 | 主螢幕 |
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps | 30；60 只在 macOS 開放 |
| 快捷鍵 | ⌘⇧1（建議）／自訂快捷鍵／關閉 | ⌘⇧1；被其他 App 佔用時設定視窗會標示 |
| 點擊圖示 | 開啟選單／開始／停止錄影 | 開啟選單；這個選項出現前的設定維持開始／停止錄影 |

從選單選「開啟 RecordStuff」或按 **⌘⌥,** 開啟這些設定。外觀提供跟隨系統／淺色／深色（預設跟隨系統）；通知預設開啟，也需要 macOS 允許。錄影中只能修改語言與外觀，其他設定鎖定。指定螢幕必須可用，App 不會默默改錄其他螢幕。每次擷取一個完整螢幕，沒有麥克風、視窗或區域選擇。

輸出 H.264／AAC MP4。音訊要求 256 kbps，並明確關閉語音處理；本機診斷錄音能保留高頻與左右聲道分離。實際位元率取決於編碼器與內容。擷取時要求的幀率略高於 30 或 60 fps，在測試的 Mac 上實測約 29.9 與 59.8 fps；60 fps 的檔案明顯較大。

## 目前進度與設計

[1.0.0 驗收](docs/zh-TW/verification/releases/1.0.0.md)檢查了 1920×1080 短錄影、存檔完整性與 QuickTime 播放；該輪未測完整原生設定／選單迴歸、主觀聽音、首次授權、長錄影與手動 DMG 安裝。較早的驗證涵蓋 Retina 擷取、權限復原、部分檔案保留、安裝與同身分更新；環境與限制仍記錄於[驗證紀錄](docs/zh-TW/verification/README.md)。

- [System design](docs/zh-TW/system-design/README.md)：產品總覽、架構、錄影流程、桌面功能、函式細節、工具與決策。
- [驗證紀錄](docs/zh-TW/verification/README.md)：已取得證據與限制。
- [剩餘計畫](plans/README.zh-TW.md)：計畫狀態與驗證索引；已完成或取消的計畫已移除。
- [貢獻指南](docs/zh-TW/CONTRIBUTING.md)：開發環境、問題回報、測試與 PR 提交流程。

## 開發

```bash
pnpm install
pnpm start             # 建置並以 macOS open 啟動 Electron.app
pnpm dev               # 熱重載；權限可能歸於啟動它的終端機／編輯器
pnpm start:app         # 建置、自簽、驗證並開啟 recordstuff.app
pnpm open:app          # 驗證並開啟現有開發包，不重建
pnpm check             # typecheck、測試、build
pnpm icons             # 產生圖示；macOS 額外產生 ICNS
pnpm log               # 追蹤 macOS log
pnpm dist:mac    # 自簽 DMG → dist/（發布用的由 CI 建）
pnpm dist:win    # 未簽章 Windows x64 安裝程式 → dist/（發布用的由 CI 建）
```

開發者需有唯一名稱的有效自簽憑證，預設 `RecordStuff Dev`；可用 RECORDSTUFF_SIGN_IDENTITY 精確指定名稱或 SHA-1。重建前先確認 App 是否正在錄影；自己的錄影須先停止存檔，再結束 App。這條流程不公證、不發布；收件者不安裝憑證。`pnpm dist:win` 在 `dist/` 產生未簽章的 Windows x64 NSIS 安裝程式，不走 macOS 簽署流程；發布用的由 CI 在 GitHub 的 Windows runner 上建置並檢查。沒有 Linux 的打包目標。

專案 Node 要求為 ≥22.12，TypeScript 量測工具使用 Node 24。FFmpeg 只供開發驗收：

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm matrix -- all
pnpm audio:quality -- record /tmp/audio-run-001 --repeat 3  # 音質迴歸測試（macOS；會播放測試音）
```

結果存至 `docs/verification/measurements/`（已 gitignore 的本機目錄；整理後的結論寫進[驗證紀錄](docs/zh-TW/verification/README.md)）；matrix 只供 macOS 未打包開發版。long 現為 3 分鐘漂移回歸，10 分鐘基準已完成。詳見 [工具文件](docs/zh-TW/system-design/tooling.md)。

## 目錄

src/main 是生命週期、錄影狀態機、寫檔、權限、原生 UI 與設定視窗；renderer 包含隱藏擷取宿主與設定面板；preload 轉交 MessagePort 並提供設定橋接；shared 是狀態、協定、品質及語言 catalog。scripts 放開發工具，resources 放素材與雙語安裝指南，docs/system-design 是英文正式設計，docs/zh-TW 是翻譯，docs/verification 是證據，plans 只放尚未完成工作，website 是官方網站（Astro，獨立套件，見 docs/zh-TW/system-design/tooling.md）。

影片與設定留在本機；更新檢查會連線至網站的靜態版本 feed，失敗時改查 GitHub Releases，不傳送安裝識別碼或遙測；沒有雲端後端或自動安裝。故障時盡力保留部分影片，不保證所有當機／斷電都可復原。

## 授權

本專案採用 [MIT License](LICENSE)。

音質測試背後的設計與原理：[教學文件](docs/zh-TW/system-design/audio-quality.md)。

發布維護者：先在本機驗證，再推送版本 tag；檢查清單與閘門見 [GitHub 發布自動化](docs/zh-TW/system-design/releases.md)。
