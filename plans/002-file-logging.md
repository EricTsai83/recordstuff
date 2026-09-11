# 002 檔案 log

狀態：待執行
前置：無
後續：003（沒有 log 就看不到 `pnpm start` 的結果）

## 問題

選單列 app 沒有 console。`pnpm start` 與正式版發生問題時，現在唯一的線索是通知文字。開發時要看狀態轉移、session 失敗原因、權限驗證結果，只能改回 `pnpm dev`，但 `pnpm dev` 錄不到系統音訊（001 §20）。

## 做法

- `src/main/log.ts`：`log(message)` 同時寫 stdout 與 `app.getPath('userData')/logs/recordstuff.log`。每行 `ISO 時間 訊息`，和現在的格式相同。
- 輪替：寫入前檢查大小，超過 5 MB 就把 `recordstuff.log` 改名為 `recordstuff.1.log`，`.1` 改 `.2`，最多保留 3 個。同步 `appendFileSync` 即可，量很小。
- 寫檔失敗不能影響 app：catch 後只印 stderr 一次，之後只寫 stdout。
- `index.ts` 現有的 `log()` 改成 import 這個模組；`recorder`、`capture-host`、`permission`、`settings` 已經是注入 `log`，不用改。
- 啟動時寫一行版本、Electron 版本、platform、outputDir。
- 右鍵選單不加「顯示 log」項目（001 §2 沒有這項；需要時記進 roadmap）。

## 完成標準

- `pnpm start` 後 `tail -f ~/Library/Application\ Support/recordstuff/logs/recordstuff.log` 能看到與 `pnpm dev` 相同的輸出。
- 單元測試：輪替（超過上限時的檔名鏈）、寫入失敗不拋錯。
- README 的開發段落補上 log 路徑與 `tail -f` 指令。

## 不做

- 不引入 log 套件、不做 log level、不上傳。
