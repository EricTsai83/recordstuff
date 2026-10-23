# 084 — 有界預覽傳輸與復原

[English](084-bounded-preview-delivery.md) | [繁體中文](084-bounded-preview-delivery.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22；2026-10-23 修訂：縮小到唯一沒有上限的那一段，改以主動要求 key frame 來復原，寫入具體的起始上限，並移除「不送未改變影格」。硬性相依：083（已結案）、092 與 094（port 最終的訊息與幀率，以及 Studio baseline）。佇列第六個，在 094 之後。依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與現況

Studio 頁面變慢或暫停時，不能讓 capture 程序或 renderer 累積工作；頁面跟上後要很快恢復畫面。預覽 chunk 從引擎經 napi 送到 capture 程序的 JavaScript 執行緒，再經 Studio 的 `MessageChannelMain` port 直接送到頁面，不經過 main（[studio-link.ts](../src/main/settings/studio-link.ts)）。現在有上限與沒有上限的部分：

- **有上限：** native `PreviewGate`（[lib.rs](../native/capture/src/lib.rs)）最多讓兩個 chunk 等 JavaScript 執行緒，丟幀後在下一個 key frame 前什麼都不送（預覽編碼器每秒出一個 key frame）。頁面讓預覽離開視線時會停止預覽（`StudioLink`），081／092 設定其幀率。
- **沒有上限：** JavaScript 執行緒接下 chunk 後 gate 就算它完成，host 把它 post 到 port。`postMessage` 沒有 backpressure，所以頁面停止繪製時（renderer 卡住、長時間 GC、被節流的隱藏視窗），chunk 會先堆在 port，再堆在 decoder 的 `pending` map（[preview-decoder.ts](../src/renderer/lib/preview-decoder.ts)），而它沒有大小上限。083 在頁面跟得上時量到 0 丟幀；慢的頁面是沒測過的情況。

本計畫只為這一段設上限。不取代傳輸方式（080 被否決的原型維持否決）、不改 gate，也不加入一般化的 credit 協定：每次加入都會建立新的 channel，所以舊頁面的 ack 不可能送到新頁面。

## 步驟與責任

- [ ] **先重現並量測。** 一個受控的頁面停滯：讓 Studio 頁面在指定時間內停止繪製的開發開關（要實作並記錄在[工具指南](../docs/zh-TW/system-design/tooling.md)；在那之前不是可執行的命令），絕不凍結 main 或使用者的 App。用它在 094 的 bundle 上，記錄 092 每個幀率下 30 秒停滯期間增長的東西：已 post 但未繪製的 chunk 數與 bytes、decoder 的 `decodeQueueSize` 與 `pending`、capture 程序與 renderer 的記憶體。這是修改前的數據。
- [ ] **回報已繪製；超過上限就停止轉送。** 頁面在同一個 port 上告訴 host 每個已繪製（或已丟棄）chunk 的 timestamp，每繪製一幀最多合併成一則訊息。host 記錄未確認的 chunk 數與 bytes，任一達到上限就停止 post，起始上限為 **3 個 chunk 或 512 KiB**（15 fps 的 1 Mbps 串流每個 delta frame 約 8 KB；key frame 較大），依第一步的數據確認。停止期間 host 丟棄 chunk 並把串流標為等待 key frame，和 gate 的做法一樣。頁面消失（port 關閉、沒有 ack）時停止預覽工作，不阻塞擷取、writer 或停止／存檔；音量表維持自己的訂閱。
- [ ] **主動要求 key frame 來復原，不被動等待。** 未確認數量低於上限時，host 要求引擎在下一個預覽 tick 出 key frame（編碼器本來就支援強制 key frame，092 切換來源時也會用到），而不是等最多一秒。頁面遇到任何間隔、decode 錯誤或 reset 時，立即關閉已解碼的畫面、清空 `pending`，並丟棄 delta 直到收到帶 configuration 的 key frame。不逐幀 reset 或 flush。
- [ ] **為頁面自己的佇列設上限。** `pending` 與 decoder 佇列使用同樣的上限；超過時頁面 reset 並等 key frame，而不是持續增長。畸形或過大的訊息由 port 的 validator 拒絕（只有引擎會送，一個 validator 就夠）；沒有 WebCodecs 或 decoder 無法啟動時，預覽顯示為無法使用。預覽故障絕不讓錄影失敗。

## 門檻與完成條件

在每個幀率下停滯 30 秒期間，未確認的 chunk 數與 bytes 從不超過上限，頁面記憶體的增長不超出 baseline 範圍；恢復後、以及反覆隱藏／重新加入十次後，沒有殘留的未確認項目。恢復後，目前畫面在**目前幀率下兩個預覽 tick 加上 092 Studio baseline 的 decode 與繪製 p95** 內回來，在硬體上量測、並以 fake time 在單元測試中確認，不新增常駐 watchdog。跟得上的頁面與 092 的數據相比沒有新的丟幀（0 missed、0 gate drop），錄影節奏、音畫同步、CPU 與存檔 bytes 都不變。

## 不在範圍內

不送未改變的影格（畫面沒變時不編碼預覽）：092 預設為「關閉」、「省電」只是選項，所以除非使用者開啟預覽，開著不管的 Studio 不花任何成本，083 也量到靜態素材的編碼成本很小；而 suppression 需要由相機動態、layout 編輯與音量表觸發失效判斷，很容易出錯。只有在 092 的選項處理不了、仍有實測的 Studio 成本時才重新考慮。

## 驗證

ack 與上限（host 端使用假 port 與 fake time）、頁面的 reset 與等待 key frame、validator 的 focused 測試（`pnpm test:scope -- studio pipeline-diagnostics`）；host 與協定的變更跑 `pnpm check`。在新的簽章 bundle 上、經「好了」交接後做一輪桌面測試：每個幀率下的停滯開關、`pnpm acceptance:studio`、對照 092 數據的 Studio CPU 案例，以及一段以 `pnpm verify` 檢查的錄影。不跑 matrix：錄影的時序與同步沒有改變。結案時留下修改前後的數據、採用的上限與剩餘限制。

## 執行與結案契約

依[計畫索引](README.zh-TW.md)處理順序、證據、桌面交接與結案；保留 capture 程序的故障隔離、預設直接 MP4 流程，以及預覽故障絕不讓錄影失敗。開始執行先重讀當時程式碼與 092、094 的結案紀錄。
