# 036 — 失敗歷史背景保存與安全退出

[English](036-async-failure-history.md) | [繁體中文](036-async-failure-history.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-25。排在 [025](../docs/zh-TW/verification/history-2026-09.md#plan-025-結案--2026-09-25) 之後立即執行，早於 [037](037-overlapping-recording-finalization.zh-TW.md) 與最後的 [035](035-guided-native-acceptance.zh-TW.md)。這是獨立實作工作，不代表目前歷史儲存已非同步化。

## 目的與範圍

目前失敗歷史在 main 同步序列化、寫入、fsync、rename；user-data 磁碟慢會卡住 UI，保存失敗需要手動重試。將這些資訊的處理移離 UI 執行緒，對可恢復失敗自動重試，正常退出／重新啟動時處理未保存歷史。錄影媒體本來已非同步依序寫入；本計畫不改影片收尾，也不允許正常停止尚未完成時開始下一段錄影。

責任檔案：[歷史協調](../src/main/recording-result.ts)、[儲存](../src/main/recording-result-store.ts)、[App 生命週期](../src/main/index.ts)、共用模型、設定 renderer 與測試，包含[設定 fixture](../scripts/fixtures/settings-panel.ts)。保留獨立 ID、全部未確認及最近確認 20 筆、逐筆警告、手動重試、升級、較新／損壞格式保護、原子替換與 32 MiB 安全上限。

併入的問題（2026-09-25）：回應慢於一個 frame 時，失敗紀錄操作會失去鍵盤焦點。[choose()](../src/renderer/settings.ts) 在保存期間把帶有焦點的「知道了」／移除按鈕設為 disabled；Chromium 的 focus fixup 會在下一次渲染更新時把焦點移到 `body`，而 `updateRecordingResult` 要等回應到達才依 `document.activeElement` 判斷是否還原，因此不會還原。在未修改的 HEAD `6377c62`，於設定 fixture 的 `recordingResult:` choose handler 加 100 ms 延遲後，「real mouse Got it acknowledges only the offered result and collapses it」、「acknowledged result can be reopened with keyboard」與「removing the final reviewed row returns keyboard focus to the active tab」2／2 次皆失敗；不加延遲時為間歇失敗（交錯執行的三次基準中有一次）。真實保存比 fixture 慢，本計畫非同步且落盤後才提交的確認會讓回應更慢，因此與此處的保存流程一起修正。VoiceOver 與原生行為尚未觀察。

025 負責媒體終止工作與唯一退出協調器。本計畫向該協調器登記 metadata 工作，不新增互相競爭的 before-quit handler。同意放棄提醒不代表可以放棄影片寫入。使用 [Codex 實作／Opus 5.5 review](../.agents/skills/codex-implement-with-opus-5-5-review/SKILL.md) 執行。

## 實作契約

- [ ] 採有明確擁有者的背景 worker 或同等隔離執行方式，處理序列化與磁碟操作；僅把同步寫入包在 Promise 不算完成。回應性量測包含啟動讀取／驗證／升級及快照傳輸成本；歷史未讀完前不得以空狀態覆蓋磁碟。讀取期間的新失敗依 UUID 合併；若需打包 worker，驗證建置 bundle 中確實存在且能啟動。
- [ ] 僅一個保存擁有者、一次寫入進行中；快照帶 revision，舊完成事件不能清除較新未保存資訊的警告。合併可取代的待寫快照，但不漏任何失敗或明確操作結果；最多一份寫入中、一份最新待寫，避免無限寫入佇列。逾時不等於取消 OS I/O，也不允許另一 writer／rename 競爭。
- [ ] 新錯誤立即可見。「知道了」／移除顯示本地化保存中，相關 revision 成功落盤才提交已確認／移除畫面狀態；等待期間的新失敗與較晚檔案結果不可丟失。防止重複操作，不全域鎖死錄影控制。操作失敗維持原狀並顯示該筆錯誤；只有真正未保存的紀錄才出現保存警告。獨立重試不改確認狀態。
- [ ] 操作等待期間保留焦點歸屬：在任何控制項被 disabled 之前，記錄由哪一筆紀錄、哪個控制項發起；回應或落盤提交到達時依此還原焦點——確認、收合或失敗後回到該筆的 summary，移除最後一筆後回到目前分頁。不依賴 `document.activeElement` 撐過等待；忙碌中的控制項可改用 `aria-disabled` 並忽略觸發，取代原生 `disabled`。等待期間使用者已移動焦點或視窗失去焦點時不得搶焦點，也不得把焦點移到其他紀錄的控制項。
- [ ] 可恢復寫入失敗使用單一 timer 與有上限退避：初定 2、5、15 秒，之後 dirty 期間最多每 30 秒重試。手動重試可立即觸發，但不複製進行中寫入；成功重設退避、無差異就停止，避免通知／log 洗版。較新／損壞格式不因重試而被覆蓋，指引不得暗示所有問題都能靠釋放空間解決。worker 故障保留記憶體快照，不復活舊資料、不產生多個 writer。
- [ ] 退出與重新啟動走 025 同一協調器：停止接收新錄影，先安全排空媒體，再以有限時間嘗試保存最新 metadata（初定 5 秒，實作時量測）。重複退出加入同一次工作。失敗顯示受影響提醒筆數及可辨識時間／原因，提供重試／留在 App。只有全部媒體工作安全、且沒有 metadata 寫入仍可能發布時，才可提供清楚標示的「不儲存這些提醒並退出」；不能把終止 worker 視為 OS I/O 已停止的證據。寫入卡住時 App 保持開啟並誠實顯示狀態；取消退出安全恢復新錄影入口，relaunch 同樣遵守。強制關閉／斷電不在保證範圍。
- [ ] 定義中英文載入／保存／重試／退出 UI；不重發 OS 通知、不假裝已保存、不因退出自動確認。文件說明強制中斷可能失去尚未保存資訊，以及背景處理不增加磁碟吞吐量。

## 驗證與完成

- [ ] 可重現測試：延遲／拒絕寫入、快照進行中先 A 後 B、確認／移除與晚到清理／新錯誤競爭、舊完成拒絕、重試時間／合併、持續故障、較新／損壞格式、啟動讀取競爭、升級、worker 故障與逾時後不平行發布。使用真實臨時檔跨實例檢查內容，不只計算 Promise 呼叫次數。
- [ ] 在設定 fixture 讓失敗紀錄操作的回應至少延遲 100 ms，並涵蓋最長的保存中狀態，以真實滑鼠與鍵盤重跑上述三個焦點案例；另加等待期間使用者移動焦點的案例。每次執行都必須通過，不能只是間歇通過。
- [ ] `pnpm acceptance:regression`，檢視雙語文案並在設定 fixture 操作保存中／重試／失敗。隔離 Electron fixture 走正式退出 wiring 與延遲 worker I/O，證明 main／UI 可回應、媒體退出工作仍有人管理、重複退出共用工作、逾時留在 App、取消恢復操作，以及任何明確放棄 metadata 的退出不丟影片。還原設定並確認清理。
- [ ] 生命週期變更依政策需新 `pnpm start:app` bundle 的錄影 smoke 與真正退出／重啟案例；worker／建置變更需包裝驗證。未改品質／音訊行為不跑完整矩陣。遵守[測試政策](../docs/zh-TW/testing.md)，原生操作使用對應 skill。依使用者安排，仍未操作的原生項目列於最後 035 N24–N26，直到維護者親自完成；fixture 不得取代。
- [ ] 完成 Opus review、修正成立 findings 並重跑受影響檢查；更新雙語設計／驗證，記錄最終等待、重試政策與限制。依[完成規則](README.zh-TW.md#完成計畫)處理，035 保留未完成原生責任。不自行 commit／push／發布。

本次僅寫計畫：檢查連結／anchor、命令、雙語一致性與 `git diff --check`；不啟動 App、測試或錄影。
