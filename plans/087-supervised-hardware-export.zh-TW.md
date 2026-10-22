# 087 — 受監督、有界的硬體匯出

[English](087-supervised-hardware-export.md) | [繁體中文](087-supervised-hardware-export.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22。硬性相依：085 及 086 backend 門檻通過。 依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與邊界

用 086 scene 將一個固定 project revision 匯出為獨立可播 MP4。第一版只有 085 既有錄影的 trim／styling、H.264／AAC、單一 job。HEVC／ProRes／GIF、指定檔案大小、字幕、語音增強、變速與通用 scheduler 不在此版。不改預設錄影 encoder；FFmpeg runtime 相依須另有決定。

## 步驟

- [ ] 定義窄且有驗證的 job protocol，沿用 utility-process supervision 模式。export worker 與 live capture 分開；main 管 admission、目的檔保留、進度及最後 publication，不接 frame bytes。job 固定 manifest revision／來源身分，autosave 不得改變正在輸出的內容。
- [ ] decode → 共用 scene／render → 硬體編碼 → mux／write，frame／bytes queue 有界且有 backpressure。量測支持才用 IOSurface／Metal，Windows 明確 adapter；零拷貝只描述實測路徑。明確選擇／回報硬體支援及軟體 fallback 政策，不暗中耗無限 CPU。
- [ ] 音畫 trim mapping 一致，處理 codec priming／尾端 padding，保留色彩 metadata／range。以 deterministic 素材驗證頭尾並明訂 frame／sample tolerance。不支援的 media／尺寸明確拒絕，不默默縮圖或丟音訊。
- [ ] exclusive 保留新目的檔、寫擁有的 temporary，encoder flush、finalize 成功與必要 sync 後才發布。取消／crash／磁碟滿不得改 source／project bytes，只刪擁有的可丟輸出；若保留可救 partial，明訂政策。取消／退出有期限、處理 late callback、重試用新 job；不可為匯出終止錄影。
- [ ] 預設串行，錄影／live preview 使用引擎時拒絕或延後 export。整合既有錄影狀態／quit gate，處理 export 中開始錄影的反向競態：先取消／延後 export 再允許 capture。未另量不開 GPU／media-engine 競爭。production UI 雙語提供 progress、cancel、error／retry、未存編輯語義。

## 門檻與驗證

benchmark 前固定 1080p30 素材及品質；目標參考 Mac 至少 real-time export、queue 記憶體不隨長度成長、本機 fixture 的取消完成 p95 ≤2 秒。blocked I/O 另測 supervisor 明訂期限。未達標先優化或記錄範圍決定，不空稱效能提升。分報 decode／render／encoder-wait／write 與品質，不能靠暗降畫質換速度。

合成 decode／render／audio fixture、source checksum、worker 強制結束、GPU 故障、磁碟滿、目的檔碰撞、finalize 時取消都要涵蓋。廣泛 native／process／檔案生命週期跑 `pnpm check`；改 quit 加 lifecycle fixture；最終 UI regression、相關 package 檢查。原生播放確認真實輸出，新錄影 smoke／CPU 驗 admission 與預設路徑不退步；matrix 只跑受影響 subset。Windows CI build／fixture 與硬體 export 未驗證分開。量測、清理、復原及最小使用流程完成才結案。

## 執行與結案契約

依[系列契約](README.zh-TW.md#glide-參考演進083088)處理證據、門檻、桌面交接及結案。保留 Electron／React、capture-process 故障隔離與預設直接 MP4 流程。開始執行先重讀當時程式碼與前置結案紀錄；路徑／數字是設計目標，不取代當時政策。
