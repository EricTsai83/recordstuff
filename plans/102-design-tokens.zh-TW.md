# 102 — 所有頁面共用一套設計 token

[English](102-design-tokens.md) | [繁體中文](102-design-tokens.zh-TW.md)

狀態：進行中；第 1 步（錄影檔分頁，樣板）於 2026-10-31 完成。建立：2026-10-31，依維護者要求：「整個 CSS 以 shadcn 為基底，盡量不要用 Tailwind 預設或寫死像素，讓所有地方一致，每次改動都附前後比較圖。」硬相依：無未完成項目。以已結案的 067（字級、點擊目標與對比）與 069（樣式分層與 `tests/style-guard.test.ts`）為基礎。依[計畫索引](README.zh-TW.md)的順序執行。

## 目前的問題

顏色已經全部是 token（069 的 style guard 會擋下寫死的顏色），但尺寸不是：

- `src/renderer/ui.css` 有 763 行含像素值：margin、padding、gap 用了 32 種值（1、2、3、4、5、5.5、6、7、8、8.5、9、10、12、14、16、18、20、22、24、26、28、30、32、34、36、40、44、46、56、64、72），字級 11 種（7.5 到 30），圓角有 6 種直接寫在 `--radius-*` 旁邊。
- 各頁 TSX 有 92 個含像素的 Tailwind 任意值（`text-[13px]`、`gap-[6px]`、`min-w-[196px]`、`rounded-[14px]` 等）。
- 同一種用途在不同頁面數值不同：列表上方的標題是 14/10、18/12、20/16 或 12/4 px；區段間距 22、28 或 44 px；列的內距 12 或 14 px。設計文件寫頁面標題 24px，CSS 實際是 26px。

## shadcn 與 Tailwind 原本提供什麼

- Tailwind v4 只有一個間距變數 `--spacing`（4px）；`p-3`、`gap-6` 和 CSS 的 `--spacing(3)` 都是它的倍數，含半格。字級（`text-xs` 到 `text-2xl`）與圓角是 App 可以重新定義的 theme 變數。
- shadcn/ui 定義顏色 token 與一個 `--radius`，`--radius-sm/md/lg/xl` 由它推算；元件使用 Tailwind 的間距與字級名稱，是網頁密度（控制項 36px、文字 14px）。
- RecordStuff 保留 macOS 密度（維護者 2026-10-31 的選擇）：067 已把 `text-xs` 改成 13px；控制項高 28px。

## 設計

- **間距**：CSS 用 `--spacing(n)`，TSX 用 Tailwind 的數字名稱，刻度為 0.5、1、1.5、2、2.5、3、4、5、6、8、10、12（2–48px）。不在刻度上的值改成最接近的一格。
- **字級**：`--text-3xs` 11px（只用在最密的說明）、`--text-2xs` 12px（說明、中繼資料、數量）、`--text-xs` 13px（內文與控制項，067）、需要時用 Tailwind 的 `--text-sm`/`base`/`lg`，頁面標題用 `--text-title`，設為設計文件寫的 24px（目前 26px；第 2 步兩者並列給維護者看）。
- **圓角**：在 shadcn 的 `sm`/`md`/`lg`/`xl` 旁邊加 `--radius-xs`（radius − 6px）。
- **同一用途只用一個值**：列表上方的標題上 `--spacing(5)`、下 `--spacing(3)`；區段之間 `--spacing(6)`；列的內距 `--spacing(3)`；卡片格線 `--spacing(6)` × `--spacing(5)`。
- **刻意保留像素**：1px 細線、焦點框與播放進度條的幾何、版面斷點與容器查詢寬度（容器查詢不能讀變數）、像 272px 卡片這類尺寸下限、`editor-geometry.ts` 有測試的時間軸幾何，以及倒數畫面獨立的樣式表（069）。

## 步驟

每一步：先拍改動前截圖，改動後再拍，以 `pnpm preview:ui` 的 `shots.json` 或樣板用的並排差異圖（框出有變動的區域）配對；跑受影響的 `pnpm test:scope`；做 Codex GPT-6.1 Sol review；各自 commit。截圖隨每一步的回報交給維護者。

1. **錄影檔分頁（樣板）— 2026-10-31 完成。** 上述 token；該分頁的 CSS 與 TSX 改用 token。共用的 `.day-heading` 與 `.result-day` 讓疑難排解的日期間距一起統一。
2. **一般與錄影設定**：區段、列、區段標題、關於區塊、清除資料區段；頁面標題 token。
3. **錄影工作室與鍵盤快捷鍵。**
4. **疑難排解**（失敗紀錄列、說明、動作、技術詳細資料）與首次使用引導。
5. **共用外框**：側欄、頁首、對話框、選單、toast、縮放提示、tooltip；shadcn 元件裡的任意值改成 variant。
6. **剪輯畫面與播放器**：只改間距與字級；時間軸幾何不動。
7. **防護**：擴充 `tests/style-guard.test.ts`，像擋顏色一樣擋下 `ui.css` 中保留清單以外新增的像素 margin、padding、gap、字級與圓角，以及 TSX 中的 Tailwind 任意像素值；更新設計文件（desktop.md 的字級段落），結案。

## 驗證

每一步跑背景套件（改到的分頁的 `pnpm test:scope`，共用外框加 `layout`），以 `pnpm preview:ui` 配對每一頁的中英文、深淺色與預設、窄、最小三種尺寸。只在第 7 步做一次桌面回合，在 M1 Pro 上看真實視窗；背景套件已經在離屏繪出同樣的頁面。

## 風險

- 對齊刻度會讓元素移動 2–4px，頁面可能多或少一行。每一步的截圖會在 commit 前呈現。
- 為某一頁改共用規則，會連帶改到其他頁（如第 1 步的 `.day-heading`）；每一步會列出共用規則影響的頁面。
