---
name: edit-view-usability
description: 以 Computer Use 實機檢查 RecordStuff 剪輯畫面（「剪輯…」）對第一次使用者是否好懂：讓用過一般剪輯軟體（iPhone 相簿／QuickTime 修剪、iMovie、CapCut、Final Cut）、但沒看過說明的人，在 pnpm start:app 建置的 App 上不靠教學完成修剪、移除、還原與找切點，以及可剪輯錄影的時間軸分段（相機時段、音量時段），並檢查每個按鈕、提示與中文用詞。只負責 runner 與背景 UI 測試判定不了的「看不看得懂、順不順手、看起來對不對」；功能、版面不跳動、匯出內容的判定交給 pnpm acceptance:editor 與 tests/ui/editor.spec.ts。適用於剪輯畫面的 UX/UI 修改後、維護者要求「用 computer use 實際操作看看」或「確認不用教學也能上手」。
---

# Edit View Usability

以使用者的語言回報（維護者用繁體中文時用繁體中文）。這個 skill 補充[原生驗收 skill](../native-acceptance/SKILL.md)：桌面交接、證據分類與 Codex 委派的共通規則照那裡；這裡只寫剪輯畫面易用性回合的做法。只有建立或修改本 skill 的請求，不代表要立即啟動回合。

## Runner、背景測試與 Computer Use 的分工

依[腳本 runner 或 Computer Use](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use)，能判定的就交給腳本；Computer Use 只判斷腳本判定不了的事。2026-10-26 起，相機與音量時段的幾輪 Computer Use 檢查，凡能判定的都已移入腳本（每個斷言都以「改壞程式就失敗」驗證過）：

| 項目 | 由誰 |
| --- | --- |
| 修剪把手按住時的時間標籤與時間列、拖出視窗外放開後的匯出長度、按住選取範圍時預覽跟隨、滑過預覽的懸停與返回、快捷鍵面板、⌘Z 全部撤回 | `pnpm acceptance:editor`（`native-ax.mts` 的 `pointer down/drag/up` 與 `texts`） |
| 相機泡泡的拖曳、縮放（含注音輸入法下的 −）、隱藏與還原、音量、算繪匯出、Tray 的「開始可剪輯錄影」、下一段錄影回到一般錄影 | `pnpm acceptance:editor` |
| 相機時段（S、C 設定 4–7 秒隱藏，預覽跟著播放位置，匯出該段只有螢幕畫面）、音量時段（S、V、靜音，匯出該段以 ffmpeg 量到數位靜音） | `pnpm acceptance:editor` |
| 相機軌與音軌的選取、相機軌旁的修剪把手、存檔時控制項不變暗、「隱藏所有相機畫面」保留時段、上限、排隊順序、取消靜音、工具列在 1060／960 px 維持一行、隱藏時的虛線外框不吃按壓也不讓泡泡被拖動、音量面板把點過的音軌排第一 | 背景 UI 與頁面測試（`pnpm test:scope -- editing`，不用桌面） |
| 第一次使用者看不看得懂、會先試什麼手勢、按鈕與提示的用詞、深色模式的對比與層次、懸停提示的內容、預覽聽起來對不對、跟常見剪輯軟體比是否順手 | **本 skill（Computer Use 觀察）** |

Computer Use 的限制（2026-10-25 起的各輪都是如此）：游標**無法按住拖曳停在中途、無法不按鍵移動**，所以看不到拖曳中的畫面、懸停提示也拍不到；**聽不到聲音**；滑桿的拖曳常常沒有作用（改用點擊軌道或聚焦後按方向鍵）。上表交給腳本的項目不要在這裡判定；觀察到的現象可以記錄，結論以腳本為準。

## 回合步驟

1. **桌面交接。** 說明範圍（約 10–20 分鐘；時段回合可能會匯出一次；截圖會拍到整個螢幕），請維護者回覆「好了」，收到後才開始。每一輪都重新交接；只有維護者明確說不用等回覆時才省略，並在回報中寫明。
2. **建置與準備。** 結束正在執行的 RecordStuff（`osascript -e 'tell application id "com.ericts.record" to quit'`，等程序結束），`pnpm start:app`，再執行 **`pnpm prep:edit-view`**：它開啟本 checkout 的 bundle 的視窗，放到主螢幕以外的螢幕（沒有就留在主螢幕），最大 1060×1400，並把輸出資料夾裡最新的可剪輯錄影複製成一個沒有剪輯紀錄的新錄影；輸出一行 JSON，含視窗位置、要用的截圖指令（`screencapture -x -D <n>`）與副本名稱，填進提示。啟動 `caffeinate -d -i -t 5400`，回合結束後停止。沒有可剪輯錄影時，它會要求先錄一段（Tray 的「開始可剪輯錄影」）。
3. **委派 Codex。** 目前的 agent 沒有原生 Computer Use 時，委派 **Codex `gpt-6.1-sol`、reasoning medium**（T3 中用 `delegate_task`，`role: "test"`，`target.options` 用 `reasoningEffort`，每一輪各自的 `clientRequestId`）。修剪、移除用「一般回合」範本；相機與音量時段用「時段回合」範本。
4. **核對再修。** 收到報告後，把每項發現對照程式碼確認是真的問題、測試工具的限制，還是誤判；先向維護者列出全部發現，再修確認的問題。能變成腳本判定的，補進 `tests/ui/editor.spec.ts`、頁面測試或 runner，且每個新斷言都要先「暫時改壞對應的程式，確認它失敗，再改回」；不能讓它失敗的斷言不加。跑 `pnpm test:scope -- editing`。
5. **回報。** 分開寫：每項任務第一次是否成功、找到的問題與處理方式、只靠 Computer Use 觀察的項目、交給腳本或仍未驗證的項目（拍不到的懸停提示、聽不到的聲音）。附上關鍵截圖。
6. **清理。** 確認剪輯已全部還原或重設、「滑過預覽」關閉、剪輯畫面關閉、App 保持開著。執行 **`pnpm prep:edit-view -- --cleanup`**：把這輪準備時複製的錄影、它的匯出檔（「（已編輯）」或 "(edited)"，含編號）與剪輯紀錄移到垃圾桶，其他檔案不動。截圖拍到維護者的整個螢幕：給維護者看過後詢問是否刪除，同意就刪掉 `/tmp/rs-cu-shots/`。

## 已知的環境陷阱

- **視窗跨在兩個螢幕之間**時，Computer Use 看到的畫面和 `screencapture` 對不上，整輪會被擋住（2026-10-26 第一輪）。`pnpm prep:edit-view` 會把視窗整個放進一個螢幕；提示中寫明視窗的位置與要用的 `-D`，並請 Codex 不要移動或縮放它。
- **連線**一律用 bundle 的完整路徑，不用 bundle id（會連到 /Applications 的舊版）。
- **輸入法是注音**時，剪輯畫面的 S、C、V、+、− 依按鍵位置判斷，仍然有效；若打字出現選字視窗，按 Escape。
- **選項類浮動視窗開著時**，輔助使用樹看不到視窗其他部分；runner 會先按 Escape，Codex 也一樣。
- **相機鏡頭被遮住或環境太暗**時，runner 的「泡泡裡是相機畫面」記為未判定（blocked），不是失敗也不是通過。

## 一般回合範本

```text
Hands-on, first-time-user UX review (round N) of a macOS app's video EDIT VIEW using YOUR COMPUTER USE capability
(screenshots + real mouse/keyboard). The user approved desktop control now and will not touch mouse/keyboard.
Do NOT modify repository files. Do not record, do not turn on the camera, never click Export (匯出), do not quit the app.

Connecting: attach by the exact app path /Users/<user>/<checkout>/dist/mac-arm64/RecordStuff.app (attaching by bundle
id is ambiguous). On a timeout, wait ~10 s and retry up to 3 times; else operate at whole-screen level. If computer use
is unavailable, stop and report the errors. The window is at <prep:edit-view's window>; do not move or resize it.
Screenshot it with <prep:edit-view's screenshot command>; check the first one shows the RecordStuff library.

Persona: you have used ordinary video editors (iPhone Photos/QuickTime trim, iMovie, CapCut, Final Cut) but never this
app; do not read its docs or source.

App: RecordStuff (menu bar), UI in Traditional Chinese. 「錄影檔」 tab → the card "<prep:edit-view's copy>" → 「⋯」 →
「編輯…」. Do not open other cards.

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

## 時段回合範本

只判斷腳本判定不了的事：功能、版面不換行、外框、排序、匯出內容與音量都已有腳本判定，Codex 看到相反的現象時照樣記錄，由執行者對照腳本結果。

```text
Hands-on UX/UI review (round N) of a macOS app's video EDIT VIEW, its timeline stretches, using YOUR COMPUTER USE
capability (screenshots + real mouse/keyboard). The user approved desktop control now and will not touch
mouse/keyboard. Do NOT modify repository files. Do not record, do not quit the app. You MAY click Export (匯出) once.
Do not re-delegate.

Connecting: attach by the exact app path /Users/<user>/<checkout>/dist/mac-arm64/RecordStuff.app. The window is at
<prep:edit-view's window>; do not move or resize it. Screenshot it with <prep:edit-view's screenshot command>; check the
first one shows the RecordStuff library. The input source may be Zhuyin; the editor's S, C and V work by key position;
press Escape if a candidate window appears. You cannot hold a drag midway, hover without pressing or hear sound: say
"unverified by computer use" for tooltips and sound rather than guessing; for a slider, click its track or focus it and
use the arrow keys.

Persona: you have used Final Cut, CapCut or iMovie but never this app; do not read its docs or source.

App: RecordStuff, UI in Traditional Chinese. 「錄影檔」 tab → the card "<prep:edit-view's copy>" (可編輯, never edited) →
「⋯」 → 「編輯…」. Do not open other cards.

What there is: under the timeline's pictures, a camera lane (「顯示相機」 / hatched 「隱藏相機」) and a lane per sound
input (「系統聲音 100%」, a stretch's percent, hatched 「靜音」). Toolbar after the trash button: the camera button
(「隱藏相機」 / 「顯示相機」, key C) and 「音量」 (key V), both acting on a dragged range, a selected part (S splits at the
playhead and selects the part after it) or a clicked lane stretch. 「選項」 holds 「隱藏所有相機畫面」 and
「重設相機與音量」. Undo ⌘Z, Redo ⇧⌘Z.

Tasks (expected vs happened, attempts, first-try success, screenshot paths):
a. Open the editor. Without reading anything, find how to hide the camera for a while and how to mute the microphone
   for a while; say what you tried first and whether the lanes and buttons read as what they are.
b. Hide the camera from ~0:02 to ~0:04 and from ~0:08 to the end; mute the microphone from ~0:05 to ~0:06; set the
   system audio to ~50% somewhere.
c. Pause inside a hidden stretch and judge the outline that shows; play through the stretches and judge the bubble's
   cuts (and the sound, if you can hear it; else unverified).
d. Turn 「隱藏所有相機畫面」 on and off; judge whether its note says what happens.
e. <this round's focus>.
f. Export once, open it from the toast's 播放 and judge the camera inside and outside the hidden stretches.
Audit only what a person judges: whether each label, icon, note and tooltip says what it does in natural Traditional
Chinese; contrast and hierarchy of the lanes and the hatching in this theme; whether the lanes read as one timeline with
the pictures, playhead and ruler; anything confusing compared with Final Cut / CapCut / iMovie.

Cleanup: 「選項」 → 「重設相機與音量」, undo until Undo is unavailable if possible; close popovers, the player and the
editor; leave the app running and the window in place; report the export's file name. Screenshots to
/tmp/rs-cu-shots/ named rN-NN-description.png.

Report (English, concise, complete): computer use status; step log with readouts and screenshot paths; verdict per task;
ranked UX/UI problems with concrete fixes (exact Traditional Chinese wording); functional observations separately with
repro steps; what is good; what stayed unverified; cleanup confirmation.
```

## 判讀與證據

- 報告標示為「Codex computer use 觀察」，與 runner 的腳本證據、背景測試、維護者親自操作分開（[測試指南](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use)）。
- Codex 的拖曳是一次完成的：「拖曳中」的畫面它看不到，只能看到放開後；滑過時不按鍵的移動它做不到。這類項目寫「Computer Use 無法觀察，由 acceptance:editor 判定」，不寫成通過或失敗。
- 它的建議不一定都要採用：例如它建議把「還原」改成「復原」，但 macOS 繁體中文的 Undo 是「還原」，維持與系統一致；它建議在按鈕旁常駐「已隱藏所有相機畫面」的說明，但提示框、按 C 的提示與「選項」的說明已三處說明，常駐只會讓工具列更擠。不採用的建議要在回報裡說明理由。
- 播放器的懸停縮圖跟著游標而不是播放位置：以點擊跳轉、游標不動時縮圖不更新，不是錯誤。
- 每輪的發現與處理記在 [剪輯設計](../../../docs/zh-TW/system-design/editing.md)（中英文）中該功能的段落。
