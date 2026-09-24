# 024 — 完整寫入錄影資料後才回報成功

[English](024-complete-recording-writes.md) | [繁體中文](024-complete-recording-writes.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-24。執行順序：下一個待執行的開發計畫。

## 問題與證據

[FileWriter.append](../src/main/file-writer.ts) 忽略 `handle.write(bytes)` 的結果，把整個輸入長度計為已寫入。成功返回的呼叫可能只寫入部分資料；剩餘資料因此遺失，`finish()` 仍可能把不完整檔案當作成功存檔。

調查時，在獨立的 macOS Node 子程序設定 `RLIMIT_FSIZE=2`，要求寫入六個位元組。真正的 FileHandle 回傳兩個位元組；目前 FileWriter 卻計為六個，並成功完成一個只有兩個位元組的檔案。限制只影響該子程序，暫存測試檔已清除。這是受控的資源限制重現，不代表一般錄影的故障頻率；先前的短寫注入測試也顯示相同計數缺陷。

Node/libuv 已會補寫許多底層短寫，但呼叫端仍必須尊重回傳量。部分成功後才發生錯誤，仍可能回傳正數的不足寫入量；單純儲存裝置較慢不能作為發生此狀況的證據。參考 [Node FileHandle.write](https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position) 與 [libuv 寫入處理](https://github.com/libuv/libuv/blob/v1.x/src/unix/fs.c)。

## 設計參考：Cap

採用設計原則，不照搬 Rust 語法或導入新的媒體架構。已檢視的 Cap revision：`ce785e705e79652adba4b8bf752669c4093499e0`。

- Cap 的[封裝程序通訊寫入](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/cap-muxer-protocol/src/lib.rs#L210-L238) 使用 `write_all`，完整送出每份資料或向上回報錯誤。
- 其[短寫回歸測試](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/cap-muxer-protocol/src/lib.rs#L561-L609) 限制每次最多寫七個位元組，確認 4096 位元組資料仍完整一致。該測試驗證程序間傳輸，不是直接寫 MP4 到硬碟；RecordStuff 借鏡的是完整寫入契約。
- Cap 的 [macOS 媒體 writer](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/enc-avfoundation/src/mp4.rs#L4383-L4475) 把媒體輸出交給 AVAssetWriter 並檢查狀態。本計畫不導入 AVAssetWriter。
- [Rust write_all 語意](https://doc.rust-lang.org/std/io/trait.Write.html#method.write_all) 作為參考：寫完整個緩衝區或失敗，無法取得進展時也必須失敗。

## 範圍與行為契約

在 FileWriter 內提供完整寫入保證。保留公開的 `append(): Promise<void>`、序列化佇列、每五秒 sync、既有錯誤碼及 Recorder 的 saved/failed 事件契約。保留工作目錄中既有的正式檔撞名修正與測試；該修正不是本計畫的實作成果。

1. 將 `WritableHandle.write` 回傳型別明訂為至少包含 `{ bytesWritten: number }`，相容 Node FileHandle；所有注入 handle 同步遵守此契約。
2. 在同一個佇列 append 工作內，反覆只寫入剩餘的 `Uint8Array.subarray(offset)`。每次成功立即依實際回傳量增加 offset 與總寫入量；同一 chunk 的各段之間不得插入後續 chunk 或 sync。
3. 整個 chunk 寫完才 resolve。空 chunk 不呼叫 write 即完成；剩餘資料非空卻回傳零時立即失敗。負數、非整數、非有限值或超過剩餘長度的無效計數也必須失敗，避免計數錯誤或無限迴圈。
4. 拋出的 I/O 錯誤沿用既有首次失敗機制。保留 `ENOSPC → disk_full`；零／無效進展及其他寫入錯誤使用 `output_write_failed`。不盲目重試拋出的錯誤，也不從頭重寫已寫入部分資料的 chunk。
5. 部分成功後失敗，仍保留實際確認寫入量。後續 append 與 finish 必須 reject，finish 不得建立完成檔。abandon 關閉 handle、停止定時 sync，並保留非空 `.recording.mp4`；真正空檔維持既有盡力清理行為。此失敗路徑的背景佇列拒絕不得造成未處理的 Promise rejection。
6. Recorder 必須回報失敗及保留的部分檔案路徑，不得為該次錄影發出 saved；清理失敗錄影後仍可開始下一次錄影。

成功寫入與 fsync 是不同保證。維持既有 flushing 行為，不承諾所有 crash、斷電或檔案系統故障都可復原；保留部分 MP4 也不保證可播放。

## 實作順序

- [ ] 1. 在 [file-writer.test.ts](../src/main/file-writer.test.ts) 加入會失敗的行為回歸測試，檢查真實暫存檔內容與計數，記錄修正前失敗結果。
- [ ] 2. 在 [file-writer.ts](../src/main/file-writer.ts) 實作具型別的完整寫入迴圈與進度計數。檢查注入 handle 與失敗清理的呼叫端；僅在上述契約需要時調整生命週期程式。
- [ ] 3. 加入聚焦的 [Recorder 測試](../src/main/recorder.test.ts)，使用真正的 FileWriter 搭配短寫／錯誤注入，驗證失敗、部分路徑回報、不發 saved、清理及後續成功錄影。不可只用直接拋錯、未經 FileWriter 的 mock 代替。
- [ ] 4. 完成下述檢查，將已驗證的契約與限制同步至[英文錄影設計](../docs/system-design/recording.md)及[繁中錄影設計](../docs/zh-TW/system-design/recording.md)。
- [ ] 5. 將永久結論保留在雙語驗證文件；依[計畫完成規則](README.zh-TW.md#完成計畫)，必要工作完成後才更新雙語索引並移除此計畫與翻譯。保留失敗與受阻證據。未另行要求，不 commit、push 或發布。

## 回歸案例

| 案例 | 必須觀察到的結果 |
| --- | --- |
| 一次寫完與空 chunk | 內容／計數正確；空輸入不呼叫 write |
| 連續短寫 | 每次最多七個位元組，4096 位元組資料仍逐位元組一致 |
| 多個 chunk 排隊，立即要求 finish | 順序串接且不漏寫／重複；finish 等所有剩餘資料寫完 |
| 部分成功後 ENOSPC／EIO | 分類與實際計數正確，包含第一個 chunk 內已寫部分；保留部分檔，不產生完成檔 |
| 尚未寫入／已有資料後回傳零 | 立即失敗、不無限迴圈；分別清理空檔或保留非空部分檔 |
| 無效回傳計數 | 拒絕且不錯誤增加已寫入量 |
| 首次失敗後 append／finish／abandon 及 timer 活動 | 不再寫入或完成存檔、無未處理 rejection；清理時釋放 handle 並停止 timer |
| 正式檔撞名 | 既有錄影前／途中撞名測試持續通過，實際回傳路徑內容完整 |
| Recorder 錯誤傳遞與恢復 | 發出失敗與部分路徑、不發 saved，下一次錄影可成功 |

使用可重現的注入 handle 搭配真實暫存檔。即使預期失敗，測試 teardown 仍須清理 writer／timer。先前的程序檔案限制實驗是補充證據；測試套件不需改變使用者磁碟容量、全機限制或正式 App 的限制。

## 檢查與驗收

依[共用測試政策](../docs/zh-TW/testing.md)，本變更影響檔案寫入與錄影失敗行為。

- 最終實作必要自動檢查：`pnpm check`（型別、測試、正式建置）與 `git diff --check`。開發時可先跑聚焦測試；沒有新修改或未解疑慮，不重複已通過的複合檢查。
- 必要原生 smoke：以 `pnpm start:app` 建置新 bundle，依[共用案例](../docs/zh-TW/acceptance.md)開始、停止、存檔、驗證媒體並觀察播放。原生 computer use 由 GPT-6 Astra 依[驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)執行；可使用 skill 支援的無人值守 `pnpm acceptance` 供應開始／停止／存檔／媒體結果，播放另行觀察。先前撞名修正的驗收不能算作本次新實作的驗收。
- 變更的失敗案例由受控 FileWriter／Recorder 測試涵蓋，與成功的真實螢幕／系統音訊錄製分開報告。不為模擬 ENOSPC 而填滿使用者磁碟。
- 共用 `out/`／`dist/` 的建置必須序列化；每輪桌面／音訊／快捷鍵由單一執行者使用。記錄環境、設定與證據，還原變更、關閉測試 UI、正常退出並確認受測 App 程序全數結束。
- 排除：設定回歸、權限重設、硬體拔除、完整畫質／fps 矩陣、長錄影、音訊保真與發布／安裝檢查；除非實作擴及這些行為。
- 缺少原生驗收前置條件應記 blocked，而非不適用。分開報告檢查／結果、範圍排除及必要但未驗項目；不可只因單元測試通過就標示計畫完成。

此次僅建立計畫，檢查連結／錨點、指令名稱、翻譯與 `git diff --check`；不因新增計畫就建置或啟動 App。
