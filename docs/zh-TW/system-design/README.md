# recordstuff System Design

[English](../../system-design/README.md) | [繁體中文](README.md)

更新：2026-09-21。這組文件描述目前程式的設計與已驗證行為，取代已完成的執行計畫。recordstuff 是本機桌面錄影工具，沒有後端服務。

## 閱讀順序

| 文件 | 回答的問題 |
| --- | --- |
| [產品總覽](overview.md) | 為誰解決什麼問題、具備哪些功能、支援聲明與產品邊界 |
| [設計總覽](design-overview.md) | 設計骨幹、分層方向、一次錄影的完整路徑與跨切面不變式 |
| [系統架構](architecture.md) | 程序如何分工、媒體如何流動、資料與資源由誰擁有 |
| [Electron、Chromium 與 WebRTC](webrtc.md) | 媒體引擎分層、本機錄製與網路通訊的區別、音訊處理及驗證邊界 |
| [錄製管線](recording.md) | 開始、編碼、分段傳輸、停止、失敗與檔案保存如何運作 |
| [桌面功能](desktop.md) | 選單、通知、權限、設定與 log 的細節 |
| [函式設計索引](functions.md) | 各原始碼模組的函式／方法、輸入輸出、副作用與協作關係 |
| [網站、App 與更新 feed 交付](delivery.md) | 流程圖、部署負責者、token 需求與發布邊界 |
| [GitHub 發布自動化](releases.md) | tag 觸發建置、簽署 secrets、閘門、公開發布與失敗處理 |
| [macOS 簽署身分與自簽設計](signing.md) | 身分設計、憑證建立與備份、本機簽署、待實作 CI 配置 |
| [建置、打包與驗收工具](tooling.md) | 開發者如何建置、簽署、量測與交付 |
| [音質測試設計](audio-quality.md) | 每個指標的重要性、素材設計、頻率擬合、失敗判讀與證據 |
| [設計決策](decisions.md) | 為什麼這樣設計、已接受哪些取捨、何時才需要改架構 |
| [本機驗證紀錄](../verification/README.md) | 哪些事已有證據、哪些是限制、原始量測在哪裡 |

程式碼是實作事實的來源；變更行為時同步更新相應文件。函式索引涵蓋正式程式與開發工具的具名函式，事件 callback 依所屬流程說明；測試案例留在相鄰 `*.test.ts`，不複製成第二份測試清單。

未完成工作只放在 [plans](../../../plans/README.zh-TW.md)。已完成計畫不再兼作規格；Windows／Linux 驗收、Apple 認證發行均不列入目前交付範圍。歷史變更可由 Git 查閱。
