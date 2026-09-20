# 錄製管線與檔案設計

[English](../../system-design/recording.md) | [繁體中文](recording.md)

實作來源：[Recorder](../../../src/main/recorder.ts)、[renderer CaptureHost](../../../src/renderer/capture-host.ts)、[FileWriter](../../../src/main/file-writer.ts)、[品質函式](../../../src/shared/quality.ts)。

## 狀態與操作

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> needsPermission: 螢幕授權未就緒
    needsPermission --> idle: 授權與來源驗證成功
    idle --> starting: toggle
    starting --> recording: started
    recording --> stopping: stop / 退出
    stopping --> idle: 寫完並改名 / saved
    starting --> idle: failed
    recording --> idle: failed
    stopping --> idle: failed
```

`needsPermission` 帶 `needsRelaunch`；`idle` 可帶 `lastSavedPath` 或 `outputDirUnavailable`；`recording` 帶 ISO `startedAt`。錯誤是 `failed` 事件，沒有持久的 `failed` 狀態。缺權限時點圖示只發 `permissionRequested`；starting／stopping 期間點擊無作用。

## 開始流程

1. `Recorder.start()` 確認 idle、沒有 session，執行 OS preflight；建立 session id、品質快照與 starting 狀態。
2. `ensureWritableDir()` 建立資料夾、實際写入並刪除 probe。不可用就報錯，不換到其他資料夾。
3. 以本地時間 `YYYY-MM-DD HH-mm-ss` 開啟 `.recording.mp4`。`wx` 防止同名暫存檔覆蓋；遇 EEXIST 改試 `-2` 至 `-10`。
4. `CaptureHost.start()` 等待 host ready，送 start。Main 選目前 primary display 對應來源，找不到匹配時退到第一個 source，搭配 `audio: 'loopback'`。
5. Renderer 檢查 MP4 MIME、要求畫面與音訊；沒有音軌或音軌已 ended 就釋放 stream 並回錯誤。
6. 量測影格、套用品質，再檢查所有軌仍存活；建立 MediaRecorder、掛事件、開始並回 started。
7. Main 進 recording；第一片 bytes 必須在首片期限內到達，才清除該 timer。

## 期限與故障隔離

| 保護 | 預設值 | 失敗處理 |
| --- | --- | --- |
| 輸出資料夾／開檔階段 | 8 秒 | output_open_failed；late writer 回來後 abandon |
| host ready | 8 秒 | start 失敗，下次可重建 |
| 來源／系統授權請求 | 120 秒 | capture_start_failed；停止該 session |
| started 後首 chunk | 8 秒 | capture_start_failed，保留已寫入資料 |
| stop 回應 | 10 秒 | stop_timeout |
| 退出等待 | 10 秒，失敗收尾另給最多 3 秒 | 未完成 capture 時盡力 close／保留；已 finalizing 不誤報失敗 |
| 心跳 | session 進行中每 5 秒檢查／送 ping | 檢查時已有 2 次未回 pong 就 teardown、回 unresponsive |

這些是專案的等待上限，不是 OS 標準或精準的全流程耗時保證。磁碟 I/O 不能因此被真正取消。

## 品質與編碼

| 設定 | 實作規則 |
| --- | --- |
| 影像等級 | economy 0.07、standard 0.13、high 0.24 bits / pixel / frame |
| 位元率 | width × height × requested fps × 係數，四捨五入至 100 kbps，限制 1.5–60 Mbps |
| 解析度 | source 不縮放；1080p／1440p／4K 上限按來源方向交換長短邊，不放大，縮小時取偶數 |
| 幀率 | 30／60；目前只有 darwin 開放 60；其他平台有效值為 30，不覆寫使用者檔案 |
| 音訊 | 固定要求 256,000 bps；請求 ideal 2 聲道、restrictOwnAudio true；echoCancellation／noiseSuppression／autoGainControl false |
| 格式 | `video/mp4;codecs=avc1,mp4a.40.2`；不支援時失敗，不偷偷切 WebM |
| 分片 | timeslice 與 `videoKeyFrameIntervalDuration` 均設 1000 ms；實際出片不保證一秒 |

`measureFrameSize()` 用 muted video 的 intrinsic size，預設等最多 3 秒。因多螢幕曾出現 `getSettings()` 錯報高度，以實際影格優先；量不到才用 track 設定。套限制時重新附上幀率，並等最多 1.5 秒再量。約束被拒絕就保留來源尺寸並警告；無法重測時暫以目標尺寸回報並警告；完全沒有尺寸則以 1920×1080 計算編碼目標，不假稱量到尺寸。

系統音訊明確要求關閉語音處理：本機基準曾量到高頻失衡與聲道混合，同時關閉 EC／NS／AGC 後，v2 探測恢復正常；排除自身聲音仍啟用。這些是要求，不是所有平台的保證。若音軌明確回報任一效果仍為 true，會加入 warning；未回報維持未知。詳見[音質設計的修正對照](audio-quality.md#15-系統擷取修正2026-09-14)。

`CaptureReport` 包含可知的 width／height／frameRate／sampleRate／channelCount、目標位元率與 warnings。未知值不填；這是啟動時的觀察與要求，成品仍需 ffprobe 量測。只有要求 60 且 track 明確回報 ≤30 時發降級通知，靜態畫面少產生影格不當成這種降級。

## 分片與停止順序

```mermaid
sequenceDiagram
    participant U as 使用者
    participant R as Recorder
    participant H as Renderer host
    participant W as FileWriter
    U->>R: toggle 開始
    R->>W: open .recording.mp4
    R->>H: start(id, quality)
    H-->>R: started(capture)
    loop 每個非空片段
      H-->>R: chunk(id, seq, bytes)
      R->>W: append(bytes)
    end
    U->>R: toggle 停止
    R->>H: stop(id)
    H-->>R: 最後 chunk
    H-->>R: stopped(id)
    R->>W: 等佇列、sync、close、rename
    W-->>R: finalPath
    R-->>U: idle + saved 通知
```

Renderer 把 Blob 轉 ArrayBuffer 的 Promise 串成 chain，避免非同步轉換使順序顛倒；忽略空 Blob。Main 檢查 session id 與連續 seq，錯序就失敗。過期 session 的 started／chunk 會觸發 stop，避免超時後仍暗中擷取。

停止 pending start 會從 pending 移至 cancelled；OS 請求回來後釋放 stream。正常 stop 令 MediaRecorder flush 最後 dataavailable；`finish()` 一次性等待傳送 chain 完成後才送 stopped。來源自行 ended 或 recorder error 回 failed，不當成正常 stop。

## 寫檔與失敗

FileWriter 的 append、週期 sync 與 finish 都排在同一佇列。每 5 秒嘗試 fsync；首次 I/O 錯誤被記住，之後佇列作業回同一錯誤。ENOSPC 映射為 disk_full，其他寫入錯誤為 output_write_failed。

成功 finish 等待佇列、sync、close，才把暫存檔 rename 成 `.mp4`，之後 Recorder 發 saved。失敗時先清除 session、stop host、立刻回 idle，再 abandon writer；已有計數 bytes 就保留 `.recording.mp4`，零 bytes 盡力刪除。部分檔案沒有自動修復或重新封裝；曾實測可播不代表所有中斷都可復原。

目前獨占檢查針對 `.recording.mp4`；final `.mp4` 名稱與 partial write handling 的所有邊界並未在此聲稱完全保證。沒有磁碟空間預留、無限長錄製承諾或有界背壓。更完整的耐久性需求應先建測試，再改實作。

## 錯誤分類

| 類型 | code | 對使用者的結果 |
| --- | --- | --- |
| 權限／環境 | permission_denied、permission_needs_relaunch、unsupported_os_version | 引導系統設定／重啟或說明版本 |
| 來源／編碼 | no_display、no_audio_track、mp4_unsupported | 不開始錄製，說明缺少能力 |
| 擷取 | capture_start_failed、capture_failed、capture_host_crashed、capture_host_unresponsive | 回 idle；有部分檔則提供位置 |
| 檔案 | output_open_failed、output_write_failed、disk_full | 說明位置／磁碟問題，盡力保留 bytes |
| 停止 | stop_timeout | 停止等待擷取回覆並盡力保留部分檔 |

Main 的來源 handler 可記錄具體拒絕原因，取代 renderer 的泛用 AbortError；只覆寫可由來源拒絕解釋的錯誤。`permission_needs_relaunch` 是協定支援碼，常態授權引導主要由 PermissionWatcher 狀態處理。
