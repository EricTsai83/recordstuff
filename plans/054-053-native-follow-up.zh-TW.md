# 054 — Plan 053 的原生驗收後續

[English](054-053-native-follow-up.md) | [繁體中文](054-053-native-follow-up.zh-TW.md)

狀態：已規劃。建立日期：2026-09-29。執行順序：見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與範圍

Plan 053 於 2026-09-29 結案時，還有三項原生檢查沒有完成（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-053-結案--2026-09-29)）。它的程式碼已合併並有單元測試涵蓋；本計畫補齊缺少的證據，只有在檢查失敗時才修改 App 程式碼。2026-09-29 的 20 項稽核另外加入兩項 runner 修正與兩項原生觀察，列在最後。

- **已安裝 App 的通知點擊。** 點擊通知不可開啟設定。開發版 bundle 執行中時，點擊讓 macOS 啟動了登記在 /Applications 的那一份，它以 `second-instance` 通知開發版；因此 053 在通知點擊後 2 秒內忽略 `second-instance` 與 macOS reopen（`activate`）（[desktop](../docs/zh-TW/system-design/desktop.md#設定快捷鍵)）。登記的那一份自己在執行時點擊會收到什麼，尚未觀察到：該回合因 session 鎖定而停止。Plan 014 記錄到啟用發生在 click 回呼後約 110 ms，支持這個時間窗但不構成證明。
- **真實報告中的 checkpoint。** `pnpm measure:finalization` 因 053 worktree 的開發版 Electron.app 沒有螢幕錄製授權而 blocked，因此還沒有任何報告顯示 `checkpoint`（[tooling](../docs/zh-TW/system-design/tooling.md#收尾量測)）。
- **殘留的權限提示。** 那次 blocked 的執行在畫面上留下 macOS 的「Electron 正在要求略過系統私密視窗選擇器」提示；必須按「不允許」而非「允許」，讓 worktree 的那一份不取得授權。
- **提早失敗後的快捷鍵 runner。** `pnpm acceptance`（[acceptance-hotkey.mts](../scripts/acceptance-hotkey.mts)）在 `--seconds` 之後送出停止鍵，沒有先確認它的 session 是否已經結束。2026-09-29 有一個 session 在錄影約 8 秒時以 `capture_start_failed` 失敗（第一個 chunk 期限前沒有 media）；停止鍵送到已回到 idle 的 App，反而開始新的 session，runner 讓它停在 `starting` 直到 120 秒的擷取請求期限。修正：送出停止鍵前，找出這個 session 在 capture 紀錄之後的結束紀錄（`saved` 或 `failed`）；若已存在，直接回報而不送出按鍵。判斷放在有單元測試的純函式中。
- **倒數音效的誤判。** 同一個 runner 的 tick 檢查（[countdown-evidence.mts](../scripts/lib/countdown-evidence.mts) 的 `compareTickLevels`）在 tick 的兩個音高 523 與 784.5 Hz，比較錄影前 500 ms 與 2 秒後同一相位。2026-09-29 一段正常的錄影在這裡失敗，測到 −41.8 與 −40.1 dBFS，對照為 −69.2 與 −71.5：擷取開始時素材的 beep（660 Hz、120 ms、約 −10 dBFS）正在發聲，所以檔案開頭是 40 ms 的數位靜音，接著 beep 直接以滿音量出現。這個陡峭的起音讓能量在約 100 ms 內擴散到兩個 tick 音高；2 秒後同一個 beep 有 10 ms 的 attack，就沒有這個現象。這段錄影本身通過所有媒體檢查，有 10 次閃光與 10 次 beep，最後一聲 tick 在擷取前約 1 秒就結束。修正方向由實作者決定：在同一段 frame 中以素材音調為基準判斷 tick 音高（真正的 tick 在自己的音高比 660 Hz 大聲，頻譜外洩則相反），或略過檔案開頭就在播放中的素材 beep。補上單元測試：開頭被截斷的 beep 必須通過，既有注入 tick 的案例仍須失敗。
- **稽核的原生觀察。** 同一次稽核修改了兩條只有單元測試涵蓋的通知路徑。(a) 真實睡眠喚醒後，睡眠期間被扣住的通知，只要使用者喚醒後操作過 Mac，即使最後一次輸入已超過 2 秒也必須出現；沒有輸入的維護喚醒則必須繼續扣住。(b) 點擊「無法註冊快捷鍵 …」通知會開啟設定；這需要另一個 App 占用錄影快捷鍵，只有該回合能製造這個衝突時才觀察。

不在範圍內：新功能；擷取開始通知的錄影，它需要大於最小解析度上限（1080p）的螢幕，以及擷取無法確認的上限，參考機上兩者都沒有；只有接上這類螢幕時才執行。

## 驗證

- [ ] 回合開始前：依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)確認 session 已解鎖；session 鎖定時，回合在啟動任何東西前停止。
- [ ] 對殘留的 Electron 權限提示按「不允許」。
- [ ] 在主 checkout 的 `main` 上以 `pnpm start:app` 建置全新簽署的 bundle 並結束它，再執行 `pnpm acceptance:notification -- --install --clicks 2`。通過條件：runner 判定點擊通過、已安裝的 App 已還原並驗證，且 App log 在任何點擊後都沒有 `reopen: … Settings opened`。出現 `reopen: … ignored … ms after a notification click` 是預期的證據，代表時間窗攔下了啟用。若設定被開啟，記錄事件及其在 `notification: clicked` 之後的延遲，再以另一個變更修正時間窗或 listener。
- [ ] 在開發版 Electron 已有螢幕錄製授權的主 checkout 執行 `pnpm measure:finalization -- --dir <絕對路徑資料夾> --repeat 1`。通過條件：該段錄影儲存並驗證通過，報告中 `checkpoint` 有數值。
- [ ] 選做，只在有大於 1080p 的螢幕時：以 1080p 上限錄一次，確認任何擷取開始通知都在存檔後出現、錄影期間不出現。
- [ ] Runner 修正：`pnpm typecheck` 與兩項修正的單元測試；接著在全新 bundle 上跑一次 `pnpm acceptance -- --seconds 10`，必須仍能正常錄影、停止、存檔並通過 tick 檢查。提早失敗的分支與被截斷的 beep 由單元測試涵蓋，不要為了重現而弄壞擷取，或刻意讓錄影在 beep 中開始。
- [ ] 稽核觀察 (a)：回合中在錄影中選擇睡眠，錄影會存檔並扣住「已儲存 …」通知（plan 050）；喚醒 Mac 後碰一次鍵盤或觸控板，再放著超過 2 秒。通過條件：被扣住的通知不需再次輸入就出現，log 依序有 `notification: held during sleep` 與 `notification: shown`。
- [ ] 稽核觀察 (b)，選做：在另一個 App 占用錄影快捷鍵時重新啟動 RecordStuff，點擊拒絕註冊的通知。通過條件：設定開啟。若無法製造衝突，記為未執行。
- [ ] 排除：capture matrix、長時間錄影與音訊保真度；擷取與編碼沒有改變。

## 完成與證據處理

遵循[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。每一回合只有一個桌面擁有者。還原所有變更的設定、關閉測試 UI、結束受測的 App 並確認程序已結束。

- [ ] 以中英文把結果加入 plan 053 的紀錄或新的日期紀錄，更新兩個索引，再移除本計畫與其翻譯。未經另外要求，不 commit、push 或發布。
