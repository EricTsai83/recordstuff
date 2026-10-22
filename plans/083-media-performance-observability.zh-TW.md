# 083 — 媒體管線量測與預算

[English](083-media-performance-observability.md) | [繁體中文](083-media-performance-observability.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22。硬性相依：無；077 於 2026-10-22 結案後，佇列排在 089 之後。 依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與現況

在更動傳輸或加入編輯器前，讓效能決策可重現。擴充現有量測，不另造 benchmark 系統；已有 `measure:cpu`、`matrix`、`measure:finalization`、預覽統計與鏡頭年齡報告。080 已確認共享 texture 沒有 CPU 收益；081 已找出 Chromium 視窗合成為 Studio 主要成本，本計畫不重開實驗。

## 步驟與責任

- [ ] 盤點引擎、host、Studio port 與 decoder 的指標及時鐘，沿用 session ID 與取樣設施。定義擷取／合成／編碼／寫入、port／解碼／繪製耗時、queue 高水位及丟棄／復原原因。不同程序的時鐘未校準不得相減；繪製完成不等於螢幕實際呈現。
- [ ] 在現有 runner 加入開發用、有界的 counter／histogram 與彙整報告。不逐幀同步寫 log／檔案，不收集畫面、裝置識別或輸入文字。錄影 bytes 不經 renderer；只在相關 session 存活時收集。
- [ ] 用靜態文字、動態畫面與可選的合成鏡頭素材，硬體可用時補一輪真實鏡頭。報告程序樹 CPU、共享編碼服務歸因限制、記憶體峰值／常駐量、預覽 age p50／p95、吞吐量、drop 及停止／存檔耗時。分開 30／60 fps 與 Studio 操作中／旁觀／隱藏案例。沿用 CLI，新參數先實作並記錄才使用。
- [ ] 同一 artifact 相鄰比較 diagnostics 開／關；只有結果依賴漂移時依測試政策做 A/B/A。保存機器、OS、revision／未提交輸入身分、設定、素材版本、溫度／供電條件與原始樣本。結論限於實測工作負載。

## 門檻與完成條件

量候選方案前先固定負載與門檻。沿用 CPU、幀節奏、同步及退出預算；instrumentation 成本不得超出 baseline spread，會干擾時先降取樣。優化須超過實測 spread，且目標相對改善至少 10%，錄影完整性不得退步；不足視為無法定論，不藉此增加架構。

記錄數值化記憶體／queue、延遲 baseline 與 084–088 使用的預算。編輯功能的預算在各計畫量測前屬暫定；新增功能成本與優化收益分開。產出可重用報告 schema 與診斷即可結案，即使沒有值得採用的優化。

## 驗證與失敗處理

純報告／parser：focused fixture 與 `pnpm typecheck`。改 native／runtime instrumentation 或 timer 時，再做 `pnpm check`、新簽章 bundle 的錄影 smoke、媒體驗證／播放及受影響的 `pnpm measure:cpu`／`pnpm matrix` 案例，同一段錄影供多項指標使用。涵蓋缺樣本、中斷報告與清理；不為 parser 跑全 matrix／UI suite。缺鏡頭列為該負載未驗證。結案前移除臨時 probe、保存證據。

## 執行與結案契約

依[系列契約](README.zh-TW.md#glide-參考演進083088)處理證據、門檻、桌面交接及結案。保留 Electron／React、capture-process 故障隔離與預設直接 MP4 流程。開始執行先重讀當時程式碼與前置結案紀錄；路徑／數字是設計目標，不取代當時政策。
