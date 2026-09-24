# 026 — 拒絕將空錄製發布為成功

[English](026-reject-empty-recordings.md) | [繁體中文](026-reject-empty-recordings.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍與證據

處理 bug **9**，接在 025 與 024 後。真實 Recorder／FileWriter 測試送出 started，再要求停止並回 stopped，全程沒有媒體 chunk，仍產生零位元組正式 MP4 與 saved。Renderer 會略過空 blob。尚未原生重現 MediaRecorder 零輸出的時序，不宣稱所有快速停止都會失敗。

修改 [Recorder](../src/main/recorder.ts)、[FileWriter](../src/main/file-writer.ts) 與測試，必要時調整 renderer／錯誤提示。不加入任意最短錄製秒數、MP4 parser、執行期 ffprobe 相依或完整可解碼保證。

## Cap 評估

Cap 的 AVFoundation writer 在[沒有最後影格時以 NoFrames 拒絕 finish](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/enc-avfoundation/src/mp4.rs#L961-L990)，明確支持拒絕空輸出的原則。但 RecordStuff 收到的是編碼後 chunk，不是影格時間戳。非零位元組只是必要的最低門檻，不足以證明含可解碼影格，不能宣稱和 Cap 的媒體檢查完全相等。

## 實作與測試

- [ ] 成功須有非空媒體且寫入全部完成。使用 024 的 FileWriter 實際位元組計數，不信任要求寫入的 chunk 長度，不為空 chunk 加總。在 FileWriter 發布前再次防守；Recorder 的無媒體失敗走 025 單一終止流程。
- [ ] 沒有媒體時沿用既有的 `capture_start_failed` 並附獨立 detail，與已使用該代碼的第一個 chunk 期限一致，提供清楚雙語提示。只有使用者可見文案無法誠實表達時才新增代碼，屆時同步更新共享驗證器、翻譯與全部消費端。零輸出不可發 saved 或設定 lastSavedPath。真正的磁碟寫入錯誤保留原代碼。
- [ ] 關閉 handle 與同步 timer，清除確實為空的暫存檔；其他失敗保留非空 partial。可立即重試成功。不可只因時間很短而拒絕非空且有效的錄影。
- [ ] 覆蓋 started→stop→stopped 無 chunk、只有空 chunk、stopped 前最後一筆非空 chunk、首筆 append 尚未完成、寫入失敗、重複 stopped 與重試。對真實暫存檔大小／內容與事件斷言，確保零寫入不能繞過 writer 防守。
- [ ] 更新雙語錄製設計，區分「非空」與「可播放」。

必要：`pnpm check`；全新 `pnpm start:app` smoke、媒體檢查／播放，加上可實際操作的立即停止。記錄真實結果，不要求原生擷取一定產生空 blob；受控無媒體測試另列證據。若影響設定或通知行為，合併相應驗收政策。此範圍僅拒絕零輸出，不做完整矩陣、長錄製、權限與拔除螢幕。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 評估是固定 revision `ce785e705e79652adba4b8bf752669c4093499e0` 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
