# 無人值守快捷鍵路徑（呼叫者以 System Events 送鍵）

驗收模式：**開發驗收**（工作樹有未提交變更）。範圍：[plans/016-recording-hotkey.md](../../../../plans/016-recording-hotkey.md)。執行者直接操作，沒有委派。

快捷鍵開始、停止、MP4 存檔及 QuickTime 播放流程完成；客觀雙聲道非靜音檢查通過。**整體保留 fail：verify 音訊位元率門檻失敗**，不能宣稱整份 verify 通過或發布驗收完成。

案例合計：**pass 9／fail 1／blocked 6／not run 5**。此數量是下方案例表，不是 verify 指標數量。

## 環境與啟動證據

- macOS 26.6.2（25G83），arm64；RecordStuff 0.1.2，Electron 44.3.0。
- HEAD：`e4b24dbd82e0be6ab0761f39c9b8d98761308f30`；[既有工作樹狀態](git-status-before.txt)，[環境與素材 SHA-256](environment.txt)。本次只新增驗收證據，沒有修改程式、設定或計畫，也未執行 check、commit、push、發布。
- 呼叫者建置記錄：[start-app-5.log](start-app-5.log)，EXIT=0，9 個 bundle identities 驗證通過，identifier `com.ericts.record`。其建置開啟路徑是 `dist/mac-arm64/RecordStuff.app`；呼叫者告知隨後複製至 `/Applications/RecordStuff.app` 啟動，本次 App log 的 executable 確認為 `/Applications/RecordStuff.app/Contents/MacOS/RecordStuff`。未重建或重啟，未執行 ps／pgrep，沒有獨立證明不存在其他副本。
- 只以最後一次 `start: RecordStuff 0.1.2`（2026-09-19T15:31:00.880Z）及其後 log 判定：[本次完整片段](app-session.log)。舊啟動與旧 needsPermission 不納入結果。本次 15:31:00.916Z 註冊成功、15:31:00.995Z permission granted，可見 2 個螢幕。
- 原設定唯讀確認：繁體中文、standard、source、60 fps，輸出 `/Users/eric/Movies/RecordStuff`。設定檔 version 2 沒有 hotkey 欄位，實際鍵以本次註冊 log 為準。
- 素材：專案 `scripts/test-material.html`，Chrome 153.0.8010.50。computer use 點擊開始；一次工具回傳 user changed 提示，但重新觀察顯示音訊播放中與全螢幕，計時 33.307 → 43.755 秒；[素材截圖](material-playing.png) 是本次原生截圖。沒有使用 auto 參數或腳本啟動素材。
- 螢幕錄製實際為 1920×1080。音訊輸出裝置與系統音量未取得（唯讀 system_profiler 僅回傳空 Devices）；沒有修改音量。原有 Chrome 影音頁 AX 顯示 play 按鈕；未干預使用者分頁，但未全面證明沒有其他背景聲。音訊證據限於本次成品量測。

## 握手與延遲

**送鍵者是呼叫者，以 System Events 送出 ⌘⌥⇧R，並非 computer use。** 執行者沒有自行 pressKey 全域錄影快捷鍵；computer use 僅用於素材與播放器 UI。

| 事件 | UTC 時間／結果 |
| --- | --- |
| [material-ready](handshake-material-ready) | 2026-09-19T15:35:20.595+00:00 |
| [送鍵 1 原檔](handshake-key-sent-1) | `2026-09-19T15:35:23.3NZ` |
| pressed 1／starting／recording | 15:35:23.663Z／23.665Z／24.014Z |
| [送鍵 2 原檔](handshake-key-sent-2) | `2026-09-19T15:35:33.3NZ` |
| pressed 2／stopping／idle／saved | 15:35:33.894Z／33.895Z／33.917Z／33.918Z |

兩個送鍵檔都存在，且兩次 pressed／狀態轉換均在各 60 秒內；首次送鍵沒有觸及 90 秒 blocked 門檻。從 material-ready 到 pressed 1 為 3.068 秒；pressed 1 到 recording 為 351 ms；pressed 2 到 saved 為 24 ms。

呼叫者送鍵時間的 `.3NZ` 不是有效 ISO 小數秒，**不能精確計算送鍵到 pressed 的毫秒延遲**。只採用可辨識的整秒欄位：pressed 1 相對該秒起點 +663 ms，pressed 2 +894 ms，這兩個數字不是實際延遲。若送鍵發生於各檔記載的那一秒且先於 pressed，延遲範圍分別為 0–663 ms、0–894 ms；這是帶條件的秒級估計。原檔完整保留，精準延遲案例 blocked，未自行修正原始時間。

## 案例結果

| 案例 | 操作與預期 | 實際與證據 | 狀態 |
| --- | --- | --- | --- |
| 建置與啟動身分 | 讀呼叫者 log 與本次 executable | EXIT=0、bundle ID 與 /Applications 路徑相符；非 Tray 驗證 | pass |
| 快捷鍵註冊 | 本次啟動後應 registered | 預設 CommandOrControl+Alt+Shift+R 註冊成功 | pass |
| 錄製權限 | 本次啟動後應 granted | granted and capture sees 2 screen(s) | pass |
| 動態素材 | Chrome 點擊開始，全螢幕與計時前進 | 音訊播放中，33.307 → 43.755 秒；素材截圖 | pass |
| 快捷鍵開始錄製 | 呼叫者送鍵，60 秒內 pressed、recording | pressed 23.663Z、recording 24.014Z | pass |
| 快捷鍵停止存檔 | 呼叫者再送鍵，60 秒內 stopping、idle、saved | 33.895Z → 33.917Z → 33.918Z；新 MP4 已保存 | pass |
| 客觀音訊 | 48 kHz、2 聲道、各 RMS > −60 dBFS | 48000 Hz、2；−25.569713／−24.602274 dBFS | pass |
| verify 完整性層級整體 | 執行指定 pnpm verify 並保留所有指標 | exit 1、verdict fail：音訊 19343 bps 低於 128000 bps 門檻 | fail |
| QuickTime 實際播放 | 原生 UI 播放與進度前進 | 0 → 0.1296 → 8.3589 秒，播放中截圖與 AX 證據 | pass |
| 收尾 | 停止本次錄製、關素材與播放器、保持 App | 已 idle；Escape、關素材分頁；QuickTime App quit；RecordStuff 未關閉 | pass |
| 精準送鍵延遲 | 以有效 UTC 時戳計算毫秒延遲 | 呼叫者兩個檔案的小數格式無效，僅能作條件式秒級估計 | blocked |
| Tray 啟動選單 | 開選單確認待命與主要項目 | 此無人值守路徑依 skill 不存取純 Tray UI | blocked |
| 錄製中選單狀態 | 確認停止操作與鎖定項目 | 需要 Tray，未操作 | blocked |
| 顯示最後錄影／Finder | 經選單定位正確檔案並置前 | 需要 Tray；直接開 QuickTime 不計為此案例通過 | blocked |
| 語言與保存 | 切換語言、重啟確認保存並還原 | 需要 Tray，且本次禁止重啟 | blocked |
| 更改／停用快捷鍵 | UI 選擇 preset、Off 與保存 | 需要 Tray，未操作 | blocked |
| 主觀聽感、音質與聲道分離 | 人耳聽取比較 | 工具未聽取音訊；RMS 不證明上述性質 | not run |
| 動態幀率與掉幀門檻 | moving 模式判定 | 指定命令未帶 --moving，指標 n/a | not run |
| flash/beep 同步與長時間漂移 | --sync 與長錄影 | 未帶 --sync、影片不足 60 秒；容器差值不等於主觀同步 | not run |
| QuickTime 拖曳定位 | 拖曳時間列驗證 seeking | 本次按指定播放路徑完成，未拖曳 | not run |
| 衝突、權限拒絕、首次授權、故障與長錄影 | 其他回歸與故障情境 | 未改權限、未注入故障、未測跨 App 矩陣或發布安裝 | not run |

## MP4 與 verify 細節

影片保留：[2026-09-19 23-35-23.mp4](/Users/eric/Movies/RecordStuff/2026-09-19%2023-35-23.mp4)，38,090,522 bytes，9.8765 秒，H.264 1920×1080／AAC stereo。

命令與完整輸出：[verify-output.txt](verify-output.txt)；[退出碼](verify-exit-code.txt)；[verify.json](verify.json)。使用使用者指定的 `pnpm verify -- <MP4> --json <報告目錄>/verify.json`，沒有追加 `--moving`／`--sync` 或改門檻。

完整性層級：尺寸、時長、容器 A/V 時長差（11 ms）、容器起始差（0 ms）、Sample rate/channels、影片位元率與完整 frame decode 通過；音訊位元率失敗。因此此層級的整份結果是 **fail**。工具說明 AAC 在稀疏音訊下低位元率可能正常，保留該解釋但不抹除失敗，也不據此推斷聽感差。7 個指標 pass、1 fail、5 n/a。

另保留觀測值：56.66 fps、掉幀 1.93%、最大 gap 105.717 ms，未進行動態門檻判定；影片位元率 30.90 Mbps（目標 16.20 Mbps 的 191%，檔案較大）；log 警告 track.getSettings 報 1920×1920，但實際影格確認 1920×1080。

QuickTime 起初 `open -a "QuickTime Player" <MP4>` 回傳 `Unable to find application named 'QuickTime Player'`（exit 1），改以原生工具 bundle ID `com.apple.QuickTimePlayerX` 取得 App，再用原生開檔對話框選取同一 MP4。paste 遇 clipboard timeout 後重新讀狀態，以 setValue 輸入路徑，成功開啟；不以啟動指令錯誤冒充播放失敗。播放按鈕由 off → on，時間列前進；[播放中截圖](quicktime-playing.png)、[起始 AX](quicktime-before.txt)、[播放 AX](quicktime-playing.txt)、[8.36 秒進度 AX](quicktime-progress.txt)。截圖由原生 QuickTime screenshot 保存，畫面內容為錄製素材。

## 收尾與限制

[收尾紀錄](cleanup.txt)：本次錄製已停止保存；Escape 退出素材全螢幕後關閉本次分頁，未關閉原有分頁；QuickTime 正常退出，後續 AX 回 `App quit`。RecordStuff 保持開啟，本次 log 最後状态為 idle，沒有設定需要還原。使用者既有錄影未修改或刪除。

本報告證明的是呼叫者 System Events 與 computer use 分工下的一次短錄影流程，不能推論為 computer use 自行送出全域快捷鍵，也不能推論 Tray、持久化、所有前景 App、音質同步、長期穩定或發布版本通過。計畫 016 與發布紀錄保持原樣，供呼叫者依本次 fail 與 blocked 結果決定後續處理。
