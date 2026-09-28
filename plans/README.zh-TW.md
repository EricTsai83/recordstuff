# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-29。本索引只列未完成的計畫、順序與硬性相依。計畫完成即移除；結案紀錄保留在[驗證紀錄](../docs/zh-TW/verification/README.md)，耐久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)。限制佇列範圍的既定決策，例如不做更新器、不做解除安裝器、不為體積而原生重寫、只驗證 macOS，記錄於[設計決策](../docs/zh-TW/system-design/decisions.md)，此處不重複；已結案的 034 移交給 035 N17 的 Windows 系統匣驗收，是 macOS-only 驗證的唯一窄例外，僅限系統匣圖示及其必要原生驗收。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

目前進行中：無。051 於 2026-09-29 結案；[修復與驗收紀錄](../docs/zh-TW/verification/audit-051.md)保留暫緩的 tray 點選與精確原生證據限制。

## 順序與狀態

目前順序：**052**，接著 **053**。052 承接 2026-09-29 第二輪稽核中 runner 的那一組；該輪 20 項 App、發布工具與網站修正為 `ea86b99`…`7f1f3a8`，而 runner 修正需要實際執行受影響的 runner，因此維護者把它們移成獨立計畫。053 承接 2026-09-29 第三輪稽核在其修正 `ba8b651`…`4740520` 之外留下的六項，每一項都需要原生、量測或 GitHub 上的證據。錄影時保持喚醒、睡眠時存檔的 050 已於 2026-09-28 結案（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-050-保持喚醒與睡眠時停止--2026-09-28)），在最後的逐步原生驗收 035 之後（[結案紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-035-結案--2026-09-28)）。

| 計畫 | 來源 | 範圍 |
| --- | --- | --- |
| [052 — Runner 的 process 與環境安全](052-runner-process-safety.zh-TW.md) | 2026-09-29 第二輪稽核；維護者決定 | 讓每個 runner 的 `pgrep`／`pkill` 都 escape 並檢查結束碼、只從 `scrubbedEnv()` 啟動 Electron、讓 finalization build 可以中斷，並讓每個 runner 使用自己的素材 profile |
| [053 — 第三輪稽核的遺留項目](053-audit-leftovers.zh-TW.md) | 2026-09-29 第三輪稽核；維護者要求 | 讓執行中的動作按鈕保留焦點、決定 cadence 百分位數定義、檢查網站 pull request、第二次啟動時開啟設定、擷取結束後才送出錄影開始時的提示，並為 sentinel checkpoint 計時 |

排序規則：零風險整理、優先的歷史保存工作與防止資料損失的防護已排在最前並完成，維護者要求的快捷鍵後續 044、最後一項 audit 修正 033、更快的錄影回合 042、錄影前倒數 040、Windows 系統匣圖示 034（其原生 Windows 驗收移至 035），以及需量測的收尾工作 037 也已完成；037 在量測門檻結案：儲存改成連結而非複製後，已沒有可分離出來重疊的等待；維護者要求的倒數數字依螢幕縮放 045、可選的倒數音效 046、獨立的失敗紀錄分頁 047、選單列選單與設定的順序 048，以及 CPU 預算 049 也已完成；049 的 baseline 在參考機上確認了每一項目標（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-049-cpu-baseline-結案--2026-09-28)）。035 永遠最後。035 與之後來自其 N31 的 050 最後結案；052 開始新的佇列，053 接在其後。

硬性相依：無。

## 來源與證據邊界

- R1 為第一輪十項 bug audit，R2 為第二輪八項（2026-09-24）。第二輪有 5 項併入 4 份既有計畫、3 項另開計畫，不重複建立修復工作。重現條件、修正契約與證據限制已直接寫入計畫，不依賴被 gitignore 的本機 audit 檔案。
- 各計畫的 Cap 比較固定 revision `ce785e705e79652adba4b8bf752669c4093499e0`；已結案的 037 與 038 固定 `26e1a6d882f311d10b5317e9e0d29babe4f6737e`；已結案的 040 固定 `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`；已結案的 043 固定 `40f44a803f0980fb7ed530f17d12b8fed40f6b5a`；已結案的 041 固定 `b2b6ae45d4cae303107b10a9df166d91caed7702`，並閱讀 Chromium tag 152.0.7977.78。只代表已檢視範圍的靜態比較，不能外推為 Cap 已處理這些問題。
- 2026-09-25 的 T3 Code／Cap 架構比較只貢獻 038 與已結案 029 的 run id。為維持 App 精簡，不採用 Effect、monorepo 拆分、`src/main/` 功能子目錄與設定檔備份。
- 慢速磁碟 backlog 仍屬明列限制；已結案的 037 沒有加入重疊，因此也沒有競爭下的開始條件。
- 多筆失敗歷史（2026-09-25）沒有獨立計畫檔就已實作；其[紀錄](../docs/zh-TW/verification/history-2026-09.md#多筆失敗歷史--2026-09-25)與 035 的 N19–N23 已涵蓋剩餘原生案例。

## 已結案計畫

結案紀錄，由新到舊：[051](../docs/zh-TW/verification/audit-051.md)、[050](../docs/zh-TW/verification/history-2026-09.md#plan-050-保持喚醒與睡眠時停止--2026-09-28)、[035](../docs/zh-TW/verification/history-2026-09.md#plan-035-結案--2026-09-28)、[049](../docs/zh-TW/verification/history-2026-09.md#plan-049-cpu-baseline-結案--2026-09-28)、[048](../docs/zh-TW/verification/history-2026-09.md#plan-048-結案--2026-09-28)、[047](../docs/zh-TW/verification/history-2026-09.md#plan-047-結案--2026-09-28)、[046](../docs/zh-TW/verification/history-2026-09.md#plan-046-結案--2026-09-28)、[045](../docs/zh-TW/verification/history-2026-09.md#plan-045-結案--2026-09-28)、[037](../docs/zh-TW/verification/history-2026-09.md#plan-037-結案--2026-09-27)、[034](../docs/zh-TW/verification/history-2026-09.md#plan-034-結案--2026-09-27)、[040](../docs/zh-TW/verification/history-2026-09.md#plan-040-結案--2026-09-26)、[042](../docs/zh-TW/verification/history-2026-09.md#plan-042-結案--2026-09-26)、[033](../docs/zh-TW/verification/history-2026-09.md#plan-033-結案--2026-09-26)、[044](../docs/zh-TW/verification/history-2026-09.md#plan-044-結案--2026-09-26)、[043](../docs/zh-TW/verification/history-2026-09.md#plan-043-結案--2026-09-26)、[032](../docs/zh-TW/verification/history-2026-09.md#plan-032-結案--2026-09-26)、[031](../docs/zh-TW/verification/history-2026-09.md#plan-031-結案--2026-09-26)、[041](../docs/zh-TW/verification/history-2026-09.md#plan-041-結案--2026-09-26)、[030](../docs/zh-TW/verification/history-2026-09.md#plan-030-結案--2026-09-25)、[029](../docs/zh-TW/verification/history-2026-09.md#plan-029-結案--2026-09-25)、[028](../docs/zh-TW/verification/history-2026-09.md#plan-028-結案--2026-09-25)、[027](../docs/zh-TW/verification/history-2026-09.md#plan-027-結案--2026-09-25)、[038](../docs/zh-TW/verification/history-2026-09.md#plan-038-結案--2026-09-25)、[026](../docs/zh-TW/verification/history-2026-09.md#plan-026-結案--2026-09-25)、[036](../docs/zh-TW/verification/history-2026-09.md#plan-036-結案--2026-09-25)、[039](../docs/zh-TW/verification/history-2026-09.md#plan-039-結案--2026-09-25)、[025](../docs/zh-TW/verification/history-2026-09.md#plan-025-結案--2026-09-25)、[024](../docs/zh-TW/verification/history-2026-09.md#plan-024-完整寫入--2026-09-24)、[023](../docs/zh-TW/verification/history-2026-09.md#plan-023-結案--2026-09-23)、[022](../docs/zh-TW/verification/history-2026-09.md#plan-022-結案--2026-09-24)、[021](../docs/zh-TW/verification/history-2026-09.md#plan-021-結案--2026-09-23)、[020](../docs/zh-TW/verification/history-2026-09.md#plan-020-結案--2026-09-23)、[019](../docs/zh-TW/verification/history-2026-09.md#plan-019-結案--2026-09-23)、[018](../docs/zh-TW/verification/history-2026-09.md#plan-018-結案--2026-09-20)、[017](../docs/zh-TW/verification/history-2026-09.md#儲存通知時序2026-09-20)、[014](../docs/zh-TW/verification/history-2026-09.md#通知生命週期調查--2026-09-20)、[012](../docs/zh-TW/verification/history-2026-09.md#plan-012-結案--2026-09-20)。013 與 016 記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。每份紀錄保留其未測項目與接受的限制；本索引不重開已結案計畫。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
