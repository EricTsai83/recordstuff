# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-26。本索引只列未完成的計畫、順序與硬性相依。計畫完成即移除；結案紀錄保留在[驗證紀錄](../docs/zh-TW/verification/README.md)，耐久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)。限制佇列範圍的既定決策，例如不做更新器、不做解除安裝器、不為體積而原生重寫、只驗證 macOS，記錄於[設計決策](../docs/zh-TW/system-design/decisions.md)，此處不重複；034 是 macOS-only 驗證的唯一窄例外，僅限 Windows 系統匣圖示及其必要原生驗收。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

## 順序與狀態

以下計畫皆已規劃、尚未實作。目前順序：**034 → 037 → 035**。

排序規則：零風險整理、優先的歷史保存工作與防止資料損失的防護已排在最前並完成，維護者要求的快捷鍵後續 044、最後一項 audit 修正 033、更快的錄影回合 042 與錄影前倒數 040 也已完成；目前處理可選或需量測的工作，035 永遠最後。即使之後新增更大編號的實作／修復計畫，也排在 035 之前。

| 計畫 | 來源 | 範圍 |
| --- | --- | --- |
| [034 — Windows 系統匣圖示](034-windows-tray-icons.zh-TW.md) | 維護者要求 | Windows 系統匣圖示與其必要原生驗收；視覺草稿可獨立進行 |
| [037 — 有上限的錄影收尾重疊](037-overlapping-recording-finalization.zh-TW.md) | 2026-09-25 比較；量測門檻 | 先量測是否有值得分離的停止等待才實作；目前尚無實測效益 |
| [035 — 維護者逐步原生驗收](035-guided-native-acceptance.zh-TW.md) | 最後一輪 | Codex 準備並一次帶領一步，由維護者親自操作每項必要原生案例，包含失敗 UX 全部未測原生動作與前序計畫收納的缺口；自動化或受阻狀態不算通過 |

硬性相依如下，其餘皆為工作安排：

- 037 依賴 025、026、029、030、036、038、040 與 041（皆已完成），須維持 036 在全部媒體工作之後才處理 metadata 的退出階段，重用 038 定義的寫入積壓上限，把 040 的倒數中 session 視為進行中，並以 041 的節奏基準比較時序。
- 034 的 Windows 圖示須涵蓋所有已提交的 tray 狀態，包括 040（已完成）的 `busy` 與 `countdown`。

## 來源與證據邊界

- R1 為第一輪十項 bug audit，R2 為第二輪八項（2026-09-24）。第二輪有 5 項併入 4 份既有計畫、3 項另開計畫，不重複建立修復工作。重現條件、修正契約與證據限制已直接寫入計畫，不依賴被 gitignore 的本機 audit 檔案。
- 各計畫的 Cap 比較固定 revision `ce785e705e79652adba4b8bf752669c4093499e0`；037 與已結案的 038 固定 `26e1a6d882f311d10b5317e9e0d29babe4f6737e`；已結案的 040 固定 `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`；已結案的 043 固定 `40f44a803f0980fb7ed530f17d12b8fed40f6b5a`；已結案的 041 固定 `b2b6ae45d4cae303107b10a9df166d91caed7702`，並閱讀 Chromium tag 152.0.7977.78。只代表已檢視範圍的靜態比較，不能外推為 Cap 已處理這些問題。
- 2026-09-25 的 T3 Code／Cap 架構比較只貢獻 038 與已結案 029 的 run id。為維持 App 精簡，不採用 Effect、monorepo 拆分、`src/main/` 功能子目錄與設定檔備份。
- 慢速磁碟 backlog 仍屬明列限制；037 評估競爭下有限度的開始條件，不保證消除持續吞吐量不足。
- 多筆失敗歷史（2026-09-25）沒有獨立計畫檔就已實作；其[紀錄](../docs/zh-TW/verification/history-2026-09.md#多筆失敗歷史--2026-09-25)與 035 的 N19–N23 承接剩餘原生案例。

## 已結案計畫

結案紀錄，由新到舊：[040](../docs/zh-TW/verification/history-2026-09.md#plan-040-結案--2026-09-26)、[042](../docs/zh-TW/verification/history-2026-09.md#plan-042-結案--2026-09-26)、[033](../docs/zh-TW/verification/history-2026-09.md#plan-033-結案--2026-09-26)、[044](../docs/zh-TW/verification/history-2026-09.md#plan-044-結案--2026-09-26)、[043](../docs/zh-TW/verification/history-2026-09.md#plan-043-結案--2026-09-26)、[032](../docs/zh-TW/verification/history-2026-09.md#plan-032-結案--2026-09-26)、[031](../docs/zh-TW/verification/history-2026-09.md#plan-031-結案--2026-09-26)、[041](../docs/zh-TW/verification/history-2026-09.md#plan-041-結案--2026-09-26)、[030](../docs/zh-TW/verification/history-2026-09.md#plan-030-結案--2026-09-25)、[029](../docs/zh-TW/verification/history-2026-09.md#plan-029-結案--2026-09-25)、[028](../docs/zh-TW/verification/history-2026-09.md#plan-028-結案--2026-09-25)、[027](../docs/zh-TW/verification/history-2026-09.md#plan-027-結案--2026-09-25)、[038](../docs/zh-TW/verification/history-2026-09.md#plan-038-結案--2026-09-25)、[026](../docs/zh-TW/verification/history-2026-09.md#plan-026-結案--2026-09-25)、[036](../docs/zh-TW/verification/history-2026-09.md#plan-036-結案--2026-09-25)、[039](../docs/zh-TW/verification/history-2026-09.md#plan-039-結案--2026-09-25)、[025](../docs/zh-TW/verification/history-2026-09.md#plan-025-結案--2026-09-25)、[024](../docs/zh-TW/verification/history-2026-09.md#plan-024-完整寫入--2026-09-24)、[023](../docs/zh-TW/verification/history-2026-09.md#plan-023-結案--2026-09-23)、[022](../docs/zh-TW/verification/history-2026-09.md#plan-022-結案--2026-09-24)、[021](../docs/zh-TW/verification/history-2026-09.md#plan-021-結案--2026-09-23)、[020](../docs/zh-TW/verification/history-2026-09.md#plan-020-結案--2026-09-23)、[019](../docs/zh-TW/verification/history-2026-09.md#plan-019-結案--2026-09-23)、[018](../docs/zh-TW/verification/history-2026-09.md#plan-018-結案--2026-09-20)、[017](../docs/zh-TW/verification/history-2026-09.md#儲存通知時序2026-09-20)、[014](../docs/zh-TW/verification/history-2026-09.md#通知生命週期調查--2026-09-20)、[012](../docs/zh-TW/verification/history-2026-09.md#plan-012-結案--2026-09-20)。013 與 016 記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。每份紀錄保留其未測項目與接受的限制；本索引不重開已結案計畫。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
