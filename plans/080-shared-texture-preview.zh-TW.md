# 080 — macOS 上以共用 GPU 貼圖顯示錄影工作室的預覽

[English](080-shared-texture-preview.md) | [繁體中文](080-shared-texture-preview.zh-TW.md)

狀態：已規劃；尚未開始。建立：2026-10-18，源自 075 步驟 8 的量測；下方設計已於 2026-10-18 獲維護者接受（「接受這個設計」），之後執行。優先順序：由維護者排序；一次一個計畫。硬性相依：075 的預覽與錄影工作室（已結案，[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-075-結案--2026-10-18)），以及本計畫要修訂的 076 D2（[設計決策](../docs/zh-TW/system-design/decisions.md)）。依[計畫索引](README.zh-TW.md)按順序執行步驟。

## 目標與範圍

讓 macOS 上錄影工作室的預覽不必經過編碼與解碼。現在引擎合成 640 像素寬的預覽，用 VideoToolbox 編碼，經 `MessagePort` 送出，工作室再用 WebCodecs 解碼並繪製。改為：合成器的預覽貼圖（一個 IOSurface）以 Mach port 送到 main，main 裡的一小段原生模組把 port 轉回 IOSurface，再由 Electron 實驗性的 `sharedTexture` 模組以 `VideoFrame` 無複製地交給工作室。成功的標準是：工作室開著時比不開多出的 CPU 明顯下降（步驟 2 的門檻）、main 的事件迴圈從不被這個模組卡住，而且任何失敗都退回現在的編碼預覽，不影響錄影。

不在範圍內：Windows，維持編碼預覽（Direct3D 11 的共用 handle 可以不靠原生模組複製到 main，留作之後的選項）；錄影本身的路線，不變；Live preview 之前的鏡頭畫面（`getUserMedia`，不變）；更大或更高幀率的預覽，要等步驟 2 量測後再決定。

## 現況

- **預覽的成本。** 在參考機 M1 Pro、D21 的 10 fps 下，工作室顯示中的錄影（S）在 30 fps 用 24.5%，不開工作室（R）為 15.5%，多 8.9 個百分點；60 fps 為 30.7% 對 19.4%，多 11.3 個百分點；D18 允許 8 個百分點，超出部分由 D21 接受（[075 的紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-075-結案--2026-10-18)）。這段差距包含預覽的編碼器、訊息傳遞、WebCodecs 解碼與工作室的繪製，各自佔多少沒有量過。
- **原生程式在哪裡跑。** 只在錄影用的 `utilityProcess`（076 的 D2）：原生程式當掉只結束那個子程序，main 保留部分檔案並回報失敗。Electron 的 `sharedTexture.importSharedTexture` 只能在 main 使用，而且要 main 自己的 IOSurface 指標，所以在 macOS 上 main 必須呼叫原生程式才能取得它。這就是 D2 要開的例外。
- **兩條通往畫面的路線。** 錄影由原生程式合成，預覽則走 Chromium 的編解碼器；本計畫在 macOS 上拿掉第二條。

## 其他專案的做法

- [ghostty-xterm-bench](https://github.com/mxschmitt/ghostty-xterm-bench)（MIT，研究用，未發布）：終端機在 `utilityProcess` 裡繪製，把每個 IOSurface 做成 Mach send right（`IOSurfaceCreateMachPort`），經由 main 裡 N-API 模組建立的通道（`bootstrap_register`）送出；main 呼叫 `IOSurfaceLookupFromMachPort`、`importSharedTexture`，再把 `VideoFrame` 送到沙箱化的頁面。引擎先送 Mach 訊息、再送 JavaScript 的「frame」訊息，且一次只傳一張，所以 main 接收時訊息已在佇列中（`packages/electron-ghostty/src/addon.c`）。只參考它的架構；若取用程式碼，保留其 MIT 授權聲明。
- Chromium 的 [Mach port rendezvous](https://chromium.googlesource.com/chromium/src.git/+/main/base/apple/mach_port_rendezvous_mac.cc)：瀏覽器程序用 bundle id 加程序編號組成名稱登記（`bootstrap_check_in`），新版在交出 port 之前還會驗證對方程序。
- Electron 的 [shared texture 設計說明](https://github.com/electron/electron/blob/v44.7.0/shell/common/api/shared_texture/README.md)與 `spec/api-shared-texture.spec.ts`：macOS 上 IOSurface 要以 Mach port、透過事先建立的 IPC 送到另一個程序；匯入的貼圖要保留到所有參照都釋放為止。
- OBS 與 Cap 把合成好的貼圖畫進原生視圖，Electron 無法把它放進網頁裡；`sharedTexture` 是 Electron 達成同樣零複製顯示的方式。

## 設計（2026-10-18 接受）

- **A1 只在需要時載入。** main 在 macOS 上第一次有工作室觀看預覽時才載入模組，啟動時與 Windows 上都不載入。載入的模組無法卸載，之後會留在記憶體中，但沒有觀看預覽時它的程式完全不執行。
- **A2 只做最少的事。** 模組只做三件事：建立通道、接收一個 surface、釋放一個 surface。沒有擷取或繪製邏輯；其餘都留在引擎與 TypeScript。
- **A3 永不等待。** 引擎先送 Mach 訊息，再透過現有的 port 送出該格的訊息，並等工作室放開上一張後才送下一張（一次只傳一張）。main 接收時等待時間為 0：佇列中沒有就跳過這一格。模組不需要自己的執行緒。
- **A4 通道。** main 用 bundle id、自己的程序編號與一段隨機字串組成名稱登記（`bootstrap_check_in`，如 Chromium），在步驟 2 於簽章版確認可用；只有在 check-in 被拒時才改用已不建議使用、但 ghostty 採用的 `bootstrap_register`，並記錄原因。每則收到的訊息，其 audit trailer 必須是正在觀看之錄影階段的擷取程序；其他一律丟棄並記錄。
- **A5 生命週期。** main 收到的每個 surface 只有一個擁有者，等 Electron 回報所有參照都已釋放才釋放；引擎的預覽貼圖在其 port 或匯入仍持有時不重複使用。
- **A6 失敗就退回。** 模組載入失敗、通道建立失敗或接收失敗時，該階段的預覽退回現在的編碼串流，記錄一次；錄影永遠不受影響。
- **A7 格式。** 合成器的預覽是 NV12，`importSharedTexture` 接受（`nv12`）；只有 Chromium 顯示 NV12 有誤時，才由同一個 kernel 改出 BGRA。

## 步驟

### 1. 決定剩下的事項

- [ ] **D1 模組的語言。** 建議：Rust 加 napi-rs，獨立 crate（`native/preview-receiver`），沿用引擎已在用的工具鏈，並做成獨立的 `.node`，讓 main 永遠不載入擷取模組。替代方案：如 ghostty 用 C、以 node-gyp 建置，多一套工具鏈。
- [ ] **D2 門檻。** 建議：只有在參考機上 30 fps 時 S 比 R 多出的部分下降至少 2 個百分點，且預覽期間 main 事件迴圈延遲 p99 比現在多不超過 2 ms，才保留這項工作；否則記錄結果並結案，保留編碼預覽。
- [ ] **D3 076 的 D2。** 修訂後的文字：擷取仍在 `utilityProcess`；main 可以載入一個只負責接收預覽 surface 的模組，只在工作室觀看時使用，並有退回機制。

### 2. 原型門檻（macOS，放在開發開關後面）

- [ ] 引擎把每張預覽貼圖匯出為 Mach port，並在該格訊息之前送出；模組（D1）建立通道並接收；main 匯入後把畫面送給工作室；工作室繪製 `VideoFrame` 後關閉它；釋放的通知回傳到引擎。
- [ ] 在簽章版確認：以動態名稱呼叫 `bootstrap_check_in`（A4）、audit trailer 的程序編號，以及 NV12 正確顯示（A7）。
- [ ] 以 `pnpm measure:cpu` 量測（30 與 60 fps 的 S 與 L，對照現在的數字），並量預覽期間 main 的事件迴圈延遲。由維護者依 D2 決定。

### 3. 實作

- [ ] 依設計完成退回機制（A6）、延後載入（A1）、對方檢查（A4）與生命週期（A5）；移除開發開關。
- [ ] 打包：模組建置 arm64 與 x64、從封存檔解出、與 app 一起簽章；檢查 `codesign` 並啟動打包後的 app。
- [ ] 測試：Rust 測試涵蓋等待時間為 0 的接收與被拒的對方（把 port 送給測試自己的程序）；TypeScript 測試涵蓋退回，以及在 Windows 或沒有觀看預覽時從不載入模組；工作室的頁面測試不變。

### 4. 驗證與文件

- [ ] `pnpm check`。在簽章版進行原生回合：工作室開著時的 Live preview 與錄影；預覽中砍掉擷取程序，main 與選單列仍在執行，預覽退回或結束；開關工作室 50 次，main 的記憶體與 IOSurface 數量沒有增加；預覽中睡眠與變更顯示器。以 `pnpm measure:cpu` 量測 CPU。Windows 由 CI 驗證。
- [ ] 記錄結果：[設計決策](../docs/zh-TW/system-design/decisions.md)（D2 的例外、D3）、[桌面](../docs/zh-TW/system-design/desktop.md)（預覽的路線）、[錄影](../docs/zh-TW/system-design/recording.md)（匯出的貼圖）、[工具](../docs/zh-TW/system-design/tooling.md)（模組的建置與簽章）、驗證紀錄，以及屆時若已寫好的鏡頭疊加學習文章；各附翻譯。

## 完成與驗證邊界

步驟 2 的門檻已決定，且若保留則步驟 3、4 完成；或結果已記錄、計畫結案並保留編碼預覽，即為完成。引擎、main 與打包的變更依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)，適用錄影列、CPU 列與打包檢查；桌面回合依[交接確認](../docs/zh-TW/testing.md#測試前確認桌面交接)。撰寫本計畫只需要檢查連結、中英對照與 `git diff --check`。
