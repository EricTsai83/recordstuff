# 006 RecordStuff.app 開發包與簽章

狀態：待執行
前置：004
對應：001 里程碑 3

## 目標

讓開發與測試跑的是使用者實際拿到的 RecordStuff.app，而不是通用的 Electron.app，然後完成簽章、公證、安裝檔。

## 為什麼

`pnpm start` 跑的 Electron.app 名字是 Electron、識別碼是 `com.github.Electron`，權限提示與設定頁清單顯示的都是「Electron」，和使用者看到的「RecordStuff」是兩筆不同的權限紀錄。`electron-builder --dir` 會組出完整的 RecordStuff.app 但跳過 DMG 與壓縮，幾秒完成，權限記在 RecordStuff 名下，`LSUIElement`、`NSAudioCaptureUsageDescription` 等 Info.plist 設定也是真的那一份。

## 步驟

1. 加 `pnpm start:app`：`electron-vite build && electron-builder --dir --mac && open dist/mac-arm64/RecordStuff.app`。確認 Dock 沒有圖示、選單列有圖示、log 寫到 `~/Library/Application Support/RecordStuff/logs/`（注意 userData 目錄名從 `recordstuff` 變成 `RecordStuff`）。
2. 用這個 .app 重跑 004。權限提示應顯示「RecordStuff」。
3. Developer ID 簽章：確認 keychain 有憑證、`electron-builder.yml` 的 `hardenedRuntime` 與 entitlements 讓 app 能啟動且能錄。ad-hoc 與正式簽章的 TCC 紀錄分開，簽章後要再授權一次。
4. 公證：設 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，`pnpm dist:mac` 產 DMG，另一台或新使用者帳號安裝，確認 Gatekeeper 不擋、第一次啟動的權限流程與 004 一致。
5. 001 §4「簽章打包後的版本行為與開發版相同」逐項對照。
6. Windows 簽章：有憑證就設 `CSC_LINK`／`CSC_KEY_PASSWORD`；沒有就照 001 §15 出未簽章版並在 README 註明。

## 完成標準

- 001 §4 全部達成，里程碑 3 完成，第一版可發布。
