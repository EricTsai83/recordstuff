# 038 — 錄影健康防護

[English](038-recording-health-guards.md) | [繁體中文](038-recording-health-guards.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-25。排在 [026](../docs/zh-TW/verification/history-2026-09.md#plan-026-結案--2026-09-25)（已完成）之後、027 之前；[037](037-overlapping-recording-finalization.zh-TW.md) 重用本計畫定義的寫入積壓上限。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

RecordStuff 靠 heartbeat 偵測擷取 renderer 是否還活著，磁碟滿了則要等寫入失敗才知道。目前仍有四種狀況要到資料已經損失才被發現：輸出磁碟在錄影中耗盡空間、renderer 仍回應 ping 但編碼器不再送出 chunk、慢速儲存讓寫入積壓無上限成長、錄影中程序被終止而暫存檔從未被回報。本計畫為每一種各加一個小型防護，全部走既有的停止與失敗路徑。不新增狀態機狀態、不做復原或 remux、除既有儲存通知與失敗歷史外不加健康 UI，也不掃描輸出資料夾裡的無關檔案。另外承接 [026 結案](../docs/zh-TW/verification/history-2026-09.md#plan-026-結案--2026-09-25)的一項後續：通用的開始失敗不可蓋掉 writer 已保留的磁碟錯誤。

責任檔案：[Recorder](../src/main/recorder.ts)、[FileWriter](../src/main/file-writer.ts)、[歷史協調](../src/main/recording-result.ts)、[App 生命週期](../src/main/index.ts)、[翻譯](../src/shared/i18n.ts)及其測試。所有門檻集中一處並寫明初始目標值，只憑書面證據調整。

## Cap 參考

固定版本 `26e1a6d882f311d10b5317e9e0d29babe4f6737e` 的 Cap [在錄影期間每兩秒輪詢可用空間](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/crates/recording/src/output_pipeline/core.rs#L532-L615)，依[固定位元組門檻](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/crates/utils/src/disk_space.rs#L5-L8)發出[空間不足／耗盡健康事件](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/crates/recording/src/output_pipeline/core.rs#L391-L421)；其 muxer 維持[以位元組計的有界封包佇列](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/crates/cap-muxer/src/main.rs#L92)；啟動時寫入、正常退出時清除的[崩潰哨兵](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/crash_sentinel.rs#L1-L9)用來偵測未正常關閉的 session；[電源觀察者](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/power_observer.rs#L22-L33)記錄睡眠與喚醒。這些是能重打影格時間戳、重組片段的原生管線的原始碼參考；RecordStuff 收到的是不透明的 MediaRecorder 位元組，因此只借「觀察後停止」的形狀，不借復原機制。

## 實作契約

- [ ] **磁碟餘裕。** session 進行期間以單一 timer 用 `fs.statfs` 輪詢輸出資料夾的可用空間（初定每 5 秒；輪詢失敗只記一次 log，絕不因此停止錄影）。低於警告門檻（初定 1 GiB）每個 session 只記一次 log。低於停止門檻（初定 200 MiB）發出一次正常停止，讓檔案在仍有空間時排空、sync 並發布。儲存通知與 log 說明錄影因磁碟即將用盡而提前停止；該原因以既有 `saved` 事件的選用欄位攜帶，不另發第二個事件或用全域旗標。成功仍是成功，不進失敗歷史。若發布仍然失敗，沿用既有失敗路徑與部分檔案保留。不預留空間、不改資料夾、不降品質。
- [ ] **擷取停滯。** `started` 之後啟動一個 chunk 間隔 timer，每個被接受的 chunk 重設它；`stopped` 到達或 session 進入收尾時解除，讓正常排空不會被讀成停滯。到第一道界線（初定 10 秒沒有 chunk）記一次警告 log，到第二道界線（初定 30 秒）經既有終止失敗路徑以 `capture_failed` 加獨立 detail 失敗，保留部分檔案。heartbeat 不變；會回應但不送媒體的 renderer 從此是失敗而非無聲卡住。既有的第一個 chunk 期限仍負責第一個 chunk 之前的防護。
- [ ] **有上限的寫入積壓。** FileWriter 統計已接受但尚未確認寫入的位元組。當一次 append 會超過上限（初定 64 MiB）時拒絕它，並經 `output_write_failed` 加積壓 detail 讓 session 失敗，如現況保留第一個錯誤。不暫停、不丟棄、不重試：MediaRecorder 無法被節流，上限的目的是讓慢速或離線儲存以保留部分檔案結束錄影，而不是記憶體無限成長。把目前積壓量暴露給 log 與 037 的開始條件量測。
- [ ] **中斷證據。** session 建立暫存檔之前，用既有原子寫入在 userData 的專用目錄為每個 session 寫一個哨兵檔（檔名為 session id；內容為 session id、開始時間、暫存路徑），確保崩潰不可能留下沒有哨兵指名的暫存檔；哨兵寫入失敗只記一次 log，不阻擋錄影。每一種終止結果，包含失敗，都移除該 session 自己的哨兵。每個 session 一個檔案，037 的並行收尾新增／移除哨兵時就不需要共用的讀改寫。啟動時在歷史還原之前，每個殘留哨兵各轉成一筆失敗歷史，文案說明 App 在錄影中未正常結束、檔案可能不完整，然後移除該哨兵。重用既有的還原重檢：路徑只是查找提示，檔案仍在才是 partial，否則為 unknown。優先在既有 code 上用獨立 detail；只有使用者可見文案無法誠實表達時才新增 code，屆時同步更新共用驗證器、翻譯與所有消費端。這不是掃描孤兒檔案，也不是崩潰復原；單一實例鎖保證殘留哨兵屬於已死亡的程序。
- [ ] **睡眠與喚醒。** 以 `powerMonitor` 記錄 suspend 與 resume 及進行中的 session id，讓睡眠後的失敗可被讀為睡眠，而非不明原因的 track 中斷。本計畫不在 suspend 時停止錄影；錄影中睡眠的原生結果記錄於 035，供日後決策有證據。
- [ ] **開始期間已保留的磁碟錯誤。** writer 在擷取請求之前就開啟，而請求可能為了權限提示等待最多 120 秒，期間每 5 秒 sync 一次。若背景 sync 已失敗，之後這次嘗試又以通用的 `capture_start_failed` 結束（首片期限、擷取請求逾時、host start 拒絕，或 host 回報 `capture_start_failed`），失敗流程 abandon writer 時不會讀取該錯誤，於是磁碟已滿或已中斷連線的輸出磁碟，會被顯示為「無法開始錄製」加上檢查設定的建議。分類這類失敗前先排空 writer，改以它保留的代碼（`disk_full` 或 `output_write_failed`）回報，並沿用既有的資料夾／磁碟建議。保留權限、缺少音訊等具體的 host 原因；writer 正常且沒有收到媒體時，維持 026 的 `capture_start_failed`。這是既有問題，於驗證 026 第一項 review finding 時發現，不是 026 引入的。
- [ ] 提前停止原因與中斷紀錄的雙語文案。更新雙語錄影設計（期限與故障隔離表、寫檔與失敗）與桌面設計（錄影失敗結果），並明寫不做任何復原或修復。

## 驗證與排除

- [ ] 注入時鐘與 stat 的可重現測試：跨門檻的警告後停止、只發出一次停止、輪詢失敗被忽略；以真實 Recorder 事件測停滯警告與失敗並保留非空暫存檔；以真實 FileWriter 對慢速寫入 stub 測積壓拒絕；哨兵在暫存檔存在之前寫入、saved 與每種失敗 code 都移除哨兵；哨兵寫入失敗不阻擋開始；啟動時兩個哨兵產生兩筆紀錄，涵蓋檔案存在／不存在；正常退出後沒有哨兵。檢查真實暫存檔內容與發出的事件，不只計算呼叫次數。
- [ ] 開始期間的磁碟錯誤：以真實 FileWriter 並讓週期 sync 在媒體到達前失敗，首片期限、擷取請求逾時與 host start 拒絕都回報保留的磁碟代碼，結果為 empty；writer 正常時仍為 `capture_start_failed`。
- [ ] `pnpm check`，再以新 `pnpm start:app` bundle 做錄影 smoke、驗檔與播放。磁碟防護在有界磁碟映像上操作，絕不用系統碟；中斷則在隔離輸出資料夾錄影中強制結束標示過的 bundle 再重新啟動。兩者都是 035 的引導原生案例（N30、N31）；測試不證明其通知與歷史呈現。
- [ ] 排除品質／音訊矩陣、權限流程與發布：本計畫不改編碼、來源選擇或狀態機。

## 完成與證據處理

依[共用測試政策](../docs/zh-TW/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 參考是固定 revision 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
