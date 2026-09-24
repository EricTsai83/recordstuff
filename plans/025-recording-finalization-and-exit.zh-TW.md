# 025 — 錄製終止、存檔收尾與安全退出

[English](025-recording-finalization-and-exit.md) | [繁體中文](025-recording-finalization-and-exit.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

錄影失敗 UI 已另行實作：立即 pending 狀態、App 內結果／確認，以及整合式 tray 標記（見[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影失敗結果)）。本計畫仍未完成：須將既有呈現與下方終止負責者／退出協調器整合，包含退出待處理提示；不重做通知收件匣，也不宣稱重啟復原。

## 範圍與證據

處理 bug **3、4、10**，接在 [已完成的 024](../docs/zh-TW/verification/history-2026-09.md#plan-024-完整寫入--2026-09-24) 後。實際 before-quit callback 在待命但失敗清理未完成時允許退出；正常 finish 超過 10 秒也會呼叫退出。另一個真實 FileWriter 測試在延遲複製期間注入 host 崩潰，重現「先回報保留暫存檔，稍後 finish 刪掉它，且不發 saved」。這些是受控回歸證據，尚非原生退出造成資料損壞的量測。

影響：[Recorder](../src/main/recorder.ts)、[退出整合](../src/main/index.ts)、[FileWriter](../src/main/file-writer.ts)、生命週期測試與雙語提示。保留正式檔名不覆寫及 024 完整寫入契約。不加入 remux、崩潰恢復、背景 helper 或原生媒體重寫。

## 第二輪擴充：R2-01、R2-02

併入本計畫，因為 renderer 終止與 main 存檔是同一條端到端負責關係。R1 指第一輪、R2 指第二輪；上方原有 bug 編號屬 R1。

R2-01（P1）：[CaptureHost](../src/renderer/capture-host.ts) 在 encoder error 立即 finish，只等待當時的 chain；稍後最後一筆 dataavailable 加入的是更新後的 chain。實際 renderer 的受控測試送出 started、chunk、error、chunk；最後一筆到達前 main 已清掉 session。與 024 不同，這些資料還沒進入 FileWriter。R2-02（P2）：音訊 track ended 後，onstop 等 blob 完成才讀可變的 stopRequested；等待期間使用者 stop 會把意外中斷改成正常 stopped。真實 renderer／模擬媒體測試重現 started、chunk、stopped 而沒有 error。兩者都未證明原生故障發生頻率。

- [ ] 終止開始時固定原因。意外 track end 或 encoder error 不可被晚到使用者 stop 覆蓋；正常 stop 先發生時，也不可因清理造成 tracks 結束而誤判錯誤。保留音訊／螢幕的正確診斷及真正存檔錯誤。
- [ ] Encoder error 先保留原因，等最後 dataavailable／stop 與最新 blob 交接 chain 完成，再送唯一終止訊息；track 清理不能破壞剩餘交接。缺 stop 或 host 消失須有有界恢復，回報失敗且只宣稱實際保留資料，不能保證救回硬崩潰遺失的資料。
- [ ] 測兩種先後順序、延遲 Blob 轉換、交接 rejection、重複 stop／error 與缺少終止事件。增加真實 CaptureHost protocol → Recorder → FileWriter 整合案例，檢查末筆內容、錯誤原因、唯一終止結果及無未處理 rejection。修 renderer 終止前的時序，同時保留 main 接受 stopped 後的負責關係。
- [ ] 下方錄製 smoke 與隔離 lifecycle fixture 一併涵蓋 protocol 修改。受控 encoder 故障與原生擷取／播放證據分列；編碼設定未變，不增加品質矩陣。

既有 Cap 比較針對 finalization／退出負責關係，不代表已確認 Cap 處理這些 MediaRecorder 事件競爭。

## Cap 評估

Cap 在[一般退出前分別檢查錄製與待完成存檔](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L3550-L3618)，並以[finalization registry 保有每個 project／attempt 的結果](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L1010-L1133)。這是 bug 3／4 的明確類似設計，也能作為 bug 10 單一收尾負責流程的參考；不代表 Cap 已測過完全相同的 Electron renderer 崩潰案例。

Cap 在[通過退出檢查後仍有資源清理期限與 watchdog](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L3745-L3817)，因此不能宣稱它永遠等待或保證強制退出安全。我們採用「先確認檔案安全，再清理一般資源」的分工，不複製 Rust 類型或整套 registry。RecordStuff 保留既有退出時自動停止錄製的行為，與 Cap 一般忙碌時拒絕退出有所不同。

## 實作順序與契約

- [ ] 每次錄製只有一個終止流程負責：擷取失敗／abandon，或正常 finalization。接受 stopped 後，晚到的 host crash／error／display 事件不可再啟動競爭的 abandon；存檔本身的磁碟錯誤仍須回報失敗。路徑穩定後才發出唯一一次 saved／failed。
- [ ] 獨立於 UI 狀態追蹤所有 opening、writing、finalizing、failure cleanup。先登記工作，再發出可能同步觸發退出的狀態事件。以工作集合取代會被覆蓋的單一 pendingFailure；新版失敗不能遺失舊版清理。納入啟動逾時後才完成的 writer open。
- [ ] before-quit 即使從 idle 進入，也使用同一個可重複呼叫的 shutdown coordinator。退出嘗試期間阻止開始新錄製；重複退出共用同一工作。維持自動要求停止，再等待所有磁碟工作；完成前持續保有檔案與 handle 的負責關係。
- [ ] 保留擷取停止回應期限，但不能用該期限結束仍在執行的存檔。期限到且磁碟工作未完時，取消／延後退出、維持 App 開啟，提供雙語「仍在儲存／清理」提示。不可提早摧毀 host／App 或宣稱 saved／kept。安全重設退出狀態以允許重試，第二次退出仍不可跳過待完成工作。不新增會丟資料的強制退出按鈕。
- [ ] 必要時在 writer 內阻止 publication 與 abandon 互相競爭；不能以清掉 session 指標假裝已取消 I/O。對外提供保留路徑前確認其結果穩定。擷取失敗後仍可開始後續錄製，但舊清理必須持續被追蹤。
- [ ] 更新雙語錄製／桌面設計，記錄一般退出契約與 force-quit 限制。

## 回歸與驗收

自動案例：idle 時延遲 abandon；兩次失敗清理正／逆序完成；啟動逾時後晚到 writer；finish 超過 10 秒；重複退出；退出中成功／失敗；stopped 前後 host crash／error；finalization 磁碟錯誤；真實暫存檔的內容與終止路徑。測 production 退出協調，不複製 busy 判斷當作測試。不可重複 saved／failed、遺失工作、刪除已宣稱保留的 partial、產生未處理 rejection 或提早 app.quit。

必要：`pnpm check`；全新 `pnpm start:app` 的開始／停止／存檔／媒體檢查／播放 smoke，加上錄製中退出與 idle 退出。另以隔離 Electron lifecycle fixture 延遲真實 copy／cleanup，透過 production wiring 要求退出，驗證有工作時程序仍存活、安全後才退出。僅 Recorder promise 測試不足以證明程序生命週期。使用限縮測試注入，不填滿磁碟、不改機器限制。若提示影響設定，追加 `pnpm acceptance:regression`；若修改原生通知，合併通知政策要求。

除非實作擴大，不做完整品質／fps 矩陣、長錄製、音訊保真、權限重設、拔除螢幕與發布檢查。在 030 完成前，媒體證據須明列可用 FFmpeg 實測的聲道 RMS，不只依整體綠燈判斷。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 評估是固定 revision `ce785e705e79652adba4b8bf752669c4093499e0` 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
