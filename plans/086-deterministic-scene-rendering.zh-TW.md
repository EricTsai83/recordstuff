# 086 — 確定性畫面模型與共用渲染

[English](086-deterministic-scene-rendering.md) | [繁體中文](086-deterministic-scene-rendering.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22。硬性相依：085 已實作；083 預算及 084 預覽契約。 依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與邊界

預覽與匯出在同一 media time 評估同一編輯。先做 trim、背景／padding 與既有鏡頭 layout 算式，不引入 timeline framework、plugin system 或全面改引擎。純 Rust scene model 由 project revision、有理數媒體時間與輸出尺寸求 render 參數；TypeScript 管 UI，不另做動畫引擎。

## 步驟

- [ ] 定義 time mapping、實體像素／point／normalized layout／輸出像素座標、取整、aspect／crop 與色彩契約。涵蓋非零 track offset、缺 track、向後 seek、來源旋轉；時間到平台邊界前保留整數／有理數，不以 UI frame delta 推進動畫。
- [ ] 建小型 pure module，預覽／匯出共用 deterministic fixture。整合既有 `camera_layout`／WGSL 公式，不複製。scene 不持有擷取時鐘或 OS handle，只抽出真實需要的最小共用邊界。
- [ ] 在量測原型門檻比較既有 Metal／D3D11 adapter 與 wgpu 編輯 compositor。多 pass 編輯器可能值得 wgpu，但不為一致而遷移 live D3D11 capture。量 texture import、格式轉換、copy、GPU 同步及可用平台硬體支援。保留唯一語義 scene／shader source，明列 adapter 差異；接受 packaging、device-loss 與維護成本後才採 backend。
- [ ] 整合最小 production 預覽：暫停時按需渲染，decode／texture cache 有界，seek 具取消／generation。每條 close／error／device-loss 路徑釋放舊 frame、buffer、GPU resource。媒體處理不進 main 或 sandbox renderer，適用時沿用已驗證的編碼預覽傳輸。低解析預覽／全尺寸輸出共用語義，明列 sampling 差異。

## 門檻與驗證

相同 timestamp 順序、隨機、倒序重播，scene 參數在明定 numeric tolerance 內一致。兩個入口比較合成素材的輸出畫面，先訂色彩／縮放 tolerance；不設 UI pixel baseline 或設計值。測 crop、rounding、alpha edge、color range／transfer、高 DPI 文字。device loss 保留素材，可重啟或明確 unavailable，不讓 main 當機。

選 backend 前依 083 固定 1080p30 預覽負載及記憶體預算；參考硬體的播放處理 p95 必須在 33.3 ms frame budget，seek 另訂量測期限。分報 decode／render／transfer。不達門檻就刪原型、記錄決定後才續 087，不永久養兩個 render 實作。

純 scene 跑 focused Rust／Clippy／format；backend／build 與共用引擎整合跑 `pnpm check` 及相關 package 檢查。UI 最終跑 `pnpm acceptance:regression`；真實 GPU／preview 依原生流程。改 live compositor 才需錄影 smoke／CPU／matrix，編輯隔離則列理由省略。Windows CI 合成測試不證明硬體 texture sharing。ownership／lifetime 契約與架構文件完成才結案。

## 執行與結案契約

依[系列契約](README.zh-TW.md#glide-參考演進083088)處理證據、門檻、桌面交接及結案。保留 Electron／React、capture-process 故障隔離與預設直接 MP4 流程。開始執行先重讀當時程式碼與前置結案紀錄；路徑／數字是設計目標，不取代當時政策。
