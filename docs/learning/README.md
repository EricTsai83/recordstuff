# Learning articles

Standalone HTML articles that teach transferable design patterns, using this project as the worked example. They explain design rationale and its preconditions, not the current implementation: behavior is documented in [system design](../system-design/README.md), and unfinished work lives in [plans](../../plans/README.md). Articles are written in the language they were requested in and are generated with the `to-html` skill under `.agents/skills/`; run its highlight and validate scripts after editing.

# 學習文章

可獨立閱讀的 HTML 設計模式文章，以本專案為範例，說明可遷移到其他程式碼庫的設計判斷與前提。它們不是目前實作的規格：行為以[系統設計](../zh-TW/system-design/README.md)為準，未完成工作在[計畫](../../plans/README.zh-TW.md)。文章以撰寫時要求的語言寫成，由 `.agents/skills/` 下的 `to-html` skill 產生；修改後請執行該 skill 的 highlight 與 validate 腳本。

| 文章 | 主題 |
| --- | --- |
| [事件迴圈裡的磁碟工作：三個可遷移的設計模式](disk-work-in-an-event-loop.html) | 非同步 I/O 與執行緒的取捨、建立資源前先寫意圖紀錄、用 promise 鏈做有上限的並行；以計畫 036／037／038 的設計為例 |
