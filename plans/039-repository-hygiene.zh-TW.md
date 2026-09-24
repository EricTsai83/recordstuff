# 039 — 儲存庫整理：版面文件與測試位置

[English](039-repository-hygiene.md) | [繁體中文](039-repository-hygiene.zh-TW.md)

狀態：已規劃，尚未實作。建立日期：2026-09-25。排在佇列第一位：只有文件與檔案搬移，幾分鐘的工作，且能消除後續計畫原本得再改一次的文件落差。執行順序見[佇列](README.zh-TW.md#順序與狀態)。

## 範圍與證據

2026-09-25 的目錄結構檢視認為版面本身健康：`src/` 依程序切分且沒有跨程序 import，`src/shared/` 不引用 Electron 或 DOM，產生物皆已 ignore，版面由 tsconfig 配對與 vitest 設定強制。只有四件小事已與實況不符。

- [儲存庫版面](../docs/zh-TW/system-design/repository.md)早於 commit `2e38f68`。第 40 行說沒有獨立測試目錄、第 103 行說測試只在 `src/` 與 `scripts/` 下尋找，但 `tests/capture-protocol.test.ts` 已存在、`vitest.config.ts` 收錄 `tests/**`，第 102 行的強制設定表也缺少 `tsconfig.tests.json`。第 50 行把 `test-material.html` 放在 `scripts/fixtures/`，實際檔案在 `scripts/test-material.html`，所有腳本與文件都用後者。[英文原文](../docs/system-design/repository.md)同樣四行。[CONTRIBUTING](../docs/zh-TW/CONTRIBUTING.md) 對 `tests/` 的描述已經正確。
- `.claude/skills/claude-implement-with-gpt6-astra-review/SKILL.md` 與 `.agents/skills/claude-implement-with-gpt6-astra-review/SKILL.md` 逐位元相同；兩份會各自漂移。
- `scripts/update-acceptance.test.ts` 測的是 `scripts/lib/update-acceptance.mts`；`scripts/lib/settings-entry.test.ts` 測的是 `scripts/lib/acceptance.mts`，而後者已有 `acceptance.test.ts`。兩者都違反版面文件所述「測試放在來源旁」的慣例。
- 根目錄 `tsconfig.json` 的 references 只列 node 與 web 設定。`pnpm typecheck` 會明確跑 tests 設定，結果不受影響，但編輯器的專案參考會漏掉它。

不在範圍：`src/main/` 改功能子目錄、跨程序同名檔案改名、把 `scripts/acceptance-*.mts` 收進子目錄、`website/` 改成 workspace、引入 linter 或 Effect。同一次檢視已逐項評估，以目前規模皆為成本高於收益而不採用。

## 實作契約

- [ ] 更新兩份儲存庫版面文件：說明 `tests/` 放需要跨程序的測試，由 `tsconfig.tests.json` 檢查、`vitest.config.ts` 收錄；在強制設定表加入 `tsconfig.tests.json`；把素材頁移到 `scripts/` 進入點清單。所有連結相對於所在檔案保持有效。
- [ ] 把 `.claude/skills/…` 的副本改為指向 `.agents/skills/…` 的相對 symlink。移除副本前先確認 skill 仍能以名稱載入；若不能，保留一份並在兩處各加一行互相指向的說明。未啟用 `core.symlinks` 的 Windows checkout 會看到一個只含路徑的文字檔；可接受，因為 skill 不是建置輸入。
- [ ] 將 `scripts/update-acceptance.test.ts` 移到 `scripts/lib/update-acceptance.test.ts`，並把 `scripts/lib/settings-entry.test.ts` 併入 `scripts/lib/acceptance.test.ts`，修正相對 import。根目錄 `tsconfig.json` 的 references 加入 tests 設定。

## 驗證與完成

僅文件與測試位置：執行 `pnpm typecheck` 與 `pnpm test` 證明搬移後的測試仍能執行且測試數相同，檢查受影響連結／anchor，執行 `git diff --check`。不啟動 App、不打包、不錄影。依[完成規則](README.zh-TW.md#完成計畫)處理，完成後移除此計畫與翻譯。不自行 commit、push 或發布。
