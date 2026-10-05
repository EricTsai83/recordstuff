# 設計決策與取捨

[English](../../system-design/decisions.md) | [繁體中文](decisions.md)

這是目前採用的決策，不是新的工作計畫。原始計畫中已被實測推翻的假設，以此處及程式為準。

| 決策 | 原因 | 代價／重新評估條件 |
| --- | --- | --- |
| Electron + TypeScript | 以現有語言完成桌面生命週期、原生選單與 Chromium 擷取 | 有 Electron 常駐成本；只在實測效能或擷取能力不足時評估原生引擎 |
| Bundle identifier 用維護者自有網域反寫（`com.ericts.record`；[原因](signing.md#bundle-identifier)） | identifier 沒有註冊機構，自有網域是唯一的唯一性保證；它也是 App 在 TCC 授權、通知與簽章裡的身分 | 選一次就不再動：改了 macOS 會視為新 App，使用者需重新允許螢幕錄製 |
| Chromium getDisplayMedia + MediaRecorder | 不自寫音訊裝置或原生 sidecar，先完成錄影核心 | 對 codec／時間戳控制有限；明確要求 EC／NS／AGC false 已恢復本機高頻與立體聲，引擎／平台變更需重測 |
| 隱藏 renderer 專做擷取 | DOM 媒體 API 位於 renderer；UI 仍可用原生 API | 多一條 MessagePort；需 ready、session、順序与心跳管理 |
| Main 擁有狀態與影片 writer | UI、擷取程序不能各自宣稱錄影成功 | 程序中止時 main 要協調故障收尾 |
| MP4 H.264 + AAC | 本機 QuickTime 可直接播放，硬體編碼已有量測證據 | fragmented MP4；非所有損壞檔都可播，無轉檔 fallback |
| 原生 Tray／Menu／Notification | 一個按鈕的產品不需要一般視窗與 UI framework | 通知呈現與 Finder 排序受系統控制 |
| 只由已提交的 runner 以腳本輸入操作 RecordStuff 自己的 UI（維護者 2026-10-02 決定，plan 063；[工具](tooling.md#腳本化原生驗收)） | Computer Use 無法存取純 tray 的程序，Tray 案例只能等維護者或記為受阻；048 與 035 的回合中，CoreGraphics 點擊與按鍵加上輔助使用讀取已到達所有狀態，runner 能重複這些操作，並把原生選單和正式 model 的 log 行比對 | 腳本輸入只證明送達與狀態，不證明外觀，外觀仍要觀察它的截圖。點擊會移動真正的游標（在 macOS 26 上直接送給程序打不開選單），所以每輪仍需桌面交接，期間有人操作也不會被偵測；能消除這一點的是隔離的 macOS 工作階段或 VM。狀態列項目由控制中心承載，每次 macOS 更新後都要重新確認項目定位 |
| 錄影失敗歷史放在設定的獨立分頁，而非獨立視窗（plan 047；[設計](desktop.md#錄影失敗結果)） | 失敗紀錄放在偏好上方時，每次開啟設定都先看到一長串原因；Cap 把歷史與診斷都作為單一設定視窗中的頁面，並讓 tray 直接連到它們。失敗與偏好會一起使用（指引會導向「錄影設定」分頁），而獨立視窗需要自己的生命週期、preload、sender 授權、尺寸保存、關閉快捷鍵、當機與焦點處理 | 只有在歷史擴大到失敗以外（例如已儲存錄影的資料庫，屬於另一個產品決定）時才重新考慮獨立視窗。不採用只在 tooltip 顯示錯誤文字、錄影資料庫與上傳 log |
| 錄影前倒數，預設 3 秒（plan 040；[設計](recording.md#倒數)） | 以往點擊後約 0.3 秒就開始擷取，最初幾格會拍到滑鼠離開選單列，又沒有剪輯器可剪掉。比照 Cap 先準備管線、以 gate 控制影格，倒數前就準備好擷取，歸零時由 `MediaRecorder.start()` 作為 gate；關閉、3、5、10 秒沿用 Cap 的選項，預設值也套用到既有使用者 | 只在右上角顯示 28% 白色數字，沒有方框、圓環、文字、全螢幕變暗或 content protection：`getDisplayMedia` 無法排除個別視窗，因此 overlay 改在擷取前 300 ms 離開。每個數字可選擇伴隨一聲提示音（plan 046），依維護者選擇預設開啟，既有使用者也一樣，並可在設定中關閉；它在擷取前 860 ms 就結束，靠時間上的分離不進入錄影。歸零時仍不加開始音效，因為 RecordStuff 會錄系統音訊，而 `restrictOwnAudio` 是否排除 App 自己的聲音尚未驗證。數字在明亮照片上會變淡；維護者在 035 的 N32 判斷它在明亮照片、白色文件與深色編輯器上都夠清楚也夠透明，因此維持目前透明度。數字大小隨被錄螢幕縮放，為短邊的 14%，限制在 56–216 pt（plan 045），因為固定 56 pt 只有 1080 pt 螢幕的約 5%，讀起來太小；不採用大小設定，也不把數字移到中央。點擊、快捷鍵、選單或退出都能取消，取消不算失敗 |
| 以排他硬連結發布；不做重疊收尾（plan 037；[設計](recording.md#寫檔與失敗)） | 實測停止到可再開始的時間主要是發布時的複製：libuv 在 macOS 上從不 clone，儲存 2 GB 錄影要複製 1.3–1.9 秒，低空間提前停止也因空間不足而失敗。連結耗時固定、不需要空間，而且和複製一樣不會取代既有名稱；改用連結後已沒有可分離的等待，因此沒有為重疊存檔另建第二套生命週期 | 沒有硬連結的磁碟區（exFAT、部分網路磁碟區）仍會複製：exFAT 映像上 2 GB 的儲存要等 2.2–3.1 秒，而且複製需要與檔案同樣大小的剩餘空間，這點重疊也無法解決；在慢速碟上，複製還會和下一段錄影的寫入互搶。維護者已接受（2026-09-27）。若這類輸出資料夾證實很常見，應先在那裡去掉複製（例如先排他地佔住最終檔名，再改名蓋過這個佔位檔，並先在該檔案系統上實測），而不是做重疊；只有在實測的代表情境再次於檔案關閉後花超過 0.5 秒時，才重新考慮重疊 |
| 從 App 外部量測 CPU 預算（plan 049；[預算](tooling.md#cpu-預算)） | 待機原本沒有任何量測，矩陣讀的是 `ps` 會衰減的 `%cpu`，對待機的一秒太粗，也看不到系統 helper。和 Cap 的量測工具一樣，由一個小程式讀取 App 程序樹的 `proc_pid_rusage`，把 VTEncoderXPCService 分開回報，並捨棄程序組合有變化的區間；和 Cap 不同的是，超過門檻會判定失敗 | 發布的 App 裡不放任何監控計時器，因為它本身就會喚醒待命中的 App。門檻只適用於 M1 Pro 參考機；換機器或升級 Electron 時要先取新的 baseline。每 5 秒的權限輪詢在量測顯示它有影響之前保留；Electron 隨預設 session 預熱、沒有載入頁面的 renderer（第一個視窗開啟前約 65 MB），以及第一次擷取後 Chromium 保留的音訊服務（約 49 MB、每秒 0.3 次喚醒），經維護者同意予以接受（2026-09-28），因為記憶體只回報、不列入預算；待機契約依角色列出它們，錄影後的檢查看每次錄影的成長，而不是和啟動時的差異 |
| 錄影期間保持喚醒；睡眠時停止並存檔（plan 050；[設計](recording.md#寫檔與失敗)） | 原本沒有任何機制讓 Mac 保持喚醒，閒置造成的螢幕或系統睡眠可能結束長時間不操作的錄影；使用者要求的睡眠則會在 `suspend` 後 146 ms 以 capture_failed 結束錄影，失敗橫幅也看不到（035 的 N31）。改由 `prevent-display-sleep` blocker 涵蓋整個 session；無法拒絕的睡眠變成附說明的一般停止，通知等到醒來才顯示。Cap（[靜態檢視](https://github.com/CapSoftware/Cap/tree/20c224073bece3fbebed8acb631bd2df97cd6f40)）不持有 blocker，系統停止擷取後會把擷取重建回同一段錄影 | 錄影期間螢幕會一直亮著，沒有設定開關。醒來後不會接續同一個檔案，因為 `MediaRecorder` 無法替換軌道；若使用者需要跨越睡眠的錄影再重新評估。沒有系統睡眠、只是強制螢幕睡眠或鎖定螢幕的情況不在處理範圍，錄影仍會失敗；維護者已於 2026-09-28 接受 |
| 全域快捷鍵依實體鍵位註冊（macOS 停用 `LayoutAwareGlobalHotkeys`；[原因](desktop.md#錄影快捷鍵)） | 編輯器記錄實體鍵位並拒絕數字鍵盤；Chromium 依配置查找，會在注音下把預設 ⇧⌘1 移到數字鍵盤 | 非 QWERTY 拉丁配置的字母快捷鍵是 US 位置，而不是鍵帽字母。每次升級 Electron 都要執行 `pnpm acceptance:shortcut-layout`（[檢查](tooling.md#鍵盤配置快捷鍵檢查)）：若其 Chromium 改名或移除此功能，註冊會在無提示下回到依配置查找 |
| 手寫 type guard、單一 repo | 協定及狀態規模小，容易完整閱讀與測試 | 沒有協定版本協商；獨立發布另一端時需重設契約 |
| 媒體 buffer 複製傳送 | 先前 Electron 44 的 transfer ArrayBuffer 實驗會卡住 main | 多一次記憶體拷貝；目前無有界背壓 |
| 從實際影格量尺寸 | getSettings 多螢幕錯報曾把 1080p 縮成 1080×606 | 啟動增加量測等待；fallback 必須留 warning |
| timeslice 與關鍵影格同設 1000 ms | 只有 timeslice 時低動態 Retina 首片曾晚於 8 秒 | 名義設定不是硬性發片週期 |
| 保持品質係數、明示實測差異 | 30 fps 位元率接近目標；60 fps 可用但約兩倍目標 | 60 fps 檔案較大；需持續區分要求、track 與成品 |
| 移除音訊品質選單 | 本機不同 AAC 要求值實際都約 160 kbps | 固定要求 256 kbps，不保證音訊碼率或 stereo 分離 |
| 不補償固有音畫延遲 | 已測延遲與漂移在專案接受範圍 | 升級擷取引擎後重測，不能把一次量測視為永遠正確 |
| 固定自簽憑證 + DMG | 開發者可產生可安裝下載版，收件者不需開發工具或憑證 | 未 Apple 公證，首次開啟可能需手動允許；固定身分也不保證所有環境 TCC 行為 |
| DMG 只有 App 與 Applications 連結 | 拖曳到 Applications 的視窗是使用者早已熟悉的安裝慣例；附帶文件只增加雜訊與混淆 | 說明、更新與移除指引必須線上可及並由每個 release 連結；任何多出的可見檔案都會讓發布閘門失敗 |
| tag 即發布也是版本；驗證在打 tag 之前 | 單一維護者與單一 Mac 無法支撐 nightly 通道，pipeline 內的人工驗收閘門只是重複開發期已做的檢查，而打 tag 前先在 repo 寫版本號只是多一個會出錯的步驟 | CI 證明建置、簽章、版面與 bytes 一致，但不證明擷取；壞版本以新版本修正，絕不覆寫；record job 以 bot 身分 commit 到 main |
| 手動更新，不做更新器；macOS 以垃圾桶移除，Windows 用每位使用者的解除安裝程式（Windows 部分：維護者 2026-10-03 決定） | 同一身分與路徑讓取代後保留設定與權限；單鍵錄影工具從背景更新機制得到的好處有限。在 Windows 上，使用者預期從「設定 → 應用程式」移除已安裝的 App，每位使用者的安裝檔會在那裡登記 | 兩個平台的使用者都需自行下載新版；絕不自動刪除使用者資料。macOS 規則不變。Windows 解除安裝程式移除 App、開始選單捷徑與其登記，保留錄影、設定與 log（`deleteAppDataOnUninstall: false`）。只透過延後的更新評估重新考慮更新器 |
| Windows x64 與 macOS 由同一個 tag 一起發布，只由 CI 檢查，沒有 Windows 實機（維護者 2026-10-03 決定，plan 064，[結案](../verification/history-2026-10.md#plan-064-結案--2026-10-03)；[發布契約](releases.md#發布契約)） | 維護者沒有 Windows 機器，但希望 Windows 使用者走與 Mac 相同的流程；GitHub 的 Windows runner 能建置、安裝、檢查並解除安裝安裝檔，只是不能錄影。每位使用者的一鍵 NSIS 安裝檔（`oneClick`、`perMachine: false`、不需管理員權限）是在 GitHub 發布的 Electron App 的常見做法（T3 Code，pingdotgg/t3code，在 DMG 旁附一個），其開始選單捷徑帶有 appId `com.ericts.record` 作為 Windows toast 所需的 AppUserModelID | 實機驗證仍只有 macOS。Windows 的證據只有 CI：`windows-2025` 上的 `pnpm check`，以及發布前後的每位使用者靜默安裝、登記、版本、架構、簽章狀態、系統匣圖示、捷徑與靜默解除安裝；擷取、系統音訊、通知與系統匣在 Windows 上都未驗證（035 的 N17 系統匣矩陣仍未結案），Windows 文案（系統匣、電腦進入睡眠、預設播放裝置、只提 Ctrl 的快捷鍵訊息與保留鍵）從未在 Windows 上看過；App 也不強制 Windows 最低版本：Electron 44 本身支援 Windows 10 以上，更舊的系統上 App 根本無法啟動、也就無從檢查，而沒有實機就無法訂出更窄的下限。不簽章，資產名稱寫明這點，因此 SmartScreen 會警告；完整性由 SHA256SUMS、`release-win32-x64.json` 與 GitHub build-provenance attestation 承擔。Windows 失敗時整個 tag 在發布前失敗。只有 x64：Windows on Arm 與 Linux 沒有建置。有 Windows 機器時記錄實機證據；若 SmartScreen 或使用者回報讓未簽章安裝檔不可行，再考慮簽章 |
| 英文正式版與繁體中文翻譯 | GitHub 文件、註解與診斷共用英文，App 可明確選中文 | catalog 與雙語文件需同步維護 |
| 設計與計畫分離 | 已完成執行日志不適合長期當規格 | 更新行為時需維護設計、驗證紀錄；plans 只留剩餘交付 |
| 原始量測留在本機 | 每次執行的報告、log 與探測都綁定機器，貢獻者一多就會倍增；只有解讀後的結論值得長存 | `docs/verification/measurements/` 已 gitignore；驗證紀錄與 release 紀錄必須帶足數字，不依賴原始檔；`acc6342` 之前的歷史仍保有早期原始量測 |
| [已知素材的音質診斷](audio-quality.md) | 以同時 pilot、頻率擬合和連續性視窗區分高頻流失、增益與時鐘差異 | 無效量測不能叫作品質失敗；需保留重複結果，不自動學習壞基準；不取代聽感與長時間驗證 |

## 工具與演進邊界

現有建置採 electron-vite、打包採 electron-builder。依賴維持穩定版本路線；升级需重新跑相關檢查及媒體驗證，不能只因套件更新就沿用舊平台結論。

沒有為未来先引入 Effect、schema framework、monorepo、React、Rust 或完整 PlatformRecorder。當確實需要新視窗，可新增 UI renderer 但媒體仍不經 UI；當 Chromium 能力已確認不足，可在維持 Recorder 契約的前提下評估替代 host。沒有排程的錄影庫、編輯、快捷鍵、自動更新、Windows 實機驗證，以及 macOS 與 Windows x64 以外的平台支援，不是目前下載版的必要前置。

歷史原生引擎候選與第三方比較未當成現有實作或未來承諾；需要採用時重新調查相應 API 與依賴。
