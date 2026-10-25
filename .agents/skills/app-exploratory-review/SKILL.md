---
name: app-exploratory-review
description: 以 Computer Use 實機探索試用 pnpm start:app 建置的 RecordStuff 全部功能（Tray、設定各區段、Library、Studio 預覽、短錄影、剪輯畫面、播放器、視窗縮放），像真實使用者一樣找出功能錯誤、體驗不佳、使用者感受到的卡頓與 layout shift，每項附截圖；可指定所有 App 視窗開在某一台螢幕（例如直向副螢幕）。執行者核對發現後向維護者列出並詢問需要判斷的地方，再以實作 skill 修正。適用於維護者要求「用 computer use 試用各種功能」「找體驗/效能/版面問題並修」；不取代 runner 的功能判定，也不是發布驗收。
---

# App Exploratory Review

以使用者的語言回報（維護者用繁體中文時用繁體中文）。這個 skill 補充[原生驗收 skill](../native-acceptance/SKILL.md)：桌面交接、證據分類、Codex 委派、啟動正確的 App 與收尾的共通規則照那裡；這裡只寫探索式全功能試用回合的做法。剪輯畫面的「第一次使用者看不看得懂」另有[剪輯畫面易用性 skill](../edit-view-usability/SKILL.md)，本回合只順帶走過剪輯畫面。只有建立或修改本 skill 的請求，不代表要立即啟動回合。

## 和 runner 的分工

能由 runner 判定的功能（快捷鍵錄影、Tray 結構、播放、剪輯把手拖曳等，見[驗收對照](../../../docs/zh-TW/acceptance.md#腳本-runner-或-computer-use)）結論以 runner 為準；本回合負責 runner 判不了的部分：

- 功能在真實操作路徑上有沒有壞：無反應、錯誤訊息、狀態不一致。
- 體驗：不直覺、用詞混亂或翻譯缺漏、缺少回饋、控制項位置奇怪。
- 使用者感受到的效能：點擊到有反應的時間、卡頓、轉圈過久、捲動不順、開視窗太慢。
- Layout shift：載入或切換時內容跳動、閃爍、尺寸突變、文字截斷或重疊。

Computer Use 的游標無法按住拖曳停在中途，也無法不按鍵移動（見剪輯畫面易用性 skill）；這類現象可以記錄，結論交給 runner。

## 回合步驟

1. **範圍與目標螢幕。** 確認維護者要的功能範圍（未指定就是下方完整清單）以及視窗要開在哪台螢幕。以 `system_profiler SPDisplaysDataType` 與 NSScreen（例如以 `swift` 印出 `NSScreen.screens` 的 `localizedName`、`frame`）取得每台螢幕的名稱、解析度與座標，換算成左上原點的全域座標寫進提示；不要沿用舊座標，螢幕排列會變。設定類視窗開在**游標所在的螢幕**（`src/main/settings/settings-window.ts` 的 `getDisplayNearestPoint(getCursorScreenPoint())`），所以要求 Computer Use 開視窗前先把游標移到目標螢幕，並從該螢幕自己的選單列點圖示。
2. **準備。** 備份 `~/Library/Application Support/recordstuff/settings.json`（例如到 `/tmp/rs-explore/settings.backup.json`），記錄目前 commit。依 AGENTS.md 啟動 `caffeinate -d -i -t 5400`，回合與修正驗證結束後停止。
3. **桌面交接。** 說明本輪範圍（會操作哪些畫面、會錄 5–10 秒短片、目標螢幕、Computer Use 可能要求核准控制 RecordStuff／QuickTime／Finder），請維護者回覆「好了」後停止輸出等待。每一輪都重新交接。
4. **建置。** 收到回覆後執行 `pnpm start:app`，把輸出存檔（例如 `/tmp/rs-explore/start-app.log`）並確認 exit 0 與開啟的是 `dist/mac-arm64/RecordStuff.app`。
5. **委派 Codex。** 目前的 agent 沒有原生 Computer Use 時，委派 **Codex `gpt-6-astra`、reasoning medium**（T3 中用 `delegate_task`，`role: "test"`，`mode: "async"`，每一輪各自的 `clientRequestId`）。提示用下方範本，填入螢幕座標與本輪範圍。等待完成通知，不要輪詢、不要同時操作桌面。
6. **核對。** 讀報告並逐張看截圖；每項發現對照 App log 與程式碼，分成「確認的產品問題」「測試工具限制」「誤判」。無法判定的寫明缺什麼證據。
7. **先列出、再問、再修。** 向維護者列出全部發現（附截圖路徑或內嵌圖片、嚴重度、重現步驟）。涉及設計取捨、用詞、預設值或行為改變的，用提問讓維護者決定，不自行假設；明確的 bug 也先列出再修。修正一律依 [claude-implement-with-gpt6-1-sol-review](../claude-implement-with-gpt6-1-sol-review/SKILL.md) 實作與審查，測試範圍依[共用測試規則](../../../docs/zh-TW/testing.md)選擇。
8. **複驗。** 修正後重建，只針對修過的發現做一輪較小的 Computer Use 複驗（重新交接），附修正前後截圖。
9. **收尾與回報。** 依原生驗收 skill：停止錄影並等存檔、關閉測試視窗（含 QuickTime 文件與自動跳出的開啟面板）、`settings.json` 與備份逐位元組比對還原（`cmp`）、正常結束 App 並以 `pgrep -fl RecordStuff` 確認程序消失、停止 `caffeinate`。列出新增的測試錄影並詢問保留或移到垃圾桶；截圖拍到維護者整個螢幕，給維護者看過後詢問是否刪除 `/tmp/rs-explore/`。回報分開寫：測過的功能、發現與處理、只靠 Computer Use 觀察的項目、blocked 或未驗證的項目，並附上原生驗收 skill 規定的人為干擾提醒。

## 委派提示範本

```text
你是 RecordStuff（<checkout 路徑>）的探索式驗收執行者，不要再委派。用繁體中文回報。

## 前提
- 先讀 AGENTS.md 與 .agents/skills/native-acceptance/SKILL.md（依其中的工具規則與收尾規則；這輪是探索式體驗測試，不是完整基本驗收）。
- 先確認你有原生 Computer Use 工具可用；沒有就立即回報 blocked 並停止。
- 維護者已完成桌面交接（已回覆「好了」），你可以直接操作桌面。
- App 已由呼叫者以 `pnpm start:app` 建置並開啟（commit <SHA>，產物 dist/mac-arm64/RecordStuff.app），輸出在 <start-app.log 路徑>。不要再執行 pnpm start:app 或重建；中途需要重開時，正常結束後用 `pnpm open:app`。App log：~/Library/Logs/recordstuff/recordstuff.log。
- RecordStuff 是選單列 App，沒有主視窗。Computer Use 對純 tray 程序可能回 -10005 timeoutReached，此時直接在螢幕上點選單列圖示，或用 `pnpm native:input`（elements / press <標題> / click / scroll / shortcut，見 docs/zh-TW/system-design/tooling.md#執行者輸入）操作設定視窗。錄影快捷鍵 <目前設定>；設定快捷鍵 ⌥⌘,（可用 `pnpm acceptance:settings-shortcut -- --observe` 送出）。

## 螢幕
- <每台螢幕：名稱、解析度、左上原點的全域座標範圍、是否主螢幕>
- 所有 RecordStuff 視窗（設定、Library、Studio、剪輯畫面、播放器等）都要開在 <目標螢幕>。設定視窗會開在游標所在的螢幕：開視窗前先把游標移到目標螢幕，優先從該螢幕自己的選單列點 RecordStuff 圖示。若某個視窗仍開在別的螢幕，記為一個發現（附截圖），再把它拖到目標螢幕繼續。
- 錄影照設定的預設螢幕；錄影長度保持 5–10 秒。

## 要做的事
像真實使用者一樣試用，包括但不限於：
1. Tray 選單：每個項目、子選單、淺色/深色可讀性。
2. 設定視窗每個分頁/區段：切換每種設定、改值再改回、快捷鍵擷取、語言切換（最後切回原語言）、外觀、相機/麥克風開關（權限提示只觀察，不改系統設定/TCC）。
3. Library：格線/列表切換、滑過預覽、搜尋/排序/最愛、開啟錄影、播放器控制項。
4. Studio / 預覽：Live preview 開關與各速率、相機泡泡拖曳。
5. 錄一段 5–10 秒短片：倒數、錄影中選單狀態、停止、存檔通知，再在 Library/剪輯畫面打開：修剪把手、選取、匯出（可取消或只匯出很短一段）。
6. 把視窗縮放到目標螢幕的窄寬/高高尺寸，看排版是否壞掉。
<本輪額外重點>

每個畫面特別注意並記錄：功能錯誤／無反應／錯誤訊息／文字截斷或重疊或翻譯缺漏；體驗不好之處；使用者感受到的效能（點擊到反應的大約時間、卡頓、轉圈過久、捲動不順、開視窗太慢）；layout shift（用連續截圖捕捉前後）。

## 證據
- 每個發現截圖存到 <截圖目錄>，檔名 `NN-簡短描述.png`。用 `screencapture -x -R <x,y,w,h> <檔>` 對準目標螢幕或視窗 frame（`-x` 單獨只拍主螢幕）。
- 必要時讀 App log 對照時間。
- 不修改程式碼、不 commit；不碰「系統設定」/TCC/其他 App 的提示。

## 收尾
- 停止錄影並等存檔；關閉你開的測試視窗（含 QuickTime 文件與其自動跳出的開啟面板）；把 App 內改過的設定改回原值（備份在 <備份路徑>，呼叫者之後會逐位元組核對）；從選單正常結束 RecordStuff，以 `pgrep -fl RecordStuff` 確認程序已結束。
- 列出這輪新增的錄影檔路徑（不要刪除）。

## 回報格式
寫到 <報告路徑>，最後訊息也貼出同樣內容：
1. 測過的功能清單（做了什麼、結果 正常/有問題/blocked）。
2. 發現清單依嚴重度排序：類別（bug / UX / 效能 / layout shift / 文字）、重現步驟、預期 vs 實際、截圖路徑、原因猜測。
3. 沒測到或 blocked 的項目與原因。
4. 收尾狀態（設定、視窗、程序、新增錄影）。
附註：「測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。」
```

## 判讀與證據

- 報告標示為「Codex computer use 觀察」，與 runner 的腳本證據、維護者親自操作分開（[測試指南](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use)）。
- Computer Use 量到的反應時間是體感估計，不是量測；要下效能結論時，改用 App log 時間戳或對應的 `measure:*`／`diagnose:*` 指令佐證，並寫明方法。
- Codex 的建議不一定要採用：與 macOS 慣例或既有設計決定衝突的，在回報中說明不採用的理由。
- 視窗開在非目標螢幕時，先確認是不是游標位置造成的（測試操作順序），再判斷是否為產品問題。
