# 082 — 錄影工作室的第一次點擊與它的量測 runner

[English](082-studio-runner-follow-ups.md) | [繁體中文](082-studio-runner-follow-ups.zh-TW.md)

狀態：已規劃，尚未開始。建立：2026-10-19，依維護者要求，從 081 的結案而來。優先順序：由維護者排定；一次一個計畫。硬性相依：081 為錄影工作室調整頻率的做法（已結案，[紀錄](../docs/zh-TW/verification/history-2026-10.md#plan-081-結案--2026-10-19)）。依[計畫索引](README.zh-TW.md)的規則依序執行各步驟。

## 目標與範圍

081 的量測留下三件事，都不需要維護者動手就能自動完成：一個看起來沒有作用的錄影工作室點擊；一份因為已接受的原因而讓每次 `--studio` 量測都判 FAIL 的 CPU 報告；以及調整頻率的 hover 路徑，目前只有單元測試驗證過。成功的標準是：錄影工作室的控制項依維護者的決定（D1）回應第一次點擊；`measure:cpu --studio` 的報告只在真的有問題時判 FAIL；並以原生方式確認只移動游標就能讓錄影工作室在每秒 5 格與 10 格之間切換。不需要相機：三件事都和相機有沒有送出影格無關。

不在範圍內：錄影工作室的成本（081 已在 D18 之內結案）、略過沒有變化的預覽影格（[決策](../docs/zh-TW/system-design/decisions.md)中的有條件候選項目，要先量測靜止畫面），以及 077 中需要維護者動手的案例。

## 目前狀況

- **第一次按「即時預覽」。**080 與 081 的每次 `measure:cpu --studio` 量測中，runner 第一次按「即時預覽」幾乎每輪都沒有啟動任何東西，15 秒後的重試才成功。App 的 log 裡沒有第一次按的紀錄：沒有任何東西到達按鈕。runner 按下時，主螢幕上全螢幕的素材在最前面，所以設定視窗不是 key window。在 macOS 上，點擊不在前景的視窗會先啟用它，除非 view 接受第一次滑鼠事件（`acceptFirstMouse`，Electron 預設關閉），否則點擊不會傳給頁面。若真是如此，在別的 App 錄影、點旁邊錄影工作室裡的「即時預覽」「停止錄影」或靜音的人，也一樣要點兩次。
- **程序角色檢查。**`measure:cpu` 在最後一次儲存 5 秒後，以「沒有開過錄影工作室的啟動」的規則判斷 R 的程序角色。錄影工作室開過之後，Chromium 的 `utility:video_capture` 與 `utility:audio`（由頁面的 `getUserMedia` 啟動）會留下；[工具](../docs/zh-TW/system-design/tooling.md#cpu-預算)記錄了這點，[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影工作室)也量過它們不耗 CPU，但每份 `--studio` 報告仍因此判 FAIL，讓真正的失敗混在其中。
- **hover 路徑。**`studio-pace.ts` 以頁面根元素的 `pointerenter` 與 `pointerleave` 決定完整頻率。081 只在點擊之後，才在 App 的 log 裡看到完整頻率（L 開始時的 `studio: preview at 10 a second`）；在 macOS 上、只移動游標而不點擊時，Chromium 是否會把 `pointerenter` 送給不在前景的視窗，尚未以原生方式驗證。

## 步驟

### 1. 找出第一次點擊的原因

- [ ] 素材在最前面、錄影工作室在第二個螢幕時，由 runner 點一次錄影工作室的控制項（以 osascript 的滑鼠事件，和 `measure:cpu` 相同），讀 App 的 log 與頁面的事件：這次點擊只是啟用視窗、有到達頁面，還是因為剛開啟的輔助使用樹而遺失。再分別在設定視窗已是 key window、以及點「錄影設定」的控制項時重複，區分視窗啟用與錄影工作室本身的影響。

### 2. 決定

- [ ] **D1 第一次點擊。**依第 1 步的結果：若是視窗啟用吃掉了點擊，建議讓設定視窗接受第一次滑鼠事件（`acceptFirstMouse`），使其他 App 在前景時點擊控制項也會直接作用，如同工具面板或 OBS 的控制項；風險是只想把視窗帶到前面的點擊，會作用在底下的東西上，例如錄影卡片的「刪除」，維護者可以決定只限錄影工作室分頁。否則，採用第 1 步找到的原因與它的修正，修在 App 或 runner。
- [ ] **D2 程序角色規則。**建議：在 `--studio` 量測中，R 的規則允許一個 `utility:video_capture` 與一個 `utility:audio`，其他角色的要求不變，並在報告中註明這項允許；沒有錄影工作室的啟動維持現在的規則。

### 3. 實作、驗證與記錄

- [ ] D1 的修改，頁面能檢查的部分附上單元測試或背景 UI 測試；若原因是視窗啟用，runner 改為只按一次：第一次就成功的量測中，`measure:cpu` 的 L 不再重試，其他情況仍會重試。
- [ ] `measure:cpu` 中 D2 的規則，附上單元測試（`cpu-sampler` 的 `judgeRoles` 或 runner 自己的輔助函式）。
- [ ] hover 檢查：一個 runner 或 `measure:cpu` 的一個步驟，不點擊、只把游標移到錄影工作室上（CGEvent 的滑鼠移動，`native-ax.mts` 目前還沒有提供），等待後移開，從 log 讀到 `studio: preview at 10 a second` 再讀到 `at 5`；缺少任何一個就失敗。在[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)後於簽署的 bundle 上執行一次。
- [ ] 在簽署的 bundle 上跑一次 `pnpm measure:cpu -- --minutes 1 --camera preview=0 --skip-settings --skip-playback --studio`：若 D1 消除了原因，第一次按就不需要重試；程序角色以 D2 的規則判斷；S 與 L 在 081 的數字之內。
- [ ] 記錄結果：D1 寫入[桌面設計](../docs/zh-TW/system-design/desktop.md#錄影工作室)，D2、hover 檢查與 L 的按法寫入[工具](../docs/zh-TW/system-design/tooling.md#cpu-預算)，以及驗證紀錄；每份都附翻譯。

## 完成與驗證範圍

D1 與 D2 都已決定並實作、hover 檢查已在簽署的 bundle 上執行過，且一次 `--studio` 量測除了真正的限制之外都判 PASS 時完成。renderer、main 與 runner 的修改依[測試規則](../docs/zh-TW/testing.md#依行為選擇測試)，採用 `settings-bridge` 與 `tooling` 範圍及錄影工作室的背景 UI 案例；桌面回合依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)。撰寫本計畫只需要檢查連結、中英文一致與 `git diff --check`。
