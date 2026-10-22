# 085 — 可復原、版本化的編輯專案

[English](085-recoverable-editable-projects.md) | [繁體中文](085-recoverable-editable-projects.zh-TW.md)

狀態：已規劃、尚未開始。建立：2026-10-22。硬性相依：083、084；另須通過下述第二階段產品門檻。 依[計畫索引](README.zh-TW.md)順序執行。本次只寫計畫，以下實作及效能目標尚未驗證。

## 目標與決定門檻

加入可選編輯專案，保留一般直接存 MP4。參考 Glide 的素材／編輯分離，不照抄 schema 或其耐久性保證。先提出具體流程：將既有錄影開成專案、保存編輯、重開、日後匯出；實作前由維護者決定是否要此編輯範圍與儲存成本。若不採用，以決定結案並將 086–088 標為暫緩，不建猜測性的基礎設施。

## 步驟與責任

- [ ] 制定最小 v1 manifest：一份既有扁平錄影、有理數／整數時間單位、來源尺寸／色彩、不可變素材身分及 edit revision。已合成 MP4 無法還原獨立鏡頭。區分專案擁有與外部參照素材；預設明確複製成自含專案，檢查磁碟空間、串流可取消、進度不阻塞 main。不假設 hard link 能保證不可變。
- [ ] storage／validation 與錄影 publication／history 分開。每個專案一個 metadata writer，以 transaction 期間持有的 OS lock 跨 App instance 強制執行，再以 revision 檢查編輯衝突。lock 競爭時唯讀／重試，crash 由 OS 釋放，不靠過時 PID 檔猜 owner。解析有上限，不支援的未來版本明確拒絕。migration 複製向前並可回復；毀損編輯不可默默重置預設。拒絕逃逸／絕對素材路徑及 symlink 逃逸；遺失／替換素材可 relink 或唯讀復原，不刪檔。
- [ ] 明訂 asset／manifest／directory transaction 順序：在目的 volume staging、完成／sync 資料、支援時原子發布 metadata，測各平台 rename／durability。temp＋rename 不等於斷電保證。中斷 import 只留下可辨識、擁有的 staging，復原不得刪其他檔。新 revision commit 前保留最後有效版本。autosave debounce／合併且有界，顯示未存／錯誤狀態。
- [ ] 用 production React 元件與既有 library action ownership 做 open／save／reopen、素材遺失復原。專案成功不成為一般 MP4 存檔的前提。定義移動／刪除及 undo 上限；刪專案不隱含刪除外部錄影。

## 門檻與驗證

每個 publication 邊界注入故障後，只能重開前一 committed revision 或完整新版。測磁碟滿、權限失敗、revision 衝突、未知 schema、截斷 JSON 與路徑逃逸。只存 metadata 的耗時不隨影片長度成長；用生成檔量 64 MiB／2 GiB import、取消延遲與記憶體，不為大檔錄長片。實作前固定 size／count 上限及取消期限；一般錄影與 idle 成本維持 083 spread 內。

孤立 storage／parser 做 focused 測試與 TypeScript；跨模組 UI／persistence 最終跑 `pnpm acceptance:regression`。macOS 與 Windows CI 實際 volume I/O 測試不等於斷電或 Windows 硬體證據。未改 capture／lifecycle 不錄影；不為 JSON 引入簽章／build 相依。schema、ownership、migration／recovery 文件及雙語 UI 完成才結案；既有 MP4 不靠編輯器仍可播放。

## 執行與結案契約

依[系列契約](README.zh-TW.md#glide-參考演進083088)處理證據、門檻、桌面交接及結案。保留 Electron／React、capture-process 故障隔離與預設直接 MP4 流程。開始執行先重讀當時程式碼與前置結案紀錄；路徑／數字是設計目標，不取代當時政策。
