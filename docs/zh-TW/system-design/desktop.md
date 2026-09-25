# 桌面功能設計

[English](../../system-design/desktop.md) | [繁體中文](desktop.md)

## Tray 與通知

來源：[tray-model.ts](../../../src/main/tray-model.ts)、[tray.ts](../../../src/main/tray.ts)、[index.ts](../../../src/main/index.ts)。

TrayModel 是純函式產物，包含 icon、title、tooltip 與一份扁平的指令清單；偏好設定完全不在 tray 裡，所以模型回傳什麼、選單就顯示什麼。AppTray 只把模型映射到 Electron；不保存第二份業務狀態。左鍵呼叫 toggle，右鍵才動態組選單；不使用會攔截左鍵的 `setContextMenu`。[全域快捷鍵](#錄影快捷鍵)呼叫與左鍵相同的 toggle。

| 狀態 | 圖示／標題 | Tray 指令 | 設定視窗中的偏好 |
| --- | --- | --- | --- |
| needsPermission | idle／空白 | 權限說明、開設定或重啟；權限遺失期間存過檔才能顯示最後錄影；儲存位置 | 全部可調 |
| idle | idle／空白 | 待命或位置不可用；有 lastSavedPath 才能顯示最後錄影；儲存位置 | 全部可調 |
| starting | idle／`…` | 提醒完成系統提示 | 語言與外觀；About 連結仍可用 |
| recording | recording／`REC` | 可停止（已註冊快捷鍵時 tooltip 顯示組合鍵）；儲存位置變灰 | 語言與外觀；About 連結仍可用 |
| stopping | idle／`…` | 儲存中 | 語言與外觀；About 連結仍可用 |

每個狀態都有「設定」、「顯示 log」與「結束」，而且「設定」永遠可點：哪些偏好被鎖定由面板自己說明。macOS 使用 template PNG／@2x，Windows 分支使用 ICO；macOS 才顯示圖示旁 title。錄整個螢幕時 `REC` 可能出現在影片，這是目前接受的呈現。

通知使用本地化文案與 silent 模式。存檔通知點擊顯示完整影片；若錄影因磁碟保護而結束，通知會說明（「已儲存 {file}。磁碟空間即將用盡，已提前停止錄製」），該次錄影仍屬成功、不進入失敗紀錄（見[錄製設計](recording.md#寫檔與失敗)）。錄影失敗通知一律開啟設定中的「失敗紀錄」，呈現已確認的檔案狀態與復原操作。品質與語言保存失敗、幀率降級通知只有說明。

macOS 點通知會做兩件事：把回應交給 App，並要求系統啟動發通知的 App；後者約在點擊回呼後 110 ms 才落地。reveal 以 `setImmediate` 立刻請 Finder 選取檔案；若系統隨後把這個無視窗 App 設為前景，Finder 會被壓回使用者原本的視窗後方，看起來什麼都沒發生（v0.1.0 的回報；macOS 26.6 上約三次點擊出現一次，同一程序的第一次點擊很少發生）。計畫 014 因此在 reveal 之後掛一個一次性的 `did-become-active` 監聽，時窗 `ACTIVATION_WINDOW_MS`（1 秒）：啟動若落在時窗內，就從已是前景的 App 再 reveal 一次，讓 Finder 的置前最後落地。log 區分 `reveal requested`、`reveal repeated after activation` 與 `reveal failed`。只有點擊會掛監聽；背景存檔不會碰 Finder。原生通知不支援或 `failed` event 會留下 log。通知是否顯示仍受系統通知設定影響。原生證據由 `pnpm acceptance:notification` 產生（[工具鏈](tooling.md#通知驗收)）。通知縮圖已由使用者於 2026-09-14 重開機後確認正常。

`AppTray` 持有每個原生 `Notification`，直到 `click`、`close` 或 `failed`；單純 `show` 不會釋放。退出時關閉尚未處理的通知並清除參照；同步 `show()` 例外也會釋放並記錄。這讓 `show()` 返回後 callback 仍可到達：Electron 44.3.0 的[通知 wrapper](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_notification.cc) 由 GC 管理，解構時會清除原生 delegate。此生命週期修正不代表已證實歷史未送達點擊的原因。不使用 timer 淘汰通知；沒有終止事件的通知會持有到退出。 Windows Action Center 的生命週期未在本次修正或驗證：Windows `close` 可能只是橫幅逾時，歷史通知仍可點擊。

儲存通知由 `SavedNotification` 在檔案完成且回到 idle 後排程：macOS 使用單次 500 ms timer，其他平台立即請求。這讓 macOS 有時間清除擷取造成的通知抑制狀態，但只是依實測選定的啟發式延遲，不是就緒訊號或送達保證；專注模式、其他擷取與通知偏好仍有效。離開 idle（新錄影或進入權限恢復狀態）會永久取消前次待送通知，權限提示優先於舊存檔通知；退出判定取消 timer，也抑制該次退出過程中完成的儲存通知；延後退出後恢復未來通知，不重播已抑制的通知。不保留佇列、不重試；請求通知時的例外只記錄日誌，不影響已存檔案。寫檔與 idle 不等待通知。參見[時序證據](../verification/history-2026-09.md#儲存通知時序2026-09-20)。

圖示的原生 hover 提示保留目前狀態，並加上「右鍵開啟選單」；提示依 App 語言顯示英文或繁體中文。

## 設定視窗

來源：[ui-model.ts](../../../src/main/ui-model.ts)、[settings-model.ts](../../../src/main/settings-model.ts)、[settings-window.ts](../../../src/main/settings-window.ts)、[renderer/settings.ts](../../../src/renderer/settings.ts)。

Tray 只保留必須一鍵可達的指令，所有偏好設定都在同一個獨立的 sandbox 視窗。「設定」會開啟視窗，已開啟則聚焦。macOS 會先讓 App 取得前景，因為沒有 Dock 圖示的 App 單純顯示視窗並不會被帶到最前。變更立即儲存且視窗保持開啟；切換語言會就地更新標籤與標題。關閉視窗（含 Escape 與平台的關閉快捷鍵，這兩個由面板自己處理，因為沒有 Dock 圖示的 App 沒有應用選單）不會結束選單列 App。關閉快捷鍵在 macOS 精確為 ⌘W、其他平台為 Ctrl+W，不得帶其他修飾鍵；頁面與快捷鍵編輯器共用同一個判斷，因此 macOS 的 ⌃W 與 ⌘⇧W 仍可錄入。⌘W 本身永遠不會成為錄影快捷鍵：編輯器遇到它就關窗，驗證器也保留 `CommandOrControl+W`，手動編輯的設定檔同樣會回到預設值。與原生選單相同，以輸入的字元判斷；只有該鍵盤配置在該位置不輸入拉丁字母時，才採用實體 W 鍵。頁面的 renderer 程序結束時，main 會丟棄該視窗而不保留空白視窗，下次開啟設定再建立並載入新視窗；不會自動重新載入，因此反覆當掉的頁面不會形成迴圈。關閉、失焦與當掉事件只作用於自己的視窗實例，已丟棄視窗晚到的事件不會清掉替代視窗。錄製仍使用獨立的隱藏 renderer。

[settings-model.ts](../../../src/main/settings-model.ts) 只宣告每項偏好一次，配上穩定的群組與選項 id，也是唯一知道某個選項代表什麼的地方；它同時產生面板要畫的 view，以及「這個請求現在允不允許」的答案。Tray 模型是同一份狀態與 context 的兄弟投影，不是面板讀取的來源。

已提交設定由主程序持有，面板只暫存尚未完成的選擇：畫出收到的 view，回傳群組 id 與選項 id，不回傳 action。主程序只接受設定視窗自身 main frame 的請求，依當下重新產生的模型解析這組 id，然後才呼叫與 tray 相同的 action handler，而該 handler 在保存前會再檢查一次錄製狀態。啟動錄製、錄製中與存檔中，除了語言與外觀以外的設定在面板與該邊界都會鎖定。保存依請求順序序列化，第二個變更是排隊而不是被回報為失敗。保存期間顯示 main 已提交的值；儲存狀態不佔版面，並以列的 aria-busy 標示；較新的操作意圖獨立保留於佇列，不被舊回覆覆蓋，全部請求完成後才解除其他群組的鎖定，最新選擇未生效時顯示行內訊息；被 OS 拒絕註冊的快捷鍵會保留選取並加上「目前無效」的註解。群組也可以帶 `actions`：渲染在該控制項下方的按鈕，用於同一張卡片內可能凌駕該偏好的系統面板。actions 群組的選項、以及該 `actions` 清單中的選項，都沒有可比對的已提交值，因此由其 handler 以布林值回報自身結果並直接採用；其餘選項仍以「要求的值是否成為已提交值」判定，所以一個什麼都不回報的 handler 永遠無法把未保存的變更變成成功。保存期間正在操作的控制項維持可用、其餘暫時停用，因為停用中的元素無法保有鍵盤焦點。設定 preload 僅提供讀取、選取、擷取與變更訂閱；面板在第一份 view 之前唯一可能需要的字串（首次讀取失敗）依主程序寫在頁面 URL 的語言在地化。

「錄影」分頁包含影像品質、解析度上限與幀率，並說明編碼品質與像素尺寸的差異。「一般」包含快捷鍵、語言與更新控制。分頁支援方向鍵、Home 和 End，變更設定後保留目前分頁。更新操作使用按鈕，其完成狀態與偏好儲存分開處理。

設定視窗預設 560×680、最小 380×360，原生標題與分段分頁固定，上方以外的置中清單獨立捲動。Main 以選填的 `control`、`section`、`noteKind` 宣告呈現方式：通知與啟動更新使用原生 checkbox 開關；品質與語言使用原生 radio 分段；其他偏好保留原生選單。省略欄位時預設選單與靜態說明。連續同 section 的列共用分組清單；更新列共用標題，錄影鎖定以 section 註腳說明。明暗模式共用 accent／focus token，強制色彩回到原生控制項。

目前阻擋與歷史錄影失敗以結構化診斷呈現，與一般說明分開。消失的已選螢幕保留選取並停用，加上「無法使用」後綴；僅目前阻擋且存在可用主螢幕時提供「使用主螢幕」，透過原本 screen/primary id 儲存，不自動錄影。儲存失敗顯示於原控制項旁；只有候選仍有效、未鎖定且已提交值未改變時才提供重試。復原成功只證明偏好儲存，不能推論擷取成功。復原按鈕消失時僅在原焦點仍位於按鈕才回到選單；背景推播保留控制項身分與捲動位置。

快捷鍵使用單一選單，包含一組建議快捷鍵、目前自訂值（若有）、關閉及「自訂快捷鍵…」。不另設自訂按鈕；自訂成功會成為選單中標示「自訂」的目前組合，不累積歷史。選回建議值會取代自訂，不保留歷史，關閉則保留。擷取期間禁止重複開啟；按下組合僅預覽，按「確定」或無修飾鍵的 Enter 才儲存。有候選時 Tab 可移至確定與取消；沒有候選時 Tab 直接退出。取消保留原值，Esc／取消及成功提交回到選單，Tab／失焦維持使用者移動焦點的位置。Main 確認後才監聽，暫停註冊不視為衝突。「確定」左鍵按下時保留擷取焦點，避免 macOS 在 click 前先失焦取消候選；鍵盤確認及編輯器外取消維持原行為。

原生視窗標題保留「RecordStuff - 設置」（英文「RecordStuff - Settings」）；內容區移除重複圖示、大標題及自動儲存說明，直接從分頁開始。文件仍保留視覺隱藏的 h1 供輔助使用。「一般」底部左側為「由 Eric Tsai 製作」，右側是官方網站（地球）與 GitHub 原始碼圖示按鈕；每顆 32px 按鈕保留在地化輔助使用名稱及 hover 提示，診斷重試按鈕維持正常文字尺寸。Renderer 只送出 `about/website` 或 `about/source`，由 main 授權固定網址、用預設瀏覽器開啟並回報失敗；錄影中仍可用，不接受任意 URL 或導覽設定頁面。

滑鼠操作不顯示焦點外框，但保留 DOM 焦點；Tab／方向鍵等鍵盤導覽恢復 2px 焦點線，forced-colors 使用系統色。選單選項及 action 按鈕依 id 就地更新，新增自訂值或更新結果不重建整頁；暫時鎖定不讓下方分段控制閃暗。擷取經 main 確認後顯示三線監聽動畫，減少動態效果時靜止。開啟通知設定等 action 不顯示套用文字，只有失敗時顯示「操作失敗」。

捲動區平常隱藏 scrollbar，底部有剩餘內容時才顯示不攔截操作的漸層玻璃提示，不顯示箭頭，捲到底或內容可完全容納即隱藏；尺寸與內容變更會重新計算。增加對比／減少透明度改用實色邊界，forced-colors 恢復原生 scrollbar。再次檢查更新時保留上次結果文字與節點，僅更動檢查按鈕文字及可用性；完成後就地更新結果，避免區塊收合再展開。

視窗寬高獨立儲存在 userData 的 `settings-window.json`，不混入錄影偏好或其寫入佇列；初始 560×680（Electron 邏輯像素），保留雙語控制寬度並減少精簡頁首後的多餘高度。調整尺寸後 250ms 合併寫入，關閉／退出時同步 flush 最後尺寸，關閉重開及下次 App 啟動皆沿用。最小 380×360；開啟時依游標所在螢幕工作區限制尺寸並置中，不保存位置，也不因單次螢幕限制覆寫原保存尺寸。缺檔或無效尺寸回預設；寫入失敗記 log 並保留本程序尺寸，既有磁碟檔不被半份 JSON 覆蓋。

## 錄影快捷鍵

來源：[hotkey.ts](../../../src/main/hotkey.ts)、[shortcuts.ts](../../../src/main/shortcuts.ts)、[shared/hotkey.ts](../../../src/shared/hotkey.ts)、[index.ts](../../../src/main/index.ts)。計畫 016 加入全域開始／停止快捷鍵：其他 App 在最前景時也能切換錄製，而且讓沒有視窗的程序有一個系統層級入口，可供無人值守驗收使用。

RecordingHotkey 包裝 Electron `globalShortcut`。按下快捷鍵呼叫與 tray 左鍵相同的 `toggle` 函式，所以 `Recorder.toggle()` 仍是唯一決策點：idle 開始、recording 停止、needsPermission 重發權限通知，starting／stopping 期間忽略。每次按下都先寫 log `hotkey: <accelerator> pressed` 再 toggle。`apply(settings)` 先釋放前一個註冊再註冊新的，更改時不會同時有兩個組合鍵生效；`dispose()` 在 will-quit 執行。

使用者在 「設定」視窗的「快捷鍵」欄位選一組建議快捷鍵、「自訂快捷鍵…」或「關閉」（與品質相同，只在 idle／needsPermission 可改）。預設 `CommandOrControl+Shift+1`（macOS 顯示 ⌘⇧1，其他平台 Ctrl+Shift+1），2026-09-21 由維護者決定。全域快捷鍵優先於最前景 App，因此預設必須是常見 App 都不會預期的組合。最直覺的 ⌘⇧R 因此被否決過兩次：2026-09-19 的衝突檢查發現它是 Chrome／Firefox 的強制重新載入、Safari 的閱讀器、Zoom 的本機錄製，在瀏覽器按下去會變成開始螢幕錄影而不是重新載入。既有使用者若已選用它則保留，顯示為自訂；不再列為建議選項。數字鍵是比較安靜的區段 — macOS 以 ⌘⇧3/4/5 佔用截圖與螢幕錄製，而 App 綁定的是不加 Shift 的 ⌘1…9（分頁與檢視模式）— 但 ⌘⇧1 尚未經過同樣逐一 App 的查核，那屬於原生驗收範圍。前一個預設 `CommandOrControl+Alt+Shift+R` 在 2026-09 已驗證於 Chrome、Safari、Firefox、Finder、Xcode、VS Code、Slack 與 Zoom 均未被佔用，現在僅保留既有使用者已儲存的值，不另列替代選項。`HOTKEY_PRESETS` 保留歷史常數供相容性測試；選單只提供 `DEFAULT_HOTKEY`，不枚舉此清單。自訂值由 `validateAccelerator` 驗證：至少含 CommandOrControl 或 Control，可加 Alt／Shift，只能有一個支援按鍵、不可重複修飾鍵、長度最多 64 字元，並排除少量 macOS 保留組合。標準順序為 CommandOrControl、Control、Alt、Shift、按鍵。不合法的儲存值仍回預設並記 warning。

「自訂…」以實體 key code 錄入字母、數字、F 鍵與標點，並支援空白及方向鍵；不支援的鍵區（含數字鍵盤）拒絕錄入。Shift 標點別名會先轉成 Shift 加基礎鍵，再檢查保留組合。快捷鍵群組是唯一可傳值的控制項；main 重新驗證並標準化後才儲存。Escape、Tab／Shift+Tab 移出、點擊其他位置、視窗失焦／關閉、renderer 結束與 15 秒逾時都取消錄入。main 先解除 OS 註冊才確認開始錄入，完成或取消後恢復；退出時清除註冊。每次錄入是一份由發起視窗持有的 lease，與它可能啟動的設定交易分開。取消、失焦、逾時、關閉、renderer 失敗、錄影鎖定與退出都立即釋放它，即使已確認的儲存仍在寫入，並恢復當下已提交的註冊。釋放可重複呼叫；舊視窗晚到的事件或較早的儲存完成時，只結束自己的 lease，不會結束新視窗的錄入。已確認的儲存在視窗關閉或當掉後仍會完成；尚未確認的草稿絕不送出。`AppShortcuts` 持有兩個註冊與下述「先保存再註冊」的順序。錄影期間整個群組鎖定。不合法組合顯示在地化原因且不改設定。「關閉」保留自訂值，仍可直接選回。錄入按鈕可用鍵盤操作，並以 `aria-live` 宣告狀態。

全域快捷鍵依實體鍵位註冊。在 macOS 上，main 會在 app ready 之前停用 Chromium 的 `LayoutAwareGlobalHotkeys`（[hotkey.ts](../../../src/main/hotkey.ts) 的 `physicalHotkeyFeatures`，並與命令列上既有的 `disable-features` 清單合併）。這個功能開啟時，Chromium 152 會把快捷鍵綁到當下配置中輸入該字元的鍵，每次切換鍵盤都重新註冊。注音的 ZhuyinBopomofo 配置在數字列輸入注音符號，預設的 ⌘⇧1 因而被移到數字鍵盤，而編輯器拒絕數字鍵盤。現在改用編輯器所記錄的 US 固定位置註冊，與 Cap 透過 `global-hotkey` 的做法相同。因此在 Dvorak、AZERTY 等非 QWERTY 拉丁配置下，字母快捷鍵是 US 位置，而不是鍵帽上的字母（[決策](decisions.md)、[plan 043 結案](../verification/history-2026-09.md#plan-043-結案--2026-09-26)）。`pnpm acceptance:shortcut-layout` 會在數字列不輸入數字的配置下檢查建置好的 App，若註冊又跟著配置走就失敗（[工具](tooling.md#鍵盤配置快捷鍵檢查)）。

`pnpm acceptance` 以 macOS key code 送出數字、空白、方向鍵、F1–F20 與常見未加 Shift 的標點，字母則以輸入的字元送出；其他組合會在開始錄影前明確報錯並列出快捷鍵。由於註冊依實體鍵位，以 key code 送出的鍵在任何輸入法下（包含注音）都能觸發已註冊的快捷鍵。以字元送出的字母，只有在該字母位於 US 位置的配置（例如 ABC 與注音）才會按到同一顆鍵；在 Dvorak 或 AZERTY 下，runner 會按到別的鍵。

OS 拒絕註冊（其他 App 佔用，或 `register` 擲出）不會被吞掉：寫 log `hotkey: registration failed for …`、選單標題顯示「快捷鍵無法使用（被其他 App 佔用）：…」並發通知。設定仍會保存，使用者的選擇在重啟後保留；tray 照常可用。關閉快捷鍵不影響 tray 行為，並記住組合鍵，重新開啟即還原。更改快捷鍵先保存再註冊：寫入失敗保留舊註冊並通知「無法儲存快捷鍵設定」。若寫入期間開始了錄影，註冊變更會延後（`request` → 下一次回到 settled 狀態時 `flush`），讓開始這次錄影的組合鍵仍能停止它；期間選單把已保存的選擇顯示為無法使用。

`pnpm acceptance:shortcut` 以隔離 Electron 驗證註冊失敗回報與跨程序重啟保留選擇，並檢查程序、視窗、快捷鍵與臨時資料清理。通知斷言觀察呼叫，不驗證 macOS 橫幅送達；也不保證偵測所有其他 App 攔截按鍵的情況。Plan 020 依維護者接受此證據結案，真實 OS 衝突與通知橫幅保留為未測限制，詳見[結案紀錄](../verification/history-2026-09.md#plan-020-結案--2026-09-23)。

## 語言

來源：[i18n.ts](../../../src/shared/i18n.ts)。預設為英文 en，不自動沿用 OS 語言；可由 Settings／設定 視窗的 Language／語言欄位切換 English 或繁體中文 zh-TW。英文文案為具型別的 key，ZH_TW 對應完整繁體中文模板，translate 代入具名 placeholder，編譯器要求每個 placeholder 都有值。

TrayContext 提供目前語言，通知建立時讀當前 context；已發送的 OS 通知不追溯改寫。語言操作排入 SettingsStore 保存佇列，成功後才更新記憶體與刷新選單，失敗保留舊語言並以原語言通知。錄製中可切換，但不改來源、品質快照、位置或錄製狀態。

選單、tooltip、資料夾對話框、通知與使用者錯誤摘要都有翻譯；技術錯誤細節及開發工具／新量測輸出維持英文，細節留在 log，不混入中文通知。macOS 原生提示跟隨系統語言。

## 螢幕權限

來源：[permission.ts](../../../src/main/permission.ts)。只在 macOS 建立 PermissionWatcher。

1. 每 5 秒及 activate 時檢查 `getMediaAccessStatus('screen')`，不依賴無視窗 App 的 activate 一定出現。這一段不會跳提示、也不會產生任何物件，所以輪詢很便宜。
2. 未 granted：清除驗證快取與待執行的重試，發 needsPermission；每個程序最多主動呼叫一次 getSources，以便系統註冊與提示。
3. granted 但未驗證：用 getSources 查是否有螢幕，避免只相信設定開關。驗證 4 秒仍未回應時顯示重啟指引（needsRelaunch），但該呼叫仍佔著名額：期限無法取消 getSources。
4. Watcher 發出的 getSources（提示或驗證）同時最多一個未完成；等待期間只輪詢第一段。提示進行中才授權時，等提示結束後再驗證；提示的結果永遠不算驗證。
5. 查得到來源就快取成功；失敗則 needsRelaunch，並從該次失敗完成時起退避重試：5、10、20、40 秒，之後每 60 秒。撤銷授權會重設退避。
6. 撤銷授權、擷取實際被拒（markRelaunchRequired）與 stop() 都會開始新世代：舊世代的驗證晚到時只記 log 並忽略，接著重新驗證。stop() 移除 interval、activate listener 與兩個 timer；仍未完成的呼叫保留到它自己結束。

只有第一段會被輪詢，而讓這件事安全的正是「第二段成功一次就快取整個程序」。Cap 曾經長期輪詢對應的 macOS 呼叫 `SCShareableContent`（它會實體化系統上每個視窗、App 與顯示器），整個程序生命週期每次呼叫都洩漏，約 15 MB／分鐘，直到 macOS 耗盡 swap（[CapSoftware/Cap issue #2023](https://github.com/CapSoftware/Cap/issues/2023)，於 0.5.9 以「Memory growth while idle on macOS」修正）。這裡採用的就是他們事故後的設計：便宜的 preflight 可以自由輪詢，昂貴的驗證成功一次即快取、序列化執行，失敗後至少等一個輪詢週期（從完成時起算）才重試，連 5 秒與 4 秒兩個常數都相同。Cap 也會讓 `ShareableContent::current` 逾時，但未證明丟棄該 future 會取消 macOS 請求，所以 RecordStuff 持有真正的 promise，而不是再送替代請求（plan 027）。永遠不返回的呼叫無法在同一程序內恢復：指引是重新啟動，讓它隨程序結束。執行期撤銷仍由第一段、由擷取嘗試本身、以及實務上 macOS 要求 App 重啟三者抓到。撤銷與重新授權若都落在兩次輪詢之間就觀察不到，之前開始的驗證仍可能被套用。

只有狀態改變才通知 Recorder。Recorder 一律保存最新權限狀態，starting、recording、stopping 期間也一樣，但不因此打斷正在錄的 session。每次回到非忙碌狀態（存檔、擷取失敗或啟動失敗）都依保存的狀態決定 idle 或 needsPermission，因此 session 中只通知一次的撤銷不會遺失，同一 session 內之後又授權也不需要再次通知。needsPermission 保留 lastSavedPath，選單仍有「顯示最後一個錄影」；權限恢復後 Recorder 還原其餘 idle 資訊（outputDirUnavailable，期間已改儲存位置則不還原）。存檔通知仍讓位給權限指引，見通知一節。實際軌道结束、host 錯誤或 OS 要求退出走錄製管線的收尾。

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

`language` 是相容新增欄位：舊檔未填時預設 en；不支援的值回 en 並記 warning，但保留合法位置與品質。`hotkey.accelerator` 必須通過共用快捷鍵驗證器；v3 檔缺少或不合法的 hotkey 區塊回預設快捷鍵並記 warning，保留其他欄位。`outputDir` 必須是非空絕對路徑。版本 1 可讀，補預設 quality；版本 1／2 補預設快捷鍵（各記 warning），下次保存寫成 v3。整份無效／未知版本／路徑無效回預設並記 log；僅 quality 壞掉則保留合法 outputDir，重設品質。舊 audioQuality 額外欄位不參與目前設定。`notifications` 與 `updates` 同屬相容新增欄位：缺少或非布林值一律讀為 `true` 且不記 warning，因為在這個開關存在之前寫下的檔案並不是壞檔。

保存以 Promise 佇列依「上一份成功提交的設定」合併更新，避免連點遺失前一次修改；先寫入並 fsync `settings.json.tmp` 再 rename，成功才切換記憶體。單次失敗會移除暫存檔並拒絕自己的 caller，後續儲存仍可執行。rename 前先 fsync，可避免當機或斷電後留下空白或半份的 settings.json；由於沒有目錄 fsync，剛完成的修改仍可能退回前一份檔案。

更改位置使用原生選資料夾對話框，macOS 先 focus 以免藏在別的視窗後方。保存設定成功會清除 idle 的位置錯誤旗標並刷新選單；真正能不能寫入於開始錄製時用 probe 驗證。沒有背景自動改存預設位置。

品質與快捷鍵只能在 idle／needsPermission 修改；每個 session 保存自己的品質快照。設定檔即使有其他平台不開放的 60 fps，effectiveQuality 只調整本次有效值，不重寫設定。

## Log 與診斷

來源：[log.ts](../../../src/main/log.ts)。macOS 目前路徑為 `~/Library/Logs/recordstuff/recordstuff.log`；設定為 `~/Library/Application Support/recordstuff/settings.json`。路徑由 Electron app 名稱與 `getPath` 決定，產品顯示名稱仍是 RecordStuff。

每行為 `[UTC ISO 時間] 訊息`。啟動時記 App／Electron／平台版本、本次啟動的 run id、outputDir、品質、packaged 與 executable；每次錄製記 session、狀態、capture report、first chunk、saved（含提前停止原因）／failed、停滯與低空間警告及 writer 積壓、改報為已保留磁碟錯誤的啟動失敗，以及啟動時找到的中斷 sentinel。`power: suspend` 與 `power: resume` 會記下進行中的 session 與狀態。Log 含本機路徑，分享診斷前可移除個人路徑；不寫入媒體內容。

Session record（plan 029）。run id 由啟動時間加 pid 組成（例如 `20260925T101530123Z-4242`），只出現在 `start:` 行，一般行不加前綴。App 在人類可讀的 capture、`saved` 與 `failed:` 行旁，每個事件另寫一筆有版本的 record：`session-record: {"v":1,"run":…,"kind":…}`。種類有 `capture`（session、要求品質、capture report）、`saved`（session、最終路徑、錄製與要求停止時間、提前停止原因）、`failed`（session、code、detail、檔案結果、保留與暫存路徑、時間；沒有留下檔案也會寫）與 `refused`（preflight 拒絕，不指名任何 session）。JSON 讓含空白、引號或換行的路徑維持在一行跳脫後的內容。失敗收尾可能在下一個 session 開始後才結束，完成順序不是身分，所以 Recorder 的終止事件帶著 session。開發用分析器依 run 與 session id 配對錄影；該次啟動有寫 record 時只讀 record，不會把兩種形式算成兩個結果。舊 log 不改寫。

所有訊息先送 stdout。檔案在下次追加前若超過 5 MiB，將舊檔依序移到 `.1.log`～`.3.log`（開發 runner 以檔案身分 cursor 跟過輪替，見 [tooling](tooling.md#選擇驗收範圍)，政策本身不變）；同步寫入方便無視窗 App 即時診斷。檔案寫失敗後本程序停用檔案 log，只報 stderr 一次並繼續 stdout。主程序未捕捉例外另外開錯誤對話框，unhandled rejection 留 log。

「顯示 log」優先選取檔案，不存在則開 logs 資料夾；不影響正在錄製的工作。固定簽章更新後可沿用現有權限，但開發 Electron.app 與安裝 RecordStuff.app 的授權不可混用；排查先核對 executable。

## 官方網站

網站（[website/](../../../website/)，見[工具](tooling.md#官方網站)）依維護者決定只有英文；App UI 與 repo 指南維持雙語，頁尾連到繁體中文安裝指南。2026-09-20 在同一份內容層上建了三種結構並在本機比較：A 為 T3 Code 的頁面組合（首頁含 hero、插圖與功能格；獨立 Download、Help、Support）；B 為單頁捲動、說明可折疊；C 為下載優先的首頁加一頁合併說明。維護者選擇 A，理由是熟悉度與說明可深連結；B 與 C 已刪除。第二輪在該結構上比較三個視覺方向（Ember：營地夜色、橘色強調；Paper：淺色單色；Aurora：漸層光暈），維護者選擇 Ember，並改用幾何無襯線 Geist 取代襯線、移除小標與區塊副標、以真實的環＋紅點標誌取代方形 App 圖示，首頁以動畫呈現一鍵開始錄影。同日第三輪移除脈動（App 不會閃爍）、以「循環播放、輪與輪之間停留、捲出畫面暫停」取代暫停按鈕、用進場時逐漸沉澱的多層漸層取代單色頁面背景、縮小場景並新增「Click → Recording → Saved」三態帶、帶圖示的功能卡、等寬字規格帶與雙欄安裝摘要。第四輪以石墨中性色取代橘紫配色（白字、第二行標題灰色、紅色只用於錄影點、無彩色光暈），並在故事的每次點擊時加入鏡頭向選單列圖示推近的效果。三種地景風格（Dusk 寫實、Wire 線稿、Facet 低多邊形）皆重新調成中性色、只保留營火的暖色，在 `/preview/` 比較後維護者選擇 Facet，其餘刪除。鏡頭改以螢幕右上角為錨點，整塊一起放大、圖示留在變厚的選單列內；循環放慢為十四秒，推近與拉回各 1.4 秒並緩入緩出；錄影狀態修正為 tray 真實顯示的樣子：實心圓點加旁邊的「REC」標題，而不是環內紅點。第五輪把基準字級提高到 18 px（所有字級都用 rem，因此整體在相同欄寬內放大；說明頁表格中的長路徑改為可換行）、放大指示文字與箭頭並把該句傾斜角度由 3° 加到 9° 以貼合箭頭弧度、再下移 14 單位讓箭尾與文字之間留白，並把頁面暗角改為對齊視窗而非文件，因為原本依文件高度縮放會讓短頁（Support）比長頁（Help）看起來較亮。最後一輪在故事開始前加入三秒靜止、以指示箭頭（「Click again to stop recording」）取代第二次推近、通知改為即時彈出、閒置圖示移到電池旁讓左移讓位更明顯，並把選單列所有元素垂直居中。頁面：`/`（用途、下載按鈕、功能）、`/download`（已驗版本、大小、日期、來源 commit、可複製的 SHA-256、SHA256SUMS 與 release.json 連結、舊版經 GitHub Releases）、`/help`（安裝、仍要打開、權限、錄製、語言、手動更新、移除、保留資料）與 `/support`（已驗平台邊界、隱私、原始碼與問題回報）。文案僅限 README、安裝指南與驗證紀錄已記載的事實；沒有 Windows／Linux／Intel 控制項，也不宣稱公證、免警告啟動或自動更新。Support 頁原有「已知限制」清單，2026-09-20 依維護者決定移除：其中的 Finder 未置前行為已修復（見[驗證紀錄](../verification/history-2026-09.md#通知點擊後-finder-置前--2026-09-20)），更新檢查已實作（見[交付設計](delivery.md)）而非列為長期限制，其餘項目與說明頁及平台邊界重複。

## 更新檢查

[updates.ts](../../../src/main/updates.ts) 獨立管理更新檢查生命週期。「設定 → 一般」提供「檢查更新…」、檢查結果與「啟動時檢查更新」。結果不改變 Tray 標題，也不產生通知或對話框；啟動錄製、錄製中與存檔時停用更新操作，檢查及待顯示結果延至 idle／needsPermission。

設定版本 3 新增可選的 `updates: { enabled, lastAttempt }`。舊檔預設開啟且無檢查紀錄。原子、序列化寫入保留其他設定。發出網路請求前保存嘗試時間，失敗亦計入，避免重開繞過 24 小時限制；系統時鐘回調造成的未來時間戳視為應重新檢查。手動檢查不受此限制，時間戳寫入失敗時記錄錯誤後仍繼續連線。App 執行期間沒有輪詢計時器。關閉偏好只影響啟動檢查。

App 注入 Electron `net.fetch`，採用 Chromium 網路層及系統代理／PAC 設定；單元測試注入測試用傳輸。檢查先讀取 `https://record.ericts.com/release.json`，失敗改查儲存庫的 GitHub latest-release API。每個來源最多等待 8 秒，結束 App 時取消請求。與 `app.getVersion()` 比較穩定語意版本；不相容的產物、無效資料與預覽版不會產生更新提示。啟動檢查失敗恢復先前選單並寫 log；手動失敗提供發布頁與重試。成功顯示本地檢查時間，或顯示新版並開啟固定官網下載頁；下載、取代仍為手動。

## 通知開關

「設定 → 一般」提供「通知」開／關；macOS 的「開啟通知設定…」按鈕就放在同一張卡片內，讓開關與可能凌駕它的系統權限讀起來是同一個決定，而不是兩個無關的設定。`AppTray.show` 在任何其他判斷之前先檢查這個開關，並寫下 `notification: turned off in settings, dropped: …`，因此單一布林值管轄 App 發出的每一則通知 — 存檔完成、錯誤，以及各種寫入失敗提示。錄製進行中這個開關與其他偏好一樣鎖定。

App 刻意不映射作業系統的通知權限。Electron 沒有任何方式可以讀取：`systemPreferences.getMediaAccessStatus` 只接受 `microphone`、`camera` 與 `screen`，而 `Electron Framework` 二進位中不存在 `getNotificationSettingsWithCompletionHandler`。其中確實存在 `requestAuthorizationWithOptions:completionHandler:`，所以 Electron 是在 `Notification.show()` 內部向 macOS 請求授權 — 全新安裝的第一則通知就是觸發系統提示的那一刻。`UNUserNotificationCenter` 只在狀態為 `notDetermined` 時提供該提示，而狀態按 bundle ID 保存、重新安裝 App 也不會重置，因此顯示提示的機會一輩子只有一次，被拒絕之後就 App 而言即為終局。所以這次機會花在首次啟動，由那則同時告訴使用者選單列 App 位置的首次啟動提示來使用：啟動正是 macOS 已經在為這個 App 索取螢幕錄製權限的時刻，通知的請求因此落在同一個脈絡裡，而不是出現在使用者第一次錄影結束的瞬間。開關維持預設開啟 — 一個從不說自己存好了的錄影工具讀起來像壞掉，而一個使用者永遠找不到、從未動用的提示機會，並不比被拒絕好。把開關關掉再打開同樣會送出確認通知，那也是可重複執行的送達測試。狀態列必然要宣稱一個 App 讀不到的權限狀態，所以群組的說明文字改為標示恢復路徑 —「系統設定 → 通知 → RecordStuff」— macOS 的操作按鈕則直接開啟該面板。關閉開關會停止發送 OS 通知；錄影失敗仍顯示於選單列與下述「失敗紀錄」區塊。

此設計沿用 Cap（`apps/desktop/src-tauri/src/notifications.rs`）：送出路徑只檢查一個 `enable_notifications` 布林值，別無其他。Cap 另外會以 `isPermissionGranted()` 管控開關，該 API 由 `@tauri-apps/plugin-notification` 提供，Electron 沒有對應品；這段落差改由說明文字承擔。Plan 019 最初實作了通往 macOS `UserNotifications` 的 Node-API 橋接來補上它，後來撤回：該橋接使得載入失敗（架構不符或最低系統版本過新的 `.node`）會靜默壓制每一則通知，連 Electron 原本會發出的隱式授權請求也一併消失，比完全沒有狀態資訊嚴格更糟。橋接保存在 `wip/019-native-notification-bridge` 分支。

網站靜態端點由已線上驗證的 manifest 產生版本、tag、平台／架構、DMG 資訊、發布日期與可信頁面 URL。未驗證的預覽建置輸出錯誤物件，不宣告可下載版本。Vercel 快取 feed 五分鐘，App 請求不使用快取。`pnpm site:check` 比對建置 feed 與 manifest；部署 workflow 也會以 `check-release.mts --dir .vercel/output/static` 檢查實際發布產物。不新增安裝識別碼、查詢參數、遙測、更新器依賴或簽章身分。

macOS 設定入口會開啟通知總覽，再選 RecordStuff 即可進入權限控制；plan 019 結案保留此路徑。一般設定值／文字更新保留既有表單控制項、焦點與捲動位置，只有分頁／結構改變才重建表單。僅因儲存而暫時鎖定的操作維持原本亮度，避免整個面板短暫變淡；錄製或平台限制造成的停用仍有停用外觀。

## 設定快捷鍵

`CommandOrControl+Alt+,`（macOS 為 ⌘⌥,）透過 `openSettings` 開啟、還原並聚焦同一個設定面板，錄製中也可使用。它不會切換錄製狀態，也不佔用一般的 ⌘,。`settings-hotkey.ts` 獨立管理註冊，結束時僅釋放自己的組合鍵；選單只在註冊成功時顯示快捷鍵，失敗則以目前語言說明。

新選取的錄影快捷鍵不得與設定組合鍵在目前平台等價。既存設定若衝突，保留原值並優先維持錄影功能；從選單列開啟設定後變更或停用錄影快捷鍵即可恢復。自訂擷取期間兩個註冊一起暫停，lease 釋放（提交、取消、失焦、逾時、關閉或 renderer 失敗）時即恢復，不等待尚未完成的儲存；錄影中的設定鎖定不變。

### 螢幕偏好與診斷

設定 → 錄影 → 螢幕先列主螢幕，再列 `screen.getAllDisplays()` 提供的唯一已連接螢幕；開啟面板不列舉錄製來源、不要求錄製權限。預設跟隨目前主螢幕；指定選擇只在現有 version-3 設定中保存 id 與 label。版本 1–3 缺少欄位時採預設，無效值記警告並回退。空白名稱使用本地化的 id 名稱；面板只送 choice id，由 main 重新解析目前動作與名稱。

新增／移除／尺寸事件一律推進配置世代；閒置時立即刷新，忙碌時於結束後刷新。錄製期間不能變更選擇。缺失或重複的保存目標保留勾選但停用，仍可選主螢幕或有效目標恢復。閒置 tray 顯示健康的指定目標；tray 與設定區分目前不可用與上次失敗。上次失敗只留在記憶體，關閉通知仍顯示，只有成功開始錄製或成功保存不同選擇才清除。保存失敗保留偏好與診斷，並依通知偏好送出錯誤通知。不新增 tray 子選單或系統 picker；系統音訊政策不變。

外觀偏好提供「跟隨系統」（預設）、「淺色」、「深色」，位於一般設定，錄影期間亦可切換。Main 成功儲存後設定 `nativeTheme.themeSource`，即時套用原生視窗與 CSS 深淺色；啟動時讀回。舊檔缺少此欄位或值不合法時回到 system，不影響其他偏好。

## 錄影失敗結果

Recorder 在檔案清理完成前發出獨立 failure-status。Main 將每筆失敗及其確認狀態存入 `userData/recording-history.json`（version 2），獨立於通知偏好與錄影狀態。新錯誤排最前面；延遲清理只更新自己的 ID，不取代或重排其他紀錄。保留所有未確認紀錄與最近確認的 20 筆紀錄。這是失敗歷史，不是媒體資料庫或遺留檔案復原機制。

選單列仍只有一個項目。只要有未確認失敗，待命圓環就整合警示標記；錄影中的實心圖示與 REC 優先。選單顯示未確認筆數及「查看失敗紀錄」。左鍵仍開始／停止錄影。錯誤通知開啟設定中的同一列表，定位最新未確認紀錄（全部確認時則定位最新紀錄），不自動確認。開選單、關通知、成功錄影或等待，都不清除失敗。

「失敗紀錄」位於設定任一分頁的偏好上方。每筆可獨立展開，顯示時間、原因、檔案結果、恢復指引與技術資訊。清理中停用「知道了」，不提供檔案定位。部分檔案顯示前及定位前重新檢查；未知或遺失路徑只是查找線索，不保證可播放或復原。檔案／資料夾／權限操作仍遵守錄製鎖定。普通更新保留各筆展開狀態與 ID，舊按鈕不會操作新紀錄。

「知道了」只在精確 ID 的處理完成後，成功保存確認狀態才收合該筆；所有保留的失敗都確認後，才消除選單列警示。已確認紀錄可移除；手動移除或淘汰最舊已確認紀錄，都不刪影片或 log。確認與移除要等包含它們的快照成功寫入磁碟後才顯示；等待期間該筆顯示本地化的「正在儲存」文字，按鈕以 `aria-disabled` 保持可聚焦並忽略啟用，其他紀錄、偏好與錄影操作不受影響。確認／移除保存失敗時，維持先前可見狀態並在該筆顯示錯誤。「重新儲存提醒」獨立保存整份歷史，不改變確認狀態，未確認與處理中的失敗亦可重試。任何成功保存都包含其他尚未存入磁碟的失敗。

焦點依操作開始時記錄的意圖還原，不依賴 `document.activeElement` 撐過等待：確認、收合或失敗後回到該筆摘要，移除最後一筆後回到目前分頁。使用者在等待期間移動焦點或視窗失焦時不搶回焦點，也不會移入其他紀錄的操作按鈕。失敗紀錄操作不排在偏好保存佇列後面，也不會結束快捷鍵擷取。

重啟不重發通知。中斷的 pending 清理改為無法確認；先前程序結束時（強制結束、當機、程序被終止或斷電）仍在錄製的 session，會在啟動時依其中斷 sentinel 回報一次，成為一筆未確認的 `app_terminated` 紀錄：「RecordStuff 在錄製期間未正常結束」，時間為該 session 的開始時間，指引說明檔案可能不完整且不會修復。其暫存檔路徑以下述「先前確認的部分檔案」方式重新檢查：只有該處存在非空檔案時才提供定位，否則為無法確認並保留路徑作為線索。它不發通知；紀錄保存後即移除 sentinel，因此確認後或再次重啟都不會重複出現。不執行任何復原、重新封裝或修復。先前確認的部分檔案也先顯示無法確認，再以一次一筆、每筆兩秒期限檢查；逾時停止後續檢查，避免佔滿檔案系統工作執行緒。檢查成功恢復部分檔案狀態，同時保留期間的確認操作。無法存取的路徑保留候選資訊與先前確認資格，供下次啟動檢查；中斷清理不因找到位元組就升級成已確認保留。已移除的 ID 不會被延遲檢查或完成事件重新加入。

首次使用會把有效 `recording-result.json` v1 單筆紀錄移入獨立歷史檔案，保留舊檔。有效的空歷史不會再匯入舊資料。歷史損壞、超大或版本較新時記入 log 並拒絕覆蓋；後續保存呈現持久化警告。歷史驗證唯一 ID，序列化上限為 32 MiB；不會為了符合上限刪除未確認紀錄，超過就回報保存失敗，並非無限的永久儲存。

歷史透過 Node 非同步 `fs.promises`（libuv 執行緒池）以私有暫存檔、fsync 與 rename 寫入；主程序不等待磁碟。啟動時以非同步方式讀檔，載入完成前絕不寫入，期間到達的失敗依 ID 合併；設定在此之前顯示本地化的載入文字。單一負責者最多只有一個寫入進行中、一個合併後的後續寫入；每份快照都是完整歷史，會包含較早快照中的所有失敗與操作結果，完成時只結算該快照包含的 revision。較舊的完成結果不會清除較新未保存變更的警告。啟動檢查後未變更的歷史不重寫。

保存失敗仍在記憶體顯示新資訊，只有與上次保存內容不同的紀錄才顯示本地化警告。一般 I/O 失敗以單一 timer 自動重試：尚未保存時依序間隔 2、5、15 秒，之後每 30 秒；成功後重設退避，歷史已保存則停止，一段連續失敗只記一次 log 並記錄恢復。手動重試會立即開始，若已有寫入進行中則加入該次寫入，不會產生第二個 writer。無法讀取或較新版本的歷史不會重試或覆寫，警告會如實說明而非建議釋放磁碟空間；超過 32 MiB 上限時請使用者移除已確認紀錄。原子替換不保證斷電或磁碟已滿／不可寫時恢復，背景保存也不會增加磁碟吞吐量。跨重啟權限錯誤採歷史指引，僅目前權限仍需要時提供重新啟動。失敗 ID 使用跨程序 UUID。

序列化留在主程序，不使用 worker。在 M1 Pro 上，32 MiB 上限的整份快照 `JSON.stringify` 約 40 ms，超過一個 16 ms 畫面；但把這份快照交給 worker 需要在主程序做成本相近的 structured clone，因此改為快取每筆紀錄的已編碼 JSON 與 fingerprint（紀錄不可變），歷史迴圈累積約 8 ms 工作即讓出事件迴圈。實測主程序最長單一 turn：寫入（含上限）最多約 10 ms；啟動讀取在上限時有一次約 38 ms 的 turn（單次 `JSON.parse`），3.8 MiB 約 6 ms，一般歷史約 2 ms。見[驗證紀錄](../verification/history-2026-09.md#plan-036-結案--2026-09-25)。

## 延後退出

正常退出會等待錄影與所有未完成磁碟工作，即使 tray 已 idle 也一樣。等待 13 秒後若仍有工作，英文／繁中資訊對話框會提示 RecordStuff 保持開啟，請在存檔／清理完成後重試退出。重複要求不能略過此判定；啟動中的擷取在延期後仍保留停止意圖。重啟只在退出獲准後登記，退出延期會取消該次重啟意圖。媒體工作不提供強制退出控制。

只有在媒體已安全、且持續拒絕新擷取時，退出與重新啟動才會嘗試保存最新失敗歷史，最多等待 5 秒（本機保存實測約 5–10 ms；32 MiB 上限低於 200 ms）。已保存就正常退出。若仍有寫入進行中，警告只提供「繼續等待／留在 App」，不提供退出，因為逾時不代表作業系統已停止寫入。若保存失敗且沒有寫入進行中，警告列出尚未保存的提醒筆數及其時間與原因（前五筆，其餘顯示數量），並提供「重試」、「留在 App」與獨立的「不儲存這些提醒並結束」；該選擇會記 log 並關閉歷史 writer。留在 App 會重新開放擷取與自動重試，並清除重新啟動意圖。重複要求加入進行中的嘗試並把提示帶到前景。退出不會附帶確認或保存任何提醒，也不重播系統通知。強制結束與斷電可能遺失尚未保存的提醒。
