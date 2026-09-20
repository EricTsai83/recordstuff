# 桌面功能設計

[English](../../system-design/desktop.md) | [繁體中文](desktop.md)

## Tray 與通知

來源：[tray-model.ts](../../../src/main/tray-model.ts)、[tray.ts](../../../src/main/tray.ts)、[index.ts](../../../src/main/index.ts)。

TrayModel 是純函式產物，包含 icon、title、tooltip 與遞迴 menu。AppTray 只把模型映射到 Electron；不保存第二份業務狀態。左鍵呼叫 toggle，右鍵才動態組選單；不使用會攔截左鍵的 `setContextMenu`。[全域快捷鍵](#錄影快捷鍵)呼叫與左鍵相同的 toggle。

| 狀態 | 圖示／標題 | 主要選單與限制 |
| --- | --- | --- |
| needsPermission | idle／空白 | 權限說明、開設定或重啟；可調資料夾、品質與快捷鍵 |
| idle | idle／空白 | 待命或位置不可用；有 lastSavedPath 才能顯示最後錄影；可調資料夾、品質與快捷鍵 |
| starting | idle／`…` | 提醒完成系統提示；品質與快捷鍵鎖定 |
| recording | recording／`REC` | 可停止（已註冊快捷鍵時 tooltip 顯示組合鍵）；資料夾、品質與快捷鍵鎖定 |
| stopping | idle／`…` | 儲存中；品質與快捷鍵鎖定 |

每個狀態都有「語言」、「顯示 log」與「結束」。macOS 使用 template PNG／@2x，Windows 分支使用 ICO；macOS 才顯示圖示旁 title。錄整個螢幕時 `REC` 可能出現在影片，這是目前接受的呈現。

通知文案由純函式產生，通知使用 silent 模式。存檔通知點擊顯示影片；有 partialPath 的失敗通知顯示部分檔；無部分檔時，位置不可用開資料夾選擇、缺權限開系統設定、需要重啟則 relaunch。品質保存失敗與幀率降級只有說明。

macOS 點通知會做兩件事：把回應交給 App，並要求系統啟動發通知的 App；後者約在點擊回呼後 110 ms 才落地。reveal 以 `setImmediate` 立刻請 Finder 選取檔案；若系統隨後把這個無視窗 App 設為前景，Finder 會被壓回使用者原本的視窗後方，看起來什麼都沒發生（v0.1.0 的回報；macOS 26.6 上約三次點擊出現一次，同一程序的第一次點擊很少發生）。計畫 014 因此在 reveal 之後掛一個一次性的 `did-become-active` 監聽，時窗 `ACTIVATION_WINDOW_MS`（1 秒）：啟動若落在時窗內，就從已是前景的 App 再 reveal 一次，讓 Finder 的置前最後落地。log 區分 `reveal requested`、`reveal repeated after activation` 與 `reveal failed`。只有點擊會掛監聽；背景存檔不會碰 Finder。原生通知不支援或 `failed` event 會留下 log。通知是否顯示仍受系統通知設定影響。原生證據由 `pnpm acceptance:notification` 產生（[工具鏈](tooling.md#通知驗收)）。通知縮圖已由使用者於 2026-09-14 重開機後確認正常。

儲存通知由 `SavedNotification` 在檔案完成且回到 idle 後排程：macOS 使用單次 500 ms timer，其他平台立即請求。這讓 macOS 有時間清除擷取造成的通知抑制狀態，但只是依實測選定的啟發式延遲，不是就緒訊號或送達保證；專注模式、其他擷取與通知偏好仍有效。離開 idle（新錄影或進入權限恢復狀態）會永久取消前次待送通知，權限提示優先於舊存檔通知；`before-quit` 取消 timer，也拒絕退出過程中完成的儲存通知。不保留佇列、不重試；請求通知時的例外只記錄日誌，不影響已存檔案。寫檔與 idle 不等待通知。參見[時序證據](../verification/README.md#儲存通知時序2026-09-20)。

## 錄影快捷鍵

來源：[hotkey.ts](../../../src/main/hotkey.ts)、[shared/hotkey.ts](../../../src/shared/hotkey.ts)、[index.ts](../../../src/main/index.ts)。計畫 016 加入全域開始／停止快捷鍵：其他 App 在最前景時也能切換錄製，而且讓沒有視窗的程序有一個系統層級入口，可供無人值守驗收使用。

RecordingHotkey 包裝 Electron `globalShortcut`。按下快捷鍵呼叫與 tray 左鍵相同的 `toggle` 函式，所以 `Recorder.toggle()` 仍是唯一決策點：idle 開始、recording 停止、needsPermission 重發權限通知，starting／stopping 期間忽略。每次按下都先寫 log `hotkey: <accelerator> pressed` 再 toggle。`apply(settings)` 先釋放前一個註冊再註冊新的，更改時不會同時有兩個組合鍵生效；`dispose()` 在 will-quit 執行。

使用者在 tray 的「快捷鍵」子選單選三個 preset 之一或「關閉」（與品質相同，只在 idle／needsPermission 可改）。預設 `CommandOrControl+Alt+Shift+R`（macOS 顯示 ⌘⌥⇧R，其他平台 Ctrl+Alt+Shift+R）。計畫原提案 ⌘⇧R；2026-09-19 衝突檢查發現它是 Chrome／Firefox 的強制重新載入、Safari 的閱讀器、Zoom 的本機錄製，而全域快捷鍵優先於最前景 App，瀏覽器使用者會誤觸開始錄影。三修飾鍵預設在 Chrome、Safari、Firefox、Finder、Xcode、VS Code、Slack、Zoom 均未綁定；⌘⇧R 與 ⌘⌥R 仍列為 preset。自訂錄製快捷鍵的對話框不在範圍內。

OS 拒絕註冊（其他 App 佔用，或 `register` 擲出）不會被吞掉：寫 log `hotkey: registration failed for …`、選單標題顯示「快捷鍵無法使用（被其他 App 佔用）：…」並發通知。設定仍會保存，使用者的選擇在重啟後保留；tray 照常可用。關閉快捷鍵不影響 tray 行為，並記住組合鍵，重新開啟即還原。更改快捷鍵先保存再註冊：寫入失敗保留舊註冊並通知「無法儲存快捷鍵設定」。若寫入期間開始了錄影，註冊變更會延後（`request` → 下一次回到 settled 狀態時 `flush`），讓開始這次錄影的組合鍵仍能停止它；期間選單把已保存的選擇顯示為無法使用。

## 語言

來源：[i18n.ts](../../../src/shared/i18n.ts)。預設為英文 en，不自動沿用 OS 語言；可由 Language／語言選單切換 English 或繁體中文 zh-TW。英文文案為具型別的 key，ZH_TW 對應完整繁體中文模板，translate 代入具名 placeholder。

TrayContext 提供目前語言，通知建立時讀當前 context；已發送的 OS 通知不追溯改寫。語言操作排入 SettingsStore 保存佇列，成功後才更新記憶體與刷新選單，失敗保留舊語言並以原語言通知。錄製中可切換，但不改來源、品質快照、位置或錄製狀態。

選單、tooltip、資料夾對話框、通知與使用者錯誤摘要都有翻譯；技術錯誤細節及開發工具／新量測輸出維持英文，細節留在 log，不混入中文通知。macOS 原生提示跟隨系統語言。

## 螢幕權限

來源：[permission.ts](../../../src/main/permission.ts)。只在 macOS 建立 PermissionWatcher。

1. 每 5 秒及 activate 時檢查 `getMediaAccessStatus('screen')`，不依賴無視窗 App 的 activate 一定出現。
2. 未 granted：清除驗證快取，發 needsPermission；每個程序最多主動呼叫一次 getSources，以便系統註冊與提示。
3. granted 但未驗證：用最多 4 秒的 getSources 查是否有螢幕，避免只相信設定開關。
4. 查得到來源就快取成功；失敗則 needsRelaunch，下次輪詢再驗。重入驗證由 validating 旗標阻止。
5. 擷取實際被拒絕時，main 可呼叫 markRelaunchRequired 清快取；授權被撤回也清快取。

只有狀態改變才通知 Recorder。Recorder 只在 idle／needsPermission 接受權限狀態更新，不以輪詢直接打斷正在錄的 session；實際軌道结束、host 錯誤或 OS 要求退出走錄製管線的收尾。

開系統設定使用固定 ScreenCapture URL，不自動修改 TCC。缺權限選單始終提供重新啟動，因本機曾遇到 OS 回報無法在同程序更新。系統音訊是另一項授權，螢幕 granted 不代表音訊可用；由 renderer 的音軌檢查處理拒絕。首次授權、同程序音訊復原與撤銷測試的證據見 [驗證紀錄](../verification/README.md)。

## 設定與儲存位置

來源：[settings.ts](../../../src/main/settings.ts)、[quality.ts](../../../src/shared/quality.ts)。

```json
{
  "version": 3,
  "outputDir": "/Users/example/Movies/RecordStuff",
  "quality": {
    "videoQuality": "standard",
    "resolutionCap": "source",
    "frameRate": 30
  },
  "language": "en",
  "hotkey": { "enabled": true, "accelerator": "CommandOrControl+Alt+Shift+R" }
}
```

`language` 是相容新增欄位：舊檔未填時預設 en；不支援的值回 en 並記 warning，但保留合法位置與品質。`hotkey.accelerator` 必須是 shared/hotkey.ts 的 preset 之一；v3 檔缺少或不合法的 hotkey 區塊回預設快捷鍵並記 warning，保留其他欄位。`outputDir` 必須是非空絕對路徑。版本 1 可讀，補預設 quality；版本 1／2 補預設快捷鍵（各記 warning），下次保存寫成 v3。整份無效／未知版本／路徑無效回預設並記 log；僅 quality 壞掉則保留合法 outputDir，重設品質。舊 audioQuality 額外欄位不參與目前設定。

保存以 Promise 佇列依「上一份成功提交的設定」合併更新，避免連點遺失前一次修改；先寫 `settings.json.tmp` 再 rename，成功才切換記憶體。單次失敗拒絕自己的 caller，後續儲存仍可執行。這是避免半份 JSON 的策略，不是附帶目錄 fsync 的斷電耐久性保證。

更改位置使用原生選資料夾對話框，macOS 先 focus 以免藏在別的視窗後方。保存設定成功會清除 idle 的位置錯誤旗標並刷新選單；真正能不能寫入於開始錄製時用 probe 驗證。沒有背景自動改存預設位置。

品質與快捷鍵只能在 idle／needsPermission 修改；每個 session 保存自己的品質快照。設定檔即使有其他平台不開放的 60 fps，effectiveQuality 只調整本次有效值，不重寫設定。

## Log 與診斷

來源：[log.ts](../../../src/main/log.ts)。macOS 目前路徑為 `~/Library/Logs/recordstuff/recordstuff.log`；設定為 `~/Library/Application Support/recordstuff/settings.json`。路徑由 Electron app 名稱與 `getPath` 決定，產品顯示名稱仍是 RecordStuff。

每行為 `[UTC ISO 時間] 訊息`。啟動時記 App／Electron／平台版本、outputDir、品質、packaged 與 executable；每次錄製記 session、狀態、capture report、first chunk、saved／failed。Log 含本機路徑，分享診斷前可移除個人路徑；不寫入媒體內容。

所有訊息先送 stdout。檔案在下次追加前若超過 5 MiB，將舊檔依序移到 `.1.log`～`.3.log`；同步寫入方便無視窗 App 即時診斷。檔案寫失敗後本程序停用檔案 log，只報 stderr 一次並繼續 stdout。主程序未捕捉例外另外開錯誤對話框，unhandled rejection 留 log。

「顯示 log」優先選取檔案，不存在則開 logs 資料夾；不影響正在錄製的工作。固定簽章更新後可沿用現有權限，但開發 Electron.app 與安裝 RecordStuff.app 的授權不可混用；排查先核對 executable。
