# 無人值守快捷鍵路徑 — 開發驗收

結論：**blocked**。原生 computer use 已提供按鍵 API，但 Chrome 原生存取被核准檢查拒絕，未能啟動素材或進行本次錄影。僅啟動證據與快捷鍵註冊通過；不代表計畫 016 全面驗收通過。

- 時間：2026-09-19T20:56:42.939034+08:00（Asia/Taipei）。
- 範圍：[plan 016](../../../../plans/016-recording-hotkey.md)，依 [computer-use 技能](../../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 的無人值守段落；未委派。
- 環境：macOS 26.6.2（25G83）、arm64；RecordStuff 0.1.2、Electron 44.3.0。
- HEAD：`e4b24dbd82e0be6ab0761f39c9b8d98761308f30`；工作樹有既有未提交變更，見 [工作樹紀錄](worktree-status.txt)，本次不是發布驗收。
- 產物：`/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app`。
- 啟動來源：協調者在 sandbox 外執行的 `pnpm start:app`，輸出完整複製至 [啟動 log](start-app-016.log)。含建置、自簽、9 個 bundle identity 驗證、Opened 與 `EXIT=0`。本執行者沒有重建或重開 App，也未執行受限制的 ps／pgrep。
- [本次 App log](app-current.log) 僅從最後一行 `start: RecordStuff 0.1.2`（12:53:54.078Z）起；executable 與上述產物一致，12:53:54.132Z 註冊快捷鍵、12:53:54.136Z ready，權限行顯示 capture sees 2 screens。沒有透過程序清單獨立核對副本數量。
- log 中原品質：standard、source、60 fps；輸出資料夾 `/Users/eric/Movies/RecordStuff`。原語言、主螢幕配置、音訊輸出裝置與音量未能從 UI 確認，沒有更改設定。
- 固定素材：`scripts/test-material.html`，SHA-256 `a327547a798cd75f2bc4320fbd670ce107481335eeb47243ea997e03b514b965`；預定 Chrome，實際未開啟素材。

## 案例結果

| 案例 | 操作與預期 | 實際與證據 | 狀態 |
| --- | --- | --- | --- |
| 啟動證據 | 讀取協調者建置／簽章／開啟輸出及本次 ready | 產物路徑吻合，EXIT=0、ready；[啟動](start-app-016.log)、[App](app-current.log) | pass |
| 快捷鍵註冊 | 本次 log 應註冊 ⌘⌥⇧R | `hotkey: registered CommandOrControl+Alt+Shift+R` | pass |
| 動態素材 | 原生點擊開始音訊與全螢幕，確認畫面動態 | 取得 Chrome 即被拒絕；[工具紀錄](computer-use-blocker.txt) | blocked |
| 快捷鍵開始 | 按鍵 API 送 ⌘⌥⇧R，30 秒內 pressed 與 recording | 未送鍵；素材前置受阻，沒有開始 30 秒等待 | blocked |
| 快捷鍵停止與存檔 | 約 10 秒後再按一次，30 秒內 stopping、idle、saved | 本次未開始錄影，沒有 MP4 路徑 | blocked |
| 完整性驗證 | `pnpm verify -- <path> --json <dir>/verify.json` | 無本次 MP4，未執行；[verify.json](verify.json) 為受阻註記，**不是 verify 工具輸出** | blocked |
| 客觀聲音 | 48 kHz、2 聲道、每聲道 RMS > −60 dBFS | Sample rate/channels 與左右 RMS 均無測量值 | blocked |
| QuickTime 播放 | 開啟本次 MP4、原生按播放、進度前進並保存畫面 | 沒有本次 MP4，未開啟／操作播放器，無播放截圖 | blocked |
| 語言與保存 | Tray 切換語言並重開驗證 | 此無人值守路徑依要求排除 Tray；亦禁止重開 App | blocked |
| 顯示最後錄影 | Tray 定位正確錄影並確認 Finder | 此路徑依要求排除 Tray | blocked |
| 錄製中選單狀態 | Tray 確認停止與鎖定設定 | 此路徑依要求排除 Tray | blocked |
| 更改快捷鍵 | Tray 修改、停用及保存 | 此路徑依要求排除 Tray | blocked |
| 主觀聽感 | 實際聆聽 | 未驗，工具未提供聽感證據 | not run |

**計數：pass 2／fail 0／blocked 10／not run 1，共 13 案例。**

## 阻礙與限制

`cua.getState()` 成功，文件明列原生 `Target.pressKey(key: string)` 並支援組合鍵；但 `cua.getApp('com.google.Chrome')` 回覆 `Computer Use was not approved to use Google Chrome`。自動核准檢查拒絕 Chrome 原生操作，原因是未核准 Computer Use 使用該 App。本次未嘗試以其他介面繞過拒絕，也未用 AppleScript／osascript、IPC 或腳本代按。

無本次錄影，不能執行媒體完整性與 RMS 檢查，沒有可保存的播放器截圖。快捷鍵衝突、啟停過渡期重按、設定保存／停用、長時間穩定、同步、音質、首次授權與發布版安裝均未驗證；未將靜態 diff 或既有錄影當作本次行為證據。

## 收尾

本執行者沒有建立錄影或素材分頁，無自己開始的錄影需要停止存檔；沒有新 MP4。QuickTime 在初始工具清單已執行，本次未操作或新開播放器，因此保留既有使用者狀態，未關閉原有 QuickTime。RecordStuff 沒有被退出或重開，本次 log 無新增錄製／停止／退出事件。所有原有錄影與變更保留，沒有修改程式、commit、push 或發布。
