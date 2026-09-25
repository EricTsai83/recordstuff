# 目錄結構

[English](../../system-design/repository.md) | [繁體中文](repository.md)

同一個 repository 收錄兩項交付物與它們共用的文件：根目錄是 Electron 桌面 App，`website/` 是靜態官方網站。兩者共用 Git 歷史、發布流程與這組設計文件，其餘各自獨立——網站是自帶依賴與 lockfile 的獨立套件，App 不會從它匯入任何東西。

本文說明「什麼放在哪裡、為什麼」。程序邊界與資料擁有權見[系統架構](architecture.md)，個別模組見[函式設計索引](functions.md)，操作這些目錄的指令見[建置、打包與驗收工具](tooling.md)。

## 頂層目錄

| 位置 | 內容 |
| --- | --- |
| `src/` | App 原始碼，依 Electron 程序切分 |
| `scripts/` | 開發者工具：建置啟動、簽署、發布、錄製驗證與驗收 |
| `tests/` | 同時需要瀏覽器 DOM 與 Node API 的跨程序測試 |
| `docs/` | 系統設計、驗證證據，以及繁體中文鏡像 |
| `plans/` | 只放尚未完成的執行計畫 |
| `resources/` | App 執行期需要的資源，以及安裝說明 |
| `build/` | electron-builder 使用的打包圖檔 |
| `website/` | 發布於 record.ericts.com 的 Astro 網站，獨立套件 |
| `.github/workflows/` | 發布與網站部署自動化 |
| `.agents/`、`.claude/` | 開發期使用的 agent skill 定義 |
| 根目錄設定 | `package.json`、`tsconfig*.json`、`electron.vite.config.ts`、`vitest.config.ts`、`electron-builder*.yml` |
| 根目錄說明 | `README.md`、`CONTRIBUTING.md`、`AGENTS.md`／`CLAUDE.md`、`LICENSE` 與各自的 `*.zh-TW.md` |
| `out/`、`dist/`、`node_modules/` | 產生物；不納入 Git，可重新建置 |

## App 原始碼

`src/` 依 Electron 程序切分，而非依功能切分。檔案在哪個程序執行決定它可以匯入什麼，因此這條邊界優先於其他分類。

| 目錄 | 執行於 | 內容 |
| --- | --- | --- |
| `src/main/` | 主程序 | 生命週期（`index.ts`）、錄製狀態機（`recorder.ts`）、擷取頁面監管、檔案寫入、權限偵測、設定、選單列、全域快捷鍵、儲存通知、更新檢查、log，以及僅供開發的無人值守錄製（`autorecord.ts`） |
| `src/renderer/` | 繪製程序 | 兩個入口：隱藏的擷取頁面（`index.html` + `capture-host.ts`，負責媒體串流與編碼），以及設定面板（`settings.html`、`settings.ts`、`settings.css`） |
| `src/preload/` | Preload，sandbox | 每個 renderer 各一個：`index.ts` 只把 MessagePort 交給擷取頁面、不對外開放任何 API；`settings.ts` 承載設定面板的 IPC 契約 |
| `src/shared/` | 兩邊共用 | 狀態（`state.ts`）、MessagePort 協定、錄製品質運算、設定面板契約、螢幕偏好、外觀、快捷鍵驗證，以及翻譯（`i18n.ts`） |

這棵樹有四條共通慣例：

- **`src/shared/` 必須與執行環境無關。** 它是唯一同時被 `tsconfig.node.json` 與 `tsconfig.web.json` 收錄的目錄，因此不得匯入 Electron 或 DOM API。
- **測試與原始碼同層**，命名為 `foo.test.ts`。唯一例外是 `tests/`，放同時需要瀏覽器 DOM 與 Node API 的跨程序測試；由 `tsconfig.tests.json` 檢查，讓 renderer 設定不含 Node 型別。`vitest.config.ts` 收錄 `src/**/*.test.ts`、`scripts/**/*.test.ts` 與 `tests/**/*.test.ts`。
- **`*-model.ts` 把決策與副作用分開。** `tray.ts`、`settings.ts`、`settings-window.ts` 負責與 Electron 互動；`tray-model.ts`、`settings-model.ts`、`ui-model.ts` 是純投影，不需要視窗即可測試。`recorder.ts` 以注入協作者達成同一件事。
- **所有使用者看得到的文字集中在 `src/shared/i18n.ts`**，英文與繁體中文成對維護，不散落在各模組。

## 開發者工具

`scripts/` 收錄支援開發、但不隨 App 出貨的一切：

- **入口檔**放在該目錄頂層，與 `package.json` script 一對一：`start-app.mjs`、`make-icons.mjs`、`probe-recording.mjs`、`verify-recording.mts`、`run-matrix.mts`、`diagnose-frame-cadence.mts`、`audio-quality.mts`、`acceptance-*.mts`、`create-signing-identity.mts`、`release.mts`、`cleanup-release-keychain.py`。`test-material.html`——同步與音質量測時播放的素材頁——也放在同一層。
- **`scripts/lib/`** 放入口檔背後的共用實作：驗收執行環境、驗證與媒體工具、音質分析、release manifest 用戶端。
- **`scripts/fixtures/`** 放測試替身與注入用的替代實作。

工具使用 `.mts`／`.mjs`，因為它們直接由 Node 執行，不經過 App 的打包流程；測試則是放在旁邊的一般 `*.test.ts`。

## 文件

| 位置 | 用途 |
| --- | --- |
| `docs/system-design/` | 程式目前的行為。完成的計畫併入此處後即移除 |
| `docs/verification/README.md` | 整理過的證據：量到什麼、數字與限制 |
| `docs/verification/releases/<version>.md` | 各版本的驗證事實 |
| `docs/verification/measurements/` | `pnpm verify`、`matrix`、`acceptance*`、`audio:quality` 寫出的原始執行結果。已 gitignore，不可被納管文件連結 |
| `docs/learning/` | 可獨立閱讀的 HTML 設計模式文章，以本專案為範例說明可遷移的設計判斷；是設計理由，不是目前行為。以撰寫時要求的語言寫成、不做鏡像；由 `docs/learning/README.md` 索引 |
| `docs/zh-TW/` | `docs/` 與 `CONTRIBUTING.md` 的繁體中文鏡像，路徑相對位置相同 |
| `plans/` | 只放未完成工作，`<name>.md` 與 `<name>.zh-TW.md` 同層，由 `plans/README.md` 索引 |
| `resources/INSTALL.md` | 給使用者的安裝／更新／移除指南，由發布頁與 README 連結 |

翻譯刻意採用兩種規則：`docs/` 下的文件鏡像到 `docs/zh-TW/` 的同一相對路徑；計畫與根目錄說明則以 `.zh-TW.md` 後綴放在原檔旁。連結必須能從各檔案所在位置正確解析。

## 打包輸入

- `build/` 是 electron-builder 的 `buildResources`：`icon.png`、macOS 的 `icon.icns`，以及 DMG 背景 `background.png` 與 `background@2x.png`。全部由 `pnpm icons` 以程式產生。
- `resources/` 放 App 執行期所需資源：macOS 選單列 template 圖、Windows `.ico` 兩枚（同樣由 `pnpm icons` 產生）、`entitlements.mac.plist`，以及雙語安裝指南。打包過濾只複製 `*.png` 與 `*.ico`，因此 entitlements 與指南不會進入出貨的 App。
- `electron-builder.yml` 是共用打包設定，`electron-builder.local.yml` 以 `extends` 延伸出本機免費自簽。`files` 只允許 `out/**` 與 `package.json`，因此 `src/`、`scripts/`、`docs/`、`plans/` 的任何內容都不會抵達使用者。

## 網站

`website/` 是獨立的 Astro 專案，不是 workspace 成員：它有自己的 `package.json`、`pnpm-lock.yaml` 與 `node_modules/`，由根目錄透過 `pnpm site:dev`、`site:build`、`site:check`、`site:manifest`、`site:screenshots` 代為呼叫。

| 位置 | 內容 |
| --- | --- |
| `website/src/pages/` | 路由：`index`、`download`、`help`、`support`，以及 `release.json` feed 端點 |
| `website/src/components/` | 頁面區塊與標記，較大的組合放在 `pages/`、`scenes/`、`heroes/` |
| `website/src/layouts/`、`styles/`、`themes/` | 共用 layout、全域與字型 CSS，以及 ember 主題 |
| `website/src/content/site.ts`、`src/lib/` | 網站文案與其背後的 release／文字輔助函式 |
| `website/scripts/` | manifest 產生、發布與連結檢查、截圖，以及它們的測試 |
| `website/release-manifest.json` | 納管的 manifest，建置前會先驗證 |
| `website/compare/` | 本機截圖比對結果；已 gitignore |

App 的更新檢查讀取本網站的 `release.json`，因此 `scripts/lib/release-manifest*.mts` 跨越兩邊共用，網站 workflow 也會監看它。分工見[網站、App 與更新 feed 交付](delivery.md)。

## 自動化與產生物

`.github/workflows/release.yml` 在推送 `v*` tag 時建置、簽署、驗證並發布；`website.yml` 在網站變更、手動觸發，或穩定版發布後被呼叫時部署網站。`.agents/skills/` 與 `.claude/skills/` 是開發用 skill 定義，不屬於任何一項交付物。Claude Code 只使用 `.claude/skills/`，其他 agent 使用 `.agents/skills/`，因此兩者都需要的 skill 在兩個目錄各自保留一份。

所有產生物都不納管、且可重建：`pnpm build` 產生 `out/`，`pnpm start:app` 與 `pnpm dist:mac` 產生 `dist/`，網站建置產生 `website/dist/` 與 `website/.astro/`，`pnpm install` 產生 `node_modules/`，本機驗證產生 `docs/verification/measurements/`。

## 結構由什麼維持

這個結構靠設定強制，而不只靠慣例：

| 檔案 | 約束了什麼 |
| --- | --- |
| `tsconfig.node.json`／`tsconfig.web.json` | 哪些目錄以 Node／Electron 或 DOM 函式庫檢查型別；`src/shared/` 同時出現在兩者。在 renderer 端執行的 fixture `scripts/fixtures/frame-cadence-renderer.ts` 從 Node 設定排除，改以 DOM 設定檢查 |
| `tsconfig.tests.json` | `tests/` 同時以 DOM 與 Node 函式庫檢查型別，與 renderer 分開 |
| `vitest.config.ts` | 測試只在 `src/`、`scripts/` 與 `tests/` 下以 `*.test.ts` 尋找 |
| `electron.vite.config.ts` | 一個 main 入口、兩個 preload 入口、兩個 renderer HTML 入口 |
| `electron-builder.yml` | 打包哪些內容（`out/**`、`package.json`）與複製哪些資源 |
| `.gitignore` | 產生物、原始量測與簽署材料一律不納管 |
| `website/scripts/check-links.mts` | 已發布網站的連結完整性 |

## 新檔案該放哪裡

- 會碰到 Electron、檔案系統或作業系統的邏輯：`src/main/`；其中值得測試的決策部分抽成 `*-model.ts`。
- 兩個程序都需要的型別或純函式：`src/shared/`，不得匯入 Electron 或 DOM。
- 使用者會讀到的文字：`src/shared/i18n.ts`，雙語同步。
- 手動或由 CI 執行的工具：入口放 `scripts/`，邏輯放 `scripts/lib/` 以便測試。
- 關於行為的長期結論：`docs/system-design/`，並在同一次修改更新繁體中文鏡像。
- 執行結果的證據：在 `docs/verification/README.md` 摘要；原始輸出留在已忽略的 `measurements/`。
- 尚未完成的工作：`plans/`；行為寫入文件後即移除該計畫。
