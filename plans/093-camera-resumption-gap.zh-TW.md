# 093 — 相機恢復訊息寫出實際間隔

[English](093-camera-resumption-gap.md) | [繁體中文](093-camera-resumption-gap.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-23，依維護者要求，從 090 拆出（原本是 090 的 D2），讓一個邏輯修正不必等 090 的相機回合。硬性相依：無；佇列第一個，排在 090 之前。依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下都尚未實作或驗證。

## 目標與現況

相機恢復時，`CameraFeed` 以 `heard_ns` 計算間隔（[camera.rs](../native/capture/src/core/camera.rs)）。還沒送出任何畫面的相機 `heard_ns` 為 0，所以 083 的相機回合記下「the camera delivered frames again after 2478244.7 s」，也就是 host 的開機時間，實際約 2.5 秒（[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-083-結案--2026-10-23)）。這個錯誤自 plan 075 就存在。`judge` 本來就以 `heard_ns.max(since_ns)` 計算靜默，麥克風的 `microphone_resumed` 也從錄影開始計算；只有相機的恢復訊息沒有。

## 步驟與責任

- [ ] 恢復的間隔改以 `heard_ns.max(since_ns)` 計算，與 `judge` 使用同一個參考點，讓從未送出畫面的相機從錄影開始計算。訊息文字與事件形狀不變，只有數字改變。
- [ ] 在 core/camera.rs 與 core/tests.rs 以假時鐘寫單元測試：從一開始就沒有畫面、2.5 秒後恢復的相機回報 2.5 秒；送過畫面、中斷後恢復的相機回報中斷的長度；中斷規則（`CAMERA_SILENT_NS`）不變。

## 門檻與完成條件

兩種情況的恢復訊息都寫出實際間隔；其他相機行為不變，也不碰 090 的開始規則。

## 驗證

`core::` 下的 focused Rust 測試（`pnpm test:scope -- pipeline-diagnostics` 會執行）；引擎變更跑 `pnpm check`。不做桌面回合：這是假時鐘可以完整涵蓋的純計算，硬體上的訊息由 090 的相機回合觀察。Windows 只由 CI 檢查，依 076 的 D8。

## 執行與結案契約

依[計畫索引](README.zh-TW.md)處理順序與結案；維持相機為可選（D12）與 capture 程序的故障隔離。開始執行時先檢查當時的程式與 083 的結案紀錄。
