# 069 — 依 shadcn 的分層管理 renderer 樣式

[English](069-shadcn-style-layers.md) | [繁體中文](069-shadcn-style-layers.zh-TW.md)

建立：2026-10-06。狀態：已規劃，尚未開始實作。來源：plan 067 之後，維護者先詢問 CSS token 是否依照 shadcn，接著要求樣式依 shadcn 的管理方式整理，以便長期維護，同時保留 App 自己的設計值。本文件是可執行的計畫；建立本文件不代表重構已完成。

067 已於 2026-10-06 結案（[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-067-結案--2026-10-06)）；依[計畫索引](README.zh-TW.md)接著執行。這是佇列相依：沿用 067 的 gallery、量測與斷言，作為畫面沒有任何改變的證明。依執行當時的測試規則選擇檢查。

## 成果與範圍

Renderer 的外觀保留 067 定下的所有數值，但每一項客製都放在 shadcn 預期的那一層：

1. **Token。** 語意化 CSS 變數寫在 `:root` 與 `.dark` 兩個區塊，透過 `@theme inline` 對應到 Tailwind，形式與 shadcn 產生的一致。App 專屬的意義（錄影紅、媒體覆蓋層、品牌標誌）以具名 token 加在這裡，就像 shadcn 加入 `--chart-*` 或 `--sidebar-*`。
2. **元件。** `src/renderer/components/ui/*` 維持為我們擁有的 shadcn 程式碼。App 需要的差異以 `cva` variant 或元件 prop 表達，不從外部用選擇器伸進元件內部（`[data-slot=…]`，或用功能 class 覆寫元件的 utility）。
3. **功能頁面。** 頁面以 Tailwind utility 與 token 組合元件。留在 `ui.css` 的版面 CSS 放在 `@layer components`，使用 token，不寫死顏色。

結果必須視覺完全一致：這是重構，不是重新設計。範圍不含：修改設計值、改用 shadcn 預設色盤（白色頁面取代淺灰）、替換 Base UI、倒數覆蓋層自己的樣式表（`countdown.css`，依設計不屬於 shadcn）以及網站。除非維護者要求，不 commit、push、開 PR 或發布。

## 起始證據

於 `39dd5196`（2026-10-06）檢視：

| 範圍 | 目前狀態 | 目標 |
| --- | --- | --- |
| Token 格式 | 單一 `:root` 中的 `light-dark(#hex, #hex)`；`card-`、`popover-`、`secondary-` 與 `accent-foreground` 都對應到 `--foreground` | `:root` 與 `.dark` 兩個區塊，computed 顏色相同；每個 `*-foreground` 有自己的變數，值為目前的值 |
| App token | `--recording`（067）；`@theme` 中根字級規則的 `--text-xs: 0.8125rem` | 保留，並記錄為 App 刻意的主題決策 |
| 寫死的顏色 | `ui.css` 約 29 處，例如 `#ef4444`（未讀圓點、新增外框、品牌標誌）、`#18181b`／`#fff`（品牌與狀態標誌）、`#000b`／`#0009`／`#0002`（媒體覆蓋與陰影）、`#000`／`#fff`（播放器與全螢幕表面） | 具名 token（`--recording`、`--media`、`--media-foreground`、`--media-scrim`、`--shadow-*` 或同等命名） |
| 從外部伸進元件的選擇器 | `.section > [data-slot="card"]`（間距）、`.controls > [data-slot="button"]` 與 `.row-actions > [data-slot="button"]`（換行）、`.controls [data-slot="native-select-wrapper"]`、`.pc [data-slot="slider-*"]`、`[data-slot="switch*"]` 的強制色彩規則、`.tab-badge`／`.toast-key` 字級 | Card 的 size／spacing prop、Button 的 `wrap`（或同等）variant、Slider 的 `media` variant、元件內的 `forced-colors:` variant、Badge／Kbd 的 size variant |
| 功能 CSS | `ui.css` 約 1,170 行未分層規則 | 版面規則放在 `@layer components`（或在元件中改用 utility），使用 token；只有旁邊寫明 cascade 理由時才保留未分層規則 |

## 1. 基準與識別

- [ ] 在新的 `docs/verification/measurements/<timestamp>-shadcn-layers/` 記錄 HEAD、working tree 與本次測試 recipe。
- [ ] 建置一次，依序執行 `pnpm preview:ui -- --out <dir>/before`，保留其 `shots.json` 與 `measurements.json` 作為參考。這一步不需要桌面回合。

## 2. Token

- [ ] 把色彩 token 改寫為 `:root` 與 `.dark` 兩個區塊，在兩種主題下產生相同的 computed 顏色。保留 `color-scheme` 與頁面已在切換的 `.dark` class；確認「跟隨系統」外觀仍跟隨 OS。
- [ ] 每個 `*-foreground` 有自己的變數，值為目前的值，之後改色盤時不必修改對應。
- [ ] 為上述每個寫死的顏色新增具名 token 並取代字面值。意義相同的顏色共用同一個 token。

## 3. 元件

- [ ] 每個從外部伸進元件的選擇器，都改為該元件的 variant 或 prop，在呼叫處使用。其他呼叫者看到的預設繪製保持不變。
- [ ] 把強制色彩覆寫移進元件（`forced-colors:` variant），行為不變。
- [ ] 在每個修改過的 `components/ui` 檔案開頭記錄與 shadcn 原始碼的差異及原因，之後與上游比對時，能分辨刻意修改與走樣。

## 4. 功能樣式與護欄

- [ ] 其餘功能版面放進 `@layer components`（較清楚時改在呼叫處用 utility）。只有寫明 cascade 理由時才保留未分層規則。
- [ ] 新增一個檢查：`src/renderer`（token 區塊與 `countdown.css` 除外）出現寫死的顏色，或功能樣式表出現 `[data-slot=…]` 選擇器時就失敗。保持精簡，並納入 `pnpm check`。
- [ ] 在[桌面設計](../docs/zh-TW/system-design/desktop.md#設定視窗)與[repository](../docs/zh-TW/system-design/repository.md)（及英文版）寫入三層分工，以及新的客製該放在哪一層。

## 5. 驗證與結案

依[測試規則](../docs/zh-TW/testing.md)分類最終 diff。renderer 樣式重構透過共用 token 也會影響播放器與全螢幕頁，預期 recipe：

| 檢查 | 要求 |
| --- | --- |
| `pnpm acceptance:regression` | 通過，包含 `settings-layout`（U067-0…3），36 張 reviewed matrix baseline **不變**；baseline 出現差異視為要修的回歸，不重新核准 |
| 同一份 `out/` 上的 `pnpm preview:ui -- --out <dir>/after` | 依 `shots.json` 與 before 配對：每張像素一致，或差異經檢視並說明（例如反鋸齒），且 `measurements.json` 的字級、對比、點擊區與 overflow 完全相同 |
| 新的護欄 | 刻意放入寫死顏色與 `[data-slot]` 選擇器時失敗，移除後通過 |
| `pnpm acceptance:player`（桌面回合） | 只有在播放器或全螢幕頁的 token 或元件改變繪製路徑時；需完成桌面交接 |
| `git diff --check`、連結與翻譯 | 通過 |

視窗選項、`window-controls.ts` 與左上角繪製不在範圍內；若有變動，加上在新的 `pnpm start:app` 上執行 `pnpm acceptance:settings-shortcut -- --observe`。純樣式變更不執行錄影、CPU、通知與網站檢查。

- [ ] 把結案紀錄（前後配對、護欄、檢查、任何不一致之處及原因）寫入[驗證紀錄](../docs/zh-TW/verification/README.md)及其英文版，更新兩份計畫索引，再依[完成規則](README.zh-TW.md#完成計畫)移除本計畫與其翻譯。
