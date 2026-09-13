# 004 乾淨 TCC 下的權限流程測試

狀態：已完成（2026-09-13）
前置：003（先確認錄製本身可行，再測第一次使用的流程）
後續：006

## 目標

驗證 001 §11 描述的兩個權限流程在「使用者第一次打開 app」的狀態下真的成立，並回答 §17 第 6 題。原本的測試都是在 Electron.app 已有螢幕錄製權限的機器上做的。

**範圍（使用者於 2026-09-13 同意調整）**：004 只負責「開發版（`pnpm start` 的 Electron.app）能驗到的部分」——§17 第 6 題、§11 的行為差異、以及實測逼出的程式修正。需要真實 app 身分才有意義的驗收全部移交 006，理由是 `pnpm start` 用的是多個 Electron bundle 共用的 `com.github.Electron`，006 才會用計畫中的 `com.recordstuff.app` 跑 RecordStuff.app；在共用身分下重跑，得到的既不是使用者會遇到的流程，也無法判定 TCC 紀錄屬於誰。若把這些留在 004、而 006 的前置又是 004，兩邊會互相等待。移交清單見「完成標準」與 006 步驟 6。

## 步驟

1. 先確認 app 沒在跑（`pgrep -fl "Electron.app/Contents/MacOS/Electron"`），再重置兩個權限：
   ```bash
   tccutil reset ScreenCapture com.github.Electron
   tccutil reset AudioCapture com.github.Electron
   ```
   服務名稱已對過系統：`kTCCServiceScreenCapture` 是上半的「螢幕錄製」、`kTCCServiceAudioCapture` 是下半的「僅系統音訊錄製」（來源：`TCC.framework` 的 `REQUEST_ACCESS_SERVICE_kTCCService*` 字串）；`tccutil` 只是把 `kTCCService` 接在參數前面，所以這兩個名稱有效。2026-09-13 實測兩行都成功，各印三筆 reset——這台機器裝了多個共用 `com.github.Electron` 的 Electron bundle。
   `tccutil` 只接受 **bundle id**：拿執行檔路徑當參數會失敗（exit 64、`No such bundle identifier … OSStatus -10814`），不要那樣用。重置後用下面「查核與證據」的命令確認狀態是 `Unknown (None)` 才算乾淨；若之後又在設定頁手動把開關關掉，紀錄會變成 `Denied (System Set)`（已拒絕，不是尚未詢問），第一次的系統提示就不會出現，要從步驟 1 重來。
   **重置前先確認要重置的是哪個 app 身分。** `pnpm start` 跑的是多個 Electron bundle 共用的 `com.github.Electron`（上面那次各印三筆 reset 就是證據），而 006 會用計畫中的 `com.recordstuff.app` 跑 RecordStuff.app——兩者是不同的 TCC 紀錄。日後要重置，必須指定已確認過的那個 bundle id，不要用會波及其他 app 的全域重置（`tccutil reset AudioCapture` 不帶 bundle id、或 `tccutil reset All`）。也不要預期「重置完提示就一定會彈」：2026-09-13 兩次針對 `com.github.Electron` 的音訊重置之後都沒有等到提示（見執行紀錄步驟 5）。
2. `pnpm start`。預期：圖示出現、log `state → needsPermission`、一則通知「需要螢幕錄製權限」、右鍵選單第一行灰字加「開啟系統設定」。
3. 觀察啟動時那一次 `getSources` 的效果：macOS 有沒有彈出「Electron 想要錄製這台電腦的螢幕」？Electron 有沒有自動出現在設定頁清單？兩者都沒有，就把 §11 的「零依賴替代」換成 `node-mac-permissions`，記回 001。
4. 點「開啟系統設定」，打開 Electron 的螢幕錄製。回到 app 等 5 秒。預期兩種之一，記下是哪一種：
   - 直接進 `idle`（macOS 不需重啟），或
   - 進 `needsRelaunch`、通知「需要重新啟動」、選單改「重新啟動」；點了之後重啟並進 `idle`。
5. 左鍵點錄製。預期彈出系統提示「「Electron」想要權限錄製你的系統音訊。」（zh-TW 原文）。先按**拒絕**：應收到 `no_audio_track` 通知，內容指向設定頁，`~/Movies/RecordStuff` 沒有留下檔案（開檔時是零位元組，`FileWriter.abandon()` 會刪掉）。
   提示真的彈出時，記下從點錄製到按下按鈕經過幾秒：開始錄製的逾時是 8 秒（001 §12），超過就會先報 `capture_start_failed`（`capture host 未在時限內送出畫面`）而不是 `no_audio_track`。若真的發生，記下來——那是要改 §12 逾時的證據，不是偶發。權限已經是「已拒絕」時不會彈提示，Chromium 直接給死音軌，約 0.3 秒就報 `no_audio_track`。
6. 到設定頁「僅系統音訊錄製」打開 Electron，再點錄製。預期正常開始，不需重啟。
7. 錄製中到設定頁關掉螢幕錄製權限。macOS 不會無聲地處理：會跳一個對話框「直到結束前，「Electron.app」都能錄製你的螢幕內容。你可以選擇立即結束「Electron.app」，或稍後再執行此動作。」，按鈕是「結束並重新打開」與「稍後」。兩條路都要記：選「稍後」時進行中的錄製有沒有被打斷；選「結束並重新打開」時 app 被終止後殘檔還在不在、能不能播。
8. 003 延後過來的兩項人手檢查：錄完一段後點「已儲存 …」通知，確認 Finder 選到該檔；若這台機器改以內建 Retina 螢幕為主螢幕，錄一段並看 `capture:` log 的 `track size=` 與成品尺寸，答 001 §17 第 7 題的 HiDPI 部分。

## 查核與證據

app 的 log 與系統的 TCC log 要一起看，才分得出「提示沒彈」與「提示彈了但還沒按」：

```bash
pnpm log     # tail -f ~/Library/Logs/recordstuff/recordstuff.log
/usr/bin/log show --last 10m --predicate 'subsystem == "com.apple.TCC"' --info --style compact \
  | grep -iE "recordstuff|com\.github\.Electron" \
  | grep -iE "Handling access request|Update Access Record|AUTHREQ"
```

zsh 的 `log` 是內建命令，一定要寫 `/usr/bin/log`。三種線索：

- `Handling access request to kTCCServiceScreenCapture …, ReqResult(Auth Right: …)`：`Unknown (None)` 是尚未詢問（乾淨狀態）、`Allowed (System Set)`／`Denied (System Set)` 是已有決定。`kTCCServiceAudioCapture` 同理。
- `Update Access Record: kTCCService… to Allowed/Denied`：使用者在提示或設定頁按了什麼、按在哪個時間點。
- app 自己的 `permission: …`、`state → …`、`failed: …`。

## 執行紀錄（2026-09-13）

log 時間為本機時間（UTC+8）；app log 在 `~/Library/Logs/recordstuff/recordstuff.log`。

| 步驟 | 狀態 | 觀察 |
|---|---|---|
| 1 重置 | ✅ | 17:12:16 `tccutil reset ScreenCapture com.github.Electron`、`… AudioCapture …` 兩行都成功，各印三筆 reset。以路徑當參數不支援（exit 64、`No such bundle identifier … OSStatus -10814`） |
| 2 乾淨啟動 | ◐ | 17:12:17 app log：`state → needsPermission`、`ready; output dir …`、`permission: prompt call refused as expected: Failed to get sources.`。右鍵選單第一行與新的重新啟動項目尚未逐項確認；權限通知是否顯示受同一個簽章限制（開發版收不到通知），移交 006 |
| 3 註冊／提示 | ✅ | 設定頁多出一列 Electron.app（開關為關），使用者確認有看到系統提示並操作、允許了螢幕錄製。§11 的零依賴替代（靠一次 `getSources` 註冊並彈提示）成立，不改用 `node-mac-permissions` |
| 4 授權後是否需重啟 | ✅ **必須重啟** | 17:18:37 啟動的 PID 33163 停在 `needsPermission`；17:20 使用者授權（Touch ID）後在 macOS 對話框「直到結束前，「Electron.app」可能無法錄製你的螢幕內容…」選「稍後」。之後超過 30 秒、六次輪詢，app log 完全沒有進展，`getMediaAccessStatus` 從未回 granted，第二段驗證因此沒被觸發、`needsRelaunch` 也不會變 true。17:21:06 重新啟動的程序 17:21:07 立刻 `granted and capture sees 2 screen(s)`。→ 已修正選單（見下方「本次修正」）。這次是「開→關→開」的復原路徑，乾淨 TCC 第一次授權未逐字重跑 |
| 5 拒絕系統音訊 | ◐ | 觀察到的是「設定頁把開關關掉」版本：17:15:05.258（`state → starting` 後約 0.35 s）`no_audio_track 系統音訊軌已結束（…）`、`state → idle`；`find ~/Movies/RecordStuff -maxdepth 1 -type f -newermt '2026-09-13 17:12:00'` 沒有任何檔案 → **不留殘檔已確認**。第一次系統提示按「拒絕」的版本、以及用左鍵點圖示觸發（這次是 `RECORDSTUFF_AUTORECORD`）尚未測。17:31 的重試**不算數**：`tccutil reset AudioCapture com.github.Electron` 印了三行成功後啟動 app，使用者左鍵點錄製，17:31:48 直接開始錄製、沒有出現任何音訊提示（使用者明確確認）。該實驗開始前兩個權限都是開的，所以這不是乾淨的「第一次音訊授權」狀態，只能記成一次失敗的嘗試；不據此斷言 bundle id 重置一定清得掉或一定清不掉以路徑為 key 的紀錄。要正確驗證得用乾淨的使用者帳號或簽章身分（006）。17:59 的再試一次**同樣沒有重現**：17:59:25 重新啟動後 `permission: granted`，17:59:36 開始、17:59:37 進 `recording`，17:59:53 存成 `2026-09-13 17-59-36.mp4`，全程**沒有出現任何系統音訊提示**（使用者確認）；同一段的通知一樣是 `notification: failed (…UNErrorDomain錯誤1…)`。錄製本身正常，只是「第一次音訊授權」這個狀態依舊沒被造出來。為什麼造不出來沒有查明，這裡不作歸因——只記錄兩次嘗試都沒重現，結論待 006 用可驗證的 app 身分重跑 |
| 6 允許後再錄 | ◐ | 17:16 打開「僅系統音訊錄製」後，17:16:28 的 5 秒錄製成功存成 `2026-09-13 17-16-28.mp4`：ffprobe 5.001567 s、2816999 bytes、h264 1920x1080 + AAC 2 聲道。但這個 process 是開關打開之後才啟動的，「同一個 process 不需重啟」同樣未證 |
| 7 錄製中撤銷螢幕權限 | ✅（「稍後」這條） | macOS 不會立刻終止 app，而是跳「直到結束前，「Electron.app」都能錄製你的螢幕內容。你可以選擇立即結束「Electron.app」，或稍後再執行此動作。」。選「稍後」後 90 秒錄製**完整跑完**：17:18:25 `state → stopping` → `idle` → `saved`，`2026-09-13 17-16-55.mp4` ffprobe 90.004917 s、46348510 bytes、h264 + AAC，沒有 `capture_failed`。撤銷只對之後啟動的 process 生效：17:18:37 的新 process 直接 `state → needsPermission`。「結束並重新打開」那一條未測 |
| 8 通知點擊／HiDPI | ⏳ 移交 006 | **通知根本沒出現**：17:22:28–17:22:37 使用者親手用選單列開始／停止，log 有 `saved …17-22-28.mp4`，但使用者回報完全沒有看到通知（系統設定裡 Electron 的通知是開的、樣式為暫時顯示，鏡像／共用螢幕通知為關）。這台是 ad-hoc、linker-signed、沒有 TeamIdentifier 的 Electron，Electron 官方文件說 macOS 的通知需要簽章、未簽章會發 `failed`。加上 `failed` 診斷 log 後 17:29:04 實測到具體原因：`notification: failed (無法完成作業。（UNErrorDomain錯誤1 。）): 已儲存 2026-09-13 17-28-59.mp4`——是 macOS 的通知中心拒收，不是 app 沒送。與 Electron 文件說的「macOS 通知需要簽章」一致，但簽章版能不能顯示尚未驗證，通知顯示與「點通知開 Finder」的驗收移交 006 的簽章版。HiDPI 這次做不到：只接兩台外接 BenQ（主螢幕 1920x1080，邏輯 = 實體），沒有偵測到內建 Retina 螢幕，§17 第 7 題維持部分已答，延到 006 |

## 本次修正（2026-09-13）

實測逼出兩個要改的地方，都已完成，`pnpm check` 通過（typecheck、183 個測試、build）：

1. **`needsPermission` 一律提供「重新啟動」**（`src/main/tray-model.ts`）。步驟 4 的情形下，執行中的程序永遠看不到剛給的授權，而舊選單在 `needsRelaunch` 為 false 時只給「開啟系統設定」，使用者沒有出路。現在 `needsRelaunch` 為 false 時多一項「已經允許了？重新啟動 RecordStuff」，tooltip 說明「執行中的這個程序仍然會被拒絕（macOS 自己的提示也說要結束 app 後才生效）」。狀態機不動：不猜、也不假裝偵測得到授權，輪詢頻率不變。
2. **通知失敗要留下痕跡**（`src/main/tray.ts`、`src/main/index.ts`）。步驟 8 發生「存檔成功但使用者沒看到通知」，而 log 裡沒有任何線索。現在 `Notification.isSupported()` 為 false 會寫 `notification: not supported on this system, dropped: <body>`，Electron 的 `failed` 事件（`(event, error)`，darwin／win32）會寫 `notification: failed (<error>): <body>`。只做診斷：不改通知內容、不加替代 UI、不自動開 Finder，通知失敗也不影響錄製。17:29:04 實測這行確實出現（`UNErrorDomain` 錯誤 1），錄製本身不受影響（同一段 5 秒錄製正常存成 `2026-09-13 17-28-59.mp4`）。


## 執行環境（重跑時會再遇到）

以下都是自動化執行環境的問題，不是 app 的缺陷，但會讓人誤判：

- 啟動前一定要把 `ELECTRON_RUN_AS_NODE` 從環境移除。沒移除的那一次 app 靜靜結束，連 app log 都沒寫。
- 用 `nohup … &`／`disown` 起的 wrapper 會被工具環境收掉；改用 Python `Popen(['/usr/bin/nohup', wrapper], start_new_session=True, stdin=DEVNULL)` 才留得住（確認 PPID 為 1）。
- detached runner 走 login zsh 會抓到 Node 18，`pnpm` 在 `URL.canParse` 就掛掉；讓 `/bin/sh` 繼承目前環境才 build 得起來。

## 記錄

- §17 第 6 題填「已答」。
- 步驟 3、4 的結果決定 §11 是否要改文字或實作。
- 每次 Electron 升版後這個計畫要重跑一次；升版前先 `tccutil reset`。

## 完成標準

範圍調整後（見「目標」），004 的完成標準是**開發版身分下驗得到的部分**，2026-09-13 全部達成：

- 步驟 3（`getSources` 會註冊並彈提示）、步驟 4（在未授權狀態啟動的程序，授權後必須重新啟動才看得到）已答，差異已寫回 001 §11／§8 並改了選單（見「本次修正」）。步驟 4 的答案限定在實測到的情境——**在未授權狀態啟動的程序，於「開→關→開」的復原路徑授權後仍看不到**；乾淨 TCC 第一次授權尚未逐字重跑，因此不當成「macOS 一律必須重啟」的普遍結論。
- 步驟 5 的「缺系統音訊權限時不留殘檔」已確認（0.35 秒回 `no_audio_track`，`~/Movies/RecordStuff` 沒有檔案）。
- 步驟 7 的「稍後」那條已確認（進行中的 90 秒錄製完整跑完存檔）。
- 實測逼出的兩個程式修正已完成並通過 `pnpm check`（typecheck、183 個測試、build）。
- 通知在開發版收不到的原因已查明並留下診斷 log（`notification: failed`，`UNErrorDomain` 錯誤 1）。004 只負責「通知有送出、失敗寫得進 log」——已完成。

### 移交 006 的驗收（004 不聲稱通過）

以下每一項在 004 都**沒有**得到結論，一律由 006 用 RecordStuff.app（`com.recordstuff.app`）重跑並寫下實際結果，見 006 步驟 6：

1. 第一次系統音訊提示按「拒絕」→ 應得 `no_audio_track` 且不留檔案。2026-09-13 兩次嘗試都沒能讓提示出現（17:31、17:59），**未驗證**。
2. 同一個 process 在設定頁打開音訊權限後直接錄（不重啟）。004 那次是開關打開之後才啟動的 process，**未驗證**。
3. 修正後的權限選單實地確認：`needsPermission` 第一行灰字、「開啟系統設定」、以及新的「已經允許了？重新啟動 RecordStuff」按下去真的重啟並進 `idle`。目前只有單元測試涵蓋，**未在真機逐項點過**。
4. 存檔通知會顯示、點下去 Finder 會選到該檔；以及權限通知是否顯示（同一個簽章限制）。（原 003／004 步驟 8）
5. HiDPI：內建 Retina 螢幕為主螢幕時的 `track size=` 與成品尺寸，補完 001 §17 第 7 題。（原 003／004 步驟 8）
6. 乾淨 TCC 下**第一次**授予螢幕錄製的完整流程（步驟 2–6 逐字），以及步驟 7 的「結束並重新打開」那條分支——殘檔還在不在、能不能播。兩者在 004 都仍未驗證。
