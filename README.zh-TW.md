# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

錄、剪、完成。一個選單列 App，把一個螢幕連同系統音訊錄成一般的 MP4，需要時也能加上麥克風與相機；錄完可以剪掉不要的片段，原檔不動。不需要帳號。

[官方網站](https://record.ericts.com) · [下載頁](https://record.ericts.com/download) · [使用說明](https://record.ericts.com/help)（網站為英文）

## 下載

<!-- release-download:start -->
下載 **[RecordStuff 3.0.0：macOS Apple silicon（arm64）](https://github.com/EricTsai83/recordstuff/releases/download/v3.0.0/RecordStuff-3.0.0-arm64-selfsigned.dmg)**（134,009,677 bytes）。[英文發行說明](https://github.com/EricTsai83/recordstuff/releases/tag/v3.0.0) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v3.0.0/SHA256SUMS) · [最新版本](https://github.com/EricTsai83/recordstuff/releases/latest)。

SHA-256：`654f55e322c1eedf9e90d19fdc05d3b98ead38d2b43d84e128a5934b96e9f307`。

Windows：**[RecordStuff 3.0.0：Windows x64](https://github.com/EricTsai83/recordstuff/releases/download/v3.0.0/RecordStuff-3.0.0-x64-unsigned-setup.exe)**（103,351,520 bytes），未簽章、由 CI 建置；錄影尚未在 Windows 實機上驗證。

SHA-256：`8efb8887ff92f93b362f8c1f2e8905c4c2ce0fe5a7b3ec25304e2ca975819570`。
<!-- release-download:end -->

- **macOS**：把 RecordStuff 拖到 Applications。若被阻擋，開啟「系統設定 → 隱私權與安全性」並點「強制打開」（[Apple 說明](https://support.apple.com/102445)）。
- **Windows**：執行安裝程式。若 SmartScreen 警告，點「其他資訊 → 仍要執行」。

更新、移除與資料位置見[安裝指南](resources/INSTALL.zh-TW.md)。

## 平台

| 平台 | 狀態 |
| --- | --- |
| macOS Apple silicon | 已在 M1 Pro、macOS 26 驗證；自簽，未公證 |
| Windows x64 | 安裝程式由 CI 建置並檢查；錄影未在實機驗證；未簽章 |
| Linux、Intel Mac、Windows on Arm | 未驗證，無發布版本 |

## 使用方式

1. 啟動 RecordStuff，允許螢幕與系統音訊錄製。
2. 按 **⇧⌘1**（Windows 為 Ctrl+Shift+1），或從選單列圖示選「開始錄影」，倒數 3 秒後開始錄影；用同樣方式停止。
3. 影片存在 `~/Movies/RecordStuff`（Windows 為 `Videos\RecordStuff`）。點通知或選「開啟 RecordStuff」即可播放、重新命名、在 Finder 中顯示或刪除。
4. 在選單列選單的「錄影時包含」下，勾選每次錄影要包含的內容：「系統聲音」（電腦播放的聲音）、「麥克風」與「相機」；想錄沒有通知音或音樂的旁白解說，就取消勾選「系統聲音」。要調整相機，選「開啟錄影工作室…」。預覽下方一排緊湊按鈕可選擇錄影類型（一般錄影，或 macOS 上的可編輯錄影）、螢幕、相機、系統聲音與麥克風，並標示各自是否開啟；有問題時（例如找不到相機），該按鈕會標示「有問題」，選單裡說明原因。在「相機」按鈕裡還能調整泡泡的大小、圓角與鏡像，泡泡位置則在預覽中拖曳；「即時預覽」會顯示畫面。預覽下方，一般錄影可顯示或隱藏相機、為各個聲音選「不錄製」並調整音量；可編輯錄影會完整保留，錄完後再到「編輯…」調整。相機畫面是畫進影片裡，不會顯示在你的螢幕上。
5. 要傳送錄影，把它的卡片從「錄影檔」分頁拖出去：給出的就是卡片播放的樣子，已套用剪輯、合成相機（按住 ⌥ 拖曳則給出原始檔）。卡片選單的「分享…」另外提供只有聲音、原始檔、無相機影片，以及每條軌道各自的檔案（給剪輯師），並可「拷貝」或「存到…」；在卡片上按 ⌘C 會拷貝它的影片。「編輯…」可剪輯錄影而不改動原檔，其中的「另存副本…」把結果存成你自己的檔案。

按 **⌥⌘,** 開啟設定：

| 設定 | 選項 | 預設 |
| --- | --- | --- |
| 螢幕 | 主螢幕／已連接螢幕 | 主螢幕 |
| 隱藏選單列 | 開啟／關閉；錄影中不出現選單列與其中的圖示，也不錄它在螢幕上方佔住的那一條（僅限 macOS） | 關閉 |
| 隱藏 Dock | 開啟／關閉；錄影中不出現 Dock，Dock 常駐時也不錄它佔住的那一條（僅限 macOS） | 關閉 |
| 隱藏桌面圖示與小工具 | 開啟／關閉；錄影中不出現桌面圖示與小工具（僅限 macOS） | 關閉 |
| 儲存位置 | 任意資料夾 | 影片 → RecordStuff |
| 倒數 | 關閉／3／5／10 秒，可開倒數音效 | 3 秒，倒數音效開啟 |
| 系統聲音 | 開啟／關閉，選單列選單與錄影工作室也可切換；關閉時完全不錄電腦播放的聲音 | 開啟 |
| 麥克風 | 開啟／關閉，選單列選單也可切換；與系統音訊錄在同一條音軌（戴耳機可避免喇叭回音） | 開啟 |
| 輸入裝置 | 跟隨系統／已連接的麥克風 | 跟隨系統 |
| 相機 | 開啟／關閉，選單列選單也可切換；在錄影工作室中調整（尚未在 Windows 上用相機測試） | 開啟 |
| 相機裝置 | 跟隨系統／已連接的相機 | 跟隨系統 |
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps（60 僅限 macOS） | 30 |
| 快捷鍵 | ⇧⌘1／自訂／關閉 | ⇧⌘1 |
| 點擊圖示 | 開啟選單／開始／停止錄影 | 開啟選單 |
| 語言 | English／繁體中文 | English |

「鍵盤快捷鍵」分頁（macOS 也可從「輔助說明」選單開啟）列出所有快捷鍵及目前能否使用。

輸出 H.264／AAC MP4。每次擷取一個完整螢幕，沒有視窗或區域選擇。影片與設定留在本機；更新檢查不傳送識別碼或遙測。

## 開發

```bash
pnpm install
pnpm start        # 建置並開啟開發版
pnpm dev          # 熱重載
pnpm start:app    # 建置、自簽並開啟 recordstuff.app
pnpm check        # typecheck、測試、build
pnpm dist:mac     # 自簽 DMG → dist/
pnpm dist:win     # 未簽章 Windows x64 安裝程式 → dist/
```

需要 Node ≥22.18 與 Rust stable 工具鏈（用來建置原生擷取引擎）；自簽建置需要本機的 `RecordStuff Dev` 簽署憑證。

- [貢獻指南](docs/zh-TW/CONTRIBUTING.md)：開發環境、程式碼導覽、測試與 PR
- [System design](docs/zh-TW/system-design/README.md) · [工具](docs/zh-TW/system-design/tooling.md) · [驗證紀錄](docs/zh-TW/verification/README.md) · [計畫](plans/README.zh-TW.md) · [發布](docs/zh-TW/system-design/releases.md)

## 授權

[MIT](LICENSE)
