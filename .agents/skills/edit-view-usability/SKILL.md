---
name: edit-view-usability
description: 以 Computer Use 實機檢查 RecordStuff 剪輯畫面（「剪輯…」）對第一次使用者是否好懂：讓用過一般剪輯軟體（iPhone 相簿／QuickTime 修剪、iMovie、CapCut、Final Cut）、但沒看過說明的人，在 pnpm start:app 建置的 App 上不靠教學完成修剪、移除、還原與找切點，並檢查每個按鈕、提示與中文用詞。只負責 runner 判定不了的「看不看得懂、順不順手」；按住拖曳、滑過預覽、匯出與錄影的功能判定交給 pnpm acceptance:editor。適用於剪輯畫面的 UX/UI 修改後、維護者要求「用 computer use 實際操作看看」或「確認不用教學也能上手」。
---

# Edit View Usability

以使用者的語言回報（維護者用繁體中文時用繁體中文）。這個 skill 補充[原生驗收 skill](../native-acceptance/SKILL.md)：桌面交接、證據分類與 Codex 委派的共通規則照那裡；這裡只寫剪輯畫面易用性回合的做法。只有建立或修改本 skill 的請求，不代表要立即啟動回合。

## Runner 與 Computer Use 的分工

依[腳本 runner 或 Computer Use](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use)，能判定的就交給 runner：

| 項目 | 由誰 |
| --- | --- |
| 修剪把手按住時的時間標籤與時間列、拖出視窗外放開後的匯出長度、按住選取範圍時預覽跟隨、滑過預覽的懸停與返回、快捷鍵面板、⌘Z 全部撤回 | `pnpm acceptance:editor`（`native-ax.mts` 的 `pointer down/drag/up` 與 `texts`） |
| 相機泡泡的拖曳、縮放、隱藏與還原、音量、算繪匯出、Tray 的「開始可剪輯錄影」、下一段錄影回到一般錄影 | `pnpm acceptance:editor` |
| 第一次使用者看不看得懂、會先試什麼手勢、按鈕與提示的用詞、版面是否跳動或被切掉、跟常見剪輯軟體比是否順手 | **本 skill（Computer Use 觀察）** |

Computer Use 的游標**無法按住拖曳停在中途，也無法不按鍵移動**（2026-10-25 的六輪中都是如此），所以上面交給 runner 的項目不要在這裡判定；觀察到的現象可以記錄，但結論以 runner 為準。

## 回合步驟

1. **桌面交接。** 說明範圍（約 10–15 分鐘、不會錄影、不會開相機、不會匯出、截圖會拍到整個螢幕），請維護者回覆「好了」，收到後才開始。每一輪都重新交接。
2. **建置。** 結束正在執行的 RecordStuff（`osascript -e 'tell application id "com.ericts.record" to quit'`，等程序結束），再 `pnpm start:app`，確認 `dist/mac-arm64/RecordStuff.app` 的程序在跑。啟動 `caffeinate -d -i -t 5400`，回合結束後停止。
3. **委派 Codex。** 目前的 agent 沒有原生 Computer Use 時，委派 **Codex `gpt-6.1-sol`、reasoning medium**（T3 中用 `delegate_task`，`role: "test"`，每一輪各自的 `clientRequestId`）。提示用下方範本，填入本輪重點。
4. **核對再修。** 收到報告後，把每項發現對照程式碼確認是真的問題、測試工具的限制，還是誤判；先向維護者列出全部發現，再修確認的問題，並補 UI 測試（`tests/ui/editor.spec.ts`）或 runner 檢查，跑 `pnpm test:scope -- editing`。
5. **回報。** 分開寫：每項任務第一次是否成功、找到的問題與處理方式、只靠 Computer Use 觀察的項目、交給 runner 或仍未驗證的項目。附上關鍵截圖。
6. **清理。** 確認剪輯已全部還原（「還原」不可用、沒有移除的片段）、「滑過預覽」關閉、剪輯畫面關閉、App 保持開著、沒有匯出。截圖拍到維護者的整個螢幕：給維護者看過後詢問是否刪除，同意就刪掉 `/tmp/rs-cu-shots/`。

## 委派提示範本

```text
Hands-on, first-time-user UX review (round N) of a macOS app's video EDIT VIEW using YOUR COMPUTER USE capability
(screenshots + real mouse/keyboard). The user approved desktop control now and will not touch mouse/keyboard.
Do NOT modify repository files. Do not record, do not turn on the camera, never click Export (匯出), do not quit the app.

Connecting: attach by the exact app path /Users/<user>/<checkout>/dist/mac-arm64/RecordStuff.app (attaching by bundle
id is ambiguous). On a timeout, wait ~10 s and retry up to 3 times; else operate at whole-screen level. If computer use
is unavailable, stop and report the errors. Screenshot the display the window is actually on
(`screencapture -x -D 2 <path>` for a second display).

Persona: you have used ordinary video editors (iPhone Photos/QuickTime trim, iMovie, CapCut, Final Cut) but never this
app; do not read its docs or source.

App: RecordStuff (menu bar), UI in Traditional Chinese. Open via the menu bar icon → 「開啟 RecordStuff」 or ⌥⌘, .
「錄影」 tab → newest recording → 「⋯」 → 「剪輯…」.

Tasks (narrate expectation vs result, attempts, first-try success):
a. cut off the first ~2 s and the last ~1 s;  b. remove a middle stretch (~40–60%);  c. undo then redo;
d. find a precise time to cut;  e. play through the edited areas and read the export length;
f. <this round's focus>.
Audit every visible control and text: labels, icons, hint, ruler, playhead, trim handles, selection and removed
visuals, export length, feedback messages; judge clarity in Traditional Chinese and against common editor conventions;
note anything misaligned, clipped, jumping or confusing.

Cleanup: undo until nothing is removed and Undo is unavailable (else close/reopen and verify untouched); 滑過預覽 OFF;
close any popover and the edit view; leave the app running. Never Export.
Screenshots to /tmp/rs-cu-shots/ named rN-NN-description.png.

Report (English, concise but complete): computer use status and display; step log with exact readouts and screenshot
names; verdict per task (first-try success? attempts?); ranked UX/UI problems with concrete fixes (exact Traditional
Chinese wording where text); functional bugs separately; what is good; cleanup confirmation.
```

## 判讀與證據

- 報告標示為「Codex computer use 觀察」，與 runner 的腳本證據、維護者親自操作分開（[測試指南](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use)）。
- Codex 的拖曳是一次完成的：「拖曳中」的畫面它看不到，只能看到放開後；滑過時不按鍵的移動它做不到。這類項目寫「Computer Use 無法觀察，由 acceptance:editor 判定」，不寫成通過或失敗。
- 它的建議不一定都要採用：例如它建議把「還原」改成「復原」，但 macOS 繁體中文的 Undo 是「還原」，維持與系統一致。不採用的建議要在回報裡說明理由。
- 每輪的發現與處理記在 [剪輯設計](../../../docs/zh-TW/system-design/editing.md)（中英文）中該功能的段落。
