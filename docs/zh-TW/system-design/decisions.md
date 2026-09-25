# 設計決策與取捨

[English](../../system-design/decisions.md) | [繁體中文](decisions.md)

這是目前採用的決策，不是新的工作計畫。原始計畫中已被實測推翻的假設，以此處及程式為準。

| 決策 | 原因 | 代價／重新評估條件 |
| --- | --- | --- |
| Electron + TypeScript | 以現有語言完成桌面生命週期、原生選單與 Chromium 擷取 | 有 Electron 常駐成本；只在實測效能或擷取能力不足時評估原生引擎 |
| Bundle identifier 用維護者自有網域反寫（`com.ericts.record`；[原因](signing.md#bundle-identifier)） | identifier 沒有註冊機構，自有網域是唯一的唯一性保證；它也是 App 在 TCC 授權、通知與簽章裡的身分 | 選一次就不再動：改了 macOS 會視為新 App，使用者需重新允許螢幕錄製 |
| Chromium getDisplayMedia + MediaRecorder | 不自寫音訊裝置或原生 sidecar，先完成錄影核心 | 對 codec／時間戳控制有限；明確要求 EC／NS／AGC false 已恢復本機高頻與立體聲，引擎／平台變更需重測 |
| 隱藏 renderer 專做擷取 | DOM 媒體 API 位於 renderer；UI 仍可用原生 API | 多一條 MessagePort；需 ready、session、順序与心跳管理 |
| Main 擁有狀態與影片 writer | UI、擷取程序不能各自宣稱錄製成功 | 程序中止時 main 要協調故障收尾 |
| MP4 H.264 + AAC | 本機 QuickTime 可直接播放，硬體編碼已有量測證據 | fragmented MP4；非所有損壞檔都可播，無轉檔 fallback |
| 原生 Tray／Menu／Notification | 一個按鈕的產品不需要一般視窗與 UI framework | 通知呈現與 Finder 排序受系統控制 |
| 全域快捷鍵依實體鍵位註冊（macOS 停用 `LayoutAwareGlobalHotkeys`；[原因](desktop.md#錄影快捷鍵)） | 編輯器記錄實體鍵位並拒絕數字鍵盤；Chromium 依配置查找，會在注音下把預設 ⌘⇧1 移到數字鍵盤 | 非 QWERTY 拉丁配置的字母快捷鍵是 US 位置，而不是鍵帽字母。每次升級 Electron 都要確認其 Chromium 仍有此功能，否則註冊會在無提示下回到依配置查找 |
| 手寫 type guard、單一 repo | 協定及狀態規模小，容易完整閱讀與測試 | 沒有協定版本協商；獨立發布另一端時需重設契約 |
| 媒體 buffer 複製傳送 | 先前 Electron 44 的 transfer ArrayBuffer 實驗會卡住 main | 多一次記憶體拷貝；目前無有界背壓 |
| 從實際影格量尺寸 | getSettings 多螢幕錯報曾把 1080p 縮成 1080×606 | 啟動增加量測等待；fallback 必須留 warning |
| timeslice 與關鍵影格同設 1000 ms | 只有 timeslice 時低動態 Retina 首片曾晚於 8 秒 | 名義設定不是硬性發片週期 |
| 保持品質係數、明示實測差異 | 30 fps 位元率接近目標；60 fps 可用但約兩倍目標 | 60 fps 檔案較大；需持續區分要求、track 與成品 |
| 移除音訊品質選單 | 本機不同 AAC 要求值實際都約 160 kbps | 固定要求 256 kbps，不保證音訊碼率或 stereo 分離 |
| 不補償固有音畫延遲 | 已測延遲與漂移在專案接受範圍 | 升級擷取引擎後重測，不能把一次量測視為永遠正確 |
| 固定自簽憑證 + DMG | 開發者可產生可安裝下載版，收件者不需開發工具或憑證 | 未 Apple 公證，首次開啟可能需手動允許；固定身分也不保證所有環境 TCC 行為 |
| DMG 只有 App 與 Applications 連結 | 拖曳到 Applications 的視窗是使用者早已熟悉的安裝慣例；附帶文件只增加雜訊與混淆 | 說明、更新與移除指引必須線上可及並由每個 release 連結；任何多出的可見檔案都會讓發布閘門失敗 |
| tag 即發布也是版本；驗證在打 tag 之前 | 單一維護者與單一 Mac 無法支撐 nightly 通道，pipeline 內的人工驗收閘門只是重複開發期已做的檢查，而打 tag 前先在 repo 寫版本號只是多一個會出錯的步驟 | CI 證明建置、簽章、版面與 bytes 一致，但不證明擷取；壞版本以新版本修正，絕不覆寫；record job 以 bot 身分 commit 到 main |
| 手動更新與垃圾桶移除，不做更新器／解除安裝器 | 同一身分與路徑讓取代後保留設定與權限；單鍵錄影工具從背景更新機制得到的好處有限 | 使用者需自行下載新版；絕不自動刪除使用者資料；只透過延後的更新評估重新考慮 |
| macOS 為唯一已驗平台與唯一打包目標 | 使用者設備只有 Mac，Windows／Linux 不作發布阻擋，也不該提供沒驗過的安裝檔 | 保留跨平台程式（Windows 系統匣分支、平台判斷），但不承諾未驗平台正常；在有維護者能實機驗證前，不設 `win`／`nsis` 打包目標與 `dist:win` 指令 |
| 英文正式版與繁體中文翻譯 | GitHub 文件、註解與診斷共用英文，App 可明確選中文 | catalog 與雙語文件需同步維護 |
| 設計與計畫分離 | 已完成執行日志不適合長期當規格 | 更新行為時需維護設計、驗證紀錄；plans 只留剩餘交付 |
| 原始量測留在本機 | 每次執行的報告、log 與探測都綁定機器，貢獻者一多就會倍增；只有解讀後的結論值得長存 | `docs/verification/measurements/` 已 gitignore；驗證紀錄與 release 紀錄必須帶足數字，不依賴原始檔；`acc6342` 之前的歷史仍保有早期原始量測 |
| [已知素材的音質診斷](audio-quality.md) | 以同時 pilot、頻率擬合和連續性視窗區分高頻流失、增益與時鐘差異 | 無效量測不能叫作品質失敗；需保留重複結果，不自動學習壞基準；不取代聽感與長時間驗證 |

## 工具與演進邊界

現有建置採 electron-vite、打包採 electron-builder。依賴維持穩定版本路線；升级需重新跑相關檢查及媒體驗證，不能只因套件更新就沿用舊平台結論。

沒有為未来先引入 Effect、schema framework、monorepo、React、Rust 或完整 PlatformRecorder。當確實需要新視窗，可新增 UI renderer 但媒體仍不經 UI；當 Chromium 能力已確認不足，可在維持 Recorder 契約的前提下評估替代 host。沒有排程的錄影庫、編輯、快捷鍵、自動更新與其他平台支援，不是目前下載版的必要前置。

歷史原生引擎候選與第三方比較未當成現有實作或未來承諾；需要採用時重新調查相應 API 與依賴。
