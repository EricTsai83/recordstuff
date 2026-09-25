# 驗證歷史 — 2026 年 9 月

[English](../../verification/history-2026-09.md) | [繁體中文](history-2026-09.md)

本頁保留原已完成計畫中的驗證結論，與正式 system design 分開維護。2026-09-14 文件整併時沒有重跑錄製，也沒有把本機結果推論到其他機器。原始計畫已移除，逐次變更可由 Git 歷史追溯。



[返回驗證索引](README.md)。以下是歷史證據，包含當時的未完成狀態與操作方式；現行選測規則見[測試指南](../testing.md)。原始 measurements 連結僅本機可用，新 clone 不會包含。


## Plan 044 結案 — 2026-09-26

plan 043 手動執行的鍵盤配置檢查，現在由 `pnpm acceptance:shortcut-layout` 自動化，由 Claude 實作、Codex GPT-6 Astra review（[鍵盤配置快捷鍵檢查](../system-design/tooling.md#鍵盤配置快捷鍵檢查)）。這項檢查防範 Electron 升級時 `LayoutAwareGlobalHotkeys` 被改名或移除。它選取一個已啟用、數字列不輸入數字的輸入法，並透過新的 [fixture](../../../scripts/fixtures/shortcut-layout.ts) 載入建置好的 `out/main/index.js`；這個 fixture 沿用 shortcut-failure 的 boundary 模式。接著以 System Events 對真正註冊的 `CommandOrControl+Control+Alt+Shift+7` 送出 key code，最後還原輸入法。測試指南的全域快捷鍵列與 Electron 列、設計決策的 Electron 升級觸發點，以及桌面設計，現在都指向這個指令。

- **只選取輸入法還不夠。** 從背景程序以 `TISSelectInputSource` 選取注音後，在觀察的 5 秒內鍵盤配置都停在 ABC。預設功能的 Electron probe 這時仍會觸發數字列 ⌘⌃⌥⇧7，所以只選取輸入法的檢查，會在 043 的 bug 存在時照樣通過。在 probe 自有視窗中聚焦一個文字欄位後，輸入法在 100 ms 內套用了 `com.apple.keylayout.ZhuyinBopomofo`。視窗關閉、probe 結束後配置仍然保留，預設功能的 probe 這時只觸發數字鍵盤。因此對輸入法，runner 會開這樣的視窗，最多等 8 秒讓配置套用後才繼續。
- **組成。**
  - [runner](../../../scripts/acceptance-shortcut-layout.mts) 負責前置檢查、桌面回合、輸入法、fixture 程序與報告。
  - [shortcut-layout.mts](../../../scripts/lib/shortcut-layout.mts) 包含 JavaScript for Automation 輔助程式（以 TIS 讀取與選取輸入法、以 CGEvent 讀取輸入的字元），以及輸入法選擇、還原紀錄、結果判定與其他 RecordStuff 程序的偵測。
  - 數字列沒有任何鍵輸入數字、且數字鍵盤 7 仍輸入 7 的輸入法才符合條件。已啟用的鍵盤輸入法依序嘗試，目前的輸入法排第一。
  - [shortcut-layout.test.ts](../../../scripts/lib/shortcut-layout.test.ts) 的 16 項測試涵蓋：配置判定；嘗試順序，包括指定了未啟用或不可選取的輸入法；切換後、部分失敗後與第一次查詢失敗後的還原；無法確認的還原；pass／fail／blocked 的優先順序，包括程序寫出通過結果後又卡住或崩潰；drill；以及程序偵測，包括 `pnpm dev` 的相對 entry。
  - 沒有新增 npm 依賴，共用的 shortcut-failure fixture 與 `acceptance-shortcut.mts` 都未修改。

執行環境為 M1 Pro、macOS 26.6.2、Node 24.21.0、Electron 44.3.0，從 ABC 開始。已啟用的輸入法為 ABC 與注音。最終版本上的結果：

- **通過。** `pnpm acceptance:shortcut-layout` exit 0，含建置約 7 秒（`2026-09-25T20-37-16-917Z-shortcut-layout`）：
  - ABC 因數字列輸入數字而略過；
  - 選取並聚焦啟用注音，其 ZhuyinBopomofo 配置的數字列輸入 ㄢ ㄅ ㄉ ˇ ˋ ㄓ ˊ ˙ ㄚ ㄞ；
  - 正式程式的 switch 為 `disable-features=LayoutAwareGlobalHotkeys`；
  - ⌘⌥, 觸發一次、數字列 7 觸發一次、數字鍵盤 7 未觸發；
  - ABC 已還原並確認。
- **Drill。** `-- --drill-layout-aware` exit 1（`…20-37-30-039Z-shortcut-layout-drill`）：觀察到的 `disable-features` 為 none，數字列 7 未觸發、數字鍵盤 7 觸發，ABC 已還原。
- **無法使用的輸入法。** `-- --source com.apple.inputmethod.TCIM.Cangjie`（已安裝、未啟用）在任何變更前以 exit 2 結束，`AppleSelectedInputSources` 不變。
- **SIGINT。** 分別在啟用視窗期間與 check 的數字鍵盤觀察期間中斷 runner。兩次都 exit 1，中斷當下注音都在使用中；ABC 已還原並確認，每個 Electron process group 都正常結束，沒有殘留的 fixture 程序。第二次的結果把數字鍵盤那一鍵標為 `not completed`。
- **其他 RecordStuff 程序。** 以 `pnpm dev` 相同的方式（本 checkout 的 Electron、entry 為 `.`）啟動 App 時，runner 在任何變更前以 exit 2 結束，並列出其 pid。
- **檢查。** `pnpm check` 通過（53 個檔案、882 項測試），`git diff --check` 無問題。修改過的文件中，相對連結與 anchor 都能解析。

較早的兩次執行發現了問題。Chromium 收到 SIGTERM 時會正常 quit，不會呼叫 fixture 的 Node handler，所以被中斷的 check 沒有寫出結果；現在 fixture 在正式程式 ready 後就註冊 quit observer。最初幾次的啟用執行也寫入了 Electron 共用的預設 profile，pass 1 隨後回報了這個問題。

依範圍未執行：`pnpm acceptance:regression`，因為共用 fixture 與 `acceptance-shortcut.mts` 未修改；錄影、matrix、通知與封裝，因為產品未變。這項檢查送出的是合成 key code，實體按鍵不在範圍內；043 由維護者回報的實體按鍵仍是硬體證據。Windows 不在範圍內。

清理：

- 每次執行後輸入法都回到 ABC，沒有殘留的 RecordStuff、fixture 或 probe 程序。
- 以 dev 方式啟動的 App 已結束。它使用真正的 userData 與 log，`settings.json` 不變（SHA-256 `0f892e19…`）。
- 注音輸入法現在記住 ZhuyinBopomofo 為它的配置；本 session 開始時回報的是 none。這是輸入法本身的狀態，任何人用它打字都會設定，不做還原。
- 開發用的 probe，以及修正 3 之前的啟用執行，寫入了 `~/Library/Application Support/Electron`；最終版本的執行沒有動到它。
- 本 session 執行了 `caffeinate -d -i -t 5400`。
- 依維護者要求，結案後已刪除 13 個本機報告目錄，從 `2026-09-25T20-27-24-582Z-shortcut-layout` 到 `2026-09-25T20-37-52-134Z-shortcut-layout`。本紀錄中的數據即為保留下來的紀錄。

Codex GPT-6 Astra 以 medium reasoning 執行，log header 確認為 read-only sandbox。pass 1 約 1.5 分鐘，回傳四項 Medium findings，全部接受並修正：

- 程序偵測漏掉以 `.` 啟動本 checkout Electron 的 `pnpm dev` 與 `pnpm preview`；
- 還原時第一次查詢失敗，就會跳過選回原輸入法；
- 啟用視窗使用了 Electron 的持久預設 profile；
- 判定忽略 supervisor 的結果，所以在卡住、崩潰或被強制結束之前寫出的通過結果可能被算為通過。

pass 2 約 1 分鐘，沒有 findings。30 分鐘的 review 預算用了約 2.5 分鐘，沒有使用 fallback。工作尚未 commit，沒有 push 或發布。

## Plan 043 結案 — 2026-09-26

全域快捷鍵改為依實體鍵位註冊，由 Claude 實作、Codex GPT-6 Astra review（[錄影快捷鍵](../system-design/desktop.md#錄影快捷鍵)、[設計決策](../system-design/decisions.md)）。問題是在 plan 032 的原生回合發現的：啟用注音時，預設的 ⌘⇧1 會被綁到數字鍵盤。Chromium 152 預設啟用 `LayoutAwareGlobalHotkeys`，會依目前配置找出輸入該字元的鍵來註冊，而 ZhuyinBopomofo 配置在數字列輸入注音符號。另一方面，快捷鍵編輯器記錄的是實體鍵位，並且拒絕數字鍵盤。Cap（`40f44a8`、`global-hotkey` 0.7.0）則是註冊固定的實體 key code。

- **變更。** macOS 上，main 會在 app ready 之前設定 `disable-features`。這個值由 [hotkey.ts](../../../src/main/hotkey.ts) 的 `physicalHotkeyFeatures` 算出：
  - 把 `LayoutAwareGlobalHotkeys` 附加到命令列上已有的清單，因為 Chromium 對重複的 switch 只保留最後一個值；
  - 清單已含此功能時不變，不論有沒有 field-trial 後綴；
  - 其他平台不做任何事。

  三項測試涵蓋平台判斷與各種合併情況。桌面設計與新增的設計決策列記錄了實體註冊、已接受的取捨（非 QWERTY 拉丁配置下，字母快捷鍵依 US 位置），以及每次升級 Electron 都要重做的確認。工具指南不再要求 ABC 輸入法。
- **修改前。** 在 Electron 44.3.0、啟用注音（ZhuyinBopomofo）的環境下，repository 外的 probe 註冊 ⌘⇧1、⌘⌥⇧R 與 ⌘⌥,，再以 System Events 送出按鍵：
  - 預設設定下，數字列 ⌘⇧1（`key code 18`）不觸發，數字鍵盤 `key code 83` 會觸發。
  - ⌘⌥⇧R 與 ⌘⌥,（`key code 43`）都會觸發：這個配置沒有任何鍵輸入 r 或逗號，所以兩者都退回固定位置，設定快捷鍵因此不受影響。
  - 停用此功能後，數字列 ⌘⇧1 會觸發、數字鍵盤不再觸發，另外兩個仍會觸發。
- **檢查**（最終版本，Node 24.21.0）：
  - `pnpm acceptance:regression` 通過：`pnpm check`（型別檢查、52 個檔案的 866 項測試、建置）、Settings 113/113，以及清理完整的快捷鍵失敗整合測試。
  - `pnpm exec vitest run src/main/hotkey.test.ts` 通過 16 項測試。
  - `git diff --check` 無問題。

原生回合在 M1 Pro、macOS 26.6.2 上執行，版本為 `867b1c3` 加上未提交的變更；回合期間選用注音，結束後還原維護者原本的 ABC 輸入法：

- **`pnpm acceptance:updates`** 以 exit 0 結束，11 個必要案例全數通過。Fixture 從數字列 key code 記錄到四次 `hotkey: CommandOrControl+Shift+1 pressed`，這正是 plan 032 第二次執行時逾時的案例。兩段錄影分別為 10.7 秒與 10.9 秒、1920×1080、48 kHz 立體聲 −27.4／−26.6 與 −26.7／−27.5 dB，閃光／提示音配對 11/11 與 10/10、偏移 71 與 56 ms，所有受判定的完整性檢查都通過。
- **設定快捷鍵。** 全新的 `pnpm start:app` bundle 註冊了維護者的 ⌘⇧1 與 ⌘⌥,，`pnpm acceptance:settings-shortcut` 也收到了設定 callback。
- **播放。** Codex GPT-6 Astra 以 computer use 在 QuickTime 播放 `2026-09-26 03-44-04.mp4`，從 00:00.000 播到 00:06.856，素材持續變化；之後關閉影片、取消「打開」對話框並結束 QuickTime：7 項 pass（只有工具觀察，沒有本機 PNG）。
- **權限提示。** 錄影中再次出現 macOS 要求允許 RecordStuff 略過系統私密視窗選擇器的提示。維護者要求按下允許，但沒有用自動化點擊：它會授予擷取權限，macOS 預期由人親自回應。

實體按鍵，由維護者回報。回合結束後，維護者以 `pnpm open:app` 開啟修正後的 bundle，用實體數字列 ⌘⇧1 在注音與 ABC 下各開始並停止一次錄影，回報一切正常。App log 相符：19:55 UTC 有兩組 `hotkey: CommandOrControl+Shift+1 pressed` 的開始／停止，並存下兩個檔案。log 不會記錄輸入法，所以配置部分依據維護者的回報。本 session 修正之前，維護者曾在未修正的 bundle 上按了七次 ⌘⇧1；當時的輸入法不明，而且 plan 032 的切換讓配置 override 停在 ABC，所以那些按鍵無法說明 Bopomofo 配置下的行為。沒有原生案例轉交 035。

依範圍未執行：matrix、長時間錄影、通知、`--full`、Windows，以及另外一輪 `pnpm acceptance`。以 QWERTY 為基礎的配置下，字母快捷鍵兩種方式得到相同的 key code，probe 已經涵蓋。

清理：回合開始前，維護者原本開著且處於 idle 的 bundle 已正常結束，回合後維持關閉。沒有殘留 RecordStuff、fixture、素材瀏覽器或 QuickTime 程序。`settings.json` 在回合前後不變（SHA-256；內容包含維護者自己選的 ⌘⇧1），輸入法也已恢復為 ABC。結案後依維護者要求刪除了本輪測試產物：`2026-09-25T19-41-04-951Z-settings-acceptance`、`2026-09-25T19-41-41-911Z-shortcut-failure`、`2026-09-25T19-42-49-815Z-updates-fXb6e9`（含兩段錄影）、`2026-09-25T19-45-31.612Z-settings-entry-CVoYIJ` 與 `2026-09-25T19-46-25Z-plan043-computer-use`，以及維護者在 ~/Movies/RecordStuff 的六段手動測試錄影（`2026-09-26 03-18-39` 到 `03-55-45`）。本紀錄中的數據即為保留的紀錄。

Codex GPT-6 Astra（medium reasoning，log 開頭確認為 read-only sandbox）約 74 秒完成第 1 個 pass，沒有發現實作問題：啟動順序、acceptance 插樁、平台判斷與合併邏輯都符合契約。它回報一項 Low 等級的文件 finding，已接受。桌面設計原本寫著：依實體鍵位註冊後，`pnpm acceptance` 送出的每個鍵在任何輸入法下都能觸發快捷鍵；但 runner 以字元送出字母，在 Dvorak 或 AZERTY 下會按到別的鍵。該段中英文版現在已區分 key code 送鍵與字母；runner 的對照方式仍不在範圍內。這是一句文件修正，不需要第二個 pass。30 分鐘 review 預算約用 1.5 分鐘，未使用 fallback。本輪已在本機 main 分成數個 commit：修正 `96057a9`、設計文件 `29f5268`，以及本結案 commit。沒有 push 或發布。

## Plan 032 結案 — 2026-09-26

更新驗收的設定鎖定契約（R2-06），由 Claude 實作、Codex GPT-6 Astra review（[更新功能驗收](../system-design/tooling.md#更新功能驗收)）。Runner 的 `assertNoUpdateActions` 假定錄製中只有語言可用；修改前把同一個檢查套用到真正的錄製中 `settingsView`，會在 `settings group appearance` 失敗。

- **契約。** 改由 [update-acceptance.mts](../../../scripts/lib/update-acceptance.mts) 的 `assertLockContract` 判定。預期行為取自 `BUSY_SETTINGS_POLICY`，依桌面設計撰寫，而不是複製模型的旗標。Starting、錄製與儲存中會鎖定螢幕、畫質、解析度上限、影格率、快捷鍵、通知、啟動檢查與更新 action 群組，以及 tray 的變更輸出資料夾；語言、外觀與 About 逐一選項都維持可用。Idle 與兩種權限狀態下所有群組解鎖。只有 recording 要求 REC 與一個可用的 Stop；Stop 依 action 尋找，所以狀態行前面的失敗紀錄不會影響位置。Starting 與儲存中要求 `…`、沒有 Stop，tray 也永遠不含更新項目。設定群組不在政策表中，或表中群組已不再提供，都會失敗。Runner 對兩個錄製中 snapshot 及其前後的 idle snapshot 套用此契約。[桌面設計](../system-design/desktop.md#tray-與通知)的狀態表原本在忙碌狀態寫「只有語言」，已同步修正雙語版本。
- **第二個過時期望。** 第一次必要執行更早就在重啟案例失敗：它預期 zh-TW 面板標題為 `設定`，但自 `b262188`（2026-09-24）起標題 key 是 "RecordStuff - Settings"（`RecordStuff - 設置`）。Runner 改為比對該 key 的正式翻譯，檢查的是語言而不是文案。
- **測試。** `scripts/lib/update-acceptance.test.ts` 新增 7 項測試，以正式的 `settingsView` 與 `trayModel` 建立 snapshot：
  - 英文與繁中各在六種更新狀態下錄製，包含已提供更新；
  - 八個鎖定群組在 starting、錄製與儲存中分別被錯誤解鎖；已提供的下載 action 本身是可用的，只靠群組鎖定才無法使用；
  - 語言、外觀與 About 被整組或單一選項鎖定；
  - 未分類的群組與被移除的群組；
  - 錄製中缺 REC、缺 Stop 或 Stop 停用、變更資料夾可用、出現更新項目，以及失敗紀錄排在最前面；
  - Starting 與儲存中出現 REC 或 Stop；
  - Idle 與兩種權限狀態要求所有群組解鎖，同時容許因自身原因停用的選項（檢查進行中、螢幕不存在、未驗證的影格率）。
- **檢查**（最終版本，Node 24.21.0）：`pnpm exec vitest run scripts/lib/update-acceptance.test.ts` 通過 1 個檔案的 15 項測試；`pnpm typecheck` 通過；runner 程式庫在 Node type stripping 下可載入；`git diff --check` 無問題。

原生 `pnpm acceptance:updates`（預設 smoke 範圍，未使用 `--logic-only`）的執行環境：M1 Pro、macOS 26.6.2、Node 24.21.0、Electron 44.3.0，版本為 HEAD `7ceb83a` 加上未提交的變更。主螢幕 1920×1080，系統音訊輸出到外接耳機、音量 69，測試素材 SHA-256 `e631b973…`。每次執行都自行建置並簽章 fixture。

- **第 1 次**（18:56 UTC）在重啟案例因上述過時標題失敗。
- **第 2 次**（18:58 UTC）通過擷取前的六個案例，包含修正後的標題。第一段錄影沒有開始：送出 System Events 快捷鍵 30 秒後，App 沒有記錄任何按鍵。當時的輸入法是注音，其鍵盤配置 `com.apple.keylayout.ZhuyinBopomofo` 的數字列輸入注音符號。在 repository 外以 Electron 探測：合成的 `key code 18`（數字列 1）從未觸發已註冊的 ⌘⇧1、⌘⇧2、⌘⌥⇧1 或 ⌃⇧1；`keystroke "1"` 與 `key code 83`（數字鍵盤 1）會觸發，字母組合以 key code 送出也會觸發。切換到 ABC 後，`key code 18` 可以觸發。另以一份 TextEdit 文件確認 System Events 送鍵有效（收到全形 `ｑ`），該文件未存檔即關閉。
- **第 3 次**（19:04 UTC）在回合期間選用 ABC，結束後恢復注音。結果 exit 0，全部 11 個必要案例通過，包含檢查此契約的錄製段。兩段錄影分別為 10.7 與 10.9 秒、1920×1080、48 kHz 立體聲 −27.4／−27.4 與 −26.7／−27.5 dB，閃光／提示音配對皆 10／10、偏移 65 與 61 ms，所有受判定的完整性檢查都通過。兩段錄影的素材中央都有 macOS 未回應的提示，要求允許 RecordStuff 略過系統私密視窗選擇器；fixture 結束後提示關閉，沒有授予任何權限。原生 Tray 點擊、可見瀏覽器與主觀聽感不在此 runner 範圍，報告一如往常列為 blocked。
- **播放。** Codex GPT-6 Astra computer use 在 QuickTime 播放 `2026-09-26 03-06-12.mp4`，從 00:00.000 到 00:10.890，期間素材計時、捲動文字與移動方塊持續變化。隨後關閉影片、取消「打開」對話框並結束原本未執行的 QuickTime：8 項 pass。只有工具觀察，沒有本機 PNG；取樣畫面未捕捉到閃光方塊亮起。

這些斷言透過插樁 fixture 檢查正式的 handler、tray 模型與設定模型，不是原生選單畫面、tray 點擊或瀏覽器傳輸。依範圍未執行：`--full`，因為 feed 篩選與逾時未改；另外的一般錄影回合與 `pnpm check`，因為沒有修改 App 原始碼。

每次執行後都沒有殘留 RecordStuff、Electron fixture 或素材瀏覽器程序，`settings.json` 前後 SHA-256 相同，輸入法也已恢復為注音。結案後依維護者要求刪除了本輪測試產物：三個執行目錄 `2026-09-25T18-56-39-131Z-updates-uHM73o`、`2026-09-25T18-58-43-277Z-updates-n7BlXk` 與 `2026-09-25T19-04-59-492Z-updates-YWKqze`（含兩段錄影），以及播放報告 `2026-09-25T19-07-04Z-plan032-computer-use`。本紀錄中的數據即為保留的紀錄。

發現但未修正：若輸入法的數字列不輸入數字，預設快捷鍵 ⌘⇧1 在*實體*數字列上可能也無法觸發 RecordStuff。本次只測過合成事件。之後由 [plan 043](#plan-043-結案--2026-09-26) 修正。沒有原生案例轉交 035。

Codex GPT-6 Astra（medium reasoning，log 開頭確認為 read-only sandbox）約 50 秒完成第 1 個 pass，沒有 findings。它列出了三個 script、雙語設計／工具／驗證文件、兩份 plan 索引與已刪除的 plan 檔，共 15 個變更檔案。不需要第二個 pass。30 分鐘 review 預算約用 1 分鐘，未使用 fallback。本輪已在本機 main 分成數個 commit：runner 修正 `bcff30f`、設計文件 `350627c`，以及本結案 commit。沒有 push 或發布。

## Plan 031 結案 — 2026-09-26

正式版下載指標不再倒退，由 Claude 實作、Codex GPT-6 Astra review（[發布自動化](../system-design/releases.md)）。R2-04 audit 曾在暫存 checkout 以真正的 record CLI 先記錄 0.1.4、再記錄 0.1.3，結果 package.json 停在 0.1.4，正式版 manifest 與兩份 README 下載區塊卻回到 0.1.3。

- **指標依據。** `release.mts record` 在取得候選版本前先讀取並驗證已提交的 `website/release-manifest.json`，再以語意化版本比較經驗證的候選版本。較新版本為 promoted：manifest 與兩份 README 區塊來自同一份 snapshot。版本相同且發布身分與資產事實一致（即 `pnpm site:manifest verify` 比對的欄位）時為 unchanged：已提交的 manifest 保持原本 bytes（含 `verifiedAt`）。任何差異都在寫檔前失敗並列出欄位。較舊版本為 historical only，只補上缺少的驗證紀錄。package.json 維持原本規則：前進到較新的已記錄正式版、永不倒退，與指標分開判定；預發布版仍只寫歷史紀錄。基準缺少、無法讀取或格式錯誤（包括帶預發布 tag）時，在寫任何檔案前停止並提示 `pnpm site:manifest generate vX.Y.Z`。沒有新增隱含的 bootstrap：repo 已有基準，而且這個明確指令已存在。只寫入內容有變的檔案，輸出寫明結果與檔案。
- **真正 CLI 測試**在暫存 checkout 中以固定的 gh 與網路回應執行（`scripts/release-record.test.ts`，19 項）：0.1.3 → 0.1.4 promotion，以及不改任何檔案、保留人工證據的 idempotent 重試；R2-04 的順序（先 0.1.4、後 0.1.3）讓指標與 package.json 維持 0.1.4、補上 0.1.3 紀錄，重跑不改任何內容；重新記錄已提交的版本；同版在 source commit、DMG digest 與 DMG 大小上的衝突；預發布版；package.json 超前 manifest（promotion 不動它）與落後（promotion 或較舊的 record 讓它前進）；基準缺少、非 JSON、格式錯誤與為預發布版；source commit 不符；任一語言 README 缺少標記；以及候選 package 版本下的離線 README 檢查。每個失敗案例都斷言 package.json、兩份 README、manifest 與兩個紀錄目錄維持不變。以修改前的 `release.mts` 執行時，19 項中有 12 項失敗，包括先 0.1.4 後 0.1.3 的順序。
- **檢查**（最終版本，Node 24.21.0）：`pnpm exec vitest run scripts/release-record.test.ts scripts/release.test.ts` 2 個檔案 33 項測試通過，含已提交的 1.0.0 manifest 與兩份 README 的離線一致性檢查；`pnpm typecheck` 通過；`git diff --check` 無問題。
- **依範圍未執行：**App 建置、錄影、DMG、網站檢查、線上發布與部署，因為 App、網站、共用 manifest 模組、workflow、簽署與打包程式都沒有變更。GitHub Actions 的 record job 本身沒有執行；workflow 未變，historical-only 的正式版 record 仍會執行 `deploy-website`，重新部署未變的指標。

Codex GPT-6 Astra（medium reasoning）第 1 輪費時 49 秒，無 findings；它列出了程式、測試、雙語文件、計畫索引與已刪除的計畫檔。CLI 回報的 sandbox 是 workspace-write 而非 read-only；prompt 禁止修改，review 前後 diff 相同。之後 review skill 已加上 `--sandbox read-only`，resume 時也重複指定 model，因為不帶參數的 resume 會改用設定檔的預設 model（`4815f70`）。review 後修正了一則程式註解與兩份發布設計文件各一句：已提交的 manifest 是在取得 release 之前讀取，而不是在任何網路請求之前，因為先解析 tag 指向的 commit。行為沒有改變，因此沒有執行第二輪。30 分鐘 review 預算約用 1 分鐘，未使用 fallback。

檢查發布文件時發現 delivery.md、tooling.md 與繁中發布契約的網站觸發清單不完整，漏了 website.yml 自 `dd29e1f` 起就監聽的共用 manifest 模組，已一併修正。本輪以範圍分開的 commit 提交在本機 main：record 修正與測試 `67ffb32`、發布設計 `3c77897`、網站觸發條件 `9dadaae`、review skill `4815f70`，以及本結案 commit。沒有 push、tag 或發布。

## Plan 041 結案 — 2026-09-26

以設定的幀率擷取，由 Claude 實作、Codex GPT-6 Astra review（[幀率要求](../system-design/recording.md#幀率要求)、[影格節奏診斷](../system-design/tooling.md#影格節奏診斷)）。在此之前，每段錄影的影格都比設定少約 2%（30 fps）或 4%（60 fps），而且沒有掉格。

各輪環境：M1 Pro（10 核、32 GB）、macOS 26.6.2、Node 24.21.0、Electron 44.3.0／Chromium 152.0.7977.78、ffmpeg 9.0.1；主螢幕為 BenQ 1920×1080、60.00 Hz（Electron `displayFrequency` 60）；系統音訊輸出到外接耳機，音量 94；測試素材 SHA-256 `e631b973…c41459`；版本為 HEAD `86ecbc5` 加上未提交的變更。每次診斷與 matrix 都自行建置 `out/`。

- **分類：(A) 來源下限。** `pnpm diagnose:cadence` 經由正式的 capture host 錄製素材，並在 MediaRecorder 之前為 video track 送達的每個影格記下時間戳。舊要求 `{ ideal: N, max: N }` 的四次 30 秒錄影送達 29.42／29.36 fps（間隔中位數 33.90／34.00 ms）與 57.78／57.22 fps（17.20／17.30 ms）。track 每次丟棄 1–4 格（最多 0.45%）；檔案 pts 的中位數與送達時間戳相差不到 0.05 ms；`getSettings().frameRate` 全程回報 30 或 60。加上八個忙碌程序後偏差仍在（29.46 與 57.62 fps，分布更集中）。Chromium 的 ScreenCaptureKit 裝置把要求當成最小影格間隔，因此每個間隔都是這個下限再加上交付延遲。間隔分布沒有先前保留的檔案看起來那麼緊：30 fps 約 17% 的間隔短於週期的 99%（時間戳是到達時間，會抖動），但沒有任何兩倍間隔，中位數仍長約 0.6 ms。
- **候選（每種幀率各兩次）。** 只給 `{ ideal }` 與舊要求相同（29.29 與 57.01 fps），因為 Chromium 的裝置幀率與 track 限速器都由它決定。30.6／62.4 達到 29.99 與 59.70／59.86 fps，但 30 fps 中位數為 33.60／33.70 ms，落在 1% 邊界。30.3／62.5 的下限是 33 與 16 ms，即週期無條件捨去到整數毫秒；它達到 29.96／29.92 與 59.80／59.82 fps，中位數為 33.37–33.40 與 16.72–16.77 ms，30 fps 的分布也最集中。`ffmpeg mpdecimate` 在所有 60 fps 錄影中都沒有找到重複影格；對重新取樣到 120 fps 的片段，它會標出約一半的影格。**採用：** 以 30.3／62.5 作為 `CAPTURE_FRAME_RATE`，由 `getDisplayMedia` 與解析度上限的 `applyConstraints` 以 `{ ideal, max }` 送出。位元率目標、log 裡的 requested fps、驗證與降級規則仍以設定值為準。
- **改動前後**（`pnpm matrix`；改動前使用 HEAD 的要求，改動後使用本次變更；改動前的 long 已經顯示新的中位數欄位）：

| 案例 | 改動前 | 改動後 |
| --- | --- | --- |
| fps，30 fps ×2 | 29.39／29.34 fps，無掉格，CPU 13%，offset 63／87 ms | 29.86／29.93 fps，中位數 33.47／33.37 ms，無掉格，CPU 13%，offset 56／97 ms |
| fps，60 fps ×2 | 57.86／57.01 fps（**fail**），掉格 0.12%／1.10%，CPU 22／20%，offset 86／77 ms，31.4／30.9 Mbps | 59.96／59.95 fps（pass），中位數 16.70／16.74 ms，掉格 0.50%／0.28%，CPU 21／22%，offset 82／92 ms，32.6 Mbps |
| quick ×3 | 29.29–29.35 fps，無掉格，CPU 13–14%，offset 72–97 ms | 29.92–29.94 fps，中位數 33.42–33.43 ms，無掉格，CPU 13–14%，offset 76–87 ms |
| long，180 秒 | 29.44 fps，中位數 33.83 ms，無掉格，CPU 14%，offset 70 ms，drift 3 ms | 29.90 fps，中位數 33.47 ms，無掉格，CPU 14%，offset 83 ms，drift 1 ms |

  改動後每個案例都配對為 `matched`，通過聲道能量（−27.1／−27.1 dB）與位元率（30 fps 為 100–101%），並 exit 0。改動後的診斷結果一致：29.96／29.90 與 59.80／59.68 fps；60 fps 兩次的檔案各有 14 與 12 個兩倍間隔，改動前為 1–18。Go criteria 全數成立：平均在 30 的 0.5 fps 與 60 的 1 fps 內，中位數在週期的 1% 內，掉格低於 2% 且落在改動前的範圍內，CPU 差距在 3 個百分點內，offset、drift、能量與位元率都在門檻內。`THRESHOLDS` 沒有更動。
- **錄影 smoke。** 以新的 `pnpm start:app` bundle、使用者原本的 60 fps 設定執行 `pnpm acceptance`，錄到 10.3 秒 1920×1080：track 62.5 fps，實測 59.78 fps（完整性層級不判定），48 kHz 雙聲道 −27.2／−27.2 dB，10 次閃光與 10 次短音，可完整解碼；報告 `2026-09-25T16-33-55-153Z-hotkey-acceptance`。log 沒有降級通知。Codex GPT-6 Astra 以 computer use 在 QuickTime 播放該檔：從 0.05 秒播到 7.07 秒，素材持續在動；以輔助使用把時間列設到 8.0 秒後續播到 10.32 秒片尾；接著關閉影片、取消 Open 對話框，並退出原本未執行的 QuickTime。結果 5 pass、1 blocked：工具的裁切畫面找不到時間列的位置，無法以滑鼠拖曳（只有工具觀察，沒有本機 PNG；`2026-09-25T16-38-23Z-computer-use`）。

自動化證據：最終版本的 `pnpm check` 通過 typecheck、52 個檔案的 844 個測試與 build。新增測試涵蓋 constraint builder（30.3／62.5；高於設定值，但週期差不到 1 ms，且低於下一個設定值）、降級規則以設定值而非要求值判斷（62.5 與 59.8 不算降級、30 仍算、30 fps 設定永遠不算）、capture host 在 `getDisplayMedia` 與 `applyConstraints` 都送出要求值而編碼目標仍以 60 fps 計算、`frameStats` 的間隔中位數，以及節奏統計、計數窗口與分類（包含 tap 漏格的情況）。

未驗證：解析度上限的 `applyConstraints` 路徑的原生行為（沒有接上大於上限的螢幕）、60 Hz 以外的螢幕、其他 Mac 與其他 Chromium 版本。要求值保留的餘裕是依本機延遲調整的；在更高更新率的螢幕上，60 fps 錄影可能略高於 60。沒有原生案例移交 035。

Codex GPT-6 Astra（medium reasoning、read-only）第一輪花了 131 秒，對診斷工具提出兩項 Medium finding，皆接受並修正；它認為產品端的要求值、位元率、降級與 verify 變更符合計畫。(1) renderer 的影格 tap 在讀取端卡住時可能漏格，runner 會把觀察端的損失誤判為來源變慢，而且仍然 exit 0：現在若 tap 看到的影格少於檔案的 99%，結果為 `undetermined` 並 exit 1。已記錄的 20 次錄影中，tap 看到的影格都不少於檔案，因此這些分類仍然成立。(2) 收到 SIGTERM 時，忙碌程序、經由 `open` 啟動的 fixture 與素材瀏覽器都會留下：現在由一個可重複呼叫的 cleanup 在 SIGINT 或 SIGTERM 時精準停止本輪自己的程序。在帶兩個忙碌程序的實際錄影中，它沒有留下任何程序，分別以 130 與 143 結束。第一次 SIGINT 測試曾發現 handler 完成前，本輪仍可能寫出 summary 並先 exit 1，因此現在收到訊號後本輪就停止前進。驗證修正時還發現，10 秒錄影把啟動時的 4 次丟棄（1.3%）算進去，被分類為 `track-limiter`；現在計數從 recorder 開始後的第一個取樣起算，重跑後兩種幀率都是 0 次丟棄與 `on-time`。修正後的第二輪花了 81 秒，提出一項 Medium finding，已接受並修正：若訊號剛好在本輪正常收尾、等待 Chrome 或 Electron 結束時抵達，本輪仍可能先寫出 summary 並 exit 0；現在等待結束後會再檢查一次是否已中斷。修正後在最後一次錄影結束時送 SIGTERM，以 143 結束，沒有寫 summary，也沒有殘留程序。review 已達兩輪上限，這最後一項修正沒有再經過 review。30 分鐘的 review 預算用掉約 3.5 分鐘，不需要 fallback。

每輪結束後都沒有殘留的 RecordStuff、Electron 或素材瀏覽器程序，`settings.json` 前後相同（SHA-256）。本輪的測試產物已依維護者要求在結案後刪除：~/Movies/RecordStuff 的 17 支錄影（`2026-09-25 23-54-18` 到 `2026-09-26 00-34-00`）、十四個 `*-frame-cadence` 目錄、上文提到的 hotkey acceptance 與 computer-use 報告、`2026-09-26.md`／`.json`，以及 `2026-09-25.md`／`.json` 中本輪的段落（plan 030 的段落保留）。本紀錄中的數字即為保存的結果。本輪已在本機 main 上依範圍分開 commit：擷取 `249323f`、工具 `6f555d2`、設計文件 `d2e584c`，以及這個結案 commit。沒有 push 或發布。


## Plan 030 結案 — 2026-09-25

音訊與同步證據（R1 bug 8、R2-05），由 Claude 實作、Codex GPT-6 Astra review（[量測工具](../system-design/tooling.md#量測工具)、[門檻與判定](../system-design/tooling.md#驗收門檻)）。

- **判定。** 每個檢查為 pass、fail、blocked、incomplete 或 n/a。整體依序為 fail、blocked、incomplete、pass，其餘 n/a；`pnpm verify` 與 `pnpm matrix` 在 fail 或 incomplete 時 exit 1、blocked 時 exit 2，其餘 0。快捷鍵與更新驗收把 blocked 與 incomplete 視同 fail。
- **由呼叫端宣告必要證據。** matrix 要求聲道能量與同步標記，`pnpm verify` 要求能量、帶 `--sync` 時也要求標記，`pnpm acceptance` 要求能量，更新驗收兩者都要求。缺 ffmpeg／ffprobe 時，matrix 與快捷鍵驗收在錄影或送鍵前就 blocked。資訊性報告維持 n/a 並附原因，絕不算 pass。
- **格式與能量分開。** 「Sample rate/channels」依串流 metadata 判定 48 kHz 立體聲；「Channel energy (RMS)」需要兩個有效且高於 −60 dBFS 的數值。靜音、缺少或多出的聲道、NaN 或 +∞、工具錯誤與沒有音軌都判 fail。JSON measurement 以 `measured` 加值，或 `not-requested`、`unavailable`、`error` 加原因保存能量與同步；`syncAttempted` 已移除。
- **標記覆蓋。** 沿用既有常數：偏移需要 `MIN_SYNC_PAIRS`（3）組配對；要求或實測至少 120 秒的錄影，前 60 秒與後 60 秒還須各有 3 組配對才能判定漂移；較短的檔案沒有漂移可判定。不足時會指出原因（沒有閃光、沒有短音、配對太少、缺一端窗口）。沒有更動任何門檻。
- **media-tools 邊界。** 只有 exit 0 的執行才算量測：非 0 結束或被 signal 終止、ffprobe JSON 格式錯誤，或 astats 回報的聲道數與串流不符，都是附 stderr 最後幾行的 MeasurementError，部分輸出一律捨棄。只有檔案有音軌時才執行 astats。

自動化證據：最終 `pnpm check` 通過 typecheck、51 個檔案共 830 項測試與 build；`git diff --check` 無誤，每個修改過的 runner 都能在 Node type stripping 下載入。分析器測試涵蓋 R1-8 的純 metadata 重現、各種能量狀態、沒有閃光、沒有短音、兩者皆無、配對太少、只有頭或只有尾的長檔、被截短的長案例、無效的偏移與漂移、超標的偏移與漂移、有效的短與長樣本、未要求／blocked／失敗的同步、資訊性報告、R2-05 重現（其餘全部有效、要求同步但沒有配對：現在為 incomplete、exit 1）、判定優先序、退出碼，以及文字與 Markdown 標記。整合測試以 ffmpeg 產生立體聲媒體（兩聲道都有音、全靜音、單聲道靜音、截斷的 fragmented 檔、無法讀取的位元組），執行 `verifyRecording` 與真正的 `pnpm verify` CLI；以自訂 PATH 的子程序模擬缺 ffmpeg（blocked、exit 2）、缺 ffprobe（exit 2）、印出一個聲道 RMS 後 exit 1 的 ffmpeg，以及 exit 0 但只回報兩聲道之一的 ffmpeg（皆 fail、exit 1）。另有子程序在沒有 ffmpeg 時執行真正的 matrix CLI：建置前即 exit 2。對保留錄影 `2026-09-25 16-31-41.mp4` 隱藏 ffmpeg 時，HEAD `fc40cad` 判 pass（exit 0，「RMS not measured」），本次變更回報能量 blocked（exit 2）；工具齊全時量到 −27.2／−27.2 dB 與 10 組配對、83 ms。

原生：M1 Pro（32 GB）、macOS 26.6.2、Node 24.21.0、Electron 44.3.0、ffmpeg 9.0.1，HEAD `fc40cad` 加上未提交的變更，主螢幕 1920×1080，系統音訊輸出到外接耳機、音量 94；每輪 matrix 都自行建置 `out/` 並錄製未打包的 App。

- `pnpm matrix -- quick` 於 147 秒後 exit 0。1440p Standard、1440p High 與 Source Standard 各錄約 30.0 秒、1920×1080，配對為 `matched`，兩聲道 RMS 為 −27.1 至 −27.2 dB，配對數 29、30、30，偏移 68、99、99 ms，30 fps 在容差內、沒有掉幀，CPU 13–14%。短案例的漂移為 n/a。
- `pnpm matrix -- long` 於 223 秒後 exit 0：180.01 秒、`matched`、RMS −27.1／−27.1 dB，179 組配對，頭窗口 59 組（71.9 ms）、尾窗口 60 組（73.2 ms），漂移 1.3 ms，29.38 fps，沒有掉幀，CPU 13%。
- 隔離的缺標記案例：把閃光框固定為黑色的素材副本（SHA-256 `56066784…12805b`，只差這條規則），以獨立 Chrome kiosk 開啟，執行 `pnpm matrix -- quick --no-open-material`。整輪 153 秒後 exit 1。每個案例量到 0 次閃光與 29–30 個短音，RMS −27.1／−27.1 dB，影格時序通過，只有偏移為 `incomplete`（「no flashes found」），並列在該輪的「cases that did not pass」段落。該素材 Chrome、其 profile 與 Electron 都已結束。
- 播放：Codex GPT-6 Astra computer use 在 QuickTime 播放 `2026-09-25 23-06-14.mp4`，由 00:00 前進到 00:17.8；長檔由 00:00 前進到 00:11.4，把時間列移到 02:50.4 後再前進到 02:56.3，畫面中的素材都在移動；兩個檔案關閉後沒有殘留「打開」視窗，並正常退出原本未執行的 QuickTime。它的快照只拍到暗的標記框，所以閃光本身以偵測器的 179／179 為證據；沒有保存本機 PNG（僅工具觀察；`2026-09-25T15-15-35Z-computer-use`）。

每輪結束後都沒有殘留 Electron、RecordStuff 或素材瀏覽器程序，`settings.json` 前後的 SHA-256 相同。依 plan 規定，缺少或失敗的 ffmpeg 沒有在真正未安裝的機器上執行，而是在隔離子程序中模擬。`pnpm acceptance` 與 `pnpm acceptance:updates` 沒有重跑原生輪次：它們只改為讀取新判定，由 typecheck、共用 helper 的測試與載入檢查涵蓋。沒有新案例轉交 035。

Codex GPT-6 Astra（medium reasoning、read-only）在 30 分鐘預算中約用 1 分鐘完成一個 pass，沒有使用 fallback，回傳無 findings；不需要第二個 pass。

測試錄影（~/Movies/RecordStuff 的 `2026-09-25 23-06-14.mp4`、`23-07-03`、`23-07-53`、`23-08-54`、`23-13-00`、`23-13-49` 與 `23-14-39`）、本機量測 `2026-09-25.md`／`.json` 與 播放報告 `2026-09-25T15-15-35Z-computer-use` 都保留在本機。本輪已在 main 依範圍分開提交為本機 commit：工具 `13a6cd6`、設計文件 `c4805dd` 與本結案 commit。沒有 push 或發布。

## Plan 029 結案 — 2026-09-25

Log 身分與跨輪替驗收（R1 bug 7、R2-07），由 Claude 實作、Codex GPT-6 Astra review（[Log 與診斷](../system-design/desktop.md#log-與診斷)、[驗收工具](../system-design/tooling.md#選擇驗收範圍)）。

- **事件帶 session 身分。** Recorder 的 captureStarted、saved 與 failed 事件帶著 session（id、暫存路徑、錄製與要求停止時間），失敗另帶落定的檔案結果；preflight 拒絕是獨立的 failed 變體，不指名 session。每次啟動在 `start:` 行記下 run id（啟動時間加 pid）。
- **Session record。** 人類可讀行不變，main 另外為每次 capture、儲存、失敗（沒有檔案也寫）與拒絕各寫一筆有版本的 JSON record：`session-record: {"v":1,"run":…}`。含空白、引號或換行的路徑維持在一行跳脫後的內容。
- **依身分配對。** `pnpm verify`、`pnpm acceptance` 與 `pnpm matrix` 以 run 與 session id、透過檔案完整路徑配對 session，只有單一 session 指名同名檔時才用檔名。重複 record 是一個結果，不同結果是 conflict；空的失敗不宣告路徑，因為同一秒的重試可能重用它的名稱。沒有 record 的舊版啟動使用保守的舊版關聯；其他情況顯示為 ambiguous、conflict 或 unknown，不判定需要要求設定的檢查，驗收與 matrix runner 會判該案例失敗。被 single-instance lock 拒絕的啟動寫的 `start:` 行不再算程序啟動，也就是 plan 028 那一輪遇到的缺口。
- **跨輪替讀取。** Runner 的等待與收尾以 cursor 為起點，cursor 由檔案身分、byte offset 與其前 64 bytes 組成。它跟著檔案進入保留的 archive、每行只讀一次、容忍改名與追加之間的空檔、保留尚未換行的最後一行；歷史被 retention、截斷或截斷後又長回移除時，立即回報 evidence gap。快捷鍵 runner 要求 run id，跟隨 capture record 指名的 session，並從該 session 的終止 record 取得檔案。輪替政策本身不變。

自動化證據：最終版本 `pnpm check` 通過 typecheck、50 個檔案 814 項測試與 build；`git diff --check` 無誤。以 production logger 寫入、`rotateLog` 輪替的真實暫存 log 測試涵蓋：R2-07 重現（31 行的舊檔輪替後，saved 出現在 3 行的新檔）、停止、儲存與失敗收尾期間的輪替、多次輪替、超過保留數的輪替、截斷、截斷後又長回、改名與追加之間 active 檔不存在、尚未換行的最後一行、重啟、重複 record、其他 session 的結果、有上限的逾時，以及停止最多只切換一次。真實 Recorder 經 production logger（含輪替）與 production session logging 產生 A（1080p）先失敗、B（4k）先完成收尾的 log：依身分兩者都配對正確，同一批行不讀 record 時兩者皆為 ambiguous；capture record 被 retention 移除時，檔案維持 unknown，不會借用別人的設定。手寫案例另涵蓋三個交錯 session 含無檔失敗、不同資料夾同名檔、特殊字元與分解形式 Unicode、新舊啟動混合、未知 id 與版本、兩次啟動中相同的 session id，以及失敗的 preflight。以 245 個保留 log（其中 6 個含被 lock 拒絕的 start 行）重播，舊的依順序讀法配到的 630 個檔案全部得到相同關聯，0 筆不一致；保留 log 中沒有它會出錯的交錯。每個變更過的 runner 都能在 Node type stripping 下載入，這一步抓到 Vitest 接受但 Node 不支援的 TypeScript parameter property。

原生：M1 Pro、macOS 26.6.2，HEAD `43461d5` 加上未提交的變更。`pnpm start:app` 建置並驗證全新簽章 bundle（九個 identity；app.asar SHA-256 `7a901e7e…264e17`），啟動時記下 run id。`pnpm acceptance` 送出 ⌘⌥⇧R（press → pressed 176 ms），從 capture record 綁定 session `muh1dly0-r93rzr`，從 saved record 取得檔案，以相同 run 與 session 配對為 `matched`；錄製 10.3 秒、1920×1080、48 kHz 立體聲，RMS −27.2/−27.2 dB，10 次閃光與 10 個音，可完整解碼（`2026-09-25T14-08-34-152Z-hotkey-acceptance`）。Codex GPT-6 Astra computer use 在 QuickTime 播放，進度由 0 前進至約 9.57 秒，測試素材持續移動。reader 依 review 修正後，以 `pnpm open:app` 重開同一產物，`pnpm acceptance` 再次通過（session `muh1x8p3-7e9bu0`、`matched`、10.2 秒；`2026-09-25T14-23-50-091Z-hotkey-acceptance`）。RecordStuff、QuickTime 與素材瀏覽器皆已退出，設定未變更。依維護者要求，另外兩個等待改用 cursor 的 runner 接著以同一產物原生執行：`pnpm acceptance:settings-shortcut` 送出 ⌘⌥,，並從 checkpoint 起接到設定 callback（只驗證 callback，未觀察面板），之後正常退出 App；`pnpm acceptance:notification -- --install --clicks 2` 在英文、Finder 關閉的情境下 2/2 通過，兩次點擊都讓 Finder 置前並選中存好的檔案，之後還原原本安裝的 App（app.asar 不變、簽章有效）、語言設定與 TextEdit，並刪除它產生的錄影。

依 plan 規定，原生錄製進行中的輪替沒有實測：強制輪替與失敗收尾在隔離的暫存 log 中執行。原生沒有觸發失敗路徑；matrix runner 只做了載入與 dry run。沒有新案例需要移到 035。

Codex GPT-6 Astra（medium reasoning、唯讀）完成兩個 pass，共用 30 分鐘 budget 中約四分鐘，沒有 fallback。Pass 1 回報一個 Medium finding：log 在兩次讀取間被截斷又長回超過 cursor 時，會從過時的 offset 讀取並靜默跳過事件。已以 cursor mark 修正，並加入兩個拿掉修正就會失敗的 regression test。Pass 2 無 findings。

同樣依維護者要求，本紀錄寫完後已刪除測試錄影 `2026-09-25 22-08-39.mp4` 與 `2026-09-25 22-23-55.mp4`、上述四個本機 measurements 目錄（兩次快捷鍵執行、`2026-09-25T14-33-17.132Z-settings-entry-HkW39M` 與 `2026-09-25T143333.532Z-notification-acceptance`），以及暫存的 review 與驗收 log；原始證據已不存在，保留下來的只有本紀錄。本輪已依範圍拆成數個 commit，提交在本機 main：App 端 `f2db26b`、工具 `7afdb4c`、設計文件 `93909ed`，以及本結案 commit。未 push，也未發布。

## Plan 028 結案 — 2026-09-25

設定視窗與快捷鍵生命週期（R1 bug 1、5，R2-03），由 Claude 實作、Codex GPT-6 Astra review（[設定視窗](../system-design/desktop.md#設定視窗)、[錄影快捷鍵](../system-design/desktop.md#錄影快捷鍵)）。

- **關閉組合鍵。** 頁面與快捷鍵編輯器共用同一個判斷：macOS 精確為 ⌘W、其他平台精確為 Ctrl+W，不得帶其他修飾鍵；以輸入的字元判斷，只有該配置在該位置不輸入拉丁字母時才採用實體 W 鍵。macOS 的 ⌃W 與 ⌘⇧W 現在可以錄入，不再關閉視窗。
- **錄入 lease。** 每次錄入是一份由發起視窗持有的 lease。取消、失焦、逾時、關閉、renderer 失敗、錄影鎖定與退出都立即釋放它，即使已確認的儲存仍在寫入，並恢復當下已提交的註冊；一筆請求只釋放它送出時的 lease。全域的 `committingHotkey` 例外已移除。從 `index.ts` 抽出的 `AppShortcuts` 持有兩個註冊：已確認的儲存先保存再註冊，session 進行中則延後；寫入失敗保留原設定與註冊並通知。
- **當掉後恢復。** renderer 結束時記 log 並丟棄該視窗；下次開啟設定建立並載入新視窗，不自動重新載入。關閉、失焦與當掉事件只作用於自己的視窗實例。

自動化證據：最終版本 `pnpm acceptance:regression` 通過 — `pnpm check`（typecheck、47 個檔案 778 項測試、build）、設定 113/113（`2026-09-25T12-48-48-007Z-settings-acceptance`），以及快捷鍵整合三個階段全數通過且清理完整（`2026-09-25T12-49-25-151Z-shortcut-failure`）。`git diff --check` 無誤。新的 SettingsWindow 測試對原實作有 46 項中 16 項失敗。單元與 DOM 測試涵蓋：各平台關閉組合鍵對應、大小寫與鍵盤配置；macOS ⌃W 可錄入並確認而 ⌘W 關窗，切換為 Windows 對應後亦然；每一種釋放路徑（取消、失焦、逾時、關閉、當掉、關閉程式）搭配卡住後成功或失敗的儲存，並檢查實際註冊、已存值與重開面板；用恢復的舊鍵開始錄影時保留它作為停止鍵直到 settle；重開視窗錄入期間舊儲存完成；當掉時放棄未確認草稿；重複開啟／當掉不自動重新載入；已丟棄視窗晚到的事件；以及載入失敗後重開可用。

production main 快捷鍵 fixture 以 fixture 專用的 `settings.json` rename gate 保留已確認的儲存；這不是真實磁碟卡住，輸入為 Chromium input event，不是 OS 送鍵。它證實：真實 renderer 當掉會丟棄視窗並恢復兩個快捷鍵；替代視窗可錄入 ⌃W，按確定後儲存並註冊；保留儲存期間按 ⌘W 會在儲存完成前恢復已提交的註冊；持久化後才註冊新鍵，重開面板顯示該值；舊的保留儲存在新錄入期間完成時，兩個鍵維持暫停直到該錄入結束；當掉後保留的儲存失敗時，保留原設定與註冊並送出在地化的寫入失敗通知。

原生：M1 Pro、macOS 26.6.2，HEAD `9d29118` 加未提交變更。`pnpm start:app` 建置並驗證全新簽章 bundle（九個 identity；app.asar SHA-256 `22642c17…c079c`），兩個快捷鍵皆註冊。`pnpm acceptance:settings-shortcut` 送出 ⌘⌥,，設定 callback 開啟面板。Codex GPT-6 Astra computer use 無法取得 RecordStuff：依名稱取得回傳 `-10005 timeoutReached`，依路徑取得則回報工作階段已停止，與 plan 025 相同。依路徑取得時還啟動了第二個 instance，它因單一 instance 鎖結束，其 `start:` 行讓錄影 runner 以此作為最後一次啟動而拒絕執行 — 這是 plan 029 要處理的 log 身分缺口。正常退出並以 `pnpm open:app` 重開同一產物後，`pnpm acceptance -- --seconds 10` 送出 ⌘⌥⇧R（按鍵 → pressed 160 ms），錄得 10.3 秒 1920×1080、48 kHz 立體聲、RMS −27.2/−27.2 dB、10 次閃光與 10 聲嗶聲、音畫長度差 −2 ms，完整解碼通過（`2026-09-25T12-54-31-902Z-hotkey-acceptance`）。Computer use 在 QuickTime 由 0.045 秒播放至 9.701 秒，畫面為變化中的測試素材，取消「打開」選擇器並退出 QuickTime（`2026-09-25T12-57-13Z-computer-use`；截圖只在工具對話中）。RecordStuff 與 QuickTime 均已退出，偏好與基準相同。

受阻並移至 035 N38–N40：原生面板中的實體 macOS ⌃W 錄入與確定、一般 ⌘W 關窗、錄入期間按 ⌘W 後設定與錄影快捷鍵恢復。本輪錄影與設定快捷鍵的原生送達，都發生在任何錄入之前。Windows 對應只有單元測試。完整媒體矩陣、權限變更、螢幕移除與長時間錄影不在範圍內。

Codex GPT-6 Astra（medium reasoning、read-only）完成一個 pass，約用 30 分鐘預算中的 1 分鐘，未使用 fallback，無 findings。之後沒有修改程式碼。

維護者決定結案，受阻的原生設定面板案例移至 035 N38–N40。依維護者要求，後續另將 `CommandOrControl+W` 列為保留組合，手動編輯的設定檔也無法把 ⌘W 設為全域錄影快捷鍵，macOS 的 ⌃W 與 ⌘⇧W 仍可使用；`pnpm check` 再次通過（47 個檔案 778 項測試），第二個 Codex GPT-6 Astra pass 檢查此變更、agent 保持喚醒規則與 skill 語言變更，無 findings。本輪依範圍分別在 main 本機 commit：runtime 與測試 `4fbe271`、Command+W 保留 `cc7546d`、設計文件 `908e6b5`，以及本結案 commit；agent 規則 `f5c3009` 與 skill 語言變更 `8797757` 另成 commit。未 push 或發布。同樣依維護者要求，本紀錄寫完後已刪除測試錄影 `2026-09-25 20-54-37.mp4`、上述本機 measurements 目錄，以及暫存的 review 與驗收 log；原始證據因此不再存在，以本紀錄為準。

## Plan 027 結案 — 2026-09-25

權限同步與查詢生命週期（R1 bug 2、6），由 Claude 實作、Codex GPT-6 Astra review（[螢幕權限設計](../system-design/desktop.md#螢幕權限)）。

- **保存權限狀態。** Recorder 把 PermissionWatcher 的最新狀態與錄影狀態分開保存，starting、recording、stopping 期間也一樣，但不因此打斷 session。存檔、擷取失敗與啟動失敗都依該狀態落定為 idle 或 needsPermission，所以 session 中只通知一次的撤銷不再以誤導的「待命中」結束，同一 session 內之後又授權也不需要再次通知。needsPermission 現在帶 `lastSavedPath`，選單仍有「顯示最後一個錄影」；outputDirUnavailable 會被記住並隨授權恢復，期間改過儲存位置則不恢復。存檔通知仍依既有設計讓位給權限指引。session 以 needsPermission 結束時，`autorecord` 回報該 session 自己的 saved 或 failed 結果。
- **唯一有擁有者的列舉。** PermissionWatcher 同時最多持有一個 getSources（提示或驗證），直到該 promise 自己結束。4 秒期限只顯示重新啟動指引、不釋放名額；呼叫未完成期間只輪詢第一段。提示進行中才授權時，等提示結束後再驗證；提示的結果永遠不算驗證。
- **退避與世代。** 驗證失敗後，從完成時起算 5、10、20、40 秒重試，之後每 60 秒；撤銷授權會重設退避。撤銷、markRelaunchRequired 與 stop() 都開始新世代，舊世代晚到的結果只記 log 並忽略，接著重新驗證。stop() 移除 interval、activate listener 與兩個 timer。

自動化證據：最終 `pnpm check` 通過 typecheck、45 個檔案 756 項測試與 build；`git diff --check` 無誤。注入測試涵蓋：

- Recorder：starting、recording、stopping 期間撤銷，之後存檔或失敗，都落定為 needsPermission 且仍回報失敗；存檔路徑保留在狀態與選單；同一 session 內之後授權，不需額外事件即回到 idle；needsRelaunch 切換保留路徑；儲存位置不可用的標記隨授權恢復，缺權限期間改儲存位置則清除；autorecord 保留存檔結果。
- Watcher：呼叫卡住時十二次輪詢與 activate 後仍只有一個底層未完成請求（舊 watcher 30 秒內送出七個）；提示與驗證共用一個名額；期限後晚到的成功不需第二個請求即恢復；晚到的拒絕啟動倍增退避直到上限；撤銷並重新授權後，晚到的成功視為過時並重新驗證；撤銷後晚到的拒絕被忽略並把名額讓給提示；擷取被拒會取代進行中的驗證；stop() 移除 listener 與 timer，晚到的結果既不套用也不釋放其他請求的名額。

原生驗收，在 macOS 26.6.2 的 M1 Pro、HEAD `3f696b6` 加上未提交變更：`pnpm start:app` 建置並驗證新的簽章 bundle（九個 identity），log 顯示 ready 後 50 ms 驗證成功、看得到兩個螢幕。`pnpm acceptance -- --seconds 10` 錄得 10.3 秒 1920×1080、48 kHz 立體聲 RMS −27.2／−27.2 dB、10 次閃光與 10 次嗶聲並可完整解碼，結果通過（`2026-09-25T11-34-34-660Z-hotkey-acceptance`）。log 顯示 starting → recording → stopping → idle 與存檔通知，之後 RecordStuff 已退出。接著由 Codex GPT-6 Astra computer use 在 QuickTime 播放該檔，進度從 0 前進到約 6.7 秒並有動態測試素材；關閉時出現的 Open 面板已取消，並結束 QuickTime；截圖只留本機。RecordStuff 與 QuickTime 均已退出，未變更任何偏好或權限。未記錄輸出裝置與音量。

未做原生驗收：開發版 App 上的撤銷、重新授權與重新啟動恢復，因此也沒有記錄權限變更時 macOS 提供或強制的行為。Agent 無法操作系統設定或驗證身分來變更權限，這些項目屬 blocked，移入 035 N36、N37。永不返回的 getSources 無法以原生方式產生；唯一未完成請求、期限指引與退避以注入測試為證據。長錄影、媒體矩陣與拔除硬體不在範圍內。

Codex GPT-6 Astra（medium reasoning、read-only）完成一個 pass，約用 30 分鐘預算中的 60 秒，未使用 fallback，沒有 findings。之後未修改程式，所以沒有第二個 pass。

接受的限制：

- 撤銷與重新授權若都落在兩次輪詢之間就觀察不到，之前開始的驗證仍可能被套用。
- 永不返回的 getSources 在程序剩餘期間都佔著名額；指引是重新啟動。
- Stale TCC 的自動恢復在重試之間最多等 60 秒。
- 權限遺失期間存下的錄影不顯示存檔通知，因為權限指引優先；選單仍可找到該檔。

依維護者要求，本輪依範圍分開在本機 main 上 commit：runtime 與測試 `f272aef`、設計文件 `1c3a5ba`，以及本結案 commit。未 push 或發布。原生權限案例由維護者決定留給 035 N36、N37。同樣依維護者要求，寫完本紀錄後已刪除測試錄影 `2026-09-25 19-34-40.mp4`、上述本機量測目錄、播放截圖與暫存 review log，原始證據已不存在，只留下本紀錄。

## Plan 038 結案 — 2026-09-25

錄影健康防護，由 Claude 實作、Codex GPT-6 Astra review。每項防護只做觀察，並透過既有的停止或失敗流程結束；沒有新增狀態、健康 UI，也不做任何復原、重新封裝或修復。所有門檻都是初始目標，集中在 [recording-health.ts](../../../src/main/recording-health.ts)（見[錄製設計](../system-design/recording.md#期限與故障隔離)）。

- **磁碟餘裕。** 從 `started` 到停止前，以單一不重疊 timer 每 5 秒讀取輸出資料夾的 `fs.statfs`。低於 1 GiB 記錄一次；低於 200 MiB 只要求一次正常停止，讓檔案排空、sync 並發布。saved 事件帶 `stoppedEarly: "lowDisk"`，log 與存檔通知會說明磁碟即將滿（「已儲存 {file}。磁碟空間即將用盡，已提前停止錄製」／"Saved {file}. Recording stopped early because the disk is almost full."）。這類錄影屬於成功，不進入失敗紀錄。查詢失敗只記錄一次，永不因此停止錄影。
- **擷取停滯。** `started` 之後，每個非空 chunk 重設同一個 timer，空 chunk 不算。10 秒時記錄一次警告，30 秒時以 `capture_failed` 與停滯 detail 失敗，保留部分檔。收到 `stopped` 或任何失敗都會解除，因此正常停止後較慢的收尾不會被當成停滯。心跳與首片期限不變。
- **寫入積壓。** FileWriter 提供 `backlogBytes`。會超過 64 MiB 的 append 立即被拒絕且不排入佇列，之後的 append 也一律拒絕；拒絕前已接受的 bytes 仍會寫入，因此部分檔是沒有缺口的前段。finish 會拒絕，session 以 `output_write_failed` 與積壓 detail 失敗；若先前已保留磁碟錯誤，則沿用該錯誤。
- **開始期間已保留的磁碟錯誤。** 泛用的 `capture_start_failed`（首片期限、擷取請求逾時、host start 被拒，或 host 回報 capture_start_failed）在發布 pending 結果前，會先排空 writer 最多 2 秒。若 writer 已保留錯誤，就改報 disk_full 或 output_write_failed，讓通知與紀錄一致。具體的 host 原因與乾淨的 writer 維持原代碼。
- **中斷證據。** 每個 session 在 `userData/recording-sessions/` 有一個 sentinel，於每次嘗試暫存檔名之前以原子寫入建立，並在每個終止結果發布後移除；正常退出會等待移除完成。啟動時，每個遺留的 sentinel 會成為一筆未確認紀錄，使用新代碼 `app_terminated`：「RecordStuff 在錄製期間未正常結束」／"RecordStuff did not exit normally while recording."，指引說明檔案可能不完整且不會修復。需要新代碼的原因是：`capture_failed` 固定的原因與「請檢查錄影設定」指引，對當機情況並不誠實；host 協定會拒絕 `app_terminated`。紀錄 ID 由 session 推導，時間為 session 開始時間，路徑以還原部分檔的方式重新檢查。只有該紀錄曾出現在已保存的歷史檔中，才移除 sentinel；這包含之後的自動重試，也包含期間已保存的移除操作之前的保存。暫時無法讀取的 sentinel 會保留，中斷的寫入或無效內容則捨棄。舊版 App 會把含 `app_terminated` 的歷史視為無法讀取，並如同處理較新版本的歷史一樣拒絕覆寫。
- **睡眠與喚醒。** `power: suspend` 與 `power: resume` 的 log 會記下進行中的 session 與狀態。睡眠不會停止錄影。

自動化證據：最終 `pnpm check` 通過 typecheck、45 個檔案 739 項測試與 build；`git diff --check` 無誤。測試使用注入的時鐘與可用空間、真實 Recorder 事件，註明處則使用真實暫存檔，涵蓋：

- 磁碟：跨越門檻時只警告一次、只停止一次，停止中不再查詢，saved 事件與 log 帶有原因；查詢失敗只記錄一次，不停止錄影。
- 停滯：10 秒警告、30 秒失敗；非空 chunk 重設計時，空 chunk 不會；真實 FileWriter 的停滯保留非空暫存檔及其確切位元組；停止後長達 60 秒的收尾不算停滯。
- 積壓：FileWriter 立即拒絕，之後的 append 與 finish 也拒絕，同時已寫入的前段完全正確，並保留先前的磁碟錯誤；Recorder 以積壓 detail 失敗，保留已接受的位元組。
- 開始期間磁碟錯誤：使用 sync 會失敗的真實 FileWriter，首片期限、擷取請求逾時、host start 被拒與 host 回報的 capture_start_failed，都回報 disk_full 且結果為 empty，第一個 pending 狀態就已帶此代碼；no_audio_track 與乾淨 writer 維持原代碼；會等待執行中的 sync，卡住的 sync 有上限。
- Sentinel：暫存檔存在前 sentinel 已存在並記下路徑；撞名時改寫；在 saved 之後、六種失敗代碼之後，以及開檔期限後才開啟的遲到 writer 之後，都會移除；寫入失敗只記錄一次，錄影照常進行；正常退出後不會留下。
- 啟動：兩個 sentinel（一個檔案存在、一個不存在）成為 partial 與 unknown 紀錄；重啟時重新檢查且不重複；確認狀態會保存；歷史被封鎖時保留 sentinel；自動重試成功時移除它，已移除的紀錄不會復活；重新檢查期間已保存的移除也一樣；無法讀取的 sentinel 會保留，無效或寫入中斷的會捨棄；協定拒絕新代碼。

反向對照：pass 2 修正前，「重新檢查期間移除」的測試會卡住（5 秒逾時）。

原生驗收於 M1 Pro、macOS 26.6.2，使用 HEAD `e72552c` 加上未提交的變更：`pnpm start:app` 建置並驗證全新簽章 bundle（九個 identity）。`pnpm acceptance -- --seconds 10` 錄得 10.2 秒、1920×1080、48 kHz 雙聲道，RMS −27.2／−27.2 dB，10 次閃光與 10 次嗶聲，完整解碼，通過（`2026-09-25T10-43-08-381Z-hotkey-acceptance`）。App log 依序為 starting → recording → stopping → idle，沒有停滯、低空間、空間查詢失敗或 sentinel 失敗的紀錄。當時可用空間為 366 GiB，因此打包版的 `statfs` 查詢正常執行，但沒有觸及任何門檻。`userData/recording-sessions/` 已建立，存檔後為空，也沒有留下 `.recording.mp4`。之後由 Codex GPT-6 Astra 以 computer use 在 QuickTime 播放該檔，從 0 播到 10.234 秒並顯示動態測試素材；關閉影片時沒有出現「打開」面板，並結束 QuickTime（`2026-09-25T10-45-56-290Z-plan038-computer-use`，截圖當時只存於本機）。RecordStuff 與 QuickTime 都已退出，沒有變更任何偏好。未記錄輸出裝置與音量。

以下沒有做原生驗收：以有上限的磁碟映像觸發磁碟防護停止；強制結束後的中斷紀錄及其定位／unknown 轉換（035 N30）；錄製中睡眠（035 N31）；停滯、積壓與開始期間磁碟錯誤路徑（僅有受控測試）。主觀聽感、音畫同步、長錄製、權限與螢幕拔除不在本次範圍。

Codex GPT-6 Astra（medium reasoning、唯讀）完成兩個 pass，約 113 秒加 92 秒 = 205 秒（預算 30 分鐘），沒有使用 fallback。Pass 1 回報兩項 Medium，均已接受：

1. 首次保存歷史失敗而保留的 sentinel，在之後自動重試成功時從未移除，已確認並移除的紀錄會被重新匯入。現在由 `RecordingResults.saved(ids)` 等待之後的成功保存，本身不觸發保存。
2. 暫時性的讀取錯誤會刪除有效的 sentinel。現在這類 sentinel 會保留到之後的啟動。

Pass 2 確認第 2 項修正，並回報一項 Medium，已接受：若啟動重新檢查期間已保存了一次移除，`saved` 會永遠等待，sentinel 也不會移除。修正方式是記錄所有曾經保存過的 ID。這項修正經過針對性與完整驗證，但依兩個 pass 的上限，沒有第三次 review。

接受的限制：

- 持續低於位元率的磁碟吞吐量仍會結束錄影。
- sentinel 寫入包含在 8 秒開檔期限內，因此卡住的 userData 磁碟會被報為 output_open_failed。本次未觀察到。
- 若在發布與移除 sentinel 之間當機，已存檔的錄影也會被回報為中斷；其路徑已不存在，所以紀錄為 unknown。
- 使用者移除紀錄後若 sentinel 的 unlink 失敗，下次啟動會再次匯入該紀錄。

依維護者要求，本輪已依範圍分批 commit 到本機 main：程式與測試 `a3fd073`、設計文件 `9e8cfcc`，以及這個結案 commit。沒有 push 或發布。同樣依維護者要求，寫完本紀錄後已刪除測試錄影 `2026-09-25 18-43-14.mp4`、上述兩個本機 measurements 目錄與暫存的 review log；原始證據已不存在，本紀錄就是留下的證據。

## Plan 026 結案 — 2026-09-25

不再把空錄影發布為成功；由 Claude 實作、Codex GPT-6 Astra review。`FileWriter.finish` 是唯一的發布關卡：先排空佇列，讓已保留的 append 或背景 sync 錯誤以原代碼（disk_full 或 output_write_failed）優先拒絕；之後若確認寫入為零位元組，就關閉 handle、清除 fsync timer、刪除空暫存檔，並以 `capture_start_failed` 與 detail `capture ended without media; no bytes were written` 拒絕。Recorder 把這個拒絕導入單一失敗流程，因此不會出現 saved、lastSavedPath 或 `.mp4`，結果為 empty。`abandon()` 具冪等性，失敗流程稍後的清理不會刪掉在同一秒內重用該檔名的重試錄影。只有非空 chunk 才滿足首片期限。既有的雙語 `capture_start_failed` 文案（「無法開始錄製」加「這次沒有留下錄影內容。」）仍然誠實，因此沒有新增錯誤碼或修改文案。沒有最短錄製秒數；非空不代表可播放（見[錄製設計](../system-design/recording.md#寫檔與失敗)）。

自動化證據：最終 `pnpm check` 通過 typecheck、44 個檔案 706 項測試與 build。新測試使用真實暫存檔，涵蓋：沒有 chunk 與只有空 chunk 的停止（含重複 stopped）；唯一 chunk 在 stopped 前一刻到達的立即重試；首筆 append 尚未完成時停止，之後成功，或以 ENOSPC 失敗並保留 disk_full；媒體到達前背景 sync 出現 ENOSPC／EIO，保留 disk_full／output_write_failed；空結果仍在發布時，於同一秒內開始的重試；FileWriter 在 0 到 2 次空 append 後 finish（handle 關閉、無 timer、檔案刪除、檔名可重用）；零位元組時寫入與 sync 錯誤保留原代碼；以及空 chunk 不滿足首片期限。反向對照：停用 finish 關卡使五項零輸出測試失敗；恢復 Recorder 事先檢查位元組數，使兩項 sync 失敗測試失敗；abandon 不具冪等性時四項測試失敗，重試的暫存檔被刪除（copy 時 ENOENT）。

原生驗收於 M1 Pro、macOS 26.6.2，使用 HEAD `6309c8a` 加上未提交的變更：`pnpm start:app` 建置並驗證全新簽章 bundle（九個 identity）。`pnpm acceptance -- --seconds 10` 錄得 10.3 秒、1920×1080、48 kHz 雙聲道，RMS −27.2／−27.2 dB，10 次閃光與 10 次嗶聲，完整解碼，通過（`2026-09-25T08-31-35-815Z-hotkey-acceptance`）。最短可行的立即停止：以 `pnpm open:app` 重開同一 bundle 後執行 `pnpm acceptance -- --seconds 0.05`，在進入錄製狀態約 0.2 秒後送出停止。Host 唯一的最後 chunk 為 1,640,113 bytes，App 存下 0.33 秒、1920×1080 H.264 加 48 kHz 雙聲道 AAC 的檔案，可完整解碼（`ffmpeg -xerror`）：非常短但非空的錄影被儲存，沒有被拒絕。Runner 只在音訊能量一項判定失敗（RMS −∞，volumedetect −91 dB），也沒有偵測到標記，因為 0.3 秒窗口錯過了素材每秒一次的閃光與嗶聲；這既不能證明開頭 300 ms 的音訊有擷取到，也不能證明遺失（`2026-09-25T08-32-13-558Z-hotkey-acceptance`）。原生擷取從未產生空輸出；無媒體路徑的證據來自上述受控測試。之後由 Codex GPT-6 Astra 以 computer use 在 QuickTime 開啟兩支影片：10.3 秒影片播放到 6.75 秒並顯示測試素材影格，0.33 秒影片可開啟並顯示影格，沒有錯誤對話框。截圖只存在工具對話中，沒有本機 PNG。影片與「打開」面板都已關閉，QuickTime 已退出（`2026-09-25-plan026-computer-use`）。每個 runner 都正常結束 RecordStuff；沒有殘留 RecordStuff、QuickTime 或素材程序，也沒有留下 `.recording.mp4`。輸出裝置為外接耳機、48 kHz；未記錄音量。主觀聽感、音畫同步、未變更的設定／通知行為、權限、長錄製與螢幕拔除不在本次範圍。

Codex GPT-6 Astra（medium reasoning、唯讀）完成兩個 pass，共 80 秒加 60 秒 = 140 秒（預算 30 分鐘），沒有使用 fallback。Pass 1 回報一項 Medium，已接受：Recorder 事先檢查位元組數時跳過了 finish，使媒體到達前的背景 sync 失敗被報為 capture_start_failed，而不是 disk_full／output_write_failed。已移除該檢查，改由 finish 作為唯一關卡。Pass 2 確認此修正，並回報一項 Medium，已接受：finish 與失敗流程都會 abandon writer，第二次 unlink 可能在失敗結果發布期間，刪掉在同一秒內重用該檔名的重試。現在 abandon 具冪等性。這項修正經過針對性與完整驗證，但依兩個 pass 的上限，沒有第三次 review。

驗證 pass 1 finding 時發現一個既有的開始期間誤報，不在本次範圍，已排入 Plan 038：背景 sync 已失敗後，首片期限、擷取請求逾時、host start 拒絕或 host 回報的 capture_start_failed，仍回報 capture_start_failed，而不是保留的磁碟代碼。依維護者要求，本輪已依範圍分批 commit 到本機 main：程式與測試 `499095a`、設計與結案文件 `d47d430`、implement-with-review skill 的剩餘風險規則 `0e6d660`，以及這個同時把該後續排入 038 的文件 commit。沒有 push 或發布。


## 桌面閒置防護 — 2026-09-25

Plan 036 回合的後續：當時四次設定 fixture 失敗都發生在本地時間 15:34 macOS 關閉螢幕並鎖定 session 之後；`sendInputEvent`／System Events 的模擬輸入不會重設閒置計時，這台 Mac 閒置 10 分鐘就會關閉螢幕。現在每個桌面 runner 開始前都執行 [desktop-session.mts](../../../scripts/lib/desktop-session.mts)：`caffeinate -u` 喚醒閒置關閉的螢幕；session 已鎖定（`ioreg` 的 `CGSSessionScreenIsLocked`）時，在啟動任何東西或送出按鍵前停止；`caffeinate -d -i -w <runner pid>` 持有防止螢幕與系統閒置睡眠的 assertion 直到 runner 結束。回合中（每 2 秒及結束時）偵測到鎖定，結果改為 BLOCKED、exit code 2，並在報告寫入 `Desktop:` 一行。已接入 `acceptance`、`acceptance:settings`、`acceptance:shortcut`、`acceptance:settings-shortcut`、`acceptance:quit-dialog`、`acceptance:notification`、`acceptance:updates`（含擷取範圍）、`matrix` 與 `audio:quality -- record`。

六項 helper 測試涵蓋鎖定解析、先喚醒再檢查、拒絕時不持有 assertion、只釋放一次、回合中與結束前鎖定、無法讀取鎖定狀態及非 macOS。實際執行 `pnpm acceptance:settings` 通過 113/113，期間 `pmset -g assertions` 顯示 caffeinate 代表 runner PID 持有 PreventUserIdleDisplaySleep 與 PreventUserIdleSystemSleep，結束後釋放，報告記錄 session 未鎖定（`2026-09-25T08-02-14-865Z-settings-acceptance`）。以 PATH shim 模擬鎖定時，上列九個指令都在啟動、安裝、建置或送出按鍵前以 BLOCKED 與 exit 2 結束（對執行中的開發 bundle 執行 `pnpm acceptance` 時 log 沒有任何快捷鍵按下，之後已正常結束該 bundle 並確認程序消失；`/Applications/RecordStuff.app` 未被修改）。讀取五次後才回報鎖定的 shim，使 113/113 的設定回合改為 BLOCKED、exit 2（`2026-09-25T08-04-16-478Z-settings-acceptance`）。未實測從真實閒置睡眠喚醒與真實密碼鎖定：這台 Mac 螢幕睡眠即會鎖定 session，只有預防能避免；也未嘗試鎖定維護者的螢幕。手動鎖定、闔上螢幕或受管理的政策仍可能中斷回合。


## Plan 036 結案 — 2026-09-25

背景保存失敗歷史與安全退出；依維護者要求由 Claude 實作、Codex GPT-6 Astra review（計畫原先寫的是另一組搭配）。歷史儲存只使用非同步 `fs.promises`，包含 `load()` 與分塊的 `writeFileAtomic` 寫入。`RecordingResults` 是唯一的持久化負責者：最多一個寫入進行中與一個合併後續寫入、帶 revision 的快照、確認／移除只在耐久保存後生效、逐筆警告分為 `io`、`blocked`（無法讀取或較新版本的檔案，永不重試或覆寫）與 `tooLarge`，自動重試間隔 2、5、15 秒後每 30 秒，手動重試加入進行中的寫入，啟動時非同步載入並合併期間到達的失敗。失敗紀錄操作不排在偏好保存佇列後；renderer 以 `aria-disabled` 讓忙碌按鈕保持可聚焦，並依記錄的意圖還原焦點。退出／重新啟動維持 025 的媒體階段在前，之後最多等待 5 秒保存最新歷史：寫入進行中只有「繼續等待／留在 App」，保存失敗後為「重試／留在 App／不儲存這些提醒並結束」。

量測（M1 Pro，本機 `measurements/2026-09-25-plan036/`）：32 MiB 上限（335 筆、每筆 64 KiB 含跳脫字元與中文的細節）整份 `JSON.stringify` 約 40 ms，超過 16 ms 畫面。未加入 worker，因為同一快照的 structured clone 在主程序也約 16 ms；改為快取每筆已編碼 JSON 與 fingerprint，歷史迴圈累積約 8 ms 工作即讓出。最終分段版本五次量測中，冷寫入、熱寫入與載入後首次寫入的最長單一 turn，在上限與 3.8 MiB 歷史皆最多 9.8 ms；啟動讀取在上限有一次 38–39 ms 的 turn（單次 `JSON.parse`），3.8 MiB 約 6 ms，一般 25 筆歷史約 2 ms。寫入總時間一般約 5–8 ms、3.8 MiB 為 17–30 ms、上限為 80–180 ms，因此保留 5 秒的初始退出等待。先前仍會阻塞 16–55 ms 的分段版本已量測並汰換。

自動化證據：最終 `pnpm acceptance:regression` 通過，含 typecheck、build 與 43 個檔案 687 項測試、設定 113/113 及快捷鍵整合且清理完成（`2026-09-25T07-46-02-395Z-settings-acceptance`、`2026-09-25T07-46-38-356Z-shortcut-failure`）。新增的 deterministic 測試以真實暫存檔與全新 store instance 驗證：延遲／拒絕的寫入、單一 writer 下 A→B→C 合併、確認／移除與遲到清理及新到達失敗的交錯、較舊完成結果不清除較新警告、確認失敗同時有新失敗、有上限退避／手動加入／重設／停止、無法讀取或未來版本歷史永不重試、啟動載入競態與升級、退出 flush 有上限且逾時後不產生平行 writer、退出暫停與恢復重試、協調器先媒體後歷史的順序，以及提示按鈕與雙語文字。`pnpm acceptance:lifecycle` 新增隔離 Electron `history` 案例，以 production Recorder、FileWriter、RecordingResults、退出協調器與歷史退出流程搭配先卡住再拒絕的儲存邊界：寫入卡住時主程序事件迴圈延遲 2–6 ms、renderer 往返 ≤ 5 ms，重複退出合併為一次，寫入中不提供退出，「留在 App」後恢復錄影，metadata 提示等到被延遲的最終複製完成才出現，明確的只放棄提醒退出保留媒體精確 bytes 且只有一個 writer（`2026-09-25T07-01-05-678Z-lifecycle`、`2026-09-25T07-42-43-106Z-lifecycle`）。

設定 fixture 改用 120 ms 非同步儲存，並如正式環境在回覆前推送已提交的 view；新增載入、自動重試、150 ms 與 2 秒延遲下的「知道了」／重新展開／移除最後一筆焦點案例，以及等待期間移動焦點。負向對照（改回原生 `disabled` 且不依意圖還原）重現原本三個焦點失敗與新增的延遲案例（102/113，`2026-09-25T07-02-10-580Z-settings-acceptance`）；實作在螢幕開啟時每次皆 113/113。pass-1 F1 修正前有一次在「failed durable acknowledgement stays unread and expanded」失敗：截圖顯示新的保存失敗列沒有警告，但失敗寫入其實已完成，點擊也沒有產生預期的逐筆錯誤（`2026-09-25T07-17-18-506Z-settings-acceptance`）。之後約 25 次（含 CPU 壓力）未再出現；原因未確立，fixture 現在於每次腳本點擊前確認畫面列與 main 一致並在失敗時輸出診斷。另有四次既有的「keyboard navigation retains a visible focus ring」失敗，發生在本地時間 15:34 macOS 關閉螢幕且畫面鎖定之後（pmset／ioreg），記為環境受阻，不算通過。已檢視中英文保存中、載入、保存警告與重試截圖。

原生：`pnpm start:app` 建置並驗證新的簽章 bundle（九個 identity）。`pnpm acceptance -- --seconds 10` 錄製 10.3 秒、1920×1080、48 kHz 雙聲道 RMS −27.2/−27.2 dBFS、10 次閃光與 10 次提示音並完整解碼（`2026-09-25T07-12-49-303Z-hotkey-acceptance`）；QuickTime 播放到 2.15 秒並 seek 到 6.46 秒（共 10.285 秒），截圖顯示解碼畫面。runner 之後經新協調器正常結束 App；RecordStuff、QuickTime 與測試素材程序確認已結束。已安裝的 `/Applications/RecordStuff.app` 原本 idle，重建前已正常結束並保持關閉。此使用者沒有失敗歷史檔，原生退出只走過歷史已保存的路徑。未原生執行重新啟動：它只在權限恢復狀態提供。未保存歷史的退出、延遲載入、儲存失敗／恢復與 VoiceOver 仍列於最後的 Plan 035 N24–N26 未測；fixture 不能取代。強制結束與斷電可能遺失未保存的提醒；背景保存不增加磁碟吞吐量。

Codex GPT-6 Astra（medium reasoning、read-only）完成兩輪，共 153 秒 + 132 秒 = 285 秒，未超過 30 分鐘預算，未使用 fallback。Pass 1 回報兩項 Medium，皆接受並修正。F1：`write()` 在釋放 writer 前就挑選 waiters，落在該 microtask 空檔的 `persist()` 會永遠不結算；現在釋放 writer 與挑選 waiters 在同一步完成，並新增在舊邏輯下會失敗的 microtask 深度回歸測試。F2：保存成功後清除警告時對每個被標記列掃描一次整份歷史；清理與操作提交改用 ID 索引與布林變更追蹤，60,001 列恢復測試在舊邏輯需 6.9 秒，現在低於 3 秒。Pass 2 逐一檢視全部 42 個變更、刪除與未追蹤檔案，確認兩項修正並回報無 findings。兩輪都未確立修正前那一次設定 fixture 失敗的原因。

依維護者要求，本輪已依 scope 分開 commit 在本機 main：執行期實作與驗收覆蓋 `507a2c0`、設計與結案文件 `1e0deea`、桌面閒置防護 `502e452`，以及本次文件 commit。未 push 或發布。


## Plan 039 結案 — 2026-09-25

儲存庫整理，只涉及文件與測試位置。兩份儲存庫版面文件現在說明 `tests/`（同時需要 DOM 與 Node API 的跨程序測試，由 `tsconfig.tests.json` 檢查、`vitest.config.ts` 收錄），在強制設定表列出 `tsconfig.tests.json`，並把 `test-material.html` 歸到 `scripts/` 進入點同層。`scripts/update-acceptance.test.ts` 移到 `scripts/lib/update-acceptance.test.ts`，`scripts/lib/settings-entry.test.ts` 併入 `scripts/lib/acceptance.test.ts`，根目錄 `tsconfig.json` 的 references 加入 tests 設定。

重複 skill 一項依維護者決定不執行：Claude Code 只使用 `.claude/skills/`，其他 agent 使用 `.agents/skills/`，因此兩份 `claude-implement-with-gpt6-astra-review` 維持各自獨立的檔案，不改為 symlink。儲存庫版面文件已記錄這項分工。

`pnpm check` 通過：typecheck、43 個檔案共 665 個測試（先前為 44 個檔案 665 個；合併使檔案數少一個，測試數不變）與 build。受影響連結／anchor 與 `git diff --check` 通過。不需要、也未執行 App 啟動、打包、錄影或原生驗收。下一個是 Plan 036，尚未開始。依維護者要求，已依 scope 分開 commit 在本機 main；未 push 或發布。


## Plan 025 終止負責與退出 — 2026-09-25

實作已完成；計畫仍保留，等待最後原生驗收。Renderer 在 Blob 轉換前固定終止原因，encoder error 等待末筆 data／stop，有界 fallback 阻止後續交接。Main 只保留一個終止流程，獨立追蹤開檔、存檔、失敗清理與等待結果查核／發布。退出共用協調器、保留啟動後立即停止的意圖，10 秒停止期限後另留 3 秒清理時間；待處理工作只能延後退出，不能被丟棄。延期會取消重啟意圖；遲到開檔後關閉失敗只保留不確定的候選路徑。

Claude Opus 5.5 xhigh 完成兩輪唯讀 review，約 815.7 秒＋531.8 秒，共 1347.6 秒，未使用 fallback。Pass 1 六項全部接受並修正：(1) Medium，partial 結果 stat／發布可能晚於退出；(2) Low–Medium，缺少明確 false／重試／重新開始斷言與可直接執行的 fixture 指令；(3) Low，Node 型別參照削弱 renderer 隔離；(4) Low，退出延期對話框可能被遮住或堆疊；(5) Low，延期的 relaunch 意圖會影響後續普通退出；(6) Low，退出期限取消等待授權的啟動，與文件不符。Pass 2 確認前六項已修正，另有三項也全部接受修正：(1) Low–Medium，延期後晚到的 start 可能持續擷取，現改為開始後立即停止並更新雙語提示；(2) Low，停止／退出期限相同，可能多要求一次退出，現加安全的 3 秒餘裕；(3) Low，雙語狀態、fixture 與測試目錄文件落差。依技能最多兩輪限制，不再送第三輪；第二輪後修正以針對性及完整檢查驗證，不宣稱 reviewer 最後給出無 findings 核准。

本機證據保留在 `measurements/2026-09-25-plan025/` 與 `measurements/plan025-review/`。第一次 lifecycle fixture 因頂層 await 阻擋 Electron ready 而逾時，改 async main 後修正，原程序已清理。Lifecycle 通過真實 copy、handle close、partial 結果 stat／發布延遲，兩次退出延期、精確 bytes、durable partial 歷史與安全程序退出（`2026-09-24T19-17-21-069Z-lifecycle`）。Fixture 使用 100 ms 退出期限；Recorder 假時鐘測試涵蓋正式期限與延後啟動。

原生工具最初對無視窗 App 回 timeoutReached；後續 RecordStuff 操作（含恢復後）回報 application session 已明確停止。這是工具狀態，不能據此證明維護者主動停止。重開的 App 經維護者協助正常退出，並確認程序消失。首次通知 runner 因既有 Finder 視窗受阻，沒有替換已安裝 App；維護者關閉視窗後，`pnpm acceptance:notification -- --install --clicks 2` 通過 2/2，還原原安裝 App／偏好、關閉測試 UI 並退出（`2026-09-24T192002.836Z-notification-acceptance`）。

新簽章開發 bundle 的錄製 smoke 通過：初次 10.3 秒影片完成解碼與 computer use QuickTime 播放／跳轉，影片與後續「打開」面板皆關閉，播放器退出。第一輪修正後的 10.2 秒影片通過完整解碼與素材標記，48 kHz 雙聲道，兩聲道 RMS 約 −27.2 dBFS（`2026-09-24T19-25-50-795Z-hotkey-acceptance`）。第二輪修正後最新簽章 bundle 另通過 10.3 秒 smoke、10 次 flash／beep、完整解碼及 −27.2／−27.2 dBFS 聲道 RMS（`2026-09-24T19-37-05-881Z-hotkey-acceptance`）。QuickTime 原生操作觀察到測試素材與 2.81 秒播放進度；影片關閉後無殘留視窗，再正常結束播放器，確認 RecordStuff／播放器程序消失。未做主觀聽感。恢復後輸出裝置為外接耳機、48 kHz；未記錄實體音量。

設定 regression 首次 98/100：確認資料與收合成功，但焦點及後續 Enter 展開失敗。相關 Settings production 程式未改。只增加 active tag、文件／視窗焦點診斷後，重跑 100/100，焦點正確停在 summary（`2026-09-24T19-24-08-355Z-settings-acceptance`）。保留初次失敗，未確定根因。其後快捷鍵整合與程序清理通過（`2026-09-24T19-25-20-597Z-shortcut-failure`）。

維護者操作的錄製中結束通過：實際繁中選單是 **結束**。Log 確認正常停止、完成存檔、saved，唯讀程序檢查確認 main／helper 已退出。保留檔案 `2026-09-25 03-31-49.mp4` 為 23.472533 秒、1920×1080 H.264＋AAC、45,473,734 bytes。影像／音訊完整解碼通過；FFmpeg 預設 null 輸出時基曾產生重複 DTS 捨入警告，使用 demux 時基與 `-xerror` 完整解碼沒有警告。結束時依設計不顯示存檔通知。此手動案例使用第一輪修正後產物；第二輪修正影響延後啟動／期限／提示。最後 `pnpm check` 通過 647 tests／41 files；lifecycle 三種模式重跑通過（`2026-09-24T19-35-40-217Z-lifecycle`），Settings 通過 100/100（`2026-09-24T19-35-51-688Z-settings-acceptance`）。延期退出提示的原生可見性、焦點與雙語版面仍因工具工作階段停止受阻，025 保留等待此項證據；受阻／未測不算通過。不包含完整品質／fps 矩陣、長錄影、音訊保真、權限重設、拔螢幕、網站或發布檢查。強制退出／斷電與儲存裝置永久無回應不受正常退出契約保證。Plan 036 仍負責非同步提醒保存及未保存提醒的退出政策。


### 延期退出提示測試入口 — 2026-09-25

使用者追加 `pnpm acceptance:quit-dialog -- --language en|zh-TW`。隔離 Electron fixture 共用正式 `createQuitFeedback`、Recorder、FileWriter 與退出協調器，延遲合成 bytes 的真正複製，確認關閉原生提示後仍保留待處理工作，再解除延遲、安全退出。不錄影、不改正式 App 資料。型別、建置及 42 files／649 tests 通過；既有 lifecycle copy／cleanup／result 三種案例通過。原生 computer use 看見中英文提示文字完整、無截斷，AX 焦點位於提示；兩輪皆保留精確合成 bytes 並正常退出（`2026-09-24T19-51-04-283Z-quit-dialog-zh-TW`、`2026-09-24T19-51-29-074Z-quit-dialog-en`）。截圖留在工具對話，維護者另提供英文截圖，文字與焦點按鈕完整。取得工具目標或局部截圖仍不能證明自動跳到另一個 App 前面。

Ctrl+C 留下 interrupted 失敗，強制清理後確認程序群組消失（`2026-09-24T19-52-08-592Z-quit-dialog-en`）。兩輪原定預設逾時測試均在期限前關閉，因此只能算正常路徑。另以測試專用 Node preload 把外層 40 秒期限加速為 1 秒、於原生 UI 前觸發：首次程序群組 probe 回 `EPERM` 而未留下報告；runner 已補上 supervisor 例外報告，失敗且清理狀態未確認。重測走到 timeout 分支，記錄強制清理與 groupGone=true（`2026-09-24T19-57-23-762Z-quit-dialog-en`），最後唯讀確認無 fixture 程序。這是加速期限證據，不宣稱實際觀察提示保持 40 秒。此次只抽取提示與新增驗收工具，未改錄製／編碼路徑，因此不重做既有媒體／通知案例。追加 review 另存本機 `measurements/plan025-dialog-review/`。


追加的 Claude Opus 5.5 xhigh review 完成兩輪（437.0＋203.5＝640.5 秒），沒有 fallback。四項全部接受：D1 Medium，單次取消 handler 讓重複 Ctrl+C 跳過清理，改持續接收訊號；D2 Low，SIGTERM 取消未能阻止 fixture 的正常退出提示，實測 JavaScript SIGTERM handler 仍無效，因此 runner 明確選用立即 SIGKILL 自己建立的可丟棄合成程序群組，其他 runner 保留正常 SIGTERM；D3 Low／依平台而定，重複結束不再置前既有提示，已恢復 focus-on-join 且不增加對話框；D4 Low，timer callback 中群組 SIGKILL／probe 例外可能逃出 Promise／報告，改 fallback 至 child SIGKILL，讓錯誤經受監督的 Promise 回報，並以真實 child 的受控 EPERM 回歸測試驗證。第二輪確認 D1–D3 後提出 D4；最後 D4 修正以測試確認，未送第三輪 review。

最後 `pnpm check`：651 tests／42 files、型別與建置通過。預設 lifecycle copy／cleanup／result 仍通過（`2026-09-24T20-03-57-213Z-lifecycle`）。最後取消及加速逾時均記錄強制清理、groupGone=true 與正確失敗報告，且未要求原生提示（`2026-09-24T20-04-07-076Z-quit-dialog-en`、`2026-09-24T20-04-09-141Z-quit-dialog-en`）。英文正常路徑（`2026-09-24T20-04-32-770Z-quit-dialog-en`）及最後繁中（`2026-09-24T20-10-05-132Z-quit-dialog-zh-TW`）的顯示／關閉／bytes／退出通過。最後繁中截圖與 AX 顯示文字完整、按鈕有焦點。跨 App 自動置前仍未確認，因此不因驗收工具完成就默默關閉 Plan 025。未 commit、push 或發布。


### Plan 025 結案 — 2026-09-25

維護者明確確認本次測試提示會自動跳到前景。連同既有中英文原生截圖／可讀性、錄製中正常結束、新 bundle 擷取／媒體／播放、通知 2/2、Settings 100/100、生命週期、最後 651 項測試與清理證據，Plan 025 最後必要原生觀察已完成。這是維護者觀察的置前結果，不是 agent 從裁切圖推論；上方受阻／未測狀態仍保留為歷史。025 已結案，移除雙語執行計畫；下一項 036 尚未開始。035 仍保留原排定的其他案例。未 commit、push 或發布。

原生驗收技能現已明定 agent 截圖、搭配 accessibility 自行判讀及具名證據紀錄的步驟。此修改不會讓 CLI 自動呼叫 AI，也不宣稱無人桌面 CI 已涵蓋。未來要在不靠人工證據的情況下通過自動置前，仍需工具提供被動全桌面／前景觀察能力。本次結案與流程更新僅修改文件，檢查連結／錨點、指令、雙語與 diff 空白；未重啟 App 或錄影。


維護者其後授權依 scope 直接在 main 建立本機 commits：執行期負責關係／安全退出為 `2e38f68`，隔離原生提示驗收、截圖流程及干擾提醒為 `7d7d939`。本次文件變更完成 025 結案並將下一項更新為 036，未開始實作 036，未 push 或發布。最後合併的程式／設定檔自 651 項測試通過後未變，沿用既有驗收證據；重新檢查文件連結／錨點與 diff 空白，並修正移除 025 列後的佇列表格。


## 多筆失敗歷史 — 2026-09-25

依使用者授權直接延伸錯誤提醒，不另排實作 plan。各筆保留獨立 ID、原因、檔案線索／結果與確認狀態；保留所有未確認及最近 20 筆已確認紀錄。移除已確認紀錄不刪影片或 log。選單列顯示未確認筆數，全部確認才消除標記；獨立重新儲存不改未讀狀態。v2 採新歷史檔，升級既有 v1 單筆資料，避免舊 App 覆寫新歷史。

初次 `pnpm acceptance:regression` 通過 39 檔共 625 tests、設定 97/97 及快捷鍵整合，清理完成。建置後 fixture 以滑鼠／鍵盤檢查確認、展開、獨立重試、移除，以及新紀錄出現時的舊滑鼠操作。已檢視中英文列表與最小視窗亮暗色截圖。證據：`measurements/2026-09-25-failure-history/`、設定 `2026-09-24T17-58-53-487Z-settings-acceptance`、快捷鍵 `2026-09-24T17-59-11-659Z-shortcut-failure`；UTC 產物名稱與本地工作日期不同。

使用者要求對前次單筆實作追加的 Opus review 耗時 530.8 秒，提出一項 Low：未讀保存重試必須同時確認。本次接受並改為獨立精確 ID 的重試，涵蓋重啟測試。該輪補充先前兩輪歷史紀錄，並非無問題通過。本次多筆實作的 review 記於下方。

原生選單列／通知／Finder／重啟／錄影操作依使用者要求仍未執行，收進最後引導 Plan 035，新增 N19–N23；fixture 不代表原生重繪、通知或擷取已驗證。不淘汰未確認紀錄，32 MiB 安全上限改以保存失敗呈現；同步歷史寫入可能卡住主程序／UI，磁碟不可用、斷電或 metadata 損壞時不能保證保存。未變更擷取、編碼或音訊品質，本輪不重跑錄影矩陣。


最終 `pnpm acceptance:regression` 通過 **39 檔共 627 tests、設定 100/100、快捷鍵整合且清理完成**。證據：`measurements/2026-09-25-failure-history/history-regression-2.log`；設定 `2026-09-24T18-13-29-130Z-settings-acceptance`、快捷鍵 `2026-09-24T18-13-47-919Z-shortcut-failure`。已檢視更新後中英文截圖。集合 API 轉換期間的 TypeScript 錯誤已在回歸前修正；未新增原生驗收。

Claude Opus 5.5 xhigh 完成兩輪唯讀 review（506.7 秒 + 367.0 秒 = 873.7 秒），沒有 fallback。第一輪 6 項 Low 全數接受並修正：

1. 很舊的未讀紀錄確認後可能被 20 筆較新已確認紀錄立即淘汰。新增驗證／保存 `acknowledgedAt`，保留最近確認的 20 筆；回歸確認剛確認的舊筆仍在。
2. 移除最後一筆丟失鍵盤焦點，空歷史入口遺留定位請求。空列表返回前消耗請求並定位目前分頁；真實輸入 fixture 涵蓋最後一筆移除及下一筆到達不搶焦點。
3. 同時啟動多筆 stat 可能因失聯網路磁碟佔滿檔案工作執行緒。改逐筆檢查，逾時不再發出請求；八筆離線候選僅發出一次底層 stat。
4. 單筆操作失敗會誤標未變更紀錄尚未保存。改比對各 ID 已保存 fingerprint，只有真正差異才警告；確認／移除失敗仍回報操作錯誤，維持原紀錄。
5. 切換語言重播所有翻譯後結果。語言改變時不播報歷史事件；fixture 檢查不批次讀出失敗。
6. 關閉通知說明及 desktop／Plan035 文件仍引用舊區塊名稱。中英文及測試改為失敗紀錄。

第二輪：**無 findings**，確認全部六項修正。保留的輕微限制未變：啟動正規化的 unknown 紀錄遇到寫入失敗仍可能顯示一般保存警告；未用到的歷史翻譯 key 無行為影響。最後回歸／review 後只整理文件及證據；另檢查 `git diff --check`、文件連結／anchor 與雙語一致性。原生缺口仍在 Plan035；未 commit、push 或發布。


維護者要求依範圍分批本地 commit 並結束本輪實作。完整寫入及已完成 Plan024 的移除提交為 `b4deda3`；失敗歷史／UI 提交為 `2546f87`。本輪實作結案，沒有獨立失敗歷史 plan 需要刪除；不代表尚未完成的 Plan025、非同步資訊保存 Plan036、重疊 Plan037 或最後人工驗收 Plan035 結案。最後的計畫提交保留佇列及原生驗收責任，未要求 push／發布。Commit 前已核對目前 source／fixture 差異與 review 快照一致，因此沿用無變更版本的既有通過證據，不重跑測試。


## 最新失敗跨重啟保留 — 2026-09-25

最新錄影失敗與已讀狀態改存入獨立、版本化的 `userData/recording-result.json`，跨重啟保留。未讀提醒留下；已讀結果仍可查看，但不亮未讀標記。啟動不重發錯誤通知。中斷清理改為無法確認，即使候選檔存在也不宣稱收尾成功；先前確認的部分檔案限時兩秒重新檢查，不存在／空檔／無法存取改為無法確認。UUID 失敗識別與參照檢查避免舊還原工作覆蓋新結果或已讀操作。

持久化失敗仍在記憶體顯示結果，並提供本地化警告；「知道了」成功存下已讀狀態後才清除標記，失敗仍未讀並可重試。無效格式、版本與過大紀錄不阻止啟動。私有暫存檔、fsync、rename 讓替換失敗時保留舊完整 JSON；這不是斷電保證、通知收件匣或遺留檔案修復機制。

`pnpm acceptance:regression` 通過 **39 檔案、617 個測試**、**94/94 設定案例**及快捷鍵整合，清理完成。[設定證據](../../verification/measurements/2026-09-24T17-17-20-022Z-settings-acceptance/report.md)、[快捷鍵證據](../../verification/measurements/2026-09-24T17-17-37-744Z-shortcut-failure/report.md)、[實作與保留紀錄](../../verification/measurements/2026-09-25-result-persistence/implementation.md)。測試涵蓋新 store/controller 實例的重啟讀取、未讀／已讀、中斷清理、消失／空檔／目錄、檢查逾時與過期結果、保存失敗／重試、損壞紀錄與原子替換失敗。Fixture 以真實滑鼠測失敗確認及成功重試；雙語最小視窗提示已視覺檢查。

保留先前失敗：optional-property 型別與缺少新錯誤 pending 事件的測試流程已修正。一輪設定測試因「知道了」焦點與鍵盤重開失敗為 88/90；只加診斷的重跑及後續審查前完整回歸均為 90/90。尚未確定這兩項暫時失敗的原因，不宣稱已對它們修正正式程式。

維護者明確要求剩餘原生操作排到最後的 Plan035。本版尚無新原生重啟／選單列／橫幅／錄影驗收；必要原生檢查為延後執行，不算通過或不適用。前版正常錄影證據不外推到本版。完整畫質／音訊／長錄影矩陣不屬本次範圍。本輪未啟動原生 App、未變更使用者偏好、未 commit／push／發布。


Claude Opus 5.5 xhigh 第一輪完成（438.1 秒），五項全部接受：逾時／檢查中確認後仍保留候選路徑及先前確認資訊，後續可重新辨識部分檔；略過未變更的啟動寫入並提供已讀保存重試；同步保存失敗前先呈現 idle；歷史重新啟動操作依目前權限限制；固定 fixture 等待改為有期限的狀態輪詢。另修正 tray-hint 註解位置與雙語總覽因果。每項行為都有對應測試。原88/90失敗仍保留；輪詢移除時間假設，不代表已證明舊失敗根因。第五輪回歸抓到 idle/pending 順序改動後過時的最後事件斷言，修正後第六輪完整通過。同步 user-data IO 仍可能阻塞其他主程序工作，不宣稱非阻塞。


Claude Opus 5.5 xhigh 第二輪完成（360.8 秒），新增五項 Low 均接受修正：確認部分檔的 fingerprint 忽略多餘候選／先前確認欄位，避免未變更卻重寫；已讀重試使用正確失敗文案；歷史權限指引限定 macOS；新確認／重試 fixture 改為限時輪詢；區分要求 tray 更新與同步 IO 卡住時的實際原生重繪。兩輪合計798.9秒，未 fallback／未第三輪；最後修正由 Codex 與第七輪回歸驗證。最後僅強化 fixture 逾時必須明確失敗，另跑型別與設定驗收。user-data 寫入卡住時的原生重繪仍未驗證，可能延遲。


## 錄影失敗結果 — 2026-09-25

最新失敗在本次 App 執行期間保留：同一選單列圖示的警告標記、右鍵結果入口，以及設定兩個分頁頂端的「最近錄影結果」。錯誤通知開啟同一區塊。關閉通知、開選單、開始另一次錄影都不算已讀；錄製時優先顯示 REC。「知道了」只確認指定且已完成清理的失敗，並收合區塊。清理中、確認保留部分檔案（可能無法播放）、無內容與無法確認有不同說明；部分檔案消失時改成無法確認。macOS 權限復原提供系統設定／重新啟動，遵守錄影與清理限制。這不是永久歷史或啟動復原；Plan 025 生命週期工作仍待執行。

最後自動化版本：`pnpm acceptance:regression` 通過 **38 個檔案、589 個測試**、**86/86 設定案例**及快捷鍵整合，清理完成。證據：[設定](../../verification/measurements/2026-09-24T16-03-37-364Z-settings-acceptance/report.md)、[快捷鍵整合](../../verification/measurements/2026-09-24T16-03-54-220Z-shortcut-failure/report.md)、[實作與保留紀錄](../../verification/measurements/2026-09-24-recording-error-ui/implementation.md)。已檢查最小尺寸雙語明暗結果版面；真實滑鼠／鍵盤案例涵蓋確認、收合、重開與按下至放開間替換錯誤。保留前次失敗：首次 fixture 的 Enter 重開失敗已修正；擴充測試的一次 TypeScript mock 回傳推斷與測試清理方法錯誤已修正。

Claude Opus 5.5 xhigh 第一輪提出六項，全部接受並修正：過時通知路由文件／無用 API 與測試、finish 關檔不確定性、誤導的上次錄影文字、依平台的權限復原、顯示檔案失敗後仍宣稱保留，以及正式非同步／操作／IPC 測試缺口。新增實際 writer 不確定狀態的 recorder 測試、注入依賴的正式 receive/action 測試，以及 SettingsWindow 指定操作與 applied 結果測試。自行檢查另修正滑鼠操作跨錯誤識別與重複 focus 賦值。


最終原始碼的[原生驗收](../../verification/measurements/2026-09-25-error-ui-native-final/report.md)：5 項通過／3 項受阻／0 項失敗。全新 `pnpm start:app` 驗證 9 個 bundle 身分；`pnpm acceptance` 錄製 10.3 秒、1920×1080、48 kHz 雙聲道、RMS −27.2/−27.2 dBFS、10 次閃光／嗶聲及完整解碼通過。QuickTime 原生播放／跳轉通過。App／helpers、播放器及素材均退出，偏好未變。產物 app.asar SHA256：`8a952878f640223aa45b55c5b7ca8720b7b4e287d8eb37406cbdb45d26c07c0e`；HEAD `140746a8ab20365fcfddc90d1286b77c651d377f` 加未提交開發變更。工具沒有 desktop／tray target，SystemUIServer 逾時，故警告標記／選單、原生受控失敗結果操作與錯誤通知點擊受阻；同任務前輪已通過普通設定入口，但 fixture 不代表這些 OS 行為通過。完整畫質／音訊／fps／長錄影矩陣、權限重設、拔裝置與存檔通知安裝測試不屬本次影響範圍。track settings 回報 1920×1920，實際影格為 1920×1080 並通過尺寸檢查；未宣稱主觀聽感或發布驗收。


Claude Opus 5.5 xhigh 第二輪確認前六項程式／測試修正，只新增兩項 Low 文件問題：繁中區塊名稱不一致，以及中英文設計總覽仍稱不保留錯誤狀態。均接受並修正；最後回歸與原生驗收後沒有改動執行程式。兩輪完成（612.2 秒＋346.0 秒），未 fallback、未執行第三輪。最後連結／錨點、package 指令、雙語一致性與 `git diff --check` 通過。


## 設定視窗尺寸記憶 — 2026-09-24

Plan 022 結案後的追加需求：保存使用者調整的寬高，關閉重開與下次 App 啟動還原。預設改為 560×680，最小 380×360；已檢視繁中淺色一般分頁，精簡頁首後可容納一般內容且減少空白。獨立 `settings-window.json` 採 250ms 合併與關閉／退出 flush，不更動錄影偏好；開啟時配合游標所在螢幕工作區限制並置中。

`pnpm acceptance:regression` 通過 555 tests、[76/76 設定面板](../../verification/measurements/2026-09-23T17-33-22-411Z-settings-acceptance/report.md)、[40/40 整合案例](../../verification/measurements/2026-09-23T17-33-37-631Z-shortcut-failure/report.md)，測試程序及暫存資料清理完成，`git diff --check` 通過。新增單元測試涵蓋跨實例持久化、無效檔案、失敗保存、螢幕限制、合併寫入、關閉重開與退出 flush；真正 Electron 視窗 resize 後兩輪重開維持 620×740，下一個程序還原 640×760，錄影偏好未被更動。GPT-6 Astra 獨立 review 無 findings。本輪未重建使用者正式 App，也未新增錄影或原生 computer-use 驗收。

## Plan 022 結案 — 2026-09-24

最終 `pnpm acceptance:regression`：549 tests、[76/76 面板案例](../../verification/measurements/2026-09-23T17-24-28-392Z-settings-acceptance/report.md)、[36/36 整合案例](../../verification/measurements/2026-09-23T17-24-43-761Z-shortcut-failure/report.md) 全部通過，程序及暫存資料清理完成；`git diff --check` 通過。已檢視繁中淺色一般分頁的最終 footer 截圖。Review Pass 2 無新增 findings，R4 已確認修正。

維護者明確確認：最新版自訂快捷鍵按「確定」已成功；先前亦確認設定入口、錄製／播放、快捷鍵與外觀操作正常。最後要求底部左側顯示「由 Eric Tsai 製作」（英文 Built by Eric Tsai），右側以官方網站與 GitHub 原始碼圖示表達，保留雙語名稱、hover 提示、鍵盤操作與既有固定網址授權。內容區維持精簡分頁，不重複 App 名稱；底部捲動提示僅模糊漸層、不含箭頭，游標只在可操作區使用手形。

維護者指示完成上述修改後結案，並明確不再執行剩餘人工驗收。因此 VoiceOver、原生增加對比、完整原生狀態矩陣、新錯誤介面的實體螢幕拔插／恢復及易用性、最終圖示連結由外部瀏覽器開啟，保留為**已接受的未測限制，不標示測試通過**。歷史測試、失敗、工具阻礙及 review findings 保留下文；此結案記錄取代舊段落的待辦狀態，不回寫歷史結果。沒有新增錄製品質或跨平台驗證宣稱。

最終 footer scoped GPT-6 Astra review：R4/P2 指出 `.about button` 的 32px 圖示尺寸會擠壓失敗後的文字重試按鈕；接受，限定為 `.about .controls > button`，並加入連結失敗後重試按鈕可讀且圖示保留的 fixture。先前 review 的 R1（錯用靜態說明作儲存錯誤）、R2（Tab 落在即將隱藏的取消按鈕）、R3（fixture 等錯儲存列）均已修正，詳見原紀錄。Claude 因維護者額度限制未使用；review 為獨立 GPT-6 Astra。

設計定案已移入雙語 desktop 文件，計畫索引已更新，022 雙語計畫檔依 plans/README 規則移除。不包含 commit、push、tag 或發布。

## 快捷鍵確定按鈕滑鼠修正 — 2026-09-24

最終 `pnpm acceptance:regression` 全部通過：549 tests、75/75 面板、36/36 整合；證據目錄 17-08-05 settings-acceptance、17-08-20 shortcut-failure，清理完成。

維護者回報按確定沒有變化。將原本 `element.click()` 測試換成 Electron 真正 mouseDown/mouseUp 後，[修正前案例](../../verification/measurements/2026-09-23T17-05-57-796Z-shortcut-failure/report.md) 重現：候選仍在預覽，按鈕點擊讓擷取先取消，設定維持原值。修正確定按鈕左鍵 mousedown 的預設焦點行為，讓 click 完成前保留擷取焦點，避免 focusout 清除候選；主程序驗證、儲存及鍵盤操作不變。

加入 mousedown 回歸並將所有正常提交與保留組合驗證改用真實滑鼠事件。[修正後整合](../../verification/measurements/2026-09-23T17-07-29-281Z-shortcut-failure/report.md) 36/36 通過，含持久化、重啟、拒絕與恢復，清理完成。首次修正後執行另在候選前遇到 renderer evaluation 錯誤（17-07-04），未視為通過；已改善腳本錯誤上下文，保留該失敗證據，後續重跑通過。GPT-6 Astra scoped review 無 findings。本轮未更新使用者正式 bundle，不冒充原生 computer-use 驗收。

## 單一建議快捷鍵 — 2026-09-24

依維護者確認，選單只提供「建議：⌘⇧1」、目前自訂值（若有）、自訂入口及關閉。舊 preset 已儲存者保留原快捷鍵並標為自訂；改回建議值不保留自訂歷史。未更動儲存格式或預設快捷鍵。`pnpm acceptance:regression` 通過 549 tests、75/75 面板、36/36 整合，清理完成；`git diff --check` 通過。新增模型回歸涵蓋各舊 preset 的保留與標示、單一建議及重設後選單精簡。GPT-6 Astra scoped review 無 findings。證據：[面板](../../verification/measurements/2026-09-23T17-02-07-655Z-settings-acceptance/report.md)、[整合](../../verification/measurements/2026-09-23T17-02-23-046Z-shortcut-failure/report.md)。本輪未重建使用者正式 App，原生待驗範圍不變。

## 快捷鍵確認與捲動提示 — 2026-09-24

自訂快捷鍵現在先保留本地候選，按確定或無修飾鍵 Enter 才保存；取消、失焦或既有 15 秒逾時不保存。有候選時 Tab 可移到確定／取消，提交中不重複送出並保留焦點。再次檢查更新保留上次結果，避免結果區收合再展開。正常配色隱藏 scrollbar，以底部非互動漸層玻璃提示剩餘內容，捲到底／可完全容納時消失；輔助對比及透明度模式有替代呈現。

`pnpm acceptance:regression`：548 單元測試、75/75 設定面板案例、36/36 正式 main 整合通過；型別／建置與 `git diff --check` 通過。新增確認前未保存、取消候選與防重送、更新前次結果保留、真實 Electron 節點／下方座標穩定及捲動提示 top/bottom/fits 斷言。已檢視最小尺寸深色玻璃提示截圖。證據：[面板](../../verification/measurements/2026-09-23T16-55-43-040Z-settings-acceptance/report.md)、[整合](../../verification/measurements/2026-09-23T16-55-58-586Z-shortcut-failure/report.md)。清理完成。GPT-6 Astra 獨立 scoped review 無 findings。

本輪未重建或操作使用者的正式 bundle，確認步驟與新捲動提示尚無原生人工驗收。先前使用者確認的錄製／播放、快捷鍵及外觀測試仍有效，但不擴張到本輪新互動。Plan 022 尚待原生 VoiceOver／增加對比、新錯誤介面實體螢幕恢復／易用性、官方連結開啟，以及結案文件整理；自動測試全過不代表所有人工測試皆完成。

## 設定互動與精簡頁首 — 2026-09-24

維護者明確回報上一版「最新版實際操作」全部正常：自訂／取消／預設／關閉快捷鍵、深淺色／系統外觀與重啟保留，以及短錄影／播放與錄影鎖定。此為人工回報，並非本輪新增原生觀測，也不表示 VoiceOver／增加對比或實體拔插新錯誤介面已驗收。

後續依回饋移除內容區圖示、大標題、自動儲存說明；保留原生標題與輔助使用 h1。滑鼠不留焦點外框，鍵盤導覽保留；快捷鍵選項與 action 依 id 就地更新，儲存狀態不再推動下方版面，暫時停用不讓分段選擇閃暗。新增三線監聽動畫，遵循減少動態效果；開啟通知設定不顯示套用文字，失敗才顯示操作錯誤。

`pnpm acceptance:regression` 通過 546 tests、70/70 面板案例、34/34 正式 main 整合案例；`git diff --check` 通過。新增 DOM 身分保留、動態 action 失敗與無套用文案測試，實際 Electron 驗證鍵盤焦點框／pointer 移除、儲存期間下方座標穩定、監聽指示及減少動態效果。已檢視繁中淺色監聽截圖，確認內容由分頁開始。證據：[面板](../../verification/measurements/2026-09-23T16-45-11-148Z-settings-acceptance/report.md)、[整合](../../verification/measurements/2026-09-23T16-45-25-800Z-shortcut-failure/report.md)。測試程序及暫存資料清理完成；未重建使用者 bundle、未新增原生錄製或 VoiceOver 證據。獨立 GPT-6 Astra scoped review 無 findings，Claude 依先前 quota 指示未使用。

## 快捷鍵選單與外觀偏好 — 2026-09-24

依使用者要求移除獨立自訂快捷鍵按鈕，統一從選單進入；目前自訂值標示「自訂」，取消保留原值，擷取中不重複啟動。新增可保存的跟隨系統／淺色／深色外觀，啟動時還原，錄影中亦可改。既有設定已自動跟隨系統。

`pnpm check`：546 tests 通過。設定面板 fixture：66/66 通過，含雙語、深淺色、窄視窗及真實 Tab／Shift+Tab。正式 main/IPC/preload/page 整合：34/34 通過，含啟動套用深色、三種外觀切換、CSS media query 與存檔一致；所有測試程序與暫存資料清理完成。證據：[設定面板](../../verification/measurements/2026-09-23T16-26-51-185Z-settings-acceptance/report.md)、[整合](../../verification/measurements/2026-09-23T16-27-54-858Z-shortcut-failure/report.md)。未重建使用者正式 bundle，未重測實際錄製或 VoiceOver。

獨立 GPT-6 Astra scoped review（依使用者指定，Claude usage 已達上限）：Pass 1 R3/P2 指出 fixture 等錯 hotkey 列，通知／外觀仍在儲存便開始擷取造成逾時；接受並改為等待所有 Applying 清空。另調整外觀測試順序，避免合法儲存先標準化舊快捷鍵而干擾 migration 斷言。兩次失敗保留於 16-27-05、16-27-33 測量目錄，清理皆完成。Pass 2 無 findings；最終整合通過。

## Plan 022 頁首與底部精簡 — 2026-09-24

依維護者要求移除底部重複名稱，保留官方連結；頁首改用既有 icon 加「RecordStuff - 設置」／「RecordStuff - Settings」，原生視窗標題同步文字。`pnpm acceptance:regression` 通過 543 單元測試／型別／建置、[設定 fixture 66/66](../../verification/measurements/2026-09-23T16-20-21-125Z-settings-acceptance/report.md) 及 [快捷鍵整合 30/30](../../verification/measurements/2026-09-23T16-20-36-342Z-shortcut-failure/report.md)，清理完成。新增斷言確認圖示在正式 CSP 下從打包資產載入，以及底部保留兩個連結但沒有名稱。已檢視繁中淺色一般分頁截圖；本輪未重建或操作維護者正在使用的原生 App。

## Plan 022 人工入口驗收 — 2026-09-24

維護者回報已完成並通過：無錄影時以 ⌘⌥, 開啟設定、⌘W 關閉、由 Tray「設定」重開。兩個入口可用，關閉面板不退出 App 或開始錄影。這是維護者回報，不是新增 computer-use 觀測；不擴張為其餘原生矩陣已通過。此案例在沒有相關變更前不必重做。維護者要求將可重複案例腳本化，新增 `pnpm acceptance:regression`，整合 fixture 補上重複入口／關閉回歸。

本次 `pnpm acceptance:regression` 全部通過：36 檔／543 單元測試、型別與建置、[設定 fixture 64/64](../../verification/measurements/2026-09-23T16-17-01-163Z-settings-acceptance/report.md)、[快捷鍵整合 30/30](../../verification/measurements/2026-09-23T16-17-15-711Z-shortcut-failure/report.md)，隔離程序與暫存資料清理完成；此輪未操作或退出維護者的 App，未新增錄影。追加範圍由 GPT-6 Astra 獨立唯讀 review，無實質 findings。

## Plan 022 開發驗證 — 2026-09-23

設定面板已具備分組控制項、行內診斷／復原、單一自訂快捷鍵入口、固定標題／分頁與固定網址連結。**下列範圍已驗證，計畫仍保留待完成的原生／人工矩陣。** `pnpm check` 通過 36 檔／543 測試、TypeScript 與正式建置。[設定 fixture](../../verification/measurements/2026-09-23T15-44-30-335Z-settings-acceptance/report.md) 64/64：保留 CSP／sandbox／只傳 id IPC／儲存順序，加入開關／分段／行內失敗、40 組雙語明暗預設／最小尺寸狀態截圖（無水平或外層溢位）、實際 Tab／Shift+Tab 退出及模擬 forced-colors 的原生控制項退場。[快捷鍵整合](../../verification/measurements/2026-09-23T15-39-13-638Z-shortcut-failure/report.md) 25/25 且清理完成；受控失敗不等於 OS 衝突或通知橫幅實測。

[原生報告](../../verification/measurements/2026-09-23T1547-plan022-computer-use/report.md) 保留 9 pass、2 歷史 fail、1 blocked、7 not run。已觀察雙語淺色排版、首輪擷取／Esc、最終深色錄影分頁與紫色系統 accent 下的 App 配色、還原及播放。首輪把擷取暫停誤顯示成快捷鍵衝突，已修正並通過測試；最終啟動前過早送設定快捷鍵曾逾時，ready 後重跑通過。最終擷取視覺重測因 AX／截圖不同步及 `noWindowsAvailable` 受阻，不以 log 代替通過。曾與同台 Mac 的系統設定比較，並還原淺色／多色。改版前僅有舊 fixture 四組語言／配色截圖，不是完整原生狀態矩陣；改版後截圖在 fixture 報告，原生截圖僅為對話中的工具觀察，不虛構本機路徑。

[最終產物錄影](../../verification/measurements/2026-09-23T15-43-34-401Z-hotkey-acceptance/report.md) 通過開始／停止／存檔及完整性驗證：10.2 秒、1920×1080、48 kHz 雙聲道、RMS −26.5/−27.2 dBFS、6 閃光／9 嗶聲。QuickTime 播放至 10.2258 秒，跳轉至 4.98985 秒。素材實際為視窗並與設定並列，不宣稱全螢幕覆蓋；幀時序、同步及主觀聽感未驗。原偏好及系統外觀已還原，RecordStuff/helpers 已退出，測試影片及後續選檔視窗已清理。基底 `ae06f8177fe942f6d4301c3ac532927123c4e569` 加未提交變更，Darwin 25.6.0 arm64／Electron 44.3.0，本機簽章 0.1.5。

依使用者要求，Claude 額度不足而改用同模型 GPT-6 Astra 獨立 review。Pass 1 的 R1（靜態說明誤當儲存拒絕原因）、R2（Tab 焦點移至即將消失的取消按鈕）均接受、修正並補回歸測試；Pass 2 無 findings。CLI 未產出完成結果，兩輪由獨立 reviewer agent 完成；詳見 [review 紀錄](../../verification/measurements/2026-09-23T1547-plan022-computer-use/review.md)。Fixture import／舊 selector／3px 外層溢位的歷史失敗也保留於原生報告。

待驗：實體螢幕拔除／重接／復原及通知開關、操作者理解與復原、完整原生雙語明暗最小尺寸錯誤／擷取／鎖定矩陣、VoiceOver／增加對比、原生官方連結開啟及失敗、最終 Custom／preset／Off 與錄影中語言操作、Tray 入口（入口已於 2026-09-24 人工驗收通過，見上節；其餘未驗項保留）。未做發布、跨平台驗收、commit、push 或公開發布。

## Plan 020 開發驗證 — 2026-09-23

自訂快捷鍵實作通過 `pnpm check`：31 個測試檔、466 個測試、TypeScript 與正式建置。涵蓋驗證與標準化（含 Shift 標點／保留組合別名）、自訂值與 Off 儲存、模型授權、暫停／延後請求／退出、錄入生命週期、提交焦點與 Tab、實體鍵映射、失敗通知去重，以及驗收工具讀取最新註冊狀態。

第一份開發產物由 `pnpm start:app` 建置、自簽及驗章，環境 macOS 26.6.2 arm64／Electron 44.3.0，基底 `09b0493a546c2776e712401c425374512da98000` 加未提交變更。第一輪保留 standard/source/60 fps、繁中、原輸出位置與 ⌘⇧1；`pnpm acceptance` 完成開始／停止／存檔，10.3 秒、1920×1080、48 kHz 雙聲道、RMS −27.2/−27.2 dBFS、9 次閃光／9 次嗶聲，完整解碼無錯誤。QuickTime 播放前進至 9.62 秒，定位 4 秒成功。完整性檢查通過；55.32 fps、掉幀 2.58% 僅回報，不判定時間表現，亦不代表同步、主觀聽感或長錄影驗證。

起初原生選單列存取回 `-10005 timeoutReached`；維護者開啟設定後，computer use 已驗證同鍵重錄不會開始錄影、缺少修飾鍵的錯誤、Escape 取消，以及 `Control+Shift+K` 的保存與註冊；重啟 log 仍註冊同一自訂值。原生 log 發現提交時舊快捷鍵過早恢復，review 修正已保留焦點並避免 blur 取消。首次自訂驗收也重現舊 log reader 錯誤：腳本送出啟動時的舊快捷鍵並逾時；現已改讀最新註冊／暫停狀態。保留這些失敗證據，不把初版當作最終驗收。

修正 log reader 後，[自訂快捷鍵驗收](../../verification/measurements/2026-09-23T0558-hotkey-acceptance/report.md) 已在第一份產物以 `Control+Shift+K` 通過：10.3 秒、1920×1080、左右聲道 RMS −27.2/−27.2 dBFS、10 次閃光／嗶聲；QuickTime 播放前進至 8.77 秒。這證明自訂錄影路徑，不代表後續程式修正已做原生回歸。測試快捷鍵其後已在下述最終產物驗收中還原為原有 ⌘⇧1。

QuickTime 關閉測試影片後曾遺留「打開」視窗；其後透過原生 UI 取消，回傳 `noWindowsAvailable`。驗收 skill 已要求收尾時檢查並取消這個遺留對話框，同時保留使用者原有文件。

本機證據：[computer-use 報告](../../verification/measurements/2026-09-23T0548-computer-use/report.md)、[初次錄影報告](../../verification/measurements/2026-09-23T0548-hotkey-acceptance/report.md)。下述最終產物結果取代先前待重建／還原狀態；見 [Plan 020 結案](#plan-020-結案--2026-09-23)。

### 最終重建產物 — 2026-09-23 06:08 UTC

兩輪 review 後以 `pnpm start:app` 重建、自簽及驗章最終程式。[自訂驗收](../../verification/measurements/2026-09-23T0608-hotkey-acceptance/report.md) 以持久化的 `Control+Shift+K` 通過：10.3 秒、1920×1080、48 kHz 雙聲道、RMS −27.2/−27.2 dBFS、10 次閃光／嗶聲、無解碼錯誤。原生 UI 確認同鍵重錄不開始錄影、提交後保留焦點、Tab 取消，以及實體標點 `Control+;`／`Control+Alt+;`；log 不再出現中途舊鍵註冊。QuickTime 播放至 10.25 秒、定位至 4.02 秒，遺留 Open 視窗取消後確認 `noWindowsAvailable`。

原有 ⌘⇧1 已從設定還原，06:10:39 UTC 確認保存與註冊；RecordStuff 留在 idle、Settings 開啟供檢視，測試 fixture 與素材播放均已結束。刻意跨程序重複註冊 **未觸發 OS 拒絕**：兩個 Electron 程序對 `Control+Shift+J` 都回報成功。因此拒絕說明／通知仍是 blocked，不能當通過，Plan 020 保留此待驗項。非 US 配置及原生慢寫入故障注入未測，Shift 標點的工具送鍵未取得可判定結果。[最終原生報告](../../verification/measurements/2026-09-23T0608-computer-use/report.md)：8 pass、0 fail、1 blocked、2 not run。56.60 fps、2.85% 掉幀只回報，完整性層級不判定幀率。

## 環境與證據

已測環境：Apple M1 Pro、macOS 26、Electron 44.3／Chromium 152；外接 1920×1080 與內建 Liquid Retina XDR 3456×2234。安裝產物為 macOS arm64，自簽身分 `recordstuff Dev`。Intel、其他 macOS 版本、Windows、Linux 與另一台 Mac／新帳號未驗；使用者已決定不以這些驗收作為目前發布前置。

原始量測（`pnpm verify`、`pnpm matrix`、`pnpm acceptance`、`pnpm audio:quality` 與 computer-use 驗收報告）寫到 `docs/verification/measurements/`；該目錄已 gitignore，只留在產生它的機器上。本文與 [releases/](releases/) 是對外發布的整理結論。下文提到的歷史原始檔（2026-09-13 到 2026-09-19）在 commit `acc6342` 之前曾被追蹤，仍可從 Git 歷史讀取；舊結果中的 fail／n/a 與錯誤試跑如實保留，不能因後續調整門檻而回寫成當時全過。

## 已取得的結果

| 項目 | 證據／結果 | 解讀限制 |
| --- | --- | --- |
| 1080p30 標準 10 分鐘 | 600.0 秒、569.6 MB、7.92 Mbps、29.30 fps、掉幀 0.39%，Electron 合計 CPU 平均 17%／峰值 21% | 動態測試素材；不代表任意解析度或機器負載 |
| 硬體編碼 | 錄製時出現 VTEncoderXPCService，約 1.4–1.9% CPU，停止後消失 | 本機 H.264 證據 |
| 音畫同步 | 552 對標記，頭 89 ms／尾 93 ms、結尾漂移約 3 ms，音訊−影像時長差 −2 ms | 偵測器約 10 ms 偏差；不同段固有延遲約 45–80 ms |
| 30 fps 品質等級 | 精省／標準／高約 4.4／8.1／14.9 Mbps，接近目標 | 係數保留 0.07／0.13／0.24 |
| 60 fps | 約 57 fps、標準約 31 Mbps、CPU 約 23%，檔案約 223 MB/分 | 未完全達到 fps／位元率門檻；使用者接受後開放 macOS |
| 系統音訊 | 有聲內容 AAC 約 160 kbps；請求 2 聲道後是 dual-mono | 不是 stereo 分離；beep 素材低位元率不可視為完整音質驗證 |
| 播放與殘檔 | QuickTime 可開／拖曳；殺 renderer 後保留 17.64 秒、11.5 MB 的 `.recording.mp4`，404 影格可解碼，Chrome 可播 | 部分檔可播為此例結果，不是通用修復保證 |
| Retina | 安裝版原尺寸 22.55／17.43 秒錄影均 3456×2234；最新段全段可解碼且有聲 | 已修正首片與 getSettings 尺寸問題 |
| 自簽／更新 | DMG 安裝、深度嚴格簽章與內容驗證；同憑證同路徑內容更新後螢幕權限保留，音訊實錄成功 | ad-hoc → 自簽是不同身分，不能混入 A/B 更新結果 |
| 首次螢幕授權 | scoped reset 後使用者看到提示、操作設定與選單重啟，新程序 granted | 沒有證明每個 macOS 首次授權一律需重啟 |
| 首次音訊拒絕 | 使用者確認提示並按不允許，no_audio_track、回 idle、無新增影片 | 明確拒絕證據已補齊 |
| 音訊權限復原 | 同程序啟用並選稍後仍失敗；重啟後 15.34 秒有聲檔可解碼 | 該情境需要重啟 |
| 錄製中撤銷／退出 | OS 結束重開前收尾完整 47.594271 秒 MP4，新程序 needsPermission | 不是強制斷電測試 |
| 最後復原 | `2026-09-14 00-17-33.mp4` 12.653633 秒、45,041,905 bytes，1080p H.264＋48 kHz AAC 雙聲道，全解碼成功；使用者確認可播 | 完成當時的本機結果 |
| 通知 | 使用者看到錯誤與存檔通知，點擊有 Finder 回報與 reveal 日誌。點擊後的前景現由 `pnpm acceptance:notification` 覆蓋（[2026-09-20](#通知點擊後-finder-置前--2026-09-20)） | macOS 26.6 上約 40 次點擊會有一次橫幅按下去但點擊未送達 App；根因未證實；後續 30/30 本機矩陣已獲接受作為計畫結案依據 |
| 通知縮圖 | 2026-09-14 使用者確認整台 Mac 重開機後正常 | 原待確認項目已關閉，具體原因未查明 |
| 全域快捷鍵 | 對無視窗的 `/Applications` 建置執行 `pnpm acceptance`（柔化後的 660 Hz 素材、Chrome app 模式全螢幕）：System Events 送出 ⌘⌥⇧R 後 166 ms 收到、再 96 ms 進入 recording，錄 20 秒存檔，完整性層級通過，48 kHz 雙聲道 RMS −27.1／−27.2 dB，偵測到 20 次閃光與 19 個嗶聲，音畫偏移 79 ms（報告）；Codex computer-use 以同一送鍵路徑完成素材、錄影、verify 與 QuickTime 播放（23:34 執行） | 稀疏素材的音訊碼率只回報；背景播影片的一次執行被嗶聲守門拒絕（0 個嗶聲可與靜音分離），驗收時背景音訊必須關閉；Computer Use 的 `pressKey` 到不了全域快捷鍵，三次非互動執行被 per-app 核准擋下（20:56、20:59、21:20、21:33 fail、根因）；Tray 選單案例與聽感仍未由工具驗證 |

## 已驗安裝產物識別

這是當時產物的指紋，不是未來重新打包後仍可沿用的 checksum，也不是公開下載連結。

| 項目 | 值 |
| --- | --- |
| DMG | `dist/local/recordstuff-0.1.0-arm64-selfsigned.dmg` |
| DMG bytes | 126,081,923 |
| DMG SHA-256 | `a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc` |
| app.asar SHA-256 | `c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274` |
| 公開憑證 SHA-1 | `01B373511530BBF287CA35E54C10A5F017AAD637` |

私鑰仍由開發者持有，不放入 repo／下載檔。驗證當時的影片與 `/tmp` 日誌可能已被清除；此處保留數據，不承諾暫存證據一直存在。當時最後完整程式檢查為 13 個測試檔、211 tests、typecheck／build 通過。新的語言功能需另外通過本次檢查並產生新版安裝包；舊 DMG 不代表已測新語言功能。

## 可重複的驗收方法

工具、指令與目前門檻見 [建置與驗收工具](../system-design/tooling.md)。基本功能回歸可用短錄＋完整解碼，品質／同步改動再跑相關矩陣；`long` 現為 3 分鐘，10 分鐘基準已做過，不因文件整理重跑。只有工具全部適用指標 pass 才稱自動判定通過；n/a、素材限制與使用者接受的偏差都需單列。

本地 DMG 不等於公開下載證據；後續已完成的公開下載／安裝驗證見 [v0.1.0 紀錄](releases/0.1.0.md)。

## 文件與語言功能更新 — 2026-09-14

本次英文正式文件及可保存的英文／繁體中文 App 功能已通過 pnpm check：14 個測試檔、221 tests、typecheck 與 build。涵蓋 placeholder 一致性、舊設定英文預設、保存失敗與並行更新、錄製中切換呈現，以及通知語言與點擊動作。pnpm matrix -- quick --dry-run 的英文輸出正常；文件本機連結與 git diff --check 已檢查，搬移的歷史 Markdown／JSON 與 Git 原檔逐位元相同。

此次未產生新的自簽安裝包、未做新的原生介面錄製驗收或公開發布；這些仍由下載版計畫追蹤。

## 音質自動化測試 — 2026-09-14

新增 `pnpm audio:quality`（[用法與門檻](../system-design/tooling.md#音質迴歸測試)）。`pnpm check` 通過：15 個測試檔、232 個測試、型別檢查與建置，包含實際 FFmpeg AAC／低通／格式／CLI 整合測試。正常 PCM 與 FFmpeg AAC 通過，刻意劣化的素材失敗。新增開頭短暫聲音的迴歸案例保護標記對齊；標記或靜音間隔無效時，不輸出會造成誤判的頻率量測。

完成版 macOS 自動流程透過未修改的程式擷取路徑錄製 16 秒。原始報告 為 **fail**，不是音質通過的基準：48 kHz／雙聲道格式與標記檢查通過，但 1 kHz 聲道分離約 0 dB（要求 ≥30 dB）；左右探測序列的 12 kHz 響應相對各自 1 kHz 為 −20.44／−12.64 dB，16 kHz 為 −74.72／−66.73 dB。其餘增益／殘餘能量失敗也保留在報告。PCM 素材與 FFmpeg AAC 對照組能通過相同頻率檢查。

這證明此機器的「播放 → 系統擷取 → AAC」路徑有高頻流失與雙單聲道現象，與使用者反映聲音悶的情況一致，但尚未定位負責的環節。依序播放音調也可能量到隨時間變化的增益，因此兩個聲道序列的響應差異不代表硬體不對稱。未控制或量測裝置／音量，門檻屬初始工程標準。工具未更改程式音訊設定，也尚未修復音質。素材與擷取紀錄保留在 `/tmp/recordstuff-audio-quality-20260914-final`，MP4 路徑在原始報告中；暫存檔日後可能被清除。本次未產生新安裝檔。

## 音質診斷 v2 穩健性修復 — 2026-09-14

[設計教學](../system-design/audio-quality.md)記錄原因、演算法、門檻與限制。已重現兩個 v1 問題：刪掉每段 600 ms 探測音的前後各 100 ms 仍通過，而只有 10 ppm 時鐘偏差的乾淨訊號卻會在殘差檢查失敗。v2 以各成分的重疊視窗，以及有限頻率估計／最小平方擬合修正這些案例。同時 pilot 正規化也將區段間增益變化與頻率響應分開；結尾標記避免只靠補靜音就冒充完整素材。

`pnpm check` 通過：15 個測試檔、254 個測試，其中 **33 個是音質工具測試**，另包含型別檢查與建置。對照涵蓋獨立相位的 ±10／20／100 ppm、過大時鐘偏差、實際 FFmpeg AAC／低通／格式解碼、邊緣／中央／僅目標音斷音、結尾插入 50 ms、局部削波、無效標記、多次摘要、未完成 batch，以及 CLI 保存與結束碼。文件目標、雙語章節與 `git diff --check` 通過。本次未修改正式音訊處理。

完成三次真實 v2 擷取：**0 次 pass、2 次 fail、1 次 invalid**。摘要維持 invalid。第 1 次標記間隔量得 −22.63 dB，未達素材辨識要求的 −30 dB，因此未輸出缺乏依據的頻譜欄位。第 2／3 次標記有效並保留失敗：1 kHz 聲道分離約 0 dB，16 kHz 相對同時 pilot 的響應，左側為 −46.64 到 −46.48 dB，右側為 −44.14 到 −43.85 dB。另有部分殘差／增益／12 kHz 失敗，詳見第 1 次、第 2 次及第 3 次。

前／後裝置與音量快照相同。這是端點證據，不代表持續控制了整個環境。無效量測不納入各指標範圍，並明確計入缺少數量。這些是失敗證據，不是經校準的通過基準。v1／v2 的素材與估計方式不同，不能把精確 dB 差異當作產品改善前後比較。原本 v1 證據未改寫。暫存素材／log 留在 `/tmp/recordstuff-audio-v2-20260914`，每份報告都有 MP4 路徑。本次未產生新安裝檔。

## 系統音訊處理修正 — 2026-09-14

擷取端現在明確關閉回音消除、降噪與自動增益，保留排除自身聲音與 ideal 立體聲，詳見[設計說明](../system-design/audio-quality.md#15-系統擷取修正2026-09-14)。對照期間沒有改變素材、分析器或門檻。第一輪試驗已恢復高頻響應，但開頭仍有雜訊／聲道分離／間隔失敗。

最終程式的重複量測為 **2 pass、0 fail、1 invalid**，前後裝置與音量快照相同。摘要刻意維持 invalid：第 1 次標記間隔辨識失敗（−18.81 dB）。第 2 次和第 3 次所有門檻都通過。這兩次有效量測的左右 16 kHz 相對同時 pilot 差異在 0.004 dB 內，先前有效基準則約 −44 到 −47 dB；立體聲分離也從約 0 dB 恢復到超過 30 dB 門檻。接近數值下限的極大分離值，代表漏入另一聲道的能量極低，不是經校準的硬體規格。

環境證據：前／後。若請求 false 後音軌明確回報效果仍啟用，程式會留下 warning；沒有回報則維持未知。本次實驗定位的是三個設定一起更改對本機路徑的修正效果，不是每個效果各自的貢獻。既有錄音檔未改動。

修正驗證：`pnpm check` 通過 15 個測試檔／255 個測試、型別檢查與建置。`pnpm start:app` 建置、自簽、驗證九個 bundle 身分後，開啟 `dist/dev/mac-arm64/recordstuff.app` 供聽感比較；未取代 `/Applications` 的副本。文件目標與 `git diff --check` 通過。

## macOS 0.1.0 發行 — 2026-09-15

[本版產物及下載路徑證據](releases/0.1.0.md)。已公開發布，安裝候選版檢查通過但有 Finder 未置前限制；瀏覽器下載後安裝及錄影已通過，首次需「仍要打開」；使用者回報與本機限制見本版紀錄。上方歷史雜湊保留原值。

## 精簡安裝介面與 tag 觸發發布 0.1.2 — 2026-09-19

0.1.2 原始碼從 DMG 移除隨附指南並加入程式產生的箭頭背景；發布閘門現在要求恰為 App 與 Applications 連結。本機 `pnpm dist:mac` 建置通過候選閘門與 Finder 版面檢查；`pnpm start:app` 加手動 16.7 秒錄影通過完整性檢查；可丟棄副本移除後使用者資料未變；推送 `v0.1.2` tag 後不到三分鐘公開，匿名公開下載驗證 job 於 22 秒內通過。見 [0.1.2 證據](releases/0.1.2.md)與[發布自動化](../system-design/releases.md)。verifier 同日改為完整性與效能兩層，見[工具鏈](../system-design/tooling.md#驗收門檻)。

## 通知點擊後 Finder 置前 — 2026-09-20

計畫 014 以新的無人值守檢查 `pnpm acceptance:notification`（[工具鏈](../system-design/tooling.md#通知驗收)）在已安裝的 0.1.2 與 macOS 26.6.2 上重現 v0.1.0 的回報：在新的 TextEdit 視窗在前時透過輔助使用按下「已儲存 …」橫幅，取樣前景 App 3 秒。加了 `did-become-active` 診斷的 App log 給出機制：macOS 在點擊回呼後約 110 ms 才啟動發通知的 App，且只針對登錄在 `/Applications` 的那份；當這個啟動晚於 Finder 的啟動，無視窗的 App 就留在最前面，Finder 在使用者視窗後方選著檔案。同一程序的第一次點擊很少發生。未修正的 0.1.2 在 Finder 關閉狀態點 6 次，2 次 RecordStuff 留在最前面（1756 執行）；同一版本後來的 5 次點擊有 3 次失敗、包含第一次（1818 執行，其中一次是點擊未送達）；診斷版同樣 6 次中 2 次，且每次失敗的 reveal 後 4 ms 就記到 `did-become-active`（1748 執行）。

修法（reveal 後掛 1 秒的一次性 `did-become-active` 監聽，收到就從已是前景的 App 再 reveal 一次，見[桌面](../system-design/desktop.md#tray-與通知)）在本次被裝進 `/Applications`，以 `--full` 的 5 次點擊 × 3 種 Finder 狀態 × 2 種語言判定。30 次預定點擊（含重試共 35 次錄影；1759 執行）中 26 次通過，3 次無法判定（通知中心沒有為該次存檔顯示橫幅），1 次以另一種方式失敗：橫幅按下、App 被啟動，但點擊沒有送達 App（log 沒有 reveal），Finder 根本沒被叫到；未修正版在 1756 執行也出現過一次同樣的未送達點擊。26 次通過中有 13 次 log 記到 `reveal repeated after activation`，也就是 macOS 確實在第一次 reveal 後啟動了 App，第二次 reveal 在約 0.4 秒內把 Finder 放回最前面；沒有任何已送達的點擊以 RecordStuff 留在最前面收場。 每次點擊的檔案選取與前景分開記錄在報告中；英文與繁中橫幅內文皆符合。未涵蓋：tray 選單自己的顯示檔案（輔助使用碰不到 tray，見 016 紀錄）、其他桌面空間、橫幅消失後從通知中心清單點擊；修正後的 bytes 尚未發布。


### 強化後通知腳本實測 — 2026-09-20

以 `pnpm start:app` 建置並簽章目前未提交的程式，在 macOS 26.6.2 arm64 執行預設 `pnpm acceptance:notification -- --install`：退出碼 0，4 次通過、1 次未出現通知（未執行）、無失敗，從首筆 planned 事件到清理完成為 63.555 秒，不需重跑即可結束。另在第二段錄影 starting 時送 SIGINT，訊號後 2.00 秒退出；錄影中送 SIGTERM，1.90 秒退出。兩次取消都正確回傳退出碼 1、停止並存檔、還原 App 與設定。已安裝 app.asar 雜湊與設定檔 bytes 均符合原始快照，八段測試錄影與三份 App 備份皆已刪除；computer use 確認 Finder 沒有殘留視窗。原始證據：`docs/verification/measurements/2026-09-20-notification-live/report.md`（僅本地）。未重測完整六組矩陣、播放／音訊、權限失敗及系統層卡死。未出現通知不算該次點擊通過；本次耗時也不保證能從無回應的 OS 或檔案系統恢復。


### 完整通知矩陣與空白 TextEdit 清理 — 2026-09-20

快速測試後使用者回報的殘留視窗是 TextEdit「打開」面板，不是錄影存檔。舊流程只關閉測試文件、保留空的 TextEdit 程序，再喚起可能重開面板。清理現在會在沒有其他文件時退出 TextEdit，並等待程序消失；有其他文件則保留。

`pnpm acceptance:notification -- --install --full` 在 371.74 秒內完成全部 30 個案例，沒有卡住：**25 通過、1 失敗、4 未執行**，退出碼 1。每個語言／Finder 狀態組都有多次通過。失敗案例為 zh-TW/closed/click 5：橫幅被按下，但 App 沒有 reveal log，RecordStuff 留在前景；根因尚未確認。未出現的通知沒有算通過。程序查詢與 computer-use inventory 均確認 TextEdit 已退出，Finder 沒有視窗；原安裝 app.asar 與設定符合測前快照，30 段錄影與備份均已刪除。`pnpm check` 通過 320 個測試、型別檢查及建置。原始證據：`docs/verification/measurements/2026-09-20-notification-full/report.md`。這證明流程可完成與清理，不代表通知矩陣全數通過。測試不判定視窗所在螢幕；App 錄製主螢幕，且通知點擊發生在停止錄影之後。


### 通知事件與 Accessibility 診斷 — 2026-09-20

補上通知請求、shown、clicked、closed 紀錄並重建後，英文 15 案例 `--full` 於 199.59 秒完成：8 通過、1 前景失敗、6 未執行，退出碼 1。使用者確認期間有操作桌面；該次前景失敗有 shown／clicked／reveal，但 Chrome 變成前景，因此不能認定為產品缺陷。後續兩案例複測均通過。六次未按到通知都有 shown callback，但保存的 Accessibility 搜尋沒有匹配的橫幅節點；其中一次另有視窗索引變動造成的 System Events -1719。問題縮小到通知呈現／存續或 Accessibility 觀察，尚不能證明每次的根因；最後一筆搜尋 timeout 是 5 秒期限，不是另一項 OS 通知錯誤。App／設定已還原、17 段錄影及備份已清除、TextEdit 已退出；321 個測試、型別檢查及建置通過。原始證據：`docs/verification/measurements/2026-09-20-notification-diagnostics/report.md`。

## 儲存通知時序—2026-09-20

Plan 017 開發目標：macOS 26.6.2（25G83）、arm64、Electron 44.3.0；基底 commit `2f1109e53d1033ead10e9866eb7e88cad49fbab9` 加本機修改。capture host 原本已在 `stopped` 前停止 tracks，未發現漏停；新增 renderer `tracksStoppedAt`、主程序收到停止與檔案完成的時間戳。JS track 釋放不代表 OS 通知抑制已解除。

先前完整測試缺少六個橫幅，目前只對有對應證據的案例判定抑制競態。以下為過濾私人內容後的本機時間（UTC+8），檔案 `03-29-21.mp4`：

| 事件 | 時間 |
| --- | --- |
| 請求停止 | 03:29:24.198 |
| Idle／存檔／請求通知 | .216／.217／.217 |
| Electron shown callback | .219 |
| NotificationCenter 螢幕分享 false | .228 |
| DND auxiliary state 清除 | .330 |
| 通知決策 | .330：`resolutionReason: display shared`、`muted by DND suppression: silence`、`canDisplayWhileCenterIsClosed: false` |
| Accessibility | 沒有相符橫幅、沒有 click callback |

先前 17 次停止，螢幕分享 false 到 DND auxiliary clear 相差 101–106 ms。成功對照為 03:28:10：分享 false 在 .520、auxiliary clear 在 .621、決策 .629（`resolutionReason: disabled`），.630 允許顯示。未改系統設定；當時日誌顯示專注模式未啟用、擷取期間抑制有效。舊資料沒有 track-release 時間戳，不能事後重建。

API 查核：[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) 提供來源列舉，[Notification](https://www.electronjs.org/docs/latest/api/notification) 提供通知事件，皆未記載螢幕分享抑制已就緒的訊號。Apple 的 [SCStream stopCapture](https://developer.apple.com/documentation/screencapturekit/scstream/stopcapture(completionhandler:)) 不是 Electron MediaStream 的就緒 API。在這些介面未找到合適的受支援訊號，因此評估 macOS 單次 500 ms 延遲，留出超過實測約 113 ms 存檔到 DND 清除落差的餘裕。這不保證送達、不繞過刻意抑制，不加重試或延長 AX 搜尋。

新擷取與首次退出請求會取消待送通知，退出期間才完成的存檔通知也會略過。寫檔／idle 先完成，再排程；通知例外不會把成功存檔改成失敗。本機證據位於 `measurements/2026-09-20-plan17/`；原生結果如下。


同一份簽章產物連續執行兩輪 `pnpm acceptance:notification -- --install --full --keep-recordings`，**各 15/15 全通過**，fail／not-run 皆為零，沒有重試；從首事件到清理完成分別 226.217 秒、227.824 秒。英文，每種 Finder 關閉／背景／最小化狀態各五次，使用者暫停桌面操作。每個檔案都只有一次請求與 click callback，AX 看見相符橫幅、選取正確檔案且 Finder 在前景。Track stop 到存檔 12–24 ms，通知於存檔後 500–512 ms 請求，DND auxiliary clear 在 track stop 後 107–136 ms。修正後首例：12:04:30.952 track stop、+2 ms 主程序收到、+13 ms 存檔、+17 ms 分享 false、+118 ms DND clear、+516 ms 請求，AX／點擊通過。延遲讓此請求避開實測競態，不代表 OS 的通用上限。

通知待送期間送 SIGTERM，timer 在送達前取消（+159 ms 的 `saved cancelled (shutdown)`），runner 依預期以失敗狀態 1 結束，清理 1.80 秒完成。錄影已存檔，沒有遺留錄製；安裝 app.asar 與設定的 SHA-256 前後一致，測試 TextEdit／Finder 資源及 App 備份完成還原／移除，測試影片保留。另兩次重疊案例在舊通知待送時開始新擷取：舊檔存在、舊通知取消且未請求；新錄影存檔後皆只有一次可點擊橫幅。新通知請求後、點擊前確認文字編輯仍在前景。使用既有 runner 與保留於本機的衍生腳本 `overlap.mts`，未加入產品 hook 或變更系統設定。


同份產物的 `pnpm acceptance` 錄得 10.346 秒、1920×1080 H.264／AAC MP4（standard／source／要求 60 fps）：七個有判定的完整性指標全通過，10 次閃光／9 次嗶聲，48 kHz 雙聲道 RMS −26.8／−27.2 dBFS，沒有解碼錯誤。未判定幀率品質、主觀聽感、聲道分離、音質或長時間同步。原生 QuickTime computer use 確認播放從 0 前進到 4.68 秒，跳到 2.01 秒後繼續前進至 7.58 秒，畫面可見變動中的測試素材。截圖由工具直接觀察，未另存本機圖片。QuickTime 已結束、Finder 只剩桌面，TextEdit 與測試 Chrome 素材程序已清理。原安裝版已還原且待命，新簽章產物留在 `dist/mac-arm64/RecordStuff.app`，36 個測試影片保留於本機。

最終 `pnpm check`：334 個測試、型別檢查與建置通過。Claude Fable 5.1（high、唯讀）完成 review：補上 autorecord 退出與權限狀態取消政策的文件及權限恢復邊界測試，epoch 格式建議因僅屬可讀性而拒絕。簽章建置後沒有執行邏輯變更。本機總報告：`measurements/2026-09-20-plan17/report.md`。

Plan 017 已完成並移除計畫檔；不代表 Plan 014 舊有的點擊未送達案例已解決，也未發布。刻意設定的專注／螢幕分享抑制、其他 OS 版本、純 Tray UI、通知中心歷史點擊及長錄影不在本次結論內。未變更系統通知設定或權限。

### 通知生命週期調查 — 2026-09-20

接續 Plan 014 調查，發現 `AppTray.show()` 未持有由 GC 管理的 Electron `Notification`。現在持有待處理通知直到 click／close／失敗，同步 show 失敗會釋放並記錄，退出時關閉尚未處理的通知。這修正具體的生命週期風險，**不代表已證實歷史點擊未送達的根因**。runner 現在分開判定實際通知文字的 click callback 與本次完整路徑的 reveal 要求，不再只靠 reveal 日誌推論 callback 送達。

`pnpm check` 通過 342 個測試、typecheck 與 build。`pnpm start:app` 在 macOS 26.6.2 arm64、Electron 44.3.0 驗證九個簽章 bundle；來源為 HEAD `13b325d64f68320d2715bf8cd5f7b45cae1957f6` 加本次未提交變更。候選 app.asar SHA-256 為 `23a94f071d47468a57fe1f96c5f85fa7ef2a2749c2d856f4ee33f635b8db2cae`，dist 與暫時安裝副本一致。`pnpm acceptance:notification -- --install --full --languages en,zh-TW --keep-recordings` **30/30 通過**，零失敗／缺少通知、無重試：英文／繁中 × Finder 關閉／背景／最小化，各五次；首個事件到清理完成共 452.8 秒。每例均完成兩秒錄影存檔、匹配 callback／reveal、選中正確檔案，最終 Finder 在前景。審查修正診斷文字後，使用最終 helper 重判全部觀察仍為 30 次通過；該修正未改 App 程式。

runner 已還原原安裝版／語言並重開 App，退出測試 TextEdit，保留全部 30 個錄影。收尾後 computer use 只見 Finder 桌面，沒有測試 Finder 視窗。選單列 App 本身回 `timeoutReached`，由使用者退出後才建置簽章版。本輪是無人值守腳本檢查，不是 computer-use Tray 驗收；未新增播放、音質、其他 Space、通知中心歷史、強制 GC A/B 或 Windows 驗證。沒有終止事件的通知會持有到退出；Windows 逾時／歷史行為不在本次修正內。以上歷史失敗的根因仍未確認；下方結案決定接受此限制。原始本機證據：`docs/verification/measurements/2026-09-20-plan014-lifetime/`（`native/report.md`、`candidate.json`、`final-judgement.json`、檢查／建置／review 日誌）。

**Plan 014 結案 — 2026-09-20：** 維護者接受雙語本機矩陣 30/30 為通過結果，並明確要求計畫收尾。已移除雙語計畫檔，下一個為 Plan 012。歷史失敗與未測項目照實保留，不宣稱已證明根因或未執行的檢查也通過。發布與安裝公開版驗收移交另行要求的發布工作，不再作為本次接受結案的前置；本次沒有發布版本。未來英文發行說明應列入通知生命週期保留，以及退出會關閉本次程序尚未處理的通知。

## 官方網站本機建置 — 2026-09-20

計畫 012 階段 1–3 已在 `website/` 實作，當時僅在本機檢查、尚未部署；後續上線確認見下方結案紀錄。`website/release-manifest.json` 由公開的 v0.1.2 release 產生並線上重新驗證：DMG `RecordStuff-0.1.2-arm64-selfsigned.dmg`、127,314,171 bytes、SHA-256 `2de49bbd552e46934ef4573ca8c8b103e3a0b1334dd12b2022dee1f332f7fc7f`，與 release.json、SHA256SUMS 及 GitHub asset digest 一致。網站單元測試 11/11 通過；`astro check` 0 錯誤（TypeScript 6.0.3）；`pnpm site:build` 產出 4 頁；連結檢查 61 個站內參照、13 個外部 URL 皆無壞連結；根目錄 `pnpm check` 照常通過。1440 px 與 390 px 整頁截圖沒有水平溢出；每頁鍵盤 Tab 順序為 skip link → 品牌 → 導覽 → 主要下載 → 其餘連結，每頁都有 `main` landmark、一個 `h1`、圖片 alt 與外部連結的 `rel="noopener"`。回歸檢查：故意壞掉的 fragment 會讓連結檢查失敗；發行說明連結指向其他 release 的 manifest 會被拒絕；`astro dev` 與 `build:offline` 顯示「not re-verified」頁尾警語而 `pnpm site:build` 不顯示，即使環境繼承了 `SITE_MANIFEST_OFFLINE=1` 亦然。

三種結構（A：T3 Code 頁面組合、B：單頁、C：下載優先）以本機截圖比較，維護者選擇 A。兩輪 Codex GPT-6 Astra review 找到五個中等問題（漏比 `notesUrl`、沒有證據就設定已驗證旗標、目錄路徑繞過 fragment 驗證、`#71717a` 文字對比 4.12:1、繼承的離線變數繞過線上驗證），皆已修正並重新檢查。同日第二輪設計以內嵌動畫 SVG 場景（游標點擊 → 紅色錄影點 → 已儲存通知）取代 PNG 插圖、改用 Geist 並移除區塊小標；`astro check`、建置（4 頁）、連結檢查與單元測試重跑皆通過，並以 puppeteer 在循環的 1.5 s、3.2 s、6.6 s 逐幀驗證動畫。第三輪重新驗證重排時間的九秒循環：0.5 s（只有環）、2.0 s（環內紅點）、4.5 s（通知）、8.0 s（停留），並確認場景捲出畫面時所有動畫暫停（computed `animation-play-state` 切換為 paused 再恢復）。維護者選定 Facet 後，最終十六秒循環在 1.5 s（閒置、無動作）、5.4 s（推近、點擊：實心圓點與 REC）、7.5 s（拉回、錄影中）、9.0 s（指示標註）與 10.0 s（停止點擊後即時通知）重新驗證；建置（含 `/preview/` 三個方向共 8 頁）、連結檢查、`astro check` 與單元測試再次通過。上述本機檢查未做：Lighthouse、真實產品截圖（維護者選擇繪製的場景）、任何 HTTPS／公開存取檢查、透過上線網站下載，以及該下載的 Gatekeeper／仍要打開檢查。這些原列於部署後的階段 4.5；後續結案決定見下方紀錄。

## Plan 012 結案 — 2026-09-20

維護者確認[官網](https://record.ericts.com)已上線且已自行確認，明確要求只做文件收尾、不再追加驗收。匿名 HTTPS 請求回傳 HTTP 200，GitHub About 也已連到正式網址。本次以此確認作為計畫 012 的結案依據，不將上述歷史未測項目改記為逐項驗證通過。收尾期間沒有新增錄影、系統音訊擷取、播放、官網下載 checksum 或乾淨安裝 Gatekeeper 測試。

雙語 README 已補官網、下載頁與 Help 連結；發布指南記錄未來發行說明使用的公開 Help 網址。雙語計畫 012 已移除，下一個為計畫 018。既有本機測試結果、review 發現與驗證限制保留於上方。

最後視覺微調：場景的 Apple 圖示與左側選單整組右移 12 SVG 單位（場景寬 820 px 時約 6 px），保留原有間距，並重新產生社群預覽圖。`pnpm site:check` 通過（12 項測試、Astro 零診斷、4 頁、59 個站內參照與 13 個外部 URL）；`pnpm check` 通過（342 項測試及正式建置）。`pnpm site:screenshots` 的四頁在 320、390、1440 px 均無水平溢出，重新產生的場景圖亦已目視確認。文件連結檢查與 `git diff --check` 通過。

## 更新檢查實作 — 2026-09-20

Plan 018 已在 macOS 26.6.2 arm64 本機實作，以 `45a7cb3540d4ee1b5b484e5549609e28abba3e3b` 加未提交變更為基礎。`pnpm check` 通過 23 個檔案、382 個測試、TypeScript 檢查與正式建置。涵蓋新版／相等／舊版／無效語意版本、feed 缺欄位、架構／平台不符、HTTP／逾時備援、關閉偏好、跨重開的檢查間隔、錄製延後（含保存設定或請求途中開始錄製）、重疊、結束取消及雙語選單狀態。`pnpm site:check` 通過 15 個測試、Astro 診斷、線上 manifest 驗證、建置 feed 與 0.1.2 manifest 完整比對、59 個內部參照及 13 個外部 URL 檢查。

原生驗收受阻：computer use 無法讀取既有 `/Applications/RecordStuff.app`，回傳 `-10005 timeoutReached`。無法確認錄製狀態，因此保留 App 執行，未結束或重建。本次未操作安裝舊版對新版 feed 的瀏覽器開啟、原生錄製延後／離線選單、偏好保存，也未測擷取、音訊、存檔或播放。未部署 feed 或發布 App；Plan 018 保留原生驗收與交付待辦，真正已發布版本升級需有新版本後才能證明。本機 log／報告位於 `docs/verification/measurements/2026-09-20-update-check/`（gitignored）。

另以 Node 直接呼叫 `fetchVersion` 實測線上備援：網站 `/release.json` 回傳 HTTP 404（尚未部署）、GitHub latest 回傳 HTTP 200，檢查器取得 `0.1.2`。這是網路檢查，不代表原生 UI 驗收通過。

Opus 5 第一輪提出五項 findings。F1（Medium，GitHub 請求未明定標頭）拒絕：正式網路函式已實際取得 GitHub HTTP 200，未重現所稱故障。F2（Low/Medium，未來時間戳壓住檢查）與 F3（Low，手動檢查依賴設定寫入）接受並加入回歸測試。F4（Low，部署略過 feed 驗證）接受：檢查器支援 `--dir`，在部署前驗證 Vercel 產物。F5（Low，未驗證端點分支缺測試）接受：獨立程序測試實際端點在已驗證／缺少／無效旗標下的輸出，部署檢查器也拒絕缺失、版本不符與預覽 feed。這些檢查不代表原生 UI 通過。

Opus 5 第二輪確認第一輪判定成立，另提出三項 Low，皆接受：網站隱私清單未交代對外檢查（`website/src/content/site.ts`）；架構總覽及翻譯未更新資料邊界（`docs/system-design/overview.md` 與繁中版）；正式傳輸使用 Node fetch，未採用支援系統代理的 Electron 網路層（`src/main/index.ts`）。文案已交代 feed、備援、關閉選項及手動安裝，App 改為注入 Electron `net.fetch`。最後修正後再次通過 `pnpm check` 的 382 個測試與型別／建置，以及 `pnpm site:check` 的 15 個測試和所有建置／feed／連結檢查。另以暫存 user-data 目錄的獨立 Electron 程序實測最終傳輸：網站 404 → GitHub 200 → 版本 0.1.2，exit 0；沒有存取既有 App 或錄製。所選 API 支援系統代理／PAC，但未使用實際代理環境驗證。已達兩輪 review 上限，最後修正由 Codex 驗證，未送第三輪。CLI 最終訊息僅有摘要，因此完整本機審查紀錄另存 `opus-pass2-full.txt`。

## 更新驗收自動化與人工後續 — 2026-09-20

先前 computer-use 逾時後，維護者已退出 App，並完成人工驗收本機已簽章候選包：目前版本／時間顯示、英文與啟動檢查偏好於重啟後保存、關閉偏好仍能手動檢查、錄製時更新選項停用、Stop／REC 正常、存檔後恢復操作，以及影片畫面／聲音播放正常。另以暫時調低版本且延遲回應的候選包確認：錄製期間隱藏結果，存檔後顯示新版，瀏覽器開啟正確下載頁。以上是維護者回報的原生驗收，並非自動原生點擊。維護者免除真實斷網驗收；公開 feed 部署與已發布版本的升級仍未驗證。

`pnpm acceptance:updates` 已能執行隔離安裝包的 handler／model 整合驗收與真實快捷鍵錄影；前置條件、範圍與退出碼見[工具指南](../system-design/tooling.md#更新功能驗收)。`pnpm check` 通過 24 個檔案的 389 項測試及型別／建置。只測邏輯的執行通過。第一次完整執行正確因音訊素材守門失敗（第一段 10 次閃光、未偵測到提示音；第二段 11／11）；影片解碼與錄製狀態斷言通過，清理保留原有設定。第一段缺少標記的原因未獲證實。維護者確認其他聲音已停止後，完整重跑通過全部 11 組必要檢查，包含退出／清理與原始碼／設定保護。

| 最終真實錄影 | 長度 | 畫面 | 聲音 | 素材標記 | 完整性 |
| --- | --- | --- | --- | --- | --- |
| 第一段 | 10.5895 秒 | 1920×1080 H.264 | 48 kHz 雙聲道 AAC；RMS −27.3／−27.3 dBFS | 10 次閃光／10 次提示音 | 7 項判定通過；完整解碼通過 |
| 第二段 | 10.7727 秒 | 1920×1080 H.264 | 48 kHz 雙聲道 AAC；RMS −26.6／−27.4 dBFS | 11 次閃光／11 次提示音 | 7 項判定通過；完整解碼通過 |

要求設定為 standard／source／30 fps。兩段分別驗證錄製中請求檢查，以及已有請求的結果在下一段錄製中回傳；更新操作停用、Stop 位置與 REC 標題不變，存檔後才顯示結果。這些 UI 斷言檢查實際 handler／model，不檢查原生選單像素。驅動器攔截下載 URL，並以可控傳輸回應取代網路請求，不更改網路連線。主觀播放、保真度、影格時序、長時間同步與實體影音延遲不在判定範圍。測試 App 與素材瀏覽器已退出；真實設定與原始碼入口／package 雜湊不變。未加入正式 App 測試入口，未安裝或發布。

本機證據保留於 `measurements/2026-09-20T13-32-09-101Z-updates-9VF5g4/`（只測邏輯）、`measurements/2026-09-20T13-34-15-543Z-updates-Cw8hBk/`（第一次完整執行失敗）與 `measurements/2026-09-20T13-37-57-101Z-updates-g9HHOz/`（完整通過），包含報告、請求／回應、簽章記錄、影片及 `recording-verify.json`。人工後續紀錄位於 `measurements/2026-09-20-update-manual/`。原始產物由 gitignore 排除，此處摘要保留結果與限制。

### Review 修正與最終重跑

Opus 5 第一輪提出七項，全部接受：連續錄影間的存檔通知遮擋、累積 fixture 錯誤導致錯報 App 仍在執行、缺少失敗時 releases 連結驗證、影格時序／影音偏移未判定、錯誤回應未以原子方式寫入、既存輸出目錄的退出碼不明確，以及逾時取消次數未按案例計算。Fixture 現在攔截存檔通知（通知顯示不在此 runner 範圍）、原子寫入錯誤回應，並允許退出時帶著先前錯誤仍觀察正常退出。Runner 驗證兩種連結、判定同步與影格時序且至少要有五組配對標記、比較取消增量，並以 exit 2 拒絕且保留既存輸出目錄。退出案例會先刻意觸發 fixture 錯誤。新增 CLI 回歸測試曾找出暫時直接引入 production module 與 Node strip-only 模式不相容；已移除該 import，才完成下列通過檢查。

最終 `pnpm check`：24 個檔案的 390 項測試及型別／建置通過。修正後完整重跑通過全部 11 組必要檢查，包含注入錯誤後退出。兩段影片長 10.6661／10.7571 秒，皆為 1920×1080 H.264、48 kHz 雙聲道 AAC、29.28 fps；分別有 11／10 組閃光提示音配對，聲音延遲中位數 60.5／90.6 ms，量測掉幀為零，每段十項媒體判定均通過。未判定長時間漂移、CPU、稀疏素材音訊碼率及主觀保真度。原始碼／設定不變，測試 App 已退出。最終證據：`measurements/2026-09-20T13-55-46-607Z-updates-U7nSds/`；檢查／review 紀錄：`measurements/2026-09-20-update-automation/`。先前證據完整保留。

Opus 5 第二輪確認前七項修正，另提出五項，全部接受：退出末期錯誤可能未檢查、通知攔截缺少接線保護、CLI 回歸測試在目錄防護退化時可能意外啟動驗收、ready／stopped 快照未原子寫入，以及不足三組同步配對被寫成零組。Runner 現在核對最終預期錯誤清單、插樁時驗證正式通知呼叫、目錄測試直接測純檔案 helper 而不啟動 CLI、啟停快照用暫存檔更名，並準確說明同步統計不足。`pnpm check` 再次通過 390 項測試及型別／建置；既存完整錄影證據符合最終退出／媒體斷言。已達兩輪 review 上限，這些最後修改由 Codex 驗證，未送第三輪或再次錄影。完整 review 位於自動化證據目錄的 `opus-pass1-full.txt` 與 `opus-pass2.txt`。

第二輪修正後的最終安裝包邏輯驗收也通過（10 組必要檢查，明確不錄影）：`measurements/2026-09-20T14-04-45-217Z-updates-1js1Dw/report.md`。測試 App 已退出，原始碼／使用者設定不變。

## 公開更新 feed 部署前檢查 — 2026-09-20

`pnpm site:check` 通過：15 項測試、Astro 診斷（39 個檔案，無錯誤／警告）、已發布 0.1.2 manifest 線上驗證、建置 feed 完整比對，以及 59 個內部引用／13 個外部網址。14:18 UTC 對 `https://record.ericts.com/release.json` 的 HTTPS GET 回傳 HTTP 404；正式 feed 交付仍待辦。本次未啟動 App 或測試錄影。

Vercel 唯讀檢查確認既有 `recordstuff` 專案、根目錄 `website` 與已驗證的 `record.ericts.com` 網域。儲存庫 Actions secrets 清單為空。本機 CLI 登入有效；維護者要求只透過 CI/CD 部署後，已移除剛下載的本機專案／環境檔案。未部署、commit、push、建立 tag 或發布版本。維護者將設定儲存庫 Actions secrets `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`，確認 feed 與 workflow 變更已在 main，再手動觸發 `macOS release`，使用既有 tag `v0.1.2` 並啟用 `deploy-website=true`。部署後仍需驗證公開 JSON／內容／快取標頭，以及正式 App 傳輸直接取得 feed 而未走 GitHub 備援，才結束 018。

本次提交前 `pnpm check` 通過 24 個檔案的 395 項測試、型別檢查與正式建置；`git diff --check` 亦通過。未另行執行原生 UI 或錄影驗收。

## 獨立網站 CI/CD — 2026-09-20

網站交付移至 `.github/workflows/website.yml`，由 main 的 push 修改 `website/**` 或該 workflow、在 main 手動重試，以及穩定版本記錄成功後明確呼叫共用 workflow 三種入口執行。移除 `release.yml` 的 `deploy-website` dispatch 選項；重試改用 `gh workflow run website.yml --ref main`。這取代前一節部署前檢查所述的手動 release dispatch 操作。部署仍需 Vercel secrets，缺少設定會印出略過提示。各入口共用正式部署鎖，取得鎖後才讀取最新 main。release 明確呼叫可涵蓋不會觸發 push workflow 的 `GITHUB_TOKEN` 提交。

本機驗證：actionlint 1.7.12 通過兩份 workflow（未啟用 ShellCheck 整合）；`pnpm site:check` 通過 15 項測試、Astro 診斷、0.1.2 manifest 線上驗證、建置 feed 比對及 59 個內部引用／13 個外部網址。文件連結與 `git diff --check` 通過。未執行 GitHub workflow、Vercel 建置／部署、App 啟動或錄影；線上端到端交付仍未驗證，plan 018 維持未結案。

## 網站獨立 CI 依賴修正 — 2026-09-20

首次線上網站檢查回報 47 個 TypeScript 錯誤：獨立網站套件的 tsconfig 指定 Node 型別，卻未宣告 `@types/node`。先前本機檢查可解析根目錄的依賴，因此漏掉這個隔離環境問題。已在網站 devDependencies 加入 `@types/node` 24.13.4，並重新產生網站 pnpm lockfile。

在 repository 外的全新目錄，只複製網站原始碼、不繼承根目錄 node_modules，以 `pnpm install --frozen-lockfile` 安裝後驗證：15 項測試全過，Astro 檢查 39 個檔案無錯誤／警告，經線上驗證的正式建置與已發布 0.1.2 feed 相符，59 個內部引用／13 個外部網址全過。忽略 esbuild build script 的警告仍存在，但未阻擋建置。這是在 macOS 的依賴隔離驗證，尚未重跑 Linux Actions 或 Vercel 部署；未測試 App 或錄影行為。`git diff --check` 通過。

## Vercel 存取診斷 — 2026-09-20

網站 workflow 現在於安裝／建置前檢查憑證與 ID 格式，並讀取團隊、專案 API；只輸出 HTTP 狀態與設定提示，不輸出憑證或回應內容。六種模擬案例通過（成功、團隊／專案 403、404、ID 格式錯誤、token 空白）；同一檢查以本機 CLI 憑證唯讀存取既有專案也通過。這不代表無法讀回的 GitHub secret 有效。Actionlint（未啟用 ShellCheck）與 diff 格式檢查通過。未觸發部署或線上 workflow；CI 專案設定授權失敗仍待核對儲存庫 secrets。

### 專案限定 token 說明修正

Vercel 支援專案限定 token，且明確禁止其讀取團隊／使用者資源（見[官方公告](https://vercel.com/changelog/project-scoped-tokens)）。因此團隊 API 403 不代表 token 無效。診斷已改成只查目標專案及其歸屬／設定。目前固定的 CLI 59.23.2 在 pull 路徑仍未啟用 owner lookup fallback；相符的未結案[上游問題 #17506](https://github.com/vercel/vercel/issues/17506) 記錄了專案讀取成功、團隊讀取失敗導致 `vercel pull` 失敗的情形。移除診斷的團隊閘門不等於修復 CLI 限制；現有 pull／build／deploy 流程可能仍需團隊限定 token 作為替代，沒有證據顯示必須使用 Full Account。專案限定 token 的端到端部署仍未驗證。先前將團隊 403 直接視為 Scope 設錯的說法不夠準確。

## Vercel 原始碼部署 — 2026-09-20

採用 [T3 Code 官網](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml)的原始碼部署方式：Actions 驗證專案存取，再用既有釘版 CLI 59.23.2 執行 `deploy --archive=tgz --prod --yes --scope`，不再執行 `pull`、本機 `vercel build` 或 `--prebuilt`。Vercel 建置命令改為 `pnpm test && pnpm check`，測試、型別、manifest 線上驗證、正式建置、建置 feed 比對及連結檢查都必須通過才上線。觸發條件、部署鎖與 App 發布邊界維持原設計；GitHub 憑證不傳入遠端建置。

本機通過 actionlint 1.7.12（未啟用 ShellCheck）、15 項網站測試、39 個檔案診斷、0.1.2 manifest 線上／建置 feed 驗證、59 個內部引用與 13 個外部網址、文件連結目標及 `git diff --check`。未執行遠端建置／部署、啟動 App 或錄影。這移除了已知有問題的 pull 路徑，但不代表專案限定 token 的完整原始碼部署已驗證；線上驗收與公開 feed 交付仍待完成。先前 prebuilt 部署記錄保留為歷史。

### 直接部署的 scope 修正

首次原始碼部署在查詢專案前因 `User not found (404)` 失敗。CLI 59.23.2 的顯式 `--scope` 路徑要求查詢使用者／團隊，不相容於專案限定 token。已移除 `--scope`，仍以 `VERCEL_ORG_ID` 與 `VERCEL_PROJECT_ID` 指定目標。使用實際釘版 CLI 與本機 HTTP 模擬伺服器重現：有 `--scope` 時使用者 404 立即中止；移除後相同 404 不再阻止 CLI 查詢指定專案。模擬請求全為 GET，未進行真實部署。Actionlint（未啟用 ShellCheck）與 `git diff --check` 通過。這驗證的是啟動路徑修正，不是完整部署成功；前一節含 `--scope` 的指令說明以本修正為準。

## 公開 feed 交付成功 — 2026-09-20

[網站執行 35520447965](https://github.com/EricTsai83/recordstuff/actions/runs/35520447965) 由 `ab4b42201bd4dbe5ab78e4d6e68e5b90f5317256` 成功部署。15:46 UTC 匿名 HTTPS GET `https://record.ericts.com/release.json` 回傳 200、JSON 類型與 `Cache-Control: public, max-age=300, s-maxage=300`。完整 JSON 與已驗證的 0.1.2 manifest 對應欄位一致。以 Node fetch 執行正式 `fetchVersion` 得到 0.1.2，只有一個官網請求，沒有 GitHub 備援。本次未操作已安裝 App／Electron 傳輸或原生選單，未發布 App 或錄影。公開 feed 交付已驗證；結案前仍待已安裝 App 對正式 feed 的最後檢查。前述歷史失敗保留。

## 0.1.3 發布授權 — 2026-09-20

公開 feed 交付成功後，維護者確認本機驗收已完成並要求發布。沿用前述原生／人工與自動錄影證據，不宣稱本次另做正式 feed 原生檢查或公開版升級。發布前 `pnpm check` 通過 24 個檔案的 395 項測試、型別與正式建置。發布準備移除自動發行說明中过時的 Finder 限制並加入官網 Help。本次未停止 App，也未透過 start:app 重建。

## Plan 018 結案 — 2026-09-20

依維護者確認的本機驗收、已驗證公開 feed 交付與成功的 [0.1.3 發布](releases/0.1.3.md)結案。發布 workflow 已完成建置、簽署、公開發布、匿名公開下載重驗、版本記錄與網站部署。正式 feed 已宣告 0.1.3 並符合版本 metadata。先前本機證據與歷史失敗完整保留；不宣稱新增正式 feed 原生檢查或公開版升級測試，限制保留在發布紀錄。完成的雙語計畫已移除並更新索引。

## 設定視窗與待機成本 — 2026-09-21

Tray 選單改為扁平指令清單，所有偏好設定移入單一 sandbox 設定視窗。`pnpm check` 通過 28 個檔案的 425 項測試、型別檢查與正式建置。

`pnpm acceptance:settings` 在真實 Electron 視窗載入已建置的 `out/preload/settings.js` 與 `out/renderer/settings.html`，11 項案例全過：出貨頁面在出貨 CSP 下載入且無 console 錯誤、preload 只暴露 read／choose／onChanged、沙箱頁面拿不到任何 Node API、`?lang` query 讓首次繪製即為正確語言、每個群組畫出一個可用控制項並顯示實際提交值、此平台不可用的選項列出但不可選、被拒絕的快捷鍵顯示註解並以 `aria-describedby` 連結、真實 change 事件以 `("language", "en")` 抵達主程序並讓整個面板換語言重繪、主程序未提交的選擇會回報失敗並顯示實際值。退出碼雙向驗證過：缺建置產物為 2、刻意弄錯斷言為 1、正常為 0。此 fixture 自備 view 與 IPC handler，因此判的是頁面、preload 邊界與 IPC 往返；`settings-model` 與 `SettingsWindow` 由單元測試涵蓋。原本短暫存在、以 `happy-dom` 測同一頁面的單元測試已由這個執行器取代：它跑的是真實瀏覽器引擎而非模擬 DOM，且不需要新增依賴。

待機成本量測對象為 `pnpm start:app` 啟動的打包 App，程序生命週期內未錄製、也未開啟設定視窗。機器無其他負載時的 240 秒視窗內，四個程序合計使用 0.10 秒 CPU，約單核 0.042%（main 0.033%、GPU 0.008%、network 與 renderer 0.000%）；`top` 回報 %CPU 0.0、power 分數 0.0。另外三個較短視窗（含與本機建置重疊者）介於 0.033% 與 0.063% 之間。曾把已驗證後的權限輪詢改為 60 秒，實測與原本 5 秒同為 0.033%，因此已還原：便宜的第一段回到單一 5 秒間隔，與 Cap 事故後的設計一致（見[桌面設計](../system-design/desktop.md#螢幕權限)）。擷取宿主心跳的改動則保留——現在只在 session 進行中運作，而不是第一次錄製後永久執行，同時也避免待機時的卡死變成使用者無從處理的錯誤。

**未驗證。** 未點擊原生 tray、未經由「設定…」項目開啟視窗、未驗證 macOS 上實際的視窗置前行為，也未做任何螢幕或系統音訊擷取。`SettingsWindow.show()` 的 macOS 置前修正與 tray 選單本身仍未由機器驗證；專案的 [computer-use 驗收 skill](../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 已記錄無視窗 App 的 tray 無法自動化，需要互動式執行。

## 通知開關取代原生橋接 — 2026-09-21

Plan 019 最初實作為通往 macOS `UserNotifications` 的 Node-API 橋接（保存在 `wip/019-native-notification-bridge`）：權限狀態機、啟動時引導對話框、設定中的狀態顯示，以及每次建置都編譯 `.node` 的建置與打包管線。審查發現該橋接把失敗方向反了。`AppTray.show` 以一個初值為 `unknown` 的狀態為閘門，因此橋接載入失敗就會丟棄每一則通知 — 而由於該閘門同時擋住 `Notification.show()`，也就一併擋掉 Electron 在該呼叫內部發出的授權請求。兩個現實觸發點確實存在：建置腳本只針對 `process.arch` 編譯，且寫死 `-mmacosx-version-min=13.0`，而 App 並未宣告 `minimumSystemVersion`。受影響的使用者拿到的可用通知會比改動前更少。

Electron 44.3.0 的行為改以檢視實際隨附的 framework 二進位確立 — 這正是計畫第一步要求卻未完成的項目。`Electron Framework` 內含 `requestAuthorizationWithOptions:completionHandler:` 以及 Electron 自己的 log 字串 `Notification authorization granted: `，所以 `Notification.show()` 確實會向 macOS 請求授權。其中不存在 `getNotificationSettingsWithCompletionHandler`，而 `systemPreferences.getMediaAccessStatus` 的型別只接受 `microphone | camera | screen`，因此無從讀取狀態。`setPermissionRequestHandler` 中的 `'notifications'` 是 Chromium 的網頁內容權限，不是 App 本身的權限。這是二進位符號檢查而非原始碼閱讀；Objective-C selector 以字串常量儲存，因此出現與不出現都算相當可靠。

替代方案沿用 Cap（`apps/desktop/src-tauri/src/notifications.rs`）：settings.json 中一個 `notifications` 布林值，預設開啟，寬鬆讀取，使欄位出現之前寫下的檔案不會產生 warning；`AppTray.show` 會最先檢查它；「設定 → 一般」提供開／關與 macOS 的「開啟通知設定…」，說明文字標示「系統設定 → 通知 → RecordStuff」，而非 App 讀不到的狀態。打開開關會送出一則確認通知，那正是 Electron 的授權請求能依使用者自身意願送達的時機，同時也是可重複執行的送達測試。`native/`、`scripts/build-notifications.mjs`、`electron.vite.config.ts` 的編譯掛鉤、`electron-builder.yml` 的 `asarUnpack` 項目、`node-api-headers` 相依與三個主行程模組皆已移除。

`pnpm check` 通過：兩個 project 的 TypeScript 檢查、29 個檔案 445 項測試（新增 8 項 — 設定的預設值／往返／非布林值、tray 關閉時丟棄與啟用確認，以及 settings-model 的四項：已提交的開關、錄製鎖定、說明文字、僅 macOS 的面板操作），以及正式建置。

**未驗證。** 未啟動 App。沒有送出任何通知、沒有觀察到 macOS 授權提示、沒有開啟系統設定面板，也沒有執行任何螢幕或系統音訊擷取。原始回報的版本為何收不到通知（拒絕、忽略或其他原因）仍未重現 — 計畫 019 的第一步仍然開放。「Electron 在 `show()` 內部請求授權」這項結論由二進位符號推得，尚未在已簽章的打包版本上實際觀察。

## Plan 019 部分原生驗收 — 2026-09-23

在 macOS 26.6.2 arm64，以 `pnpm start:app` 建置並啟動乾淨 commit `3986d767baf9fb3a049e2dca7a637f02bcaa4941`（0.1.5）；RecordStuff Dev 自簽的九個 bundle 通過驗證，本次未驗安裝 DMG。`pnpm check` 通過 TypeScript、29 個檔案共 450 項測試與正式建置。

無視窗 App 的 computer-use 操作逾時，維護者手動開啟設定後，原生工具成功操作繁中通知開關，確認關閉警語與恢復開啟；兩次重新開啟都有 Electron `shown` 事件。macOS 既有 RecordStuff 通知權限為開啟。但工具無可用截圖，通知中心只暴露行事曆小工具，因此未獨立確認可見橫幅。

**發現：**「開啟通知設定…」只開到通知總覽，還要再點 RecordStuff，未符合 plan 019 直接進入 RecordStuff 面板的驗收條件。本次未修改程式。選單列錄影控制仍無法操作，瀏覽器也拒絕開啟本機測試素材 URL，未錄影或播放。首次授權、已安裝套件與原始回報仍未驗證。通知已恢復原本開啟，App 保持執行。本機報告：`../../verification/measurements/2026-09-23-plan019-computer-use/report.md`（gitignored）。Plan 019 維持開放。

維護者後續回報：上述請求的手動檢查皆正確（確認橫幅、有聲錄影／存檔／播放、通知點擊與 Finder、關閉通知後仍存檔且無橫幅）。這是使用者回報，並非 computer-use 獨立觀察；未指定首次授權或已安裝套件的測試條件。新增待查現象：開啟通知時 App 畫面似乎短暫閃爍，關閉時正常。靜態檢查發現設定儲存開始、主行程刷新與儲存結束都會重建整個表單，且只有開啟時會送確認通知；這些是調查線索，尚非重現後確定的根因。

### 設定閃爍後續修正 — 2026-09-23

維護者更正觀察：開啟和關閉通知都會讓設定畫面閃爍。renderer 現在於分頁結構不變時，直接更新既有控制項的值、文字與可用狀態，不再於每次儲存和主行程推送時替換整個表單。只有儲存造成的暫時鎖定維持原本亮度；錄製或平台限制造成的停用仍會變淡。確認通知維持原行為。

`pnpm check` 通過（29 個檔案 450 項測試、型別檢查及建置）。獨立 Electron 設定 fixture 通過 21/21 項，其中新增五項涵蓋開關兩方向、延遲儲存與中途推送、DOM 身分／焦點／捲動保留、儲存鎖定亮度及真正停用的樣式。本機證據：`../../verification/measurements/2026-09-23T04-59-30-756Z-settings-acceptance/report.md`。此 fixture 使用建置後的 renderer/preload 與測試 IPC，未驗原生選單列或通知送達。未重建或重啟執行中的已簽章 App；新版打包 App 的實際閃爍觀感仍待確認。

2026-09-23 原生補驗：維護者結束舊版後，以 `pnpm start:app` 重建並驗證新版簽章，renderer/CSS 與已測建置的位元組相符。維護者開啟設定後，由 computer use 完成三輪關閉／開啟，共六次切換；選項與說明文字正確更新，焦點保留，實際視窗截圖中的周圍版面及捲動位置穩定。通知恢復開啟，新版 App 保持執行。離散截圖無法完全排除兩張截圖間的瞬間閃爍；本次未重跑錄影回歸。本機報告：`../../verification/measurements/2026-09-23-settings-flicker-native/report.md`。

## Plan 019 結案 — 2026-09-23

維護者回報所要求的手動通知與錄製檢查皆正確，修正描述為開關兩方向都會閃爍，並在 renderer 修正與回歸測試後要求結案。Plan 019 依此本機驗收依據完成；移除英文與繁中計畫文件，下一項為 020。

證據包含維護者回報的確認橫幅、螢幕／系統音訊錄製／存檔／播放、通知點擊／Finder、關閉通知後仍正常存檔，以及 `pnpm check`（450 項測試）、獨立設定 fixture（21/21）與重新建置的自簽 App 三輪原生關閉／開啟操作。證據來源及本機報告位置保留於前述部分驗收與閃爍後續紀錄。renderer 在值更新時保留控制項，只有儲存造成的鎖定不再變淡。

結案保留可用的「通知總覽 → RecordStuff」操作路徑；原本直接進入專屬面板的要求未實作，歷史發現仍保留。原始下載版本的問題成因未重現；乾淨帳號首次授權及已安裝 DMG 的行為未獲獨立確認；離散截圖也無法證明所有瞬間畫面都無閃爍。這些限制持續記錄，不改寫為通過。本次結案不包含 release、commit、tag 或發布。

### 快捷鍵註冊失敗自動化 — 2026-09-23

在有桌面工作階段的 macOS（Node 24）執行 `pnpm acceptance:shortcut`。指令建置後，以臨時設定啟動獨立 Electron，載入正式 main bundle、設定視窗、preload、renderer、IPC 及儲存流程。僅在測試 adapter 中暫停快捷鍵註冊，讓真正的 Electron 呼叫穩定回傳 `false`；觀察 `Notification.show()` 呼叫但不發送系統橫幅，並替換選單列與擷取權限邊界，避免操作使用者選單列或要求錄影權限。正式程式沒有新增故障注入開關。

十項整合斷言通過：失敗選項保存、錯誤文字、通知內容、取消不重複通知、明確重存再次通知、Off 清除錯誤、通知偏好、成功恢復、無效輸入保留原值，以及其他偏好仍可儲存。這不等於重現其他 App 造成的 OS 衝突，也未驗證橫幅送達或螢幕／系統音訊錄製；Plan 020 的原生 OS 拒絕驗收限制仍保留。

收尾也是成功條件：正式關閉流程必須關閉視窗、釋放快捷鍵並銷毀選單列；外層確認自己的獨立程序群已消失後，才刪除臨時資料。逾時、SIGINT／SIGTERM 先要求正常退出，超過期限才對該程序群升級 SIGKILL，不會退出使用者的 RecordStuff。外層遭不可攔截的 SIGKILL 或電腦關機時無法執行收尾；無法確認清理狀態時保留臨時目錄並回報失敗。

故意失敗與逾時演練（`pnpm acceptance:shortcut -- --drill-failure`／`--drill-timeout`）應回傳非零並顯示 `cleanup=complete`；本機兩種演練及 SIGINT／SIGTERM 中斷均確認清理完成。六項程序管理測試另外涵蓋成功、非零退出、正常逾時退出、強制終止、子程序清理、中斷與啟動失敗。報告、log、JSON 留在 gitignored 的 `measurements/*-shortcut-failure/`，執行用臨時資料會刪除。

### 快捷鍵重啟自動化 — 2026-09-23

`pnpm acceptance:shortcut` 現在以兩個依序啟動的 Electron 程序通過 14 項斷言。第一個程序經正式設定 IPC 存下註冊失敗的自訂快捷鍵並退出；外層確認其程序群消失後，第二個才使用同一份臨時設定啟動，且不重新寫入初始設定。第二個驗證選項、重新註冊失敗、畫面說明與通知呼叫。兩階段都必須通過正式關閉流程檢查，才刪除臨時目錄。各階段保留獨立結果及 App log，總報告記錄兩次程序狀態。fixture 建置失敗且未啟動子程序時也會刪除臨時資料；子程序清理狀態不明時則保留。

`pnpm check` 通過 32 個檔案共 472 項測試、型別檢查與建置；故意失敗／逾時清理演練通過。獨立 Codex GPT-6 Astra 已完成 runner、fixture、程序管理及其測試的 review，無 findings；Claude Opus 5.5 因每週額度用盡而無法審查。Reviewer 本身未執行測試。本機證據：`../../verification/measurements/2026-09-23T06-45-12-655Z-shortcut-failure/report.md`（gitignored）。

剩餘項目只有真實 OS 衝突與可見錯誤通知：人工重現並觀察，或由維護者明確接受自動化失敗路徑證據，保留原生情境未測限制。這次增量不要求重做錄影／播放或人工重啟測試。Plan 020 仍待該驗收決定，不包含 commit 或發布。

## Plan 020 結案 — 2026-09-23

維護者明確接受自動化驗收，並同意將真實 OS 衝突與通知橫幅列為未測限制，據此結案。此決定取代上文當時的待驗／未結案狀態，不把 blocked 或未測結果改寫為通過。已移除雙語計畫，下一項為 023（用全域快捷鍵開啟設定）。

結案沿用最終重建產物的自訂快捷鍵錄影／存檔／播放與錄入回歸、`pnpm check` 的 472 項測試，以及 `pnpm acceptance:shortcut` 的 14 項失敗處理／跨程序重啟斷言。故意失敗、逾時、SIGINT／SIGTERM 清理均經驗證，原快捷鍵已還原。新增自動化的獨立 Codex GPT-6 Astra review 已完成且無 findings；Claude Opus 5.5 因額度限制未完成此增量的 review。

自動化確認 Electron 回報註冊失敗時的說明與通知呼叫，不證明真實 OS 衝突或 macOS 橫幅送達。使用者另回報按鍵由其他 App 接走且沒有通知；未以當次 log 確認發生於錄入、註冊或按鍵送達階段，成因仍未判定。非 US 配置等歷史未測項目繼續保留於原紀錄。本次只做文件結案，未重新執行 App、錄影或測試，未 commit、push 或發布。

## 設定快捷鍵—2026-09-23

Plan 023 已實作 ⌘⌥,，包含獨立註冊、保留既存衝突與復原、擷取暫停及最小化還原。`pnpm check` 通過 33 檔／481 測試，涵蓋拒絕／例外、平台等價、保留鍵提示與 renderer 失敗復原。macOS 26.6.2 arm64 上 `pnpm start:app` 完成建置、簽章驗證及啟動（HEAD `eab415cef7bbf8c60c85daddce1a9b9a5f4ca554` 加本次變更），OS 接受兩個快捷鍵註冊。

原生入口維持 **blocked**：Finder computer use 傳送 `super+alt+comma` 後，App log 沒有設定快捷鍵 callback；存取無視窗 RecordStuff 回傳 `-10005 timeoutReached`。不能據此宣稱全域按鍵或面板聚焦成功。重複／最小化／重開、雙語導覽、擷取復原及錄影／鎖定／存檔／播放仍未原生驗證，未製造 OS 衝突。本次沒有新增錄影或變更偏好，新版 App 保持閒置。可重現的測試不能代替 OS 驗收，Plan 023 保留。本機證據位於 `docs/verification/measurements/2026-09-23-settings-shortcut/`（報告、check／建置／App log，Git 忽略）。

### 混合入口補驗—2026-09-23

維護者回報手動成功，並授權 System Events ＋ Computer Use。新增 `pnpm acceptance:settings-shortcut`，送出固定鍵前檢查本 checkout 的 bundle 與目前註冊，等待新 callback 並保存獨立證據。六次實際送鍵皆收到 callback；Computer Use 觀察真正且聚焦的繁中設定面板，完成鍵盤分頁導覽、重複開啟與關閉重開，包含明確將 Chrome 置前的案例。另一次擷取期間執行正確拒絕送鍵，Escape 後註冊與入口恢復。最小化還原已操作，但未觀察到可區分的最小化狀態，因此維持部分驗證。最後關閉面板，App 保持執行；未修改偏好或建立錄影。

`pnpm check` 通過 34 檔／483 測試。這是無人值守混合驗收，不是純 Computer Use；先前純工具失敗紀錄保留。英文 UI、其他擷取退出、錄製持續／存檔／播放及真正 OS 衝突仍待驗。本機報告：`docs/verification/measurements/2026-09-23-settings-shortcut/hybrid-report.md`。

## Plan 023 結案 — 2026-09-23

Plan 023 依維護者授權的 System Events ＋原生 Computer Use 入口完成。沿用 07:09:28Z 建置簽章的同一個本機 bundle，之後僅修改驗收工具。原生證據涵蓋英／繁中 UI、錄影快捷鍵 Off 與自訂 Control+F12 的獨立性、保留鍵拒絕、擷取提交／取消／15 秒逾時／關窗，以及原生 Hide 指令造成的失焦恢復。單純 Chrome Raise 沒有產生失焦事件，該次是逾時結束，不計為失焦證據；重複開啟與關閉重開已於前次確認。語言、預設快捷鍵、品質、輸出、通知與更新偏好皆已還原。

30.3 秒錄影在開啟設定與切換語言期間持續，原生 AX 顯示錄影／快捷鍵／更新／通知控制項鎖定、語言可用。正常停止存檔、完整解碼，QuickTime 播放及跳轉至 15 秒可看到錄下的設定鎖定畫面。音訊為 48 kHz 雙聲道，RMS −31.1／−31.9 dB，影音時長差 9 ms。一般驗證器的**視訊碼率失敗**（9.70 Mbps，門檻 ≥11.34 Mbps）予以保留：此為混合桌面 UI 操作，開啟 App 後離開全螢幕動態素材（7 閃光／4 嗶聲），不稱為全指標通過。另一次不操作桌面的 10.3 秒基準錄影通過所有具判定的完整性指標：視訊 31.24 Mbps、雙聲道 RMS −27.2／−27.2 dB、影音時長差 13 ms、9 閃光／9 嗶聲與完整解碼。該次曾記錄 track.getSettings 為 1920×1920 的警告，實際解碼畫面為 1920×1080；不宣稱幀時序、長期同步或主觀聽感已驗。

`pnpm acceptance:shortcut` 三個階段共 25 項斷言通過，程序及暫存資料完整清理。新增設定階段以受控註冊 adapter 驗證既存等價衝突的所有權與原值保留、恢復、擷取暫停、保留鍵拒絕、雙語拒絕且不顯示可用快捷鍵、刷新不重試、renderer 崩潰恢復與重開；並確認真正 Electron 視窗先進入最小化，再由 callback 還原聚焦且沒有重複視窗。原生 Computer Use 未能顯示可區分的最小化狀態，以真實視窗整合斷言補足，不改寫為原生工具證據。未製造真正競爭 App 的 OS 衝突；本計畫允許受控錯誤分支驗證。

擴充 fixture 的首次執行因試圖選取下拉選單不存在的自訂值而失敗，改用真正的自訂擷取流程後 25 項全數通過；這是測試驅動修正，不是 App 修正。純 Computer Use 送鍵失敗的歷史保留，結案不代表該路徑已修好。移除已完成計畫，下一個為 021。本機證據位於 measurements 下的 `2026-09-23-settings-shortcut/full-report.md`、`2026-09-23T0747-hotkey-acceptance/`、`2026-09-23T0749-hotkey-acceptance/` 與 `2026-09-23T07-51-05-287Z-shortcut-failure/`。兩段新錄影保留於 Movies/RecordStuff；QuickTime 測試影片已關閉，保留其原有「打開」面板；沒有測試錄影仍在進行，RecordStuff 閒置且設定關閉。

### 收尾更正 — 2026-09-23

結案回報後，維護者指出遺留的 QuickTime「打開」選擇器。先前將其視為應保留的既有視窗，判斷依據不足：第一次工具觀察時已存在，不代表使用者希望保留。已透過原生 Computer Use 取消，重新取得狀態並按 Escape 後，QuickTime 回傳 `noWindowsAvailable`。未刪除錄影或文件。此紀錄更正前述收尾說明，錄製與功能測試結果不變。

### 碼率重測—2026-09-23

同一執行中的產物新增三次 30 秒錄影，所有具判定的完整性指標均通過：純動態素材 30.68 Mbps、動態素材上開啟設定 30.84 Mbps、嘗試 Raise 一般 Chrome 視窗 31.02 Mbps（門檻 11.34 Mbps）。第二次錄影確認設定面板及鎖定控制項入鏡、背景素材持續動態，QuickTime 原生播放及跳轉通過。Raise 沒有切換錄到的素材，因此未精確重現原先的混合桌面情境。原失敗影片每個完整 5 秒區段為 31.46、14.12、3.02、3.72、3.01、3.29 Mbps，新錄影則維持約 30–31 Mbps；支持內容變化造成碼率下降的解釋，但不能宣稱唯一原因已證實，或用碼率單獨證明畫質。原 fail 保留，未修改 App 或驗證門檻。偏好不變；測試設定面板、影片及 QuickTime 再次自動出現的「打開」選擇器均已關閉，確認 `noWindowsAvailable`。本機證據：`docs/verification/measurements/2026-09-23-bitrate-retest/report.md`。

### 最終結案確認 — 2026-09-23

維護者於碼率重測後要求結案。Plan 023 正式完成，英文及繁中計畫檔已移除；下一個為 021，再來為 022。前述原始碼率失敗、混合桌面情境未完整重現及原生自動化限制保留為歷史證據，不宣稱已修復或所有情境皆已驗收。本次收尾僅更新文件，不包含發布。

## Plan 021 螢幕選擇 — 2026-09-23

開發 checkout `b6e60e0` 加未提交變更已完成實作與兩輪 Codex 獨立 review（macOS 26.6.2 arm64、Electron 44.3.0）。依維護者指示，因 Vercel 額度耗盡而略過 Claude。第一輪指出：舊 handler 請求繼承新作業（P1）、video track 先結束造成診斷遺失（P2）、存檔 finalize 期間移除螢幕誤報失敗（P2）。三項皆接受、修正並涵蓋回歸測試；第二輪無 findings。`pnpm check` 的 36 個測試檔、538 項測試、型別檢查與建置通過。

混合原生驗收以 CUA 操作設定／QuickTime，`pnpm acceptance:settings-shortcut` 開面板，`pnpm acceptance` 送錄影快捷鍵。指定主螢幕選擇經重啟保留。review 修正版的主螢幕錄影完整性通過：10.3 秒、10 次閃光／10 次嗶聲，48 kHz 雙聲道 RMS -26.4/-27.2 dB。非主螢幕 BenQ BL2480T（id 2）透過 Chrome 原生視窗選單移入素材，實際錄到 1080×1920、60 fps、10.3 秒，雙聲道 RMS -27.2/-27.2 dB。QuickTime 確認直向素材與播放前進超過 5 秒；review 前的指定主螢幕影片也已播放。

非主螢幕的 `--no-open-material` 原報告仍保留**失敗**：普通音訊碼率門檻不適用稀疏嗶聲，實測為 26 kbps。另以 `pnpm verify -- … --test-material --screen 1080x1920` 分析通過，不覆寫原失敗。不存在的 id 在通知開／關時都拒絕開始（`display_unavailable`、`target_missing`）；CUA 觀察設定保留上次錯誤，選回主螢幕後不重啟即可清除。一般成功路徑腳本在預期拒絕案例會回傳 1；notification shown log 不等於肉眼觀察 banner。

偏好已還原主螢幕、通知開啟、繁中與原品質／輸出／快捷鍵；程序檢查確認 App/helpers 與 QuickTime 均退出。額外素材視窗已關閉，分頁清單確認無殘留，錄影檔均保留。本機證據：`docs/verification/measurements/2026-09-23-plan-021/report.md`；三次主螢幕／指定主螢幕紀錄為 `2026-09-23T09-23-21-629Z`、`2026-09-23T09-24-57-291Z`、`2026-09-23T09-30-46-934Z`，非主螢幕為 `2026-09-23T09-33-17-514Z`（皆加 `-hotkey-acceptance` 後綴）。

自動化／代理原生驗收結束時，實體拔插／重連（含部分檔可救回程度）及原生 tray／banner 觀察仍待驗；後續維護者人工驗收提供下方結案依據。鏡像、動態旋轉／縮放／解析度變更、錄製中控制項鎖定的原生觀察、主觀音訊與背景音隔離仍未驗。既有直向錄製不能證明動態旋轉行為；自動競態測試不代替實體拔除。

### 維護者人工驗收補充 — 2026-09-23

維護者實際拔除所選螢幕，確認 App 拒絕錄製；提供的截圖顯示保留 BenQ BL2480T 選擇及不可用說明，也觀察到 hover tooltip 的不可用提示。關閉通知後未出現錯誤通知。改選主螢幕後，維護者確認不需重啟 App 即可錄製影像與系統聲音。此為使用者回報的人工證據，不是新增自動測試或影片分析。錯誤辨識度不足已列入 Plan 022。維護者隨後確認所選螢幕拔除再接回後直接恢復錄製，不需重選。未提供 display id log，僅證明此次重接可恢復，不推論永久硬體識別或 id 改變時的恢復。當時的中途進度尚未回報錄製中拔除／部分檔恢復、右鍵 tray 文字、通知 banner 及本輪人工測試最後清理。

### Plan 021 結案 — 2026-09-23

維護者依逐步人工驗收操作，回報錄製中拔除所選螢幕後立即結束錄製，且留下存檔。接著請維護者確認影片可播放至拔除前、設定或右鍵 tray 顯示中斷原因，以及還原設定／正常退出 App；維護者回覆「一切正常」。據此完成本輪人工驗收，依先前要求正式結案。播放、中斷提示與人工收尾記為維護者確認，並非代理重新觀察；本次人工錄影未提供檔案路徑、新媒體分析、提示原文或具體顯示位置。

Plan 021 已完成，移除雙語計畫檔，下一個為 022。使用者提出的錯誤辨識度改善保留於 022：將診斷與一般說明分離，以醒目標題、圖示、原因與恢復指引呈現；本次結案不實作 UI 改善。前述自動測試、review 及稀疏音訊碼率原始失敗均保留。

鏡像、動態旋轉／縮放／解析度變更、實體硬體 id 改變後重接、錄製中控制項鎖定的原生觀察、通知 banner 具體外觀及背景音隔離仍未驗。此次重接直接恢復不代表永久硬體身分；此次存檔可播放不保證所有中斷檔都能救回。本次僅文件收尾，不 commit、發布或開始 022。

## Plan 024 完整寫入 — 2026-09-24

開發來源為 `140746a8ab20365fcfddc90d1286b77c651d377f` 加 Plan 024 變更，開始時工作目錄乾淨。FileWriter 現在依實際 `bytesWritten` 補完每個 chunk，拒絕零／無效進度，I/O 失敗後保留確認寫入量且不產生完成檔。原有序列佇列、五秒 sync、錯誤碼與正式檔撞名保護保留；Recorder 正式程式不需修改。

修正前的新 FileWriter 回歸測試為 **10 失敗／14 通過**，重現七位元組短寫截斷、部分成功後錯誤未被處理，以及無效進度被當作成功。最終 `pnpm check` 的型別檢查、**37 個測試檔／572 項測試**及正式建置通過。真實暫存檔案例涵蓋 4096 位元組每次最多寫七位元組、空輸入、多 chunk／立即 finish、sync 不插入 chunk 中間、首 chunk 部分成功後 ENOSPC／EIO／零進度、無效計數、首次錯誤保留、timer／handle 清理及既有撞名案例。Recorder 測試使用真正 FileWriter 搭配注入寫入，證明失敗 partial 路徑、不發 saved、完成清理及後續成功錄影。受控磁碟錯誤不代表原生失敗頻率，也不證明損壞 MP4 可播放。

Astra 對 `pnpm start:app` 新建置的 `dist/mac-arm64/RecordStuff.app` 執行必要 smoke，九個 bundle 身分驗證通過。既有無視窗 App 的 computer use 存取逾時；先由 log 確認 idle，再經活動監視器原生 **「結束」而非「強制結束」**退出精確主程序與 helpers，之後才重建。`pnpm acceptance` 提供真實 OS 快捷鍵開始／停止／存檔及完整性驗證：**10.267 秒、1920×1080、48 kHz 雙聲道、聲道 RMS −27.211249／−27.213143 dBFS、10 次閃光與 10 次嗶聲**。QuickTime computer use 觀察播放從 0 至 3.234 秒，seek 至 7.008 秒並續播至 9.905 秒，確認素材動態內容變化。RecordStuff／helpers、測試 Chrome profile、QuickTime 及本輪新開的活動監視器均退出，偏好前後相同；App 保持關閉。

環境為 macOS arm64、Apple M1 Pro、主螢幕 BenQ GW2785TC 1920×1080、外接耳機輸出。本次短錄影證明此環境的螢幕／系統音訊錄製與可觀察播放，不推論主觀聽感、保真、同步、長時間穩定、首次權限、硬體拔除或發布／安裝。設定回歸與完整畫質／fps 矩陣因相關行為未變而排除。原生 tray 存取仍有工具限制；本次檔案寫入變更不要求 tray 操作。

本機證據均在 measurements 目錄：`docs/verification/measurements/2026-09-24-plan-024/`（修正前輸出、最終 check 與 review）、`2026-09-24T1816-plan024-computer-use/`（建置、環境、播放／清理報告）、`2026-09-24T1816-plan024-hotkey-acceptance/`（runner 報告、verify JSON 與 App log）。這些忽略追蹤的原始產物不隨 fresh clone 提供。

Claude Opus 5.5 已完成唯讀 x-high review（309.5 秒）。兩項 Low finding 均接受：雙語函式索引漏述失敗 append 的確認進度，以及本次修改的 disk-full 回歸測試只在斷言通過後才關閉 writer。索引已描述實際寫入／計數契約（及既有排他複製 finish）；測試將 writer 納入必定執行的 teardown。這些文件／測試修正不改動已原生驗收的 App 產物。review 後型別檢查與 25 項 FileWriter 測試通過；有限修正不需第二輪 review。Plan 024 已完成並移除雙語計畫檔，下一項為 025；未 commit、push 或發布。
