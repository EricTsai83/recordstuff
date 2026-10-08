# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

畫面與聲音，僅此而已。一個選單列 App，把一個螢幕連同系統音訊錄成一般的 MP4。不需要帳號。

[官方網站](https://record.ericts.com) · [下載頁](https://record.ericts.com/download) · [使用說明](https://record.ericts.com/help)（網站為英文）

## 下載

<!-- release-download:start -->
下載 **[RecordStuff 1.7.0：macOS Apple silicon（arm64）](https://github.com/EricTsai83/recordstuff/releases/download/v1.7.0/RecordStuff-1.7.0-arm64-selfsigned.dmg)**（127,479,403 bytes）。[英文發行說明](https://github.com/EricTsai83/recordstuff/releases/tag/v1.7.0) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v1.7.0/SHA256SUMS) · [最新版本](https://github.com/EricTsai83/recordstuff/releases/latest)。

SHA-256：`c0558d1b7c7e34d61da7faf2743ea9e750f4e5e214158cf73f3dea9f968f8702`。

Windows：**[RecordStuff 1.7.0：Windows x64](https://github.com/EricTsai83/recordstuff/releases/download/v1.7.0/RecordStuff-1.7.0-x64-unsigned-setup.exe)**（100,340,338 bytes），未簽章、由 CI 建置；錄影尚未在 Windows 實機上驗證。

SHA-256：`82b51abb658f57dbadb5b7fe9f3e8d49bc4c81f9ebf17c6cbd8bdcb43f374716`。
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

按 **⌥⌘,** 開啟設定：

| 設定 | 選項 | 預設 |
| --- | --- | --- |
| 螢幕 | 主螢幕／已連接螢幕 | 主螢幕 |
| 儲存位置 | 任意資料夾 | 影片 → RecordStuff |
| 倒數 | 關閉／3／5／10 秒，可開倒數音效 | 3 秒，倒數音效開啟 |
| 影像品質 | 精省／標準／高品質 | 標準 |
| 解析度上限 | 1080p／1440p／4K／原尺寸 | 原尺寸 |
| 幀率 | 30／60 fps（60 僅限 macOS） | 30 |
| 快捷鍵 | ⇧⌘1／自訂／關閉 | ⇧⌘1 |
| 點擊圖示 | 開啟選單／開始／停止錄影 | 開啟選單 |
| 語言 | English／繁體中文 | English |

輸出 H.264／AAC MP4。每次擷取一個完整螢幕，沒有麥克風、視窗或區域選擇。影片與設定留在本機；更新檢查不傳送識別碼或遙測。

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

需要 Node ≥22.12；自簽建置需要本機的 `RecordStuff Dev` 簽署憑證。

- [貢獻指南](docs/zh-TW/CONTRIBUTING.md)：開發環境、程式碼導覽、測試與 PR
- [System design](docs/zh-TW/system-design/README.md) · [工具](docs/zh-TW/system-design/tooling.md) · [驗證紀錄](docs/zh-TW/verification/README.md) · [計畫](plans/README.zh-TW.md) · [發布](docs/zh-TW/system-design/releases.md)

## 授權

[MIT](LICENSE)
