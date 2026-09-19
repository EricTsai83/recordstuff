# 全域快捷鍵開發者檢查（osascript 送鍵，非 computer-use 驗收）

時間：2026-09-19 21:01–21:02 +08:00。macOS 26.6.2 arm64，Electron 44.3.0，RecordStuff 0.1.2 開發建置（工作樹含未提交的 plan 016 變更，HEAD `e4b24db`）。

## 結論

`pnpm start:app` 建置的無視窗 App 在啟動時註冊 `CommandOrControl+Alt+Shift+R`；以 `osascript`（System Events `key code 15 using {command down, option down, shift down}`）送出 ⌘⌥⇧R 兩次，App 依序進入 recording 與 idle 並存檔，`pnpm verify` 完整性層級全部通過，雙聲道均有能量。這證明快捷鍵與 tray 左鍵共用的 toggle 路徑在真實 OS 註冊下可以開始與停止錄影。

**這不是 `astra-acceptance-with-computer-use` 的無人值守驗收。** 同日兩次 Codex GPT-6 Astra computer-use 執行（[20:56](../2026-09-19T205642-computer-use/report.md)、[20:59](../2026-09-19T205941-computer-use/report.md)）都在工具核准層被擋：非互動的自動核准審查拒絕 Computer Use 操作 Chrome、Safari、Finder 與 QuickTime Player，而其 `pressKey` 需要先取得 App 物件，因此完全沒有送鍵。這裡改用 System Events 是開發者的功能檢查，skill 明文不接受它作為 UI 驗收替代；播放器操作與聽感亦未做。

## 步驟與觀察

| 步驟 | 操作 | log／結果 |
| --- | --- | --- |
| 啟動 | 協調者在 sandbox 外執行 `pnpm start:app`（[輸出](start-app.log)，EXIT=0） | `settings: version 2 file: shortcut set to default`、`hotkey: registered CommandOrControl+Alt+Shift+R`、`ready; … hotkey {"kind":"registered",…}`、`permission: granted and capture sees 2 screen(s)` |
| 開始 | 21:01:56 送 ⌘⌥⇧R | `hotkey: CommandOrControl+Alt+Shift+R pressed` → `state → starting` → 0.3 s 後 `state → recording`（track 1920x1080 @ 60 fps）→ first chunk |
| 停止 | 21:02:20 再送 ⌘⌥⇧R | `pressed` → `state → stopping` → `state → idle` → `saved /Users/eric/Movies/RecordStuff/2026-09-19 21-01-56.mp4` |
| 驗證 | `pnpm verify -- <path> --json verify.json`（[verify.json](verify.json)） | 尺寸 1920x1080 ✅；時長 22.9 s ✅；A/V 時長差 3 ms ✅；起始偏移 0 ms ✅；48 kHz 2 聲道 RMS −29.8／−30.1 dB ✅；視訊 28.11 Mbps、音訊 250 kbps ✅；ffprobe 全解碼 ✅；幀率／掉幀為 n/a（非動態素材）；Result ✅ |

完整本次 App log 見 [app.log](app.log)。錄影內容是當時桌面與正在播放的系統音訊，不是 `scripts/test-material.html`；因此幀率、同步與音質門檻不適用，聲道能量只證明有非靜音訊號。

## 未驗證

- computer-use 無人值守路徑（plan 016 第 6 項）：受工具核准限制，兩次執行均 blocked；需在可核准 Computer Use 操作原生 App 的環境重跑。
- Tray 快捷鍵子選單的原生呈現、更改／停用快捷鍵後的重新註冊、衝突時的選單標示與通知：僅由單元測試涵蓋。
- QuickTime 播放、聽感。

## 補充：21:58 切分實驗

互動式 Codex 驗收（[21:33 執行](../2026-09-19T213348-computer-use/report.md)）在 Chrome 已核准、素材播放中的情況下，以 `chrome.pressKey('super+alt+shift+r')` 送鍵，App log 35 秒內沒有 `pressed`，判 fail。為切分根因，對**同一個仍在執行的 App 實例**（PID 64159，21:47:12 啟動）以 System Events 送出同一組合鍵兩次：

| 時間（UTC） | log |
| --- | --- |
| 13:58:18.480 | `hotkey: CommandOrControl+Alt+Shift+R pressed` → `state → starting` → 13:58:18.786 `state → recording` |
| 13:58:22.652 | `hotkey: CommandOrControl+Alt+Shift+R pressed` → `state → stopping` → `state → idle` → `saved /Users/eric/Movies/RecordStuff/2026-09-19 21-58-18.mp4` |

結論：App 的全域快捷鍵註冊與 toggle 路徑正常；失敗來自 Computer Use 的送鍵方式。`Target.pressKey()` 把按鍵投遞給目標 App（Chrome）的程序，Electron `globalShortcut` 監聽的是系統輸入層，收不到只投給某個 App 的事件；System Events 產生的是系統層按鍵，所以能觸發。這不是 RecordStuff 的缺陷，也不是核准問題。skill 的無人值守段落已改為由呼叫者以 System Events 送鍵。
