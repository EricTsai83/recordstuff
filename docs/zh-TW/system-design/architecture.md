# 系統架構

[English](../../system-design/architecture.md) | [繁體中文](architecture.md)

## 程序與責任

應用層分成 main 與隱藏 capture renderer。Electron 自身還會建立 GPU／helper 等程序；「兩層」不是作業系統只會看到兩個 PID。

```mermaid
flowchart LR
    User[使用者] --> Tray[原生 Tray / Menu / Notification]
    subgraph Main[Electron main]
      Tray --> Recorder[Recorder 狀態機]
      Settings[SettingsStore] --> Recorder
      Permission[PermissionWatcher] --> Recorder
      Recorder --> Supervisor[CaptureHost 監督器]
      Recorder --> Writer[FileWriter]
      Recorder --> Log[FileLogger]
      Select[chooseDisplayMedia 選來源]
    end
    Supervisor <-->|MessagePort| Host
    subgraph Renderer[隱藏 sandbox renderer]
      Host[CaptureHost] --> Media[getDisplayMedia / MediaRecorder]
    end
    Select --> Media
    Media -->|編碼後 chunk| Host
    Writer --> Disk[本機 MP4]
```

UI 全在 main，使用原生 Electron API；唯一 HTML 頁面是擷取宿主，沒有 React 或 UI renderer。Renderer 取得 stream、套用品質並編碼；main 選取來源、決定錄製狀態、管理檔案與使用者動作。

## 模組邊界

| 模組 | 擁有的資料／資源 | 不負責的工作 |
| --- | --- | --- |
| `main/index.ts` | App 生命週期、依賴組裝、來源 handler、退出協調 | 不編碼、不自行追加影片 bytes |
| `main/recorder.ts` | 唯一 `RecordingState`、session id、順序與 timeout | 不 import Electron；不接觸 DOM |
| `main/capture-host.ts` | 隱藏 BrowserWindow、main port、ready／heartbeat | 不作檔案成功判定 |
| `renderer/capture-host.ts` | MediaStream、MediaRecorder、序號、Blob 傳送鏈 | 不讀設定檔、不選輸出路徑、不寫檔 |
| `preload/index.ts` | 轉交 main 提供的 MessagePort | 不暴露 Node API |
| `main/file-writer.ts` | 每個錄影 session 的影片 handle、寫入佇列 | 不決定 UI 狀態 |
| `main/settings.ts` | 已提交設定、序列化保存佇列 | 不修改正在錄製的設定快照 |
| `main/tray-model.ts` / `tray.ts` | 純呈現模型／原生圖示與通知 | 不另建錄製狀態機 |
| `main/permission.ts` | 螢幕授權驗證快取與輪詢 timer | 不認定系統音訊已授權 |
| `main/log.ts` | 同步寫入與輪替的文字 log | 不保存媒體 bytes |
| `shared/i18n.ts` | 英文文案 key、繁體中文模板、語言驗證 | 不控制 OS 原生提示或翻譯技術日誌 |
| `shared/*` | 狀態、訊息與品質型別／純函式 | 不依賴 Electron 或 DOM |

## 信任邊界與 IPC

隱藏視窗使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`；禁止新視窗與導覽，停用 background throttling。打包版載入本機 HTML；開發版可載入 electron-vite URL。

Main 建立 `MessageChannelMain`，透過 `capture-host-port` 將其中一端交給 preload；preload 用 `window.postMessage` 交給頁面。頁面檢查事件來源為自身 window 與固定標記，取得 port 後送 `ready`。Port 本身被 transfer，媒體 `ArrayBuffer` 用 structured clone 複製。

雙方在接收處執行 type guard。驗證是必要欄位的形狀檢查，不是嚴格拒絕所有額外欄位或完整資源配額限制。協定沒有版本協商，因為 main／preload／renderer 隨同一 App 一起更新。

| 方向 | 訊息 | 意義 |
| --- | --- | --- |
| main → host | `start { sessionId, quality }` | 本次不可變的品質快照 |
| main → host | `stop { sessionId }` | 停止或取消仍在等待的擷取 |
| main → host | `ping` | 確認 renderer 事件迴圈仍回應 |
| host → main | `ready` / `pong` | 通道就緒／心跳回應 |
| host → main | `started { sessionId, mimeType, capture }` | recorder 已啟動；尚不代表第一片資料已落盤 |
| host → main | `chunk { sessionId, seq, bytes }` | 從 0 起連續序號的編碼資料 |
| host → main | `stopped { sessionId }` | 最後 chunk 已送出；main 才能開始完成檔案 |
| host → main | `error { sessionId?, code, detail }` | 失敗；無 session id 時可作用於 main 當前 session |

沒有逐 chunk ACK 或背壓協定：renderer 序列化 Blob 轉換，FileWriter 序列化磁碟作業，但磁碟持續變慢時佇列可能增長。心跳偵測程序回應，不等於媒體持續到達；目前有首 chunk 期限，沒有錄製期間的每片 watchdog。

## 資料模型與持久化

| 資料 | 所在位置 | 生命週期 |
| --- | --- | --- |
| `RecordingState` | main 記憶體 | App 重啟重設；`lastSavedPath` 不持久化 |
| main `Session` | Recorder 記憶體 | 開始到成功／失敗；包含 writer、品質、nextSeq、timer |
| renderer `Session` | capture host 記憶體 | stream、recorder、seq、chain、stopRequested、finished |
| `settings.json` | `app.getPath('userData')` | 跨重啟保存；現有 App 名稱對應小寫 `recordstuff` |
| `.recording.mp4` | 使用者指定資料夾 | 錄製中的檔案，失敗時可保留 |
| `.mp4` | 同一資料夾 | 正常完成並改名後的檔案 |
| `recordstuff.log` | `app.getPath('logs')` | 5 MiB 輪替、3 個舊檔 |
| 量測 Markdown／JSON | `docs/verification/measurements/` | 開發證據，不隨 App 發行 |

Main 持有影片 handle；設定與 log 模組也會寫自己的檔案，因此「單一 writer」僅指影片資料，不是整個 App 只能有一個檔案 handle。

## 啟動與關閉

Main 先建立 logger、註冊未捕捉錯誤處理並取得 single-instance lock。ready 後隱藏 Dock、載入設定、註冊 display-media handler、組裝 Recorder／host／權限 watcher／Tray、訂閱事件並開始權限輪詢。Capture renderer 延遲到首次錄製才建立，停止後保留供下次使用，故障後重建。

`window-all-closed` 不退出 App。忙碌時 `before-quit` 阻止直接結束，等 `Recorder.shutdown()` 後再次 quit；`will-quit` 停止權限輪詢並銷毀 host 與 Tray。已經 idle 的退出不額外等待 failure cleanup；硬斷電、main 強制終止、阻塞磁碟並不具有完整落盤保證。
