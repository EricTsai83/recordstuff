# 四十項稽核修復（051）

[English](../../verification/audit-051.md) | [繁體中文](audit-051.md)

四十項修復均已實作；051 於 2026-09-29 完成引導式螢幕與權限補驗後結案。Tray 原生點選仍由維護者暫緩；精確分支的證據限制保留於下方。未 commit、push 或發布。

| # | 修復原因 | 修復結果 | 主要位置 |
| --- | --- | --- | --- |
| 1 | 自訂儲存目錄消失後被重建 | 只自動建立預設／開發覆寫目錄；自訂目錄不存在就報錯 | [file-writer.ts](../../../src/main/recording/file-writer.ts) |
| 2 | 退出可能丟失排隊設定 | 媒體安全後等待設定、視窗尺寸與 log flush；逾時延後退出 | [index.ts](../../../src/main/index.ts) |
| 3 | 退出保護安裝太晚 | 先安裝退出協調器，再等待首次使用檢查 | [index.ts](../../../src/main/index.ts) |
| 4 | 選資料夾期間可能開始錄影 | 共用單一對話框，回傳後重查操作許可 | [preferences.ts](../../../src/main/settings/preferences.ts) |
| 5 | 排隊設定引用可被呼叫端改動 | 入列前複製 patch 與快捷鍵／品質物件 | [settings.ts](../../../src/main/settings/settings.ts) |
| 6 | getter 洩漏內部可變物件 | 螢幕、品質、更新、快捷鍵偏好回傳副本 | [settings.ts](../../../src/main/settings/settings.ts) |
| 7 | 讀不到歷史卻顯示沒有紀錄 | 保留檔案並顯示載入錯誤，禁止覆寫 | [recording-result-store.ts](../../../src/main/recording/recording-result-store.ts) |
| 8 | 成功存檔後 sentinel 殘留誤報 | 先持久化完成路徑；重啟忽略完成 checkpoint，空窗狀態明示未知 | [session-sentinel.ts](../../../src/main/recording/session-sentinel.ts) |
| 9 | 複製後同步失敗留下正式副檔名 | 失敗時清理目的檔，保留原始錄影 | [file-writer.ts](../../../src/main/recording/file-writer.ts) |
| 10 | 擷取準備例外未收束 | 捕捉 applyQuality 例外、釋放 tracks 並回報失敗 | [capture-host.ts](../../../src/renderer/capture/capture-host.ts) |
| 11 | Blob 傳送堆積無上限 | 64 MiB 等待上限；超限停止並回報失敗 | [capture-host.ts](../../../src/renderer/capture/capture-host.ts) |
| 12 | finish 重複執行與晚到 append | 共用 terminal Promise 並拒絕關閉後 append | [file-writer.ts](../../../src/main/recording/file-writer.ts) |
| 13 | 大型 JSON 解析阻塞 main | 超過 1 MiB 由 worker 解析；保留格式驗證 | [recording-result-store.ts](../../../src/main/recording/recording-result-store.ts) |
| 14 | 歷史重複格式化與序列化成本 | 快取不可變列投影，傳送已載入範圍 | [settings-model.ts](../../../src/main/settings/settings-model.ts) |
| 15 | 歷史 DOM 一次無限增長 | 初始 50 筆，以顯示更多每次追加 50 筆 | [settings.ts](../../../src/renderer/settings/settings.ts) |
| 16 | 同步 log 阻塞事件迴圈 | 非同步序列寫入、1 MiB 佇列上限與 flush | [log.ts](../../../src/main/lib/log.ts) |
| 17 | 視窗尺寸同步 fsync | 非同步原子寫入，退出等待完成 | [settings-window-state.ts](../../../src/main/settings/settings-window-state.ts) |
| 18 | 解析度降級只寫 log | 設定診斷與通知顯示無法確認上限 | [index.ts](../../../src/main/index.ts) |
| 19 | 設定回覆過時覆蓋新狀態 | 單調 view revision；隔離舊視窗的傳送快取 | [settings-window.ts](../../../src/main/settings/settings-window.ts) |
| 20 | index 偏好副作用責任混雜 | 抽出 preference actions，集中許可、持久化與刷新規則 | [preferences.ts](../../../src/main/settings/preferences.ts) |
| 21 | 主螢幕找不到就錄第一個來源 | 所有選擇均要求唯一精確 id，不任意 fallback | [display-source.ts](../../../src/main/display/display-source.ts) |
| 22 | 來源列舉期間主螢幕改變 | 列舉後重查 generation 與 primary id 並有界重試 | [display-source.ts](../../../src/main/display/display-source.ts) |
| 23 | 所有列舉例外都誤判權限 | 保留例外原因並回報 capture_start_failed | [display-source.ts](../../../src/main/display/display-source.ts) |
| 24 | 準備阶段無法取消 | 選單取消支援 opening／preparing，清理仍由原 owner 負責 | [recorder.ts](../../../src/main/recording/recorder.ts) |
| 25 | 低磁碟仍開始擷取 | 開啟錄影前檢查 200 MiB 下限 | [recorder.ts](../../../src/main/recording/recorder.ts) |
| 26 | copy fallback 空間需求高於停止門檻 | 複製前檢查整個檔案大小加 8 MiB | [file-writer.ts](../../../src/main/recording/file-writer.ts) |
| 27 | 部分檔案 stat 無限等待 UI | 接收／顯示路徑 metadata 檢查最多等兩秒 | [recording-result.ts](../../../src/main/recording/recording-result.ts) |
| 28 | 權限狀態吞掉先前存檔通知 | needsPermission 可接收已完成錄影通知 | [saved-notification.ts](../../../src/main/recording/saved-notification.ts) |
| 29 | 通知 constructor 例外外洩 | 涵蓋支援檢查、建構與顯示的錯誤邊界 | [tray.ts](../../../src/main/menus/tray.ts) |
| 30 | 舊權限通知仍要求重啟 | 點擊時依目前狀態重查必要動作 | [index.ts](../../../src/main/index.ts) |
| 31 | 通知點擊已移動檔案無替代路徑 | 與既有 revealSaved 共用不存在檔案的替代流程 | [tray.ts](../../../src/main/menus/tray.ts) |
| 32 | 醒來後沒有通知也輪詢 | 只有 held notification 存在才啟動輪詢 | [tray.ts](../../../src/main/menus/tray.ts) |
| 33 | 快捷鍵衝突排除後無法重試 | 失敗診斷提供重試註冊控制 | [shortcuts.ts](../../../src/main/shortcuts/shortcuts.ts) |
| 34 | release 與 updater 版本語法不同 | 共用 stableVersion 並拒絕數字前導零 | [version.ts](../../../src/shared/version.ts) |
| 35 | 網站 JS 載入失敗時內容隱藏 | observer 安裝後才啟用隱藏樣式 | [Layout.astro](../../../website/src/layouts/Layout.astro) |
| 36 | 相對連結以網站根目錄解析 | 以來源頁 URL 解析 query、fragment 與相對位置 | [check-links.mts](../../../website/scripts/check-links.mts) |
| 37 | HEAD 302 被當下載有效 | 跟隨 redirect 並檢查最終成功狀態 | [release-manifest-client.mts](../../../scripts/lib/release/release-manifest-client.mts) |
| 38 | 媒體子程序無逾時 | 預設 15 分鐘上限，可覆寫，逾時 SIGKILL | [media-tools.mts](../../../scripts/lib/verification/media-tools.mts) |
| 39 | 工具存在檢查忽略退出碼 | version 命令必須以零退出 | [media-tools.mts](../../../scripts/lib/verification/media-tools.mts) |
| 40 | 測量 Markdown／JSON 部分更新 | 原子替換加 journal，中斷後下次追加先恢復配對 | [verify-recording.mts](../../../scripts/lib/verification/verify-recording.mts) |

## 驗證與限制

- 通過：最終 pnpm acceptance:regression，含 TypeScript、1,192 個測試、正式建置、171／171 設定案例與快捷鍵失敗整合。新增回歸涵蓋空檔 finish／abandon 並行、設定快照及 flush、對話框期間錄影、複製同步失敗／空間不足、準備例外、Blob 上限、大型歷史與分頁、完成 sentinel、版本語法及報告中斷恢復。
- 通過：pnpm acceptance:lifecycle 的 copy、cleanup、result 與 history 四種真實程序退出情境，均正常退出。
- 通過：git diff --check；已檢查異動文件相對連結／錨點及中英文命令。
- 通過：pnpm site:check 的 16 個測試、Astro diagnostics/build、線上 manifest 與連結檢查；4 頁、49 個內部參照、13 個外部 URL 無壞連結。T3 preview 已目視確認首頁 reveal 正常。
- 通過：pnpm acceptance:shortcut-layout（注音輸入法），輸入來源已還原。
- 通過：pnpm acceptance:updates -- --full --logic-only，版本篩選、fallback、timeout、持久化、重啟與退出取消。更新部分僅變動版本解析，因此不重複跑 updater fixture 錄影；普通 bundle 另有實錄。
- 通過：五次通知點擊均將 Finder 置前並選中正確檔案；原安裝 App 與偏好已還原。第一次前置檢查因既有 Finder 視窗而拒絕執行，關閉該錄影目錄視窗後重跑通過。
- 通過：原生設定語言保存、正常退出／重開、自訂目錄選取與還原。兩段約 10 秒的系統快捷鍵實錄均成功保存與完整解碼、包含畫面閃光與雙聲道音訊標記，倒數取消未留下媒體或失敗。最後快捷鍵重試路由修正前的建置存到 /private/tmp/recordstuff-audit-051-output；QuickTime 已實際播放，先前同範圍影片也驗證尾端跳轉。主觀聽感未判定。
- 通過：pnpm measure:cpu -- --fps 60。啟動閒置 0.048%、錄影後閒置 0.051%、背景設定頁 0.065%；30／60 fps 錄影平均 14.4%／20.6%。CPU 預算及程序生命週期均通過，這是預算驗證，未宣稱具統計意義的加速幅度。

新增點擊回歸找出快捷鍵重試被當成 accelerator，以及與既有隱藏「重試儲存」控制的 DOM ID 衝突；兩者均已修正。最後真實頁面點擊恢復註冊且保留原選取；較早失敗 fixture 紀錄仍保留於本機證據。

### 證據與界限

最後設定回歸：2026-09-28T16-25-03-009Z-settings-acceptance；快捷鍵整合：2026-09-28T16-25-55-763Z-shortcut-failure；生命週期：2026-09-28T15-59-19-218Z-lifecycle。錄影證據：2026-09-28T15-51-14-620Z-hotkey-acceptance（預設目錄）、2026-09-28T16-01-09-180Z-hotkey-acceptance（自訂目錄，重試路由修正前）。通知：2026-09-28T162758.157Z-notification-acceptance；更新：2026-09-28T16-29-17-242Z-updates-qDj7WY；鍵盤配置：2026-09-28T16-26-32-155Z-shortcut-layout。資料均在本機 docs/verification/measurements 下；該目錄 gitignore，不保證其他 checkout 具有檔案。

最後回歸、鍵盤配置、簽章建置退出、通知與更新皆在最後快捷鍵重試修正後執行。CPU（2026-09-28T16-02-59-528Z-cpu）、自訂目錄實錄與播放取自本輪較早的 dirty tree（HEAD 1d57d7138f43d035aefd9ed15fc9f3b4eabea298 加上本次修復）；之後僅修正重試動作的路由／識別值，因此沿用未再變動的錄影與計時器範圍證據。使用原生 computer-use acceptance skill；面板／播放器快照在工具觀察中，沒有虛構本機 PNG。網站截圖保留於 T3 browser-artifacts。

引導式原生補驗（2026-09-29）：在重新簽章的正常 bundle（HEAD 1d57d7138f43d035aefd9ed15fc9f3b4eabea298 加上本次修復）通過七個功能案例。使用者切換直向主螢幕後，11.5 秒、1080×1920 影片成功保存、完整解碼，並人工確認播放及尾端跳轉。倒數期間拔除該主螢幕，App 安全回到 idle，未留下媒體或改錄另一螢幕。錄影中關閉權限仍可保存有效的 27.8 秒影片；之後新錄影正確以 permission_denied 拒絕且無媒體殘留。重新允許權限後，原程序不重啟即恢復；點舊權限通知只開設定、不重啟。最後由 agent 錄製 10.4 秒、1920×1080 影片，完整性檢查通過（10 次閃光／10 次嗶聲），原生 QuickTime 觀察確認播放前進及跳回開頭。證據在本機 docs/verification/measurements/2026-09-29-audit-051-guided/report.md 與 recovery-smoke/report.md。兩次桌面接管均等到使用者明確回覆「好了」；硬體及隱私權開關由使用者操作。

結案保留限制：拔除發生在倒數期間，不是 getSources 等待中，因此精確列舉競爭仍只有 deterministic 覆蓋。撤銷權限後存檔發生在 idle，而非 needsPermission；該 saved 通知分支也仍未原生覆蓋。第一次拔除實際移除了副螢幕，保留紀錄但不算主螢幕拔除通過。工具存取無視窗 tray 曾回傳 -10005 timeoutReached，維護者明確暫緩點選，並非標為通過。檔案系統故障採注入，未填滿或拔除真實磁碟。計畫依已觀察的螢幕／權限案例及 tray 處置結案，不宣稱所有 OS 時序分支均實測。

補驗清理通過：設定 JSON 未變，雙螢幕與原橫向主螢幕還原、權限開啟；本輪素材／播放器／系統設定 UI 已關閉，RecordStuff／helpers 正常退出，caffeinate 已停止。保留測試影片及預期失敗紀錄。QuickTime 截圖是對話工具觀察，非本機 PNG；未判定主觀聽感。

依範圍省略：完整解析度／品質矩陣、長錄影、音訊 fidelity 診斷、首次權限設定與發佈／安裝測試；未改動編碼參數或音訊處理。這是 dirty working tree 的開發驗收，不是發佈驗收。

測試期間使用 caffeinate，結束後已停止。最終清理通過：偏好與原有 Finder 錄影資料夾視窗已還原，RecordStuff／helpers、QuickTime 與測試 fixture 均已退出；App 保持關閉。正常程序退出可等待 I/O，但 force quit／斷電無法保證媒體恢復；sentinel 發佈與完成 checkpoint 的極短空窗明示未知。Metadata timeout 不會取消底層 OS 檔案請求。報告 journal 為下一次寫入恢復配對，不宣稱兩個檔案跨程序原子可見。

測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。
