# 驗證索引

[English](../../verification/README.md) | [繁體中文](README.md)

現在該跑什麼，依[測試規則](../testing.md)及[共用驗收案例](../acceptance.md)。本索引摘要既有證據；文件整理不代表重新測試或擴大覆蓋。

## 已記錄範圍

| 項目 | 既有結果與限制 |
| --- | --- |
| 1.7.0 發布，2026-10-06 | Tagged source `50d42905` 的 1,710 項測試、設定 516/516、快捷鍵整合 57/57、播放器 19/19、簽章 bundle 錄影／音訊標記與 QuickTime 播放通過；原生重新命名、自訂格式、兩種還原與音量／快轉提示已檢查。Tray 15 項通過、stale Start 競態 1 項未執行；閒置與背景設定 CPU 通過。雙平台發布／下載門檻、網站部署、公開 feed 與正式 Electron 網路 transport 通過；Windows 硬體與主觀聆聽仍未驗證。見[發布證據](releases/1.7.0.md)。 |
| Plan 070 聚焦測試 scope，2026-10-10 | `pnpm test:scope` 從十一個具名 scope 執行單一工作的選取（單元測試檔與帶 tag 的背景案例，過期時才建置，dry run 不執行任何東西）；設定矩陣改為每種語言、外觀、尺寸與分頁各一個案例，所有斷言保留。General 分頁的視覺修改 68.9 秒，完整執行 463.6 秒（−85 %）；helper 2.8 秒且不啟動 Electron。完整執行 156/156 與 drills 通過。見[結案紀錄](history-2026-10.md#plan-070-結案--2026-10-10)。 |
| Plan 071 分類與搜尋，2026-10-10 | 錄影檔分頁以儲存位置的子資料夾作為分類：移到、新增、重新命名、刪除空分類、含最愛的單一選擇器、記住目前分類、檔名搜尋、視窗開著時遞迴監看。修正八項審查 findings；拖曳卡片到分類在桌面上失敗後已移除。回歸 128/128，監看執行中 `measure:cpu` C 0.149 %。大型資料夾的監看與 VoiceOver 未測試。見[結案紀錄](history-2026-10.md#plan-071-結案--2026-10-10)。 |
| 存檔時轉成一般 MP4 與預先載入的全螢幕頁面，2026-10-10 | 存檔時就地把錄影轉成一般 MP4（先附加索引並 sync，再寫入 16 位元組的 mdat 標頭），36 分鐘的錄影開啟只要 41 ms（原本約 1.1 秒），AVFoundation 也能開啟；在 macOS 上，設定視窗開著時全螢幕頁面已先載入，第一格在 75 ms 出現（原本約 180 ms）。四支真實錄影逐封包相同；回歸 128/128；錄影 smoke、QuickTime 播放、原生 `player` 4/4 與 `measure:cpu` 通過（C 在修正 renderer 前置檢查後通過）。舊錄影仍是分段格式。見[紀錄](history-2026-10.md#存檔時轉成一般-mp4-與預先載入的全螢幕頁面--2026-10-10)。 |
| 統一焦點線、shadcn 前的紅色與素面狀態卡，2026-10-07 | 所有控制項統一為一條細的鍵盤焦點線（無外暈，錄影卡片圍繞整張卡片），恢復 shadcn 前的紅色（#fa2d48、#e85a62），狀態卡改為素面，失敗紀錄圖示改灰並以結果文字上色，捲軸 7 px。修正 4 項 review findings。回歸 67/67，基準檢視後重新產生；未進行桌面回合（只涉及頁面內繪製）。見[紀錄](history-2026-10.md#統一焦點線shadcn-前的紅色與素面狀態卡--2026-10-07)。 |
| Apple Music 配色、失敗紀錄卡片與選單，2026-10-07 | 配色更貼近 Apple Music（維持 4.5:1 對比）、失敗紀錄改為每天一張卡片、設定選單改為 shadcn Select（符合 CSP，修正 Escape 與焦點）、儲存不再閃爍、分頁不再交叉淡入淡出、加上上緣捲動漸層。回歸 66/66，基準檢視後重新產生；原生 `player`、`shortcut-native` 與 `settings-shortcut --observe` 通過。VoiceOver 搭配新選單未檢查。見[紀錄](history-2026-10.md#apple-music-配色失敗紀錄卡片與選單--2026-10-07)。 |
| 恢復外觀與動態，2026-10-07 | 在 plan 069 的 token 上恢復 shadcn 前的 Apple Music 配色、側欄、動態、播放器細節，並改由 Sonner 驅動復原 toast；內容改從頂端開始，細捲軸貼齊視窗右緣。回歸 65/65，36 張基準檢視後重新產生；原生 `player` 4/4 與 `settings-shortcut --observe` 通過。強制色彩、減少動態效果與 VoiceOver 未手動檢查。見[紀錄](history-2026-10.md#恢復外觀與動態--2026-10-07)。 |
| Plan 069 shadcn 樣式分層，2026-10-06 | Renderer 樣式移入 shadcn 的分層（token 在 `:root`／`.dark`、以 primitive variant 取代 `[data-slot]` selector、版面在 `@layer components`），預期畫面不變。252 張 gallery 中 190 張前後像素相同，其餘只在同一份程式兩次執行間本來就不同之處有差異；252 張的量測全部相同。`pnpm acceptance:regression` 通過（36 張基準未變）；原生 `player` 4/4；`tests/style-guard.test.ts` 守住分層。只在 hover 出現的狀態、強制色彩與非作用中視窗沒有圖片。見[結案](history-2026-10.md#plan-069-結案--2026-10-06)。 |
| Plan 067 設定 UI 盤點，2026-10-06 | 13px 根字級讓所有以 rem 計的控制項以 9.75px 文字畫在 22.75px 框內；根字級改為 16px、`text-xs` 為 13px。15 項問題修正（4 項 P1），5 項接受的取捨。252 組前後對照：小於 12px 的文字 3,628 → 0，低於對比下限 665 → 0，超出視窗的控制項 30 → 0。`pnpm acceptance:regression` 修正一項測試後通過；原生 `player` 4/4 與 `settings-shortcut --observe` 通過。VoiceOver 與 Windows 未測試。見[結案](history-2026-10.md#plan-067-結案--2026-10-06)。 |
| Plan 066 背景 Playwright 驗收，2026-10-06 | `pnpm acceptance:regression` 是 check 加上背景套件（53/53，210 秒），佔用桌面 0 秒，原本為 128 秒：54 次啟動，沒有視窗上螢幕、沒有搶焦點、沒有殘留程序。516 個設定案例中 513 個、快捷鍵 57 個與播放器 19 個全部移動（[帳本](playwright-migration-066.md)）；原生 `settings-native` 4/4、`shortcut-native` 修正 fixture 設定後 9/9、`player` 4/4。螢幕鎖定時亦通過。第一次 Windows CI 發現設定頁拖曳條在 Windows 蓋住分頁，已依維護者決定修正；最終 CI 在 macOS 與 Windows 皆通過（各 55/55）。Windows 原生行為未測試。見[結案](history-2026-10.md#plan-066-結案--2026-10-06)。 |
| Plan 068 模組邊界，2026-10-06 | `handleAction` 移到 `src/main/actions/`，設定頁拆成外框、分頁模組與依職責分開的 controller，`scripts/lib/` 分成 runner、acceptance、verification、audio 與 release；由 `tests/source-boundaries.test.ts` 強制兩棵樹的邊界。設定圖庫逐像素不變（60/60）；check、設定 516/516、Playwright 13/13、快捷鍵錄影、tray 15 項（另 1 項未執行）、更新與受控自我測試通過。三個間歇失敗（播放器 fixture 兩個、單元測試 helper 一個）都是測試本身的競態，不是 App 的問題；修正後播放器連續五次 19/19（[紀錄](history-2026-10.md#plan-068-結案--2026-10-06)） |
| Plan 064 Windows 發布，2026-10-03 | 依維護者決定，Windows x64 與 DMG 由同一個 tag 發布，只由 CI 檢查。`check-windows` 與發布的 `build-windows`、`verify-published-windows` 在發布前後於 `windows-2025` 上安裝、檢查並解除安裝每位使用者安裝檔；`v1.2.0-rc.1` 演練了五個資產的發布且未移動穩定版指標，`v1.2.0` 以 latest 公開，兩個驗證 job 都通過，網站提供 1.2.0 與兩個下載。每次打 tag 前 macOS 驗收與播放都通過，已安裝的 1.0.0 記錄 `updates: available; remote 1.2.0`。限制：沒有在 Windows 實機上執行任何東西（擷取、系統音訊、通知、系統匣與 035 的 N17 仍未測試）；未觀察設定中的更新結果（[紀錄](history-2026-10.md#plan-064-結案--2026-10-03)） |
| Plan 065 取消長時間 start，2026-10-03 | 保留的 log 顯示每次超過 1 秒的 start 都卡在準備階段（四次各 120 秒；中位數 289 ms、第 95 百分位 396 ms），最快的人工連按為 290 ms，因此寬限定為 1 秒。對暫停 `prepared` 的受控 build：start 後 213 ms 的快捷鍵被忽略並寫入 log，寬限後的快捷鍵與左鍵點擊都取消了 start，沒有檔案、通知或歷史項目；starting 選單標出 ⇧⌘1；start 被暫停時選「結束」，0.9 秒內結束。在新 bundle 上錄影 smoke、播放與雙語 tray 回合都通過。限制：暫停屬於受控狀態證據，不是真實未回應的擷取請求；長時間 start 案例只以英文執行（[紀錄](history-2026-10.md#plan-065-結案--2026-10-03)） |
| Plan 063 腳本化原生驗收，2026-10-02 | `pnpm acceptance:tray` 以 CoreGraphics 點擊與按鍵、輔助使用 press 操作真正的狀態列項目與選單：zh-TW 與 en 的 idle、倒數與錄影選單都與正式 model 的 `tray: menu opened` 一致，開始／停止、顯示上一段錄影（Finder 置前並選取檔案）、第二次點擊、取消錄影、倒數中結束、鍵盤導覽與結束都通過（15 通過、1 not run）。`acceptance:settings-shortcut -- --observe` 通過六項輔助使用檢查，`acceptance:quit-dialog` 的新橫幅文字層兩種語言都通過。限制：點擊會移動真正的游標（macOS 26 上 `CGEventPostToPid` 打不開選單），needsPermission 選單與過時的開始錄製留在 runner 外，外觀仍靠觀察截圖，回合中有人操作也不會被偵測（[紀錄](history-2026-10.md#plan-063-結案--2026-10-02)） |
| Plan 062 簽章通知 fixture，2026-10-02 | `pnpm acceptance:quit-dialog` 改為啟動每輪完整簽署並驗證的 Electron.app 副本。延後退出通知在兩種語言都送達（請求後 9 ms 收到 `shown`，timer 最多延遲 2 ms）。identity 缺少為 blocked，簽章失敗為 fail，兩者都不啟動。繁中橫幅文字完整可見；英文橫幅在第四行被截斷，完整文字未看到（blocked）。見[紀錄](history-2026-10.md#plan-062-結案--2026-10-02)。 |
| Plan 061 check 後驗收成本，2026-10-02 | 在 M1 Pro 上，每次設定修改的設定 fixture 成本為 93.18 秒（設定 55.29 秒、快捷鍵整合 37.89 秒），簽章 bundle 建置 37.7–40.6 秒（打包 36–39 秒），smoke 錄影 29.70 秒，播放 14.33 秒，鍵盤配置檢查 6.17 秒。`pnpm open:app` 以 0.66 秒沿用已驗證的 bundle；配方省掉不到 1 秒的重複建置。原生入口與 agent 區間未量測。見[紀錄](history-2026-10.md#plan-061-結案--2026-10-02)。 |

這些結果限於各自版本與環境，不代表目前 checkout 通過。後續記錄修復時，舊失敗仍保留在歷史。

## 證據位置

- [2026 年 10 月歷史](history-2026-10.md)：2026 年 10 月起的計畫結案。
- 發布紀錄：[1.7.0](releases/1.7.0.md)。
- `docs/verification/measurements/`：已 gitignore 的原始執行、log、媒體分析及截圖。連到此處的是**本機證據參照**，不是 repository 可下載附件；新 clone 不會包含。2026-09-26 維護者已要求刪除維護者電腦上到當天為止的所有原始執行紀錄，以及 ~/Movies/RecordStuff 裡的測試錄影；指向更早執行紀錄的連結在任何地方都已無法開啟，保留下來的是本目錄中整理過的紀錄。

新增值得長期保存的結果時，寫入對應月份歷史的日期段落（跨月建立新檔），或版本發布紀錄。已支持範圍改變時更新本摘要，並同步既有翻譯。依[報告範本](../acceptance.md#報告範本)記錄來源／產物、指令／案例、收尾與限制。歷史只追加，連結／格式修正除外，不把舊失敗改成通過。摘要須在缺少本機原始資料時仍可理解；協作者需要原始證據時，透過約定可存取的位置提供去識別 artifact，並標明可取得性。
