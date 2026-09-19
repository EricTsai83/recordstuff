# 無人值守快捷鍵路徑 — 開發驗收

整體結果：**blocked**。原生 computer-use 工具可探索桌面，且文件提供 `pressKey`，但 Chrome、Safari、Finder、QuickTime 的原生存取均遭自動核准拒絕，無法取得按鍵目標。本次沒有送出快捷鍵、沒有新增錄影，不能宣稱全域快捷鍵錄製驗收通過。

驗收時間：2026-09-19 21:18–21:20（Asia/Taipei）。範圍：[plan 016](../../../../plans/016-recording-hotkey.md) 的開始／停止錄製；依[驗收技能](../../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)「無人值守快捷鍵驗收」執行。不委派、不重建、不重啟。

## 環境與啟動證據

- macOS 26.6.2（25G83）、arm64；RecordStuff 0.1.2、Electron 44.3.0。
- HEAD：`e4b24dbd82e0be6ab0761f39c9b8d98761308f30`，有既存未提交的 plan 016 程式及文件變更；不是發布驗收。詳見 [worktree-status.txt](worktree-status.txt)。
- 呼叫者提供的 [start-app-4.log](start-app-4.log)：建置完成、9 個 bundle 簽章身分驗證完成、Opened、EXIT=0。
- 產物：`/Users/eric/personal-project/recordstuff/dist/mac-arm64/RecordStuff.app`。本次啟動 log 的 executable 與此一致；未執行 ps／pgrep，也不把 sandbox 限制當啟動失敗。
- 只採用 [app-current-launch.log](app-current-launch.log) 中 `2026-09-19T13:16:54.168Z start: RecordStuff 0.1.2` 起的行：13:16:54.221Z registered、13:16:54.225Z ready、13:16:54.291Z permission granted。之後沒有 pressed 或錄製狀態行。
- 原設定（唯讀）：繁體中文、standard、source、60 fps、輸出 `/Users/eric/Movies/RecordStuff`。快捷鍵依本次 log 為 `CommandOrControl+Alt+Shift+R`。
- 素材 `scripts/test-material.html` 的 SHA-256 及環境記錄在 [environment.json](environment.json)。素材未開始；主螢幕定位、音訊輸出裝置與音量未驗。

## 案例結果

| 案例 | 操作與預期 | 實際／證據 | 狀態 |
| --- | --- | --- | --- |
| 啟動證據 | 讀呼叫者 log，核對產物及 ready | 簽章驗證、Opened、EXIT=0；本次 log ready 且 executable 相符 | pass |
| 快捷鍵註冊 | 核對本次 registered | `CommandOrControl+Alt+Shift+R` 註冊成功 | pass |
| 原生按鍵可用性 | 取得原生 App 以使用 pressKey | API 存在，但四個原生 App 都拒絕存取；[原始工具訊息](computer-use.txt) | blocked |
| 素材開始 | Chrome，受拒後 Safari；點擊開始並確認動態 | Chrome 與 Safari 均拒絕，未開素材分頁或點擊 | blocked |
| 快捷鍵開始 | 按 ⌘⌥⇧R，30 秒內 pressed、recording | 無可用按鍵目標；未送鍵、未啟動 30 秒等待 | blocked |
| 快捷鍵停止與存檔 | 約 10 秒後再按，30 秒內 stopping、idle、saved | 開始錄製受阻；沒有本次錄影可停止或存檔 | blocked |
| MP4 完整性 | 本次檔案執行 pnpm verify 並保存 JSON | 無本次 MP4，因此未執行 verify；完整性結果不可得 | blocked |
| 客觀聲音 | 48 kHz、2 聲道、各 RMS > −60 dBFS | 素材與錄製受阻；Sample rate/channels、左右 RMS 均 n/a | blocked |
| QuickTime 播放 | 打開本次 MP4、按播放、確認進度、截圖 | 無本次 MP4且 QuickTime 存取遭拒，未開檔或播放 | blocked |
| 語言與保存 | Tray 切換並確認保存 | 此路徑不操作 Tray；亦不重啟 App | blocked |
| 顯示最後錄影 | Tray 定位正確檔案 | 此路徑不操作 Tray | blocked |
| 錄製中選單狀態 | Tray 確認狀態及鎖定項目 | 此路徑不操作 Tray | blocked |
| 更改快捷鍵 | Tray 變更快捷鍵 | 此路徑不操作 Tray | blocked |
| 主觀聽感 | 人工聽取確認 | 未驗 | not run |

**統計：pass 2／fail 0／blocked 11／not run 1（共 14 案例）。** 兩個 pass 僅代表啟動與註冊證據，不代表錄製或 UI 已通過。

## 證據缺口與收尾

本目錄保存啟動 log 副本、本次 App log 片段、computer-use 拒絕訊息、環境與工作樹狀態。沒有本次錄影，所以沒有 `verify.json`；未偽造驗證輸出，也未拿過往影片冒充本次結果。原生 App 無法存取且未播放，所以沒有播放截圖。

未開始任何錄影、未新增素材分頁、未開啟本次 QuickTime 播放視窗；沒有需要停止或存檔的自身錄影。初始 inventory 的 QuickTime 已由使用者開啟，存取遭拒而無法關閉，保持原狀。RecordStuff 未退出或重啟，依本次最後 log 維持 ready；即時 Tray 狀態受阻，沒有聲稱透過 UI 再次確認。既存使用者錄影、App 視窗及設定未改動。

未修改程式、計畫或發布紀錄，未 commit、push 或發布。此結果不能證明動態畫面、系統音訊、聽感、音質、聲道分離、同步、長時間穩定、首次授權或發布版安裝。

解除阻礙需在能核准原生 App 存取的 computer-use 工作階段重新執行；本次自動核准只回傳「Computer Use was not approved to use …」，未提供更詳細理由。未嘗試以其他 UI 自動化繞過拒絕。
