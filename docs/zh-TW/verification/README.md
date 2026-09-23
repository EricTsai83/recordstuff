# 本機驗證與量測紀錄

[English](../../verification/README.md) | [繁體中文](README.md)

本頁保留原已完成計畫中的驗證結論，與正式 system design 分開維護。2026-09-14 文件整併時沒有重跑錄製，也沒有把本機結果推論到其他機器。原始計畫已移除，逐次變更可由 Git 歷史追溯。

## 環境與證據

已測環境：Apple M1 Pro、macOS 26、Electron 44.3／Chromium 152；外接 1920×1080 與內建 Liquid Retina XDR 3456×2234。安裝產物為 macOS arm64，自簽身分 `recordstuff Dev`。Intel、其他 macOS 版本、Windows、Linux 與另一台 Mac／新帳號未驗；使用者已決定不以這些驗收作為目前發布前置。

原始量測（`pnpm verify`、`pnpm matrix`、`pnpm acceptance`、`pnpm audio:quality` 與 computer-use 驗收報告）寫到 `docs/verification/measurements/`；該目錄已 gitignore，只留在產生它的機器上。本文與 [releases/](releases/) 是對外發布的整理結論。下文提到的歷史原始檔（2026-09-13 到 2026-09-19）在 commit `acc6342` 之前曾被追蹤，仍可從 Git 歷史讀取；舊結果中的 fail／n/a 與錯誤試跑如實保留，不能因後續調整門檻而回寫成當時全過。

## 已取得的結果

| 項目 | 證據／結果 | 解讀限制 |
| --- | --- | --- |
| 1080p30 標準 10 分鐘 | 600.0 秒、569.6 MB、7.92 Mbps、29.30 fps、掉幀 0.39%，Electron 合計 CPU 平均 17%／峰值 21% | 動態測試素材；不代表任意解析度或機器負載 |
| 硬體編碼 | 錄製時出現 VTEncoderXPCService，約 1.4–1.9% CPU，停止後消失 | 本機 H.264 證據 |
| 音畫同步 | 552 對標記，頭 89 ms／尾 93 ms、結尾漂移約 3 ms，音訊−影像時長差 −2 ms | 偵測器約 10 ms 偏差；不同段固有延遲約 45–80 ms |
| 30 fps 品質等級 | 精省／標準／高約 4.4／8.1／14.9 Mbps，接近目標 | 係數保留 0.07／0.13／0.24 |
| 60 fps | 約 57 fps、標準約 31 Mbps、CPU 約 23%，檔案約 223 MB/分 | 未完全達到 fps／位元率門檻；使用者接受後開放 macOS |
| 系統音訊 | 有聲內容 AAC 約 160 kbps；請求 2 聲道後是 dual-mono | 不是 stereo 分離；beep 素材低位元率不可視為完整音質驗證 |
| 播放與殘檔 | QuickTime 可開／拖曳；殺 renderer 後保留 17.64 秒、11.5 MB 的 `.recording.mp4`，404 影格可解碼，Chrome 可播 | 部分檔可播為此例結果，不是通用修復保證 |
| Retina | 安裝版原尺寸 22.55／17.43 秒錄影均 3456×2234；最新段全段可解碼且有聲 | 已修正首片與 getSettings 尺寸問題 |
| 自簽／更新 | DMG 安裝、深度嚴格簽章與內容驗證；同憑證同路徑內容更新後螢幕權限保留，音訊實錄成功 | ad-hoc → 自簽是不同身分，不能混入 A/B 更新結果 |
| 首次螢幕授權 | scoped reset 後使用者看到提示、操作設定與選單重啟，新程序 granted | 沒有證明每個 macOS 首次授權一律需重啟 |
| 首次音訊拒絕 | 使用者確認提示並按不允許，no_audio_track、回 idle、無新增影片 | 明確拒絕證據已補齊 |
| 音訊權限復原 | 同程序啟用並選稍後仍失敗；重啟後 15.34 秒有聲檔可解碼 | 該情境需要重啟 |
| 錄製中撤銷／退出 | OS 結束重開前收尾完整 47.594271 秒 MP4，新程序 needsPermission | 不是強制斷電測試 |
| 最後復原 | `2026-09-14 00-17-33.mp4` 12.653633 秒、45,041,905 bytes，1080p H.264＋48 kHz AAC 雙聲道，全解碼成功；使用者確認可播 | 完成當時的本機結果 |
| 通知 | 使用者看到錯誤與存檔通知，點擊有 Finder 回報與 reveal 日誌。點擊後的前景現由 `pnpm acceptance:notification` 覆蓋（[2026-09-20](#通知點擊後-finder-置前--2026-09-20)） | macOS 26.6 上約 40 次點擊會有一次橫幅按下去但點擊未送達 App；根因未證實；後續 30/30 本機矩陣已獲接受作為計畫結案依據 |
| 通知縮圖 | 2026-09-14 使用者確認整台 Mac 重開機後正常 | 原待確認項目已關閉，具體原因未查明 |
| 全域快捷鍵 | 對無視窗的 `/Applications` 建置執行 `pnpm acceptance`（柔化後的 660 Hz 素材、Chrome app 模式全螢幕）：System Events 送出 ⌘⌥⇧R 後 166 ms 收到、再 96 ms 進入 recording，錄 20 秒存檔，完整性層級通過，48 kHz 雙聲道 RMS −27.1／−27.2 dB，偵測到 20 次閃光與 19 個嗶聲，音畫偏移 79 ms（報告）；Codex computer-use 以同一送鍵路徑完成素材、錄影、verify 與 QuickTime 播放（23:34 執行） | 稀疏素材的音訊碼率只回報；背景播影片的一次執行被嗶聲守門拒絕（0 個嗶聲可與靜音分離），驗收時背景音訊必須關閉；Computer Use 的 `pressKey` 到不了全域快捷鍵，三次非互動執行被 per-app 核准擋下（20:56、20:59、21:20、21:33 fail、根因）；Tray 選單案例與聽感仍未由工具驗證 |

## 已驗安裝產物識別

這是當時產物的指紋，不是未來重新打包後仍可沿用的 checksum，也不是公開下載連結。

| 項目 | 值 |
| --- | --- |
| DMG | `dist/local/recordstuff-0.1.0-arm64-selfsigned.dmg` |
| DMG bytes | 126,081,923 |
| DMG SHA-256 | `a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc` |
| app.asar SHA-256 | `c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274` |
| 公開憑證 SHA-1 | `01B373511530BBF287CA35E54C10A5F017AAD637` |

私鑰仍由開發者持有，不放入 repo／下載檔。驗證當時的影片與 `/tmp` 日誌可能已被清除；此處保留數據，不承諾暫存證據一直存在。當時最後完整程式檢查為 13 個測試檔、211 tests、typecheck／build 通過。新的語言功能需另外通過本次檢查並產生新版安裝包；舊 DMG 不代表已測新語言功能。

## 可重複的驗收方法

工具、指令與目前門檻見 [建置與驗收工具](../system-design/tooling.md)。基本功能回歸可用短錄＋完整解碼，品質／同步改動再跑相關矩陣；`long` 現為 3 分鐘，10 分鐘基準已做過，不因文件整理重跑。只有工具全部適用指標 pass 才稱自動判定通過；n/a、素材限制與使用者接受的偏差都需單列。

本地 DMG 不等於公開下載證據；後續已完成的公開下載／安裝驗證見 [v0.1.0 紀錄](releases/0.1.0.md)。

## 文件與語言功能更新 — 2026-09-14

本次英文正式文件及可保存的英文／繁體中文 App 功能已通過 pnpm check：14 個測試檔、221 tests、typecheck 與 build。涵蓋 placeholder 一致性、舊設定英文預設、保存失敗與並行更新、錄製中切換呈現，以及通知語言與點擊動作。pnpm matrix -- quick --dry-run 的英文輸出正常；文件本機連結與 git diff --check 已檢查，搬移的歷史 Markdown／JSON 與 Git 原檔逐位元相同。

此次未產生新的自簽安裝包、未做新的原生介面錄製驗收或公開發布；這些仍由下載版計畫追蹤。

## 音質自動化測試 — 2026-09-14

新增 `pnpm audio:quality`（[用法與門檻](../system-design/tooling.md#音質迴歸測試)）。`pnpm check` 通過：15 個測試檔、232 個測試、型別檢查與建置，包含實際 FFmpeg AAC／低通／格式／CLI 整合測試。正常 PCM 與 FFmpeg AAC 通過，刻意劣化的素材失敗。新增開頭短暫聲音的迴歸案例保護標記對齊；標記或靜音間隔無效時，不輸出會造成誤判的頻率量測。

完成版 macOS 自動流程透過未修改的程式擷取路徑錄製 16 秒。原始報告 為 **fail**，不是音質通過的基準：48 kHz／雙聲道格式與標記檢查通過，但 1 kHz 聲道分離約 0 dB（要求 ≥30 dB）；左右探測序列的 12 kHz 響應相對各自 1 kHz 為 −20.44／−12.64 dB，16 kHz 為 −74.72／−66.73 dB。其餘增益／殘餘能量失敗也保留在報告。PCM 素材與 FFmpeg AAC 對照組能通過相同頻率檢查。

這證明此機器的「播放 → 系統擷取 → AAC」路徑有高頻流失與雙單聲道現象，與使用者反映聲音悶的情況一致，但尚未定位負責的環節。依序播放音調也可能量到隨時間變化的增益，因此兩個聲道序列的響應差異不代表硬體不對稱。未控制或量測裝置／音量，門檻屬初始工程標準。工具未更改程式音訊設定，也尚未修復音質。素材與擷取紀錄保留在 `/tmp/recordstuff-audio-quality-20260914-final`，MP4 路徑在原始報告中；暫存檔日後可能被清除。本次未產生新安裝檔。

## 音質診斷 v2 穩健性修復 — 2026-09-14

[設計教學](../system-design/audio-quality.md)記錄原因、演算法、門檻與限制。已重現兩個 v1 問題：刪掉每段 600 ms 探測音的前後各 100 ms 仍通過，而只有 10 ppm 時鐘偏差的乾淨訊號卻會在殘差檢查失敗。v2 以各成分的重疊視窗，以及有限頻率估計／最小平方擬合修正這些案例。同時 pilot 正規化也將區段間增益變化與頻率響應分開；結尾標記避免只靠補靜音就冒充完整素材。

`pnpm check` 通過：15 個測試檔、254 個測試，其中 **33 個是音質工具測試**，另包含型別檢查與建置。對照涵蓋獨立相位的 ±10／20／100 ppm、過大時鐘偏差、實際 FFmpeg AAC／低通／格式解碼、邊緣／中央／僅目標音斷音、結尾插入 50 ms、局部削波、無效標記、多次摘要、未完成 batch，以及 CLI 保存與結束碼。文件目標、雙語章節與 `git diff --check` 通過。本次未修改正式音訊處理。

完成三次真實 v2 擷取：**0 次 pass、2 次 fail、1 次 invalid**。摘要維持 invalid。第 1 次標記間隔量得 −22.63 dB，未達素材辨識要求的 −30 dB，因此未輸出缺乏依據的頻譜欄位。第 2／3 次標記有效並保留失敗：1 kHz 聲道分離約 0 dB，16 kHz 相對同時 pilot 的響應，左側為 −46.64 到 −46.48 dB，右側為 −44.14 到 −43.85 dB。另有部分殘差／增益／12 kHz 失敗，詳見第 1 次、第 2 次及第 3 次。

前／後裝置與音量快照相同。這是端點證據，不代表持續控制了整個環境。無效量測不納入各指標範圍，並明確計入缺少數量。這些是失敗證據，不是經校準的通過基準。v1／v2 的素材與估計方式不同，不能把精確 dB 差異當作產品改善前後比較。原本 v1 證據未改寫。暫存素材／log 留在 `/tmp/recordstuff-audio-v2-20260914`，每份報告都有 MP4 路徑。本次未產生新安裝檔。

## 系統音訊處理修正 — 2026-09-14

擷取端現在明確關閉回音消除、降噪與自動增益，保留排除自身聲音與 ideal 立體聲，詳見[設計說明](../system-design/audio-quality.md#15-系統擷取修正2026-09-14)。對照期間沒有改變素材、分析器或門檻。第一輪試驗已恢復高頻響應，但開頭仍有雜訊／聲道分離／間隔失敗。

最終程式的重複量測為 **2 pass、0 fail、1 invalid**，前後裝置與音量快照相同。摘要刻意維持 invalid：第 1 次標記間隔辨識失敗（−18.81 dB）。第 2 次和第 3 次所有門檻都通過。這兩次有效量測的左右 16 kHz 相對同時 pilot 差異在 0.004 dB 內，先前有效基準則約 −44 到 −47 dB；立體聲分離也從約 0 dB 恢復到超過 30 dB 門檻。接近數值下限的極大分離值，代表漏入另一聲道的能量極低，不是經校準的硬體規格。

環境證據：前／後。若請求 false 後音軌明確回報效果仍啟用，程式會留下 warning；沒有回報則維持未知。本次實驗定位的是三個設定一起更改對本機路徑的修正效果，不是每個效果各自的貢獻。既有錄音檔未改動。

修正驗證：`pnpm check` 通過 15 個測試檔／255 個測試、型別檢查與建置。`pnpm start:app` 建置、自簽、驗證九個 bundle 身分後，開啟 `dist/dev/mac-arm64/recordstuff.app` 供聽感比較；未取代 `/Applications` 的副本。文件目標與 `git diff --check` 通過。

## macOS 0.1.0 發行 — 2026-09-15

[本版產物及下載路徑證據](releases/0.1.0.md)。已公開發布，安裝候選版檢查通過但有 Finder 未置前限制；瀏覽器下載後安裝及錄影已通過，首次需「仍要打開」；使用者回報與本機限制見本版紀錄。上方歷史雜湊保留原值。

## 精簡安裝介面與 tag 觸發發布 0.1.2 — 2026-09-19

0.1.2 原始碼從 DMG 移除隨附指南並加入程式產生的箭頭背景；發布閘門現在要求恰為 App 與 Applications 連結。本機 `pnpm dist:mac` 建置通過候選閘門與 Finder 版面檢查；`pnpm start:app` 加手動 16.7 秒錄影通過完整性檢查；可丟棄副本移除後使用者資料未變；推送 `v0.1.2` tag 後不到三分鐘公開，匿名公開下載驗證 job 於 22 秒內通過。見 [0.1.2 證據](releases/0.1.2.md)與[發布自動化](../system-design/releases.md)。verifier 同日改為完整性與效能兩層，見[工具鏈](../system-design/tooling.md#驗收門檻)。

## 通知點擊後 Finder 置前 — 2026-09-20

計畫 014 以新的無人值守檢查 `pnpm acceptance:notification`（[工具鏈](../system-design/tooling.md#通知驗收)）在已安裝的 0.1.2 與 macOS 26.6.2 上重現 v0.1.0 的回報：在新的 TextEdit 視窗在前時透過輔助使用按下「已儲存 …」橫幅，取樣前景 App 3 秒。加了 `did-become-active` 診斷的 App log 給出機制：macOS 在點擊回呼後約 110 ms 才啟動發通知的 App，且只針對登錄在 `/Applications` 的那份；當這個啟動晚於 Finder 的啟動，無視窗的 App 就留在最前面，Finder 在使用者視窗後方選著檔案。同一程序的第一次點擊很少發生。未修正的 0.1.2 在 Finder 關閉狀態點 6 次，2 次 RecordStuff 留在最前面（1756 執行）；同一版本後來的 5 次點擊有 3 次失敗、包含第一次（1818 執行，其中一次是點擊未送達）；診斷版同樣 6 次中 2 次，且每次失敗的 reveal 後 4 ms 就記到 `did-become-active`（1748 執行）。

修法（reveal 後掛 1 秒的一次性 `did-become-active` 監聽，收到就從已是前景的 App 再 reveal 一次，見[桌面](../system-design/desktop.md#tray-與通知)）在本次被裝進 `/Applications`，以 `--full` 的 5 次點擊 × 3 種 Finder 狀態 × 2 種語言判定。30 次預定點擊（含重試共 35 次錄影；1759 執行）中 26 次通過，3 次無法判定（通知中心沒有為該次存檔顯示橫幅），1 次以另一種方式失敗：橫幅按下、App 被啟動，但點擊沒有送達 App（log 沒有 reveal），Finder 根本沒被叫到；未修正版在 1756 執行也出現過一次同樣的未送達點擊。26 次通過中有 13 次 log 記到 `reveal repeated after activation`，也就是 macOS 確實在第一次 reveal 後啟動了 App，第二次 reveal 在約 0.4 秒內把 Finder 放回最前面；沒有任何已送達的點擊以 RecordStuff 留在最前面收場。 每次點擊的檔案選取與前景分開記錄在報告中；英文與繁中橫幅內文皆符合。未涵蓋：tray 選單自己的顯示檔案（輔助使用碰不到 tray，見 016 紀錄）、其他桌面空間、橫幅消失後從通知中心清單點擊；修正後的 bytes 尚未發布。


### 強化後通知腳本實測 — 2026-09-20

以 `pnpm start:app` 建置並簽章目前未提交的程式，在 macOS 26.6.2 arm64 執行預設 `pnpm acceptance:notification -- --install`：退出碼 0，4 次通過、1 次未出現通知（未執行）、無失敗，從首筆 planned 事件到清理完成為 63.555 秒，不需重跑即可結束。另在第二段錄影 starting 時送 SIGINT，訊號後 2.00 秒退出；錄影中送 SIGTERM，1.90 秒退出。兩次取消都正確回傳退出碼 1、停止並存檔、還原 App 與設定。已安裝 app.asar 雜湊與設定檔 bytes 均符合原始快照，八段測試錄影與三份 App 備份皆已刪除；computer use 確認 Finder 沒有殘留視窗。原始證據：`docs/verification/measurements/2026-09-20-notification-live/report.md`（僅本地）。未重測完整六組矩陣、播放／音訊、權限失敗及系統層卡死。未出現通知不算該次點擊通過；本次耗時也不保證能從無回應的 OS 或檔案系統恢復。


### 完整通知矩陣與空白 TextEdit 清理 — 2026-09-20

快速測試後使用者回報的殘留視窗是 TextEdit「打開」面板，不是錄影存檔。舊流程只關閉測試文件、保留空的 TextEdit 程序，再喚起可能重開面板。清理現在會在沒有其他文件時退出 TextEdit，並等待程序消失；有其他文件則保留。

`pnpm acceptance:notification -- --install --full` 在 371.74 秒內完成全部 30 個案例，沒有卡住：**25 通過、1 失敗、4 未執行**，退出碼 1。每個語言／Finder 狀態組都有多次通過。失敗案例為 zh-TW/closed/click 5：橫幅被按下，但 App 沒有 reveal log，RecordStuff 留在前景；根因尚未確認。未出現的通知沒有算通過。程序查詢與 computer-use inventory 均確認 TextEdit 已退出，Finder 沒有視窗；原安裝 app.asar 與設定符合測前快照，30 段錄影與備份均已刪除。`pnpm check` 通過 320 個測試、型別檢查及建置。原始證據：`docs/verification/measurements/2026-09-20-notification-full/report.md`。這證明流程可完成與清理，不代表通知矩陣全數通過。測試不判定視窗所在螢幕；App 錄製主螢幕，且通知點擊發生在停止錄影之後。


### 通知事件與 Accessibility 診斷 — 2026-09-20

補上通知請求、shown、clicked、closed 紀錄並重建後，英文 15 案例 `--full` 於 199.59 秒完成：8 通過、1 前景失敗、6 未執行，退出碼 1。使用者確認期間有操作桌面；該次前景失敗有 shown／clicked／reveal，但 Chrome 變成前景，因此不能認定為產品缺陷。後續兩案例複測均通過。六次未按到通知都有 shown callback，但保存的 Accessibility 搜尋沒有匹配的橫幅節點；其中一次另有視窗索引變動造成的 System Events -1719。問題縮小到通知呈現／存續或 Accessibility 觀察，尚不能證明每次的根因；最後一筆搜尋 timeout 是 5 秒期限，不是另一項 OS 通知錯誤。App／設定已還原、17 段錄影及備份已清除、TextEdit 已退出；321 個測試、型別檢查及建置通過。原始證據：`docs/verification/measurements/2026-09-20-notification-diagnostics/report.md`。

## 儲存通知時序—2026-09-20

Plan 017 開發目標：macOS 26.6.2（25G83）、arm64、Electron 44.3.0；基底 commit `2f1109e53d1033ead10e9866eb7e88cad49fbab9` 加本機修改。capture host 原本已在 `stopped` 前停止 tracks，未發現漏停；新增 renderer `tracksStoppedAt`、主程序收到停止與檔案完成的時間戳。JS track 釋放不代表 OS 通知抑制已解除。

先前完整測試缺少六個橫幅，目前只對有對應證據的案例判定抑制競態。以下為過濾私人內容後的本機時間（UTC+8），檔案 `03-29-21.mp4`：

| 事件 | 時間 |
| --- | --- |
| 請求停止 | 03:29:24.198 |
| Idle／存檔／請求通知 | .216／.217／.217 |
| Electron shown callback | .219 |
| NotificationCenter 螢幕分享 false | .228 |
| DND auxiliary state 清除 | .330 |
| 通知決策 | .330：`resolutionReason: display shared`、`muted by DND suppression: silence`、`canDisplayWhileCenterIsClosed: false` |
| Accessibility | 沒有相符橫幅、沒有 click callback |

先前 17 次停止，螢幕分享 false 到 DND auxiliary clear 相差 101–106 ms。成功對照為 03:28:10：分享 false 在 .520、auxiliary clear 在 .621、決策 .629（`resolutionReason: disabled`），.630 允許顯示。未改系統設定；當時日誌顯示專注模式未啟用、擷取期間抑制有效。舊資料沒有 track-release 時間戳，不能事後重建。

API 查核：[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) 提供來源列舉，[Notification](https://www.electronjs.org/docs/latest/api/notification) 提供通知事件，皆未記載螢幕分享抑制已就緒的訊號。Apple 的 [SCStream stopCapture](https://developer.apple.com/documentation/screencapturekit/scstream/stopcapture(completionhandler:)) 不是 Electron MediaStream 的就緒 API。在這些介面未找到合適的受支援訊號，因此評估 macOS 單次 500 ms 延遲，留出超過實測約 113 ms 存檔到 DND 清除落差的餘裕。這不保證送達、不繞過刻意抑制，不加重試或延長 AX 搜尋。

新擷取與首次退出請求會取消待送通知，退出期間才完成的存檔通知也會略過。寫檔／idle 先完成，再排程；通知例外不會把成功存檔改成失敗。本機證據位於 `measurements/2026-09-20-plan17/`；原生結果如下。


同一份簽章產物連續執行兩輪 `pnpm acceptance:notification -- --install --full --keep-recordings`，**各 15/15 全通過**，fail／not-run 皆為零，沒有重試；從首事件到清理完成分別 226.217 秒、227.824 秒。英文，每種 Finder 關閉／背景／最小化狀態各五次，使用者暫停桌面操作。每個檔案都只有一次請求與 click callback，AX 看見相符橫幅、選取正確檔案且 Finder 在前景。Track stop 到存檔 12–24 ms，通知於存檔後 500–512 ms 請求，DND auxiliary clear 在 track stop 後 107–136 ms。修正後首例：12:04:30.952 track stop、+2 ms 主程序收到、+13 ms 存檔、+17 ms 分享 false、+118 ms DND clear、+516 ms 請求，AX／點擊通過。延遲讓此請求避開實測競態，不代表 OS 的通用上限。

通知待送期間送 SIGTERM，timer 在送達前取消（+159 ms 的 `saved cancelled (shutdown)`），runner 依預期以失敗狀態 1 結束，清理 1.80 秒完成。錄影已存檔，沒有遺留錄製；安裝 app.asar 與設定的 SHA-256 前後一致，測試 TextEdit／Finder 資源及 App 備份完成還原／移除，測試影片保留。另兩次重疊案例在舊通知待送時開始新擷取：舊檔存在、舊通知取消且未請求；新錄影存檔後皆只有一次可點擊橫幅。新通知請求後、點擊前確認文字編輯仍在前景。使用既有 runner 與保留於本機的衍生腳本 `overlap.mts`，未加入產品 hook 或變更系統設定。


同份產物的 `pnpm acceptance` 錄得 10.346 秒、1920×1080 H.264／AAC MP4（standard／source／要求 60 fps）：七個有判定的完整性指標全通過，10 次閃光／9 次嗶聲，48 kHz 雙聲道 RMS −26.8／−27.2 dBFS，沒有解碼錯誤。未判定幀率品質、主觀聽感、聲道分離、音質或長時間同步。原生 QuickTime computer use 確認播放從 0 前進到 4.68 秒，跳到 2.01 秒後繼續前進至 7.58 秒，畫面可見變動中的測試素材。截圖由工具直接觀察，未另存本機圖片。QuickTime 已結束、Finder 只剩桌面，TextEdit 與測試 Chrome 素材程序已清理。原安裝版已還原且待命，新簽章產物留在 `dist/mac-arm64/RecordStuff.app`，36 個測試影片保留於本機。

最終 `pnpm check`：334 個測試、型別檢查與建置通過。Claude Fable 5.1（high、唯讀）完成 review：補上 autorecord 退出與權限狀態取消政策的文件及權限恢復邊界測試，epoch 格式建議因僅屬可讀性而拒絕。簽章建置後沒有執行邏輯變更。本機總報告：`measurements/2026-09-20-plan17/report.md`。

Plan 017 已完成並移除計畫檔；不代表 Plan 014 舊有的點擊未送達案例已解決，也未發布。刻意設定的專注／螢幕分享抑制、其他 OS 版本、純 Tray UI、通知中心歷史點擊及長錄影不在本次結論內。未變更系統通知設定或權限。

### 通知生命週期調查 — 2026-09-20

接續 Plan 014 調查，發現 `AppTray.show()` 未持有由 GC 管理的 Electron `Notification`。現在持有待處理通知直到 click／close／失敗，同步 show 失敗會釋放並記錄，退出時關閉尚未處理的通知。這修正具體的生命週期風險，**不代表已證實歷史點擊未送達的根因**。runner 現在分開判定實際通知文字的 click callback 與本次完整路徑的 reveal 要求，不再只靠 reveal 日誌推論 callback 送達。

`pnpm check` 通過 342 個測試、typecheck 與 build。`pnpm start:app` 在 macOS 26.6.2 arm64、Electron 44.3.0 驗證九個簽章 bundle；來源為 HEAD `13b325d64f68320d2715bf8cd5f7b45cae1957f6` 加本次未提交變更。候選 app.asar SHA-256 為 `23a94f071d47468a57fe1f96c5f85fa7ef2a2749c2d856f4ee33f635b8db2cae`，dist 與暫時安裝副本一致。`pnpm acceptance:notification -- --install --full --languages en,zh-TW --keep-recordings` **30/30 通過**，零失敗／缺少通知、無重試：英文／繁中 × Finder 關閉／背景／最小化，各五次；首個事件到清理完成共 452.8 秒。每例均完成兩秒錄影存檔、匹配 callback／reveal、選中正確檔案，最終 Finder 在前景。審查修正診斷文字後，使用最終 helper 重判全部觀察仍為 30 次通過；該修正未改 App 程式。

runner 已還原原安裝版／語言並重開 App，退出測試 TextEdit，保留全部 30 個錄影。收尾後 computer use 只見 Finder 桌面，沒有測試 Finder 視窗。選單列 App 本身回 `timeoutReached`，由使用者退出後才建置簽章版。本輪是無人值守腳本檢查，不是 computer-use Tray 驗收；未新增播放、音質、其他 Space、通知中心歷史、強制 GC A/B 或 Windows 驗證。沒有終止事件的通知會持有到退出；Windows 逾時／歷史行為不在本次修正內。以上歷史失敗的根因仍未確認；下方結案決定接受此限制。原始本機證據：`docs/verification/measurements/2026-09-20-plan014-lifetime/`（`native/report.md`、`candidate.json`、`final-judgement.json`、檢查／建置／review 日誌）。

**Plan 014 結案 — 2026-09-20：** 維護者接受雙語本機矩陣 30/30 為通過結果，並明確要求計畫收尾。已移除雙語計畫檔，下一個為 Plan 012。歷史失敗與未測項目照實保留，不宣稱已證明根因或未執行的檢查也通過。發布與安裝公開版驗收移交另行要求的發布工作，不再作為本次接受結案的前置；本次沒有發布版本。未來英文發行說明應列入通知生命週期保留，以及退出會關閉本次程序尚未處理的通知。

## 官方網站本機建置 — 2026-09-20

計畫 012 階段 1–3 已在 `website/` 實作，當時僅在本機檢查、尚未部署；後續上線確認見下方結案紀錄。`website/release-manifest.json` 由公開的 v0.1.2 release 產生並線上重新驗證：DMG `RecordStuff-0.1.2-arm64-selfsigned.dmg`、127,314,171 bytes、SHA-256 `2de49bbd552e46934ef4573ca8c8b103e3a0b1334dd12b2022dee1f332f7fc7f`，與 release.json、SHA256SUMS 及 GitHub asset digest 一致。網站單元測試 11/11 通過；`astro check` 0 錯誤（TypeScript 6.0.3）；`pnpm site:build` 產出 4 頁；連結檢查 61 個站內參照、13 個外部 URL 皆無壞連結；根目錄 `pnpm check` 照常通過。1440 px 與 390 px 整頁截圖沒有水平溢出；每頁鍵盤 Tab 順序為 skip link → 品牌 → 導覽 → 主要下載 → 其餘連結，每頁都有 `main` landmark、一個 `h1`、圖片 alt 與外部連結的 `rel="noopener"`。回歸檢查：故意壞掉的 fragment 會讓連結檢查失敗；發行說明連結指向其他 release 的 manifest 會被拒絕；`astro dev` 與 `build:offline` 顯示「not re-verified」頁尾警語而 `pnpm site:build` 不顯示，即使環境繼承了 `SITE_MANIFEST_OFFLINE=1` 亦然。

三種結構（A：T3 Code 頁面組合、B：單頁、C：下載優先）以本機截圖比較，維護者選擇 A。兩輪 Codex GPT-6 Astra review 找到五個中等問題（漏比 `notesUrl`、沒有證據就設定已驗證旗標、目錄路徑繞過 fragment 驗證、`#71717a` 文字對比 4.12:1、繼承的離線變數繞過線上驗證），皆已修正並重新檢查。同日第二輪設計以內嵌動畫 SVG 場景（游標點擊 → 紅色錄影點 → 已儲存通知）取代 PNG 插圖、改用 Geist 並移除區塊小標；`astro check`、建置（4 頁）、連結檢查與單元測試重跑皆通過，並以 puppeteer 在循環的 1.5 s、3.2 s、6.6 s 逐幀驗證動畫。第三輪重新驗證重排時間的九秒循環：0.5 s（只有環）、2.0 s（環內紅點）、4.5 s（通知）、8.0 s（停留），並確認場景捲出畫面時所有動畫暫停（computed `animation-play-state` 切換為 paused 再恢復）。維護者選定 Facet 後，最終十六秒循環在 1.5 s（閒置、無動作）、5.4 s（推近、點擊：實心圓點與 REC）、7.5 s（拉回、錄影中）、9.0 s（指示標註）與 10.0 s（停止點擊後即時通知）重新驗證；建置（含 `/preview/` 三個方向共 8 頁）、連結檢查、`astro check` 與單元測試再次通過。上述本機檢查未做：Lighthouse、真實產品截圖（維護者選擇繪製的場景）、任何 HTTPS／公開存取檢查、透過上線網站下載，以及該下載的 Gatekeeper／仍要打開檢查。這些原列於部署後的階段 4.5；後續結案決定見下方紀錄。

## Plan 012 結案 — 2026-09-20

維護者確認[官網](https://record.ericts.com)已上線且已自行確認，明確要求只做文件收尾、不再追加驗收。匿名 HTTPS 請求回傳 HTTP 200，GitHub About 也已連到正式網址。本次以此確認作為計畫 012 的結案依據，不將上述歷史未測項目改記為逐項驗證通過。收尾期間沒有新增錄影、系統音訊擷取、播放、官網下載 checksum 或乾淨安裝 Gatekeeper 測試。

雙語 README 已補官網、下載頁與 Help 連結；發布指南記錄未來發行說明使用的公開 Help 網址。雙語計畫 012 已移除，下一個為計畫 018。既有本機測試結果、review 發現與驗證限制保留於上方。

最後視覺微調：場景的 Apple 圖示與左側選單整組右移 12 SVG 單位（場景寬 820 px 時約 6 px），保留原有間距，並重新產生社群預覽圖。`pnpm site:check` 通過（12 項測試、Astro 零診斷、4 頁、59 個站內參照與 13 個外部 URL）；`pnpm check` 通過（342 項測試及正式建置）。`pnpm site:screenshots` 的四頁在 320、390、1440 px 均無水平溢出，重新產生的場景圖亦已目視確認。文件連結檢查與 `git diff --check` 通過。

## 更新檢查實作 — 2026-09-20

Plan 018 已在 macOS 26.6.2 arm64 本機實作，以 `45a7cb3540d4ee1b5b484e5549609e28abba3e3b` 加未提交變更為基礎。`pnpm check` 通過 23 個檔案、382 個測試、TypeScript 檢查與正式建置。涵蓋新版／相等／舊版／無效語意版本、feed 缺欄位、架構／平台不符、HTTP／逾時備援、關閉偏好、跨重開的檢查間隔、錄製延後（含保存設定或請求途中開始錄製）、重疊、結束取消及雙語選單狀態。`pnpm site:check` 通過 15 個測試、Astro 診斷、線上 manifest 驗證、建置 feed 與 0.1.2 manifest 完整比對、59 個內部參照及 13 個外部 URL 檢查。

原生驗收受阻：computer use 無法讀取既有 `/Applications/RecordStuff.app`，回傳 `-10005 timeoutReached`。無法確認錄製狀態，因此保留 App 執行，未結束或重建。本次未操作安裝舊版對新版 feed 的瀏覽器開啟、原生錄製延後／離線選單、偏好保存，也未測擷取、音訊、存檔或播放。未部署 feed 或發布 App；Plan 018 保留原生驗收與交付待辦，真正已發布版本升級需有新版本後才能證明。本機 log／報告位於 `docs/verification/measurements/2026-09-20-update-check/`（gitignored）。

另以 Node 直接呼叫 `fetchVersion` 實測線上備援：網站 `/release.json` 回傳 HTTP 404（尚未部署）、GitHub latest 回傳 HTTP 200，檢查器取得 `0.1.2`。這是網路檢查，不代表原生 UI 驗收通過。

Opus 5 第一輪提出五項 findings。F1（Medium，GitHub 請求未明定標頭）拒絕：正式網路函式已實際取得 GitHub HTTP 200，未重現所稱故障。F2（Low/Medium，未來時間戳壓住檢查）與 F3（Low，手動檢查依賴設定寫入）接受並加入回歸測試。F4（Low，部署略過 feed 驗證）接受：檢查器支援 `--dir`，在部署前驗證 Vercel 產物。F5（Low，未驗證端點分支缺測試）接受：獨立程序測試實際端點在已驗證／缺少／無效旗標下的輸出，部署檢查器也拒絕缺失、版本不符與預覽 feed。這些檢查不代表原生 UI 通過。

Opus 5 第二輪確認第一輪判定成立，另提出三項 Low，皆接受：網站隱私清單未交代對外檢查（`website/src/content/site.ts`）；架構總覽及翻譯未更新資料邊界（`docs/system-design/overview.md` 與繁中版）；正式傳輸使用 Node fetch，未採用支援系統代理的 Electron 網路層（`src/main/index.ts`）。文案已交代 feed、備援、關閉選項及手動安裝，App 改為注入 Electron `net.fetch`。最後修正後再次通過 `pnpm check` 的 382 個測試與型別／建置，以及 `pnpm site:check` 的 15 個測試和所有建置／feed／連結檢查。另以暫存 user-data 目錄的獨立 Electron 程序實測最終傳輸：網站 404 → GitHub 200 → 版本 0.1.2，exit 0；沒有存取既有 App 或錄製。所選 API 支援系統代理／PAC，但未使用實際代理環境驗證。已達兩輪 review 上限，最後修正由 Codex 驗證，未送第三輪。CLI 最終訊息僅有摘要，因此完整本機審查紀錄另存 `opus-pass2-full.txt`。

## 更新驗收自動化與人工後續 — 2026-09-20

先前 computer-use 逾時後，維護者已退出 App，並完成人工驗收本機已簽章候選包：目前版本／時間顯示、英文與啟動檢查偏好於重啟後保存、關閉偏好仍能手動檢查、錄製時更新選項停用、Stop／REC 正常、存檔後恢復操作，以及影片畫面／聲音播放正常。另以暫時調低版本且延遲回應的候選包確認：錄製期間隱藏結果，存檔後顯示新版，瀏覽器開啟正確下載頁。以上是維護者回報的原生驗收，並非自動原生點擊。維護者免除真實斷網驗收；公開 feed 部署與已發布版本的升級仍未驗證。

`pnpm acceptance:updates` 已能執行隔離安裝包的 handler／model 整合驗收與真實快捷鍵錄影；前置條件、範圍與退出碼見[工具指南](../system-design/tooling.md#更新功能驗收)。`pnpm check` 通過 24 個檔案的 389 項測試及型別／建置。只測邏輯的執行通過。第一次完整執行正確因音訊素材守門失敗（第一段 10 次閃光、未偵測到提示音；第二段 11／11）；影片解碼與錄製狀態斷言通過，清理保留原有設定。第一段缺少標記的原因未獲證實。維護者確認其他聲音已停止後，完整重跑通過全部 11 組必要檢查，包含退出／清理與原始碼／設定保護。

| 最終真實錄影 | 長度 | 畫面 | 聲音 | 素材標記 | 完整性 |
| --- | --- | --- | --- | --- | --- |
| 第一段 | 10.5895 秒 | 1920×1080 H.264 | 48 kHz 雙聲道 AAC；RMS −27.3／−27.3 dBFS | 10 次閃光／10 次提示音 | 7 項判定通過；完整解碼通過 |
| 第二段 | 10.7727 秒 | 1920×1080 H.264 | 48 kHz 雙聲道 AAC；RMS −26.6／−27.4 dBFS | 11 次閃光／11 次提示音 | 7 項判定通過；完整解碼通過 |

要求設定為 standard／source／30 fps。兩段分別驗證錄製中請求檢查，以及已有請求的結果在下一段錄製中回傳；更新操作停用、Stop 位置與 REC 標題不變，存檔後才顯示結果。這些 UI 斷言檢查實際 handler／model，不檢查原生選單像素。驅動器攔截下載 URL，並以可控傳輸回應取代網路請求，不更改網路連線。主觀播放、保真度、影格時序、長時間同步與實體影音延遲不在判定範圍。測試 App 與素材瀏覽器已退出；真實設定與原始碼入口／package 雜湊不變。未加入正式 App 測試入口，未安裝或發布。

本機證據保留於 `measurements/2026-09-20T13-32-09-101Z-updates-9VF5g4/`（只測邏輯）、`measurements/2026-09-20T13-34-15-543Z-updates-Cw8hBk/`（第一次完整執行失敗）與 `measurements/2026-09-20T13-37-57-101Z-updates-g9HHOz/`（完整通過），包含報告、請求／回應、簽章記錄、影片及 `recording-verify.json`。人工後續紀錄位於 `measurements/2026-09-20-update-manual/`。原始產物由 gitignore 排除，此處摘要保留結果與限制。

### Review 修正與最終重跑

Opus 5 第一輪提出七項，全部接受：連續錄影間的存檔通知遮擋、累積 fixture 錯誤導致錯報 App 仍在執行、缺少失敗時 releases 連結驗證、影格時序／影音偏移未判定、錯誤回應未以原子方式寫入、既存輸出目錄的退出碼不明確，以及逾時取消次數未按案例計算。Fixture 現在攔截存檔通知（通知顯示不在此 runner 範圍）、原子寫入錯誤回應，並允許退出時帶著先前錯誤仍觀察正常退出。Runner 驗證兩種連結、判定同步與影格時序且至少要有五組配對標記、比較取消增量，並以 exit 2 拒絕且保留既存輸出目錄。退出案例會先刻意觸發 fixture 錯誤。新增 CLI 回歸測試曾找出暫時直接引入 production module 與 Node strip-only 模式不相容；已移除該 import，才完成下列通過檢查。

最終 `pnpm check`：24 個檔案的 390 項測試及型別／建置通過。修正後完整重跑通過全部 11 組必要檢查，包含注入錯誤後退出。兩段影片長 10.6661／10.7571 秒，皆為 1920×1080 H.264、48 kHz 雙聲道 AAC、29.28 fps；分別有 11／10 組閃光提示音配對，聲音延遲中位數 60.5／90.6 ms，量測掉幀為零，每段十項媒體判定均通過。未判定長時間漂移、CPU、稀疏素材音訊碼率及主觀保真度。原始碼／設定不變，測試 App 已退出。最終證據：`measurements/2026-09-20T13-55-46-607Z-updates-U7nSds/`；檢查／review 紀錄：`measurements/2026-09-20-update-automation/`。先前證據完整保留。

Opus 5 第二輪確認前七項修正，另提出五項，全部接受：退出末期錯誤可能未檢查、通知攔截缺少接線保護、CLI 回歸測試在目錄防護退化時可能意外啟動驗收、ready／stopped 快照未原子寫入，以及不足三組同步配對被寫成零組。Runner 現在核對最終預期錯誤清單、插樁時驗證正式通知呼叫、目錄測試直接測純檔案 helper 而不啟動 CLI、啟停快照用暫存檔更名，並準確說明同步統計不足。`pnpm check` 再次通過 390 項測試及型別／建置；既存完整錄影證據符合最終退出／媒體斷言。已達兩輪 review 上限，這些最後修改由 Codex 驗證，未送第三輪或再次錄影。完整 review 位於自動化證據目錄的 `opus-pass1-full.txt` 與 `opus-pass2.txt`。

第二輪修正後的最終安裝包邏輯驗收也通過（10 組必要檢查，明確不錄影）：`measurements/2026-09-20T14-04-45-217Z-updates-1js1Dw/report.md`。測試 App 已退出，原始碼／使用者設定不變。

## 公開更新 feed 部署前檢查 — 2026-09-20

`pnpm site:check` 通過：15 項測試、Astro 診斷（39 個檔案，無錯誤／警告）、已發布 0.1.2 manifest 線上驗證、建置 feed 完整比對，以及 59 個內部引用／13 個外部網址。14:18 UTC 對 `https://record.ericts.com/release.json` 的 HTTPS GET 回傳 HTTP 404；正式 feed 交付仍待辦。本次未啟動 App 或測試錄影。

Vercel 唯讀檢查確認既有 `recordstuff` 專案、根目錄 `website` 與已驗證的 `record.ericts.com` 網域。儲存庫 Actions secrets 清單為空。本機 CLI 登入有效；維護者要求只透過 CI/CD 部署後，已移除剛下載的本機專案／環境檔案。未部署、commit、push、建立 tag 或發布版本。維護者將設定儲存庫 Actions secrets `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`，確認 feed 與 workflow 變更已在 main，再手動觸發 `macOS release`，使用既有 tag `v0.1.2` 並啟用 `deploy-website=true`。部署後仍需驗證公開 JSON／內容／快取標頭，以及正式 App 傳輸直接取得 feed 而未走 GitHub 備援，才結束 018。

本次提交前 `pnpm check` 通過 24 個檔案的 395 項測試、型別檢查與正式建置；`git diff --check` 亦通過。未另行執行原生 UI 或錄影驗收。

## 獨立網站 CI/CD — 2026-09-20

網站交付移至 `.github/workflows/website.yml`，由 main 的 push 修改 `website/**` 或該 workflow、在 main 手動重試，以及穩定版本記錄成功後明確呼叫共用 workflow 三種入口執行。移除 `release.yml` 的 `deploy-website` dispatch 選項；重試改用 `gh workflow run website.yml --ref main`。這取代前一節部署前檢查所述的手動 release dispatch 操作。部署仍需 Vercel secrets，缺少設定會印出略過提示。各入口共用正式部署鎖，取得鎖後才讀取最新 main。release 明確呼叫可涵蓋不會觸發 push workflow 的 `GITHUB_TOKEN` 提交。

本機驗證：actionlint 1.7.12 通過兩份 workflow（未啟用 ShellCheck 整合）；`pnpm site:check` 通過 15 項測試、Astro 診斷、0.1.2 manifest 線上驗證、建置 feed 比對及 59 個內部引用／13 個外部網址。文件連結與 `git diff --check` 通過。未執行 GitHub workflow、Vercel 建置／部署、App 啟動或錄影；線上端到端交付仍未驗證，plan 018 維持未結案。

## 網站獨立 CI 依賴修正 — 2026-09-20

首次線上網站檢查回報 47 個 TypeScript 錯誤：獨立網站套件的 tsconfig 指定 Node 型別，卻未宣告 `@types/node`。先前本機檢查可解析根目錄的依賴，因此漏掉這個隔離環境問題。已在網站 devDependencies 加入 `@types/node` 24.13.4，並重新產生網站 pnpm lockfile。

在 repository 外的全新目錄，只複製網站原始碼、不繼承根目錄 node_modules，以 `pnpm install --frozen-lockfile` 安裝後驗證：15 項測試全過，Astro 檢查 39 個檔案無錯誤／警告，經線上驗證的正式建置與已發布 0.1.2 feed 相符，59 個內部引用／13 個外部網址全過。忽略 esbuild build script 的警告仍存在，但未阻擋建置。這是在 macOS 的依賴隔離驗證，尚未重跑 Linux Actions 或 Vercel 部署；未測試 App 或錄影行為。`git diff --check` 通過。

## Vercel 存取診斷 — 2026-09-20

網站 workflow 現在於安裝／建置前檢查憑證與 ID 格式，並讀取團隊、專案 API；只輸出 HTTP 狀態與設定提示，不輸出憑證或回應內容。六種模擬案例通過（成功、團隊／專案 403、404、ID 格式錯誤、token 空白）；同一檢查以本機 CLI 憑證唯讀存取既有專案也通過。這不代表無法讀回的 GitHub secret 有效。Actionlint（未啟用 ShellCheck）與 diff 格式檢查通過。未觸發部署或線上 workflow；CI 專案設定授權失敗仍待核對儲存庫 secrets。

### 專案限定 token 說明修正

Vercel 支援專案限定 token，且明確禁止其讀取團隊／使用者資源（見[官方公告](https://vercel.com/changelog/project-scoped-tokens)）。因此團隊 API 403 不代表 token 無效。診斷已改成只查目標專案及其歸屬／設定。目前固定的 CLI 59.23.2 在 pull 路徑仍未啟用 owner lookup fallback；相符的未結案[上游問題 #17506](https://github.com/vercel/vercel/issues/17506) 記錄了專案讀取成功、團隊讀取失敗導致 `vercel pull` 失敗的情形。移除診斷的團隊閘門不等於修復 CLI 限制；現有 pull／build／deploy 流程可能仍需團隊限定 token 作為替代，沒有證據顯示必須使用 Full Account。專案限定 token 的端到端部署仍未驗證。先前將團隊 403 直接視為 Scope 設錯的說法不夠準確。

## Vercel 原始碼部署 — 2026-09-20

採用 [T3 Code 官網](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml)的原始碼部署方式：Actions 驗證專案存取，再用既有釘版 CLI 59.23.2 執行 `deploy --archive=tgz --prod --yes --scope`，不再執行 `pull`、本機 `vercel build` 或 `--prebuilt`。Vercel 建置命令改為 `pnpm test && pnpm check`，測試、型別、manifest 線上驗證、正式建置、建置 feed 比對及連結檢查都必須通過才上線。觸發條件、部署鎖與 App 發布邊界維持原設計；GitHub 憑證不傳入遠端建置。

本機通過 actionlint 1.7.12（未啟用 ShellCheck）、15 項網站測試、39 個檔案診斷、0.1.2 manifest 線上／建置 feed 驗證、59 個內部引用與 13 個外部網址、文件連結目標及 `git diff --check`。未執行遠端建置／部署、啟動 App 或錄影。這移除了已知有問題的 pull 路徑，但不代表專案限定 token 的完整原始碼部署已驗證；線上驗收與公開 feed 交付仍待完成。先前 prebuilt 部署記錄保留為歷史。

### 直接部署的 scope 修正

首次原始碼部署在查詢專案前因 `User not found (404)` 失敗。CLI 59.23.2 的顯式 `--scope` 路徑要求查詢使用者／團隊，不相容於專案限定 token。已移除 `--scope`，仍以 `VERCEL_ORG_ID` 與 `VERCEL_PROJECT_ID` 指定目標。使用實際釘版 CLI 與本機 HTTP 模擬伺服器重現：有 `--scope` 時使用者 404 立即中止；移除後相同 404 不再阻止 CLI 查詢指定專案。模擬請求全為 GET，未進行真實部署。Actionlint（未啟用 ShellCheck）與 `git diff --check` 通過。這驗證的是啟動路徑修正，不是完整部署成功；前一節含 `--scope` 的指令說明以本修正為準。

## 公開 feed 交付成功 — 2026-09-20

[網站執行 35520447965](https://github.com/EricTsai83/recordstuff/actions/runs/35520447965) 由 `ab4b42201bd4dbe5ab78e4d6e68e5b90f5317256` 成功部署。15:46 UTC 匿名 HTTPS GET `https://record.ericts.com/release.json` 回傳 200、JSON 類型與 `Cache-Control: public, max-age=300, s-maxage=300`。完整 JSON 與已驗證的 0.1.2 manifest 對應欄位一致。以 Node fetch 執行正式 `fetchVersion` 得到 0.1.2，只有一個官網請求，沒有 GitHub 備援。本次未操作已安裝 App／Electron 傳輸或原生選單，未發布 App 或錄影。公開 feed 交付已驗證；結案前仍待已安裝 App 對正式 feed 的最後檢查。前述歷史失敗保留。

## 0.1.3 發布授權 — 2026-09-20

公開 feed 交付成功後，維護者確認本機驗收已完成並要求發布。沿用前述原生／人工與自動錄影證據，不宣稱本次另做正式 feed 原生檢查或公開版升級。發布前 `pnpm check` 通過 24 個檔案的 395 項測試、型別與正式建置。發布準備移除自動發行說明中过時的 Finder 限制並加入官網 Help。本次未停止 App，也未透過 start:app 重建。

## Plan 018 結案 — 2026-09-20

依維護者確認的本機驗收、已驗證公開 feed 交付與成功的 [0.1.3 發布](releases/0.1.3.md)結案。發布 workflow 已完成建置、簽署、公開發布、匿名公開下載重驗、版本記錄與網站部署。正式 feed 已宣告 0.1.3 並符合版本 metadata。先前本機證據與歷史失敗完整保留；不宣稱新增正式 feed 原生檢查或公開版升級測試，限制保留在發布紀錄。完成的雙語計畫已移除並更新索引。

## 設定視窗與待機成本 — 2026-09-21

Tray 選單改為扁平指令清單，所有偏好設定移入單一 sandbox 設定視窗。`pnpm check` 通過 28 個檔案的 425 項測試、型別檢查與正式建置。

`pnpm acceptance:settings` 在真實 Electron 視窗載入已建置的 `out/preload/settings.js` 與 `out/renderer/settings.html`，11 項案例全過：出貨頁面在出貨 CSP 下載入且無 console 錯誤、preload 只暴露 read／choose／onChanged、沙箱頁面拿不到任何 Node API、`?lang` query 讓首次繪製即為正確語言、每個群組畫出一個可用控制項並顯示實際提交值、此平台不可用的選項列出但不可選、被拒絕的快捷鍵顯示註解並以 `aria-describedby` 連結、真實 change 事件以 `("language", "en")` 抵達主程序並讓整個面板換語言重繪、主程序未提交的選擇會回報失敗並顯示實際值。退出碼雙向驗證過：缺建置產物為 2、刻意弄錯斷言為 1、正常為 0。此 fixture 自備 view 與 IPC handler，因此判的是頁面、preload 邊界與 IPC 往返；`settings-model` 與 `SettingsWindow` 由單元測試涵蓋。原本短暫存在、以 `happy-dom` 測同一頁面的單元測試已由這個執行器取代：它跑的是真實瀏覽器引擎而非模擬 DOM，且不需要新增依賴。

待機成本量測對象為 `pnpm start:app` 啟動的打包 App，程序生命週期內未錄製、也未開啟設定視窗。機器無其他負載時的 240 秒視窗內，四個程序合計使用 0.10 秒 CPU，約單核 0.042%（main 0.033%、GPU 0.008%、network 與 renderer 0.000%）；`top` 回報 %CPU 0.0、power 分數 0.0。另外三個較短視窗（含與本機建置重疊者）介於 0.033% 與 0.063% 之間。曾把已驗證後的權限輪詢改為 60 秒，實測與原本 5 秒同為 0.033%，因此已還原：便宜的第一段回到單一 5 秒間隔，與 Cap 事故後的設計一致（見[桌面設計](../system-design/desktop.md#螢幕權限)）。擷取宿主心跳的改動則保留——現在只在 session 進行中運作，而不是第一次錄製後永久執行，同時也避免待機時的卡死變成使用者無從處理的錯誤。

**未驗證。** 未點擊原生 tray、未經由「設定…」項目開啟視窗、未驗證 macOS 上實際的視窗置前行為，也未做任何螢幕或系統音訊擷取。`SettingsWindow.show()` 的 macOS 置前修正與 tray 選單本身仍未由機器驗證；專案的 [computer-use 驗收 skill](../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 已記錄無視窗 App 的 tray 無法自動化，需要互動式執行。

## 通知開關取代原生橋接 — 2026-09-21

Plan 019 最初實作為通往 macOS `UserNotifications` 的 Node-API 橋接（保存在 `wip/019-native-notification-bridge`）：權限狀態機、啟動時引導對話框、設定中的狀態顯示，以及每次建置都編譯 `.node` 的建置與打包管線。審查發現該橋接把失敗方向反了。`AppTray.show` 以一個初值為 `unknown` 的狀態為閘門，因此橋接載入失敗就會丟棄每一則通知 — 而由於該閘門同時擋住 `Notification.show()`，也就一併擋掉 Electron 在該呼叫內部發出的授權請求。兩個現實觸發點確實存在：建置腳本只針對 `process.arch` 編譯，且寫死 `-mmacosx-version-min=13.0`，而 App 並未宣告 `minimumSystemVersion`。受影響的使用者拿到的可用通知會比改動前更少。

Electron 44.3.0 的行為改以檢視實際隨附的 framework 二進位確立 — 這正是計畫第一步要求卻未完成的項目。`Electron Framework` 內含 `requestAuthorizationWithOptions:completionHandler:` 以及 Electron 自己的 log 字串 `Notification authorization granted: `，所以 `Notification.show()` 確實會向 macOS 請求授權。其中不存在 `getNotificationSettingsWithCompletionHandler`，而 `systemPreferences.getMediaAccessStatus` 的型別只接受 `microphone | camera | screen`，因此無從讀取狀態。`setPermissionRequestHandler` 中的 `'notifications'` 是 Chromium 的網頁內容權限，不是 App 本身的權限。這是二進位符號檢查而非原始碼閱讀；Objective-C selector 以字串常量儲存，因此出現與不出現都算相當可靠。

替代方案沿用 Cap（`apps/desktop/src-tauri/src/notifications.rs`）：settings.json 中一個 `notifications` 布林值，預設開啟，寬鬆讀取，使欄位出現之前寫下的檔案不會產生 warning；`AppTray.show` 會最先檢查它；「設定 → 一般」提供開／關與 macOS 的「開啟通知設定…」，說明文字標示「系統設定 → 通知 → RecordStuff」，而非 App 讀不到的狀態。打開開關會送出一則確認通知，那正是 Electron 的授權請求能依使用者自身意願送達的時機，同時也是可重複執行的送達測試。`native/`、`scripts/build-notifications.mjs`、`electron.vite.config.ts` 的編譯掛鉤、`electron-builder.yml` 的 `asarUnpack` 項目、`node-api-headers` 相依與三個主行程模組皆已移除。

`pnpm check` 通過：兩個 project 的 TypeScript 檢查、29 個檔案 445 項測試（新增 8 項 — 設定的預設值／往返／非布林值、tray 關閉時丟棄與啟用確認，以及 settings-model 的四項：已提交的開關、錄製鎖定、說明文字、僅 macOS 的面板操作），以及正式建置。

**未驗證。** 未啟動 App。沒有送出任何通知、沒有觀察到 macOS 授權提示、沒有開啟系統設定面板，也沒有執行任何螢幕或系統音訊擷取。原始回報的版本為何收不到通知（拒絕、忽略或其他原因）仍未重現 — 計畫 019 的第一步仍然開放。「Electron 在 `show()` 內部請求授權」這項結論由二進位符號推得，尚未在已簽章的打包版本上實際觀察。

## Plan 019 部分原生驗收 — 2026-09-23

在 macOS 26.6.2 arm64，以 `pnpm start:app` 建置並啟動乾淨 commit `3986d767baf9fb3a049e2dca7a637f02bcaa4941`（0.1.5）；RecordStuff Dev 自簽的九個 bundle 通過驗證，本次未驗安裝 DMG。`pnpm check` 通過 TypeScript、29 個檔案共 450 項測試與正式建置。

無視窗 App 的 computer-use 操作逾時，維護者手動開啟設定後，原生工具成功操作繁中通知開關，確認關閉警語與恢復開啟；兩次重新開啟都有 Electron `shown` 事件。macOS 既有 RecordStuff 通知權限為開啟。但工具無可用截圖，通知中心只暴露行事曆小工具，因此未獨立確認可見橫幅。

**發現：**「開啟通知設定…」只開到通知總覽，還要再點 RecordStuff，未符合 plan 019 直接進入 RecordStuff 面板的驗收條件。本次未修改程式。選單列錄影控制仍無法操作，瀏覽器也拒絕開啟本機測試素材 URL，未錄影或播放。首次授權、已安裝套件與原始回報仍未驗證。通知已恢復原本開啟，App 保持執行。本機報告：`../../verification/measurements/2026-09-23-plan019-computer-use/report.md`（gitignored）。Plan 019 維持開放。

維護者後續回報：上述請求的手動檢查皆正確（確認橫幅、有聲錄影／存檔／播放、通知點擊與 Finder、關閉通知後仍存檔且無橫幅）。這是使用者回報，並非 computer-use 獨立觀察；未指定首次授權或已安裝套件的測試條件。新增待查現象：開啟通知時 App 畫面似乎短暫閃爍，關閉時正常。靜態檢查發現設定儲存開始、主行程刷新與儲存結束都會重建整個表單，且只有開啟時會送確認通知；這些是調查線索，尚非重現後確定的根因。

### 設定閃爍後續修正 — 2026-09-23

維護者更正觀察：開啟和關閉通知都會讓設定畫面閃爍。renderer 現在於分頁結構不變時，直接更新既有控制項的值、文字與可用狀態，不再於每次儲存和主行程推送時替換整個表單。只有儲存造成的暫時鎖定維持原本亮度；錄製或平台限制造成的停用仍會變淡。確認通知維持原行為。

`pnpm check` 通過（29 個檔案 450 項測試、型別檢查及建置）。獨立 Electron 設定 fixture 通過 21/21 項，其中新增五項涵蓋開關兩方向、延遲儲存與中途推送、DOM 身分／焦點／捲動保留、儲存鎖定亮度及真正停用的樣式。本機證據：`../../verification/measurements/2026-09-23T04-59-30-756Z-settings-acceptance/report.md`。此 fixture 使用建置後的 renderer/preload 與測試 IPC，未驗原生選單列或通知送達。未重建或重啟執行中的已簽章 App；新版打包 App 的實際閃爍觀感仍待確認。

2026-09-23 原生補驗：維護者結束舊版後，以 `pnpm start:app` 重建並驗證新版簽章，renderer/CSS 與已測建置的位元組相符。維護者開啟設定後，由 computer use 完成三輪關閉／開啟，共六次切換；選項與說明文字正確更新，焦點保留，實際視窗截圖中的周圍版面及捲動位置穩定。通知恢復開啟，新版 App 保持執行。離散截圖無法完全排除兩張截圖間的瞬間閃爍；本次未重跑錄影回歸。本機報告：`../../verification/measurements/2026-09-23-settings-flicker-native/report.md`。

## Plan 019 結案 — 2026-09-23

維護者回報所要求的手動通知與錄製檢查皆正確，修正描述為開關兩方向都會閃爍，並在 renderer 修正與回歸測試後要求結案。Plan 019 依此本機驗收依據完成；移除英文與繁中計畫文件，下一項為 020。

證據包含維護者回報的確認橫幅、螢幕／系統音訊錄製／存檔／播放、通知點擊／Finder、關閉通知後仍正常存檔，以及 `pnpm check`（450 項測試）、獨立設定 fixture（21/21）與重新建置的自簽 App 三輪原生關閉／開啟操作。證據來源及本機報告位置保留於前述部分驗收與閃爍後續紀錄。renderer 在值更新時保留控制項，只有儲存造成的鎖定不再變淡。

結案保留可用的「通知總覽 → RecordStuff」操作路徑；原本直接進入專屬面板的要求未實作，歷史發現仍保留。原始下載版本的問題成因未重現；乾淨帳號首次授權及已安裝 DMG 的行為未獲獨立確認；離散截圖也無法證明所有瞬間畫面都無閃爍。這些限制持續記錄，不改寫為通過。本次結案不包含 release、commit、tag 或發布。
