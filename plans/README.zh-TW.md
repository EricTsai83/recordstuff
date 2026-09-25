# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-26。本索引只列未完成的計畫、順序與硬性相依。計畫完成即移除；結案紀錄保留在[驗證紀錄](../docs/zh-TW/verification/README.md)，耐久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)。限制佇列範圍的既定決策，例如不做更新器、不做解除安裝器、不為體積而原生重寫、只驗證 macOS，記錄於[設計決策](../docs/zh-TW/system-design/decisions.md)，此處不重複；034 是 macOS-only 驗證的唯一窄例外，僅限 Windows 系統匣圖示及其必要原生驗收。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

## 順序與狀態

以下計畫皆已規劃、尚未實作。目前順序：**031 → 032 → 033 → 042 → 040 → 034 → 037 → 035**。

排序規則：零風險整理、優先的歷史保存工作與防止資料損失的防護已排在最前並完成；目前依原順序處理 audit 修正，最後是可選或需量測的工作，035 永遠最後。即使之後新增更大編號的實作／修復計畫，也排在 035 之前。

| 計畫 | 來源 | 範圍 |
| --- | --- | --- |
| [031 — 正式版下載指標](031-stable-release-recording.zh-TW.md) | R2-04 | 發布版本順序與錄製獨立 |
| [032 — 更新驗收契約](032-update-acceptance-contract.zh-TW.md) | R2-06 | runner 期望過時，非產品控制錯誤 |
| [033 — 輸出資料夾恢復](033-output-folder-recovery.zh-TW.md) | R2-08 | 開啟資料夾操作與提示，非錄影發布 |
| [042 — 更快的錄影回合](042-faster-recording-rounds.zh-TW.md) | 2026-09-26 對 041 回合的耗時分析；維護者要求 | 先量出 matrix 回合的時間花在哪裡，再一次執行多個 matrix 與重複、縮短休息與短案例、同步標記改為一次解碼，每一項都只在量到可觀節省且不改變結果時採用；並補上中斷清理。流程規則的部分已寫進測試指南 |
| [040 — 錄影前倒數與可區分的選單列狀態](040-recording-countdown.zh-TW.md) | 2026-09-25 維護者要求；Cap 比較 | 可設定的錄影前倒數（預設 3 秒），右上角只有透明數字、沒有方框；倒數前先準備擷取、數到 0 才開始；取消不產生失敗紀錄；選單列新增寬度不變的忙碌與倒數圖示 |
| [034 — Windows 系統匣圖示](034-windows-tray-icons.zh-TW.md) | 維護者要求 | Windows 系統匣圖示與其必要原生驗收；視覺草稿可獨立進行 |
| [037 — 有上限的錄影收尾重疊](037-overlapping-recording-finalization.zh-TW.md) | 2026-09-25 比較；量測門檻 | 先量測是否有值得分離的停止等待才實作；目前尚無實測效益 |
| [035 — 維護者逐步原生驗收](035-guided-native-acceptance.zh-TW.md) | 最後一輪 | Codex 準備並一次帶領一步，由維護者親自操作每項必要原生案例，包含失敗 UX 全部未測原生動作與前序計畫收納的缺口；自動化或受阻狀態不算通過 |

硬性相依如下，其餘皆為工作安排：

- 037 依賴 025、026、029、030、036、038 與 041（皆已完成），須維持 036 在全部媒體工作之後才處理 metadata 的退出階段，重用 038 定義的寫入積壓上限，並以 041 的節奏基準比較時序。
- 040 修改 038（已完成）擴充過的 Recorder 開始階段，並保留其已保留磁碟錯誤的規則；倒數前準備擷取時使用 041（已完成）定案的幀率要求；排在 034 與 037 之前：034 的 Windows 圖示須涵蓋 `busy` 與 `countdown` 狀態，037 的重疊收尾須把倒數中的 session 視為進行中。
- 031–033 可獨立執行；若其他工作需要更新驗收，先處理 032。
- 042 沒有硬性相依；排在 040 與 037 之前，讓它們的錄影回合使用更快的 runner。

## 來源與證據邊界

- R1 為第一輪十項 bug audit，R2 為第二輪八項（2026-09-24）。第二輪有 5 項併入 4 份既有計畫、3 項另開計畫，不重複建立修復工作。重現條件、修正契約與證據限制已直接寫入計畫，不依賴被 gitignore 的本機 audit 檔案。
- 各計畫的 Cap 比較固定 revision `ce785e705e79652adba4b8bf752669c4093499e0`；037 與已結案的 038 固定 `26e1a6d882f311d10b5317e9e0d29babe4f6737e`；040 固定 `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`；已結案的 041 固定 `b2b6ae45d4cae303107b10a9df166d91caed7702`，並閱讀 Chromium tag 152.0.7977.78。只代表已檢視範圍的靜態比較，不能外推為 Cap 已處理這些問題。
- 2026-09-25 的 T3 Code／Cap 架構比較只貢獻 038 與已結案 029 的 run id。為維持 App 精簡，不採用 Effect、monorepo 拆分、`src/main/` 功能子目錄與設定檔備份。
- 慢速磁碟 backlog 仍屬明列限制；037 評估競爭下有限度的開始條件，不保證消除持續吞吐量不足。
- 多筆失敗歷史（2026-09-25）沒有獨立計畫檔就已實作；其[紀錄](../docs/zh-TW/verification/history-2026-09.md#多筆失敗歷史--2026-09-25)與 035 的 N19–N23 承接剩餘原生案例。

## 已結案計畫

結案紀錄，由新到舊：[041](../docs/zh-TW/verification/history-2026-09.md#plan-041-結案--2026-09-26)、[030](../docs/zh-TW/verification/history-2026-09.md#plan-030-結案--2026-09-25)、[029](../docs/zh-TW/verification/history-2026-09.md#plan-029-結案--2026-09-25)、[028](../docs/zh-TW/verification/history-2026-09.md#plan-028-結案--2026-09-25)、[027](../docs/zh-TW/verification/history-2026-09.md#plan-027-結案--2026-09-25)、[038](../docs/zh-TW/verification/history-2026-09.md#plan-038-結案--2026-09-25)、[026](../docs/zh-TW/verification/history-2026-09.md#plan-026-結案--2026-09-25)、[036](../docs/zh-TW/verification/history-2026-09.md#plan-036-結案--2026-09-25)、[039](../docs/zh-TW/verification/history-2026-09.md#plan-039-結案--2026-09-25)、[025](../docs/zh-TW/verification/history-2026-09.md#plan-025-結案--2026-09-25)、[024](../docs/zh-TW/verification/history-2026-09.md#plan-024-完整寫入--2026-09-24)、[023](../docs/zh-TW/verification/history-2026-09.md#plan-023-結案--2026-09-23)、[022](../docs/zh-TW/verification/history-2026-09.md#plan-022-結案--2026-09-24)、[021](../docs/zh-TW/verification/history-2026-09.md#plan-021-結案--2026-09-23)、[020](../docs/zh-TW/verification/history-2026-09.md#plan-020-結案--2026-09-23)、[019](../docs/zh-TW/verification/history-2026-09.md#plan-019-結案--2026-09-23)、[018](../docs/zh-TW/verification/history-2026-09.md#plan-018-結案--2026-09-20)、[017](../docs/zh-TW/verification/history-2026-09.md#儲存通知時序2026-09-20)、[014](../docs/zh-TW/verification/history-2026-09.md#通知生命週期調查--2026-09-20)、[012](../docs/zh-TW/verification/history-2026-09.md#plan-012-結案--2026-09-20)。013 與 016 記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。每份紀錄保留其未測項目與接受的限制；本索引不重開已結案計畫。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
