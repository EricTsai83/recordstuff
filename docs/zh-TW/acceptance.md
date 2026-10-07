# 共用驗收案例

[English](../acceptance.md) | [繁體中文](acceptance.md)

人工與 AI 使用相同案例及證據規則。依[測試指南](testing.md)選擇必要案例，純 UI 修改不自動要求錄影。每個原生案例依[下方對照](#腳本-runner-或-computer-use)使用專案 runner 或 Computer Use；由 agent 執行的回合使用[原生驗收 skill](../../.agents/skills/native-acceptance/SKILL.md)。腳本、人工及 computer use 觀察須分開標示。

## 準備一輪驗收

任何桌面接管前，先完成[準備就緒交接](testing.md#測試前確認桌面交接)：說明本輪範圍、要求回覆「好了」等明確訊息，停止輸出並等收到回覆才開始。報告記錄回覆與範圍，定時暫停不能代替此步驟。

記錄時間、OS／架構、來源 SHA 與工作樹變更、產物路徑、設定及原有 App／錄影狀態。開發期間可按需停止錄影、退出、重啟或重建 RecordStuff，不需另行確認。正常 bundle 驗收以 `pnpm start:app` 建置啟動，再核對執行程序路徑；`pnpm open:app` 只用於同一輪重開同一產物。簽章前置與專用 runner 見[工具指南](system-design/tooling.md)。

開發分支與未提交的修正可以用相同 revision 的 `pnpm start:app` 產物驗收；記錄 commit、dirty 狀態與內容 identity、相依套件、產物路徑與 bundle identifier，以及簽章憑證 fingerprint。合併後與發布驗收依[發布規則](system-design/releases.md)使用指定的 main commit 或 release candidate。只看分支名稱不能證明產物是最新的，也不能證明簽章有效。

錄影 smoke 保持螢幕／音訊環境穩定，使用 [test-material.html](../../scripts/test-material.html)。記錄來源尺寸、品質／fps、瀏覽器、音訊輸出／音量及素材版本。人工／原生操作點擊素材的音訊／全螢幕開始控制項；`pnpm acceptance` 自行提供自動播放設定。螢幕選擇測試須把素材放在選取來源；快捷鍵 runner 的主螢幕素材不一定涵蓋其他已選來源。

## 錄影 smoke 與原生案例

一次短錄影可供多個案例使用。必要錄影 smoke 涵蓋開始／停止／存檔、媒體驗證與播放。Tray 狀態及 Finder 操作在受影響時追加，或納入明確要求的完整基本原生驗收。快捷鍵腳本不能讓 Tray 點擊案例通過。

| 案例 | 操作與預期觀察 |
| --- | --- |
| 啟動／Tray（原生；`pnpm acceptance:tray`） | 開啟選單，確認待命／權限狀態及相關操作；核對受測 App，避免重複或舊安裝副本。每個狀態的選單都依同一組順序：狀態與主要動作（開始錄影、停止、取消錄影；儲存位置無法使用時才有更改儲存位置…）、未讀失敗、開啟 RecordStuff，最後是結束 RecordStuff，沒有多餘的分隔線；已註冊的快捷鍵靠右顯示；儲存位置、顯示最後一個錄影、已確認的失敗與顯示 log 都在 RecordStuff 裡，不在選單（2026-10-04）。runner 把每個選單與正式 model 及這些規則比對；淺色與深色選單列、對齊與可讀性，則觀察它的截圖。needsPermission 選單仍由維護者處理，因為要到達它必須撤銷權限 |
| 開始 | 經選定的真正使用者路徑開始，確認錄影；動態素材與左右交替嗶聲持續約 10–15 秒 |
| 錄影 UI（原生；錄影中選單用 `pnpm acceptance:tray`） | 依現行需求確認受影響狀態、停止操作及鎖定設定 |
| 停止／存檔 | 停止一次，等待 saved／待命，記錄新 MP4 路徑；觀察到 Saving 就保存，沒捕捉短暫狀態本身不算失敗 |
| 存檔錄影入口（原生；`pnpm acceptance:notification`） | 點存檔橫幅；分別判定 RecordStuff 置前且視窗聚焦，以及「錄影檔」中那段錄影的卡片取得焦點；嘗試替代路徑前保留失敗 |
| 播放 | 開啟該檔，播放與拖曳，觀察內容及進度前進；記錄是否真的能做主觀聽感檢查。`pnpm acceptance:playback -- <檔案>` 以 QuickTime Player 涵蓋此案例，點擊其控制項與聽感除外（[播放檢查](system-design/tooling.md#播放檢查)） |
| 媒體驗證 | 復用同檔／同範圍的 runner 報告，或依下方執行 `pnpm verify`；保留每個判定失敗，音軌存在不等於非靜音 |

無人值守開始／停止／存檔與完整性檢查：

```bash
pnpm start:app
pnpm acceptance
```

第二個指令需 App 待命，通常在保存與驗證後退出 App。後續只開保存影片播放，不必重開 RecordStuff。人工錄影固定素材時，先建立新報告目錄，再執行：

```bash
pnpm verify -- /absolute/path/recording.mp4 --test-material --json /absolute/path/report-dir/verify.json
```

保留輸出及退出碼（fail 或 incomplete 為 1，blocked 為 2）。依目前音訊規格，Sample rate/channels 檢查要求 48 kHz／兩聲道，另一項 Channel energy (RMS) 檢查要求兩聲道 RMS 均大於 −60 dBFS。這能支持非靜音，不代表音質、聲道分離、主觀聽感或同步。缺失／n/a 不算通過；必要檢查為 blocked（缺工具）或 incomplete（標記不足）也不算通過。`--test-material` 只回報稀疏嗶聲碼率而不判定；`--screen` 填實際來源尺寸，需要同步分析且素材支援時才加 `--sync`。詳細門檻見[工具指南](system-design/tooling.md#驗收門檻)。

### 腳本 runner 或 Computer Use

依[選擇規則](testing.md#腳本-runner-或-computer-use)操作每個案例，並把證據標為腳本輸入、Computer Use 觀察或人工。目前的涵蓋範圍：

| 操作 | 腳本 runner | 仍由 Computer Use 或維護者負責 |
| --- | --- | --- |
| 以全域快捷鍵開始、停止與存檔，並做完整性檢查 | `pnpm acceptance` 透過 System Events 送出已註冊的按鍵 | 倒數與 REC 在選單列上的樣子 |
| 點擊存檔通知 → 錄影檔 | `pnpm acceptance:notification` 透過輔助使用按下橫幅，判定 RecordStuff 是否置前、視窗聚焦且那段錄影的卡片取得焦點（[通知驗收](system-design/tooling.md#通知驗收)） | 橫幅可讀性；卡片的框線 |
| 以快捷鍵開啟設定 | `pnpm acceptance:settings-shortcut` 透過 System Events 送出 ⌥⌘,，檢查 callback；加 `-- --observe` 時，另以輔助使用斷言視窗在前景且有焦點、Tab、應用程式選單沒有重新載入或開發者工具（⌘R、⌥⌘I 不改變焦點），且綁定 ⌘C、⌘A、⌘M 與 ⌘Q、⌘A 再 ⌘C 能複製面板文字並還原剪貼簿、最小化與還原、關閉與重開，以及頁面填滿視窗、視窗按鈕下沒有可點擊元素，並存下 `settings-window.png`；加 `--quit` 再按 ⌘Q 並確認所有程序結束 | 外觀與可讀性，依 `settings-window.png`（此視窗，含視窗按鈕）與背景套件的圖與基準（`pnpm test:ui`：所有語言、外觀與尺寸）判斷 |
| 設定視窗框、被另一個視窗取消啟用的視窗、真正的快捷鍵註冊被拒與視窗狀態、錄影播放器在螢幕上的全螢幕 | `pnpm acceptance:recipe -- native-ui`（plan 066）：`acceptance:settings-native` 判定視窗框，以及另一個視窗在前時的焦點框與跨日；`acceptance:shortcut-native` 判定 Electron 真正的註冊被拒、最小化的真實視窗經 callback 還原並聚焦、關閉鍵與重開；`acceptance:player` 判定全螢幕蓋住螢幕、焦點交還設定視窗。這些畫面的其他行為由背景套件涵蓋，不需桌面 | 其截圖的外觀；全螢幕播放由維護者自行判斷 |
| 播放 | `pnpm acceptance:playback -- <檔案>` 驅動 QuickTime Player（[播放檢查](system-design/tooling.md#播放檢查)） | 案例要求時點擊播放器自身的控制項；聽感 |
| 延後退出通知 | `pnpm acceptance:quit-dialog -- --language <en 或 zh-TW>` 檢查簽章 fixture 的生命週期、送達事件，並透過輔助使用確認本輪恰有一則橫幅、文字為本輪語言（[引導式通知驗收](system-design/tooling.md#引導式延期退出通知驗收)） | 橫幅是否可見、可讀、未截斷 |
| Tray 選單：雙語的 idle、倒數與錄影選單、開始錄影、停止、取消錄影、第二次點擊、左鍵開啟選單、以鍵盤選「開啟 RecordStuff」與結束 RecordStuff | `pnpm acceptance:tray` 右鍵點擊真正的狀態列項目，把每個選單和正式 model 比對，並判讀 log 與資料夾（[Tray 驗收](system-design/tooling.md#tray-驗收)） | 截圖上的外觀、對齊與可讀性；needsPermission 選單（需撤銷權限）；狀態改變後才選的「開始錄影」，macOS 不讓腳本輸入排出這個順序。Computer Use 無法存取純 tray 的程序（`-10005 timeoutReached`，見 [033 的回合](verification/history-2026-09.md#plan-033-結案--2026-09-26)） |
| 長時間 start（plan 065）：一秒寬限內與寬限後按快捷鍵、寬限後左鍵點擊、starting 選單，以及 starting 期間結束 | `pnpm acceptance:tray -- --long-start <run>`，對象是以 `prepare=hold` 讓 start 停在 starting 的[受控建置](system-design/tooling.md#受控驗收-build)，依 log、資料夾、失敗紀錄與 starting 選單判定 | starting 選單截圖的外觀；真實擷取請求造成的長時間 start，任何建置都無法隨時重現 |
| 略過系統私密視窗選擇器的提示 | 刻意不提供 | 只能用 Computer Use，依[下方](#依影響追加案例)的例外 |
| VoiceOver、外觀與可讀性、主觀聽感、睡眠與喚醒 | 無 | 依各案例說明，由 Computer Use 觀察或維護者負責 |

維護者於 2026-10-02 允許已提交的 runner 在[下方](#依影響追加案例)的限制內操作 RecordStuff 自己的 Tray 選單、設定視窗與選單項目。沒有 runner 涵蓋的操作留在最後一欄。維護者為單一回合授權的臨時自動化（例如 [035 重做回合](verification/history-2026-09.md#plan-035-045049-之後的重做回合--2026-09-28)），不延伸到之後的回合。Tray runner 的點擊會移動真正的游標，所以它的回合仍需要桌面交接。

## 依影響追加案例

| 影響 | 觀察項目 |
| --- | --- |
| 排版／翻譯／外觀 | 相關語言、主題、最小尺寸、裁切與焦點；fixture 所代表環境的排版可用其截圖驗證，該環境與 App 共用視窗外框與尺寸；macOS 畫在頁面角落的視窗按鈕只出現在 `settings-shortcut -- --observe` 的截圖中 |
| 控制項／設定持久化 | 改動控制項的滑鼠及鍵盤操作，關閉重開與程序重啟後保存；還原偏好 |
| 原生設定入口 | 另一 App 在前景，透過受影響入口開啟設定，檢查可見／焦點、關閉與重開；腳本 callback 不足以證明。`pnpm acceptance:settings-shortcut -- --observe` 透過輔助使用涵蓋快捷鍵入口，`pnpm acceptance:tray` 涵蓋以鍵盤從選單選「開啟 RecordStuff」 |
| 品質／來源／輸出資料夾 | 從 UI 選取受影響選項，錄影並對照真正尺寸／fps／來源／存檔位置 |
| 錄影鎖定／允許的改動 | 錄影時操作受影響控制項，依需求確認鎖定或錄影持續；停止、存檔及播放 |
| 權限／裝置恢復／退出 | 只執行受影響或要求的轉移，記錄拒絕、恢復與適用的存檔；撤銷權限或破壞性故障前置需取得該操作授權 |
| 無障礙／OS 呈現 | 觀察受影響的鍵盤／焦點行為；需要 VoiceOver 或 OS 對比行為時須實際操作，DOM 斷言不能代替 |
| 倒數與 tray 狀態 | 預設 3 秒：先是沙漏，接著是沒有標題的碼錶與被錄影螢幕右上角的數字，最後是實心圓點加 REC；只有 REC 會改變選單列項目寬度。以第二次點擊、快捷鍵、「取消錄影」與「結束」分別取消：每次都回到 idle，且不留下檔案、失敗紀錄或通知（第二次點擊、「取消錄影」與「結束」由 `pnpm acceptance:tray` 執行，快捷鍵由 `pnpm acceptance` 執行）。持續超過一秒的 start（plan 065）也能以同樣方式取消：快捷鍵、左鍵點擊、「取消錄影」（starting 選單會標出其快捷鍵）或「結束」（立即退出）；一秒內的第二次按鍵會被忽略並寫入 log（`pnpm acceptance:tray -- --long-start`）。倒數期間文字編輯器保有鍵盤焦點，點擊會穿透數字。關閉時錄影不出現數字；10 秒時兩位數完整顯示。數字大小適合每個螢幕：為其短邊的 14%，直立螢幕與同一面板橫放時相同。倒數音效開啟時（預設），每個數字響一聲柔和的提示音，最後一聲升高五度，歸零或取消時不響；倒數為關閉時開關停用，倒數與錄影期間鎖定；播放檔案與 `pnpm acceptance` 都找不到提示音。是否聽得清楚、是否悅耳需以耳朵判斷。播放每個檔案並檢查 `pnpm acceptance` 的數字區域裁圖：數字從未出現在錄影中。在淺色、深色與照片內容上的可讀性，以及減少動態／透明度的變化，需以肉眼判斷 |
| 錄影失敗歷史（plan 047） | 一般開啟設定時，「錄影設定」與「一般」都不顯示歷史。「疑難排解」內有兩個內容頁籤：預設開啟的「失敗紀錄」，以及放診斷工具與獨立收合「重設與清理」的「診斷與清理」。滑鼠與方向鍵可切換內容頁籤，不改變側欄選擇；一般模型更新及內容頁籤切換保留清理區塊的展開狀態。並顯示未確認筆數，確認後數字清除；紀錄依日期分組、初始全部收合、各列獨立展開。「查看失敗紀錄」與錯誤通知會切到「疑難排解」的「失敗紀錄」內容頁籤，只展開最新一筆未確認紀錄，聚焦並捲入視野，但不自動確認。鍵盤焦點在某列時，以細強調色邊框框住整筆紀錄（1× 螢幕 1 px、Retina 1.5 px），點擊後或視窗不在前景時不顯示；每個分頁保留自己的捲動位置。兩種語言的視窗標題都是「RecordStuff」。「知道了」、移除與重試各寫一行含紀錄 ID 與結果的 log |
| 睡眠與保持喚醒（plan 050） | 倒數與錄影期間，`pmset -g assertions` 會列出 RecordStuff 的 `PreventUserIdleDisplaySleep` assertion；存檔、取消、失敗與結束之後就消失。錄影中從 Apple 選單選「睡眠」再喚醒：存下一般的 `.mp4` 且可以播放，沒有新增失敗紀錄，醒來後出現帶睡眠說明的存檔通知；倒數中睡眠則不存任何東西、也不顯示通知。喚醒需要維護者的密碼或 Touch ID，因此由維護者操作 |

不例行重設 TCC，不從其他案例推論首次權限、實體拔插、長時間穩定、安裝／升級或主觀聽感通過。唯一的窄例外（維護者於 2026-09-26 授權）：受測的 RecordStuff build 開始擷取時，macOS 可能詢問是否允許 RecordStuff 略過系統私密視窗選擇器，直接取用畫面和音訊。該回合的執行者可以透過原生 computer use 在這個提示按「允許」，並記錄 macOS 是否接受這個輸入。若 macOS 忽略模擬輸入，就讓提示保持開啟並回報，不要設法繞過。此例外只涵蓋 RecordStuff 的這個提示：不得回應其他權限提示、不得變更「系統設定」中的隱私權清單，也不得編輯 TCC。第二項決定（維護者於 2026-10-02 核准）：已提交的專案 runner 可以用 CoreGraphics 滑鼠與鍵盤事件及輔助使用動作，操作 RecordStuff 自己的 Tray 選單、設定視窗與選單項目。它們只作用於受測的 RecordStuff bundle（以執行檔路徑與 pid 比對）、runner 自己開啟的 Finder 與 QuickTime 視窗，以及測試素材；狀態列項目的選單以右鍵開啟，絕不使用 `AXPress`，因為那等於左鍵，會開始錄影。它們不回應權限提示、不開啟「系統設定」的隱私權清單、不編輯 TCC，全域 kill、關閉所有視窗，以及繞過原生 UI 的 IPC 或測試 hook 仍然禁止。桌面交接、鎖定、螢幕 assertion、單一執行者與收尾規則適用於每個這類 runner，執行者也不在已提交的 runner 之外臨時送出這類輸入。失敗保留重現步驟；授權修復後重建並重跑受影響案例，保留前次結果。

## 收尾與證據

每輪完整 App 驗收包含失敗／取消，都須保存自己開始的錄影、停止素材、還原偏好、關閉本次 UI、正常退出受測 App 並確認程序／helper 消失。讓 App 保持關閉供下次執行。不使用全域 kill／關閉所有視窗或刪除使用者資料。隔離 runner 只清理自己的程序；設定快捷鍵指令是中途入口，不是一整輪。

記錄播放器既有視窗，只關閉測試影片及關閉後新增的「打開」對話框。測試啟動的播放器，確認沒有使用者文件才退出。沒有 App 視窗不等於程序退出。不能確認保存或收尾時，記 cleanup fail／blocked 及殘留狀態，不覆蓋該程序重建，也不能宣稱完整驗收通過。

Agent 執行的回合也要在交還桌面前釋放本輪的 Computer Use session、測試頁籤與 REPL worker，依[工具收尾流程](../../.agents/skills/native-acceptance/SKILL.md#computer-use-工具收尾)執行。macOS 的 `pnpm acceptance:cleanup-audit -- --owned-pid <PID> --output <本輪目錄>/tool-cleanup.json` 以唯讀方式檢查可見的 `Software Cursor` 浮層與明確指定的本輪 PID（每個 worker 重複一次旗標）。Exit 0 表示該範圍清空，1 表示殘留（含 zombie），2 表示檢查受阻；省略 PID 只檢查已知游標浮層。它不關閉 session 或終止 App。保留共享服務及其他工作階段，另外回報未解決的工具收尾與基於歸屬的排除項；REPL reset 本身不能證明游標已消失。

使用 `docs/verification/measurements/` 下的獨立目錄，不覆寫前次結果。保存實際截圖、本次 log、媒體路徑及 runner 報告；工具無法存圖或聽音時如實記錄。原始資料已 gitignore，新 clone 無法取得。值得保留的結論寫進[驗證索引](verification/README.md)及其歷史／發布紀錄。團隊 review 需要證據時，透過約定且可存取的附件／artifact 位置提供去識別資料；不把本機連結當共享證據，也不自動上傳私人錄影。

## 報告範本

選定案例使用 pass／fail／blocked／not run；範圍外項目列在排除項，標 not applicable 並附理由。必要但豁免的案例仍為 not run。統計時不把排除項算通過。

```markdown
# 驗收 — <日期／範圍>

- 環境：OS／架構、螢幕、音訊輸出、瀏覽器／素材版本
- 來源／產物：SHA、工作樹變更、建置指令、bundle／程序路徑
- 執行方式：人工／computer use／腳本；執行者與選用案例
- 原設定與測試檔案：

| 案例 | 操作 | 預期 | 實際 | 狀態 | 證據 |
| --- | --- | --- | --- | --- | --- |

檢查：指令、退出碼、runner 報告位置；相關 skip
排除：案例 → 不適用及影響範圍理由
必要缺口：未執行／受阻案例 → 原因或明確豁免
收尾：保存檔案、還原偏好、關閉 UI、最終程序狀態；本輪 Computer Use session／worker 與游標檢查、未解決殘留或排除項
結論：通過／失敗／受阻／未執行數量，限於觀察範圍
證據可取得性：僅本機／可存取 artifact 位置
```

發布驗收另依[發布指南](system-design/releases.md)：記錄乾淨候選 SHA，預定 tag 綁定該 SHA，寫入版本證據摘要。後續文件 commit 不自動成為已驗 App 原始碼。本指南不授權發布。
