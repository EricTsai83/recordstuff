# 028 — 設定視窗與快捷鍵生命週期

[English](028-shortcut-editing-lifecycle.md) | [繁體中文](028-shortcut-editing-lifecycle.zh-TW.md)

狀態：已規劃、尚未實作。建立：2026-09-24。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍與證據

處理 bug **1、5**，排在 027 後，與媒體編碼獨立。實際 renderer DOM 測試確認 macOS 合法 Control+W 會關窗；SettingsWindow 測試讓儲存 pending，關窗並等待 20 秒仍不恢復全域快捷鍵，直到儲存完成。

影響：[設定 renderer](../src/renderer/settings.ts)、[SettingsWindow](../src/main/settings-window.ts)、[主程序快捷鍵整合](../src/main/index.ts)、註冊歸屬與測試。保留明確 Confirm、保留組合驗證、寫入失敗回復、已存設定與實際註冊的一致性。

## 第二輪擴充：R2-03

R2-03（P2）併入此處：崩潰視窗與快捷鍵 capture lease 共用生命週期負責關係。原有 bug 1、5 屬 R1。[SettingsWindow](../src/main/settings-window.ts) 在 render-process-gone 只結束 capture，仍保留視窗；下次 show 只將它帶到前景。真實 SettingsWindow 搭配 Electron boundary fake 的崩潰／重開測試，仍只有一個 window 與一次 loadFile；未量測原生白畫面外觀。

- [ ] 使崩潰實例失效並釋放，下次 show 必須建立／載入可用視窗，避免無限自動重載。close／crash callback 綁定實例 generation，舊事件不可清掉新視窗或釋放它的 capture lease。
- [ ] 保留已提交設定及下方 capture／交易分離契約；崩潰前已 Confirm 的 pending 儲存仍依契約成功／失敗，未確認輸入不可被提交。
- [ ] 測 idle／輸入／提交中崩潰、重複 show／crash、舊 close 晚於新 show、載入失敗與成功重開。檢查快捷鍵恢復及可見持久化值，不只檢查視窗數量。
- [ ] 設定回歸增加隔離的真實 Electron renderer 崩潰／重開，以原生輸入觀察控制項可用；保留下方原生快捷鍵與錄製驗收。只模擬 render-process-gone 不足以證明恢復。

既有 Cap 快捷鍵輸入比較，未證明設定 renderer 的崩潰恢復。

## Cap 評估

Cap 的[快捷鍵編輯器保存 physical code 與個別修飾鍵](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src/routes/%28window-chrome%29/settings/hotkeys.tsx#L63-L96)，有預覽／確認控制；[後端替換註冊](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/hotkeys.rs#L458-L485) 卻以 .ok() 丟棄註冊錯誤。檢視的 editor 沒有與 RecordStuff 相同的輸入／儲存期間 suspend 契約。只能參考輸入模型，不能當作 Cap 已解決我們儲存卡住與關窗問題的證據；不抄較弱的錯誤處理或將預覽立即持久化的方式。

## 實作與測試

- [ ] 欄位與 document 共用依平台判斷的關窗函式：macOS 精確 Command+W，採 Control+W 關窗的平台使用精確 Control+W，排除額外修飾鍵。macOS Control+W 可被輸入。明確測平台映射與小寫／實體鍵處理，不以合成 event.key='w' 推論 macOS Option 的字元輸出。
- [ ] 每次 capture 取得自己的 ownership token。取消、失焦、逾時、關窗、renderer 失敗與 destroy 都須釋放該次 suspension，即使正在儲存；重複釋放無副作用。舊視窗晚到回應不能結束新視窗的 capture。
- [ ] 分開 capture lease 與設定交易。關窗結束輸入、恢復目前已提交註冊；已按 Confirm 的儲存可繼續。只有持久化成功後才要求註冊新設定。若舊快捷鍵恢復後已開始錄製，延後新註冊直到錄製穩定結束，保留當次停止鍵。儲存失敗維持舊設定與註冊。
- [ ] 新 capture 進行中，即使舊交易完成也不能提早恢復全域鍵。以歸屬／generation 檢查取代全域 committingHotkey 例外；保留衝突回報與錄製／設定兩個註冊，不可默默取消其他負責者的註冊。
- [ ] 回歸合法 Control+W、精確關窗組合、額外修飾鍵、Confirm／Cancel；慢成功／失敗搭配每個釋放路徑、儲存時重開、新 capture 與舊 commit 交錯、晚到 commit 前已開始錄製。一起檢查已存設定、實際註冊、可見提示。
- [ ] 更新雙語桌面設計與必要提示。

必要：`pnpm acceptance:regression`（含 check／build）；全新 `pnpm start:app`，實體 macOS Control+W 輸入／Confirm、一般 Command+W 關窗、受控延遲儲存時關窗後恢復錄製／設定快捷鍵。全域註冊會影響停止鍵，因此須完成錄製 smoke 與觀察播放。以隔離 fixture 延遲重現 I/O 卡住，與實際 OS 鍵盤投遞證據分開。Windows 映射僅為單元覆蓋，除非真的測 Windows。排除完整媒體矩陣、權限、拔螢幕與長錄製。

## 完成與證據處理

依[共用測試政策](../docs/testing.md)與[計畫完成規則](README.zh-TW.md#完成計畫)。必要原生 UI 驗收使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用 build 序列執行；每輪桌面／音訊／快捷鍵由一個執行者獨占。恢復設定、關閉測試 UI、正常退出受測 App 並確認程序結束；清理未完成會阻擋下一輪。

- [ ] 分列檢查／結果、範圍排除與必要但未驗項目；mock 邊界不是原生證據。缺少前提屬 blocked。實作執行 `git diff --check`。
- [ ] 耐久結論放入雙語設計／驗證文件，更新兩份索引；全部完成後才刪除此計畫與翻譯。不自行 commit、push 或發布。

本次僅規劃，檢查相對連結／anchor、命令名稱、雙語覆蓋與 `git diff --check`；不因寫計畫而 build、跑 App 測試、launch 或錄影。Cap 評估是固定 revision `ce785e705e79652adba4b8bf752669c4093499e0` 的靜態原始碼檢視，沒有執行 Cap，也不保證其每種模式／平台的行為。
