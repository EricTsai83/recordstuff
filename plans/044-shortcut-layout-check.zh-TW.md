# 044 — 自動化鍵盤配置快捷鍵檢查

[English](044-shortcut-layout-check.md) | [繁體中文](044-shortcut-layout-check.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-26。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍、證據與區隔

這是 [043](../docs/zh-TW/verification/history-2026-09.md#plan-043-結案--2026-09-26) 的後續，由維護者要求。043 停用 Chromium 的 `LayoutAwareGlobalHotkeys`，讓全域快捷鍵依實體鍵位註冊。它的鍵盤配置證據來自手動步驟：一次性的 Electron probe、用來切換輸入法的 Swift 小工具，以及在注音下執行的 `pnpm acceptance:updates`。

依實體鍵位註冊之後，一般回合不需要特定輸入法。但仍有一種回歸可能發生：升級 Electron 時這個功能被改名或移除，註冊就會在無提示下回到依配置查找，數字快捷鍵又會在注音下被移到數字鍵盤。本計畫把這項檢查做成一個指令，不需要手動切換輸入法。

區隔：
- 不改快捷鍵行為、預設快捷鍵、設定或編輯器。
- 不是實體按鍵驗收：System Events 的合成按鍵無法證明實體硬體。
- 不處理非 QWERTY 拉丁配置的字母取捨。
- 不涵蓋 Windows。

沒有新的 Cap 比較：Cap 的 `global-hotkey` 路徑沒有依配置查找可測。

## 實作契約

- [ ] 新增 `pnpm acceptance:shortcut-layout`。它沿用既有 [shortcut-failure](../scripts/fixtures/shortcut-failure.ts) 的 boundary 模式來測試建置出的 App（`out/main/index.js`），所以檢查涵蓋的是 [index.ts](../src/main/index.ts) 真正的開關接線，而不是另一個獨立 probe。
  - 與現有 phase 一樣，使用隔離的 userData 與 logs。
  - 註冊必須傳到真正的 `globalShortcut`。
  - 按鍵只做記錄、不呼叫正式的 toggle，因此不會開始擷取，也不會跳出權限提示。
  - `out/` 不存在時比照 `acceptance:shortcut`，以清楚的訊息停止。
- [ ] 透過隔離的設定檔註冊一個不易衝突的數字快捷鍵，例如 `CommandOrControl+Control+Alt+Shift+7`。有其他 RecordStuff 程序在執行時，以 blocked 拒絕。
- [ ] 輸入法處理：
  - 記錄目前的輸入法。
  - 選取一個已啟用、數字列不輸入數字的輸入法；這台 Mac 上的注音就是一例。
  - 在有上限的時間內等待目前的鍵盤配置回報為該配置；找不到或逾時記為 blocked。
  - 不新增或啟用任何輸入法，也不更改鍵盤偏好設定。
  - 無論成功、失敗、逾時、SIGINT 或 SIGTERM，都要還原原本的輸入法並確認；無法確認還原就算清理失敗。
  - 查詢與選取不引入新的 npm 依賴。優先使用 `osascript` 的 JavaScript for Automation；若需要 Swift 小工具，就在執行目錄中即時編譯，缺少 `swiftc` 時記為 blocked。
- [ ] 以有上限的等待時間，透過 System Events 送鍵並斷言：
  - 該數字的數字列 key code 能觸發正式註冊；
  - 數字鍵盤的 key code 不會觸發；
  - 一個字母或標點對照組仍會觸發，例如以 key code 43 送出的設定快捷鍵 ⌘⌥,。

  缺少輔助使用或 System Events 權限記為 blocked。整個執行期間都持有桌面回合的保護。
- [ ] 新增一個不在預設執行中的負向對照 drill：在 app ready 之前移除正式的 `disable-features` 值。此時數字列斷言必須失敗並以 exit 1 結束，輸入法仍須還原。這證明檢查確實能抓到 043 的錯誤，而不是沒測到東西也通過。
- [ ] 寫出 `report.md` 與 `report.json`，內容包括：
  - 原本、選取與還原後的輸入法，以及鍵盤配置；
  - 使用的快捷鍵與每個按鍵的結果；
  - 清理情況；
  - 與其他 runner 相同的退出碼：0 為通過、1 為失敗、2 為 blocked。
- [ ] 為純邏輯部分加單元測試：輸入法的選擇、還原的記錄，以及結果分類。避免只是重述呼叫的測試。
- [ ] 更新雙語文件：
  - [測試指南](../docs/zh-TW/testing.md)：全域快捷鍵列與 Electron／runtime 依賴列要求此指令；
  - [工具指南](../docs/zh-TW/system-design/tooling.md)：新增一節，說明前提、行為與退出碼；
  - [設計決策](../docs/zh-TW/system-design/decisions.md)：升級 Electron 的觸發條件寫明此指令；
  - [桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)：加上指向此指令的說明。

## 必要驗證與排除

這次是 runner 與 fixture 的變更，測試指南要求相關測試、型別檢查，以及實際執行受影響的 runner，包含改動到的失敗與清理路徑。

- 執行 `pnpm check`。若共用的 shortcut-failure fixture 或 `acceptance-shortcut.mts` 有改動，另外執行 `pnpm acceptance:regression`。
- 從另一個輸入法（例如 ABC）開始，實際執行 `pnpm acceptance:shortcut-layout`。它必須通過，並把起始的輸入法還原。
- 負向對照 drill 必須以 exit 1 失敗，並還原輸入法。
- 在配置 phase 中送出 SIGINT，必須還原輸入法，且不留下 fixture 程序。
- 以要求一個未啟用的輸入法來模擬配置不可用，此時必須記為 blocked，且不改動任何東西。
- 不需要錄影、matrix、通知或打包檢查：產品本身沒有變更。
- 實體按鍵不在本檢查範圍；043 由維護者回報的實體按鍵仍是硬體層面的證據。

## 完成與證據處理

依[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。共用建置需依序執行；每一回合只有一個桌面／音訊／快捷鍵操作者。還原輸入法與所有變更過的設定、結束受測程序並確認已退出；清理未完成會阻擋下一回合。

- [ ] 分開記錄檢查與結果、依範圍排除的項目，以及必要但未驗證的案例；mock 邊界不是原生證據。缺少前置條件記為 blocked。對實作執行 `git diff --check`。
- [ ] 把耐久結論寫入雙語設計／驗證文件並更新兩份索引，確認完成後才移除本計畫與翻譯。沒有另外的要求就不 commit、push 或發布。

僅規劃階段的驗證：相對連結／anchor、指令名稱、雙語涵蓋與 `git diff --check`；不為了撰寫本計畫而建置 App、跑測試、啟動或錄影。
