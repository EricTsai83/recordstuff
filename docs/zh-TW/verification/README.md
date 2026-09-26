# 驗證索引

[English](../../verification/README.md) | [繁體中文](README.md)

現在該跑什麼，依[測試規則](../testing.md)及[共用驗收案例](../acceptance.md)。本索引摘要既有證據；文件整理不代表重新測試或擴大覆蓋。

## 截至 2026-09-24 的已記錄範圍

| 項目 | 既有結果與限制 |
| --- | --- |
| Plan 037 收尾量測 | 停止到可再開始的時間主要是發布時的複製：libuv 在 macOS 上從不 clone，2 GB 的儲存要等 1.3–2.0 秒，低空間提前停止也會失敗。儲存改用排他硬連結並保留複製備援：本機 APFS 上 15 秒錄影 p50 26 ms、2 GB 為 28–40 ms，HFS+ 映像上的低空間停止可以儲存。沒有實作重疊（no-go）；exFAT 仍會複製（2 GB 需 2.2–3.1 秒），低空間時以 disk_full 失敗。維護者決定以內建 SSD 上的磁碟映像代替實體外接碟；實體碟的吞吐量未量測（[歷史](history-2026-09.md#plan-037-結案--2026-09-27)） |
| Plan 034 Windows 系統匣圖示 | Windows ICO 的每個狀態都放在 App 圖示帶灰色邊緣的深色圓角底座上（idle 白色圓環、錄影紅色中心、警示琥珀色「!」、沙漏、碼錶），並逐一繪製 16／20／24／32／48 px。以實際大小、放大與灰階預覽在六種模擬工作列表面上比較後，選擇 A 而非無底座加外框的候選。macOS 資產位元組相同、loader 未改；重複產生結果相同；994 項測試。沒有 Windows 桌面，原生外觀、縮放與點擊為 blocked，移交 035 N17（[歷史](history-2026-09.md#plan-034-結案--2026-09-27)） |
| Plan 040 錄影前倒數 | 倒數前先準備擷取（關閉／3／5／10 秒，預設 3），歸零才開始；右上角只有 28% 白色數字，並在擷取前 300 ms 離開；取消不留檔案或失敗紀錄；沙漏／碼錶 tray 圖示寬度不變。在全新 bundle 上：3 秒的 tick 在 +0／+1003／+2009 ms，`record` 在 3004 ms，`record → started` 3 ms，最初 15 格沒有數字，第二次按鍵的取消乾淨；10 秒與關閉（322 ms 進入錄影，與 318 ms 基準相同）通過；TextEdit 保有焦點；部分回合的 60 fps 掉格來自其他可見內容的 GPU 負載。已開啟的 tray 選單中過期的「取消倒數」會停止錄影（macOS 無法更新已開啟的 tray 選單）。993 個測試。以 tray 點擊開始、選單「取消倒數」、深色選單列、白色／照片上的可讀性、減少動態／透明度、其他螢幕與播放留給 035（[歷史](history-2026-09.md#plan-040-結案--2026-09-26)） |
| Plan 042 更快的錄影回合 | `pnpm matrix` 一次呼叫可跑多個矩陣與 `--repeat`（只建置一次、只開一次素材），重複交錯執行，每個案例的摘要保留每一次的判定，每個階段都計時；quick／fps 案例為 15 秒並接連執行；收到 SIGINT／SIGTERM 時經正常退出流程停止自己的 App（錄影會存檔），再以 130／143 結束。fps 與 quick 各兩次由 494 秒縮短為 221 秒（−55%）；fps 兩次加 long 估計 −27%。同時段的對照顯示判定指標沒有移動，而相隔十分鐘的回合在 30 fps 漂移了 0.25 fps。合併為一次 ffmpeg 不採用（≤ 0.6 秒）；驗證以 ffprobe 為大宗。914 項測試；Codex GPT-6 Astra 針對中斷與重複摘要的四項 Medium finding 已修正，最後一次 pass 沒有 finding。見[歷史](history-2026-09.md#plan-042-結案--2026-09-26) |
| Plan 033 儲存位置復原 | Tray 的儲存位置動作會開啟既有資料夾；只在上層存在時建立不存在的預設資料夾；不存在的自訂資料夾一律不重建；每種失敗都顯示一則附路徑與「更改儲存位置／取消」的在地化警告，且不寫入設定。17 項測試在真實暫存檔案系統與 `SettingsStore` 上執行；`pnpm check` 通過（899 項測試）。Finder 與警告的原生觀察 blocked（computer use `-10005 timeoutReached`），移到 035 N41–N42。見[歷史](history-2026-09.md#plan-033-結案--2026-09-26) |
| Plan 044 鍵盤配置快捷鍵檢查 | `pnpm acceptance:shortcut-layout` 選取一個已啟用、數字列不輸入數字的輸入法；若是輸入法，會在自有的文字欄位中啟用它，讓它的配置生效。接著以數字列與數字鍵盤 key code 檢查建置後 App 的 `CommandOrControl+Control+Alt+Shift+7`，以 ⌘⌥, 作為送達對照組，最後還原並確認輸入法。從 ABC 開始、在注音（ZhuyinBopomofo）下約 7 秒通過。依配置查找的 drill 以 exit 1 結束，無法使用的輸入法與執行中的 dev App 都在任何變更前 blocked，兩個階段的 SIGINT 都還原了 ABC。`pnpm check` 通過（882 項測試）；實體按鍵不在範圍內。見[歷史](history-2026-09.md#plan-044-結案--2026-09-26) |
| Plan 043 快捷鍵依實體鍵位 | macOS 上 main 在 app ready 之前停用 Chromium 依配置查找的 `LayoutAwareGlobalHotkeys`，並與既有清單合併，讓全域快捷鍵依編輯器記錄的實體鍵位註冊。原本在注音下，預設 ⌘⇧1 會被綁到數字鍵盤。修改前後的 probe、`pnpm acceptance:regression`（866 項測試、Settings 113/113、快捷鍵整合）、注音下的 `pnpm acceptance:updates`（數字列 ⌘⇧1 下 11/11，兩段錄影所有受判定檢查皆通過）、⌘⌥, callback 與 QuickTime 播放都通過。維護者回報注音與 ABC 下實體數字列 ⌘⇧1 皆正常，App log 也相符。見[歷史](history-2026-09.md#plan-043-結案--2026-09-26) |
| Plan 032 更新驗收鎖定契約 | 更新 runner 的 snapshot 由同一份狀態契約判定。Starting、錄製與儲存中鎖定偏好、更新 action 與 tray 的變更資料夾，語言、外觀與 About 維持可用；只有 recording 顯示 REC 與 Stop；settled 狀態全部解鎖；未分類或被移除的設定群組會失敗。另修正過時的 zh-TW 標題期望。15 項針對性測試使用真正的 settingsView／trayModel snapshot。第 3 次原生 `pnpm acceptance:updates` 在 ABC 輸入法下 exit 0（11／11，兩段 10.7／10.9 秒錄影，標記 10／10），因為注音的數字列會讓合成的 ⌘⇧1 收不到。已觀察 QuickTime 播放。見[歷史](history-2026-09.md#plan-032-結案--2026-09-26) |
| Plan 031 正式版下載指標 | `release.mts record` 以已提交的 manifest 比較經驗證的正式版：較新版本由同一份 snapshot 更新 manifest 與兩份 README 區塊，事實相同的同版重試不寫任何檔案、事實衝突則在寫檔前失敗，較舊版本只補歷史紀錄；package.json 只前進，基準無效時停止並提示修復方式。暫存 checkout 中 19 項真正 CLI 測試通過，含 R2-04 的順序（先 0.1.4 後 0.1.3）；GitHub Actions 的 record job 未執行。見[歷史](history-2026-09.md#plan-031-結案--2026-09-26) |
| Plan 041 擷取影格節奏 | 偏差來自擷取來源：ScreenCaptureKit 把要求的幀率當成最小影格間隔，影格送到 track 時就已經晚了（29.4 與 57.5 fps，沒有丟棄），CPU 負載下也一樣。擷取改為要求 30.3／62.5（33／16 ms 下限），位元率、log、驗證與降級規則仍以設定值為準；`pnpm verify` 顯示間隔中位數，`pnpm diagnose:cadence` 用來定位節奏問題。matrix fps／quick／long 改動前後：29.3–29.4 → 29.9 fps，60 fps 57.0／57.9（fail）→ 59.95／59.96（pass），掉格、CPU、同步與位元率都在門檻內；沒有重複影格；844 個測試；新 bundle 的 60 fps smoke 與 QuickTime 播放通過；Codex GPT-6 Astra 對診斷工具提出的兩項 Medium finding 已修正。解析度上限路徑與非 60 Hz 螢幕未量測。見[歷史](history-2026-09.md#plan-041-結案--2026-09-26) |
| Plan 030 音訊與同步證據 | 檢查判定為 pass、fail、blocked、incomplete 或 n/a，由各呼叫端宣告需要的證據：缺 ffmpeg 為 blocked（exit 2），閃光／短音配對太少或長檔缺任一端窗口為 incomplete（exit 1），工具執行失敗或輸出不完整為 fail；音訊格式與各聲道能量分成兩項檢查。830 項測試涵蓋 ffmpeg 產生的立體聲媒體、隔離環境中缺少與失敗的 ffmpeg，以及 R1-8 與 R2-05 重現；`pnpm matrix -- quick` 與 `long` 通過並記錄 RMS 與標記覆蓋（long 漂移 1.3 ms），隔離的無閃光 matrix 以 exit 1 結束且只有偏移為 incomplete，QuickTime 播放一段 quick 與長錄影（開頭與接近結尾）已觀察；Codex GPT-6 Astra review 無 findings。缺 ffmpeg 只在隔離子程序中執行。見[歷史](history-2026-09.md#plan-030-結案--2026-09-25) |
| Plan 029 Log 身分與跨輪替驗收 | Recorder 事件與有版本的 session record 帶 run 與 session id，verify、acceptance 與 matrix 依身分而非行序配對檔案，舊版 log 採保守關聯並明確回報 ambiguous／conflict／unknown；runner 以 rotation-aware cursor 讀 log，遇到遺失歷史回報 evidence gap，不會跳過事件。814 項測試、245 個 log 重播 0 筆不一致、兩次新 bundle smoke 皆配對為 `matched`，QuickTime 播放、設定快捷鍵 callback 與通知 2/2 通過；Codex GPT-6 Astra 修正一個 Medium finding，最後一個 pass 無 findings。原生情境下的輪替與失敗路徑只在隔離的暫存 log 中執行。見[歷史](history-2026-09.md#plan-029-結案--2026-09-25) |
| Plan 028 設定視窗與快捷鍵生命週期 | 各平台唯一且精確的關閉組合鍵，macOS ⌃W 可錄入；每個視窗的錄入 lease 在所有離開路徑都釋放，即使已確認的儲存仍在寫入；經 `AppShortcuts` 先保存再註冊；當掉的設定 renderer 會被丟棄，下次開啟重建。778 項測試、設定 113/113、含 fixture 保留儲存的快捷鍵整合、10.3 秒新 bundle smoke 與 QuickTime 播放通過；Codex GPT-6 Astra 無 findings。原生面板 ⌃W／⌘W 案例因 computer use 無法取得 RecordStuff 而受阻（035 N38–N40）。見[歷史](history-2026-09.md#plan-028-結案--2026-09-25) |
| Plan 027 權限同步 | Recorder 保存最新權限狀態，每次 session 結束都落定為 idle 或 needsPermission，並保留「顯示最後一個錄影」；PermissionWatcher 只持有一個 getSources，搭配期限指引、完成後起算的退避與世代 token。756 項測試、10.3 秒新 bundle smoke 與 QuickTime 播放通過；Codex GPT-6 Astra 無 findings。原生撤銷／重新授權／重新啟動恢復受阻（035 N36、N37）。見[歷史](history-2026-09.md#plan-027-結案--2026-09-25) |
| Plan 038 錄影健康防護 | 磁碟餘裕提前停止以成功並附原因存檔、擷取停滯失敗、64 MiB 寫入積壓拒絕並保留無缺口前段、開始期間以已保留的磁碟錯誤取代泛用失敗、每個 session 的中斷 sentinel 於啟動時回報為 `app_terminated`，以及睡眠／喚醒 log。739 項測試、10.2 秒新 bundle smoke（之後 sentinel 資料夾為空）與 QuickTime 播放通過；Codex GPT-6 Astra 三項 Medium 已修正。磁碟停止、強制結束紀錄與睡眠結果未做原生驗收（035 N30、N31）。見[歷史](history-2026-09.md#plan-038-結案--2026-09-25) |
| Plan 026 拒絕空錄影 | `FileWriter.finish` 在已保留的磁碟錯誤之後，把零確認位元組拒絕為 `capture_start_failed`；不發 saved、不產生 `.mp4`，刪除空暫存檔，冪等清理保住同一秒內的重試。706 項測試、10.3 秒新 bundle smoke、0.33 秒立即停止存為非空且可解碼，以及兩者的 QuickTime 播放均通過；Codex GPT-6 Astra 兩項 Medium 已修正。原生擷取從未產生空輸出，無媒體路徑以真實檔案的受控測試為證據。見[歷史](history-2026-09.md#plan-026-結案--2026-09-25) |
| Plan 036 背景保存歷史 | 非同步單一 writer 歷史、耐久確認／移除、自動重試、依意圖還原焦點，以及先媒體後提醒的未保存退出階段。687 項測試、設定 113/113、快捷鍵整合、lifecycle `history` 案例與新 bundle 錄影／QuickTime／退出 smoke 通過；Codex GPT-6 Astra 兩項 Medium 已修正，末輪無 findings。修正前一次 fixture 失敗原因未明；N24–N26 原生案例留在 Plan 035。見[紀錄](history-2026-09.md#plan-036-結案--2026-09-25) |
| Plan 025 終止／退出 | 兩輪 Opus review 九項全部修正；獨立磁碟工作、結果發布與安全退出。通知 2/2、設定重跑 100/100、錄製 smoke 通過；維護者操作的錄製中結束通過；雙語提示截圖通過，維護者確認自動置前，025 已結案；最後 651 項測試，追加工具四項 review finding 亦修正。見[紀錄](history-2026-09.md#plan-025-終止負責與退出--2026-09-25) |
| 多筆失敗歷史 | 最終627 tests、設定100/100及快捷鍵整合通過；Opus5.5六項Low已修正，末輪無findings；未讀獨立重試、逐筆確認／移除與v1升級。原生操作留待Plan035；見[歷史](history-2026-09.md#多筆失敗歷史--2026-09-25) |
| 最新失敗跨重啟保留 | 單筆結果／已讀狀態跨重啟；617 個測試、94/94 設定及快捷鍵整合通過。原生重啟／錄影依維護者安排留到最後 Plan035。見[持久化紀錄](history-2026-09.md#最新失敗跨重啟保留--2026-09-25) |
| 錄影失敗結果 | 初版結果區塊與整合警告標記驗證；589 個單元測試、86/86 設定案例及快捷鍵整合通過。原生錯誤／選單列／通知點擊仍受阻；見[失敗結果](history-2026-09.md#錄影失敗結果--2026-09-25) |
| 完整錄影寫入 | Plan 024：572 項測試、新 bundle 10.267 秒錄影、雙聲道 RMS −27.21／−27.21 dBFS、QuickTime 播放／seek 與清理通過。受控短寫失敗／恢復使用真正 FileWriter，不代表 crash 耐久性或損壞檔可播放。見[完整寫入](history-2026-09.md#plan-024-完整寫入--2026-09-24) |
| 設定自動化 | 最新紀錄為 555 單元測試、76/76 面板、40/40 整合案例，清理完成，包含尺寸持久化。受控註冊／Tray 邊界不代表真正 OS 送達。見[尺寸記憶](history-2026-09.md#設定視窗尺寸記憶--2026-09-24) |
| 設定原生驗收 | 維護者回報入口、錄製／播放、快捷鍵及外觀通過，並確認滑鼠「確定」修正。剩餘 VoiceOver、原生對比、完整原生矩陣、新螢幕錯誤 UI 及最終外部連結開啟已豁免，不標通過。見 [Plan 022 結案](history-2026-09.md#plan-022-結案--2026-09-24) |
| 螢幕拔插／恢復 | 維護者回報目標拒絕、恢復及拔除後錄製／保存／播放；不推論其他硬體或後續錯誤 UI。見 [Plan 021 結案](history-2026-09.md#plan-021-結案--2026-09-23) |
| 1.0.0 發布 | CI 發布／下載驗證及 tagged source 的本機短錄影／QuickTime 播放。本輪未驗首次權限、主觀聽感、長錄影、完整原生設定／Tray 回歸及手動 DMG 安裝。見[發布證據](releases/1.0.0.md) |

這些結果限於各自版本與環境，不代表目前 checkout 通過。後續記錄修復時，舊失敗仍保留在歷史。

## 證據位置

- [2026 年 9 月歷史](history-2026-09.md)：開發輪次、量測、失敗、修復、已接受限制與計畫結案，保留原標題。
- 發布紀錄：[0.1.0](releases/0.1.0.md)、[0.1.1](releases/0.1.1.md)、[0.1.2](releases/0.1.2.md)、[0.1.3](releases/0.1.3.md)、[0.1.4](releases/0.1.4.md)、[0.1.5](releases/0.1.5.md)、[1.0.0](releases/1.0.0.md)。
- `docs/verification/measurements/`：已 gitignore 的原始執行、log、媒體分析及截圖。連到此處的是**本機證據參照**，不是 repository 可下載附件；新 clone 不會包含。2026-09-26 維護者已要求刪除維護者電腦上到當天為止的所有原始執行紀錄，以及 ~/Movies/RecordStuff 裡的測試錄影；指向更早執行紀錄的連結在任何地方都已無法開啟，保留下來的是本目錄中整理過的紀錄。

新增值得長期保存的結果時，寫入對應月份歷史的日期段落（跨月建立新檔），或版本發布紀錄。已支持範圍改變時更新本摘要，並同步既有翻譯。依[報告範本](../acceptance.md#報告範本)記錄來源／產物、指令／案例、收尾與限制。歷史只追加，連結／格式修正除外，不把舊失敗改成通過。摘要須在缺少本機原始資料時仍可理解；協作者需要原始證據時，透過約定可存取的位置提供去識別 artifact，並標明可取得性。
