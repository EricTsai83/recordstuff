# 剩餘工作

[English](README.md) | [繁體中文](README.zh-TW.md)

更新：2026-09-27。本索引只列未完成的計畫、順序與硬性相依。計畫完成即移除；結案紀錄保留在[驗證紀錄](../docs/zh-TW/verification/README.md)，耐久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)。限制佇列範圍的既定決策，例如不做更新器、不做解除安裝器、不為體積而原生重寫、只驗證 macOS，記錄於[設計決策](../docs/zh-TW/system-design/decisions.md)，此處不重複；已結案的 034 移交給 035 N17 的 Windows 系統匣驗收，是 macOS-only 驗證的唯一窄例外，僅限系統匣圖示及其必要原生驗收。發布依[發布自動化](../docs/zh-TW/system-design/releases.md)：tag 就是版本，CI 會把每次發布回寫到 main。

## 順序與狀態

目前順序：**045 → 046 → 047 → 048 → 049 → 035**。045 到 049 已規劃，尚未實作。035 進行中：逐步引導的驗收回合已於 2026-09-27/28 使用[受控驗收 build](../docs/zh-TW/system-design/tooling.md#受控驗收-build) 執行（[紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-035-引導驗收回合--2026-09-28)）；尚待的修正，以及受 045–049 影響的案例，會在它們之後重做。

排序規則：零風險整理、優先的歷史保存工作與防止資料損失的防護已排在最前並完成，維護者要求的快捷鍵後續 044、最後一項 audit 修正 033、更快的錄影回合 042、錄影前倒數 040、Windows 系統匣圖示 034（其原生 Windows 驗收移至 035），以及需量測的收尾工作 037 也已完成；037 在量測門檻結案：儲存改成連結而非複製後，已沒有可分離出來重疊的等待。之後新增的維護者要求：倒數數字依螢幕縮放 045、可選的倒數音效 046，獨立的失敗紀錄分頁 047，以及選單列選單與設定的順序 048，都排在 035 之前；046 在 045 之後，因為兩者都會修改倒數 overlay 頁面；047 在 046 之後，因為兩者都會修改設定面板；048 排在它們之後，因為它要排序 046 與 047 新增的內容；CPU 預算 049 沒有相依，可在 035 之前的任何時間點執行。035 永遠最後。即使之後新增更大編號的實作／修復計畫，也排在 035 之前。

| 計畫 | 來源 | 範圍 |
| --- | --- | --- |
| [045 — 倒數數字依螢幕大小縮放](045-countdown-digit-scaling.zh-TW.md) | 維護者要求，2026-09-27 | 倒數數字大小改為被錄螢幕短邊的固定比例（初始目標 10%，絕不小於目前的 56 pt），比例由維護者從草稿中選定；位置、透明度、時間與頁面的單向 bridge 不變 |
| [046 — 可選的倒數音效](046-countdown-sound.zh-TW.md) | 維護者要求，2026-09-27 | 「錄影設定」新增「倒數音效」開關（預設關閉，倒數關閉時停用），每個數字伴隨一聲短促的 tick、歸零時不響，最後一聲在擷取前一秒就結束；並檢查錄影開頭的音訊不含 tick |
| [047 — 失敗紀錄移到獨立的設定分頁](047-failure-history-tab.zh-TW.md) | 維護者要求，2026-09-27 | 失敗紀錄從偏好設定上方移到設定的第三個分頁，改為依日期分組、以細分隔線區隔的單純列表，以細強調色邊框表示焦點並顯示未讀數量，選單列與錯誤通知直接開啟該分頁；繁體中文標題改為「設定」，每個分頁記住自己的捲動位置。參考 Cap 的設定頁面，採用分頁而非獨立視窗 |
| [048 — 選單列選單與設定的順序](048-menu-and-settings-order.zh-TW.md) | 維護者要求，2026-09-27 | 每個選單列選單使用同一套群組順序：狀態與主要動作（待命時新增「開始錄製」）、未讀失敗、檔案、視窗，最後是「顯示 log」與「結束」；已確認的失敗不再佔據頂端；補上省略號與靠右的快捷鍵；「一般」把語言與外觀排在更新之前。每項變更先由維護者核可 |
| [049 — CPU 預算：待機與錄影](049-cpu-budget.zh-TW.md) | 維護者要求，2026-09-28 | 目前沒有待機 CPU 測試，矩陣的錄影 CPU 檢查則是在開發用 App 上用 `ps` 的衰減平均，搭配寬鬆的 40% 上限。新增單元測試確認 session 結束後不留計時器、共用的精確 CPU 取樣器、在打包後 App 上執行的 `pnpm measure:cpu`（啟動後待機、錄影、錄影後待機、設定視窗開啟），以及合理範圍與門檻：待機 ≤ 單一核心 0.2%、每秒 ≤ 5 次喚醒，錄影 30 fps ≤ 30%、60 fps ≤ 40%，由第一次基準確認 |
| [035 — 維護者逐步原生驗收](035-guided-native-acceptance.zh-TW.md) | 最後一輪 | Codex 準備並一次帶領一步，由維護者親自操作每項必要原生案例，包含失敗 UX 全部未測原生動作與前序計畫收納的缺口；自動化或受阻狀態不算通過 |

硬性相依：045–049 → 035，因為 035 的 N32、N34 與 N35 要判斷縮放後的數字與音效，其失敗案例會操作新分頁，選單列案例也會讀取新的選單順序；035 排在所有其他計畫之後。

## 來源與證據邊界

- R1 為第一輪十項 bug audit，R2 為第二輪八項（2026-09-24）。第二輪有 5 項併入 4 份既有計畫、3 項另開計畫，不重複建立修復工作。重現條件、修正契約與證據限制已直接寫入計畫，不依賴被 gitignore 的本機 audit 檔案。
- 各計畫的 Cap 比較固定 revision `ce785e705e79652adba4b8bf752669c4093499e0`；已結案的 037 與 038 固定 `26e1a6d882f311d10b5317e9e0d29babe4f6737e`；已結案的 040 固定 `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`；已結案的 043 固定 `40f44a803f0980fb7ed530f17d12b8fed40f6b5a`；已結案的 041 固定 `b2b6ae45d4cae303107b10a9df166d91caed7702`，並閱讀 Chromium tag 152.0.7977.78。只代表已檢視範圍的靜態比較，不能外推為 Cap 已處理這些問題。
- 2026-09-25 的 T3 Code／Cap 架構比較只貢獻 038 與已結案 029 的 run id。為維持 App 精簡，不採用 Effect、monorepo 拆分、`src/main/` 功能子目錄與設定檔備份。
- 慢速磁碟 backlog 仍屬明列限制；已結案的 037 沒有加入重疊，因此也沒有競爭下的開始條件。
- 多筆失敗歷史（2026-09-25）沒有獨立計畫檔就已實作；其[紀錄](../docs/zh-TW/verification/history-2026-09.md#多筆失敗歷史--2026-09-25)與 035 的 N19–N23 承接剩餘原生案例。

## 已結案計畫

結案紀錄，由新到舊：[037](../docs/zh-TW/verification/history-2026-09.md#plan-037-結案--2026-09-27)、[034](../docs/zh-TW/verification/history-2026-09.md#plan-034-結案--2026-09-27)、[040](../docs/zh-TW/verification/history-2026-09.md#plan-040-結案--2026-09-26)、[042](../docs/zh-TW/verification/history-2026-09.md#plan-042-結案--2026-09-26)、[033](../docs/zh-TW/verification/history-2026-09.md#plan-033-結案--2026-09-26)、[044](../docs/zh-TW/verification/history-2026-09.md#plan-044-結案--2026-09-26)、[043](../docs/zh-TW/verification/history-2026-09.md#plan-043-結案--2026-09-26)、[032](../docs/zh-TW/verification/history-2026-09.md#plan-032-結案--2026-09-26)、[031](../docs/zh-TW/verification/history-2026-09.md#plan-031-結案--2026-09-26)、[041](../docs/zh-TW/verification/history-2026-09.md#plan-041-結案--2026-09-26)、[030](../docs/zh-TW/verification/history-2026-09.md#plan-030-結案--2026-09-25)、[029](../docs/zh-TW/verification/history-2026-09.md#plan-029-結案--2026-09-25)、[028](../docs/zh-TW/verification/history-2026-09.md#plan-028-結案--2026-09-25)、[027](../docs/zh-TW/verification/history-2026-09.md#plan-027-結案--2026-09-25)、[038](../docs/zh-TW/verification/history-2026-09.md#plan-038-結案--2026-09-25)、[026](../docs/zh-TW/verification/history-2026-09.md#plan-026-結案--2026-09-25)、[036](../docs/zh-TW/verification/history-2026-09.md#plan-036-結案--2026-09-25)、[039](../docs/zh-TW/verification/history-2026-09.md#plan-039-結案--2026-09-25)、[025](../docs/zh-TW/verification/history-2026-09.md#plan-025-結案--2026-09-25)、[024](../docs/zh-TW/verification/history-2026-09.md#plan-024-完整寫入--2026-09-24)、[023](../docs/zh-TW/verification/history-2026-09.md#plan-023-結案--2026-09-23)、[022](../docs/zh-TW/verification/history-2026-09.md#plan-022-結案--2026-09-24)、[021](../docs/zh-TW/verification/history-2026-09.md#plan-021-結案--2026-09-23)、[020](../docs/zh-TW/verification/history-2026-09.md#plan-020-結案--2026-09-23)、[019](../docs/zh-TW/verification/history-2026-09.md#plan-019-結案--2026-09-23)、[018](../docs/zh-TW/verification/history-2026-09.md#plan-018-結案--2026-09-20)、[017](../docs/zh-TW/verification/history-2026-09.md#儲存通知時序2026-09-20)、[014](../docs/zh-TW/verification/history-2026-09.md#通知生命週期調查--2026-09-20)、[012](../docs/zh-TW/verification/history-2026-09.md#plan-012-結案--2026-09-20)。013 與 016 記錄在[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)、[工具](../docs/zh-TW/system-design/tooling.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)。每份紀錄保留其未測項目與接受的限制；本索引不重開已結案計畫。

所有計畫的語言版本都放在本資料夾：英文 `<name>.md`，繁中 `<name>.zh-TW.md`。

## 完成計畫

計畫只保留未完成工作。永久結論寫入[系統設計](../docs/zh-TW/system-design/README.md)及[驗證紀錄](../docs/zh-TW/verification/README.md)，同步 README、索引與翻譯，再移除已完成計畫及翻譯。保留失敗與歷史證據，執行歷史由 Git 保存。
