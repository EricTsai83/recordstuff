# 088 — 可選分離素材錄影與自動縮放

[English](088-editable-capture-and-auto-zoom.md) | [繁體中文](088-editable-capture-and-auto-zoom.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22。硬性相依：085–087 已實作；沿用 083 預算與 084 邊界。 依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與產品門檻

讓未來錄影可錄後編輯游標／zoom 與可選鏡頭位置，一般直接 MP4 仍為預設。先向維護者展示 087 可用的 project／export 流程，以及新增 encoder、磁碟寫入及隱私權限的實測估算；確認 editable mode 的來源／track 範圍後才實作。舊扁平錄影無法還原鏡頭或乾淨畫面。

## 步驟

- [ ] 明確 editable-capture 選項與真實 storage／CPU 估算，既有預設路徑不變。editable mode 捕捉乾淨 screen、可選獨立 camera、獨立 system／mic track，共用 media clock、offset、pause／stop 規則與 loss metadata。沿用 native encoder／mux；先原型量成本再建 UI。不額外編一份方便分享的扁平 MP4，除非預算及產品決定允許；087 負責日後明確匯出。
- [ ] opt-in 的滑鼠位置／click／cursor-shape 存有界分塊 sidecar。記座標轉換、bounds change 以對齊高 DPI／多螢幕；缺事件退化為一般 cursor／無 auto zoom。不記原始鍵盤、typing detection、密碼或 App title。依實測 API 記錄各平台權限、情境中才問；logger 壞了只停 enhancement，不停 screen capture。
- [ ] 擴充 085 transaction／recovery 為多軌：單一 session owner、各軌 size／backlog 上限、整體 disk／backlog 政策、manifest 最後 commit 順序與漸進 recovery metadata。不每次事件重寫成長中的 JSON array。worker death 後保留可救 screen fragment，明列缺 camera／mic 與時間缺口；磁碟滿依既有 outcome 安全終止媒體。optional logger 壞掉不可暗換另一種錄影模式。
- [ ] 在 086 pure scene 由 click 算 zoom target，限制 scale／speed、edge clamp，spring 按時間求值且不依賴 seek／呼叫順序。觀測事件與可編輯 zoom keyframe 分離。production UI 做小型 inspector、手動調整、關閉／reset、有界 undo；不做完整非線性 timeline 或 plugin。cursor／zoom 預覽與輸出共用模型。

## 門檻與驗證

實作前依 083 在同機固定 ceiling。原型暫訂 editable mode：同樣 camera／audio 開啟時，App 總 CPU ≤直接模式 baseline 的 1.5 倍，額外 resident memory ≤256 MiB，queue 不隨錄影長度增長。這是產品預算提案，不是證據或改善宣稱；clean screen／camera／audio／event 的 disk amplification 分報。超限就縮 track／解析度範圍或停於原型決定，不放寬預設錄影預算。

預設模式維持 baseline spread 與既有 cadence／sync；editable 所有軌都須過既有同步／節奏，因多 clock 漂移改變而必跑 long。事件 fixture 涵蓋 pause、旋轉／DPI、支援時的 window move、cursor loss、random seek。驗 chunk 邊界、無鍵盤資料、camera／mic dropout、程序結束復原，再做 import → adjust → export → 原生播放。權限依既有 hands-on 邊界，不自動 reset TCC。

廣泛 capture／storage／UI／lifecycle 需 `pnpm check`、最終 `pnpm acceptance:regression`、新簽章錄影／媒體驗證／播放、相關 capture-settings／Studio／lifecycle、CPU 對照及含 `long` 的 matrix subset。Windows CI 只驗契約／build，硬體未測分列。完成 recovery／format／privacy 文件及雙語 help，保留失敗實驗、移除 probe、更新耐久決策後結案。

## 執行與結案契約

依[系列契約](README.zh-TW.md#glide-參考演進083088)處理證據、門檻、桌面交接及結案。保留 Electron／React、capture-process 故障隔離與預設直接 MP4 流程。開始執行先重讀當時程式碼與前置結案紀錄；路徑／數字是設計目標，不取代當時政策。
