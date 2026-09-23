# 021 — 選擇要錄哪一個螢幕

[English](021-screen-selection.md) | [繁體中文](021-screen-selection.zh-TW.md)

狀態：尚未開始；設計已提出，程式尚未動工。優先順序：023（設定快捷鍵）之後，023 緊接 020；除了 [settings-model.ts](../src/main/settings-model.ts) 與 [i18n.ts](../src/shared/i18n.ts) 的共用改動之外，與 019、020 互相獨立。建立：2026-09-21。

## 問題與目標

`chooseDisplayMedia` 一律解析主要顯示器，並在找不到時退回第一個螢幕來源（[index.ts](../src/main/index.ts)、[錄製設計](../docs/zh-TW/system-design/recording.md#開始流程)）。在接了第二台螢幕的機器上，這不是偏好而是規定：想錄的東西得先拖到主要顯示器上，而且 App 完全不提示另一個螢幕存在。App 本來就會擷取任何一個螢幕來源 — 只是「選哪一個」被寫死了。

讓使用者在「設定 → 錄影」選擇目標顯示器。這個選擇能在重新啟動後保留，在平台允許辨識的情況下也能在重新接上後保留；而無法再解析的選擇會以明確理由拒絕開始，而不是默默改錄另一個螢幕。範圍是支援的 macOS App 上的整個顯示器，音訊政策完全不變；其他平台維持既有行為，不宣稱已驗收。單一視窗錄製、區域錄製與同時錄兩個螢幕維持在範圍外（見[範圍](#完成條件與範圍)）。

## 設計決策

### 預設是「主要顯示器」，而且不是一個存下來的 display id

`{ kind: "primary" }` 是預設值，走的是現行程式路徑：主要顯示器的 id，找不到時退回第一個螢幕來源。從未打開這項設定的使用者完全感覺不到差異 — 同一個來源、同一行 log、同一套無人驗收流程；而換過螢幕擺法的使用者，錄到的一直是 macOS 當下認定的主要顯示器。這是唯一不會過期的選擇，所以它是預設值，也因此下面每一條新的失敗路徑，都只有刻意離開預設的人才會遇到。

### 指定的選擇儲存的是指紋，不只是 id

在 macOS 上 `Display.id` 是 CGDirectDisplayID：螢幕保持連接時穩定，但不保證跨越重新接上、重新開機或換底座。只存 id 會讓使用者的選擇在每次拔掉螢幕時默默消失，而 App 會改用另一個螢幕，雙方都不會發現。

因此指定的選擇儲存 `{ kind: "display", id, label, width, height }`，並在每次開始時依序解析：id 相符的顯示器；否則是 `label`、`width`、`height` 三者皆相符且只有一台的顯示器；否則視為無法解析。第二條規則就是撐過重新接上的那一條。它刻意在有歧義時拒絕猜測 — 兩台相同型號的外接螢幕會互相符合，而在同一次連線期間 id 規則本來就已經給出答案；重新接上之後，App 會說它無法判斷，而不是挑一個。實際命中哪一條規則會連同選到的顯示器記進 log，讓「錄錯螢幕」事後仍能被解釋。

### 無法解析的選擇會拒絕開始

新增錯誤代碼 `display_unavailable`。App 不會代換成別的螢幕：`ensureWritableDir` 早已立下「失敗絕不默默改用另一個資料夾」的原則（[錄製設計](../docs/zh-TW/system-design/recording.md#開始流程)），而錄錯螢幕比沒錄到更糟，因為使用者是在會議結束後才發現。拒絕會沿用其他開始失敗的既有路徑 — 理由記在 `lastDenialReason`、由 `mapHostError` 對應、寫進 log、以通知呈現 — 另外在設定面板加一行說明，保留那個過期的選擇為選取狀態並說明該螢幕未連接，就像被作業系統拒絕的快捷鍵一樣維持選取並說明它沒有作用（[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)）。

### 來源選擇變成有測試的純函式，並移出 index.ts

display-media handler 是唯一真正啟動擷取的路徑，而它今天沒有任何單元測試，因為它和 `app`、`screen`、`session` 一起住在 `index.ts`。選擇邏輯移到 `src/main/display-source.ts`：`selectScreenSource({ sources, displays, primaryDisplayId, preference })`，回傳選中的來源與命中的規則，或是它解析不到任何東西的理由。`index.ts` 只保留 callback 接線、deny 輔助函式與 `getSources` 的錯誤對應。

既有行為是原封保留並用測試釘住，不是重新推導一次：沒有來源符合主要顯示器 id 時退回第一個來源、來源清單為空是 `no_display`、`getSources` 丟出例外在 darwin 是 `permission_denied`、其他平台是 `no_display`。Electron 文件說明 `display_id` 可能為空字串；在沒有任何螢幕來源提供 id 的平台上，指定的選擇會是無法解析並直說，而 `primary` 仍能透過第一個來源的退路運作。

### 面板的顯示器清單來自 Screen API，不是 desktopCapturer

`screen.getAllDisplays()` 是同步的、不需要擷取權限、不會觸發任何提示，所以 `settingsView` 仍是 (state, context) 的純投影，打開設定也不會碰到擷取堆疊或向 macOS 要任何東西。`desktopCapturer` 只在錄影開始時才問。兩份清單之間的落差不會被藏起來：面板提供了、但擷取看不到的顯示器，就是上面那條 `display_unavailable`。

### Renderer 依然只回傳 id

新群組的每個選項都由當下的顯示器清單組出，所以 main 授權的 action 本來就帶著它要儲存的完整指紋；面板送回來的只有一個顯示器 id 字串。這個群組不需要像 020 為錄製 accelerator 提出的那種帶值通道，`settingsAction` 仍然是把 id 對到一份重新組出的模型。

### 顯示器數量改變時，兩個投影一起刷新

`screen` 會發出 `display-added`、`display-removed` 與 `display-metrics-changed`。在錄影器處於已結束狀態時，每一個事件都呼叫 `refreshUi()`，所以拔掉的螢幕會從面板消失、過期的選擇會長出說明，不需要重開視窗。錄製途中的事件不改變任何事：工作階段開始時拿到的快照就是這次的來源。

### 不做 tray 子選單，但 tray 會說出非預設的目標

[tray-model.ts](../src/main/tray-model.ts) 刻意不建任何子選單，而逐一列出顯示器不可能是平面選單。因此選擇只住在設定裡。這帶來的風險是使用者忘了這項設定、結果錄了一個閒置的第二螢幕，所以當偏好不是 `primary` 時，待命中 tray 的第一行會顯示 `待命中 — <顯示器名稱>`。維持預設時它仍然只是「待命中」，所以從未動過這項設定的使用者，看到的 tray 與今天完全相同。

### 不用系統挑選器

`useSystemPicker`（macOS 15+、實驗性）可以把選擇交給 Apple 自己的挑選器，本計畫的介面也就不必做；但 Electron 文件明講那時 handler 不會被呼叫 — 而 handler 正是 `audio: "loopback"` 與這個 App 賴以立足的每個音訊決定所在之處（[音訊設計](../docs/zh-TW/system-design/audio-quality.md)）。用實測過的音訊政策去換一個免費的挑選器，不是這個 App 換得起的交易。只有在 Electron 允許系統挑選器與由 App 指定的音訊來源並存時才重新評估。

### 錄製途中消失的顯示器早已有處理

視訊軌結束、host 回報 `capture_failed`（「擷取來源已結束」）、已寫入的部分檔案保留。這條路徑已經存在且不變；寫在這裡是為了避免這份計畫再發明第二條。

## 預期體驗

- 「設定 → 錄影」新增「螢幕」控制項，第一項是「主要顯示器」，接著依名稱列出每個已連接的顯示器 — `內建 Retina 顯示器 — 3456×2234（主要）`、`Studio Display — 5120×2880` — 並附說明：錄製的是一整個螢幕，且這個選擇不影響系統音訊。
- 預設是「主要顯示器」。變更會像其他錄影偏好一樣立即儲存，並在啟動中、錄製中或存檔中鎖定。
- 視窗開著時接上或拔掉顯示器，清單會跟著更新。若被拔掉的正是已儲存的選擇，它仍維持選取，說明文字指出它未連接、無法錄製。
- 在選擇無法解析的情況下開始錄影不會錄：log 說明哪一個已儲存的顯示器對不上、通知說選定的螢幕無法使用、tray 回到待命中。改選「主要顯示器」或任何已連接的顯示器即可恢復，不需要重新啟動。
- 在非主要顯示器上開始的錄影，內容是那個螢幕、尺寸是那個螢幕的尺寸、品質設定不變；開始的那行 log 會寫出顯示器與命中的規則。
- 維持預設選擇時，tray、log 與 `pnpm acceptance` 的行為與今天完全一致。

## 執行順序

### 1. 共用偏好與詞彙

- [ ] 新增 `src/shared/display.ts`：`DisplayPreference`、`DEFAULT_DISPLAY_PREFERENCE`（`{ kind: "primary" }`）、`isDisplayPreference`、`DisplayInfo` 形狀（`id`、`label`、`width`、`height`、`internal`、`primary`），以及兩個投影共用的名稱組字邏輯，包含 `Display.label` 為空時的退路。
- [ ] 於 [state.ts](../src/shared/state.ts) 的 `ERROR_CODES` 加入 `display_unavailable`。
- [ ] 測試：guard 接受兩種 kind，拒絕缺少 id、非字串 id、非有限尺寸與未知 `kind`；未命名顯示器的名稱穩定，且主要顯示器有標記。

### 2. 儲存

- [ ] 於 [settings.ts](../src/main/settings.ts) 寬鬆讀取 `display`，無效值回退 `DEFAULT_DISPLAY_PREFERENCE` 並記 warning，另加 `setDisplay`。不動 `SETTINGS_VERSION`：`updates` 與 `notifications` 已立下先例 — 後來新增的欄位用寬鬆讀取處理，而不是升版。
- [ ] 測試：primary 與指定值皆能往返、無效值回退並記 warning、version 1–3 的檔案沒有這個欄位時取預設、儲存其他設定不會弄掉顯示器選擇。

### 3. 來源選擇

- [ ] 新增 `src/main/display-source.ts` 與 `selectScreenSource`，並讓 [index.ts](../src/main/index.ts) 的 `chooseDisplayMedia` 改用它，包含 `display_unavailable` 的拒絕，以及一行寫出顯示器、id 與命中規則的開始 log。
- [ ] 測試：primary 由 display id 解析；primary 在沒有 id 相符時退回第一個來源；已儲存的 id 相符；重新接上的顯示器由名稱與尺寸相符；兩台相同顯示器在重新接上後視為無法解析；來源清單為空是 `no_display`；來源沒有 `display_id` 時指定的選擇無法解析、primary 仍可運作。

### 4. 面板與 tray

- [ ] 於 [ui-model.ts](../src/main/ui-model.ts) 的 `AppContext` 增加 `displays` 與 `display`、在 `AppAction` 增加 `{ setDisplay: DisplayPreference }`，並在 `appContext()` 從 `screen.getAllDisplays()` 填入兩者。
- [ ] 於 [settings-model.ts](../src/main/settings-model.ts) 在錄影分頁新增 `screen` 群組（它的分頁歸屬是用 id 清單決定的，必須一併加入），附上未連接的說明，並套用與品質相同的鎖定規則。
- [ ] 於 [tray-model.ts](../src/main/tray-model.ts) 在待命中那一行顯示非預設的目標，並於 [tray.ts](../src/main/tray.ts) 加上 `display_unavailable` 的通知訊息。
- [ ] 測試：群組列出 primary 加上每個顯示器，已儲存的那個為選取；已儲存但不存在的顯示器維持選取並帶說明；錄製中群組鎖定；`settingsAction` 對清單內的 id 回傳完整指紋、對未知 id 不回傳任何東西；`primary` 時待命中那行不變，其他情況會寫出顯示器名稱。

### 5. Main 接線

- [ ] 在 `handleAction` 處理 `setDisplay`（已結束狀態檢查、寫檔、log、刷新、寫檔失敗通知），並訂閱 `display-added`、`display-removed`、`display-metrics-changed` 在已結束狀態時呼叫 `refreshUi()`；`will-quit` 時解除監聽。

### 6. 訊息

- [ ] 所有新字串加入 [i18n.ts](../src/shared/i18n.ts) 的英文與繁體中文條目，具名參數保持一致：群組標籤、說明、未連接說明、tray 待命中那行，以及 `display_unavailable` 通知。

### 7. 文件

- [ ] 更新[錄製設計](../docs/zh-TW/system-design/recording.md)（開始流程第 4 步與錯誤分類表）、[桌面設計](../docs/zh-TW/system-design/desktop.md)（設定視窗）、[webrtc.md](../docs/zh-TW/system-design/webrtc.md) 中寫著 main 選擇主要顯示器的那一列，以及三份[英文版](../docs/system-design/)。
- [ ] 執行 `pnpm check` 與 `git diff --check`。

### 8. 驗證行為

- [ ] 維持預設選擇：開始 → 停止 → 存檔 → 播放，並確認 log 與 tray 與今天一致。使用[原生 computer-use 驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 搭配 `pnpm start:app`；重建或結束前先確認沒有使用者正在進行的錄影。
- [ ] 手動把 `settings.json` 改成一個不存在的顯示器、重新啟動，確認拒絕行為：面板的說明、通知、log、之後回到待命中，以及不需重新啟動、改選「主要顯示器」即可恢復。這一項不需要第二台螢幕。
- [ ] 在已儲存指定顯示器與維持預設兩種情況下各跑一次 `pnpm acceptance`。
- [ ] 若有第二台螢幕的硬體：錄它、確認檔案內容是那個螢幕、在面板開著時拔掉它並確認清單與說明更新，再接回去確認選擇由名稱與尺寸規則救回。沒有硬體時，所有多螢幕項目一律記為未測試，不做任何宣稱。
- [ ] 鏡像輸出與兩次啟動之間解析度改變的顯示器屬於已知未確定項；硬體允許就測，無論結果如何都記錄下來。
- [ ] 於[驗證紀錄](../docs/zh-TW/verification/README.md)寫下實際測試與未測試的項目。

## 完成條件與範圍

本計畫不授權任何 commit、push、tag 或發布。範圍外：單一視窗或單一 App 錄製（自成一份計畫 — 音訊語意、視窗身分與錄製途中改變尺寸這三個問題都還沒有答案）、區域錄製與跟隨游標、同一次錄製多個顯示器、依顯示器區分品質、面板縮圖、tray 子選單、macOS 系統挑選器，以及任何 Windows 或 Linux 已驗收的宣稱。音訊政策不變：錄到的是系統音訊，不是被選螢幕上那些內容的音訊。

完成後把長期結論寫入[錄製設計](../docs/zh-TW/system-design/recording.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)，再依[計畫完成流程](README.zh-TW.md#完成計畫)處理。

## 技術參考

- [Electron：desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)：來源 id、`display_id` 以及它可能為空的情況。
- [Electron：Display](https://www.electronjs.org/docs/latest/api/structures/display)：`id`、`label`、`internal`、`size` 與 `scaleFactor`。
- [Electron：screen](https://www.electronjs.org/docs/latest/api/screen)：`getAllDisplays`、`getPrimaryDisplay` 與顯示器變動事件。
- [Electron：session.setDisplayMediaRequestHandler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)：handler 的契約與 `useSystemPicker`。
- [Apple：CGDirectDisplayID](https://developer.apple.com/documentation/coregraphics/cgdirectdisplayid)：為什麼 display id 是限於本次連線期間的識別碼，而不是長期識別碼。
