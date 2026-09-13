# 本機驗證與量測紀錄

[English](../../verification/README.md) | [繁體中文](README.md)

本頁保留原已完成計畫中的驗證結論，與正式 system design 分開維護。2026-09-14 文件整併時沒有重跑錄製，也沒有把本機結果推論到其他機器。原始計畫已移除，逐次變更可由 Git 歷史追溯。

## 環境與證據

已測環境：Apple M1 Pro、macOS 26、Electron 44.3／Chromium 152；外接 1920×1080 與內建 Liquid Retina XDR 3456×2234。安裝產物為 macOS arm64，自簽身分 `RecordStuff Dev`、bundle id `com.recordstuff.app`。Intel、其他 macOS 版本、Windows、Linux 與另一台 Mac／新帳號未驗；使用者已決定不以這些驗收作為目前發布前置。

原始量測：[2026-09-13 Markdown](../../verification/measurements/2026-09-13.md)、[JSON](../../verification/measurements/2026-09-13.json)。舊結果中的 fail／n/a 與錯誤試跑如實保留，不能因後續調整門檻而回寫成當時全過。

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
| 通知 | 使用者看到錯誤與存檔通知，點擊有 Finder 回報與 reveal 日誌 | Finder 每次置頂仍不保證 |
| 通知縮圖 | 2026-09-14 使用者確認整台 Mac 重開機後正常 | 原待確認項目已關閉，具體原因未查明 |

## 已驗安裝產物識別

這是當時產物的指紋，不是未來重新打包後仍可沿用的 checksum，也不是公開下載連結。

| 項目 | 值 |
| --- | --- |
| DMG | `dist/local/RecordStuff-0.1.0-arm64-selfsigned.dmg` |
| DMG bytes | 126,081,923 |
| DMG SHA-256 | `a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc` |
| app.asar SHA-256 | `c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274` |
| 公開憑證 SHA-1 | `01B373511530BBF287CA35E54C10A5F017AAD637` |

私鑰仍由開發者持有，不放入 repo／下載檔。驗證當時的影片與 `/tmp` 日誌可能已被清除；此處保留數據，不承諾暫存證據一直存在。當時最後完整程式檢查為 13 個測試檔、211 tests、typecheck／build 通過。新的語言功能需另外通過本次檢查並產生新版安裝包；舊 DMG 不代表已測新語言功能。

## 可重複的驗收方法

工具、指令與目前門檻見 [建置與驗收工具](../system-design/tooling.md)。基本功能回歸可用短錄＋完整解碼，品質／同步改動再跑相關矩陣；`long` 現為 3 分鐘，10 分鐘基準已做過，不因文件整理重跑。只有工具全部適用指標 pass 才稱自動判定通過；n/a、素材限制與使用者接受的偏差都需單列。

可下載交付仍由 [唯一待執行計畫](../plans/010-downloadable-macos-release.md) 追蹤；本地 DMG 存在不等於已有對外下載或已驗真實下載路徑。

## 文件與語言功能更新 — 2026-09-14

本次英文正式文件及可保存的英文／繁體中文 App 功能已通過 pnpm check：14 個測試檔、221 tests、typecheck 與 build。涵蓋 placeholder 一致性、舊設定英文預設、保存失敗與並行更新、錄製中切換呈現，以及通知語言與點擊動作。pnpm matrix -- quick --dry-run 的英文輸出正常；文件本機連結與 git diff --check 已檢查，搬移的歷史 Markdown／JSON 與 Git 原檔逐位元相同。

此次未產生新的自簽安裝包、未做新的原生介面錄製驗收或公開發布；這些仍由下載版計畫追蹤。

## 音質自動化測試 — 2026-09-14

新增 `pnpm audio:quality`（[用法與門檻](../system-design/tooling.md#音質迴歸測試)）。`pnpm check` 通過：15 個測試檔、232 個測試、型別檢查與建置，包含實際 FFmpeg AAC／低通／格式／CLI 整合測試。正常 PCM 與 FFmpeg AAC 通過，刻意劣化的素材失敗。新增開頭短暫聲音的迴歸案例保護標記對齊；標記或靜音間隔無效時，不輸出會造成誤判的頻率量測。

完成版 macOS 自動流程透過未修改的程式擷取路徑錄製 16 秒。[原始報告](../../verification/measurements/2026-09-14-audio-quality.json) 為 **fail**，不是音質通過的基準：48 kHz／雙聲道格式與標記檢查通過，但 1 kHz 聲道分離約 0 dB（要求 ≥30 dB）；左右探測序列的 12 kHz 響應相對各自 1 kHz 為 −20.44／−12.64 dB，16 kHz 為 −74.72／−66.73 dB。其餘增益／殘餘能量失敗也保留在報告。PCM 素材與 FFmpeg AAC 對照組能通過相同頻率檢查。

這證明此機器的「播放 → 系統擷取 → AAC」路徑有高頻流失與雙單聲道現象，與使用者反映聲音悶的情況一致，但尚未定位負責的環節。依序播放音調也可能量到隨時間變化的增益，因此兩個聲道序列的響應差異不代表硬體不對稱。未控制或量測裝置／音量，門檻屬初始工程標準。工具未更改程式音訊設定，也尚未修復音質。素材與擷取紀錄保留在 `/tmp/recordstuff-audio-quality-20260914-final`，MP4 路徑在原始報告中；暫存檔日後可能被清除。本次未產生新安裝檔。

## 音質診斷 v2 穩健性修復 — 2026-09-14

[設計教學](../system-design/audio-quality.md)記錄原因、演算法、門檻與限制。已重現兩個 v1 問題：刪掉每段 600 ms 探測音的前後各 100 ms 仍通過，而只有 10 ppm 時鐘偏差的乾淨訊號卻會在殘差檢查失敗。v2 以各成分的重疊視窗，以及有限頻率估計／最小平方擬合修正這些案例。同時 pilot 正規化也將區段間增益變化與頻率響應分開；結尾標記避免只靠補靜音就冒充完整素材。

`pnpm check` 通過：15 個測試檔、254 個測試，其中 **33 個是音質工具測試**，另包含型別檢查與建置。對照涵蓋獨立相位的 ±10／20／100 ppm、過大時鐘偏差、實際 FFmpeg AAC／低通／格式解碼、邊緣／中央／僅目標音斷音、結尾插入 50 ms、局部削波、無效標記、多次摘要、未完成 batch，以及 CLI 保存與結束碼。文件目標、雙語章節與 `git diff --check` 通過。本次未修改正式音訊處理。

完成三次真實 v2 擷取：**0 次 pass、2 次 fail、1 次 invalid**。[摘要](../../verification/measurements/2026-09-14-audio-v2/summary.json)維持 invalid。第 1 次標記間隔量得 −22.63 dB，未達素材辨識要求的 −30 dB，因此未輸出缺乏依據的頻譜欄位。第 2／3 次標記有效並保留失敗：1 kHz 聲道分離約 0 dB，16 kHz 相對同時 pilot 的響應，左側為 −46.64 到 −46.48 dB，右側為 −44.14 到 −43.85 dB。另有部分殘差／增益／12 kHz 失敗，詳見[第 1 次](../../verification/measurements/2026-09-14-audio-v2/run-1.json)、[第 2 次](../../verification/measurements/2026-09-14-audio-v2/run-2.json)及[第 3 次](../../verification/measurements/2026-09-14-audio-v2/run-3.json)。

[前](../../verification/measurements/2026-09-14-audio-v2/environment-before.json)／[後](../../verification/measurements/2026-09-14-audio-v2/environment-after.json)裝置與音量快照相同。這是端點證據，不代表持續控制了整個環境。無效量測不納入各指標範圍，並明確計入缺少數量。這些是失敗證據，不是經校準的通過基準。v1／v2 的素材與估計方式不同，不能把精確 dB 差異當作產品改善前後比較。原本 v1 證據未改寫。暫存素材／log 留在 `/tmp/recordstuff-audio-v2-20260914`，每份報告都有 MP4 路徑。本次未產生新安裝檔。
