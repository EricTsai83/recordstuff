# 043 — 全域快捷鍵依實體鍵位註冊

[English](043-physical-shortcut-keys.md) | [繁體中文](043-physical-shortcut-keys.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-26。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍、證據與區隔

在 plan 032 的原生回合中發現（[結案紀錄](../docs/zh-TW/verification/history-2026-09.md#plan-032-結案--2026-09-26)），修正它是維護者的要求。啟用注音輸入法時，其鍵盤配置 `com.apple.keylayout.ZhuyinBopomofo` 的數字列輸入注音符號，預設的 ⌘⇧1 因此被綁到數字鍵盤，按數字列的 ⌘⇧1 沒有反應。設定快捷鍵 ⌘⌥, 走同一個 listener。

原因：Electron 44.3.0 內的 Chromium 152 預設啟用 `kLayoutAwareGlobalHotkeys`（[global_accelerator_listener_mac.mm](https://github.com/chromium/chromium/blob/152.0.7977.78/ui/base/accelerators/global_accelerator_listener/global_accelerator_listener_mac.mm)）。註冊時，它會在 key code 0–127 中尋找目前配置下輸入該字元的鍵，找不到才退回 US 固定位置；切換鍵盤時也會重新註冊所有熱鍵。注音配置下只有數字鍵盤的 1 會輸入 `1`；字母在任何鍵上都找不到，所以字母快捷鍵退回固定位置，仍然可用。

App 在這裡與自己不一致：[shortcut-capture.ts](../src/renderer/shortcut-capture.ts) 記錄實體 `event.code` 並拒絕數字鍵盤，註冊卻依字元綁定，在注音下綁到的正好是數字鍵盤。

證據（2026-09-26，Electron 44.3.0，macOS 26.6.2，啟用注音並使用 ZhuyinBopomofo 配置；在 repository 外的 probe 中註冊 ⌘⇧1 與 ⌘⌥⇧R，再以 System Events 送出合成按鍵）：

| Probe | 數字列 ⌘⇧1（`key code 18`） | 數字鍵盤 ⌘⇧1（`key code 83`） | ⌘⌥⇧R |
| --- | --- | --- | --- |
| 預設 | 未觸發 | 觸發 | 觸發 |
| `--disable-features=LayoutAwareGlobalHotkeys` | 觸發 | 未觸發 | 觸發 |

未測試實體按鍵。

Cap 比較固定在 `40f44a803f0980fb7ed530f17d12b8fed40f6b5a`，使用 `tauri-plugin-global-shortcut` 2.3.0 與 `global-hotkey` 0.7.0；這是靜態比較，不代表 Cap 能處理所有配置：
- 設定頁記錄 `e.code`，儲存 `{ code, meta, ctrl, alt, shift }`。
- `global-hotkey` 把 `Code::Digit1` 固定對應到 Carbon `RegisterEventHotKey` 的 key code `0x12`，不查詢配置。
- Cap 沒有預設快捷鍵、會忽略註冊失敗，並把數字鍵顯示為 `Digit1`。

本計畫只採用「依實體鍵位註冊」這一點。RecordStuff 保留原有的預設值、保留組合檢查、衝突回報與 `⌘⇧1` 標籤。

不在範圍：
- 預設快捷鍵、設定格式、編輯器、preset 清單、`pnpm acceptance` 的按鍵對照與原生模組；
- Windows 與 Linux：此功能只存在 Chromium 的 macOS listener，而且驗證只在 macOS 進行。

## 實作契約

- [ ] 在任何 `globalShortcut` 註冊之前、app ready 之前，只在 macOS 透過 `app.commandLine` 停用 `LayoutAwareGlobalHotkeys`。功能名稱集中在一個常數；命令列上已有的 `disable-features` 值要合併，不能覆蓋。
- [ ] 以針對真實邏輯的測試涵蓋此判斷：macOS 會加入、其他平台不加入；已存在的 `disable-features` 清單、重複項目與空值都能正確合併。不要加只是重述呼叫的測試。
- [ ] 在雙語[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵)記錄，並新增一列[設計決策](../docs/zh-TW/system-design/decisions.md)，內容包括：
  - 全域快捷鍵依 US 實體鍵位註冊，與編輯器的實體擷取及 Cap 一致；
  - 已接受的取捨：在 Dvorak、AZERTY 等非 QWERTY 拉丁配置下，字母快捷鍵是 US 位置，而不是鍵帽上的字母；
  - 重新評估的時機：每次升級 Electron 都要確認該版 Chromium 仍有這個功能名稱，否則行為會在無提示下回到依配置查找。
- [ ] 把 `desktop.md` 中「實體 `event.code` 不能證明配置相容」的說法，改寫為實測結果。
- [ ] 從雙語工具指南移除 plan 032 的注音／ABC 前提，並把該結案紀錄中「發現但未修正」的說明指向本計畫的結案紀錄。

## 必要驗證與排除

這次改動的是全域快捷鍵註冊，而快捷鍵會開始與停止錄影，所以適用測試規則的快捷鍵列與錄影列。

- 執行 `pnpm check` 與 `pnpm acceptance:regression`。
- 原生驗收在全新建置的 bundle 上進行，並啟用注音（ZhuyinBopomofo 配置）：
  - `pnpm acceptance:updates`：隔離 fixture 使用預設 ⌘⇧1，正是失敗的情境；兩段錄影同時作為錄影 smoke 並經媒體驗證。觀察其中一段錄影的播放。
  - `pnpm start:app` 後執行 `pnpm acceptance:settings-shortcut` 驗證 ⌘⌥,，結束後關閉 App。
- 「修改前」證據沿用上方 probe 表格：Electron、機器與配置都相同。
- 維護者在注音與 ABC 下各按一次實體數字列 ⌘⇧1（在本機 bundle 選 Settings → Shortcut → Recommended: ⌘⇧1，開始再停止，之後還原原本的快捷鍵），並確認平常使用的 ⌘⌥⇧R 仍然有效。合成事件無法證明實體按鍵。若本回合沒有進行，記為未執行並轉交 035。
- 依範圍不需要：matrix、長時間錄影、通知驗收、`--full` feed 案例、Windows，以及另外一輪 `pnpm acceptance`。在以 QWERTY 為基礎的配置下，字母快捷鍵兩種方式得到的 key code 相同，probe 已涵蓋。

## 完成與證據處理

依[共用測試規則](../docs/zh-TW/testing.md)與[計畫完成](README.zh-TW.md#完成計畫)。需要的原生 UI 回合使用[原生驗收 skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)。共用建置需依序執行；每一回合只有一個桌面／音訊／快捷鍵操作者。還原變更的設定與輸入法、關閉測試 UI、結束受測 App 並確認程序已退出；清理未完成會阻擋下一回合。

- [ ] 分開記錄檢查與結果、依範圍排除的項目，以及必要但未驗證的案例；mock 邊界不是原生證據。缺少前置條件記為 blocked。對實作執行 `git diff --check`。
- [ ] 把耐久結論寫入雙語設計／驗證文件並更新兩份索引，確認完成後才移除本計畫與翻譯。沒有另外的要求就不 commit、push 或發布。

僅規劃階段的驗證：相對連結／anchor、指令名稱、雙語涵蓋與 `git diff --check`；不為了撰寫本計畫而建置 App、跑測試、啟動或錄影。
