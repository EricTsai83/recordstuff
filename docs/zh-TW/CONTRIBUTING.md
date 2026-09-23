# 貢獻指南

[English](../../CONTRIBUTING.md) | [繁體中文](CONTRIBUTING.md)

你可以透過回報問題、改善文件與翻譯、補充測試，或修正與擴充 App 來參與貢獻。

## 回報問題或提出變更

回報 bug 時，請提供重現步驟、預期與實際行為、App 版本或 commit，以及作業系統版本與硬體。錄製問題也請附上螢幕解析度、錄影品質設定及音訊輸出裝置。必要時附上相關 log 或簡短範例，並先移除私人資訊。在 macOS 上可用 `pnpm log` 追蹤 App log。

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

目前僅在 macOS 上完成驗證。在 macOS 上，`pnpm start` 會建置並開啟開發用 Electron App，適合進行錄製檢查。出現提示時，請授予螢幕與系統音訊錄製權限；使用 `pnpm dev` 時，權限可能歸屬於啟動它的終端機或編輯器。若權限變更尚未生效，請重新啟動。

若需測試封裝後的 macOS App，`pnpm start:app` 會建置、自簽、驗證並開啟本機 App bundle。這需要本機程式碼簽署身分，設定細節見[建置與驗證工具](system-design/tooling.md)。一般原始碼修改不需要先封裝。

## 找到要修改的程式

| 位置 | 職責 |
| --- | --- |
| `src/main/` | App 生命週期、錄製協調、檔案寫入、權限、設定、選單列與 log |
| `src/renderer/` | 隱藏的擷取頁面、媒體串流與編碼 |
| `src/preload/` | MessagePort 交接 |
| `src/shared/` | 狀態、訊息協定、錄製品質與翻譯 |
| `scripts/` | 建置、簽署與錄製驗證工具 |
| `docs/system-design/` | 架構與模組文件 |
| `website/` | Astro 網站，獨立套件，由根目錄 `pnpm site:*` 指令代為執行 |

樹狀結構的其餘部分——打包輸入、文件、產生物，以及維持結構的設定——見[目錄結構](system-design/repository.md)。

讓修改聚焦於要解決的問題，並沿用周邊程式碼的慣例。測試以 `*.test.ts` 放在原始碼旁。行為改變時，新增或更新相關測試；修正 bug 時，盡可能補上能重現問題的回歸測試。

App 文案位於 `src/shared/i18n.ts`。新增或修改文案時，同步更新英文與繁體中文項目，保持具名 placeholder 一致。修改已記載的行為或指令時，更新相關文件及既有翻譯，並確認連結能從各文件所在目錄正確解析。

## 驗證修改

修改 App 後，執行：

```bash
pnpm check
```

此指令會執行 TypeScript 檢查、Vitest 測試與正式建置。開發過程也可以分別執行 `pnpm typecheck`、`pnpm test` 或 `pnpm build`。提交任何修改前，執行 `git diff --check`；若只修改文件，也請檢查受影響的連結與指令。

修改錄製行為時，請實際錄製，確認開始、停止、儲存與播放正常。App 以 `pnpm start:app` 啟動後，`pnpm acceptance` 會透過全域快捷鍵無人值守完成開始／停止／儲存／verify；播放仍需親自檢查。記錄作業系統、硬體、設定及無法測試的情境。自動化檢查無法單獨證明實際螢幕與系統音訊擷取正常。

完整 App 驗收每輪結束時（包含失敗或中斷），須保存測試錄影、還原設定、清理測試視窗、退出受測 App 並確認程序已結束；清理失敗算驗收失敗，不得中斷使用者既有錄影。`pnpm acceptance` 會讓 RecordStuff 保持關閉，下一輪前需重新啟動。單元檢查與設定快捷鍵的中途開啟步驟不會關閉無關 App。

開發用媒體分析需要 FFmpeg 與 ffprobe，執行 App 本身不需要。例如：

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
```

`--screen` 請填入實際來源尺寸；同步分析需要使用[工具指南](system-design/tooling.md)所述的測試素材。該指南也說明錄製測試矩陣與音訊品質檢查。原始執行結果會寫進已 gitignore 的 `docs/verification/measurements/`，只留在你的機器；需要保存的結果請連同數字與限制摘要到[驗證紀錄](verification/README.md)。

## 發布（維護者）

貢獻者不需要發布。維護者在本機驗證已推送的 commit 後推送 `vX.Y.Z` tag；tag 就是版本。GitHub Actions 會建置、簽署、驗證、公開、重驗公開下載，並把發布事實回寫到 main。檢查清單、版本規則與失敗處理見 [GitHub 發布自動化](system-design/releases.md)。

## 提交 Pull Request

將修改 commit、push 到自己的 fork 或 repository 分支，再向預設分支開啟 PR。請包含：

- 要解決的問題，以及相關 issue（若有）。
- 行為如何改變，以及 reviewer 需要了解的設計選擇。
- 執行過的檢查與結果，包括相關的手動錄製檢查及未測情境。
- 若有助於呈現介面變更，附上截圖或簡短錄影。

將無關的整理拆成獨立修改，方便 reviewer 評估這次貢獻。若依 review 再次修改，請重跑受影響的檢查，並更新 PR 描述中的最終行為與驗證結果。

所有執行計畫集中放在根目錄 `plans/`：英文為 `<name>.md`，繁中為 `<name>.zh-TW.md`；索引分別為 `plans/README.md` 與 `plans/README.zh-TW.md`。其他翻譯文件仍放在 `docs/zh-TW/`。
