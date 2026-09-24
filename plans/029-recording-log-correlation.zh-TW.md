# 029 — 錄製紀錄配對與 log 輪替下的可靠驗收

[English](029-recording-log-correlation.md) | [繁體中文](029-recording-log-correlation.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍與證據

處理 bug **7**，排在 028 後，相依於 025 穩定的終止負責流程。Log 中 A=1080p、B=4k，A 先失敗但 B 先清理完成，[pairRecordingsWithLog](../scripts/lib/verify.mts) 會交換兩者設定。Recorder 允許舊清理尚在進行時開始下一次擷取，因此完成順序不能代表身分。

影響：Recorder 終止事件 metadata、[主程序 log](../src/main/index.ts)、[log 配對](../scripts/lib/verify.mts)、autorecord／acceptance 消費端及測試。保留產生端 log 輪替政策，修正跨輪替讀取；不加雲端遙測、不改影片格式。

## 第二輪擴充：R2-07

R2-07（P2）與 R1-7 合併，因為驗收消費端需要同時確保事件歸屬與可靠讀取。[waitForLog](../scripts/lib/acceptance-runtime.mts) 從舊 active file 行數搜尋，而 [acceptance-hotkey](../scripts/acceptance-hotkey.mts) 在輪替後只讀新的 active file。真實 FileLogger／rotateLog 測試先有 31 行舊檔，再於 3 行新檔寫入 saved，waitForLog 仍逾時。清理的 slice(from) 也有相同行號失效邊界；未證明實際原生清理失敗。

- [ ] 以可跨輪替的 cursor／reader 取代原始行數 checkpoint，等待與清理共用。保留 production 輪替／保留政策；結合檔案身分、位置與 session ID，不能漏事件或接受舊錄影結果。
- [ ] 切檔時追讀仍保留的輪替片段，容忍暫時不存在與未完整末行，重讀去重。若保留期限已移除 cursor 所需歷史，明確回報證據缺口，不假定成功或只給無原因逾時。
- [ ] 用真實暫存 log 測開始／停止／存檔／失敗清理中輪替、多次輪替、截斷、重啟、重複事件與缺片段。檢查有界逾時、清理不多送 start／stop toggle，且能讀到新檔 saved。測 production reader 與清理 wiring，不複製搜尋迴圈。

Cap 的身分模型參考，未證明可跨輪替的文字 log 消費方式。

## Cap 評估

Cap [以 project identity 管理 finalization attempt，並配置 attempt UUID](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L1010-L1133)，不依完成先後判斷歸屬。可參考其識別模型。檢視桌面 finalization／diagnostic 路徑未找到等價的時間順序文字 log parser，不宣稱 Cap 修過我們完全相同的 parser bug。

## 實作與測試

- [ ] 既有 sessionId 貫穿 capture、saved／failed、保留路徑與開始／停止時間。明確區分沒有 attempt 的 preflight refusal，不能借用前一次 session。保留消費端相容性，或同步更新全部型別呼叫者。
- [ ] 新增帶版本、正確跳脫的結構化診斷紀錄，含 sessionId／完整路徑，以及未保留檔案的失敗。可保留人讀訊息，但新分析器不能將兩種格式計為兩次結果。保留 autorecord 成功／失敗語意。
- [ ] 每次啟動配一個 run id（初定為啟動時間加 pid），印在既有的 `start:` 行並帶入每筆結構化紀錄，讓消費端能分辨 App 重啟與 log 輪替，跨啟動配對 session 時不必猜行序。不在每一行人讀訊息加前綴；start 行與結構化紀錄已足夠。2026-09-25 自 T3 Code／Cap 架構比較併入：T3 Code 在每行 log 都蓋每次執行的 id。
- [ ] 依 session 身分配對，不依到達順序。避免只用 basename 而讓不同目錄同名碰撞；統一路徑識別正規化，不能要求失敗／已不存在檔案可 realpath。重複終止紀錄可重複讀取，矛盾結果須標示。
- [ ] 保守讀取歷史 log：只有唯一可判定的舊格式才配對，否則顯示未知／不明確，不做相依品質結論。兩個尚未配對的舊失敗不能只因某個先印出就猜歸屬；不能為了綠燈製造配對。
- [ ] 覆蓋 A／B 逆序、不同／無檔案結果、三次交錯、重複紀錄、不同目錄同 basename、含空白特殊字元路徑、混合新舊格式、未知 ID、preflight 失敗。包含真正 Recorder 驅動 log 的整合測試，不只手寫 log。
- [ ] 更新雙語工具／log 格式文件；保留歷史證據，不重寫舊 log。

必要：`pnpm check`、針對性 parser／消費端測試與保留 log 重播。R2-07 會修改 runner 等待／清理，因此須在全新 `pnpm start:app` 上執行 `pnpm acceptance`，驗開始／停止／存檔／媒體並觀察播放；另於隔離 runner fixture 強制輪替測失敗／清理路徑，不改使用者真實 log。不能沿用純 metadata 變更免原生錄製的排除。排除設定、媒體矩陣、權限與發布；metadata 不明確與獨立媒體量測分列。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 評估是固定 revision `ce785e705e79652adba4b8bf752669c4093499e0` 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
