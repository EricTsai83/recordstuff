# 063 — 原生驗收操作腳本化，Computer Use 改為只負責觀察

[English](063-scripted-native-acceptance.md) | [繁體中文](063-scripted-native-acceptance.zh-TW.md)

狀態：提案；062 已結案，現為佇列第一個；本計畫結案後才開始 064。相依：步驟 1 無；步驟 3–6 需要步驟 2 的維護者決定；步驟 6 建立在已結案的 062 修好的延後退出通知 runner 上（[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-062-結案--2026-10-02)）。與已延後的 058–060 Playwright 鏈互相獨立，後者處理的是 Settings fixture，不是原生選單列。[061 的結案紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-061-結案--2026-10-02)沒有量測原生入口，因此步驟 3–5 依它們解除阻擋的案例排序，而不是依量測成本。

## 問題與證據

[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 要求每個原生操作都用 Computer Use：開始播放素材、開啟 tray、從 tray 開始與停止、顯示最後一個錄影與 Finder、設定面板的可見與焦點、播放，以及結束 App。第 81、125 行禁止用 AppleScript、System Events 或其他自動化代按 tray 或其他 UI，只有全域快捷鍵例外。[驗收案例](../docs/zh-TW/acceptance.md)把 tray、錄製 UI 與定位檔案標為原生案例。

這條規則讓這些案例依賴一個碰不到 App 的工具。純 tray 的 Electron 程序對 Computer Use 回傳 `-10005 timeoutReached`（`2026-09-19T1753-computer-use-window-probe`），`Target.pressKey()` 也沒有送到全域快捷鍵。在這條規則下，tray 案例只能記為 blocked 或留給維護者：[048](../docs/zh-TW/verification/history-2026-09.md#plan-048-結案--2026-09-28) 把 needsPermission 選單、有未讀失敗的 idle、過期的 Start、淺色選單列與選單鍵盤導覽移交給 035 的 N33a。035 重做回合能做到這些狀態，只是因為維護者授權該回合臨時使用自動化；沒有任何 runner 能重複執行。

同樣的操作在本 repo 已經能以腳本送出原生輸入：

- **Tray。** 048 驗收回合用 CoreGraphics 右鍵，在每個狀態、兩種語言與兩種外觀下開啟真正的選單。status item 只提供 `AXPress`，那等於左鍵、會開始錄影，所以選單一律以右鍵開啟，不用 `AXPress`。2026-09-28 的 [035 重做回合](../docs/zh-TW/verification/history-2026-09.md#plan-035-045049-之後的重做回合--2026-09-28)依維護者決定，由 Claude 以 CoreGraphics 滑鼠與鍵盤事件、AppleScript 及 accessibility tree 操作 32 個原生案例，再對照 App log 判讀自己擷取的截圖。
- **通知與 Finder。** `pnpm acceptance:notification` 透過 System Events 對存檔橫幅執行 `AXPress`，並判定 Finder 是否置前且選取該檔。
- **設定入口。** `pnpm acceptance:settings-shortcut` 在核對 bundle 程序與註冊狀態後，以 System Events 送出 ⌘⌥,。可見與焦點仍交給 Computer Use。
- **播放。** `pnpm acceptance:playback`（commit `2ea706d`）以 AppleScript 操作 QuickTime Player，判定時長、尺寸、即時播放、拖曳、拖曳後畫面與播到結尾；只剩點擊播放器本身的控制項與聽感需要人工。skill 第 124 行仍要求 Computer Use 按播放，和已 commit 的工具不一致。
- **既有 helper。** `scripts/lib/shortcut-layout.mts` 已透過 `osascript -l JavaScript` 的 ObjC bridge 送出 CGEvent；`scripts/lib/desktop-session.mts` 提供鎖定偵測與使用者活動、idle assertion。

目前沒有任何文件說明何時該選 Computer Use、何時該用腳本。[testing.md](../docs/zh-TW/testing.md) 從未提到 Computer Use；AGENTS.md 把所有「native UI acceptance」導向 skill，skill 又要求腳本已能涵蓋的操作也用 Computer Use。

## 目標模型

把「操作 UI」與「判讀畫面」分開。報告中區分三種原生證據：

| 證據 | 意義 | 能證明 | 不能證明 |
| --- | --- | --- | --- |
| 腳本原生輸入 | runner 對受測 bundle 送出真正的 OS 事件（CGEvent、System Events 按鍵／press），並斷言 accessibility 狀態、log 與檔案 | OS 確實送達輸入；原生選單／視窗／Finder 達到預期 AX 狀態，App 有對應反應 | 像素、可讀性、對齊、外觀、聲音 |
| Computer Use 觀察 | agent 檢視截圖或即時桌面並判讀 | 擷取到的畫面中人會看到什麼 | 畫面沒呈現的事；它沒送出的輸入是否送達 |
| 人工 | 維護者操作或判斷 | 主觀聽感、可讀性、需要密碼／Touch ID 的步驟 | 維護者沒做的案例 |

Computer Use 保留腳本做不到或不應做的事：維護者 2026-09-26 授權、仍只限 Computer Use 的「略過系統私密視窗選擇器」提示；案例需要時點擊 QuickTime Player 本身的控制項；VoiceOver；以及判讀 runner 保存的截圖。

腳本輸入限於：受測的 RecordStuff bundle（以程序路徑與 pid 核對）、runner 自己開啟的 Finder 與 QuickTime 視窗，以及測試素材。不回應權限提示、不開「系統設定」的隱私權清單、不編輯 TCC。全域 `killall`、關閉所有視窗，以及繞過原生 UI 的 IPC 或測試 hook 仍然禁止。既有的桌面交接、鎖定、caffeinate、單一執行者與收尾規則適用於所有新 runner。

## 步驟

每一步都可以獨立完成，完成後文件保持一致。

### 1. 寫明選擇規則，並讓 skill 對齊既有腳本

不需要決定；只描述目前的行為與已 commit 的工具。

- 在中英文 [testing.md](../docs/zh-TW/testing.md) 與 [acceptance.md](../docs/zh-TW/acceptance.md) 新增「腳本 runner 或 Computer Use」小節：有專案 runner 涵蓋的操作就用 runner；Computer Use 負責觀察，以及沒有 runner 的操作；各類證據分開標示。AGENTS.md 的原生驗收那一行改為引用此小節，不重複內容。
- 更新 skill：播放改用 `pnpm acceptance:playback -- <檔案>`，Computer Use 只在案例需要時點播放器控制項；「播放器收尾」限縮為該人工路徑。description 與觸發條件和新小節保持一致。

### 2. 維護者決定關卡：允許以腳本操作 RecordStuff 自己的 UI

詢問維護者：在上述限制下，runner 是否可以用 CGEvent 與 accessibility action 操作 RecordStuff 的 tray 選單、設定視窗與選單項目。把決定與日期記在 [acceptance.md](../docs/zh-TW/acceptance.md)，放在 2026-09-26 例外旁邊。

- 同意：修改 skill 第 81、125 行，允許專案 runner 這樣做；agent 仍不得在 runner 之外臨時用 AppleScript、IPC 或測試 hook。接著進行步驟 3–6。
- 拒絕：記錄決定，tray 案例維持由 Computer Use 或維護者執行，就步驟 1 的變更完成步驟 7，並結案本計畫。

### 3. Tray driver 函式庫

提案位置：`scripts/lib/tray-driver.mts`，搭配仿照 `shortcut-layout.mts` 的 JXA helper。

- 只定位受測程序的 status item：像 `acceptance:settings-shortcut` 一樣核對 bundle 路徑與 pid，再讀取該項目的 AX 位置與大小。
- 在該範圍以 CGEvent 右鍵開啟選單；絕不對 status item 執行 `AXPress`。讀取每個選單項目的標題、啟用狀態、分隔線、快捷鍵（`AXMenuItemCmdChar` 與修飾鍵）與順序；以對選單項目 `AXPress` 選取，以 Escape 關閉；支援方向鍵導覽以涵蓋鍵盤案例。
- 每個等待都有上限（與 skill 一樣，每個 UI 狀態 30 秒），支援取消，回傳前確認選單已關閉。選單開啟時，對選單列項目的 AppleScript `click` 可能卡到選單關閉才返回；優先使用 CGEvent 加 AX 讀取，實作時再確認這個行為。
- 以錄下的 AX dump 單元測試解析與判定，不需桌面；在任何 runner 依賴它之前，先在新 bundle 上實際操作驗證。

### 4. Tray 驗收 runner

提案指令：`pnpm acceptance:tray`，對新的 `pnpm start:app` bundle 執行，或在 runtime 輸入未變時對以 `pnpm open:app` 重開的同一個 bundle 執行。與 061 之後的 `pnpm acceptance` 相同，只判斷執行中 pid 自己的 log session（`sessionBelongsTo`），啟動後在有限時間內等待它出現。

- idle、倒數與錄影三種狀態、兩種語言的選單結構：依 [acceptance.md](../docs/zh-TW/acceptance.md) 檢查群組順序、分隔線、只有 idle 有 Start、失敗紀錄在「設定…」旁、錄影中資料夾項目為灰色、已註冊快捷鍵靠右。把原生選單和同一狀態下正式 `tray-model` 的輸出比對，驗證的是 Electron 到 NSMenu 的邊界，而不是重述 model。
- 從 tray 開始錄影（log `state → recording`）、停止並等 `saved`、顯示最後一個錄影（沿用 `notification-acceptance` 的 Finder 置前與選取檢查），以及「結束 RecordStuff」後確認程序已退出。
- 以第二次點擊、「取消錄影」與「結束」取消倒數：回到 idle、保留「顯示上一段錄影」，不留下檔案、失敗紀錄或通知。
- 048 做不到、035 重做回合只靠臨時自動化做到的 N33a 狀態：透過[受控驗收 build](../docs/zh-TW/system-design/tooling.md#受控驗收-build) 檢查 needsPermission 選單與有未讀失敗的 idle、狀態改變後才選的 Start，以及選單鍵盤導覽。
- 每次開啟選單都保存截圖。淺色／深色外觀、對齊與可讀性仍由 Computer Use 或人工判讀這些截圖。
- 一段錄影服務多個案例：本輪也需要錄影 smoke 時，依[測試政策](../docs/zh-TW/testing.md#縮短錄影回合)，由 tray 開始／停止的那段錄影供 `pnpm verify` 與 `pnpm acceptance:playback` 使用。

### 5. 設定面板的原生觀察

在 `acceptance:settings-shortcut` 既有的 callback 檢查之後（或作為它的一個模式），以 AX 斷言：設定視窗存在、為 main 且有焦點、RecordStuff 在前景。接著涵蓋 Tab 移動焦點元素、最小化（`AXMinimized`）與還原、以平台關閉組合鍵關閉，以及再送一次重新開啟。callback-only 的結果保留為獨立證據。版面與視覺檢查仍由 `acceptance:settings` fixture 截圖與可選的 Computer Use 負責。

### 6. 通知橫幅文字（062 之後）

在 062 修好的 runner 中，透過 NotificationCenter 的 AX tree 讀取橫幅：語言符合本輪，且本輪恰好出現一則。截斷與可讀性仍屬視覺判讀。該 runner 的簽章與判定分層由 062 負責，本步驟只加入 AX 文字證據。

### 7. 以觀察為核心重寫 skill

重寫 skill：agent 選擇並執行專案 runner，再檢視保存的截圖與 runner 報告。把已腳本化的操作移出 Computer Use 一節；保留權限提示例外、視覺判讀（倒數、外觀、橫幅可讀性）、播放器控制項、VoiceOver，以及沒有 runner 的操作。同步更新中英文 testing.md 的 tray 操作／原生入口列、工具指南與驗收案例標示。

## 不在範圍內

既有 Computer Use 例外以外的權限提示、「系統設定」與 TCC；需要維護者密碼或 Touch ID 的睡眠與喚醒；主觀聽感與視覺品質；Windows tray 例外（035 N17）；Settings fixture driver（058–060）；以及在 CI 執行桌面 runner。

## 驗證與完成

依[測試政策](../docs/zh-TW/testing.md)處理每一步的 diff。步驟 1、2、7 是文件與 skill 變更：檢查連結、anchor、指令名稱與翻譯，以及 `git diff --check`。步驟 3–6 屬於開發者腳本列：相關測試與 `pnpm typecheck`，再於桌面交接後，在新簽章 bundle 上執行每個變更的 runner，包含失敗、逾時、中斷與收尾路徑。

每個 runner 第一次實際執行時，對同一批狀態另做一次獨立的 Computer Use 或人工觀察比對。腳本判定通過、畫面卻不符，算 driver 失敗，不算產品通過。終端機缺少輔助使用或自動化權限時記為 blocked，不繞過。

完成條件：

- [acceptance.md](../docs/zh-TW/acceptance.md) 中每個 tray、設定入口與 Finder 案例都寫明對應的 runner，或說明為何仍由 Computer Use 或維護者執行。
- 報告分開標示腳本輸入、Computer Use 觀察與人工證據。
- 不把腳本通過當成視覺或主觀證據。
- 步驟 4 列出的 N33a 狀態由 runner 涵蓋，或記錄仍不納入的原因。

把結果寫入驗證歷史，把耐久規則寫入工具與測試文件，再依[計畫完成規則](README.zh-TW.md#完成計畫)處理。
