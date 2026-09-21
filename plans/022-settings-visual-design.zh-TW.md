# 022 — 設定面板的視覺設計

[English](022-settings-visual-design.md) | [繁體中文](022-settings-visual-design.zh-TW.md)

狀態：尚未開始；設計已提出，程式尚未動工。優先順序：021 之後。建立：2026-09-21。

## 問題與目標

設定面板是 RecordStuff 唯一的視窗。使用者看得到的其他東西只有一個選單列圖示、一則通知和一個檔案，所以整個 App 的視覺印象全押在這一個視窗上 — 而它現在看起來就像一張沒有樣式的表單。每一項偏好，包括只有開與關兩種狀態的那兩項，都畫成同一個滿版 `<select>`，包在同一個有框的卡片裡（[renderer/settings.ts](../src/renderer/settings.ts)、[settings.css](../src/renderer/settings.css)）。「一般」分頁堆了六張一模一樣、彼此沒有任何分組關係的卡片，快捷鍵、兩個更新控制項、通知與語言因此讀起來像權重相同的陌生人。其中三張卡片還永遠掛著一段說明文字。保存失敗時，紅色訊息出現在視窗最下方，離出問題的控制項很遠。焦點框是一個寫死的藍色，不理會使用者的 macOS 強調色；而內容欄的寬度上限是 560px，卻裝在 460px 的視窗裡，這條規則從來沒生效過。

把面板做成 macOS 使用者已經認得的形狀：分組的內縮清單、該是開關的東西就用開關、真正是清單的才用彈出選單、採用系統色，並且讓失敗出現在它發生的地方。面板必須維持和現在一模一樣的誠實程度 — 同樣的偏好、同樣的 id、同樣的鎖定規則、同樣的保存路徑 — 而且繁體中文不能比英文更難讀。範圍是設定視窗；tray、通知與首次啟動提示不在本計畫內。

## 設計決策

### 只動呈現，契約仍然是回傳 id

不新增、不移除、不改名、不改任何偏好的預設值；不更動任何群組或選項 id；`preferencesUnlocked` 與 [settings-window.ts](../src/main/settings-window.ts) 的保存路徑原封不動。一個同時重畫面板又改變控制項行為的計畫沒辦法審查，因為每一處視覺差異都會變成行為差異的候選解釋。

因此面板依然是收到一份畫好的 view，依然只回傳群組 id 與選項 id。開關回傳的是今天兩個選項的 `<select>` 回傳的那個 `on` 或 `off`，分段控制回傳的也是原本 `<option>` 的同一個 id。本計畫沒有任何一處讓 renderer 能描述 main 沒有提供的工作 — 而那正是 [settings-panel.ts](../src/shared/settings-panel.ts) 存在的理由。

### 控制項型態由 main 宣告，renderer 不猜

renderer 分不出布林值和只有兩項的清單：`notifications` 是開／關，`language` 是 English／繁體中文，兩者都是兩個選項，但只有一個該是開關。在 renderer 裡數選項數量等於把這個判斷寫在錯的行程裡，而且清單長度一變，控制項就會默默換一種樣子。

`SettingsGroup` 新增 `control?: "switch" | "segmented" | "menu"`，預設 `menu`，由 [settings-model.ts](../src/main/settings-model.ts) 在既有的選項宣告旁邊一次講清楚。模型遵循的規則寫下來，未來新增群組時就不必從頭吵一次：

- `switch`：真正只有開或關的偏好 — `notifications`、`updateChecks`。
- `segmented`：最多三個互斥選項，且標籤在兩種語言下都很短 — `videoQuality` 與 `language`。
- `menu`：其餘一律。`resolutionCap` 有四個選項；`frameRate` 帶著「60 fps（此平台尚未驗證，暫不開放）」這種任何分段都裝不下的長標籤；`hotkey` 則是一份 020 之後只會更長的清單。

`kind` 維持現在的意思 — 這個群組「是什麼」（今天是 `"actions"`，020 之後還有 `"shortcut"`）— 而 `control` 說的是一個帶值的群組「怎麼畫」。`kind: "actions"` 的群組沒有值，會忽略 `control`。

### 原生彈出選單與原生核取方塊維持原生

`<select>` 不會被自製 listbox 取代。它是面板裡唯一一個已經具備正確鍵盤操作、正確 VoiceOver 播報、在 `forced-colors` 下行為正確，而且彈出選單是由 macOS 自己畫的控制項；手工替代品只是換一件好看外衣的降級。改變的只有它的外觀。

下面的控制項也照同一套推論。開關是 `<input type="checkbox" role="switch">`，分段是 `radiogroup` 裡真正的 `<input type="radio">`，視覺層都是疊在它們之上，而不是取代它們。在 `forced-colors: active` 下丟掉自訂層，三種控制項都交由平台原樣繪製 — 現行樣式表對 `<select>` 箭頭已經是這麼做的。

### 面板是分組清單，不是一疊長得一樣的卡片

列（row）隸屬於區段（section）。`SettingsGroup` 新增 `section?: string`，相鄰且 section id 相同的群組畫成同一份內縮清單，列與列之間以細線分隔；區段可以帶一個標題與一段註腳，都是選用。區段之間的間距由區段擁有，不由列擁有。

有兩處分組立刻回本。「錄影」分頁裡，影像品質、解析度上限與幀率合成一份清單，而不是三個方框。「一般」分頁裡，「啟動時檢查更新」與「更新」動作群組合成同一個區段、共用一個標題 — 今天它們是兩張講同一件事、卻毫無理由並排的卡片。標題維持罕用：列本身已經說出主題的區段不另給標題。

### 一列是標籤靠前、控制項靠後，註解在下方

每一列把標籤放在前緣、控制項放在同一行的後緣，也就是 macOS 系統設定的排法：控制項因此對齊成一欄，面板也不再為每個標籤花掉一整行。註解維持自己一行，放在所屬的列下方，使用次級字級並佔滿列寬；較長的中文與英文標籤在那裡換行，而不是被截斷。視窗寬度低於門檻時，整列改為標籤在上、控制項在下，讓把視窗拉窄的使用者看到的仍是完整標籤而不是刪節號。

現在掛在每個標籤上的粗暴 `overflow-wrap: anywhere` 隨之移除：它會把英文單字從中間切斷，而那個問題本來就該由雙欄排版與正常換行解決。

### 報告狀態的註解要播報，解釋用的註解不要

面板有兩種註解，現在被一視同仁。「在相同解析度下，較高品質可保留更多細節…」是使用者還沒來就已經成立的靜態說明；「無法使用：這個快捷鍵被其他 App 佔用。」與「已是最新版本（檢查時間：…）」則是因為剛剛發生了什麼才出現、才改變。後者正是 live region 的用途，而今天只有 actions 群組的註解拿到 `role="status"`，快捷鍵被拒絕這件面板能講的最重要的事反而沒有。

因此 `note` 增加一個同伴欄位 `noteKind?: "explanation" | "status"`，預設 `"explanation"`：解釋維持以 `aria-describedby` 綁在控制項上，狀態註解則在變動時額外播報。這是一個 main 本來就知道答案的單欄位新增。

### 失敗回報在失敗的那個控制項旁邊

視窗底部的 `#feedback` 不是「無法套用這項設定」該待的地方：在有六個群組的視窗裡，訊息可能離使用者剛剛碰的控制項一個畫面遠。renderer 本來就知道它問的是哪一個群組（`saving.group`），而 `SettingsChoiceResult.applied` 本來就給了答案，所以不需要改契約。失敗畫在出問題的那一列裡，另以一個視覺隱藏的 live region 保留播報，照顧沒有在看那一列的人。失敗文字仍然來自 main 的 `view.failure`，不變。

### 分頁改成分段控制，並且不再假設只有兩頁

分頁列從兩個滿版、選取時染上寫死藍色的按鈕，改成標題下方的一組 macOS 風格分段控制。

鍵盤處理同時重寫，因為它現在是照著 `"recording"` 與 `"general"` 兩個字面 id 寫的：Home 選 `"recording"`，End 選 `"general"`，兩個方向鍵都只是在兩者間互換。方向鍵、Home 與 End 改成對 `view.tabs` 做索引運算，這樣哪天多出第三個分頁 — 021 已經要往「錄影」加一個群組 — 鍵盤不會默默失效。[ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) 的既有實作保留：roving `tabIndex`、`aria-selected`、`aria-controls`。

### 用系統色，不用一個寫死的藍

`color-scheme: light dark` 與 `light-dark()` 保留，它們本來就對。改變的是強調色不再是 `#2476db`。焦點框與選取狀態改用平台強調色 — `AccentColor`／`AccentColorText`，以及原生控制項上的 `accent-color`，並保留現行藍色作為不支援系統關鍵字時的後備 — 讓改過 macOS 強調色的使用者看到自己的顏色。文字、邊框與底色值集中成一小組自訂屬性寫在同一個區塊，不再每條規則各寫一次；每一組配對在淺色與深色下都維持至少 4.5:1 的對比。

[官網主題](../website/src/themes/ember.css)的錄影紅刻意不引進。紅色在這個 App 裡的意思是「正在錄影」，而設定視窗正是唯一永遠不會在錄影的介面；在這裡用紅色當強調色，會是這個 App 第一次把狀態色拿來裝飾。

### 標題固定，清單捲動

今天捲動的是 `body`，所以內容一長，標題、提示與分頁列就跟著離開視窗。標題與分頁改為固定，區段清單自己擁有捲動區域 — 這是 macOS 設定視窗的行為，也讓「錄製作業進行中，錄製相關設定暫時鎖定。」這句提示在最需要被看到的時候留在畫面上。

視窗尺寸改成在一般情況下正好裝得下分組清單而不需捲動，維持 `resizable` 與最小尺寸；內容欄給一個真正會生效的寬度上限，讓把視窗拉寬的使用者得到置中的一欄，而不是被拉滿整個視窗的列。現行那條裝在 460px 視窗裡的 `max-width: 560px` 以失效規則的身分移除。

### 鎖定會說明理由，每個區段說一次

半透明的停用控制項不會自我說明。錄製進行中時，「錄影」區段的註腳會說明錄製設定在停止錄影前暫時鎖定 — 就是 main 已經以 `view.hint` 送出的那句話，只是放在被變灰的控制項旁邊，而不是只放在一個可能已被捲走的視窗頂端。語言維持可用，也不需要說明；它是唯一一項永遠不碰錄製工作的偏好。

「每次變更都整個重畫」的模型維持不變。它正是面板之所以是投影而非第二份真相來源的原因，而既有的以元素 id 還原焦點（含 `preventScroll`）已經涵蓋了它的代價。

### Renderer 的測試是驗收 fixture，不是新增一套 DOM 執行環境

Vitest 跑在 `node` 環境，專案沒有 jsdom 或 happy-dom 相依；`capture-host.test.ts` 就是刻意寫成不需要 DOM。為了用單元測試檢查樣式表而加進一套 DOM 執行環境，買到的只是一個假瀏覽器對版面的意見。

面板真正的測試本來就存在：[`pnpm acceptance:settings`](../scripts/acceptance-settings.mts) 透過 [scripts/fixtures/settings-panel.mjs](../scripts/fixtures/settings-panel.mjs) 在真正的 Electron 視窗裡載入實際出貨的頁面與 preload 並加以操作，還會寫出 `panel.png`。該 fixture 目前是對著現在的 DOM 斷言（`.row`、`select`、`#feedback`），所以本計畫必須把每一條斷言搬到新結構上、保留它檢查的每一個行為，並補上開關、分段與行內失敗的案例。它的截圖就是改版前後的證據。純模型的新增（`control`、`section`、`noteKind`）在 [settings-model.test.ts](../src/main/settings-model.test.ts) 以一般資料測試。

### 與 020、021 的先後關係

020 會加入快捷鍵擷取控制項，021 會加入「螢幕」群組，兩者都落在本計畫要重寫的同三個檔案裡。把本計畫排在最後，代表每個新控制項只依照完成後的詞彙撰寫一次，不必先做樣式再重做 — 這就是優先順序排在 021 之後的理由。

若維護者希望視覺工作提早，代價明講而不藏：020 與 021 要為自己新增的群組宣告 `section` 與 `control`，各一個欄位；020 的擷取欄位則以第四種 `control` 值加入。本計畫不擋這兩個計畫，它只決定由誰負擔返工。

## 預期體驗

- 開啟設定後，標題與分頁列固定不動，下方的偏好可捲動，分頁畫成一組分段控制。
- 「錄影」是單一分組清單：影像品質與解析度上限分別是分段與彈出選單，說明在其下方；幀率是彈出選單，仍列出未驗證的幀率，也仍然不讓它被選取。
- 「一般」把快捷鍵、通知、更新與語言分成不同區段；「通知」是開關，「開啟通知設定…」在同一區段內；「啟動時檢查更新」與「檢查更新…」共處於同一個「更新」標題之下。
- 未生效的變更會在出問題的那一列以面板語言說明，同時繼續顯示已提交的值；螢幕閱讀器使用者會聽到一次。
- 被作業系統拒絕的快捷鍵保留選取與註解，且該註解出現時現在會被播報。
- 錄製期間，錄製偏好變灰且區段說明原因；語言仍可使用；面板的任何狀態都不會阻擋開始、停止或存檔。
- 淺色與深色都跟隨系統，焦點框是使用者的 macOS 強調色，純鍵盤操作能依可見順序走到每個控制項，Escape 與 ⌘W 仍然關閉視窗。
- 繁體中文與英文在預設尺寸與最小尺寸下都裝得下，不截斷、不出現水平捲軸。

## 執行順序

### 1. 契約與模型

- [ ] 在 [settings-panel.ts](../src/shared/settings-panel.ts) 新增 `control`、`section` 與 `noteKind`，皆為選用欄位並寫明預設值，讓舊的 fixture view 仍能算繪。
- [ ] 在 [settings-model.ts](../src/main/settings-model.ts) 逐群組宣告：`notifications` 與 `updateChecks` 用開關，`videoQuality` 與 `language` 用分段，其餘用選單；「錄影」一個區段，「一般」分為快捷鍵、通知、更新與語言四個區段。
- [ ] 將快捷鍵被拒、更新結果與通知已關閉的註解標為 `status`，品質說明標為 `explanation`。
- [ ] [settings-model.test.ts](../src/main/settings-model.test.ts) 測試：各群組宣告的控制項與區段、註解類別，以及群組 id、選項 id、預設值與鎖定行為皆未改變。

### 2. 樣式表

- [ ] 以單一 token 區塊重寫 [settings.css](../src/renderer/settings.css)：底色、邊框、兩級文字、圓角、帶後備的平台強調色，以及 macOS 字級階層。
- [ ] 建立區段清單、列（標籤在前、控制項在後、註解在下，窄於門檻時改為堆疊）、開關、分段控制與重新設計外觀的彈出選單。
- [ ] 三種控制項都保留 `forced-colors: active` 的退場機制，任何轉場都遵守 `prefers-reduced-motion`，並在兩種配色下都維持可見的焦點框。

### 3. Renderer

- [ ] 在 [renderer/settings.ts](../src/renderer/settings.ts) 算繪區段與三種控制項，每一種回傳的群組與選項 id 都與今天相同。
- [ ] 把失敗訊息移進出問題的那一列，並保留視覺隱藏的 live region；把 `noteKind` 接到 `aria-describedby` 或 live 註解。
- [ ] 以對 `view.tabs` 的索引運算取代兩分頁的鍵盤運算。
- [ ] 維持整個重畫與以 id 還原焦點的做法。

### 4. 視窗

- [ ] 在 [settings-window.ts](../src/main/settings-window.ts) 調整視窗尺寸以裝下分組清單，維持 `resizable` 與最小尺寸，並給內容一個真正生效的寬度上限。

### 5. 訊息

- [ ] 把任何新字串（區段標題、鎖定區段的註腳）以英文與繁體中文加入 [i18n.ts](../src/shared/i18n.ts)，佔位符保持一致。句子已經存在的一律沿用既有字串。

### 6. 驗收 fixture

- [ ] 將 [scripts/fixtures/settings-panel.mjs](../scripts/fixtures/settings-panel.mjs) 改到新結構，保留它已經斷言的每一個行為：CSP 與 console 乾淨、preload 表面、沙箱、首次算繪語言、已提交值、平台不支援的選項被停用、快捷鍵被拒的註解、只傳 id 的 IPC、保存排隊期間插入推播，以及通知卡片與其面板按鈕。
- [ ] 補上開關、分段選擇、行內失敗與分頁分段控制的案例。
- [ ] 保留 `panel.png`，並在兩種語言與兩種配色下各截一張作為改版前後的證據。

### 7. 文件

- [ ] 更新[桌面設計](../docs/system-design/desktop.md#settings-window)的「設定視窗」一節與其[翻譯](../docs/zh-TW/system-design/desktop.md#設定視窗)，說明控制項詞彙、區段與行內失敗。
- [ ] 執行 `pnpm check` 與 `git diff --check`。

### 8. 驗證行為

- [ ] 在建置好的 App 中從 tray 開啟面板，於英文與繁體中文、淺色與深色、預設與最小視窗尺寸下檢查兩個分頁。使用[原生 computer-use 驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 搭配 `pnpm start:app`；重新建置或結束前先確認沒有使用者的錄影正在進行。
- [ ] 只用鍵盤操作每一個控制項，再用 VoiceOver 走一次：標籤、開關狀態、分段選取、被播報的狀態註解與行內失敗。
- [ ] 開始錄影後開啟面板，確認錄製偏好變灰且有說明理由、語言仍可使用，然後正常停止並存檔。
- [ ] 執行 `pnpm acceptance:settings` 與 `pnpm acceptance`，確認開始 → 停止 → 存檔 → 播放不受影響。
- [ ] 檢查非預設的 macOS 強調色與「提高對比」；未檢查的項目據實記錄。
- [ ] 把實際測過與未測的內容連同改版前後截圖記入[驗證紀錄](../docs/zh-TW/verification/README.md)。

## 完成條件與範圍

本計畫不授權 commit、push、tag 或發布。範圍外：任何對「有哪些偏好」、其預設值、其 id 或鎖定規則的更動；tray 選單、通知與首次啟動提示；側邊欄或第三個分頁；視窗毛玻璃、自訂標題列或紅綠燈位置調整；全 App 主題或主題偏好；控制項狀態轉場以外的動畫；引進官網配色；新增 DOM 測試執行環境；以及任何 Windows 或 Linux 的驗收宣稱。不得為了拍截圖而更動使用者已儲存的偏好。

完成後把永久結論寫入[桌面設計](../docs/zh-TW/system-design/desktop.md#設定視窗)與[驗證紀錄](../docs/zh-TW/verification/README.md)，再依[完成計畫](README.zh-TW.md#完成計畫)處理。

## 技術參考

- [Apple: Settings](https://developer.apple.com/design/human-interface-guidelines/settings)：分組、區段註腳，以及 macOS 設定視窗被期待長成什麼樣子。
- [Apple: Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)：什麼時候一項偏好該是開關而不是清單。
- [Apple: Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)：「最多三項」規則背後的數量與標籤限制。
- [Apple: Typography](https://developer.apple.com/design/human-interface-guidelines/typography)：字級階層所依循的 macOS 文字樣式。
- [MDN: light-dark()](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark)：現行已在使用、隨配色切換的顏色函式。
- [MDN: accent-color](https://developer.mozilla.org/en-US/docs/Web/CSS/accent-color)：以平台強調色替原生核取方塊與單選鈕上色。
- [MDN: forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors)：每個自訂控制項都需要的退場機制。
- [ARIA APG: Switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) 與 [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)：面板必須保留的角色、狀態與鍵盤行為。
