# RecordStuff Roadmap：第一版之後

版本：v1，2026-09-11
第一版的範圍在 `PLAN.md`。這裡是所有被移出第一版的功能、架構升級、備案，以及先前討論過但尚未定案的細節。順序是建議，不是承諾。每一項動手前先寫一頁短計畫，並確認不違反 PLAN.md §1.1 的優先順序。

---

## 第二版候選：讓它每天用得下去

### 1. 錄影庫
- 這會是 app 的第一個視窗，從右鍵選單開啟。此時才引入 renderer、preload bridge 與 React
- 列出資料夾裡的錄影：檔名、時長、大小
- 播放（用 `<video>` 播原檔）、改名、在 Finder / 檔案總管顯示、丟到垃圾桶
- 索引是 app data 裡的 JSON，遺失就從資料夾重建。資料夾才是真相
- 沒有正常收尾的 session 絕不寫進錄影庫

```ts
export interface LibraryBridge {
  list(): Promise<ReadonlyArray<RecordingEntry>>;
  rename(id: string, name: string): Promise<void>;
  trash(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  onChanged(l: (entries: ReadonlyArray<RecordingEntry>) => void): () => void;
}
```

### 2. 快捷鍵與通知加強
- 全域快捷鍵開始 / 停止（預設值要在真機上驗證與常見 app 的衝突）
- 通知加上動作按鈕：顯示 / 播放
- 「登入時啟動」開關（放在右鍵選單）
- 第一版已經是選單列 app、沒有 Dock 圖示；若之後加了視窗（錄影庫、設定），關視窗不等於退出，錄製中自動隱藏視窗

### 3. 錄製中回饋
- 計時器：macOS 直接顯示在選單列圖示旁（`tray.setTitle`），Windows 用 tooltip
- 音量表：capture host 裡的 `AnalyserNode`，每 100 ms 送 `level { rms, peak }`，可丟
- 沒聲音超過 N 秒的提示（loopback 常見的「以為在錄其實無聲」）

### 4. 儲存位置加強
- 第一版已有「更改儲存位置…」。這裡是之後的：最近使用過的位置清單、檔名模板、位置不可用時提示「暫時改用預設位置」的選項（要使用者確認，不自動）

### 5. 當機修復
- 打包 FFmpeg 靜態執行檔（LGPL 版本，發行前檢查編譯選項，spawn 時檢查 hash）
- 啟動時掃描 `*.recording.mp4`，用 `ffmpeg -c copy` 重新封裝成非 fragmented MP4、補 duration，成功改名 `<name>.recovered.mp4` 並在錄影庫標示「已復原」，失敗保留原檔標示「無法修復」
- 正常停止時也跑一次 `-c copy`，讓每個檔案都能拖曳進度條
- 當機注入測試：錄製中隨機殺 capture host / main，斷言事後有可播放的檔案

### 6. 自動更新
- `electron-updater` 靜態 feed，兩個平台同一個 release
- Sidecar 或 FFmpeg 版本內嵌並在啟動時檢查

---

## 第三版候選：錄製選項

### 7. 輸出格式
- 第一版已是 MP4（H.264 + AAC，PLAN.md ADR-3）。若第一版因 Spike 失敗退回 WebM，這裡第一項就是：停止後用 FFmpeg 轉 MP4，或提供「錄完自動轉」開關
- 正常停止後用 `ffmpeg -c copy` 把 fragmented MP4 重封裝成一般 MP4，讓 duration 與拖曳在所有播放器都準
- WebM 輸出選項（給只需要瀏覽器播放、想要更小檔案的人）
- GIF 輸出
- 品質預設：解析度上限、fps、位元率

### 8. 來源選擇
- 選螢幕、視窗、區域。預設仍是主螢幕，選項藏在第二層，不違反「一個按鈕」
- 區域錄製：用 `getDisplayMedia` 錄整個螢幕再由 capture host 裁切，或用 Chromium 的 `cropTo`，里程碑開始前要 spike

### 9. 麥克風
- 可選麥克風軌，混音進同一檔或另存
- macOS 與 Windows 麥克風權限流程
- 回音消除：參考 empy-recorder 用 WebRTC AEC3 AudioWorklet 的做法

### 10. 排除自己的聲音
- 排除本 app 播放的聲音（例如錄影庫預覽）
- macOS 需要 ScreenCaptureKit 的 `excludesCurrentProcessAudio`，Electron 是否暴露要查

---

## 第四版候選：長時間錄製

### 11. 分段與暫停
- 接近檔案大小上限或設定時長時自動分段
- 暫停 / 繼續（`MediaRecorder.pause()`，注意時間軸連續性）
- 低電量與磁碟空間預警，硬碟滿時停止並保留部分檔案

### 12. 系統事件
- 休眠：`powerMonitor 'suspend'` 時優雅停止，喚醒後說明「因電腦休眠而停止錄製」，不嘗試續錄
- 拔螢幕：`screen 'display-removed'` 時若錄的是被移除的螢幕，優雅停止並說明
- 權限在待命時被收回：提示卡 +「開啟系統設定」

---

## 更遠：編輯

### 13. 輕量編輯
- 非破壞式 `EditProject`，clip 用路徑加內容 hash 指向來源檔
- 時間軸：剪頭尾、分割、刪除區段、淡入淡出
- 預覽在 renderer 用 `<video>` 播原檔；輸出交給 main 的 `MediaExportService` 驅動 FFmpeg worker
- UI 絕不自己組 FFmpeg 指令
- 匯入外部影片一起編輯
- 擷取與編輯除了硬碟上的媒體檔之外沒有任何共用

---

## 架構升級：何時做、為什麼

這些不是功能，是當程式碼長到某個程度才值得付的成本。每一項都有明確的觸發條件。

### 14. Effect 與 Effect Schema
- **觸發**：main 裡的非同步流程超過三個彼此有 timeout 與取消關係的地方，或跨程序訊息種類超過 15 種
- **做法**：Effect 只在 main（Service、Scope、Stream、型別化錯誤），Effect Schema 統一 IPC、協定、設定、索引。Renderer 維持普通 React
- **不做的理由**：第一版五個狀態、六種訊息，手寫比框架好讀（PLAN.md §1.1 第二條）

### 15. Monorepo
- **觸發**：出現第二個 app（CLI、瀏覽器擴充）或第一個要獨立測試、零 Electron 依賴的 domain（例如編輯模型）
- **做法**：pnpm workspace，`apps/desktop`、`packages/contracts`、`packages/recording-domain`、`packages/editor-domain`、`packages/ui`。規則：`packages/*` 不 import Electron；React 元件不碰協定型別
- 目前 `src/shared/` 就是未來 `packages/contracts` 的種子

### 16. 完整的 PlatformRecorder 介面
- **觸發**：第 20 項的備案啟動，或要支援 Linux
- **做法**：

```ts
export interface PlatformRecorder {
  readonly capabilities: Effect.Effect<RecordingCapabilities>;
  readonly permission: Effect.Effect<PermissionStatus>;
  readonly requestPermission: Effect.Effect<PermissionStatus>;
  readonly start: (o: NativeStartOptions) => Effect.Effect<NativeSession, RecorderError>;
  readonly stop: (sessionId: string) => Effect.Effect<NativeResult, RecorderError>;
  readonly levels: Stream.Stream<AudioLevel>;
  readonly failures: Stream.Stream<RecorderError>;
}
```

- 實作：`ChromiumRecorder`、`FakeRecorder`（測試與 Linux 開發）、`UnavailableRecorder`、未來的原生 sidecar

### 17. 完整狀態機與錯誤模型
- 狀態加上 `unavailable { reason }`、`requestingPermission`、`recording` 帶 `outputPath` 與 `bytesWritten`、`failed` 帶 `recoverable` 與 `partialPath`
- 錯誤分程序層 / 擷取層 / 檔案層，送到 UI 前轉成 `PublicRecordingError { code, title, message, recovery? }`，復原提示 `openSystemSettings`、`relaunch`、`chooseOutputDirectory`、`retry`、`freeDiskSpace`
- 只有 main 的 `RecordingService` 能改狀態

### 18. 測試深度
- 協定 fixture：encode / decode、未知版本要拒絕
- Capture host：Playwright 驅動隱藏視窗，餵合成 `MediaStream`（canvas + oscillator），斷言 chunk 順序、timeslice、`no_audio_track`
- Main 整合：`tools/fake-capture-host` 講真協定；載入失敗、heartbeat 逾時、當機、延遲回應、chunk 缺口
- 各 OS 端對端：播放已知測試畫面與測試音、錄下、驗證解析度、fps、時長、聲道
- CI：macOS 與 Windows runner 跑所有不需要真實擷取的測試；真實擷取在發版前用檢查表

### 19. 可觀測性
- 結構化 log 帶 component、operation、sessionId、狀態轉移、耗時、錯誤 tag。絕不記錄媒體內容
- 本機指標：開始延遲、停止耗時、chunk 間隔、capture host 異常退出、修復次數、錄製中 CPU 與記憶體
- 可選的當機回報

---

## 備案

### 20. 原生擷取引擎（若 Chromium 路線撞牆）
- **觸發**：畫質、音畫同步、CPU 任一項在真機上無法達到可接受水準，且 Chromium 端沒有可調的參數；或產品需要 60fps、4K、游標特效這類需要每幀原始資料的功能
- **預期差距**（1080p30、硬體 H.264）：CPU 兩到三倍、待命記憶體約一半，幀率上限從約 30fps 解開。抓畫面與編碼用的 OS API 兩條路相同，差距來自 Chromium 管線的中間搬運與時間戳控制權
- **做法**：保留 Electron 外殼，把 capture host 換成 Rust sidecar。Cap（github.com/CapSoftware/Cap）的 `scap-screencapturekit`、`scap-direct3d`、`scap-cpal`、`scap-targets` 是 MIT 授權，可直接引用；編碼接 AVAssetWriter（macOS）與 MediaFoundation（Windows）。Cap 其餘部分是 AGPLv3，不能拿來改
- **不預先做的理由**：需要 Rust 能力，開發時程至少三倍。先用最便宜的路線驗證產品

### 21. Windows loopback keepalive
- WASAPI loopback 在沒有聲音播放時不送資料，音軌時間軸會漂移。Cap 與 OBS 都在被錄的裝置上開一條靜音輸出串流當 keepalive
- Chromium 內部是否已處理要在 PLAN.md §17 第 4 題驗證。若沒有，選項是在 capture host 用 `AudioContext` 持續播放靜音，或在 sidecar 路線處理

### 22. Linux
- UI 可跑，錄製顯示「不支援」並說明
- Electron 在 Linux 的 loopback 依賴 PulseAudio；PipeWire 路線參考 Cap 的 `crates/recording/src/sources/screen_capture/linux.rs`
- 有需求再做

### 23. 為什麼不用 Electron Forge
- Forge 是官方工具、長期維護風險較低，也能做公證與簽章
- 選 electron-builder 的理由：與 electron-vite 配套、`electron-updater` 靜態 feed 兩平台通用、NSIS 選項完整、一個設定檔
- 這是偏好選擇。若哪天 electron-builder 停止維護，換 Forge 要一起換掉 electron-vite 與更新策略

---

## 明確不做

- 相機畫中畫、游標特效、縮放動畫、雲端分享。這些是 Cap / Loom 的地盤
- 多軌專業編輯、即時效果、外掛、協作
- macOS 12 以下
- 虛擬音訊裝置、kernel extension、額外安裝程式

---

## 參考

- Cap：github.com/CapSoftware/Cap，Tauri + Rust 的完整實作，`scap-*` crate 為 MIT
- AudioTee：github.com/makeusabrew/audiotee，Core Audio Taps 的 Swift CLI，純音訊路線的參考
- electron-audio-loopback：github.com/alectrocute/electron-audio-loopback，Electron 39 以前的 loopback 補丁，README 記錄了各版本行為
- Kap：github.com/wulkano/Kap，Electron + Swift CLI 的選單列錄影 app，看 UI 與打包
- Strongly Typed 的比較文：stronglytyped.uk/articles/recording-system-audio-electron-macos-approaches
