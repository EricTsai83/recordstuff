# 004 乾淨 TCC 下的權限流程測試

狀態：待執行
前置：003（先確認錄製本身可行，再測第一次使用的流程）
後續：006

## 目標

驗證 001 §11 描述的兩個權限流程在「使用者第一次打開 app」的狀態下真的成立，並回答 §17 第 6 題。目前所有測試都是在 Electron.app 已有螢幕錄製權限的機器上做的。

## 步驟

1. 重置兩個權限：
   ```bash
   tccutil reset ScreenCapture com.github.Electron
   tccutil reset AudioCapture com.github.Electron
   ```
2. `pnpm start`。預期：圖示出現、log `state → needsPermission`、一則通知「需要螢幕錄製權限」、右鍵選單第一行灰字加「開啟系統設定」。
3. 觀察啟動時那一次 `getSources` 的效果：macOS 有沒有彈出「Electron 想要錄製這台電腦的螢幕」？Electron 有沒有自動出現在設定頁清單？兩者都沒有，就把 §11 的「零依賴替代」換成 `node-mac-permissions`，記回 001。
4. 點「開啟系統設定」，打開 Electron 的螢幕錄製。回到 app 等 5 秒。預期兩種之一，記下是哪一種：
   - 直接進 `idle`（macOS 不需重啟），或
   - 進 `needsRelaunch`、通知「需要重新啟動」、選單改「重新啟動」；點了之後重啟並進 `idle`。
5. 左鍵點錄製。預期彈出「Electron 想要錄製系統音訊」。先按**拒絕**：應收到 `no_audio_track` 通知，內容指向設定頁，沒有留下檔案。
6. 到設定頁「僅系統音訊錄製」打開 Electron，再點錄製。預期正常開始，不需重啟。
7. 錄製中到設定頁關掉螢幕錄製權限。記錄 app 的行為（macOS 通常會直接終止 app；若沒有，看是否進 `capture_failed` 並保留檔案）。

## 記錄

- §17 第 6 題填「已答」。
- 步驟 3、4 的結果決定 §11 是否要改文字或實作。
- 每次 Electron 升版後這個計畫要重跑一次；升版前先 `tccutil reset`。

## 完成標準

- 步驟 2 到 6 的預期全部成立，或差異已寫回 001 §11 並修正程式。
