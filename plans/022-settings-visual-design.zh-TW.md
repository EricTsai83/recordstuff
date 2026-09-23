# 022 — 設定面板的視覺設計

[English](022-settings-visual-design.md) | [繁體中文](022-settings-visual-design.zh-TW.md)

狀態：尚未開始；設計已提出，程式尚未動工。優先順序：023 → 021 → 022。建立：2026-09-21。更新：2026-09-23，整合 focus 與自訂快捷鍵 UI 精修。

## 問題與目標

設定面板是 RecordStuff 唯一的視窗。使用者看得到的其他東西只有一個選單列圖示、一則通知和一個檔案，所以整個 App 的視覺印象全押在這一個視窗上 — 而它現在看起來就像一張沒有樣式的表單。每一項偏好，包括只有開與關兩種狀態的那兩項，都畫成同一個滿版 `<select>`，包在同一個有框的卡片裡（[renderer/settings.ts](../src/renderer/settings.ts)、[settings.css](../src/renderer/settings.css)）。「一般」分頁堆了六張一模一樣、彼此沒有任何分組關係的卡片，快捷鍵、兩個更新控制項、通知與語言因此讀起來像權重相同的陌生人。其中三張卡片還永遠掛著一段說明文字。保存失敗時，紅色訊息出現在視窗最下方，離出問題的控制項很遠。焦點框是一個寫死的藍色，不理會使用者的 macOS 強調色；而內容欄的寬度上限是 560px，卻裝在 460px 的視窗裡，這條規則從來沒生效過。

把面板做成 macOS 使用者已經認得的形狀：分組的內縮清單、該是開關的東西就用開關、真正是清單的才用彈出選單、採用系統色，並且讓失敗出現在它發生的地方。面板必須維持和現在一模一樣的誠實程度 — 同樣的偏好、同樣的 id、同樣的鎖定規則、同樣的保存路徑 — 而且繁體中文不能比英文更難讀。範圍是設定視窗；tray、通知與首次啟動提示不在本計畫內。

## 設計決策

### 視覺方向：融入 macOS，細節有設計感

依使用者於 2026-09-23 補充的偏好，整體以「精緻的 macOS 工具」為視覺方向。延續系統字體、原生視窗框架、熟悉的控制項比例、中性色表面、細分隔線、適度圓角與系統強調色；設計感來自留白節奏、對齊、文字層級及互動狀態的細緻一致。原生 popup 與鍵盤操作維持平台習慣，快捷鍵符號與按鍵外觀保持輕巧。

避免大型品牌標題、裝飾性漸層、厚重陰影、過大膠囊按鈕、滿版強調色與多層卡片；不為模仿系統外觀而新增玻璃／透明材質或自製視窗框架。品牌只在必要的小範圍辨識元素出現，錄影紅保留其狀態意義。這是設定面板與後續 UI 的一致設計原則，不擴大本計畫至重畫 tray 或通知。

視覺驗收除了可讀性，也要將實際 App 與同一台 Mac 的系統設定並排檢視：控制項密度、字級、色彩與焦點不能顯得突兀，且分組與主次必須比目前清楚。保留比較截圖與觀察，不要求逐像素仿製系統設定；淺／深色及繁中／英文都依此檢查。本計畫內的 focus 與快捷鍵精修沿用相同方向，捕捉區展開後仍應像同一套設定控制項。

### 呈現與編輯互動精修，偏好契約維持不變

不新增、不移除、不改名、不改任何偏好的預設值；不更動任何群組或選項 id；`preferencesUnlocked` 與 [settings-window.ts](../src/main/settings-window.ts) 的保存路徑原封不動。本計畫包含自訂入口整併、捕捉區與焦點流向調整；快捷鍵預設值、允許組合、偏好格式及 main 的驗證／註冊責任維持不變。

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

### 一致的焦點樣式

- 以單一共用 token 定義焦點顏色、粗細、間距及圓角，涵蓋 popup、按鈕、頁籤，以及 本計畫新增的 switch／segment。
- 起始規格為 2px 實線、1px offset，沿控制項圓角；移除額外光暈與重複焦點層。以實際 Electron 淺／深色截圖微調，焦點指示與相鄰背景至少 3:1 對比，不靠降低透明度讓焦點變得難辨識。
- 一般控制項依 `:focus-visible` 呈現；滑鼠操作遵循瀏覽器判定，不以全域 `outline: none` 或任意 blur 隱藏焦點。Tab／Shift+Tab 與程式還原焦點後必須看得見位置。
- 系統強調色有可用 fallback；`forced-colors` 使用系統色與實線 outline，不能只依賴 box-shadow。確認未被容器裁切、不引發版面位移。選取、hover、focus、disabled 各有清楚區別。
- 「正在接收快捷鍵」用欄位底色、邊框及文字狀態表達，不再另加與鍵盤焦點競爭的外框；避免閃爍或脈動。

### 快捷鍵列與單一自訂入口

採用同列「標籤／目前快捷鍵選單／自訂…」：標籤靠左，控制項靠右；選單保留原生 `<select>`、既有預設組合、停用選項及已儲存的自訂值。移除選單內重複的「自訂…」動作，只保留旁邊按鈕。已有自訂值時，按鈕顯示「更改…」。在最小視窗寬度改為上下排列，兩種語言都不截斷。

```text
快捷鍵       [ ⌘⇧1  ▾ ]  [ 自訂… ]

快捷鍵       [ ⌘⇧1  ▾ ]  [ 更改… ]
             [ 請按下快捷鍵／⌘ ⇧ K ] [ 取消 ]
             按下組合後自動套用；Esc 取消
```

捕捉區只在編輯時展開，不開 modal。選單保留已提交的值；候選組合以等高的小型按鍵外觀顯示在捕捉欄，修飾鍵與一般按鍵間保留一致間距。可見符號搭配完整可讀的輔助名稱，裝飾用按鍵不增加 Tab 停駐點。不要在原生 option 內插入自製 keycap。

### 狀態與退出行為

| 狀態 | 呈現與行為 |
| --- | --- |
| 閒置 | 顯示已提交值與自訂／更改入口；沒有常駐捕捉框或多餘提示。 |
| 準備中 | 等 main 確認 capture armed 才顯示接收中並聚焦捕捉欄；失敗在該列說明。 |
| 接收中 | 顯示「請按下快捷鍵」、候選按鍵與取消；暫停會攔截候選輸入的全域快捷鍵，沿用既有生命週期。 |
| 套用中 | 顯示簡短狀態並防止重複提交；不讓整列閃白或位移。維持目前按下完整有效組合即自動套用，不增加確認按鈕。 |
| 成功 | main 回覆成功後顯示新值、收合編輯區，焦點回到更改按鈕；簡短狀態只宣告一次。 |
| 無效／衝突／儲存失敗 | 捕捉欄下方顯示具體原因及重試入口，顯示值遵循 main 回傳狀態。區分尚未提交的無效輸入與已儲存但 OS 無法註冊的組合，不假裝舊快捷鍵仍可用。 |
| 取消／失焦／逾時 | 保留既有 15 秒逾時與清理規則；Esc 先取消編輯、不關閉面板；Tab 正常離開並取消。明確取消後焦點回入口，Tab／視窗失焦時不搶回焦點。 |
| 錄影鎖定 | 遵守現有 enabled 規則，不能進入捕捉；顯示鎖定原因。 |

「取消」必須在捕捉欄 blur 時仍可靠生效；切換頁籤、關閉視窗、renderer 失敗與儲存例外都要恢復快捷鍵註冊。保持 ⌘W 關閉語意；非捕捉狀態的 Esc 維持既有關窗行為。錯誤與提示連到控制項的 `aria-describedby`，狀態用單一 live region，避免每個修飾鍵更新都重複播報。

### 標題固定，清單捲動

今天捲動的是 `body`，所以內容一長，標題、提示與分頁列就跟著離開視窗。標題與分頁改為固定，區段清單自己擁有捲動區域 — 這是 macOS 設定視窗的行為，也讓「錄製作業進行中，錄製相關設定暫時鎖定。」這句提示在最需要被看到的時候留在畫面上。

視窗尺寸改成在一般情況下正好裝得下分組清單而不需捲動，維持 `resizable` 與最小尺寸；內容欄給一個真正會生效的寬度上限，讓把視窗拉寬的使用者得到置中的一欄，而不是被拉滿整個視窗的列。現行那條裝在 460px 視窗裡的 `max-width: 560px` 以失效規則的身分移除。

### 鎖定會說明理由，每個區段說一次

半透明的停用控制項不會自我說明。錄製進行中時，「錄影」區段的註腳會說明錄製設定在停止錄影前暫時鎖定 — 就是 main 已經以 `view.hint` 送出的那句話，只是放在被變灰的控制項旁邊，而不是只放在一個可能已被捲走的視窗頂端。語言維持可用，也不需要說明；它是唯一一項永遠不碰錄製工作的偏好。

保留目前值與文字推播的原地更新及焦點／捲動位置；只有結構改變才重建，並以元素 id 還原焦點（含 `preventScroll`）。捕捉區收合後依上述狀態規則安排焦點，不退回每次更新重建 DOM。

### Renderer 的測試是驗收 fixture，不是新增一套 DOM 執行環境

沿用既有 [renderer 測試](../src/renderer/settings.test.ts) 驗證互動邏輯；視覺效果由真實 Electron fixture 與原生 App 驗收，不為 CSS 數值新增鏡像單元測試或另一套 DOM 執行環境。

面板真正的測試本來就存在：[`pnpm acceptance:settings`](../scripts/acceptance-settings.mts) 透過 [scripts/fixtures/settings-panel.ts](../scripts/fixtures/settings-panel.ts) 在真正的 Electron 視窗裡載入實際出貨的頁面與 preload 並加以操作，還會寫出 `panel.png`。該 fixture 目前是對著現在的 DOM 斷言（`.row`、`select`、`#feedback`），所以本計畫必須把每一條斷言搬到新結構上、保留它檢查的每一個行為，並補上開關、分段與行內失敗的案例。它的截圖就是改版前後的證據。純模型的新增（`control`、`section`、`noteKind`）在 [settings-model.test.ts](../src/main/settings-model.test.ts) 以一般資料測試。

### 與既有計畫的先後關係

020 已完成自訂快捷鍵功能；[023](023-settings-shortcut.zh-TW.md) 負責開啟設定的全域快捷鍵及捕捉期間的註冊管理，[021](021-screen-selection.zh-TW.md) 新增螢幕選擇。執行順序為 023 → 021 → 022，本計畫統一完成整體版面、focus 與快捷鍵編輯 UI，避免分成兩輪樣式重作。快捷鍵捕捉沿用上述功能的清理與註冊生命週期。

## 預期體驗

- 開啟設定後，標題與分頁列固定不動，下方的偏好可捲動，分頁畫成一組分段控制。
- 「錄影」是單一分組清單：影像品質與解析度上限分別是分段與彈出選單，說明在其下方；幀率是彈出選單，仍列出未驗證的幀率，也仍然不讓它被選取。
- 「一般」把快捷鍵、通知、更新與語言分成不同區段；「通知」是開關，「開啟通知設定…」在同一區段內；「啟動時檢查更新」與「檢查更新…」共處於同一個「更新」標題之下。
- 未生效的變更會在出問題的那一列以面板語言說明，同時繼續顯示已提交的值；螢幕閱讀器使用者會聽到一次。
- 被作業系統拒絕的快捷鍵保留選取與註解，且該註解出現時現在會被播報。
- 錄製期間，錄製偏好變灰且區段說明原因；語言仍可使用；面板的任何狀態都不會阻擋開始、停止或存檔。
- 淺色與深色都跟隨系統，焦點框是使用者的 macOS 強調色，純鍵盤操作能依可見順序走到每個控制項，⌘W 仍然關閉視窗；Escape 在捕捉時先取消編輯，其餘狀態維持關窗。
- 繁體中文與英文在預設尺寸與最小尺寸下都裝得下，不截斷、不出現水平捲軸。

## 執行順序

先記錄改版前淺／深色、繁中／英文的閒置、focus、捕捉、錯誤與鎖定基準截圖，供整體改版比對。

### 1. 契約與模型

- [ ] 在 [settings-panel.ts](../src/shared/settings-panel.ts) 新增 `control`、`section` 與 `noteKind`，皆為選用欄位並寫明預設值，讓舊的 fixture view 仍能算繪。
- [ ] 在 [settings-model.ts](../src/main/settings-model.ts) 逐群組宣告：`notifications` 與 `updateChecks` 用開關，`videoQuality` 與 `language` 用分段，其餘用選單；「錄影」一個區段，「一般」分為快捷鍵、通知、更新與語言四個區段。
- [ ] 將快捷鍵被拒、更新結果與通知已關閉的註解標為 `status`，品質說明標為 `explanation`。
- [ ] [settings-model.test.ts](../src/main/settings-model.test.ts) 測試：各群組宣告的控制項與區段、註解類別，以及群組 id、選項 id、預設值與鎖定行為皆未改變。

### 2. 樣式表

- [ ] 以單一 token 區塊重寫 [settings.css](../src/renderer/settings.css)：底色、邊框、兩級文字、圓角、帶後備的平台強調色，以及 macOS 字級階層。
- [ ] 建立區段清單、列（標籤在前、控制項在後、註解在下，窄於門檻時改為堆疊）、開關、分段控制與重新設計外觀的彈出選單。
- [ ] 三種控制項都保留 `forced-colors: active` 的退場機制，任何轉場都遵守 `prefers-reduced-motion`，並在兩種配色下都維持可見的焦點框。
- [ ] 套用共用細緻焦點 token 與快捷鍵 keycap／捕捉區樣式，確保符合前述 macOS 視覺方向。

### 3. Renderer

- [ ] 在 [renderer/settings.ts](../src/renderer/settings.ts) 算繪區段與三種控制項，每一種回傳的群組與選項 id 都與今天相同。
- [ ] 把失敗訊息移進出問題的那一列，並保留視覺隱藏的 live region；把 `noteKind` 接到 `aria-describedby` 或 live 註解。
- [ ] 以對 `view.tabs` 的索引運算取代兩分頁的鍵盤運算。
- [ ] 保留原地更新與焦點／捲動位置，結構改變時才重建並以 id 還原焦點。
- [ ] 修改 [settings.ts](../src/renderer/settings.ts) 與 [settings.css](../src/renderer/settings.css)，必要時調整 [shortcut-capture.ts](../src/renderer/shortcut-capture.ts) 的呈現介面；驗證規則與註冊仍由既有 main/shared 邏輯負責。文案同步 [i18n.ts](../src/shared/i18n.ts) 的英文與繁中。
- [ ] 實作單一自訂入口、行內捕捉區、取消、各編輯狀態與就近回饋，依狀態表管理焦點與退出清理。

### 4. 視窗

- [ ] 在 [settings-window.ts](../src/main/settings-window.ts) 調整視窗尺寸以裝下分組清單，維持 `resizable` 與最小尺寸，並給內容一個真正生效的寬度上限。

### 5. 訊息

- [ ] 把任何新字串（區段標題、鎖定區段的註腳）以英文與繁體中文加入 [i18n.ts](../src/shared/i18n.ts)，佔位符保持一致。句子已經存在的一律沿用既有字串。

### 6. 驗收 fixture

- [ ] 將 [scripts/fixtures/settings-panel.ts](../scripts/fixtures/settings-panel.ts) 改到新結構，保留它已經斷言的每一個行為：CSP 與 console 乾淨、preload 表面、沙箱、首次算繪語言、已提交值、平台不支援的選項被停用、快捷鍵被拒的註解、只傳 id 的 IPC、保存排隊期間插入推播，以及通知卡片與其面板按鈕。
- [ ] 補上開關、分段選擇、行內失敗與分頁分段控制的案例。
- [ ] 保留 `panel.png`，並在兩種語言與兩種配色下各截一張作為改版前後的證據。
- [ ] 更新 [renderer 測試](../src/renderer/settings.test.ts) 與 [設定驗收 fixture](../scripts/fixtures/settings-panel.ts)，涵蓋單一入口、等待 armed、候選預覽、取消按鈕／Esc／Tab、成功焦點還原、錯誤重試、push 更新不丟焦點與鎖定；沿用既有失敗與註冊恢復測試，不為 CSS 數值新增鏡像單元測試。

### 7. 文件

- [ ] 更新[桌面設計](../docs/system-design/desktop.md#settings-window)的「設定視窗」一節與其[翻譯](../docs/zh-TW/system-design/desktop.md#設定視窗)，說明控制項詞彙、區段與行內失敗。
- [ ] 執行 `pnpm check` 與 `git diff --check`。

### 8. 驗證行為

- [ ] 執行 `pnpm check`、`pnpm acceptance:settings`、`pnpm acceptance:shortcut`、`pnpm acceptance` 與 `git diff --check`；fixture 證據不冒充原生驗收。
- [ ] 依[原生 computer-use 驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 使用 `pnpm start:app` 的實際 App。重建／關閉前確認沒有使用者正在錄影。驗收鍵盤單獨操作、滑鼠操作、VoiceOver、非預設強調色、Increase contrast 與可測的 forced-colors；未測項目明列。
- [ ] 透過 023 的全域快捷鍵自行開啟真正的設定面板，並確認 tray 入口仍可使用；檢查兩個分頁。
- [ ] 在預設與最小視窗尺寸，檢查兩種語言及淺／深色的 focus、捕捉、錯誤、鎖定：不裁切、不重疊、不水平捲動、不出現雙重外框。保存前後截圖。
- [ ] 開始錄影後開啟面板，確認錄製偏好變灰且有說明理由、語言仍可使用，然後正常停止並存檔。
- [ ] 實際測試自訂／預設／停用及各退出路徑後快捷鍵恢復；用測試建立的錄影確認開始 → 停止 → 儲存 → 播放，並確認錄影鎖定。OS 衝突未實測時保留限制，測後復原偏好並停止、儲存自己建立的錄影。
- [ ] 把實際測過與未測的內容連同改版前後截圖記入[驗證紀錄](../docs/zh-TW/verification/README.md)。

## 完成條件與範圍

完成時須同時具備協調的 macOS 分組版面、清楚細緻的焦點、單一自訂快捷鍵入口、可理解的編輯狀態與可預期的焦點去向，且快捷鍵與錄影功能無回歸。不新增快捷鍵管理頁。本次整合僅更新計畫，不代表 UI 或原生驗收已完成。

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
