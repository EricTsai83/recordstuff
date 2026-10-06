# 貢獻指南

[English](../../CONTRIBUTING.md) | [繁體中文](CONTRIBUTING.md)

你可以透過回報問題、改善文件與翻譯、補充測試，或修正與擴充 App 來參與貢獻。

## 回報問題或提出變更

回報 bug 時，請提供重現步驟、預期與實際行為、App 版本或 commit，以及作業系統版本與硬體。錄影問題也請附上螢幕解析度、錄影品質設定及音訊輸出裝置。必要時附上相關 log 或簡短範例，並先移除私人資訊。在 macOS 上可用 `pnpm log` 追蹤 App log。

新增功能或大幅調整設計前，可以先開 issue 說明要解決的問題及預期行為，方便在實作前討論範圍。[系統設計](system-design/README.md)與[待辦計畫](../../plans/README.zh-TW.md)可用來了解現有行為與進行中的工作。

## 建立開發環境

1. 若沒有 repository 的寫入權限，先 fork，再 clone 自己的 fork。
2. 安裝 Node.js 與 pnpm。專案要求 Node ≥22.12；若要執行 TypeScript 量測腳本，請使用 Node 24。
3. 安裝依賴，並為修改建立分支：

   ```bash
   pnpm install
   git switch -c fix/describe-your-change
   ```

4. 啟動開發版 App：

   ```bash
   pnpm dev
   ```

目前僅在 macOS 上完成驗證。在 macOS 上，`pnpm start` 會建置並開啟開發用 Electron App，適合進行錄影檢查。出現提示時，請授予螢幕與系統音訊錄製權限；使用 `pnpm dev` 時，權限可能歸屬於啟動它的終端機或編輯器。若權限變更尚未生效，請重新啟動。

若需測試封裝後的 macOS App，`pnpm start:app` 會建置、自簽、驗證並開啟本機 App bundle。這需要本機程式碼簽署身分，設定細節見[建置與驗證工具](system-design/tooling.md)。一般原始碼修改不需要先封裝。

## 找到要修改的程式

| 位置 | 職責 |
| --- | --- |
| `src/main/` | `index.ts` 組裝整個 App；每個模組一個資料夾：`recording/`、`display/`、`permission/`、`library/`、`shortcuts/`、`app/`、`settings/`、`menus/`、`actions/`，共用工具放在 `lib/` |
| `src/renderer/` | 每個頁面一個資料夾（`capture/`、`settings/`、`countdown/`、`video/`）、共用的 `player/`，以及 `components/ui/` 的 shadcn/ui primitive |
| `src/preload/` | MessagePort 交接 |
| `src/shared/` | 狀態、訊息協定、錄影品質與翻譯 |
| `scripts/` | 建置、簽署與錄影驗證工具：入口檔在頂層，共用程式碼在 `lib/runner/`、`lib/acceptance/`、`lib/verification/`、`lib/audio/` 與 `lib/release/` |
| `docs/system-design/` | 架構與模組文件 |
| `website/` | Astro 網站，獨立套件，由根目錄 `pnpm site:*` 指令代為執行 |

樹狀結構的其餘部分——打包輸入、文件、產生物，以及維持結構的設定——見[目錄結構](system-design/repository.md)。哪些模組資料夾可以匯入哪些，見[模組邊界](system-design/repository.md#模組邊界)，並由 `pnpm test` 強制執行。

讓修改聚焦於要解決的問題，並沿用周邊程式碼的慣例。測試以 `*.test.ts` 放在原始碼旁。 同時需要瀏覽器 DOM 與 Node API 的跨程序測試放在 `tests/`，由 `tsconfig.tests.json` 檢查。`pnpm typecheck` 分別檢查 main、renderer 與整合測試，保留 renderer 不含 Node 型別的邊界。行為改變時，新增或更新相關測試；修正 bug 時，盡可能補上能重現問題的回歸測試。

App 文案位於 `src/shared/i18n.ts`。新增或修改文案時，同步更新英文與繁體中文項目，保持具名 placeholder 一致；編譯器會檢查每次呼叫都傳入各 placeholder 的值。修改已記載的行為或指令時，更新相關文件及既有翻譯，並確認連結能從各文件所在目錄正確解析。

可見的 renderer 使用 React、Tailwind CSS 4 與 shadcn/ui 的 Base UI 版本。`components.json` 設定 `base-mira` registry、alias 與共用的 `src/renderer/ui.css` token。透過 `pnpm dlx shadcn@latest add <component>` 加入元件；產生的原始碼放在 `src/renderer/components/ui/`，並確認 Base UI 的 data attribute 與安裝版本一致。產生的 `cn` import 必須使用 `@/lib/utils`，不要加入無關的 `cn` 套件。`settings-app.tsx` 畫出已提交的 view；`settings-controller.ts` 負責 IPC、非同步請求所有權、焦點與宣告。`player.tsx` 由設定視窗與全螢幕視窗共用。倒數字型與播放覆蓋層是功能專用的 React 呈現；原生 OS 選單及隱藏的擷取 host 使用各自的平台 API。

`pnpm test:ui` 是背景 UI 與整合套件：Playwright 驅動隱藏的離屏 Electron，載入建置好的頁面、preload 與正式 main，OS 效果換成會記錄的 adapter，因此不會從你的桌面拿走視窗、焦點、按鍵或聲音，執行時可以繼續工作。先執行 `pnpm build`，或使用已包含一次 build 與本套件的 `pnpm acceptance:regression`，不需要另外下載瀏覽器。它涵蓋頁面輸入、DOM 焦點、位置、IPC、儲存與靜音播放；OS 視窗啟用、原生視窗框、真正的註冊、在螢幕上全螢幕、擷取與音效仍由原生 runner 負責（`pnpm acceptance:recipe -- native-ui` 與錄影回合）。更換 primitive 時保留測試案例，改寫選取器及輸入序列，而非移除斷言。圖、trace 與摘要寫入 `test-results/ui/`、`test-results/ui-summary.json` 與 `playwright-report/`；詳見[背景 UI 套件](system-design/tooling.md#背景-ui-套件)。

## 驗證修改

依[共用測試規則](testing.md)按行為選擇檢查及可省略項目，人工協作者與 AI 使用同一套判準。

| 常見修改 | 起點 |
| --- | --- |
| 僅文件 | 檢查受影響連結／錨點、指令與翻譯；`git diff --check`。不啟動 App、不錄影 |
| App 程式 | `pnpm check`（TypeScript、Vitest、正式建置），加規則中依影響選取的檢查 |
| 設定／快捷鍵整合 | `pnpm acceptance:regression`，已包含 `pnpm check`；檢視受影響 UI／截圖 |
| 錄影行為 | `pnpm check`，再用新 `pnpm start:app` 產物執行[錄影 smoke 案例](acceptance.md)。`pnpm acceptance` 自動開始／停止／存檔／verify，播放另行觀察 |
| 網站 | `pnpm site:check`；視覺修改檢視受影響頁面 |

每次修改都執行 `git diff --check`。開發中可按需單獨執行 `pnpm typecheck`、`pnpm test` 或 `pnpm build`；最終版本已被成功組合指令涵蓋的檢查不重跑，相同輸入也不建置兩次（[選定一次並對每個版本驗證一次](testing.md#選定一次並對每個版本驗證一次)）。每次推送到 main，以及每個改動不只是文件或網站的 pull request，GitHub Actions 都會在 macOS 與 Windows runner 上執行 `pnpm check` 與 `pnpm test:ui`（[check.yml](../../.github/workflows/check.yml)），Windows job 另外建置未簽章的安裝檔並安裝、解除安裝一次。這會在打 release tag 之前先攔下型別、測試或建置的錯誤，但不證明擷取可用。網站由 [website.yml](../../.github/workflows/website.yml) 負責：改動 `website/**`、`scripts/lib/release/release-manifest*.mts`、`src/shared/version.ts` 或該 workflow 的 pull request，會在不使用 secrets 的情況下執行網站測試、`astro check`、離線 manifest 檢查、離線建置與離線連結檢查。線上 manifest 驗證與外部連結只由 `pnpm site:check` 以及合併後 Vercel 的正式建置檢查。

[驗收指南](acceptance.md)定義共用案例、收尾及報告；[工具指南](system-design/tooling.md)說明簽章、FFmpeg／ffprobe、媒體分析與專用 runner。完整 App 驗收保存錄影、還原設定並確認退出後，讓受測 App 保持關閉。開發期間已授權按需停止錄影、退出、重啟或重建 RecordStuff，不需另行確認。

分開回報真正檢查、範圍排除及必要但未驗項目。自動化檢查不能證明螢幕／系統音訊擷取。`docs/verification/measurements/` 原始結果已 gitignore，只在本機；透過[驗證索引](verification/README.md)保留長期結論。

## 發布（維護者）

貢獻者不需要發布。維護者在本機驗證已推送的 commit 後推送 `vX.Y.Z` tag；tag 就是版本。GitHub Actions 會建置、簽署、驗證、公開、重驗公開下載，並把發布事實回寫到 main。檢查清單、版本規則與失敗處理見 [GitHub 發布自動化](system-design/releases.md)。

## 提交 Pull Request

將修改 commit、push 到自己的 fork 或 repository 分支，再向預設分支開啟 PR。請包含：

- 要解決的問題，以及相關 issue（若有）。
- 行為如何改變，以及 reviewer 需要了解的設計選擇。
- 執行過的檢查與結果，包括相關的手動錄影檢查及未測情境。
- 若有助於呈現介面變更，附上截圖或簡短錄影。

將無關的整理拆成獨立修改，方便 reviewer 評估這次貢獻。若依 review 再次修改，請重跑受影響的檢查，並更新 PR 描述中的最終行為與驗證結果。

所有執行計畫集中放在根目錄 `plans/`：英文為 `<name>.md`，繁中為 `<name>.zh-TW.md`；索引分別為 `plans/README.md` 與 `plans/README.zh-TW.md`。其他翻譯文件仍放在 `docs/zh-TW/`。
