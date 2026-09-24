# 034 — 提升 Windows 系統匣圖示辨識度

[English](034-windows-tray-icons.md) | [繁體中文](034-windows-tray-icons.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-25。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 目的與現況

讓 Windows 工作列通知區域（系統匣）的 RecordStuff 圖示具有完整、明顯的 App 識別，而非沿用 macOS 選單列的簡單圓圈。此計畫的「Windows 選單列」指系統匣，不包含開始功能表、工作列釘選圖示或安裝程式圖示。

目前 [圖示產生器](../scripts/make-icons.mjs) 已分別輸出 macOS template PNG 與 Windows ICO，但兩者共用圓圈／圓點形狀；Windows 待機為灰圈、錄製中為紅點。目前工作樹另有警告圖示，實作時須保留並整合該狀態。[Tray](../src/main/tray.ts) 已依平台載入圖示，Windows 不顯示 macOS 的 `REC` title，因此狀態須能由圖示本身辨認。此為原始碼觀察，尚無 Windows 原生外觀驗收證據。

## 視覺方向與範圍

採用「同一品牌符號，各平台分別製作圖示」：macOS 保留簡潔的 template 圓圈，Windows 加強輪廓辨識度，兩者維持相同錄製符號與狀態含義。共通設計不要求共用同一張圖片，也不直接縮小 App 主圖示。圓角底是候選方案，不是 Windows 規定，也尚未定案。

先比較兩個 Windows 方案再選定：

- **A — 圓角底版**：以現有 App 圖示的深色圓角底、白色外圈與紅色錄製元素，簡化成適合系統匣的版本。
- **B — 無底加粗版**：保留透明周圍，加粗錄製符號，調整輪廓與對比，使其在深淺背景都清楚。

依原尺寸下的 App 辨識度、狀態區別與邊界清晰度比較，記錄選定方案與理由，再逐尺寸調整線寬、留白與比例。

| 狀態 | 兩方案共用的設計契約 | 辨識要求 |
| --- | --- | --- |
| 待機 | 錄製圓環、中央留空；A 方案另加圓角底 | 輪廓清楚，不像孤立灰圈，也不誤認為正在錄製 |
| 錄製中 | 保留選定輪廓，中央改為醒目的實心紅點 | 同時以空心／實心和顏色區別待機 |
| 警告 | 選定輪廓加高對比驚嘆號標記，必要時簡化內圈 | 最小尺寸仍能看出警告，不只靠換色 |

- 保持透明外圍，在淺色與深色背景都能辨認邊界；必要時加入細外框。
- 不加入文字、閃爍或動畫。警告不可遮蔽到失去 App 識別。
- macOS template PNG、App 主圖示及 DMG 背景維持既有設計；Linux 不在此次範圍。
- 沿用現有狀態映射、警告優先順序、tooltip 與點擊行為，不藉此修改錄製流程。
- 此計畫只新增 Windows 系統匣外觀及必要驗收，不代表完整 Windows 支援、打包或發布專案。

## 平台指引與 Cap 參考

[Electron Tray 文件](https://www.electronjs.org/docs/latest/api/tray)建議 macOS 使用 template image、Windows 使用 ICO。[Microsoft 通知區域設計指引](https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-notification)強調簡單、容易辨識的符號；圓角底是本計畫的設計選項，不是平台規定。

Cap 參考固定於已檢視 revision `26e1a6d882f311d10b5317e9e0d29babe4f6737e`：

- Tauri 桌面實作在 macOS 依模式選用 template 圖示，Windows 則選用獨立的預設圖檔。實際檢視的 Windows 圖檔為白色圓角方形輪廓搭配中央同心圓。參見[平台選圖](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/tray.rs#L709-L721)、[template 設定](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/tray.rs#L833-L838)及 [Windows 圖示原檔](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/icons/tray-default-icon.png)。
- 兩套桌面實作的行為不同：[Tauri 在 Windows 跳過錄製開始／停止的換圖](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/tray.rs#L1060-L1097)；[GPUI 則在 Windows 錄製中換成停止圖示](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop-gpui/src/tray/windows.rs#L208-L230)。不能混為同一已發布版本的行為。
- 採用分平台製作圖示的原則，不直接複製 Cap 圖案或狀態行為；RecordStuff 維持待機／錄製中／警告的區分。此參考僅為原始碼與圖檔檢視，不代表 Windows 原生驗收或小尺寸可讀性已通過。

## 實作步驟

- [ ] 開始時重新檢查工作樹，整合 025 的警告／錄製結果契約；以最終 `TrayIcon` 狀態為準，避免覆蓋並行變更。視覺草稿可獨立進行。
- [ ] 先製作 A／B 兩方案、三個狀態在 16／20／24／32／48px 的原尺寸預覽及放大對照，放在淺色／深色底上，與目前 Windows 圖示比較；選出較清楚的方案並記錄理由。確認待機與錄製中即使忽略顏色仍可區分，不能只看放大預覽。
- [ ] 在 `scripts/make-icons.mjs` 分離 Windows 專用繪圖層，沿用程式產圖方式，不直接縮小 512px App 圖示。保留 16、24、32、48px，補上 20px，逐尺寸調整細節並輸出多尺寸 ICO。
- [ ] 重新產生 `resources/tray-idle.ico`、`resources/tray-recording.ico`、`resources/tray-warning.ico`。檢查產圖副作用，確認 macOS PNG、App 圖示與 DMG 背景未被意外修改。
- [ ] 優先沿用現有 `src/main/tray.ts` 平台載入分支；只有必要時才修改 loader，並補上平台選檔／狀態切換的行為測試。不要改變 `tray-model.ts` 的狀態語意。
- [ ] 更新桌面設計文件及繁中翻譯；保存實際外觀與驗收限制至驗證文件。

## 驗證與完成條件

依[測試政策](../docs/zh-TW/testing.md)合併 runtime assets、圖示產生腳本與原生 tray 可見行為的要求：

- [ ] 執行 `pnpm icons`，檢查 ICO 包含預定尺寸、透明度、可解碼且非空；檢視各尺寸預覽，確認重複產生的 Windows ICO 位元組一致。
- [ ] 執行 `pnpm check` 與 `git diff --check`。若修改 loader，測試須涵蓋 Windows 三種圖示與 macOS template 路徑，不能僅斷言繪圖實作常數。
- [ ] 在 Windows 原生桌面，以新建置的 App 檢視三個狀態，涵蓋工作列淺色／深色、100%／125%／150%／200% 縮放，以及可見系統匣／隱藏圖示面板。記錄 OS、縮放、建置版本與截圖，確認沒有裁切、糊邊或警告消失；記錄不可用的組合。
- [ ] 在同一 Windows 驗收輪次確認既有左鍵切換、右鍵選單及 tooltip；實際開始／停止一次短錄製，確認錄製圖示切換、存檔及播放。警告可透過受控測試狀態顯示，但須區分外觀證據與真實失敗恢復證據。
- [ ] macOS 資產與 loader 若保持不變，以資產比較及自動檢查確認隔離；若共用繪圖或 loader 的修改影響 macOS，依原生驗收 skill 在新 bundle 檢查受影響外觀／操作，觸及錄製操作時補錄製 smoke。
- [ ] 每輪原生驗收結束後還原設定、關閉測試 UI、正常退出 App 並確認程序結束。序列執行共用產物的建置，由單一執行者操作桌面。

純圖示變更不需設定回歸、長錄影、音訊品質矩陣或發布。若實作擴及其他行為，依政策增加對應檢查。現有 macOS `pnpm start:app` 與 acceptance runner 不能當作 Windows 驗收；執行時先確認 Windows 啟動方式，不新增未驗證的指令說明。

沒有 Windows 桌面時，原生驗收標為 blocked，不能以 macOS 或靜態預覽替代，也不能宣稱 Windows 已驗證。此計畫目前僅為文件，所有實作與原生驗收均未執行。完成後依佇列規則保存設計／驗證結論，再移除本計畫與翻譯。
