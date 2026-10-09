# 驗證歷史 — 2026 年 10 月

[English](../../verification/history-2026-10.md) | [繁體中文](history-2026-10.md)

[返回驗證索引](README.md)。以下是歷史證據；現行選測規則見[測試指南](../testing.md)。原始 measurements 連結僅本機可用，新 clone 不會包含。

## 存檔時轉成一般 MP4 與預先載入的全螢幕頁面 — 2026-10-10

維護者要求，排在 plan 071 之前：一支 36 分鐘的錄影開啟時黑屏約一秒，全螢幕也會卡頓。兩項變更（[存檔時轉成一般 MP4](../system-design/recording.md#存檔時轉成一般-mp4)、[桌面設計](../system-design/desktop.md#錄影檔)）；比較時閱讀了 OBS `7d98bebe` 與 Cap `8d808e09`。

- **原因。** 擷取 host 寫的分段 MP4 沒有索引：Chromium 在第一格之前讀了 2.7 GB 檔案（2,106 個片段）的 1,722 個範圍、358 MB，約 1.1 秒；AVFoundation 完全無法開啟（`-11832`）。補上 `mfra` 沒有幫助。
- **存檔時轉成一般 MP4。** `FragmentIndex` 跟著已寫入的位元組讀；finish 時 `FileWriter` 附加完整 `moov` 並 sync，再把 16 位元組的 `mdat` 標頭寫在舊 `moov` 上並 sync，與 OBS 的 hybrid MP4 相同，但 OBS 沒有這兩次 sync。同一支 36 分鐘錄影：建立索引 16 ms、索引 1.5 MB、第一格 41 ms、14 次請求，AVFoundation 也能開啟。若在兩步之間中斷，檔案仍以分段格式播放。
- **全螢幕。** 以新的 `video fullscreen timing` log 行量測：第一格之前的 200 ms 中，有 140 ms 花在建立視窗與載入頁面；150 ms 的淡入本來就平順（最長一步 23 ms）。現在在 macOS 上，設定視窗開著時會有一個頁面隱藏載入待命：第一格 74–75 ms、顯示 82 ms、淡入完成 233–238 ms，之前分別是 168–192、175–199 與 331–357 ms。

### 驗證

- 維護者的四支錄影（10 秒到 36 分鐘）以隨機大小分段送進 `FragmentIndex`：每個封包的串流、解碼與顯示時間、大小與校驗碼都與原檔相同（ffmpeg `framemd5`），只有被修正的長度不同；ffprobe 長度相同；AVFoundation 都能開啟並在 80 % 處畫出影格。依維護者要求，那支 36 分鐘錄影已換成重新封裝的版本（原檔移到垃圾桶）。
- `pnpm acceptance:regression`：146 個檔案、1,843 個測試、build、背景 128/128（P11 另外確認播放的就是待命的頁面）。
- 第一輪桌面實測，使用新的 `pnpm start:app` bundle：`pnpm acceptance` 通過（60 fps 錄 10.3 秒、所有完整性檢查、倒數取消案例）；log 顯示 `finalize 14 ms to plain MP4`，檔案為 ftyp、mdat、moov；`pnpm acceptance:playback` 在 QuickTime 通過；`pnpm acceptance:player` 4/4，取得上述基準計時。
- 第二輪桌面實測，使用重新建置的 bundle：`pnpm acceptance:player` 4/4，兩次進入都是 `warm page`；`pnpm measure:cpu`：A 0.052 %、30 fps 錄影 R 15.1 %（編碼器 2.1 %）、B 0.052 % 且錄影後程序角色正確，接著 C 的前置檢查失敗，因為它要求恰好一個 renderer；改成至少一個後，`pnpm measure:cpu -- --skip-recording --minutes 1` 通過：A 0.063 %、C 0.149 %，renderer ×2（上限 0.5 %）。

未驗證：這項變更之前存的錄影仍是分段格式；存檔瞬間當機只在複本上模擬，沒有在 App 裡實際造成；Windows（不會預先載入頁面）；主觀聽感。

## 統一焦點線、shadcn 前的紅色與素面狀態卡 — 2026-10-07

同日維護者的第三輪（[桌面設計](../system-design/desktop.md#設定視窗)）。證據：`measurements/2026-10-06T16-30-24Z-restore-look/iter6` 與回歸測試 `test-results/ui/` 中的焦點圖片。

- **紅色。** 恢復 shadcn 前的 `--chosen`（`3210ae2f` 的 `settings.css`）：淺色 #fa2d48，深色 #e85a62。
- **焦點。** 所有控制項統一：一條選中紅的細線（`--focus-width`）畫在控制項邊緣，沒有外暈；有底色的控制項畫在外側，播放器內為白色；只在鍵盤操作且視窗為作用中時顯示（`ui.css` 的 `focus-ring`、`focus-ring-within`、`focus-ring-field`）。錄影卡片改為圍繞整張卡片並順著圓角，不再是被裁切在卡片內的框。
- **狀態卡。** 任何狀態都是素面卡片，沒有底色、標題前也沒有圓點；修正按鈕橫跨卡片，第二個選項改為低調的連結。
- **失敗紀錄。** 圖示為灰色，顏色改由結果文字呈現（沒有保留為紅色，保留部分為琥珀色）。
- **捲軸。** 7 px。
- **Review。** Codex GPT-6.1 Sol 兩輪（約 3 分鐘）：[1] 紅色結果文字在深色 hover 底上只有 4.1:1（改用 `--outcome-red`，≥5:1）；[2] Base UI 的滑桿把手會阻止方向鍵事件傳遞，頁面因此以為最後是滑鼠操作而隱藏鍵盤焦點線（改以 capture 階段的監聽標記鍵盤輸入；Chromium 本身在滑鼠點過 range 後仍不把它視為 focus-visible，所以該情境與以往相同不顯示線）；[3] 卡片與把手的 `:has()` 外框在非作用中視窗仍顯示（現已排除）；[4] 新錄影卡片的高亮會讓同一張卡片的鍵盤焦點線淡出（高亮現在讓位給焦點）。全部接受並修正；[4] 沒有再經 review。樣式護欄對 `var(--outcome-red)` 的誤判也已修正並加上植入案例。

### 驗證

- 最終原始碼上的 `pnpm acceptance:regression`：131 個檔案 1,743 項測試、建置，背景套件 67/67，含 S110–S115（每個控制項的線：實線、1 或 1.5 px、選中紅、無外暈）、U070-3（卡片的線），以及檢視後重新產生的 matrix 基準。

未進行桌面回合：只涉及頁面內的顏色、焦點繪製與版面，視窗選項、左上角、全螢幕與原生輸入都未改動。未手動驗證：強制色彩、VoiceOver。

## Apple Music 配色、失敗紀錄卡片與選單 — 2026-10-07

同日維護者檢視恢復後的外觀後的第二輪（[桌面設計](../system-design/desktop.md#設定視窗)）。證據：`measurements/2026-10-06T16-30-24Z-restore-look/iter5`。

- **配色。** 只調顏色、更貼近 Apple Music（維護者從三個方向中選定）：純白內容區、#f5f5f7 側欄與 #e8e8ed 選中底塊、#1d1d1f 文字、無陰影的細框群組、Apple 的深灰，紅色 #fa2d48（深色 #fc3c44）。次要文字（#636368）與紅色文字（#cc0e2c，深色 #ff7a80）比 Apple 原值略調，以在凹槽與底塊上維持 4.5:1。
- **失敗紀錄。** 每天一張卡片（維護者從三種版面中選定）：每列有狀態圖示（保留部分為琥珀色，沒有保留為紅色，未確認加紅點），詳情在卡片內展開，說明放在提示框。
- **選單。** 依維護者選擇，設定的 NativeSelect 改為 shadcn Select。過程中發現並修正兩個缺陷：Base UI 會插入被 CSP 拒絕的 style 標籤（建置時移除，規則改放 `ui.css`）；頁面的 Escape 會在選單開啟時關掉整個視窗（現在交給選單處理）。觸發鈕的焦點框只在鍵盤操作時顯示，因此滑鼠選完後不再留下框（即維護者在原生選單上看到的殘留焦點框）。
- **閃爍。** 儲存一項設定時，其他控制項都被 disable 並變成 50% 透明（shadcn 會讓 disabled 控制項變淡）；現在保持不動且不變淡，與 shadcn 前的 `.saving-disabled` 相同。側欄選取改為瞬間切換，不再交叉淡入淡出。
- **邊緣。** 內容捲動後上緣也以模糊漸層融入視窗，與下緣相同；頁面標題下移 22 px。
- **Review。** Codex GPT-6.1 Sol 一輪（約 2 分鐘）：無 findings。

### 驗證

- 最終原始碼上的 `pnpm acceptance:regression`：131 個檔案 1,743 項測試、建置，背景套件 66/66，含 U070-2（選單焦點框、焦點回歸、Escape），以及檢視後重新產生的 matrix 基準。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4（`2026-10-06T18-03-24-982Z-player-acceptance`）；`pnpm acceptance:shortcut-native` 通過，其 fixture 改由新選單啟動擷取；`pnpm start:app` 之後 `pnpm acceptance:settings-shortcut -- --observe --quit` 第二次執行通過（`2026-10-06T18-04-46.651Z-settings-entry-fZI2C3`）。第一次因為在剛開啟的 bundle 寫入啟動記錄前就讀取 app log 而停止，並留下 app，重跑同一個已驗證 bundle 前已從其選單結束。沒有殘留程序。

未執行：錄影、CPU、通知與網站檢查。未手動驗證：VoiceOver 搭配新選單、強制色彩、減少動態效果。

## 恢復外觀與動態 — 2026-10-07

Plan 069 之後應維護者要求，在 069 的 token 分層上，恢復 React／shadcn 改寫（`3e0f58e3`）遺失的外觀與動態，以其上一版 `3210ae2f` 為對照（[桌面設計](../system-design/desktop.md#設定視窗)）。這次沒有另開計畫，本紀錄即為結案。本機證據：`measurements/2026-10-06T16-30-24Z-restore-look/`（gallery `iter1`…`iter4`）。

- **配色。** 舊值改以 shadcn token 表達：墨色 `--primary`、安靜的灰、`--card-border`／`--card-shadow`、`--chosen`（#fa2d48，深色 #e85a62）用於開啟的分頁、開啟的開關、數量、未讀失敗、卡片播放鈕與焦點框，另有 `--sidebar*`、`--selected` 與錄影、警告、成功狀態。紅色文字使用 `--chosen-text`（#dc1a38，深色 #f06b73），因為 #fa2d48 在白底只有 3.8:1，低於 plan 067 的 4.5:1。
- **版面。** 寬版側欄從視窗頂端到底部有自己的灰底，開啟的分頁以淺色底塊浮起、不畫線；在 macOS 上側欄承接視窗按鈕的角落，品牌位於按鈕下方，只有側欄頂端可拖曳視窗，內容從頂端開始。內容在視窗右緣捲動，捲軸較細。macOS 窄視窗在標題列顯示 App 名稱；窄分頁列保留紅線。分段控制恢復為凹槽中浮起的選項；卡片選單每項一行。
- **動態。** 擷取中的跳動條、失敗紀錄箭頭的旋轉、新錄影外框 2.4 秒淡出（原本因 `Clip` 只在 `animationend` 重設而永不消失）、卡片紅色播放鈕放大淡入、播放器把手與加粗的軌道只在滑鼠移上時出現、快轉提示的邊緣弧形與依序亮起的箭頭、音量數值與快轉提示淡出，以及新增的點擊畫面、Space 或 K 時的播放／暫停閃現。減少動態效果時閃現不動。
- **播放器細節。** 畫面與進度列為手指游標，畫面不畫焦點框，控制項 38 px、圖示 24 px（全螢幕 52／32），恢復舊的漸層與文字陰影。
- **Toast。** 每個 toast 的生命週期交給 Sonner：每次開啟一個 Sonner toast（`toastState.show`），「已復原」原地更新，關閉時滑出；它填滿 Sonner 的位置，保留角落的關閉鈕與陰影，並位於對話框之下。
- **Review。** Codex GPT-6.1 Sol 兩輪（約 4 分鐘）：[1] 上一個 toast 滑出時顯示的新 toast 被合併進去而消失；[2] unstyled toast 在寬視窗沒有寬度；[3] 離場中的 toast 換成新 toast 的文字。三項都接受並以回歸測試修正；[3] 的修正與之後的版面調整（內容從頂端開始、捲軸貼齊右緣）沒有再經 review。

### 驗證

- 最終原始碼上的 `pnpm acceptance:regression`：131 個檔案 1,743 項測試、建置，背景套件 65/65，含新增的 U070-1（側欄、開關、卡片選單、播放鈕）與 P20（游標、焦點、閃現），以及檢視後重新產生的 36 張 matrix 基準。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4（`2026-10-06T17-07-08-657Z-player-acceptance`）；`pnpm start:app` 與 `pnpm acceptance:settings-shortcut -- --observe --quit` 通過（`2026-10-06T17-08-25.491Z-settings-entry-Uc5wg0`）；Claude 判讀其 `settings-window.png`：視窗按鈕位於側欄頂端、品牌在其下方，內容從頂端開始，細捲軸貼齊右緣。沒有殘留程序。

未執行：錄影、CPU、通知與網站檢查（只涉及外觀與 renderer 行為）。未手動驗證：強制色彩、減少動態效果與 VoiceOver。

## Plan 069 結案 — 2026-10-06

Plan 069 依維護者要求，把 renderer 的樣式移到 shadcn 的三層，保留 067 定下的所有值，預期畫面完全不變（[分層](../system-design/desktop.md#設定視窗)）。改動前，`ui.css` 的每條功能規則都沒有 layer，因此會蓋過 primitive 的 utilities；移進 `@layer components` 後會輸給它們，所以凡是與 primitive 自身 utility 設定同一屬性的規則，都改成呼叫端的 utilities 或 primitive 的 variant。證據保存在本機的 `measurements/2026-10-06T15-31-12Z-shadcn-layers/`（`before`、`before-repeat`，以及 HEAD 上成對的 `run-a`／`run-a2` 與變更後的 `run-b`／`run-b2`）。

- **Token。** `light-dark()` 配對改為數值相同的 `:root` 與 `.dark` 區塊；`card-`、`popover-`、`secondary-`、`accent-foreground` 各有自己的變數；29 個寫死的顏色改為 `--indicator`、`--brand`、`--brand-foreground`、`--media`、`--media-foreground`、`--media-scrim`、`--media-veil`、`--media-hover` 與 `--toast-shadow`。全螢幕頁原本從未設定 `.dark`、依賴 `light-dark()`，現在以設定頁的 hook（`lib/color-scheme.ts`）設定它。
- **Primitive。** Button 的 `wrap` 與 `icon-xl`（全螢幕頁 52px 的控制項，經由 Player 的 `large`）、Card 的 `size="xs"`、Badge 與 Kbd 的尺寸及 Kbd 的 `inline`、Slider 的 `variant="media"` 與 `growOnHover`、Switch 與 Toggle 的強制色彩狀態，以及 NativeSelect 的省略號，取代了 `.section > [data-slot="card"]`、`.controls > [data-slot="button"]`、`.pc [data-slot="slider-*"]`、強制色彩下的 `[data-slot="switch*"]` 規則，以及 `.tab-badge`、`.toast-key` 與 `.pc-row button` 的覆寫。每個改過的檔案開頭都寫明與 shadcn 的差異。
- **Feature。** 頁面版面放在 `@layer components`；`wide`、`narrow`、`compact`、`darwin` variant 精確承接原本的 media query。非作用中視窗的焦點隱藏與失敗紀錄內的焦點外框維持 unlayered，旁邊寫明理由。
- **前後對照。** Gallery 每次執行並不完全相同（輸出資料夾路徑、檔名範例的時間、影片畫格、動畫與縮圖），因此以 HEAD worktree 與變更後的程式成對同時繪製。252 張中有 190 張至少有一組前後完全相同；其餘 62 張在遮掉同一份程式兩次執行間本來就不同的部分後，剩下的只有路徑中每輪不同的字母、播放器移動中的畫格與提示圈，以及一個 hover 轉場中的分頁圖示，而它在 HEAD 自己的兩次執行間也會變動。`measurements.json`（字級、對比、點擊區、overflow、截斷）在 252 張全部相同。
- **護欄。** `tests/style-guard.test.ts` 在 token 以外出現顏色（CSS 值、Tailwind 色票與任意顏色 utility、原始碼中的顏色字串；允許 shadcn 的 `bg-black/80` overlay 與 `bg-white` 滑桿把手），或樣式表出現 `[data-slot]` selector 時失敗，`countdown.css` 豁免。植入 `color: #ef4444`、`.section > [data-slot="card"]` 與 `text-white` 都會讓它失敗；還原後通過。
- **Review。** Codex GPT-6.1 Sol 一輪（約 2 分鐘），確認沒有視覺回歸；[1] 護欄放過 inline 的 `rgb(…)` 或具名顏色。已接受並以植入 inline 案例修正；該修正只改測試，沒有再經 review。

### 驗證

- 最終 App 原始碼上的 `pnpm acceptance:regression`：typecheck、131 個檔案 1,743 項測試、建置，背景套件 63/63，含 `settings-layout` U067-0…3，36 張 matrix 基準未變。Review 修正 [1] 只改測試，之後護欄 2/2 與 typecheck 通過。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4，沒有 console 錯誤，cleanup `groupGone`（`2026-10-06T16-04-16-461Z-player-acceptance`）；全螢幕截圖顯示畫面上的白色控制項與漸層。

未執行：錄影、matrix、CPU、通知與網站檢查（只改樣式），以及 `settings-shortcut --observe`（視窗選項與左上角繪製未變）。圖片未涵蓋：只在 hover 出現的狀態（進度列變粗、音量滑桿、卡片的播放遮罩）、強制色彩與非作用中視窗，這些依賴搬移後的規則與背景套件。

## Plan 067 結案 — 2026-10-06

Plan 067 依維護者要求盤點整個設定視窗（四個分頁、側欄、狀態卡、頁尾、說明、選單、改名、內嵌播放器、全螢幕、對話框與暫時回饋），修正截圖與量測確認的問題。多數問題來自同一個 token：`ui.css` 把根字級設為 13px，而 shadcn 元件以 rem 計算尺寸，因此每個控制項都以 9.75px 的文字畫在 22.75px 的框內，badge 只有 8px。根字級現在是 16px，`text-xs` 重新定義為 13px（[字級](../system-design/desktop.md#設定視窗)）。證據保存在本機的 `measurements/2026-10-06T14-22-44Z-settings-ui-audit/`（before、各次迭代、after、`compare.html`、`regression.log`）。

- **矩陣。** `pnpm preview:ui` 現在畫出 252 張圖，附 `shots.json` manifest 與 `measurements.json`（computed 字級與對比，含欄位值與 opacity；點擊區；overflow 與被截斷的文字）：兩種語言、兩種主題在預設、窄與最小尺寸下的 48 張分頁圖與各自捲到底的畫面、599/600/601 與 419/420/421 px 斷點、1440×900、125% 與 150%（App 最大 zoom）以及 200% reflow 探測，還有暫時狀態（說明、無效檔名、卡片選單、改名與被拒、空資料夾與無法讀取、鍵盤焦點、zoom 通知、toast、失敗紀錄、錄影中、權限、播放器、全螢幕）。依 manifest 配對 252 組，前 → 後：小於 12px 的文字 3,628 → 0，低於對比下限的文字 665 → 0，超出視窗的控制項 30 → 0，overflow 0 → 0，小於 24px 的控制項 2,812 → 200（全是開關與滑桿把手，gallery 未計入其 `::after` 點擊區，以及周圍留白的 toast 20px 關閉鈕）。前值使用 review 修正 [1]–[3] 之前的量測，未涵蓋欄位值與 opacity；後值使用修正後的量測。
- **問題清單。** 15 項確認問題全部修正，沒有延後。P1：L01 控制項、分頁、選單、對話框、toast 與狀態文字 9.75px，badge 8px；L02 控制項高 22.8px，ⓘ 16.3px；L03 失敗紀錄主標（9.75px）比次要文字（12px）小；L04 在 380×360 視窗 150% 時，分頁（原本就有）以及字變大後的長按鈕與分段控制超出視窗或被卡片裁掉。P2：L05 淺色 muted 文字 4.4:1（現為 `#68686f`，5.0:1）；L06 錄影中狀態 3.76:1（`--recording`）；L07 列自己的按鈕（開啟通知設定…）貼在圖示邊緣而非標籤欄；L08 檔名列標籤對著欄位與範例的中線、欄位靠在欄的左側；L09 無效檔名格式沒有標示（現為 `aria-invalid` 與錯誤色）；L10 窄視窗只顯示圖示的分頁 hover 時沒有名稱；L11 空資料夾狀態的長路徑在最小尺寸撐寬面板（迭代中發現）。P3：L12 區段卡片上下 padding（16 + 12px）與左右 14px 不一致；L13 metadata 11px；L14 改名欄位錯誤時未標 invalid；L15「技術細節」高 19.5px。接受的取捨：卡片 ⋯ 在 hover 或焦點時出現，選單也能以右鍵開啟；macOS 為視窗按鈕保留的 52px 在所有尺寸與 zoom 下維持；開關、滑桿把手與 toast 關閉鈕保持繪製尺寸，以擴大或留白的點擊區達標；最小尺寸兩欄網格中的長時間戳標題會換行；App zoom 上限 150%，200% 只是探測（可 reflow、沒有 overflow）。
- **各頁。** 錄影檔、錄影設定、一般、失敗紀錄、側欄與窄分頁、狀態卡、選單、改名、說明、toast、zoom 通知、內嵌播放器與全螢幕頁，改動前後都以原解析度逐張檢視；修正後沒有未解決的問題。另修正一個 fixture 缺陷：gallery 會點擊分頁已自動展開的未讀失敗，反而把它收起。
- **回歸斷言。** `tests/ui/settings-layout.spec.ts`：U067-0 以注入的探針檢查兩條量測（有背景又半透明的容器、小字欄位值）；U067-1 預設尺寸下兩種語言與主題的每個分頁沒有小於 12px 的文字、小於 24px 的控制項或低於對比下限的文字；U067-2 最小視窗 150% 時沒有東西超出視窗或卡片、沒有 overflow；U067-3 被拒的檔名格式會標示，Escape 還原。換回原本的 `ui.css` 會讓 U067-1 失敗。36 張 matrix 基準重新產生並逐張檢視；S016 改為在列的 `.row-actions` 中找通知按鈕。
- **Review。** Codex GPT-6.1 Sol 兩輪（約 3.5 分鐘）：第一輪 [1] 欄位與選單未量測、[2] 忽略 opacity；第二輪 [3] opacity 在第一個背景擁有者就停止累乘。三項都接受並在 gallery 量測與 spec 中修正；[3] 的修正沒有再經 review。未回報任何 App 回歸。

### 驗證

- 最終 App 原始碼上的 `pnpm acceptance:regression`：`pnpm check` 通過（typecheck、130 個檔案 1,741 項測試、建置）；背景套件 61 通過、1 失敗（S016 只讀列的直接子元素），修正測試後 S016 在同一份 `out/` 通過。review 修正 [1]–[3] 只改測試與腳本，之後 `settings-layout` 8/8 與最終 gallery（252 張，cleanup `groupGone`）都在同一份 `out/` 上執行。
- 維護者回覆準備好之後的桌面回合：`pnpm acceptance:player` 4/4（`2026-10-06T15-13-33-893Z-player-acceptance`）；`pnpm start:app` 建置並簽署 bundle；`pnpm acceptance:settings-shortcut -- --observe --quit` 所有檢查通過（含視窗按鈕角落），⌘Q 後沒有殘留程序（`2026-10-06T15-14-41.736Z-settings-entry-nWWT6G`）。Claude 判讀 `settings-window.png`：視窗按鈕沒有壓到品牌與分頁，新字級在 Retina 密度下清楚可讀。

未執行：錄影、matrix、CPU、通知與網站檢查（純外觀變更）。不宣稱：VoiceOver、既有覆寫以外的強制色彩、Windows 繪製，以及 App 無法到達的 200% zoom。

## Plan 066 結案 — 2026-10-06

Plan 066 依維護者要求，把例行的 renderer 與 Electron 整合驗收移出桌面：`pnpm acceptance:regression` 現在是 `pnpm check` 加上背景 Playwright 套件（`pnpm test:ui`），不顯示視窗、不搶焦點、不送 OS 輸入、不註冊全域快捷鍵、不播放聲音、不送出通知，也不擷取任何畫面（[背景 UI 套件](../system-design/tooling.md#背景-ui-套件)）。每個舊案例都有 ledger ID 與去向（[遷移帳本](playwright-migration-066.md)）：設定 fixture 的 516 個案例有 513 個移到背景、3 個保留為原生；快捷鍵 fixture 的 57 個與播放器的 19 個都已移動，以 OS 為主張的部分有原生對應；沒有移除任何案例。App 原始碼沒有變更（前後 `out/` digest 都是 `a2965ca06e8e`）。

- **Host 與邊界。** 三個 Electron host（正式 main、以真實 model 與 library 為底的 view host、正式倒數覆蓋層）在邊界後執行：每個視窗都以隱藏、離屏、靜音的方式建立，顯示、聚焦、最小化、還原與全螢幕由虛擬狀態回答；Tray、通知、快捷鍵、對話框、shell、Dock、擷取與電源是會記錄的 adapter。teardown 稽核邊界、在 macOS 取樣視窗伺服器、正常結束，並從程序表確認這次啟動擁有的每個程序都已結束。
- **過程中的發現。** 離屏視窗的原生 `isVisible()` 會隨頁面變成 true，因此以視窗伺服器作為圍堵檢查；Playwright 的 CDP 按鍵到不了 Electron 的 `before-input-event`，因此 main 攔截的按鍵改用 `sendInputEvent`；Playwright 預設模擬淺色主題，曾讓深色基準畫成淺色；`BrowserWindow.getAllWindows()` 依建構子名稱辨識視窗。
- **原生對應。** `pnpm acceptance:settings-native`、`pnpm acceptance:shortcut-native` 與縮減後的 `pnpm acceptance:player`，可用 `pnpm acceptance:recipe -- native-ui` 一起執行。測試片段已簽入（tests/ui/media），套件與播放器 runner 都不需要 FFmpeg。
- **Review。** Codex GPT-6.1 Sol 進行兩輪 review。第一輪 8 項（Playwright 預設 `updateSnapshots` 下 CI 的基準、未回報的監督錯誤、只拍一次的程序快照、以資料夾路徑收編程序、未防護的真實對話框／通知／啟用／Tray、取消靜音只在最後檢查、App 自行結束時違規遺失、缺少 Electron 被報為失敗）與第二輪 3 項（註冊配方缺原生 runner、原生 fixture 少了真實註冊恢復、blocked 時沒有摘要）都已修正；演練 D08–D10 涵蓋圍堵與所有權修正。

### 驗證

- 沿用、未重新量測的基準：同日配方 `settings` 在 182.26 秒中佔用桌面 127.95 秒（設定 fixture 88.59 秒、快捷鍵 fixture 39.36 秒；`2026-10-06T05-27-52-850Z-recipe-settings`，revision `bcf744af`）。
- 最終 `pnpm acceptance:recipe -- settings` 在 240.67 秒內通過，沒有桌面階段：typecheck、130 個測試檔與 1,741 項測試、建置，以及 210.25 秒的 `pnpm test:ui` 53/53（`2026-10-06T10-20-38-990Z-recipe-settings`）。圍堵：54 次啟動、265 次視窗伺服器取樣，沒有視窗上螢幕、沒有成為前景、沒有違規、沒有強制清理、沒有殘留程序、沒有監督錯誤。`pnpm test:ui:drills` 通過 13 項，演練目標依設計略過。
- 視覺基準：36 張 macOS 26 圖，逐一看過兩種主題、語言與尺寸後採用；移除一張基準時會加註記且不寫入，換錯一張時會失敗，都已實測。
- 桌面回合（維護者回覆準備好之後）：`acceptance:settings-native` 4/4（`2026-10-06T10-17-51-998Z-settings-native`）；`acceptance:shortcut-native` 的 windows 階段第一次失敗，原因是縮減後的 fixture 把舊格式的錄影快捷鍵留在 ⌥⌘,，callback 因而開始一次錄影嘗試，邊界提供的空螢幕清單讓它以 `no_display` 結束，沒有擷取任何畫面；改為寫入 fixture 自己的按鍵後 9/9 通過，收尾完成（`2026-10-06T10-18-38-132Z-shortcut-native`）。`acceptance:player` 4/4：全螢幕蓋住 1920 × 1080 的螢幕，F 與 Escape 之後焦點回到設定視窗（`2026-10-06T10-18-46-321Z-player-acceptance`）。觀察中的背景執行（播放器、倒數、快捷鍵整合，6/6）在 29 次取樣中前景始終是 Google Chrome，抽查的截圖也沒有出現 RecordStuff 視窗；截圖含有維護者的螢幕內容，事後已刪除。

- 鎖定的工作階段（結案後依維護者要求）：維護者於當地時間 18:35:51 至 18:37:27 鎖定螢幕（96 秒，每秒經 `CGSSessionScreenIsLocked` 讀取），期間的完整背景執行仍在 3.5 分鐘內通過 53/53，涵蓋元件、倒數、播放器與截圖矩陣測試；該次以 `--reporter=line` 啟動，因此沒有寫出逐次啟動的摘要，但每個測試的 teardown 仍執行圍堵檢查。

- 結案後在 `plan-066-background-playwright` 分支的 Windows CI：套件第一次在 Windows 執行就發現一個 App bug。設定頁 40 px 的視窗拖曳條（`.titlebar`）在 macOS 不會蓋到內容，在 Windows 卻蓋住頁面最上方 40 px，因此窄視窗的分頁點不到；這也是 plan 066 之前 Windows 上三個位置測試失敗的原因。依維護者決定，拖曳條現在只在 macOS 繪製（`src/renderer/ui.css`），S116 檢查兩種版面；改回舊樣式時它會失敗。同一次執行的其他 Windows 失敗屬測試本身：Windows 無法回溯的檔案建立時間、平台的設定快捷鍵與訊息，以及被縮到工作區內的隱藏全螢幕視窗；現在都依平台判定。macOS CI 也找出兩個對 runner 的假設並已修正：比 1024 × 768 螢幕更大的視窗尺寸，以及在過渡動畫中量測的焦點環。
- `ce685175` 的最終 CI（[run 37454636049](https://github.com/EricTsai83/recordstuff/actions/runs/37454636049)）兩個 job 都通過：Windows 上 1,643 項單元測試（98 項略過）、背景套件 55/55（4.7 分鐘）、演練 11 項（D07、D10 與演練目標依設計略過）與安裝檔閘門；macOS 上同樣的套件與演練。

未執行：沒有螢幕的機器。不宣稱：Windows job 通過不代表 Windows 原生視窗、Tray 或擷取有證據。不宣稱：Windows UI job 通過不代表 Windows 原生視窗、Tray 或擷取有證據。

## Plan 068 結案 — 2026-10-06

Plan 068 完成維護者在 2026-10-06 要求的模組邊界工作；同日稍早 `src/main/` 與 `src/renderer/` 已依模組分成資料夾（[模組邊界](../system-design/repository.md#模組邊界)）。維護者要求立即執行，而不是排在 066 與 067 之後。開始時的 working tree 同時含有尚未 commit 的 React／shadcn 遷移，因此單憑 HEAD `bcf744af` 無法辨識它的輸入。

- **Action handler。** `handleAction` 的 29 個 case 原封不動地從 `src/main/index.ts` 的 closure 移到 `src/main/actions/actions.ts`（`createActionHandler`），協作者由外部傳入。`index.ts` 只保留一行宣告提升的轉交函式，從 1,033 行降到 871 行。`actions/` 是位於 `menus/` 與 `index.ts` 之間的新區域：handler 需要設定 store、設定視窗與 tray，若在 `app/` 用結構型別表達，會複製約 40 個成員。沒有任何 runner 錨點移動，`controlled-acceptance.test.ts` 與 `update-acceptance.test.ts` 也確認了這點。新的測試固定了結束閘門、各偏好設定的鎖、錄影中搶先按下的更新連結與拖曳。
- **設定頁。** 約 1,800 行的 `settings-app.tsx` 逐行拆成外框，加上 `tabs/library.tsx`、`tabs/preferences.tsx`、`tabs/shortcut-editor.tsx`、`tabs/failures.tsx` 與 `undo-toast.tsx`。錄影與一般分頁共用同一個依 model 繪製的元件，所以分頁模組是三個而不是四個。`settings-controller.ts` 變成 `controller/`（core、shortcut、results、library、player、info、toast）之上的單一 `export *` 介面。跨職責的寫入改成擁有該狀態的模組提供的小函式（`dismissLibraryOverlays`、`forgetMissingItems`、`clearFeedback`、`forgetInfo`、`playerHidden`）。頁面測試是透過入口驅動整個頁面，因此留在入口旁邊。
- **開發者工具。** `scripts/lib/` 的 83 個檔案分成 `runner/`、`acceptance/`、`verification/`、`audio/` 與 `release/`；入口檔留在頂層。`lineTime` 移到 `runner/log-reader.mts`，`command` 移到 `runner/processes.mts`，因此 `runner/` 與 `verification/` 不再匯入 `acceptance/`。網站的匯入與 `website.yml` 的路徑過濾跟著改到 `release/`。`pnpm audio:quality` 報告的實作 hash 改以新路徑（`./lib/audio/…`）為 key，因此 2026-10-06 之前的報告無法依 key 對應。
- **邊界。** `tests/source-boundaries.test.ts` 現在也涵蓋 `scripts/`：`src/` 不匯入 `scripts/`，`scripts/lib/` 各分組只朝一個方向匯入且不匯入入口檔，fixture 只匯入 `src/`、`scripts/lib/` 與其他 fixture。在兩棵樹各放一個刻意違規的匯入時，測試都會失敗。
- **搬移造成的缺陷。** 路徑改寫也改到了 update 與受控 runner 注入 `index.ts` 副本的 import 文字（`../../scripts/fixtures/…`），把它當成 runner 自己的 import。沒有單元測試會建置被修改的副本，所以只有 `runtime-inputs.test.ts` 中類似的字串失敗。三處都在任何 runner 執行前改回，兩個 runner 之後也都建置出修改後的副本並通過。

### 驗證

- 修改前 `pnpm typecheck` 與 `pnpm test` 通過（127 個測試檔、1,734 個測試），同一份建置的兩次離屏 `pnpm preview:ui` 圖庫逐像素相同（60/60），可作為確定性的基準。
- 拆分設定頁後，圖庫與基準逐像素相同（60/60）。
- 最後一次修改後，`pnpm acceptance:recipe -- settings` 通過：typecheck、130 個測試檔與 1,741 個測試、build、`pnpm test:ui` 13/13、設定 516/516 與快捷鍵整合（`2026-10-06T05-27-52-850Z-recipe-settings`）。每個 script 入口都能以 esbuild 打包且沒有無法解析的匯入（27/27），`pnpm site:check` 通過（5 個頁面、65 個內部參照、15 個外部網址）。
- 桌面驗收（維護者回覆準備好之後）：`pnpm acceptance` 在新建的 `pnpm start:app` bundle 上以全域快捷鍵錄了 10.4 秒，所有完整性檢查通過，倒數取消案例也通過（`2026-10-06T05-36-51-803Z-hotkey-acceptance`）。`pnpm acceptance:tray` 15 個通過、1 個未執行：macOS 先送達選單的 Start、後送達佇列中的快捷鍵，所以 stale-start 案例沒有可判定的狀態變化。`pnpm acceptance:updates` 每個案例都通過，包括實際錄影；`pnpm acceptance:controlled -- selftest` 8/8 通過；兩者都建置了被修改的副本。每一輪結束後都沒有殘留 RecordStuff 程序。
- 播放器：`pnpm acceptance:player` 起初 16:9 舞台案例在四次中失敗三次、進度條拖曳案例失敗一次；以當天早上的備份建置的重整前 working tree，同一個舞台案例三次中也失敗一次。兩者出問題的都是 fixture 而不是 App：影片 metadata 一到就量舞台，正好在 dialog 100 ms 的放大動畫期間（寬 826–851 px）；拖曳的移動事件固定間隔 100 ms 送出，機器忙時有一次拖曳停在 8 秒中的 4 秒。fixture 現在等 dialog 的動畫結束才量，並在前一次移動確實帶動影片後才送下一次，記錄每一步落在哪裡。之後連續五次都是 19/19：兩次開啟每次都量到 860 px，每次拖曳的每一步都落地（2.8、4、5.2、6 秒），滑桿全程保持拖曳狀態。
- `settings-library.test.ts` 在八次完整執行中失敗一次，失敗點是選單打開後的焦點位置。同時執行三份測試套件時六次全部重現：共用的 `menu` helper 在 Base UI 把選單標為打開時就返回，比 Base UI 把焦點移進選單早一幀。helper 現在也等選單取得焦點，這也消除了另一個在打開選單後立刻按 Escape 的測試中的同類競態；同樣的加壓下不再有任何斷言失敗。加壓時仍有部分頁面測試超過 5 秒時限；它們單獨執行只要 2.0–2.4 秒，因此沒有調高時限。

未執行：`check.yml` 的 Windows job，需要 push 或手動觸發；這次沒有修改打包。

## Plan 064 結案 — 2026-10-03

Plan 064 讓同一個 tag 在 macOS DMG 旁一起發布 Windows x64 安裝檔。2026-10-03 維護者先確認沒有 Windows 機器，接著決定仍然發布，Windows 只由 GitHub Actions 檢查，流程與 Mac 相同（[設計決策](../system-design/decisions.md)）。耐久規則見[發布自動化](../system-design/releases.md#發布契約)、[交付](../system-design/delivery.md)、[簽章](../system-design/signing.md)、[桌面設計](../system-design/desktop.md#錄影快捷鍵)與[工具](../system-design/tooling.md)。[1.2.0](releases/1.2.0.md) 是第一個雙平台正式版，之前先以 [1.2.0-rc.1](releases/1.2.0-rc.1.md) 演練。

- **決定。** 每位使用者的一鍵 NSIS（不需管理員權限、開始選單捷徑帶 AppUserModelID `com.ericts.record`、解除安裝保留使用者資料），只有 x64，不簽章，以 SHA256SUMS、`release-win32-x64.json` 與 build-provenance attestation 承擔完整性；Windows 失敗時整個 tag 失敗。除了 Electron 44 的 Windows 10 以外，不設 Windows 最低版本。
- **建置與 CI。** `electron-builder.yml` 新增 `win`／`nsis` 與 `build/icon.ico`；`pnpm dist:win` 建置安裝檔；`.gitattributes` 與依平台處理的測試讓 `pnpm check` 在 Windows 上通過；`check.yml` 新增 `windows-2025` 上的 `check-windows`（`pnpm check`、`pnpm dist:win`、`release.mts windows-smoke`）。
- **App。** Windows 上的更新檢查讀 GitHub latest release，並要求有 Windows 資產；`feedVersion` 與 `githubVersion` 接受的內容與已安裝的 macOS App 完全相同。Windows 文案改稱系統匣、電腦進入睡眠、預設播放裝置與 Ctrl；保留快捷鍵依平台而定，補上 Windows 編輯器的 `Control+Q` 能通過只列 Command 清單的缺口。macOS 文案不變。
- **發布工具與 workflow。** 1.1.1 之後的版本帶五個資產（DMG、安裝檔、SHA256SUMS 與兩份紀錄）；`build-windows` 與 `verify-published-windows` 在發布前後檢查安裝檔（每位使用者安裝、一筆 HKCU 登記、版本、x64、`NotSigned`、系統匣 ICO、捷徑、`app.asar` hash、乾淨解除安裝）。workflow 名為「Release」，屬於 `recordstuff-delivery` group。
- **網站與指南。** 下載頁、Help、Support、`resources/INSTALL.md`、兩份 README 與 release notes 都涵蓋 Windows、其 SmartScreen 步驟與只有 CI 的證據。

### 驗證

- CI：Check run 37040450544 在 `windows-2025` 上通過 `pnpm check`、`pnpm dist:win` 與 `windows-smoke` 閘門；run 37115590280（`5fae167`）、37118120707（`0fa2a0a`）與 37122157756（`c19d5eb`，即 1.2.0 原始碼）兩個 job 都通過。
- 預發布：[run 37045588224](https://github.com/EricTsai83/recordstuff/actions/runs/37045588224) 為兩個平台建置、公開並重驗 `v1.2.0-rc.1`；其紀錄讓 package.json 維持 1.1.1，穩定版 manifest 與 README 都未變動。
- 正式版：[run 37122799887](https://github.com/EricTsai83/recordstuff/actions/runs/37122799887) 建置並以 latest 公開 `v1.2.0`，通過 `verify-published` 與 `verify-published-windows`，紀錄寫回 main 並部署網站；網站的 `/release.json` 提供 1.2.0，下載頁同時連結 DMG 與安裝檔。
- 每次打 tag 前的 macOS：`pnpm acceptance` 與 `pnpm acceptance:playback` 在乾淨且已推送的原始碼上通過（[1.2.0-rc.1](releases/1.2.0-rc.1.md#打-tag-前的本機驗收)、[1.2.0](releases/1.2.0.md#打-tag-前的本機驗收)）。
- 已安裝的 macOS App：1.0.0 與 1.1.1 的更新解析器把線上 feed 與 GitHub release 讀為 1.2.0，已安裝的 1.0.0 記錄 `updates: available; remote 1.2.0`（[紀錄](releases/1.2.0.md#發布後已安裝-app-的更新檢查)）。設定仍是 version 3，歷史格式不變，因此 1.2.0 不需要資料 migration；1.2.0 原始碼讀取真實設定與九筆歷史紀錄時沒有任何警告。

未驗證：Windows 實機上的一切。step 3 的案例（SmartScreen、AppUserModelID、首次執行提示、系統匣 ICO 與點擊、含畫面與系統音訊的錄影、`MediaRecorder` MP4、`restrictOwnAudio`、通知與檔案總管顯示、設定、單一執行個體、睡眠、結束、保留資料重新安裝）都在每份發布紀錄中列為未測試，035 的 N17 系統匣矩陣在有 Windows 機器前仍未結案。未觀察已安裝 App 在「設定 → 一般」中的更新結果，也沒有執行已安裝的 1.1.1。在 1.2.0 之後執行比 1.1.0 更舊的 App，會刪掉它不認得的 `countdown` 與 `countdownSound` 設定並重設為預設值；1.1.0 與 1.1.1 會保留它們（只影響降版）。

依決定豁免：Windows 實機回合（step 3）、從公開網址在實機安裝（step 8）與 Windows 驗收 runner（step 9）。

## Plan 065 結案 — 2026-10-03

Plan 065 讓錄影快捷鍵與狀態列項目的左鍵點擊，可以在 start 持續一秒後取消它，和選單的「取消錄影」一樣。由 Claude 實作，Codex GPT-6.1 Sol review。在此之前，`Recorder.toggle()` 在 starting 期間忽略所有按鍵：因擷取請求未回應而等待 120 秒的 start 只能從選單取消，按鍵也不留 log；這段期間退出則要等擷取請求結束（曾經長達 286 秒）。耐久規則見[錄影設計](../system-design/recording.md#倒數)、[桌面設計](../system-design/desktop.md#錄影快捷鍵)、[驗收](../acceptance.md#依影響追加案例)與[工具](../system-design/tooling.md#tray-驗收)。

- **量測與決定。** 2026-09-12 至 2026-10-02 保留的 log 有 739 次 start：中位數 289 ms，第 95 百分位 396 ms。超過 1 秒的九次全部卡在準備階段（權限被拒、缺少音訊軌與舊的 8 秒時限造成 1.1–9.4 秒；擷取請求未回應時四次各 120 秒，其中一次讓退出等了 286 秒），沒有卡在開啟資料夾的，另有一次（2026-09-13）卡在 `record` 之後。917 次快捷鍵按壓中，一秒內的人工連按間隔為 290、365 與 393 ms；約 600 ms 的配對是 runner 在取消倒數；落在 starting 期間的按鍵只有 plan 063 的 runner，在 start 後 4–8 ms。維護者於 2026-10-03 決定：(a) 寬限一秒；(b) starting 的「取消錄影」標出快捷鍵；(c) 開啟資料夾或準備期間退出立即取消，納入本計畫。計畫中的長時間 start 受控重現改由下方的原生回合承擔，因為 log 已能把每次長時間 start 歸到所在階段。
- **Recorder。** starting 期間，從 session 請求起以 monotonic clock 計算，toggle 若晚於 `START_CANCEL_GRACE_MS`（1000 ms），就走「取消錄影」的路徑：開啟或準備中的嘗試會被取消，不留檔案、失敗項目或通知；已送出 `record` 時則變成「開始後停止」。寬限內的按鍵與 stopping 期間的按鍵都會被忽略並寫入 log。`shutdown()` 在延後的檢查中取消仍在開啟或準備的嘗試，因此同步的狀態變化不會再開啟第二次退出嘗試，標記仍保留作為後援；睡眠仍只標記。
- **Tray。** starting 選單的「取消錄影」帶已註冊的快捷鍵作為 accelerator，提示文字也標出它，中英文皆同，與倒數時一致。
- **工具。** 受控 build 新增 `prepare=hold` 故障與 `release prepare`，在 main 暫停 capture host 的 `prepared` 回覆。`pnpm acceptance:tray -- --long-start <run>` 操作該 build 真正的快捷鍵、狀態列項目與「結束」；命令通道 client 移到 `scripts/lib/acceptance/controlled-client.mts`。

### 驗證

環境：M1 Pro、macOS 26.6.2、Electron 44.3.0，主螢幕 BenQ GW2785TC 1920 × 1080，另有直立的 1080 × 1920 螢幕；HEAD `1657fdc` 加上未提交變更；桌面交接由維護者回覆「好了」確認。

- `pnpm check`：typecheck、99 個檔案的 1479 個測試與 build 通過。新增測試：start 後 8 與 999 ms 的按鍵被忽略並寫入 log；寬限後的按鍵在準備期間取消（保留「顯示上一段錄影」、沒有失敗、存檔或通知事件，遲到的 `prepared` 以過期 session 停止）與開啟期間取消（沒有擷取請求、沒有檔案）；倒數設為「關」時，`record` 後的按鍵變成「開始後停止」並存檔；stopping 期間被忽略的按鍵寫入 log；準備期間退出立即完成，而不是等 120 秒期限；開啟期間退出會等它持有的資料夾檢查；延後檢查前到達的 `prepared` 仍會取消；starting 選單的 accelerator 與提示文字（雙語，以及沒有註冊快捷鍵時）；以真正的 Recorder 測 `prepare=hold`；starting 選單規則；instrumentation anchor 與參數。
- 在新的 `pnpm start:app` bundle 上做錄影 smoke：`pnpm acceptance` 以 ⌘⇧1 開始與停止，存下 10.3 秒、1920 × 1080 的檔案並通過媒體驗證，數字未出現在錄影中，倒數取消案例通過；`pnpm acceptance:playback` 在 QuickTime 通過（未判定聽感）。
- 以 `pnpm open:app` 重新開啟同一 bundle，`pnpm acceptance:tray` 先 zh-TW 後 en：15 通過、1 not run（狀態改變後才選的「開始錄製」，與 063 相同）。該案例中快捷鍵在選單「開始錄製」後 4 ms 到達，現在會記錄 `toggle ignored while starting (4 ms after the start)`：也就是 plan 063 的案例，在原生環境中於寬限內被忽略。
- 對受控 build（`pnpm acceptance:controlled -- launch`）執行 `pnpm acceptance:tray -- --long-start`：14 秒內 3 個案例通過。相隔 0.2 秒的兩次按鍵中，第二次在 start 後 213 ms 被忽略；start 後約 2 秒的按鍵記錄 `cancelled (toggle) while preparing capture`；starting 選單與 model 那一行一致，「取消錄影」帶 ⇧⌘1，寬限後的左鍵點擊取消了 start；在 start 被暫停時選「結束 RecordStuff」記錄 `cancelled (quit) while preparing capture`，App 在 0.9 秒後結束。每個放行的回覆都以過期 session 停止；沒有出現檔案、通知或歷史項目。agent 自行檢視 starting 選單截圖，看到「Cancel recording」右側對齊 ⇧⌘1（Computer Use 式的觀察，不是腳本結果）。

未驗證：真實擷取請求未回應造成的長時間 start，任何 build 都無法隨時產生（暫停發生在 main，因此屬於受控狀態證據）；繁體中文的長時間 start 案例（文字由單元測試涵蓋）；淺色與深色選單列；寬限內以左鍵點擊而非快捷鍵按下（兩者呼叫同一個 `toggle`，由單元測試涵蓋）。

Review：Codex GPT-6.1 Sol pass 1（約 261 秒）沒有發現 Recorder regression，回報三項 runner finding，全部接受並修正：收尾在取消 start 之前就放行被暫停的 `prepared`，倒數設為「關」時會因此錄影（收尾現在先用「取消錄影」取消）；退出計時在 `select()` 之後才開始，而 `select()` 可能等到 App 結束才返回；點擊案例的寬限邊際從點擊尋找目標之前起算，而不是從 log 記錄的 start 起算。Pass 2（約 135 秒）沒有 findings，並確認三項修正正確。修正後的收尾路徑沒有在原生環境執行，因為沒有案例失敗。

收尾：每一輪後 RecordStuff 的所有程序都已結束，儲存的語言已改回繁體中文，受控 workspace 已移除並保留證據，`caffeinate` 讓螢幕保持喚醒。測試錄影（smoke 回合的 2026-10-03 00-31-16，tray 回合的 00-32-14 與 00-32-49）已依維護者要求刪除。依維護者要求 commit 到 main；沒有 push 或發布。

## Plan 063 結案 — 2026-10-02

Plan 063 讓原生 Tray、設定入口與通知文字案例可以用腳本完成，並寫明何時用 runner、何時用 Computer Use。由 Claude 實作，Codex GPT-6.1 Sol review。在此之前，驗收 skill 要求所有原生操作都透過 Computer Use，但它無法存取純 tray 的程序（`-10005 timeoutReached`），因此 Tray 案例只能等維護者或記為受阻，也沒有文件說明何時該改用腳本。耐久規則見[選擇規則](../testing.md#腳本-runner-或-computer-use)、[runner 對照](../acceptance.md#腳本-runner-或-computer-use)、[腳本化原生驗收](../system-design/tooling.md#腳本化原生驗收)與[設計決策](../system-design/decisions.md)。

- **選擇規則與決定。** 測試指南與驗收案例現在寫明：有已提交的 runner 涵蓋就用 runner，觀察與沒有 runner 的操作用 Computer Use，主觀判斷與需要密碼的步驟交給維護者，並把腳本輸入、Computer Use 觀察與人工證據分開標示。維護者於 2026-10-02 允許已提交的 runner 在記錄的限制內操作 RecordStuff 自己的 Tray 選單、設定視窗與選單項目（以路徑與 pid 比對受測 bundle；狀態列項目用右鍵而非 `AXPress`；不碰權限提示、TCC 或隱私權清單；不用全域 kill 或測試 hook）。
- **App 變更。** Tray 每次彈出選單時，都會記錄 `tray: menu opened in <state>: <json>`，內容就是交給 Electron 的選單，讓 runner 能把讀到的 NSMenu 和正式 model 比對。App 其他部分沒有改；`DEFERRAL_MESSAGE` 改為 export，讓測試把通知 runner 預期的文字綁定到它。
- **Runner。** 一個 JavaScript for Automation helper 透過 C API 讀取輔助使用，約 0.1 秒（同一個選單用 System Events 要 29 秒），並送出 CoreGraphics 事件。`pnpm acceptance:tray` 操作真正的狀態列項目；`pnpm acceptance:settings-shortcut -- --observe` 斷言設定視窗的啟用、焦點、Tab、最小化、還原、關閉與重開；`pnpm acceptance:quit-dialog` 新增從通知中心讀取的橫幅文字層。驗收 skill 現在先選定並執行這些 runner，Computer Use 留給截圖的視覺判讀與沒有 runner 的操作。結案時，維護者決定讓它不限定執行者，並把名稱從 `astra-acceptance-with-computer-use` 改為 [`native-acceptance`](../../../.agents/skills/native-acceptance/SKILL.md)：任何能執行指令並看得到截圖的 agent（例如這次的 Claude）都能執行 runner，並自己判讀 `screencapture` 截圖；只有需要即時 Computer Use 操作時才委派 Codex GPT-6 Astra。
- **在真實桌面上發現的問題。** macOS 26 的狀態列項目位於控制中心的視窗中。`REC` 讓項目變寬後，1080 pt 直式螢幕上的那一份被前景 App 的選單擠掉（視窗不在畫面上），AX 卻仍回報它的 frame，因此第一輪的錄影選單始終沒有打開，錄影進行了約三分鐘，才以快捷鍵停止並存檔。現在 driver 在回報的那一份被隱藏時，改點主選單列上以 bundle identifier 命名、正在顯示的視窗。改把點擊直接送給程序（以 `CGEventPostToPid` 送給 RecordStuff 或控制中心，四種變化）時游標不動，但選單一次都沒有打開，所以點擊會移動真正的游標，每輪都需要桌面交接。第二輪找出三個 runner bug，在通過的那一輪之前已修正：巢狀的選單案例把它正在讀的倒數收尾掉了；結束後還在等一個已經讀不到的選單；繁體中文的未讀失敗只比對前綴。彈出選單的鍵盤導覽在 CoreGraphics 輸入下可用，和 048 當時的嘗試不同。

### 驗證

環境：M1 Pro、macOS 26.6.2、Electron 44.3.0，主螢幕 BenQ GW2785TC 1920 × 1080，旁邊一台 1080 × 1920 直式螢幕；來源為 HEAD `4ff3eb1` 加未提交的變更，使用全新簽章的 `pnpm start:app` bundle，以 `pnpm open:app` 重開；儲存的語言為繁體中文，倒數 3 秒，維護者的歷史中有四筆未讀失敗。

- `pnpm check`：typecheck、99 個檔案共 1471 項測試與 build 通過。新的單元測試涵蓋：以 2026-10-02 錄下的選單做比對、快捷鍵對應、各狀態規則、項目被擠掉時的點擊目標、driver 有上限且可取消的等待、Tray 判定與橫幅文字判定。
- `pnpm acceptance:tray`，先 zh-TW 再 en：15 項通過、1 項 not run，共 68 秒。兩種語言的 idle、倒數與錄影選單都與 model 一致；從選單開始與停止都已存檔；「顯示上一段錄影」讓 Finder 置前並選取該檔；第二次點擊與「取消錄影」取消後沒有檔案、失敗紀錄或通知；倒數中選「結束」會退出且沒有檔案；以 Down 加 Return 開啟「設定…」、⌘W 關閉；最後的「結束 RecordStuff」讓所有程序都退出。未讀失敗群組有顯示，涵蓋 N33a 的「有未讀失敗的 idle」狀態。第二種語言期間把儲存的語言設為英文，結束後已還原。App 沒有執行時會拒絕（exit 1）；錄影中送 SIGINT 時，錄影已存檔、App 已結束，結束碼 130。
- 套用 review pass 2 的修正後（見下方），使用同一個 bundle：App 沒有執行時拒絕且不碰任何東西；雙語回合第一次在錄影中漏掉一次右鍵，所以 driver 現在會重點沒有打開任何東西的點擊（最多三次，選單開著時絕不重點），重跑後 14 項通過、2 項 not run（stale-start；以及 keyboard，因為開始時有一個無法辨識名稱的 RecordStuff 視窗，現在改為只在設定視窗開啟時跳過）；在 en 錄影中中斷時，runner 存好錄影、結束 App、還原繁體中文，結束碼 130，該輪的 keyboard 案例也通過；`--observe` 與 `quit-dialog -- --language en` 再次通過。
- `pnpm acceptance:settings-shortcut -- --observe`：六項輔助使用檢查通過；設定已開啟時在送鍵前拒絕（exit 1）。
- `pnpm acceptance:quit-dialog` zh-TW 與 en：每一層都通過，包括橫幅文字。
- agent 以自己的截圖獨立觀察：zh-TW 錄影選單與 en 倒數選單呈現的群組、靠右的 ⇧⌘1 與 ⌥⌘,、灰色的儲存位置項目，與 runner 的判定一致；設定視窗在前景且為作用中；一則未截斷的 zh-TW 延後退出橫幅與輔助使用讀到的 body 相同。

未驗證：needsPermission 選單，需要撤銷權限（屬 TCC 修改）；狀態改變後才選的「開始錄製」回報 not run，因為 macOS 比排隊的快捷鍵早 8 ms 處理了選單的 Start，沒有東西被忽略（由單元測試與 035 的維護者回合涵蓋）；淺色與深色選單列只判讀了目前外觀的截圖；Retina 螢幕、其他機器與 CI；以及回合中有人操作的干擾，目前沒有偵測。在選單 Start 之後 8 ms、狀態為 `starting` 時送出的快捷鍵沒有作用；本輪沒有判斷這是否為預期行為。

Review：Codex GPT-6.1 Sol pass 1（步驟 1，約 76 秒）沒有 findings。Pass 2（步驟 2–7，約 9 分鐘）回傳六項 findings，全部接受並修正：語言還原使用了已中止的 signal；收尾會操作被拒絕的回合從未接管的 App；可能在另一個 App 位於前景時送出 ⌘W 與 ⌘M；中斷的「顯示上一段錄影」開啟的 Finder 視窗沒有被關閉；沒有 identifier 的橫幅被計數；缺少輔助使用權限時記為失敗而非受阻。這些修正與之後加入的重點點擊都沒有再經過 review pass。

收尾：所有 RecordStuff 與 fixture 程序都已退出，儲存的語言已回到繁體中文，沒有留下本輪的 Finder 視窗，`caffeinate` 讓螢幕保持喚醒。保留在 ~/Movies/RecordStuff 的錄影：23:08:36（約三分鐘，來自失敗的那一輪）、23:11:44（診斷）、23:14:50、23:17:42、23:18:18、23:19:10、23:34:22、23:35:27、23:36:39、23:37:14、23:38:19 與 23:38:54。沒有 commit、push 或發布。

## Plan 062 結案 — 2026-10-02

Plan 062 修好了隔離的延後退出通知檢查：過去即使 macOS 拒絕通知，它仍可能通過。由 Claude 實作，Codex GPT-6.1 Sol review。只改了開發工具與文件，App 沒有變更。長期規則見[引導式延期退出通知驗收](../system-design/tooling.md#引導式延期退出通知驗收)、[證據界線](../testing.md#證據界線與停止條件)的通知條目與[準備一輪驗收](../acceptance.md#準備一輪驗收)。

- **根本原因。** `pnpm acceptance:quit-dialog` 直接啟動 `node_modules` 裡的 Electron，它只有 linker／ad-hoc 簽章（`Identifier=Electron`、`Sealed Resources=none`）。macOS 以 `UNErrorDomain` error 1 拒絕通知，而 runner 只判斷生命週期、timer 與清理，所以九月的回合在沒有橫幅的情況下通過（[plan 055](history-2026-09.md#plan-055-結案--2026-09-29)）。2026-10-01 的 A/B/A 比對沿用同一個複製路徑、bundle identifier `com.github.Electron` 與 fixture，只改簽章：原簽章被拒、完整 RecordStuff Dev 簽章兩種語言都送達、還原後又被拒。這證明完整簽章是條件，但沒有分別拆開憑證、Info.plist 與資源封存。沒有變更任何通知設定、信任、TCC 或 entitlement。九月那些 blocked 結果維持原紀錄。
- **修復。** `node scripts/start-app.mjs --fixture-app` 把本 checkout 的 Electron.app 複製到每輪的暫存目錄，用 `pnpm start:app` 選取的 identity 簽署，再以同一個 `verifyBundle` 驗證。`verifyBundle` 改為可指定 identifier 與 hardened runtime，並明確拒絕 ad-hoc 簽章。一般模式保留原本的預設值、測試、階段計時與建置紀錄。runner 以 60 秒上限監督這段 setup，只啟動驗證過的副本。fixture 把通知事件附加到 `notification.jsonl`。[quit-dialog-acceptance.mts](../../../scripts/lib/acceptance/quit-dialog-acceptance.mts) 分開判斷五層：簽章 App、生命週期、送達事件、視覺與清理。exit 0 是自動化證據，視覺層維持待補。

### 驗證

- **自動化。** review 修正前 `pnpm check` 通過（97 個檔案、1448 項測試）；修正後 `pnpm typecheck` 與相關測試通過（`start-app.test.ts` 49 項、`quit-dialog-acceptance.test.ts` 34 項）。測試涵蓋：identity 缺少、重複、過期、無法存取，以及金鑰需要有人操作（blocked，不複製也不簽章）；簽章失敗、ad-hoc、bundle 損壞、外層或 helper 憑證錯誤、identifier 與 designated requirement 錯誤（fail，不寫報告）；送達的 shown、太晚、缺少、拒絕與其他錯誤；依階段區分的 setup 逾時、生命週期與清理失敗、鎖定，以及失敗優先。`git diff --check` 通過。
- **不啟動的演練。** 不存在的 `RECORDSTUFF_SIGN_IDENTITY` 以 blocked（exit 2）結束，沒有啟動。在複製時、以及再一次在簽章時送出 SIGINT，都以失敗（exit 1）結束，沒有啟動。每次都沒有留下暫存副本、簽章 scratch 或程序。
- **桌面回合。** 維護者在開始前回覆「好了」；環境為 commit `41ae66d` 加上本次未提交的變更。`pnpm start:app` 建置、簽署並驗證 9 個 bundle identity（`identifier "com.ericts.record"`，RecordStuff Dev `01B37351…D637`），從 `dist/mac-arm64` 開啟後正常退出，所有 bundle 程序都已結束。`pnpm acceptance:quit-dialog -- --language zh-TW`（`2026-10-02T14-13-29-958Z-quit-dialog-zh-TW`）與之後的 `-- --language en`（`2026-10-02T14-14-00-328Z-quit-dialog-en`）都以 exit 0 結束。setup 約 1 秒（9 個 bundle；designated requirement `identifier "com.github.Electron" and certificate leaf = H"01b37351…d637"`）。`shown` 事件在請求後 9 ms 到達，timer 最多延遲 2 ms，精確 bytes 已儲存，副本與程序都已清除。
- **視覺。** Claude 在每次請求後 0.8 秒與 2.3 秒以 `screencapture` 被動截圖，沒有點擊，也沒有改變焦點。繁中：一則 RecordStuff 橫幅，可讀且文字完整。英文：一則可讀的英文橫幅，但 macOS 把正文截在第四行（“…retry the same action: Quit…”）。完整文字沒有看到，因為要在通知中心展開需要原生 UI 操作，本次 session 沒有這項能力；此項維持 **blocked**。橫幅使用 Electron 圖示，這是 fixture 的預期。
- **review 修正之後。** 上述回合都在修正之前執行。修正只改了 setup 的 `TMPDIR` 與讀取殘缺證據的方式：以私有 `TMPDIR` 直接執行 `--fixture-app`，簽署並驗證了副本，私有暫存目錄最後是空的；兩個演練也重跑了。維護者再次回覆準備就緒後，以已提交的修正 `6b075ca` 重跑兩種語言，不截圖（`2026-10-02T14-23-56-283Z-quit-dialog-zh-TW`、`2026-10-02T14-24-13-584Z-quit-dialog-en`）：都以 exit 0 結束，`shown` 分別在請求後 11 與 9 ms 到達，timer 最多延遲 2 ms，副本與程序都已清除。

Review：Codex GPT-6.1 Sol（medium reasoning、read-only）。Pass 1（234 秒）提出兩項，都接受並修正：

- 殘缺的 `signature.json`、timing 或 result 會在清理與寫報告之前拋出例外。
- `verifyBundle` 的憑證 scratch 不在本輪目錄內，setup 被中止時可能留下，而清理仍判定通過。

Pass 2（約 105 秒）審查修正後的 diff，沒有 findings。

清理：沒有殘留 RecordStuff、Electron fixture 或簽章程序，也沒有留下暫存副本或 scratch。報告與 agent 視覺紀錄保留在 `docs/verification/measurements/`；截圖含有無關的桌面內容，已依維護者要求刪除。本次工作期間執行了 `caffeinate -d -i -t 5400`。

## Plan 061 結案 — 2026-10-02

Plan 061 量測 `pnpm check` 之後的驗收工作，並移除其中發現的重複執行。由 Claude 實作，Codex GPT-6.1 Sol review。只改了開發工具與文件，App 本身沒有改動。長期規則見[選定一次並對每個版本驗證一次](../testing.md#選定一次並對每個版本驗證一次)與[驗證配方與計時](../system-design/tooling.md#驗證配方與計時)。

- **計時。** [verification-timing.mts](../../../scripts/lib/runner/verification-timing.mts) 讓每個 leaf 指令在自己的程序群組執行，每個階段記錄 monotonic 耗時、結果、exit code 與清理狀態。`pnpm start:app` 透過 `RECORDSTUFF_TIMING_FILE` 回報自己的 preflight、build、package、verify 與 open，這些時間顯示在所屬階段內，不重複計入。報告也記錄 revision、未提交內容的摘要、runtime 輸入、`out/` 與 `app.asar` 的摘要，以及工具版本。Agent 協作空檔與桌面交接等待記為 unknown。
- **配方。** `pnpm acceptance:recipe -- <check|settings|shortcut-registration|recording>` 跑的 leaf 檢查與它取代的組合指令相同，相同輸入只建置一次。單元測試確保每個配方與它取代的 package scripts 相同。
- **沿用 bundle。** `pnpm start:app` 在 bundle 旁記錄其 runtime 輸入；輸入改變時 `pnpm open:app` 會拒絕開啟。因此只改測試、腳本或文件之後的下一輪，可以重開已驗證的 bundle，不必重新建置。
- **量測中發現並修正的 runner 問題。** 第一次跑配方時，`pnpm acceptance` 在 `open` 返回後 0 秒就開始，結果拿前一個 App 的 log session（run `…-49210`）去判斷新的 pid 71654，送出開始鍵後以「the app restarted」中止。只有在 `start:app` 之後立刻開始的回合會遇到。Runner 現在最多等 30 秒，直到 log 最新 session 的 run id 以執行中的 pid 結尾、且該 session 已 idle。`sessionBelongsTo` 有單元測試。
- **指示稽核。** AGENTS.md 與測試規則原本就禁止重跑組合指令裡的 `check`，實作 skill 也只重跑受影響的檢查，沒有 skill 要求無條件全部重跑。測試規則現在明文規定任務內的驗證配方與證據作廢規則，AGENTS.md 引用它們；驗收 skill 允許在改動不會影響 bundle 時使用 `pnpm open:app`。

### `pnpm check` 之後的成本拆解

M1 Pro、macOS 26.6.2、Node 24.21.0、pnpm 10.33.4、Electron 44.3.0，版本為 `e1949be` 加上未提交的變更。每條路徑跑一次；這些是單次觀察，不是預算。

| 路徑 | 階段 | Wall time |
| --- | --- | --- |
| 純邏輯（`check` 參考） | typecheck／測試／建置 | 0.71–0.84 s／18.70–21.01 s／0.77–0.89 s；四次皆通過，wall 20.36–22.64 s |
| 設定修改（check 之後） | 設定 fixture，176/176 | 55.29 s |
| | 快捷鍵整合，三個 phase | 37.89 s |
| 註冊方式或 Electron 修改 | 鍵盤配置（注音），已還原為 ABC | 6.17 s |
| 建置／打包／簽章 | `pnpm start:app`：preflight／build／package／verify／open | 0.07／0.77／36.34／0.30／0.15 s（階段 37.70 s）；前一次 40.58 s，package 39.12 s |
| | 同一個 bundle 的 `pnpm open:app`：preflight／freshness／verify／open | 0.07／0.01／0.30／0.07 s（wall 0.66 s） |
| 錄影 | `pnpm acceptance`，10 秒錄影加取消案例 | 29.70 s |
| 播放 | 對同一檔案的 `pnpm acceptance:playback` | 14.33 s |
| 原生入口（`acceptance:settings-shortcut` 加 Computer Use） | — | 未量測；由 start:app（約 38 s）、上限 30 秒的 callback 和時間未知的觀察組成 |
| Agent 重複執行 | — | 未知；沒有可用的 session log 區間 |

已量測的 check 後成本排序：設定回歸 fixture 93.18 s；bundle 建置與簽章 37.7–40.6 s，幾乎都花在 electron-builder 打包；錄影回合 29.70 s；播放 14.33 s；鍵盤配置檢查 6.17 s。

### 修正前後對照（覆蓋範圍相同）

- **重建已驗證的 bundle**（確認過的過度執行）。這次之前，`pnpm open:app` 無法分辨 bundle 是新是舊，所以任何修改之後要再跑原生回合，唯一安全的做法就是重建。現在，改動不會影響 bundle 時，下一輪只要 0.66 s，而不是 37.7–40.6 s，每輪省下約 37–40 秒。重開的是同一個簽章 bundle，簽章驗證通過、runtime 輸入紀錄相符。會影響 bundle 的修改仍會要求重建。
- **重複建置**（確認存在）。`pnpm acceptance:regression && pnpm acceptance:shortcut-layout` 與 `pnpm check && pnpm start:app` 都會對相同輸入建置兩次，配方只建置一次。`pnpm build` 單獨執行三次為 0.75–0.78 s，作為階段時為 0.77–0.89 s，所以每條路徑省下不到 1 秒。確實存在，但和 fixture 相比可以忽略。
- **錄影。** 一次錄影同時提供開始／停止／存檔、媒體驗證、倒數證據、取消案例與播放檢查，沒有為了計時重錄。因 stale session 失敗的那一輪是真實缺陷，不是重複執行；修正後重跑的那一輪才是證據。

### 對 058 的影響

已量測的 check 後成本中，最大的是設定 UI 的兩個 fixture：每次設定修改 93 秒。這一輪兩者每個案例都通過，沒有觀察到不穩定。兩個 runner 都沒有拆出啟動、互動與截圖的邊界，所以換 driver 能省下多少比例仍是未知數。058 維持條件式：如果維護者決定進行，它的 pilot 要先把設定 fixture 的 55 秒拆成啟動、互動與截圖矩陣，再拿 Playwright pilot 和這份拆解比較。否則 058–060 延後，沿用現有 driver。

### 驗證

- **自動化。** `pnpm acceptance:recipe -- check` 通過四次：96 個檔案，測試數依序為 1390、1390、1396、1397，因為修正 review 時補了測試。聚焦測試涵蓋計時函式庫、配方、runtime 輸入、`start-app` 與 `sessionBelongsTo`；`git diff --check` 通過。第一次執行發現 `start-app.test.ts` 把配方的計時檔傳給它啟動的 start-app 程序，測試裡的執行因此被記成巢狀階段；現在每次執行使用自己的檔案，並斷言寫入的內容。
- **受控中斷。** 在測試階段送 SIGINT，以 130 結束：該階段記為 interrupted，build 未執行，沒有殘留 vitest。以受控程序的單元測試涵蓋通過、失敗、blocked exit 2、逾時、由子程序自行收尾的中斷、exit 0 後的強制清理，以及 App 清理。
- **桌面回合。** 回合開始前維護者回覆「好了」。`shortcut-registration` 以 122.10 s 通過：設定 176/176、快捷鍵整合 PASS、鍵盤配置 PASS 且輸入法已還原。`recording` 第一次因上述 stale session 失敗；修正後以 87.07 s 通過，錄到 10.2 秒 1920×1080、59.94 fps、10 次閃光與 10 次嗶聲，完整性與取消案例都通過。App 由 runner 自行退出，配方的 App 清理不需要動作。播放檢查的時長、尺寸、即時播放、跳轉、畫面變化與播放到結尾都通過。`pnpm open:app` 重開了 bundle，之後正常退出，bundle 的所有程序都已結束。
- **未執行。** 在真實桌面 runner 執行中中斷配方，以及配方自身對執行中 App 的清理；這兩項只由單元測試涵蓋。原生設定入口、Computer Use 觀察、聽感與擷取矩陣不在本 plan 範圍內。

Review：Codex GPT-6.1 Sol（medium reasoning、read-only），兩輪分別 148 秒與 82 秒。Pass 1 回報四項，全部接受並修正：

- 強制清理後的階段仍可能判為通過。
- `recording` 可能讓 `start:app` 開啟的 App 留著不退出。
- 插樁 workspace 會 import `scripts/fixtures`，runtime 輸入摘要沒有涵蓋。
- symlink 只雜湊目標路徑。

Pass 2 再回報三項，全部接受並修正，沒有再跑下一輪：

- App 清理沒有等 helper 程序。
- 中斷且清理不完整的階段回報 130/143，而不是失敗。
- 開頭的 identity 雜湊不在 wall time 內。

Hotkey runner 的修正發生在兩輪 review 之後，沒有經過 review。

收尾：沒有殘留的 RecordStuff、Electron fixture、素材瀏覽器 profile 或 QuickTime 程序。輸入法為 ABC。錄影與報告保留。任務期間有執行 `caffeinate -d -i -t 5400`。
