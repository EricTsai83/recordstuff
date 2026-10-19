# 081 — 錄影工作室顯示錄影時，頁面本身的成本

[English](081-studio-page-cost.md) | [繁體中文](081-studio-page-cost.zh-TW.md)

狀態：已規劃，尚未開始。建立：2026-10-19，依維護者要求，從 080 的結案而來。優先順序：由維護者排定；一次一個計畫。硬性相依：075 的錄影工作室（已結案，[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-075-結案--2026-10-18)）與 080 的量測（已結案，[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-080-結案--2026-10-19)）。依[計畫索引](README.zh-TW.md)的規則依序執行各步驟。

## 目標與範圍

找出錄影工作室的頁面在顯示錄影或即時預覽時本身花了多少，並把它降下來。080 顯示，預覽的傳輸（640 像素的 H.264 串流與它的解碼器）只佔錄影工作室額外成本的一小部分；大部分是頁面：錄影工作室開著時 main 在工作，雖然影格根本不經過它；renderer；以及 Chromium 的 GPU 程序合成一個每秒變化 10 次的 canvas。成功的標準是：在參考 Mac 上、相機有送出影格時，30 fps 錄影的錄影工作室額外成本落在 D18 的 8 點內，或者對剩下的部分有量測過的說明，以及為什麼降不下來。

不在範圍內：預覽的傳輸（080 量測過共用貼圖，保留串流；[決策](../docs/zh-TW/system-design/decisions.md)）、錄影本身的路徑，以及更大或更快的預覽。

## 目前狀態

- **額外成本。**2026-10-19，相機沒有送出影格時，30 fps 錄影佔一個核心的 10.7%，錄影工作室顯示它時是 24.4%，多 13.6 點；60 fps 多 10.0 點（編碼路徑那次）。075 在相機開啟時量到 8.9 與 11.3 點；超出 D18 8 點的部分已由 D21 接受。
- **花在哪裡（編碼後的預覽，30 fps）。**擷取程序約多 2 點（預覽的合成與編碼器），VTEncoder 約 0.5，設定 renderer 6.2，Chromium 的 GPU 程序 3.5，main 2.2（2.36%，沒有錄影工作室時 0.13%）。影格經 `MessageChannelMain` port 從擷取程序直接到頁面，所以 main 的 2.2 點是錄影工作室要它做的其他事：音量、設定畫面、預覽連結，或 Chromium 為可見視窗所做的工作。
- **一個會變化的 canvas 的成本。**080 在 App 外的 benchmark，一個其他都是空白的視窗每秒收到 10 張共用影格、畫在 640×360 的 canvas 上：相對於收到但不繪製（GPU 程序 1.0 點、renderer 0.85 點），以 CPU 像素重畫 canvas（`putImageData`）約再多 3.5 與 1.6 點；NV12 的 `VideoFrame` 不論以 `drawImage`、WebGL、WebGPU 或 `bitmaprenderer` 繪製，約再多 5–6 與 1.5–1.9 點。CPU 重畫是在共用影格照樣送達時量的；完全沒有共用貼圖的視窗沒有量測。以 `MediaStreamTrackGenerator` 餵給 `<video>` 元素（Chromium 可能把它交給 Core Animation 當 overlay）沒有量測。

## 步驟

### 1. 歸因

- [ ] 保持一次即時預覽（L），另外做一次開著錄影工作室的錄影（S）；剖析 main（`sample`、Electron 的 `contentTracing`）、renderer（React 的 render、音量表與預覽共用的影格時鐘）與 GPU 程序，把各點數歸到具名的工作。再分別在預覽不可見、音量表不可見時重做，分開兩者的份額。
- [ ] 在 benchmark 中比較以 `MediaStreamTrackGenerator` 餵給 `<video>` 的顯示與 canvas；若比較省，再在 App 中量測。

### 2. 決定

- [ ] **D1 要做的修正。**依第 1 步的數字，決定要做的變更與各自預期省下的點數；候選包括錄影工作室開著時 main 重複做的工作、以 `<video>` overlay 取代 canvas、減少或縮小重畫，以及像 OBS 一樣關閉預覽的開關。
- [ ] **D2 閘門。**建議：在參考 Mac 上、相機有送出影格時，30 fps 的 S 比 R 多不超過 8 點，L 在錄影的數字之內，預覽的延遲與流暢度不變。

### 3. 實作、驗證與文件

- [ ] D1 選定的變更，連同它們影響的頁面測試與背景 UI 套件。
- [ ] 在簽署 bundle 上、相機有送出影格時執行 `pnpm measure:cpu -- --camera preview=0 --skip-settings --skip-playback --studio --fps 60`，與 080、075 的數字比較；錄影工作室的原生回合（即時預覽、錄影、預覽畫面與音量表）。
- [ ] 記錄結果：[決策](../docs/zh-TW/system-design/decisions.md)（相機 CPU 預算那一列）、[桌面](../docs/zh-TW/system-design/desktop.md#錄影工作室)、[工具](../docs/zh-TW/system-design/tooling.md#cpu-預算)、驗證紀錄，以及關於相機疊加的學習文章；各附翻譯。

## 完成與驗證邊界

達到 D2 的閘門，或剩下的成本已量測並說明、且維護者接受時完成。renderer 與 main 的變更依[測試規則](../docs/zh-TW/testing.md#依行為選擇測試)，採 CPU 那一列與錄影工作室的頁面測試；桌面回合依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)。撰寫本計畫只需檢查連結、中英對照與 `git diff --check`。
