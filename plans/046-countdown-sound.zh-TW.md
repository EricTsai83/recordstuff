# 046 — 可選的倒數音效

[English](046-countdown-sound.md) | [繁體中文](046-countdown-sound.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-27。排在 [045](045-countdown-digit-scaling.zh-TW.md) 之後、[035](035-guided-native-acceptance.zh-TW.md) 之前，035 仍在最後。本計畫與 045 沒有硬性相依；兩者都會修改倒數 overlay 頁面與相關文件，依序執行可避免重疊修改。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

目前倒數沒有聲音：040 排除了音效（[設計決策](../docs/zh-TW/system-design/decisions.md)）。維護者於 2026-09-27 要求加一個開關，讓倒數可以關閉、有聲音，或沒有聲音。本計畫在「錄影設定」新增「倒數音效」開關；開啟時，每個數字出現都伴隨一聲短促的 tick。

tick 只在數字倒數期間播放。歸零或開始錄影時沒有聲音，取消倒數時沒有聲音，倒數關閉時也沒有聲音。其他都不變：數字的外觀與大小（045）、時間、取消方式、選單列與錄影流程維持原樣。不新增其他音效（例如儲存或失敗音效），倒數長度仍為關閉、3、5 與 10 秒。

維護者決策（2026-09-27）：提供這個開關，且與倒數長度彼此獨立。本計畫的假設（實作前維護者可更改）：音效**預設關閉**，既有使用者也一樣，讓更新後不會突然聽到聲音，040 的無聲倒數仍是預設行為。

## 為什麼錄影仍然乾淨

RecordStuff 會錄系統音訊，而擷取請求中的 `restrictOwnAudio: true` 是否能把 App 自己的聲音排除在外尚未驗證；這正是 040 沒有加開始音效的原因。Cap 會播放開始音效，並[等音效離開裝置後才開啟開始 gate](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/recording_start_sound.rs#L5-L14)。本計畫兩者都不需要：每個 tick 都很短且與數字同時播放，所以最後一聲（數字 1）在 `MediaRecorder.start()` 前整整一秒開始，遠在擷取前就結束。因此正確性建立在時間上的分離（與數字相同），而不是 `restrictOwnAudio`。驗收回合仍會檢查錄影開頭的音訊是否含有 tick。

## 實作約定

- [ ] **先由維護者選擇。**修改原始碼前，讓維護者以平常使用的輸出裝置，按實際一秒一次的節奏試聽兩到三種候選 tick，例如短正弦波 tick 與較柔和的木魚般的 click，每種各兩種音量。使用相同 Web Audio 合成方式的靜態 HTML 草稿即可；草稿不是 repo 內的檔案。每個候選都避開測試素材 660 Hz 的 beep，讓分析工具能區分，且在 150 ms 內結束。實作前把選定的聲音、音量、最後一個數字是否換音高，以及預設值（除非維護者另有指示，否則為關閉）寫入本計畫。
- [ ] **共用數值。**在 [shared/countdown.ts](../src/shared/countdown.ts) 新增 tick 的數值（波形、頻率、長度、attack、release、峰值音量，以及最後一個數字的變化），每個都註明是維護者的選擇，模組仍不 import Electron 或 DOM。以單元測試確認 tick 長度小於 `tickMs` 減 `overlayLeadMs`，讓最後一聲在 overlay 離開與開始擷取前就結束。
- [ ] **設定。**`Settings.countdownSound` 為 boolean，與 `notifications` 一樣屬於新增欄位、不提升版本號：缺少或不是 boolean 時視為關閉。「錄影設定」在「倒數」之後直接新增「倒數音效」開關群組，並附說明：每個數字會伴隨一聲短促的 tick，開始錄影前就停止，不會被錄進去。倒數為關閉時停用此開關（保留其值），錄影期間與其他錄影設定一樣鎖定。新增 `setCountdownSound` 動作，並比照倒數設定記錄變更 log。標籤與說明都提供英文與繁體中文。
- [ ] **Session 快照與 presenter。**Recorder 在每個 session 讀取一次音效設定（與倒數秒數一起），並在建立 overlay 時傳給 presenter（`prepare`，以及 `show` 自行建立視窗時）。`prepared` log 行維持 [countdown-evidence](../scripts/lib/countdown-evidence.mts) 解析的前綴，並加上音效是否開啟。autorecord 在記憶體中保持音效關閉，矩陣與音訊品質量測永遠聽不到它。
- [ ] **播放 tick。**由 [overlay 頁面](../src/renderer/countdown.ts)播放，因為 main 本來就在 tick 時間把每個新數字傳給它：時間決策仍全部由 main 掌握，頁面呈現數字，並在音效開啟時播放對應的 tick。頁面從載入頁面的 query 參數得知音效是否開啟（`loadFile` 帶 query，或開發用 URL 帶相同參數），因此 preload、數值 channel，以及「頁面無法回傳」的規則都不變。頁面載入時建立一個 `AudioContext`，讓輸出在第一個數字前就已就緒，並依共用數值以 Web Audio 合成 tick；不需要音訊檔，也不用改 CSP。每個新數字播放一聲，重複的值與 `null` 不播放；倒數結束或取消時銷毀視窗即會靜音。overlay 視窗明確設定 `autoplayPolicy: "no-user-gesture-required"`，不依賴 Electron 的預設值。tick 依系統輸出音量與靜音設定。若 overlay 失敗，倒數會無聲地繼續，選單列仍顯示倒數，與目前數字失敗時相同。
- [ ] **驗收工具。**`pnpm acceptance` 回報音效是否開啟，並新增 `--countdown-sound`，在該回合開啟音效、結束後還原設定。音效開啟時，runner 以寫明的門檻檢查錄影前 500 ms 的音訊在 tick 頻率上是否有能量，並與既有的 marker 計數並列；marker 計數仍不得多出 beep 起點。通知與更新 runner 把倒數設為 0，不受影響；確認沒有其他 runner 會以使用者的真實設定與倒數來錄影。
- [ ] **文件與網站。**同步更新雙語文件：桌面設計（設定清單、設定檔範例，以及由 overlay 頁面播放 tick 的說明）、錄影設計的倒數段落（tick 的時間，以及它為何不會進入錄影）、設計決策的倒數列（可選的 tick、預設關閉、仍沒有開始音效及其理由）、函式參考中的新數值與動作、驗收指南的倒數列，以及工具指南中 `pnpm acceptance` 的選項。英文網站的說明文字寫了在哪裡選擇倒數長度；在同一處加入音效開關。

## 驗證與排除

- [ ] 單元測試：設定解析（缺少、非 boolean、true、false）與儲存；設定模型的開關（啟用、倒數關閉時停用並保留其值、錄影期間鎖定）與其動作；翻譯覆蓋；Recorder 把 session 快照傳給 presenter，並忽略 session 開始後的設定變更；overlay 視窗選項包含 autoplay policy，且檔案與開發 URL 兩種載入方式都帶有旗標；頁面以假的 `AudioContext` 測試：開啟時每個新數字依共用數值恰好播放一聲，關閉時不播放，重複值或 `null` 不播放；長度限制；autorecord 保持音效關閉；證據解析能讀取延伸後的 `prepared` 行。
- [ ] `pnpm acceptance:regression`（設定有變更；已包含 `pnpm check`），並檢查兩種語言的設定畫面截圖：開關開啟與關閉、倒數關閉時停用，以及鎖定狀態。
- [ ] 以新的 `pnpm start:app` bundle、預設 3 秒跑一輪 `pnpm acceptance -- --skip-cancel --countdown-sound`：log 顯示音效開啟；檔案通過媒體驗證；marker 計數與素材相符；前 500 ms 在 tick 頻率上沒有能量；數字裁切仍通過。取消路徑沒有變更，所以略過取消案例；關閉視窗本來就會靜音，單元測試也涵蓋 `null` 不播放。不重跑無聲回合：音效關閉時倒數走 040 的路徑，已由單元測試涵蓋。
- [ ] 在建置後的 App 中，確認 overlay 的 audio context 不需使用者手勢就會執行，例如在僅供開發的檢查中由 main 以 `webContents.executeJavaScript` 讀取其狀態，並記錄確認方式。代理無法觀察 tick 是否真的聽得到：回報為未經工具驗證，交由維護者判斷。
- [ ] `pnpm site:check`，並檢查變更的說明頁面。
- [ ] 排除：品質與音訊矩陣（擷取與編碼不變，且 autorecord 保持音效關閉）；長時間錄影；權限；選單列；數字的外觀與大小（045）；Windows（只驗證 macOS；頁面的 Web Audio 與平台無關，但不宣稱 Windows 行為）。tick 是否聽得到、是否悅耳、音量是否合適，包括藍牙耳機在裝置喚醒時可能截掉第一聲，都由維護者判斷，屬於 035。

## 完成與證據處理

依[共用測試政策](../docs/zh-TW/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占，且 tick 聽得到，音訊擁有者要預期會聽到它。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 同步更新雙語的 035：N32 也要聽到每個數字一聲、開始時沒有聲音，並以播放確認檔案中沒有 tick；N35 也要確認倒數關閉時開關停用、倒數與錄影期間鎖定，以及沒有此欄位的既有設定檔啟動後為無聲。並在 035 的核對說明中加入 046。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 參考是固定 revision 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
