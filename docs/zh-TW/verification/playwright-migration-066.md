# Plan 066 — 背景 Playwright 遷移帳本

[English](../../verification/playwright-migration-066.md) | [繁體中文](playwright-migration-066.md)

plan 066 把桌面 runner 的每一個斷言移到背景套件；本帳本列出每個斷言的穩定 ID、去向，以及它現在提供的證據。Host 與邊界見[背景 UI 套件](../system-design/tooling.md#背景-ui-套件)；最終結果見[結案紀錄](history-2026-10.md#plan-066-結案--2026-10-06)。

## 起點

- Revision `b9271c9c573350e9bbb7da9b333a8ff24b9ac505`，工作區乾淨：plan 撰寫時所依據的 React／shadcn 與離屏 Playwright 變更，當天已提交為 `3e0f58e3` 與 `c634a2eb`。Electron 44.3.0、Playwright 1.63.0、Node 24.21.0、macOS 26（Darwin 25.6.0）arm64。
- 先前的指令關係：`acceptance:regression` = `check` → `test:ui`（13 個元件測試，不需桌面）→ `acceptance:settings`（516 個案例，桌面回合）→ 快捷鍵 fixture 的 normal、restart、settings 三個階段（57 個案例，桌面回合）。`acceptance:player`（19 個案例）是另一個桌面回合。
- 計時沿用、未重新量測（同一台機器、同一天，revision `bcf744af`，模組重新分組之前）：配方 `settings` 共 182.26 秒，其中 `test:ui` 23.52 秒，設定 fixture 88.59 秒與快捷鍵 fixture 39.36 秒佔用桌面（`2026-10-06T05-27-52-850Z-recipe-settings`）。下列案例名稱取自該輪的 `results.json`／`summary.json`，以及播放器回合 `2026-10-06T05-31-01-485Z-player-acceptance`（17/19；兩個失敗是 fixture 的競態，已在重新分組前修正）。

## 證據種類

| 種類 | 意義 |
| --- | --- |
| BG-page | 背景套件：Playwright 輸入（CDP）送到隱藏離屏視窗中的正式頁面與 preload；頁面的 DOM 焦點、繪製與幾何 |
| BG-IPC | 背景套件：真實 IPC 往返到 view host 的 handler，背後是真正的 `settingsView`、`RecordingResults`、`RecordingsLibrary` 與媒體協定 |
| BG-main | 背景套件：正式 `out/main/index.js` 及其儲存與視窗控制器；OS 效果是 adapter 呼叫（正式程式提出的要求，不是 OS 效果） |
| BG-media | 背景套件：簽入片段（tests/ui/media）的真實解碼，靜音 |
| Native | 在已顯示視窗上的桌面 runner：OS 視窗狀態、焦點、視窗框或在螢幕上的全螢幕 |

每個移動過的案例，輸入種類都變了：先前 fixture 對啟用中的視窗送 Electron `sendInputEvent` 事件；背景套件對隱藏視窗送 Playwright 輸入，該視窗的文件保持焦點。main 在頁面之前攔截的按鍵，在背景套件同樣以 `sendInputEvent` 送出。先前依 OS 啟用狀態判定的案例（plan 057），現在判定的是頁面自己的焦點行為；OS 啟用本身屬 Native 列。

## 設定（先前的 `pnpm acceptance:settings`，516 個案例）

ID 依先前執行的 115 個案例群組順序編號；`×n` 為迴圈展開（語言 × 外觀 × 尺寸 × 狀態）。未另外標註者皆為 BG-page 加 BG-IPC。

| ID | 行為 | 數量 | 去向 | 處置 |
| --- | --- | --- | --- | --- |
| S001 | 視窗與 App 的視窗框相同 | 1 | Native：`acceptance:settings-native` N-S001 | 保留為原生（離屏視窗沒有視窗框） |
| S002–S009 | 出貨 CSP 且沒有 console 錯誤、精簡標頭、bridge 鍵、沒有 Node API、URL 語言、已提交的值、不可用選項、被拒快捷鍵的註解 | 8 | settings-panel.spec.ts | 已移動；console 錯誤現在於每個測試 teardown 時都會導致失敗 |
| S010–S013 | 變更以 id 到達 main、重新繪製、沒有失敗文字；未提交的選擇會回報 | 4 | settings-panel.spec.ts | 已移動 |
| S014–S015 | 兩個延後的儲存加上較舊的推送；最後完成 | 2 | settings-panel.spec.ts | 已移動 |
| S016–S021 | 通知卡片：同一張卡片、設定面板按鈕的 id、關閉開關、延後儲存 ×2（開、關）保留控制項／焦點／捲動、錄影限制時變暗 | 8 | settings-panel.spec.ts | 已移動 |
| S022 | library 讀到名稱、日期、大小與片長 | 1 | settings-panel.spec.ts | 已移動 |
| S023 | 沒有水平或頁面外層溢位 | 120（2×2×3×10） | settings-matrix.spec.ts | 已移動 |
| S024 | 視窗按鈕下沒有可點擊元素 | 120 | settings-matrix.spec.ts | 已移動 |
| S025 | 狀態卡片只在需要時出現；側欄底部只有結束 | 24 | settings-matrix.spec.ts | 已移動 |
| S026 | 從頂端第一次 Tab 到達分頁 | 4 | settings-matrix.spec.ts | 已移動 |
| S027、S035、S036 | 錄影檔依日期分組；空資料夾；無法讀取的資料夾 | 各 12 | settings-matrix.spec.ts | 已移動 |
| S028 | 縮圖經 `recordstuff-media:` 載入，一張備用圖示 | 4 | settings-matrix.spec.ts | 已移動；備用圖示預期的 404 已宣告 |
| S029–S031 | 無法播放的檔案在錄影檔上方開啟播放器：具名控制項、角落、關閉 | 各 12 | settings-matrix.spec.ts | 已移動 |
| S032–S034 | 卡片選單：角落、hover 只點亮一項且可讀、⋯ 與右鍵在視窗內開啟、Escape 歸還焦點 | 各 12 | settings-matrix.spec.ts | 已移動（先前依啟用狀態判定，現在依頁面焦點） |
| S037–S038 | 倒數音效開關點擊；倒數為關閉時停用 | 2 | settings-panel.spec.ts | 已移動 |
| S039–S041 | 狀態卡片：就緒時沒有開始；更改輸出資料夾…；重新啟動連結 | 3 | settings-panel.spec.ts | 已移動 |
| S042–S043 | ⓘ 以 hover（在上方、間隙、保持、隱藏）與 Tab 加 Escape | 各 2（en/minimum、zh-TW/default） | settings-panel.spec.ts | 已移動 |
| S044–S048 | 更新檢查：重複狀態保留節點；Tab+Enter 只檢查一次；忙碌時的焦點框；下一次 Tab 往後 | 5 | settings-panel.spec.ts | 已移動 |
| S049–S052 | 捲動提示 | 4 | settings-panel.spec.ts | 已移動 |
| S053–S057 | 寬窄版頁尾；顯示 log 列；失敗連結的重試與其焦點 | 5 | settings-panel.spec.ts | 已移動 |
| S058–S066 | 以鍵盤操作快捷鍵編輯器、焦點框、聆聽中、Control+F12、確認、Shift+Tab、強制色彩、減少動態 | 9 | settings-panel.spec.ts | 已移動；媒體模擬改用 Playwright 而非 debugger |
| S067–S086 | 失敗紀錄：處理中、部分保存 ×4、知道了、重新展開、入口、未讀、過期的按壓、持久化 ×2、重試 ×2、連續失敗、移除、空狀態 | 25 | settings-results.spec.ts | 已移動（正式 `RecordingResults`，受控儲存） |
| S087–S088 | 載入狀態 ×2；自動重試 | 3 | settings-results.spec.ts | 已移動 |
| S089–S093 | 150 毫秒（en）與 2000 毫秒（zh-TW）的持久儲存 | 10 | settings-results.spec.ts | 已移動 |
| S094–S102、S104、S106–S109 | 失敗紀錄分頁：其他分頁沒有紀錄 ×2、分頁列 ×2、分頁按鍵、日期分組、標頭按鍵、獨立展開、焦點框、指標、跨日、技術細節、各分頁捲動、入口、計數 | 16 | settings-results.spec.ts | 已移動 |
| S103 | 未啟用的視窗沒有焦點框，回來時恢復 | 1 | Native：N-S103 | 保留為原生（需要另一個視窗在前） |
| S105 | 未啟用時跨日仍保留聚焦的操作 | 1 | Native：N-S105 | 保留為原生 |
| S110–S115 | 分頁、選單、分段、開關、按鈕、列操作的鍵盤焦點框 | 各 4 | settings-results.spec.ts | 已移動 |

合計：513 個移到背景，3 個保留為原生，0 個移除。先前的截圖以圖的形式保留在 `test-results/ui/`；其中 36 張（錄影設定、一般與錄影檔狀態）會與審核過的 macOS 26 基準比對。

## 快捷鍵整合（先前的 `pnpm acceptance:shortcut`，57 個案例）

| ID | 行為 | 去向 | 證據 | 原生對應 |
| --- | --- | --- | --- | --- |
| K-N01–K-N14 | normal 階段：確認前預覽不改設定；被拒的註冊仍保存；註解；每次要求只通知一次；關閉；卡片說明設定快捷鍵；通知偏好；重試；無效候選；其他偏好；留下失敗的選擇；調整大小已保存 | shortcut-integration.spec.ts | BG-main | K-N01–K-N04 另由 N-K01–N-K04 以 Electron 真正的註冊經 `setSuspended` 被拒執行；K-N10（重試恢復）另由 N-K04b 以真正的註冊執行 |
| K-R01–K-R04 | 重新啟動：大小、失敗的自訂選擇、重試註冊並顯示、要求通知 | shortcut-integration.spec.ts（同一測試，以相同資料第二次啟動） | BG-main | — |
| K-S01–K-S08 | 啟動時的深色外觀；舊鍵的所有權；Tray 說明；預覽；恢復；三種外觀 | shortcut-integration.spec.ts | BG-main | — |
| K-S09 | callback 還原最小化視窗且不重複 | K-S09a：正式程式要求的還原、顯示與聚焦 | BG-main | N-K05：真實最小化視窗被還原並聚焦 |
| K-S10–K-S32 | 擷取暫停；保留鍵；Tray 中失敗的註冊 ×2；重新整理不重試；renderer 崩潰與替換；編輯器時限、逾時與清除 ×2；擷取並保存 Control+W；跨關閉、重開與崩潰的延後儲存 | shortcut-integration.spec.ts | BG-main（延後的儲存是 settings.json rename 上的測試閘門） | 已聚焦視窗上的關閉鍵：N-K06 |
| K-S33–K-S38 | 兩輪入口：大小保留、快捷鍵沿用同一視窗、關閉鍵保留 App 且 Tray 重開 | shortcut-integration.spec.ts | BG-main（可見／聚焦是要求） | 真實視窗上的 N-K06–N-K08 |
| K-S39 | 入口循環不開始擷取也不改偏好 | shortcut-integration.spec.ts | BG-main | N-K08 也檢查偏好 |

runner 的 `--drill-failure` 與 `--drill-timeout` 保留在 `pnpm acceptance:shortcut-native`。

## 播放器（先前的 `pnpm acceptance:player`，19 個案例）

| ID | 行為 | 去向 | 證據 | 原生對應 |
| --- | --- | --- | --- | --- |
| P01–P10 | 列出片段與片長；卡片播放；具名控制項與標題；靜止與喚回；暫停；空白鍵／K／→／M；拖曳進度條；音量滑桿；角落 | player.spec.ts | BG-page、BG-media | — |
| P11 | 全螢幕帶名稱、控制項與交接的時間，蓋住螢幕 | player.spec.ts：正式程式要求蓋住螢幕的視窗（邊界、全螢幕要求）與其頁面 | BG-main、BG-media | N-P01：已顯示且蓋住螢幕的視窗 |
| P12–P13 | 全螢幕中的靜止與喚回 | player.spec.ts | BG-page | — |
| P14 | F 離開，播放器接續 | player.spec.ts | BG-media | N-P02：設定視窗取回焦點 |
| P15 | 雙擊全螢幕，Escape 離開且播放器仍開啟 | player.spec.ts | BG-page | N-P03 |
| P16–P18 | 標題列區；關閉並釋放檔案；直式片段的 16:9 畫面 | player.spec.ts | BG-page、BG-media | — |
| P19 | 沒有 console 錯誤 | 每個測試的 teardown | — | N-P00 |

片段現在簽入儲存庫（480 × 270 與 270 × 480，取代 1280 × 720 與 720 × 1280）；P18 依直式片段自己的尺寸判定。背景套件與桌面 runner 都不再需要 FFmpeg 來產生片段。

## 元件檢查（先前在 `fixture.cjs` 上的 `tests/ui/components.spec.ts`，13 個測試）

13 個測試的斷言全部保留，改在 view host 的 `components` 模式執行；清理 helper 測試另外確認 helper 的程序已結束。

## 新增的背景涵蓋

| ID | 行為 | 去向 |
| --- | --- | --- |
| S116 | 窄視窗頂端的拖曳條不蓋住任何分頁（darwin 與 win32 版面） | settings-panel.spec.ts；第一次 Windows CI 發現拖曳條蓋住分頁後新增 |
| C01–C06 | 倒數覆蓋層：數字出現在隱藏、不啟用 App、依螢幕調整大小的覆蓋層；更新；結束時淡出並銷毀；取消；載入時的音效旗標與替換頁面；靜音的頁面 | countdown.spec.ts |
| D01–D10 | 清理演練：啟動失敗、斷言失敗、逾時、renderer 崩潰、main 卡住、圍堵違規、SIGINT；繞過真實對話框、通知、啟用與取消靜音；App 自行結束前的違規；提到資料夾的外部程序 | drills.spec.ts（`pnpm test:ui:drills`） |

## 原生對應

| ID | Runner | 行為 |
| --- | --- | --- |
| N-S001、N-S103、N-S105 | `pnpm acceptance:settings-native` | 視窗框；另一個視窗在前時的焦點框；在前時的跨日 |
| N-K01–N-K04b | `pnpm acceptance:shortcut-native`（registration） | 預覽；真正的註冊被拒並保存；註解；通知要求；重試以真正的註冊恢復 |
| N-K05–N-K08 | `pnpm acceptance:shortcut-native`（windows） | 真實的最小化／還原／聚焦；關閉鍵；快捷鍵開出一個可見且聚焦的視窗；Tray 重開且不改偏好 |
| N-P01–N-P03 | `pnpm acceptance:player` | 全螢幕蓋住螢幕；F 離開且焦點交還；雙擊與 Escape |

`pnpm acceptance:recipe -- native-ui` 以一次建置執行這三個。結果見[結案紀錄](history-2026-10.md#plan-066-結案--2026-10-06)。
