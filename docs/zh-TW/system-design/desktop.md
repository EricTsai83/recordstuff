# 桌面功能設計

[English](../../system-design/desktop.md) | [繁體中文](desktop.md)

## Tray 與通知

來源：[tray-model.ts](../../../src/main/tray-model.ts)、[tray.ts](../../../src/main/tray.ts)、[index.ts](../../../src/main/index.ts)。

TrayModel 是純函式產物，包含 icon、title、tooltip 與一份扁平的指令清單；偏好設定完全不在 tray 裡，所以模型回傳什麼、選單就顯示什麼。AppTray 只把模型映射到 Electron；不保存第二份業務狀態。左鍵呼叫 toggle，右鍵才動態組選單；不使用會攔截左鍵的 `setContextMenu`。[全域快捷鍵](#錄影快捷鍵)呼叫與左鍵相同的 toggle。

| 狀態 | 圖示／標題 | Tray 指令 | 設定視窗中的偏好 |
| --- | --- | --- | --- |
| needsPermission | idle／空白 | 權限說明、開設定或重啟、儲存位置 | 全部可調 |
| idle | idle／空白 | 待命或位置不可用；有 lastSavedPath 才能顯示最後錄影；儲存位置 | 全部可調 |
| starting | idle／`…` | 提醒完成系統提示 | 只有語言 |
| recording | recording／`REC` | 可停止（已註冊快捷鍵時 tooltip 顯示組合鍵）；儲存位置變灰 | 只有語言 |
| stopping | idle／`…` | 儲存中 | 只有語言 |

每個狀態都有「設定」、「顯示 log」與「結束」，而且「設定」永遠可點：哪些偏好被鎖定由面板自己說明。macOS 使用 template PNG／@2x，Windows 分支使用 ICO；macOS 才顯示圖示旁 title。錄整個螢幕時 `REC` 可能出現在影片，這是目前接受的呈現。

通知文案由純函式產生，通知使用 silent 模式。存檔通知點擊顯示影片；有 partialPath 的失敗通知顯示部分檔；無部分檔時，位置不可用開資料夾選擇、缺權限開系統設定、需要重啟則 relaunch。品質保存失敗與幀率降級只有說明。

macOS 點通知會做兩件事：把回應交給 App，並要求系統啟動發通知的 App；後者約在點擊回呼後 110 ms 才落地。reveal 以 `setImmediate` 立刻請 Finder 選取檔案；若系統隨後把這個無視窗 App 設為前景，Finder 會被壓回使用者原本的視窗後方，看起來什麼都沒發生（v0.1.0 的回報；macOS 26.6 上約三次點擊出現一次，同一程序的第一次點擊很少發生）。計畫 014 因此在 reveal 之後掛一個一次性的 `did-become-active` 監聽，時窗 `ACTIVATION_WINDOW_MS`（1 秒）：啟動若落在時窗內，就從已是前景的 App 再 reveal 一次，讓 Finder 的置前最後落地。log 區分 `reveal requested`、`reveal repeated after activation` 與 `reveal failed`。只有點擊會掛監聽；背景存檔不會碰 Finder。原生通知不支援或 `failed` event 會留下 log。通知是否顯示仍受系統通知設定影響。原生證據由 `pnpm acceptance:notification` 產生（[工具鏈](tooling.md#通知驗收)）。通知縮圖已由使用者於 2026-09-14 重開機後確認正常。

`AppTray` 持有每個原生 `Notification`，直到 `click`、`close` 或 `failed`；單純 `show` 不會釋放。退出時關閉尚未處理的通知並清除參照；同步 `show()` 例外也會釋放並記錄。這讓 `show()` 返回後 callback 仍可到達：Electron 44.3.0 的[通知 wrapper](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_notification.cc) 由 GC 管理，解構時會清除原生 delegate。此生命週期修正不代表已證實歷史未送達點擊的原因。不使用 timer 淘汰通知；沒有終止事件的通知會持有到退出。 Windows Action Center 的生命週期未在本次修正或驗證：Windows `close` 可能只是橫幅逾時，歷史通知仍可點擊。

儲存通知由 `SavedNotification` 在檔案完成且回到 idle 後排程：macOS 使用單次 500 ms timer，其他平台立即請求。這讓 macOS 有時間清除擷取造成的通知抑制狀態，但只是依實測選定的啟發式延遲，不是就緒訊號或送達保證；專注模式、其他擷取與通知偏好仍有效。離開 idle（新錄影或進入權限恢復狀態）會永久取消前次待送通知，權限提示優先於舊存檔通知；`before-quit` 取消 timer，也拒絕退出過程中完成的儲存通知。不保留佇列、不重試；請求通知時的例外只記錄日誌，不影響已存檔案。寫檔與 idle 不等待通知。參見[時序證據](../verification/README.md#儲存通知時序2026-09-20)。

圖示的原生 hover 提示保留目前狀態，並加上「右鍵開啟選單」；提示依 App 語言顯示英文或繁體中文。

## 設定視窗

來源：[ui-model.ts](../../../src/main/ui-model.ts)、[settings-model.ts](../../../src/main/settings-model.ts)、[settings-window.ts](../../../src/main/settings-window.ts)、[renderer/settings.ts](../../../src/renderer/settings.ts)。

Tray 只保留必須一鍵可達的指令，所有偏好設定都在同一個獨立的 sandbox 視窗。「設定」會開啟視窗，已開啟則聚焦。macOS 會先讓 App 取得前景，因為沒有 Dock 圖示的 App 單純顯示視窗並不會被帶到最前。變更立即儲存且視窗保持開啟；切換語言會就地更新標籤與標題。關閉視窗（含 Escape 與平台的關閉快捷鍵，這兩個由面板自己處理，因為沒有 Dock 圖示的 App 沒有應用選單）不會結束選單列 App，錄製仍使用獨立的隱藏 renderer。

[settings-model.ts](../../../src/main/settings-model.ts) 只宣告每項偏好一次，配上穩定的群組與選項 id，也是唯一知道某個選項代表什麼的地方；它同時產生面板要畫的 view，以及「這個請求現在允不允許」的答案。Tray 模型是同一份狀態與 context 的兄弟投影，不是面板讀取的來源。

已提交設定由主程序持有，面板只暫存尚未完成的選擇：畫出收到的 view，回傳群組 id 與選項 id，不回傳 action。主程序只接受設定視窗自身 main frame 的請求，依當下重新產生的模型解析這組 id，然後才呼叫與 tray 相同的 action handler，而該 handler 在保存前會再檢查一次錄製狀態。啟動錄製、錄製中與存檔中，除了語言以外的設定在面板與該邊界都會鎖定。保存依請求順序序列化，第二個變更是排隊而不是被回報為失敗。保存期間保留最新選擇，不被較早的回覆或推播蓋掉；所有請求完成後才解除其他控制項的鎖定，顯示實際提交的值，最新選擇未生效時顯示行內訊息；被 OS 拒絕註冊的快捷鍵會保留選取並加上「目前無效」的註解。群組也可以帶 `actions`：渲染在該控制項下方的按鈕，用於同一張卡片內可能凌駕該偏好的系統面板。actions 群組的選項、以及該 `actions` 清單中的選項，都沒有可比對的已提交值，因此由其 handler 以布林值回報自身結果並直接採用；其餘選項仍以「要求的值是否成為已提交值」判定，所以一個什麼都不回報的 handler 永遠無法把未保存的變更變成成功。保存期間正在操作的控制項維持可用、其餘暫時停用，因為停用中的元素無法保有鍵盤焦點。設定 preload 僅提供讀取、選取與變更訂閱；面板在第一份 view 之前唯一可能需要的字串（首次讀取失敗）依主程序寫在頁面 URL 的語言在地化。

「錄影」分頁包含影像品質、解析度上限與幀率，並說明編碼品質與像素尺寸的差異。「一般」包含快捷鍵、語言與更新控制。分頁支援方向鍵、Home 和 End，變更設定後保留目前分頁。更新操作使用按鈕，其完成狀態與偏好儲存分開處理。

## 錄影快捷鍵

來源：[hotkey.ts](../../../src/main/hotkey.ts)、[shared/hotkey.ts](../../../src/shared/hotkey.ts)、[index.ts](../../../src/main/index.ts)。計畫 016 加入全域開始／停止快捷鍵：其他 App 在最前景時也能切換錄製，而且讓沒有視窗的程序有一個系統層級入口，可供無人值守驗收使用。

RecordingHotkey 包裝 Electron `globalShortcut`。按下快捷鍵呼叫與 tray 左鍵相同的 `toggle` 函式，所以 `Recorder.toggle()` 仍是唯一決策點：idle 開始、recording 停止、needsPermission 重發權限通知，starting／stopping 期間忽略。每次按下都先寫 log `hotkey: <accelerator> pressed` 再 toggle。`apply(settings)` 先釋放前一個註冊再註冊新的，更改時不會同時有兩個組合鍵生效；`dispose()` 在 will-quit 執行。

使用者在 「設定」視窗的「快捷鍵」欄位選四個 preset 之一或「關閉」（與品質相同，只在 idle／needsPermission 可改）。預設 `CommandOrControl+Shift+1`（macOS 顯示 ⌘⇧1，其他平台 Ctrl+Shift+1），2026-09-21 由維護者決定。全域快捷鍵優先於最前景 App，因此預設必須是常見 App 都不會預期的組合。最直覺的 ⌘⇧R 因此被否決過兩次：2026-09-19 的衝突檢查發現它是 Chrome／Firefox 的強制重新載入、Safari 的閱讀器、Zoom 的本機錄製，在瀏覽器按下去會變成開始螢幕錄影而不是重新載入。它仍保留為 preset 供需要的人選用。數字鍵是比較安靜的區段 — macOS 以 ⌘⇧3/4/5 佔用截圖與螢幕錄製，而 App 綁定的是不加 Shift 的 ⌘1…9（分頁與檢視模式）— 但 ⌘⇧1 尚未經過同樣逐一 App 的查核，那屬於原生驗收範圍。前一個預設 `CommandOrControl+Alt+Shift+R` 在 2026-09 已驗證於 Chrome、Safari、Firefox、Finder、Xcode、VS Code、Slack 與 Zoom 均未被佔用，現為第一個替代選項。App 曾經提供過的每個組合鍵都保留在 `HOTKEY_PRESETS` 中：`isHotkeyAccelerator` 會拒絕清單外的值，`parseSettings` 隨即回退到預設，因此移除任何一個都會靜默重設選了它的使用者。

OS 拒絕註冊（其他 App 佔用，或 `register` 擲出）不會被吞掉：寫 log `hotkey: registration failed for …`、選單標題顯示「快捷鍵無法使用（被其他 App 佔用）：…」並發通知。設定仍會保存，使用者的選擇在重啟後保留；tray 照常可用。關閉快捷鍵不影響 tray 行為，並記住組合鍵，重新開啟即還原。更改快捷鍵先保存再註冊：寫入失敗保留舊註冊並通知「無法儲存快捷鍵設定」。若寫入期間開始了錄影，註冊變更會延後（`request` → 下一次回到 settled 狀態時 `flush`），讓開始這次錄影的組合鍵仍能停止它；期間選單把已保存的選擇顯示為無法使用。

## 語言

來源：[i18n.ts](../../../src/shared/i18n.ts)。預設為英文 en，不自動沿用 OS 語言；可由 Settings／設定 視窗的 Language／語言欄位切換 English 或繁體中文 zh-TW。英文文案為具型別的 key，ZH_TW 對應完整繁體中文模板，translate 代入具名 placeholder。

TrayContext 提供目前語言，通知建立時讀當前 context；已發送的 OS 通知不追溯改寫。語言操作排入 SettingsStore 保存佇列，成功後才更新記憶體與刷新選單，失敗保留舊語言並以原語言通知。錄製中可切換，但不改來源、品質快照、位置或錄製狀態。

選單、tooltip、資料夾對話框、通知與使用者錯誤摘要都有翻譯；技術錯誤細節及開發工具／新量測輸出維持英文，細節留在 log，不混入中文通知。macOS 原生提示跟隨系統語言。

## 螢幕權限

來源：[permission.ts](../../../src/main/permission.ts)。只在 macOS 建立 PermissionWatcher。

1. 每 5 秒及 activate 時檢查 `getMediaAccessStatus('screen')`，不依賴無視窗 App 的 activate 一定出現。這一段不會跳提示、也不會產生任何物件，所以輪詢很便宜。
2. 未 granted：清除驗證快取，發 needsPermission；每個程序最多主動呼叫一次 getSources，以便系統註冊與提示。
3. granted 但未驗證：用最多 4 秒的 getSources 查是否有螢幕，避免只相信設定開關。
4. 查得到來源就快取成功；失敗則 needsRelaunch，下次輪詢再驗。重入驗證由 validating 旗標阻止。
5. 擷取實際被拒絕時，main 可呼叫 markRelaunchRequired 清快取；授權被撤回也清快取。

只有第一段會被輪詢，而讓這件事安全的正是「第二段成功一次就快取整個程序」。Cap 曾經長期輪詢對應的 macOS 呼叫 `SCShareableContent`（它會實體化系統上每個視窗、App 與顯示器），整個程序生命週期每次呼叫都洩漏，約 15 MB／分鐘，直到 macOS 耗盡 swap（[CapSoftware/Cap issue #2023](https://github.com/CapSoftware/Cap/issues/2023)，於 0.5.9 以「Memory growth while idle on macOS」修正）。這裡採用的就是他們事故後的設計：便宜的 preflight 可以自由輪詢，昂貴的驗證成功一次即快取、失敗重試不快於輪詢週期，連 5 秒與 4 秒兩個常數都相同。執行期撤銷仍由第一段、由擷取嘗試本身、以及實務上 macOS 要求 App 重啟三者抓到。

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
  "hotkey": { "enabled": true, "accelerator": "CommandOrControl+Shift+1" },
  "notifications": true
}
```

`language` 是相容新增欄位：舊檔未填時預設 en；不支援的值回 en 並記 warning，但保留合法位置與品質。`hotkey.accelerator` 必須是 shared/hotkey.ts 的 preset 之一；v3 檔缺少或不合法的 hotkey 區塊回預設快捷鍵並記 warning，保留其他欄位。`outputDir` 必須是非空絕對路徑。版本 1 可讀，補預設 quality；版本 1／2 補預設快捷鍵（各記 warning），下次保存寫成 v3。整份無效／未知版本／路徑無效回預設並記 log；僅 quality 壞掉則保留合法 outputDir，重設品質。舊 audioQuality 額外欄位不參與目前設定。`notifications` 與 `updates` 同屬相容新增欄位：缺少或非布林值一律讀為 `true` 且不記 warning，因為在這個開關存在之前寫下的檔案並不是壞檔。

保存以 Promise 佇列依「上一份成功提交的設定」合併更新，避免連點遺失前一次修改；先寫 `settings.json.tmp` 再 rename，成功才切換記憶體。單次失敗拒絕自己的 caller，後續儲存仍可執行。這是避免半份 JSON 的策略，不是附帶目錄 fsync 的斷電耐久性保證。

更改位置使用原生選資料夾對話框，macOS 先 focus 以免藏在別的視窗後方。保存設定成功會清除 idle 的位置錯誤旗標並刷新選單；真正能不能寫入於開始錄製時用 probe 驗證。沒有背景自動改存預設位置。

品質與快捷鍵只能在 idle／needsPermission 修改；每個 session 保存自己的品質快照。設定檔即使有其他平台不開放的 60 fps，effectiveQuality 只調整本次有效值，不重寫設定。

## Log 與診斷

來源：[log.ts](../../../src/main/log.ts)。macOS 目前路徑為 `~/Library/Logs/recordstuff/recordstuff.log`；設定為 `~/Library/Application Support/recordstuff/settings.json`。路徑由 Electron app 名稱與 `getPath` 決定，產品顯示名稱仍是 RecordStuff。

每行為 `[UTC ISO 時間] 訊息`。啟動時記 App／Electron／平台版本、outputDir、品質、packaged 與 executable；每次錄製記 session、狀態、capture report、first chunk、saved／failed。Log 含本機路徑，分享診斷前可移除個人路徑；不寫入媒體內容。

所有訊息先送 stdout。檔案在下次追加前若超過 5 MiB，將舊檔依序移到 `.1.log`～`.3.log`；同步寫入方便無視窗 App 即時診斷。檔案寫失敗後本程序停用檔案 log，只報 stderr 一次並繼續 stdout。主程序未捕捉例外另外開錯誤對話框，unhandled rejection 留 log。

「顯示 log」優先選取檔案，不存在則開 logs 資料夾；不影響正在錄製的工作。固定簽章更新後可沿用現有權限，但開發 Electron.app 與安裝 RecordStuff.app 的授權不可混用；排查先核對 executable。

## 官方網站

網站（[website/](../../../website/)，見[工具](tooling.md#官方網站)）依維護者決定只有英文；App UI 與 repo 指南維持雙語，頁尾連到繁體中文安裝指南。2026-09-20 在同一份內容層上建了三種結構並在本機比較：A 為 T3 Code 的頁面組合（首頁含 hero、插圖與功能格；獨立 Download、Help、Support）；B 為單頁捲動、說明可折疊；C 為下載優先的首頁加一頁合併說明。維護者選擇 A，理由是熟悉度與說明可深連結；B 與 C 已刪除。第二輪在該結構上比較三個視覺方向（Ember：營地夜色、橘色強調；Paper：淺色單色；Aurora：漸層光暈），維護者選擇 Ember，並改用幾何無襯線 Geist 取代襯線、移除小標與區塊副標、以真實的環＋紅點標誌取代方形 App 圖示，首頁以動畫呈現一鍵開始錄影。同日第三輪移除脈動（App 不會閃爍）、以「循環播放、輪與輪之間停留、捲出畫面暫停」取代暫停按鈕、用進場時逐漸沉澱的多層漸層取代單色頁面背景、縮小場景並新增「Click → Recording → Saved」三態帶、帶圖示的功能卡、等寬字規格帶與雙欄安裝摘要。第四輪以石墨中性色取代橘紫配色（白字、第二行標題灰色、紅色只用於錄影點、無彩色光暈），並在故事的每次點擊時加入鏡頭向選單列圖示推近的效果。三種地景風格（Dusk 寫實、Wire 線稿、Facet 低多邊形）皆重新調成中性色、只保留營火的暖色，在 `/preview/` 比較後維護者選擇 Facet，其餘刪除。鏡頭改以螢幕右上角為錨點，整塊一起放大、圖示留在變厚的選單列內；循環放慢為十四秒，推近與拉回各 1.4 秒並緩入緩出；錄影狀態修正為 tray 真實顯示的樣子：實心圓點加旁邊的「REC」標題，而不是環內紅點。第五輪把基準字級提高到 18 px（所有字級都用 rem，因此整體在相同欄寬內放大；說明頁表格中的長路徑改為可換行）、放大指示文字與箭頭並把該句傾斜角度由 3° 加到 9° 以貼合箭頭弧度、再下移 14 單位讓箭尾與文字之間留白，並把頁面暗角改為對齊視窗而非文件，因為原本依文件高度縮放會讓短頁（Support）比長頁（Help）看起來較亮。最後一輪在故事開始前加入三秒靜止、以指示箭頭（「Click again to stop recording」）取代第二次推近、通知改為即時彈出、閒置圖示移到電池旁讓左移讓位更明顯，並把選單列所有元素垂直居中。頁面：`/`（用途、下載按鈕、功能）、`/download`（已驗版本、大小、日期、來源 commit、可複製的 SHA-256、SHA256SUMS 與 release.json 連結、舊版經 GitHub Releases）、`/help`（安裝、仍要打開、權限、錄製、語言、手動更新、移除、保留資料）與 `/support`（已驗平台邊界、隱私、原始碼與問題回報）。文案僅限 README、安裝指南與驗證紀錄已記載的事實；沒有 Windows／Linux／Intel 控制項，也不宣稱公證、免警告啟動或自動更新。Support 頁原有「已知限制」清單，2026-09-20 依維護者決定移除：其中的 Finder 未置前行為已修復（見[驗證紀錄](../verification/README.md#通知點擊後-finder-置前--2026-09-20)），更新檢查已實作（見[交付設計](delivery.md)）而非列為長期限制，其餘項目與說明頁及平台邊界重複。

## 更新檢查

[updates.ts](../../../src/main/updates.ts) 獨立管理更新檢查生命週期。「設定 → 一般」提供「檢查更新…」、檢查結果與「啟動時檢查更新」。結果不改變 Tray 標題，也不產生通知或對話框；啟動錄製、錄製中與存檔時停用更新操作，檢查及待顯示結果延至 idle／needsPermission。

設定版本 3 新增可選的 `updates: { enabled, lastAttempt }`。舊檔預設開啟且無檢查紀錄。原子、序列化寫入保留其他設定。發出網路請求前保存嘗試時間，失敗亦計入，避免重開繞過 24 小時限制；系統時鐘回調造成的未來時間戳視為應重新檢查。手動檢查不受此限制，時間戳寫入失敗時記錄錯誤後仍繼續連線。App 執行期間沒有輪詢計時器。關閉偏好只影響啟動檢查。

App 注入 Electron `net.fetch`，採用 Chromium 網路層及系統代理／PAC 設定；單元測試注入測試用傳輸。檢查先讀取 `https://record.ericts.com/release.json`，失敗改查儲存庫的 GitHub latest-release API。每個來源最多等待 8 秒，結束 App 時取消請求。與 `app.getVersion()` 比較穩定語意版本；不相容的產物、無效資料與預覽版不會產生更新提示。啟動檢查失敗恢復先前選單並寫 log；手動失敗提供發布頁與重試。成功顯示本地檢查時間，或顯示新版並開啟固定官網下載頁；下載、取代仍為手動。

## 通知開關

「設定 → 一般」提供「通知」開／關；macOS 的「開啟通知設定…」按鈕就放在同一張卡片內，讓開關與可能凌駕它的系統權限讀起來是同一個決定，而不是兩個無關的設定。`AppTray.show` 在任何其他判斷之前先檢查這個開關，並寫下 `notification: turned off in settings, dropped: …`，因此單一布林值管轄 App 發出的每一則通知 — 存檔完成、錯誤，以及各種寫入失敗提示。錄製進行中這個開關與其他偏好一樣鎖定。

App 刻意不映射作業系統的通知權限。Electron 沒有任何方式可以讀取：`systemPreferences.getMediaAccessStatus` 只接受 `microphone`、`camera` 與 `screen`，而 `Electron Framework` 二進位中不存在 `getNotificationSettingsWithCompletionHandler`。其中確實存在 `requestAuthorizationWithOptions:completionHandler:`，所以 Electron 是在 `Notification.show()` 內部向 macOS 請求授權 — 全新安裝的第一則通知就是觸發系統提示的那一刻。`UNUserNotificationCenter` 只在狀態為 `notDetermined` 時提供該提示，而狀態按 bundle ID 保存、重新安裝 App 也不會重置，因此顯示提示的機會一輩子只有一次，被拒絕之後就 App 而言即為終局。所以這次機會花在首次啟動，由那則同時告訴使用者選單列 App 位置的首次啟動提示來使用：啟動正是 macOS 已經在為這個 App 索取螢幕錄製權限的時刻，通知的請求因此落在同一個脈絡裡，而不是出現在使用者第一次錄影結束的瞬間。開關維持預設開啟 — 一個從不說自己存好了的錄影工具讀起來像壞掉，而一個使用者永遠找不到、從未動用的提示機會，並不比被拒絕好。把開關關掉再打開同樣會送出確認通知，那也是可重複執行的送達測試。狀態列必然要宣稱一個 App 讀不到的權限狀態，所以群組的說明文字改為標示恢復路徑 —「系統設定 → 通知 → RecordStuff」— macOS 的操作按鈕則直接開啟該面板。關閉開關是照辦而非補償：說明文字此時改為交代代價與替代查看位置。十四個錯誤碼中只有六個僅能透過通知抵達使用者 — `capture_failed`、`capture_host_crashed`、`capture_host_unresponsive`、`output_write_failed`、`disk_full` 與 `stop_timeout`，也就是圖示已經是 REC 後又悄悄回到 Ready 的那些。其餘要嘛帶有 tray 狀態（`permission_denied` 與 `permission_needs_relaunch` 會進入 `needsPermission`；`output_open_failed` 設定 `outputDirUnavailable`），要嘛根本沒有開始擷取，而圖示沒有變成 REC 本身就是訊號。中斷的錄影只要寫入過任何內容，仍會在儲存位置留下 `<stamp>.recording.mp4`，而 tray 一鍵即可開啟該資料夾，所以資料夾始終是持久紀錄，App 自身不保存任何錯誤狀態。

此設計沿用 Cap（`apps/desktop/src-tauri/src/notifications.rs`）：送出路徑只檢查一個 `enable_notifications` 布林值，別無其他。Cap 另外會以 `isPermissionGranted()` 管控開關，該 API 由 `@tauri-apps/plugin-notification` 提供，Electron 沒有對應品；這段落差改由說明文字承擔。Plan 019 最初實作了通往 macOS `UserNotifications` 的 Node-API 橋接來補上它，後來撤回：該橋接使得載入失敗（架構不符或最低系統版本過新的 `.node`）會靜默壓制每一則通知，連 Electron 原本會發出的隱式授權請求也一併消失，比完全沒有狀態資訊嚴格更糟。橋接保存在 `wip/019-native-notification-bridge` 分支。

網站靜態端點由已線上驗證的 manifest 產生版本、tag、平台／架構、DMG 資訊、發布日期與可信頁面 URL。未驗證的預覽建置輸出錯誤物件，不宣告可下載版本。Vercel 快取 feed 五分鐘，App 請求不使用快取。`pnpm site:check` 比對建置 feed 與 manifest；部署 workflow 也會以 `check-release.mts --dir .vercel/output/static` 檢查實際發布產物。不新增安裝識別碼、查詢參數、遙測、更新器依賴或簽章身分。
