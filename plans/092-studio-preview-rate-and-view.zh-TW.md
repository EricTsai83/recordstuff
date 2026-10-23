# 092 — 工作室預覽的流暢度選項與螢幕來源

[English](092-studio-preview-rate-and-view.md) | [繁體中文](092-studio-preview-rate-and-view.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-23，依維護者要求；同日修訂：排在 091 之後、084 之前，預設改為「關閉」（D1），「流暢」只在實測成本被接受時保留（D2），「相機」來源移到 [094](094-studio-camera-view.zh-TW.md)。硬性相依：091（它的結案決定了每個 Studio 數字所比較的 R）。佇列第四個，在 091 之後、094 與 084 之前，因為它會改 Studio port 與預覽幀率，而 084 之後要為這些設上限。依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下行為都尚未實作或驗證。

## 目標與現況

錄影工作室的預覽是一條合成畫面的 H.264 串流，寬 640（`PREVIEW_WIDTH`，[camera_layout.rs](../native/capture/src/camera_layout.rs)）、1 Mbps；有人在操作 Studio 時每秒 10 張，只是看著時每秒 5 張（[studio-pace.ts](../src/renderer/settings/tabs/studio-pace.ts)，081 的 D1）。「操作」指滑鼠停在視窗上，或 3 秒內有按鍵、點擊、滾輪，不是視窗 focus。頁面在 Studio port 上為它顯示的 session 設定幀率，不論是 Live preview 或錄影。維護者覺得 5 fps 太慢，希望幀率由使用者選；使用者也無法看沒有相機的螢幕，只能看合成畫面。

640 是串流的解析度，不是頁面上的大小：預覽區最高 220 CSS px、依螢幕比例（16:9 約 391 × 220，[ui.css](../src/renderer/ui.css)），不論這裡選什麼都一樣大。預覽解析度與相機擷取尺寸（兩個平台都是 1280 × 720）都不做成設定：在這個預覽區大小下更高的預覽解析度看不出差別，調相機尺寸對效能沒有好處（維護者，2026-10-23）。

## 決定（維護者，2026-10-23，同日修訂）

- **D1 — 預覽流暢度選項**，放在預覽區上方：**關閉**（**預設**：不合成、不編碼、不繪製預覽，Studio 也不自己開相機）、**省電**（只是看著時 5 fps、操作時 10 fps，即現在的行為，換一個說得出用途的名字）、**標準**（固定 10 fps）、**流暢**（固定 15 fps，依 D2）。每個選項有一行說明；選「省電」時，預覽區角落顯示目前的幀率與原因（例如 `10 fps · 操作中`／`5 fps · 省電中`）。「關閉」保留預覽區的外框與比例，顯示「預覽已關閉」和開啟按鈕，按下後以使用者上次選的幀率開啟（第一次為「省電」）；泡泡外框照樣可在空白預覽區上拖曳，音量表照常（訂閱是分開的）。session 開始前，「關閉」也表示頁面不會為泡泡以 `getUserMedia` 開啟相機（[camera-preview.tsx](../src/renderer/settings/tabs/camera-preview.tsx)），所以打開 Studio 絕不會讓相機燈亮起。這個選項是一個保存的設定，Live preview 與錄影共用：使用者開啟預覽後，會一直維持開啟，直到自己關掉。最初規劃的預設是「標準」，之後改為「省電」；維護者於 2026-10-23 定為「關閉」，讓打開 Studio 不比錄影多花任何成本（預設即符合 D18），預覽則是使用者主動要求的功能。
- **D2 — 「省電」（操作中）、「標準」與「流暢」作為使用者自選的選項，接受超出 D18**，以實測為準，不用推估。15 fps 推估比錄 30 fps 多約 15 點；在約 391 × 220 的預覽區上，它比 10 fps 看得出的差別很小。「流暢」只有在實測增量比「標準」多不超過約 4 點時才上線；否則在結案前從 D1 移除，並記錄這個結論。結案時記下數字，並更新[設計決策](../docs/zh-TW/system-design/decisions.md)裡預算的文字。
- **D3 — 預覽來源：合成／螢幕**，以分段按鈕放在流暢度旁邊。預覽區維持原大小與錄影的比例。「螢幕」只畫螢幕、不畫相機，外框照樣可拖曳。只改預覽：錄出來的永遠是合成畫面。「相機」來源（只看相機、放大）在 [094](094-studio-camera-view.zh-TW.md)；`view` 訊息在這裡就設計好，讓 094 只需新增一個值，不必新增訊息。

## 步驟與責任

- [ ] **先量 baseline。** 在 091 的最終 bundle 上（若 091 沒有採用變更，就用當時的 HEAD），量現在的 Studio：S（只是看著，5 fps）、加上 `--studio-active` 的 S（10 fps）與 L，30 與 60 fps，`--repeat 3 --diagnostics`，同一輪也量 R，因為 Studio 的數字是相對 R 的增量。從 profile 數出 capture 程序中預覽執行緒的喚醒次數。
- [ ] **引擎端的幀率。** 預覽執行緒改為依所選幀率的間隔排程下一格，不再以 `PREVIEW_FPS` tick 再跳過，所以只在出畫面時喚醒（每秒 5、10 或 15 次）；改幀率或來源時立即喚醒並重設排程，`preview_tick_shows` 由這個排程取代。確認編碼器設定的幀率與 1 Mbps 在 15 fps 下夠用。port 的 `rate` 訊息（`isStudioRate`，[studio-port.ts](../src/shared/studio-port.ts)）接受 D1 的各幀率；「關閉」是頁面不再訂閱預覽（和預覽區離開視線時同一條路），不是幀率 0。macOS 與 Windows 的 session 都要改。
- [ ] **頁面端的幀率。** main 的 Studio model（[model/studio.ts](../src/main/settings/model/studio.ts)）新增並保存這個設定，預設「關閉」，i18n 補英文與繁中。`paceStudio` 只在「省電」時運作，其他選項固定送一個幀率；角落標籤讀 `paceStudio` 目前的值。單元測試涵蓋選項、預設值與保存，以及各選項的節奏。
- [ ] **「螢幕」來源。** Studio port 新增 `view` 訊息（`composed` 或 `screen`；未知的值由 validator 拒絕）；compositor 的預覽 render 依來源：「螢幕」走現有相機隱藏（D13）的路徑。切換來源時強制出 key frame。錄影的 `compose` 不動。兩個平台的 compositor 都有 Rust 測試，確認預覽參數跟著來源變、錄影參數不變。頁面：分段按鈕；session 開始前，「螢幕」提示開始 Live preview 後顯示。只用正式元件與 CSS，依 [UI 對齊規則](../docs/zh-TW/testing.md#測試-ui-與-app-保持一致)。
- [ ] **改完再量並更新文件。** 量與 baseline 相同的案例，涵蓋各幀率與「關閉」，以及「省電」下操作中的成本；錄一段有相機的影片並切換來源，確認檔案是合成畫面。更新 [recording](../docs/zh-TW/system-design/recording.md)、[decisions](../docs/zh-TW/system-design/decisions.md) 與工具指南的[管線 baseline](../docs/zh-TW/system-design/tooling.md#管線-baseline) 及預算中 Studio 的段落（各幀率的 Studio 數據成為 084 與 094 的比較基準），以及翻譯。

## 門檻與完成條件

預設的「關閉」不比 R 多花成本：預覽關閉時看著的 Studio 在 R 的範圍內，且不開相機。「省電」的成本與現在的 Studio 相同：兩種幀率下的 CPU 與 capture 程序的喚醒次數都在 baseline 範圍內；差異很小，所以依[測試政策](../docs/zh-TW/testing.md#縮短錄影回合)與 baseline 連續量測。每個幀率實際顯示的張數符合所選（以頁面的 drawn 計數量）；「省電」在操作後一個 tick 內升到 10、停止操作 3 秒後回到 5；「關閉」時不合成、不編碼、不繪製，音量表照常。「流暢」依 D2 的規則保留或移除。「螢幕」顯示沒有相機的螢幕，切換來源從不改變錄出的檔案。改幀率或來源從不讓錄影失敗或卡住。

## 驗證

每個步驟的 focused 測試（`pnpm test:scope -- studio settings-bridge`，排程與來源參數的 Rust 測試）；port 與引擎的改動跑 `pnpm check`。在新的簽章 bundle 上、經「好了」交接後做一輪桌面測試：`pnpm acceptance:studio`、第一步與最後一步的 CPU 案例、一段有相機的錄影（經維護者同意）以 `pnpm verify` 檢查。Windows 只經 CI。

## 執行與結案契約

依[計畫索引](README.zh-TW.md)處理順序、決定點、桌面交接與結案；保留 capture process 的故障隔離，以及預覽失敗不讓錄影失敗。開始執行時先看當時的程式碼與 090、091 的結案紀錄。
