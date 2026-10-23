# 092 — 工作室預覽的流暢度選項與預覽來源

[English](092-studio-preview-rate-and-view.md) | [繁體中文](092-studio-preview-rate-and-view.zh-TW.md)

狀態：已規劃、尚未開始；在佇列中的位置尚未決定。建立：2026-10-23，依維護者要求。硬性相依：無（會改到 084 要稽核的同一個 Studio port；兩者先後與排序一起決定）。依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下行為都尚未實作或驗證。

## 目標與現況

錄影工作室的預覽是一條合成畫面的 H.264 串流，寬 640（`PREVIEW_WIDTH`，[camera_layout.rs](../native/capture/src/camera_layout.rs)）、1 Mbps；有人在操作 Studio 時每秒 10 張，只是看著時每秒 5 張（[studio-pace.ts](../src/renderer/settings/tabs/studio-pace.ts)，081 的 D1）。「操作」指滑鼠停在視窗上，或 3 秒內有按鍵、點擊、滾輪，不是視窗 focus。維護者覺得 5 fps 太慢，希望幀率由使用者選；使用者也只能看合成畫面，無法單獨看螢幕或相機。

640 是串流的解析度，不是頁面上的大小：預覽區最高 220 CSS px、依螢幕比例（16:9 約 391 × 220，[ui.css](../src/renderer/ui.css)），不論這裡選什麼都一樣大。預覽解析度與相機擷取尺寸（兩個平台都是 1280 × 720）都不做成設定：在這個預覽區大小下更高的預覽解析度看不出差別，調相機尺寸對效能沒有好處（維護者，2026-10-23）。

## 決定（維護者，2026-10-23）

- **D1 — 預覽流暢度選項**，放在預覽區上方：**省電**（只是看著時 5 fps、操作時 10 fps，即現在的行為，換一個說得出用途的名字）、**標準**（固定 10 fps，預設）、**流暢**（固定 15 fps）、**關閉**（不合成、不編碼、不繪製預覽）。每個選項有一行說明；選「省電」時，預覽區角落顯示目前的幀率與原因（例如 `10 fps · 操作中`／`5 fps · 省電中`）。「關閉」保留預覽區的外框與比例，顯示「預覽已關閉」和重新開啟的按鈕；泡泡外框照樣可拖曳，音量表照常（訂閱是分開的）。
- **D2 — 接受「流暢」超出 D18。** 083 量到 Studio 在 5 fps 時比錄影多 7.3 點、10 fps 多 11.2 點（錄 30 fps，[管線 baseline](../docs/zh-TW/system-design/tooling.md#管線-baseline)）；15 fps 推估約 15 點，必須實測。預設的「標準」在只是看著時也超過 D18 的 8 點；結案時記下新數字，並更新[設計決策](../docs/zh-TW/system-design/decisions.md)裡預算的文字。
- **D3 — 預覽來源：合成／螢幕／相機**，以分段按鈕放在流暢度旁邊。三種模式下預覽區都維持原大小與錄影的比例。「螢幕」只畫螢幕、不畫相機，外框照樣可拖曳。「相機」只畫相機，放大到預覽區內最大、置中，長寬比與圓角和錄影裡合成的泡泡相同；外框隱藏。只改預覽：錄出來的永遠是合成畫面。

## 步驟與責任

- [ ] **引擎端的幀率。** 預覽執行緒每秒 tick 30 次（取代 `PREVIEW_FPS`），讓 5、10、15 都能整除，`preview_tick_shows` 跟著改；確認編碼器設定的幀率與 1 Mbps 在 15 fps 下夠用。port 的 `rate` 訊息（`isStudioRate`，[studio-port.ts](../src/shared/studio-port.ts)）接受 D1 的各幀率；「關閉」是頁面不再訂閱預覽（和預覽區離開視線時同一條路），不是幀率 0。macOS 與 Windows 的 session 都要改。
- [ ] **頁面端的幀率。** main 的 Studio model（[model/studio.ts](../src/main/settings/model/studio.ts)）新增並保存這個設定，i18n 補英文與繁中。`paceStudio` 只在「省電」時運作，其他選項固定送一個幀率；角落標籤讀 `paceStudio` 目前的值。單元測試涵蓋選項、保存，以及各選項的節奏。
- [ ] **引擎端的預覽來源。** Studio port 新增 `view` 訊息；compositor 的預覽 render 依來源：「螢幕」走現有相機隱藏（D13）的路徑，「相機」在 `camera_layout.rs` 新增一組參數（泡泡裁切以最大尺寸置中、不畫螢幕、周圍用預覽區背景色）。切換來源時強制出 key frame。錄影的 `compose` 不動。兩個平台的 compositor 都有參數的 Rust 測試。
- [ ] **頁面端的預覽來源。** 分段按鈕、「相機」時隱藏外框，以及沒有畫面的情況：錄影前「相機」放大頁面自己開的相機（`getUserMedia`），套同樣的比例與圓角；「螢幕」提示開始 Live preview 後顯示；相機中斷或被隱藏時顯示佔位畫面並說明原因。只用正式元件與 CSS，依 [UI 對齊規則](../docs/zh-TW/testing.md#測試-ui-與-app-保持一致)。
- [ ] **量測與文件。** 用 `measure:cpu` 量 Studio 在各幀率與「關閉」時只是看著的成本，以及「省電」下操作中的成本；錄一段有相機的影片並切換來源，確認檔案是合成畫面。更新 [recording](../docs/system-design/recording.md)、[decisions](../docs/system-design/decisions.md) 與 [tooling](../docs/system-design/tooling.md) 預算中 Studio 的段落，以及翻譯。

## 門檻與完成條件

每個幀率實際顯示的張數符合所選（以頁面的 drawn 計數量）；「省電」在操作後一個 tick 內升到 10、停止操作 3 秒後回到 5；「關閉」時不合成、不編碼、不繪製，音量表照常。每個來源的畫面符合 D3，「相機」的比例與圓角和合成的泡泡一致，切換來源從不改變錄出的檔案。量到的成本連同 D2 的接受一起記錄；改幀率或來源從不讓錄影失敗或卡住。

## 驗證

每個步驟的 focused 測試（Studio 與設定的 `pnpm test:scope`，tick 與參數的 Rust 測試）；port 與引擎的改動跑 `pnpm check`。在新的簽章 bundle 上、經「好了」交接後做一輪桌面測試：`pnpm acceptance:studio`、最後一步的 CPU 案例、一段有相機的錄影以 `pnpm verify` 檢查，並以肉眼確認「相機」的形狀。Windows 只經 CI。

## 執行與結案契約

依[計畫索引](README.zh-TW.md)處理順序、決定點、桌面交接與結案；保留 capture process 的故障隔離，以及預覽失敗不讓錄影失敗。開始執行時先看當時的程式碼與在它之前執行的計畫的結案紀錄（特別是 084，若它改了 port）。
