# 030 — 以實測證據驗收音訊與影音同步

[English](030-audio-verification-evidence.md) | [繁體中文](030-audio-verification-evidence.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍與證據

處理 bug **8**，排在 [029](../docs/zh-TW/verification/history-2026-09.md#plan-029-結案--2026-09-25)（已完成）後；parser／報告介面穩定後可獨立實作。[judge](../scripts/lib/verify.mts) 在 channelRmsDb 未提供時，把要求雙聲道都有能量的檢查標為 pass；[verify-recording](../scripts/lib/verify-recording.mts) 缺少 ffmpeg 時正會略過 RMS。受控純 metadata 測試已重現錯誤通過，不宣稱錄製 App 本身發生原生音訊失敗。

範圍為分析器、媒體工具邊界、報告／CLI／acceptance 消費端與受控媒體測試。不修改錄製編碼，也不為了通過測試調整音訊門檻。

## 第二輪擴充：R2-05

R2-05（P2）與 R1-8 合併：兩者都把缺少必要證據當成成功驗收。[run-matrix](../scripts/run-matrix.mts) 要求 sync，卻只對 fail 回傳失敗。提供有效 format／fps／duration／左右 RMS、syncAttempted=true，但沒有 flash／beep 配對時，真實 measure／judge 路徑回傳 sync n/a、整體 pass。這是受控 verdict 重現，並非實際錄錯螢幕的原生 matrix 測試。

- [ ] 由呼叫端明確宣告必要證據。Matrix 必須有同步量測；未要求同步的資訊報告可保留 n/a。缺工具屬 blocked／incomplete，素材配對不足屬 incomplete 或帶原因的 fail，量測超過門檻屬 fail；都不能讓 matrix 成功退出。
- [ ] 使用既有同步門檻定義並記錄最少有效配對數與時間覆蓋要求；短案例須足以估算 offset，長案例須有有效首尾區段才能判 drift。只有一筆配對或 syncAttempted 不代表覆蓋充分，不為通過樣本而放寬門檻。
- [ ] 必要同步／能量狀態貫穿個案、整體、文字／Markdown／JSON 與程序退出；盤點目前只認 fail 的消費端。保留獨立格式量測及不相關選測項。
- [ ] 測無 flash、無 beep、配對不足、只有開頭／缺結尾、畸形量測、offset／drift 超標及正常樣本。使用受控媒體與真正 matrix CLI 失敗路徑，驗證非零退出及清理；亦測未要求同步的資訊報告。

既有 Cap 解碼能量比較支持「斷言需要量測」，未確認它具有等價的 matrix 缺素材判定契約。

## Cap 評估

Cap 的[音訊同步矩陣會解碼樣本、傳遞 read_audio_stats 錯誤並拒絕接近靜音的輸出](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/recording/tests/sync_matrix.rs#L775-L802)。這能證明以實測支持聲音斷言，並非相同的缺 FFmpeg 判定模型，也不代表該案例分別驗了左／右聲道。採用證據要求，保留 RecordStuff 各聲道門檻並分別檢查兩者；不可直接將 Cap 線性 RMS 門檻搬入 dB 判定。

## 實作與測試

- [ ] 分開取樣率／聲道格式與各聲道能量。格式 metadata 可通過，而能量仍未量測。只有兩聲道有效量測值都超過既有門檻，能量才能 pass；靜音、缺聲道、格式錯誤與解碼錯誤不能變成通過。
- [ ] 明確表示缺量測與原因。必要驗收缺 FFmpeg 屬 blocked／incomplete；要求的量測執行失敗屬 fail。資訊報告刻意略過屬未量測，不能說能量 pass；不相關檢查仍保留真正 n/a。
- [ ] 一起更新整體 verdict、Markdown／文字／JSON 報告與 CLI exit：必要能量項目 blocked 或 fail，必須阻止 acceptance 成功並產生非零 CLI 結果。不可意外將其他歷史選測項全部改成必測。拆項目前先盤點依賴 metric 名稱與 verdict union 的消費端。
- [ ] 媒體工具邊界驗證 FFmpeg exit status 與輸出完整性。即使先印出可解析部分 RMS，最後非零退出也不算有效量測。保留 stderr／診斷上下文，不默默把缺值當成靜音或成功。
- [ ] 產生受控 stereo 媒體：兩聲道 tone、全靜音、單聲道靜音、錯誤／截斷輸入。在隔離子程序模擬缺執行檔／非零退出，不更動使用者 PATH 或工具。一起斷言每項、整體與 CLI 結果；若有保留的正常錄影，也納入分析。
- [ ] 更新雙語測試／工具報告說明與 fixture。歷史報告維持歷史定位，僅當缺證據影響目前結論時重跑分析。

必要：分析器／媒體工具／CLI 測試、`pnpm typecheck`、FFmpeg／ffprobe 受控媒體及 `git diff --check`。R2-05 擴大到 matrix 成功門檻與失敗／清理路徑，須實際執行受影響 runner：全新 bundle 上的 `pnpm matrix -- quick` 與 `pnpm matrix -- long`（首尾 drift 證據），保留開始／停止／存檔／媒體與播放觀察。隔離缺素材案例必須非零退出且完成清理。純分析器階段可先以 fixture 驗證，但不能據此結案整份計畫；缺 FFmpeg 屬 blocked。編碼與裝置未改，排除完整 levels／fps／音訊保真矩陣、權限重設與發布。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 評估是固定 revision `ce785e705e79652adba4b8bf752669c4093499e0` 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
