# RecordStuff — repo 指示

- 計畫在 `plans/`；執行順序以 `plans/README.md`「順序與狀態」表的「順序」欄為準，不是檔名編號。
- 使用者說「執行下一個 plan」時，取該表中順序最前、狀態為「待執行」或「進行中」且前置已完成的計畫。
- **完成一個計畫（或對計畫做了 follow-up 修改）後，必須執行 `plans/README.md`「完成一個計畫後的收尾」的五個步驟**：計畫檔狀態、順序表、目前進度、根目錄 `README.md`（目前進度、架構一覽、開發段落）、001 規格章節。沒做完不算完成，最終報告要列出更新了哪些文件。
- 設計優先順序見 `plans/001-first-version.md` §1.1：正確性 → 整潔 → robust → 效能。不引入框架或為將來寫的抽象。
- 檢查命令：`pnpm check`（typecheck + vitest + build）。不要 commit、push，除非使用者要求。
