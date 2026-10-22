# 084 — 有界預覽傳輸與復原

[English](084-bounded-preview-delivery.md) | [繁體中文](084-bounded-preview-delivery.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22。硬性相依：083。 依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與現況

Studio 變慢或暫停時，不能累積工作或干擾錄影。native `PreviewGate` 已限制最多兩個 callback 並在丟幀後等 key frame；`StudioLink` 已管理訂閱，081 已做 10／5 fps。只稽核剩餘 host → MessagePort → decoder 邊界，不把已有防護當成缺漏，也不改回 080 否決的傳輸。

## 步驟與責任

- [ ] 用 083 重現 renderer 停滯、decoder 變慢、反覆隱藏／重接；找出真實緩衝位置，定義各邊界的 bytes、幀數、尺寸及 age 上限。包含 native allocation 與傳送中的 message，不只看 `decodeQueueSize` 或 JS map；無法直接量測的部分要明列。
- [ ] 只有缺少邊界時，才加入小型、限定 session／generation 的 credit 或 ack 協定。credit 代表釋放的容量，encoded chunk 有 bytes 上限；重接產生新 generation，重複／過時 ack 不得增加容量。consumer 消失只停預覽，不阻塞擷取、writer 或停止／存檔。媒體不經 main；保留既有頻率與獨立 levels 訂閱。
- [ ] 保持 H.264 相依：不能任丟 delta 後繼續解後面的 delta。丟失／reset／age 超限後等目前 key frame 及 config，立即關閉舊 VideoFrame、清 pending，限制復原時間，不逐幀 reset／flush。定義過大／畸形輸入、timestamp 斷裂、decoder error、無 WebCodecs 的處理；預覽故障顯示 unavailable，錄影繼續。
- [ ] 只有量測支持才在此計畫原型化「不送未改變影格」。鏡頭動態、layout 編輯、seek／config 與 meters 分別觸發更新，保留有界 refresh／復原機制。固定靜態負載達 083 改善門檻、動態／互動的延遲與品質不退步才保留，否則刪原型並記錄。

## 門檻與完成條件

受控 consumer 停滯 30 秒時，預覽 queue bytes／幀數不超過明定上限；恢復與反覆重接後沒有殘留增長。兩個設定的 key-frame interval 加上 decode／draw allowance 內恢復目前畫面；allowance 在動手前依 083 固定。用 fake time 測試、硬體確認，不新增常駐 watchdog。錄影節奏、音畫同步、CPU 預算與保存 bytes 正確；只壞預覽不得讓錄影失敗。協定留在既有模組，不造通用 event bus 或第二套 UI。

## 驗證

focused 協定／decoder／native gate 測試涵蓋邊界、畸形訊息、丟失、舊 generation、關閉與 error。廣泛 host／IPC 變更跑 `pnpm check`；Studio 整合先跑相關 scope，最終依政策跑 `pnpm acceptance:regression`。新簽章錄影 smoke、`pnpm acceptance:studio`、受影響 CPU 案例確認真實擷取、頻率與清理。停滯用受控 fixture，不凍結使用者 App 或阻塞 main；改 timing／sync 才加 matrix。結案留下前後指標、資源 ownership 與限制。

## 執行與結案契約

依[系列契約](README.zh-TW.md#glide-參考演進083088)處理證據、門檻、桌面交接及結案。保留 Electron／React、capture-process 故障隔離與預設直接 MP4 流程。開始執行先重讀當時程式碼與前置結案紀錄；路徑／數字是設計目標，不取代當時政策。
