# 021 — 選擇要錄哪一個螢幕

[English](021-screen-selection.md) | [繁體中文](021-screen-selection.zh-TW.md)

狀態：實作尚未開始；2026-09-23 已同意修訂設計。023 已完成，接下來順序為 021 → 022。建立：2026-09-21。本次只修改計畫，尚未實作或驗證 App 行為。

## 問題與目標

目前 [index.ts](../src/main/index.ts) 的 `chooseDisplayMedia` 選擇主要顯示器，找不到對應來源時退回第一個螢幕來源。使用者無法自行選擇外接螢幕。

在「設定 → 錄影」新增螢幕選擇，重新啟動後保留偏好。預設繼續跟隨主要顯示器；指定螢幕只以已儲存的 id 解析，重新接上後若 id 改變就要求重選，無法解析時拒絕開始，不自動改錄另一台。範圍是支援的 macOS App 上的整個顯示器，音訊政策不變；其他平台保留既有行為，不宣稱已驗收。見[範圍](#完成條件與範圍)。

## 設計決策

### 預設仍是主要顯示器

`{ kind: "primary" }` 代表 macOS 當下的主要顯示器，不是存下來的固定 id。保留現有來源選擇政策：先找主要顯示器 id 對應來源，找不到就退回第一個來源。來源、正常 tray、既有 log 與預設驗收行為維持相容。這個 fallback 只適用於 `primary`，不適用於指定螢幕。

### 指定螢幕只保存 id 與顯示名稱，不做啟發式恢復

儲存 `{ kind: "display", id, label }`，只接受當下顯示器清單中的精確 id 匹配。名稱只是失去連接後仍可呈現的說明資料，不是身分；不依名稱、尺寸、型號或清單順序匹配，不自動改寫已儲存的 id。即使只有一台同名同尺寸螢幕，id 改變仍要求明確重選。

保證是「解析失敗時不自動代換來源」，不是永久實體硬體身分。平台 id 不是永久硬體識別碼，本設計無法排除 id 重用；同 id 重接可以解析，新 id 則需要重選。原生硬體識別與跨重接自動匹配不在第一版範圍內。

id 必須是支援顯示器 id 的非空字串；指定選擇拒絕已知無效／合成特殊值，例如 Electron 的 -1、-10。空名稱有效，以穩定、可翻譯的顯示文字替代。輸入清單出現重複 id 時視為歧義，不任選一筆。

### 無法使用時拒絕開始，並保留可見原因

指定目標不存在、有歧義、沒有對應擷取來源，或拓撲變動後仍無法安全解析時，使用 `display_unavailable`。另外保留結構化原因，區分「指定螢幕無法使用，請重新選擇」、「螢幕仍連接但擷取來源無法使用」與「顯示器配置已變更，請重試」，不能全部說成未連接。

沿用既有拒絕、錯誤映射與 log 路徑，通知遵守現有開關。main 另在記憶體保留最近一次顯示器相關的開始／擷取失敗，投影到 tray 與「設定 → 錄影」，關閉通知仍看得到。直到錄影成功開始，或成功儲存不同的螢幕偏好才清除；嘗試開始、刷新 UI、儲存失敗都不能清除。診斷不跨 App 重啟保存，重啟後重新計算當下目標是否存在。log 記錄要求與解析的 id、選擇規則、重試次數及失敗原因。

過期選項維持選取但不能當作新的 action 提交。使用者可選「主要顯示器」或已連接的可用選項，不需重啟。目標當下不存在時 tray 顯示無法使用；歷史錯誤標成「上次失敗」，不能在重接後仍誤稱螢幕未連接。

### 共用顯示器解析，再選擷取來源

將純邏輯移至 `src/main/display-source.ts`：`resolveDisplayPreference({ displays, primaryDisplayId, preference })` 提供設定、tray 與錄製共用的目前目標結果；`selectScreenSource({ sources, resolution, preference })` 再映射到實際擷取來源。設定列出顯示器不代表已確認能擷取。

`primary` 保留主要 id 優先、第一來源 fallback，空來源清單為 `no_display`。指定螢幕必須有唯一的目前顯示器，以及唯一 `display_id` 相符的來源；缺少、空 id 或歧義都是 `display_unavailable`，包括空來源清單。`getSources` 丟出例外仍沿用 darwin → `permission_denied`、其他平台 → `no_display`。以測試固定錯誤優先順序。

### 有限重試與過期請求防護

開始時固定偏好與錄影嘗試身分。每次顯示器新增、移除或資訊變動事件都增加拓撲世代值，偏好鎖定期間也要追蹤。指定螢幕的流程：讀取目前顯示器與世代值、等待 `getSources`、交付來源前再次確認世代、精確目標與嘗試仍有效。

暫時缺少來源或拓撲變動最多列舉三次，每次間隔 150 ms，始終使用同一份偏好。明確不存在或有歧義的目標立即拒絕；權限／列舉例外不重試，不替換目標。

取消或新的嘗試使舊結果與計時器失效。每個 callback 最多完成一次；過期請求不可授予擷取，也不可覆寫新嘗試的拒絕理由或 UI 診斷。既有錄影開始 timeout 仍是外層限制，三次重試不能限制永不返回的 `getSources`。測試取消／timeout 後延遲完成，以及接著開始新錄影。兩種模式都套用請求生命週期防護，primary 的來源選擇政策不變。這些檢查無法使 OS 擷取成為原子操作；交付後失敗沿用擷取失敗路徑。

### 尺寸是顯示資訊，不是身分或成品尺寸

即時 `DisplayInfo` 包含 `id`、`label`、`logicalWidth`、`logicalHeight`（DIP）、`scaleFactor`、`internal`、`primary`；偏好不保存尺寸。若設定顯示尺寸，明確標示為邏輯尺寸，不稱為錄影原生像素。成品像素依實際 video track 與既有解析度上限／品質政策驗證，不從 Screen API 推算。旋轉與縮放更新資訊，不改變 id 偏好。

### 設定清單不啟動擷取

清單來自 `screen.getAllDisplays()`，維持 `settingsView` 對 state/context 的純投影；開啟設定不呼叫 `desktopCapturer` 或要求擷取權限。開始時才能確認擷取可用性，兩份清單不一致時保留明確失敗原因。

Renderer 只回傳選項 id，main 依重新建立的模型授權並取得 id 與名稱，不新增帶值 IPC。未知、過期或停用選項不能執行。錄影分頁的 id 清單必須加入 `screen`。

### 顯示器事件更新 UI，不改錄其他來源

訂閱 `display-added`、`display-removed`、`display-metrics-changed`，每次都增加拓撲世代值；錄影器已結束時刷新設定與 tray，從忙碌回到已結束時也重新投影，涵蓋忙碌期間的變動。事件不切換進行中的錄製來源。

選擇只放在設定，不新增 tray 子選單。指定目標可用時，tray 顯示「待命中 — <名稱>」；預設正常狀態仍是「待命中」。無法使用與上次失敗依前述規則呈現。

### 不使用系統挑選器

維持目前 display-media handler 與 `audio: "loopback"` 音訊政策，不啟用會繞過 handler 的 `useSystemPicker`。只有系統挑選器能與 App 指定音訊來源並存時才重新評估，見[音訊設計](../docs/zh-TW/system-design/audio-quality.md)。

### 錄製中失去目標就結束，不替換或自動重建

沿用 host 的 video-track-ended／`capture_failed` 與既有部分檔案保留流程。另以顯示器事件偵測本次實際目標 id 被移除，導向相同、可重複呼叫但只收尾一次的失敗流程，不只依賴 OS 發出 `ended`。保留可救回內容，在 tray／設定說明原因，絕不切換來源。測試移除、track end、使用者停止同時發生。部分檔案不保證可播放，需實際驗證並記錄。自動重建串流不在本計畫範圍。

## 預期體驗

- 「設定 → 錄影」新增「螢幕」，首先是「主要顯示器」，接著是各顯示器名稱，如「內建 Retina 顯示器（主要）」；說明錄製整個螢幕，音訊仍為系統音訊。
- 選擇立即儲存，啟動、錄製、存檔期間鎖定。
- 待命時插拔會更新清單，過期選擇仍選取且顯示原因。
- 指定目標無法解析就拒絕開始；通知開啟時通知，tray 回到待命但保留錯誤。重選後不需重啟。
- 非主要螢幕錄影內容正確，輸出尺寸符合實際來源與解析度上限，品質設定不變；log 記錄目標與選擇規則。
- 預設正常路徑維持 tray、log 與 `pnpm acceptance` 的既有行為。

## 執行順序

### 1. 共用偏好與詞彙

- [ ] 新增 `src/shared/display.ts`：兩種 `DisplayPreference`、預設 primary、`isDisplayPreference`、前述 `DisplayInfo` 與共用名稱組字邏輯。
- [ ] 在 [state.ts](../src/shared/state.ts) 加入 `display_unavailable`。
- [ ] 測試缺少／空／非字串／無效 id、非字串名稱、未知 kind；即時尺寸與 scale 拒絕非有限或非正值；空名稱退路與主要標記穩定。

### 2. 儲存

- [ ] 在 [settings.ts](../src/main/settings.ts) 寬鬆讀取 `display`，無效設定回退預設並記 warning，增加 `setDisplay`；沿用後加欄位慣例，不升 `SETTINGS_VERSION`。有效但不存在的 id 必須保留，不當成無效設定。
- [ ] 測試兩種偏好往返、無效值回退、version 1–3 缺欄位使用預設、儲存其他設定不遺失選擇。

### 3. 來源解析與非同步協調

- [ ] 新增共用 resolver 與 `selectScreenSource`，接到 [index.ts](../src/main/index.ts)，包含拒絕、結構化原因與診斷 log。
- [ ] 測試 primary id 匹配與第一來源 fallback；指定 id 匹配；同名同尺寸但不同 id（一台或多台）均不恢復；重複 id／來源拒絕；空來源與缺少 `display_id` 的錯誤優先順序。
- [ ] 受控非同步測試：列舉中拓撲變動、重試成功／耗盡、目標消失、取消／timeout 後舊結果返回且已有新嘗試；callback 最多一次，舊拒絕不污染新嘗試。移除／track end／停止競態只收尾一次。

### 4. 設定與 tray

- [ ] 在 [ui-model.ts](../src/main/ui-model.ts) 的 context 加入顯示器、偏好與保留的失敗資訊；action 加入 `setDisplay`。
- [ ] 在 [settings-model.ts](../src/main/settings-model.ts) 新增 recording 的 `screen` 群組，包含失效說明與品質設定相同的鎖定規則。
- [ ] 在 [tray-model.ts](../src/main/tray-model.ts) 呈現目標／無法使用／上次失敗；[tray.ts](../src/main/tray.ts) 增加通知。
- [ ] 測試選項、唯一選取、過期選項停用且不重複、未知 id 不授權、有效 id 回傳 id 與名稱、錄製期間鎖定。各投影對缺少目標／缺少來源結果一致；正常 primary 不變。通知關閉仍保留失敗，只在規定條件清除；不把 id 重用宣稱為硬體身分保證。

### 5. Main 接線

- [ ] `handleAction` 再檢查已結束狀態、儲存、log、刷新與寫入失敗處理；失敗不改偏好或清診斷。
- [ ] 訂閱顯示器事件，追蹤拓撲與實際錄影目標移除；已結束與返回已結束時刷新。`will-quit` 解除監聽並使待處理嘗試／計時器失效。

### 6. 訊息

- [ ] 在 [i18n.ts](../src/shared/i18n.ts) 加入英文與繁中標籤、說明、無法使用／缺少來源／拓撲變動、上次失敗、恢復指引、邏輯尺寸單位及通知，具名參數一致。

### 7. 文件與檢查

- [ ] 更新[錄製設計](../docs/zh-TW/system-design/recording.md)、[桌面設計](../docs/zh-TW/system-design/desktop.md)、[webrtc.md](../docs/zh-TW/system-design/webrtc.md) 與三份[英文版](../docs/system-design/)。
- [ ] 實作後執行 `pnpm check` 與 `git diff --check`。

### 8. 行為驗收

- [ ] 依[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 以 `pnpm start:app` 驗證預設開始 → 停止 → 存檔 → 播放、tray 與 log；重建或結束前確認沒有使用者錄影。
- [ ] 人為設定不存在但格式有效的 id，重啟驗證拒絕、設定說明、通知、log、待命保留原因，改選 primary 不重啟即可恢復。關閉通知再測；僅成功開始或成功儲存不同選擇才清除診斷。此項不需第二台螢幕。
- [ ] 預設與有效指定螢幕各執行一次 `pnpm acceptance`，每輪後 App 會關閉，下輪先重啟。
- [ ] 有第二台硬體時，確認錄到該螢幕與成品尺寸；設定開啟時拔除並確認清單／原因。重接相同 id 可解析，改變 id 必須重選，不按名稱／尺寸恢復。錄製中拔除另測結束、保留原因與檔案實際可救回程度。
- [ ] 鏡像、旋轉、縮放及兩次啟動間解析度改變，硬體允許就測。沒有硬體的項目明記未測，不以單元測試代替實測。
- [ ] 每輪原生驗收後儲存自己開始的錄影、還原設定、關閉測試 UI、正常退出 App 並確認程序結束；清理不完整記為失敗／阻礙。
- [ ] 在[驗證紀錄](../docs/zh-TW/verification/README.md) 保存實測、失敗、未測與證據限制。

## 完成條件與範圍

本計畫不授權 commit、push、tag 或發布。範圍外：視窗／App／區域／跟隨游標錄製、同時錄多螢幕、跨重接自動辨識、原生硬體身分、自動重建串流、依螢幕區分品質、縮圖、tray 子選單、系統挑選器及 Windows／Linux 驗收宣稱。音訊仍是系統音訊，不是只錄選定螢幕上內容的聲音。

完成後把長期結論與證據寫入設計與驗證文件，再依[完成計畫流程](README.zh-TW.md#完成計畫)更新索引並移除雙語計畫。

## 技術參考

- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)：擷取來源。
- [Electron Display](https://www.electronjs.org/docs/latest/api/structures/display)：id、名稱、尺寸、scaleFactor 與特殊 id。
- [Electron screen](https://www.electronjs.org/docs/latest/api/screen)：顯示器清單與事件。
- [Electron display-media handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)：handler 與系統挑選器。
- [Apple CGDirectDisplayID](https://developer.apple.com/documentation/coregraphics/cgdirectdisplayid)：顯示器 id；不把它視為永久硬體識別碼。

## Cap 參考與刻意保留的差異

僅閱讀 [Cap commit ce785e7](https://github.com/CapSoftware/Cap/tree/ce785e705e79652adba4b8bf752669c4093499e0) 原始碼，未執行 Cap。[macOS 開始準備](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/recording.rs#L645-L713) 會以三次嘗試、150 ms 間隔檢查目標；[擷取監控](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/recording/src/sources/screen_capture/macos.rs#L665-L789) 在重建串流前確認目標仍存在。借鏡有限檢查與目標遺失處理，不引入自動重建。Cap 主介面有第一台 fallback，但 picker 直接提交指定目標；RecordStuff 對明確選擇採所有入口一致、不替代的政策。此參考不能證明永久硬體身分，也不是 RecordStuff 已驗證的證據。
