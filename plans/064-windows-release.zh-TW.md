# 064 — Windows 建置、驗證與發布

[English](064-windows-release.md) | [繁體中文](064-windows-release.zh-TW.md)

狀態：自 2026-10-03 起進行中，依維護者當天的決定修訂。這些決定取代了同一天在步驟 1 因沒有 Windows 機器而延後的結論，改為[設計決策](../docs/zh-TW/system-design/decisions.md)中記錄的決策：Windows x64 與 macOS DMG 經由同一個 tag 觸發的發布一起發布，由 GitHub Actions 打包與檢查，不在 Windows 實機上驗證（「流程應該與 Mac 相同」）。在分支 `windows-packaging` 上的進度（尚未進入 main）：步驟 1 已決定；步驟 2、5、6、7 與步驟 4 的更新檢查部分已實作。依此決定豁免：步驟 3 的實機回合、步驟 8 的實機 smoke 與步驟 9。剩餘：步驟 4 的其餘部分（Windows 專屬文案與 Windows 最低版本），仍留在本計畫，但不阻擋發布；步驟 8 的預發布演練與第一個雙平台正式版，各自只在維護者明確要求推送 tag 時進行；以及結案紀錄。目前的 CI 證據：run 37040450544 的兩個 job 都通過：Windows 上的 `pnpm check`（typecheck、94 個測試檔，其中 5 個依平台略過、build）、`pnpm dist:win`，以及以 1.1.1 版號建置的安裝檔通過 `windows-smoke` 的安裝、檢查與解除安裝。其前置計畫 062、063 與 065 都已結案（[062](../docs/zh-TW/verification/history-2026-10.md#plan-062-結案--2026-10-02)、[063](../docs/zh-TW/verification/history-2026-10.md#plan-063-結案--2026-10-02)、[065](../docs/zh-TW/verification/history-2026-10.md#plan-065-結案--2026-10-03)）。相依：步驟 8 需要步驟 2 與 5–7 已進入 main，且兩個 check job 都通過；步驟 4 的其餘部分不是步驟 8 的門檻，若在其後完成就隨之後的版本發布；其 macOS 系統匣複驗使用 063 的 `pnpm acceptance:tray`。

## 問題與證據

本節記錄工作開始前的狀態（2026-10-02）。其中引用的決策已於 2026-10-03 被取代，分支也已修改下方各步驟標為完成的項目。

RecordStuff 只發布自簽的 macOS arm64 DMG。Windows 不只是尚未設定，而是被既定決策排除。[設計決策](../docs/zh-TW/system-design/decisions.md)記錄「macOS 為唯一已驗平台與唯一打包目標……在有維護者能實機驗證前，不設 `win`／`nsis` 打包目標與 `dist:win` 指令」，[發布自動化](../docs/zh-TW/system-design/releases.md)也把「Windows／Intel 交付」列在範圍外。已結案的 034 在沒有 Windows 機器的情況下畫了 Windows 系統匣圖示；035 豁免了它的原生檢查（N17），所以從來沒有任何 Windows 專屬的東西在 Windows 上跑過。

目前樹狀內容盤點（2026-10-02）：

- **App 程式碼部分可攜。** 擷取以 `{ video: source, audio: "loopback" }` 回應 `setDisplayMediaRequestHandler`，沒有平台分支（`src/main/index.ts`），而 Electron 在 Windows 上支援 loopback 系統音訊。權限監看只在 macOS 執行。系統匣 ICO、首次啟動的「system tray」提示、Ctrl 快捷鍵標籤、`~/Videos/RecordStuff`，以及非 macOS 的 30 fps 上限都已存在。在 Windows 上尚未驗證：`MediaRecorder` 是否支援 `video/mp4;codecs=avc1,mp4a.40.2`（否則為 `mp4_unsupported`）、loopback 搭配 `restrictOwnAudio`，以及 toast 通知；後者需要一個 AppUserModelID 與 `app.setAppUserModelId("com.ericts.record")` 相符的開始選單捷徑。
- **部分文案在所有平台都是 macOS 用語。** 「the Mac went to sleep」（`src/main/tray-model.ts`、`src/shared/session-record.ts`）、`no_audio_track` 與 `unsupported_os_version` 的說明（`src/main/recording-result.ts`）、「macOS reserves this combination」與保留的 macOS 截圖／Spotlight 組合鍵（`src/shared/hotkey.ts`），以及設定中的「menu bar」（`src/main/settings-model.ts`）。沒有 Windows 最低版本。
- **更新檢查會拒絕 Windows。** `feedVersion` 要求 `dmg` 區塊，`githubVersion` 要求 `platform === "darwin"` 與 DMG 資產（`src/main/updates.ts`）。已安裝的 macOS App（1.1.1 及更早）正是以這些規則解析 `https://record.ericts.com/release.json` 與 GitHub 最新 release，所以它們的格式不能改。
- **發布工具只支援單一平台。** `scripts/lib/release-manifest.mts` 固定 `PLATFORM = "darwin-arm64"`、一個 `dmg` 區塊與恰好三個資產；`scripts/release.mts` 以 `hdiutil`、`plutil`、`lipo` 與 `start-app.mjs --verify-app` 驗證，寫出一行的 SHA256SUMS、僅限 macOS 的 release notes、README 文字與紀錄標題。`release.yml` 在 `macos-15` 上以 keychain 簽章執行建置、發布與驗證；`start-app.mjs` 在非 macOS 上會拋出錯誤。
- **打包。** `electron-builder.yml` 只有 `mac`／`dmg`；`extraResources` 已經會帶上 `*.ico`。沒有 `build/icon.ico`（`scripts/make-icons.mjs` 只寫 512 px 的 `build/icon.png`），也沒有 `dist:win` 指令。
- **CI。** `check.yml` 只在 `macos-15` 跑 `pnpm check`。在 `windows-latest` 上，以下測試會失敗：預期 `path.join` 產生 POSIX 分隔符的測試（`src/main/tray.test.ts`、`src/main/recorder.test.ts`）、以 `chmod` 製造不可讀／不可寫的 fixture（`src/main/session-sentinel.test.ts`、`src/main/settings.test.ts`）、未加保護的 `/usr/bin/openssl` 與 shebang 假程式（`scripts/create-signing-identity.test.ts`、`scripts/lib/audit-tools.test.ts`、`scripts/release-record.test.ts`）、依賴 LF 換行的 README 比對（沒有 `.gitattributes`），以及 `scripts/lib/runtime-inputs.test.ts` 的 symlink 案例，它們需要 Windows runner 預設不給的權限。`pnpm acceptance:recipe` 會管理程序群組，只能在 macOS 與 Linux 執行（plan 061）。寫檔測試中對開啟中檔案的 rename／unlink／hard-link 行為在那裡沒有測過。
- **網站。** manifest、`/release.json` feed 與下載、說明與支援頁面都只寫 macOS，並註明不支援 Windows。
- **驗收工具。** 每個 runner 都使用 `osascript`、JXA、`pgrep` 或 `~/Library` 路徑；在 Windows 上沒有任何工具能自動檢查錄影。

## 目標

一個 `vX.Y.Z` tag 發布一個 GitHub release，同時帶有既有的 macOS DMG 與 Windows x64 安裝檔，否則什麼都不發布。每個平台都在自己的 runner 類型上建置、過閘門、發布、以匿名方式重新下載後再過一次閘門。已安裝的 macOS App 讀到的 feed 與資產完全不變。網站提供兩個平台，說明 Windows 安裝檔未簽章、未經實機驗證，並誠實說明其 SmartScreen 警告。發布紀錄寫明 Windows 只由 CI 檢查，並列出未測試的項目。

## 步驟

每個步驟都可以獨立完成，完成後文件保持一致。

### 1. 維護者決定門檻 — 已於 2026-10-03 決定

當天的第一個答案是沒有 Windows 機器，因此本計畫延後；接著維護者決定不經實機驗證就發布（「不用幫我驗證 Windows，但讓 GitHub Actions 負責打包」）。答案記錄在[設計決策](../docs/zh-TW/system-design/decisions.md)與其英文版，取代「macOS 為唯一已驗平台與唯一打包目標」那一列，並修訂手動更新那一列：

- **驗證硬體。** 沒有。Windows 的證據只有 CI，來自 GitHub 的 `windows-2025` runner，並如此標示；沒有 VM 回合。
- **架構。** 只做 x64；Windows on Arm 仍在範圍外。
- **安裝方式與「不做解除安裝器」的決策。** 每位使用者的一鍵 NSIS 安裝檔（`oneClick: true`、`perMachine: false`、不需管理員權限），因為這是常見做法而選用：T3 Code（pingdotgg/t3code）在與 DMG 相同的 GitHub release 中附一個。其開始選單捷徑帶有 appId `com.ericts.record` 作為 AppUserModelID，並在「設定 → 應用程式」登記 Windows 解除安裝程式，`deleteAppDataOnUninstall: false`，所以解除安裝絕不刪除使用者資料。macOS 的規則（手動更新、移到垃圾桶）不變；兩個平台仍都沒有更新器。
- **簽章。** 不簽章，完整性由 SHA256SUMS（每個二進位資產一行）、`release-win32-x64.json` 與 GitHub build-provenance attestation 承擔；資產名稱 `RecordStuff-<version>-x64-unsigned-setup.exe` 寫明這點。考慮過的選項保留在[簽章](../docs/zh-TW/system-design/signing.md#windows-安裝檔依決策不簽章)。
- **發布綁定。** Windows 失敗時，整個 tag 在發布前就失敗。
- **最低 Windows 版本。** 未決定：沒有硬體能把 Electron 44 的下限再縮小。留給步驟 4 的其餘部分。

### 2. Windows 建置與 CI 中的 Windows 檢查 — 已在分支完成

- `electron-builder.yml` 依步驟 1 加入 `win` 與 `nsis` 區段、上述產物名稱與 `build/icon.ico`；後者現在由 `pnpm icons` 產生（16–256 px），並由 `scripts/make-icons.test.ts` 逐 byte 核對。`files` 與 `extraResources` 維持共用。
- `pnpm dist:win` 為 `electron-vite build && electron-builder --win nsis --x64 --publish never`，不走 macOS 簽章路徑；`start-app.mjs` 仍拒絕非 macOS 主機，並指向它。macOS 的分段計時、runtime 輸入紀錄與簽章支援都沒有改變。
- `.gitattributes` 設定 `* text=auto eol=lf`；對 Windows 敏感的測試改為依平台判斷，而不是在兩個平台都略過。
- `check.yml` 新增在 `windows-2025` 上執行的 `check-windows` job（使用發布所固定的 image，而非 `windows-latest`）：`pnpm check`、`pnpm dist:win`、`release.mts windows-smoke dist`（步驟 5 的安裝閘門），並把安裝檔上傳為保留 7 天的建置產物。`workflow_dispatch` 讓工作分支也能檢查。

證據：run 37040450544 在 `windows-2025` 上通過 `pnpm check`、`pnpm dist:win` 與 `windows-smoke` 閘門；尚未推 tag，因此發布 workflow 的 job 都還沒執行過。

### 3. Windows 實機可行性回合 — 豁免

依決定豁免：沒有 Windows 機器。此決定接受已發布的 Windows 建置可能完全無法錄影，所以本步驟原本的門檻（「無法錄影的 Windows 建置不往下進行」）不再適用，release notes、README 與網站都寫明擷取未驗證。步驟 5 的 CI 閘門只能代替安裝、登記、捷徑存在與解除安裝，而且只是 runner 證據。其他每個案例在 Windows 上都維持未測試，並在每個版本的發布紀錄中如此列出：SmartScreen 的文字、實際使用中的開始選單捷徑 AppUserModelID、首次啟動的「system tray」提示、五種系統匣 ICO 狀態在亮色與暗色工作列及 100/125/150/200 % 縮放下的樣子、系統匣點擊與 tooltip（035 的 N17 矩陣仍未結案並延續）、有畫面與系統音訊的錄影、`MediaRecorder` 的 MP4 支援、`restrictOwnAudio`、儲存後的 toast 與其 Explorer 顯示、設定的保存、單一實例取得焦點、錄影中睡眠、結束，以及保留資料的解除安裝與重新安裝。若之後有 Windows 機器，這些案例需要依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)另做一輪。

### 4. 為 Windows 調整 App — 更新檢查已完成；其餘仍待完成，不阻擋發布

- **已在分支完成：更新檢查。** 在 win32/x64 上只讀 GitHub 的最新 release，且只在帶有 Windows 資產時接受，因為網站 feed 只描述 macOS DMG。沒有 Windows feed：網站 manifest 中選用的 `windows` 區塊供下載頁使用。`feedVersion` 與 `githubVersion` 仍只接受 macOS App 目前讀取的內容；`src/main/updates.test.ts` 涵蓋雙平台 release、其他平台、只有 macOS 的 release，以及 Windows 只讀 GitHub。
- **剩餘：** 睡眠、缺少系統音訊、不支援的 OS 與「menu bar」／「system tray」的平台專屬文案，兩種語言都要；依平台保留快捷鍵（macOS 截圖／Spotlight 組合鍵只在 macOS 保留）；Windows 最低版本，沒有硬體時只能採用 Electron 44 文件記載的下限，經由 `osSupported` 與既有的 `unsupported_os_version` 路徑並提供 Windows 說明來強制，或記錄為不強制。每項修正都有聚焦測試；在 macOS 上，以 `pnpm acceptance:tray` 檢查兩種語言中變更的系統匣文案；Windows 上的外觀仍未驗證。這不阻擋步驟 8；若在其後完成，就隨之後的版本發布。

### 5. 多平台發布工具 — 已在分支完成

- **相容性。** `release.json` 資產與網站的 `/release.json` 維持 darwin-arm64 格式，供已安裝的 macOS App 讀取。Windows 有自己的紀錄 `release-win32-x64.json`。SHA256SUMS 每個二進位資產一行，讓 `shasum -a 256 -c` 照樣能檢查，Windows 使用者也能拿 `Get-FileHash` 與對應那一行比對。
- **依版本決定資產組合。** `LAST_MACOS_ONLY_VERSION = "1.1.1"`：更早的 tag 維持三個資產的契約，讓 `published` 仍能從 main 重新驗證；之後的每個版本（含預發布）有五個：DMG、Windows 安裝檔、SHA256SUMS 與兩份紀錄。`release.mts assets` 為 workflow 印出一個 tag 的資產組合。
- **Windows 閘門**，在 Windows runner 上執行（`candidate-windows`、`published-windows`、`windows-smoke`）：每位使用者模式靜默安裝；HKCU 下恰好一個解除安裝項目、HKLM 下沒有，且 DisplayVersion 等於版本；`RecordStuff.exe` 的 PE machine 為 x64、ProductVersion 等於版本；安裝檔與 exe 的 Authenticode 狀態為 `NotSigned`；系統匣 ICO 與開始選單捷徑存在；記錄 `app.asar` 雜湊；然後靜默解除安裝，並確認 App、捷徑與登記都已移除。兩個平台的 `app.asar` 雜湊分別在兩份紀錄中，不強制相同。
- **紀錄與文字。** manifest schema 有選用的 `windows` 區塊，恰好在 1.1.1 之後的版本為必要；promotion、unchanged 與 historical-only 規則比對其欄位；README 下載區塊、release notes（macOS、Windows 與 Verify 段落）、驗證紀錄骨架與 release 標題涵蓋兩個平台。發布測試涵蓋 Windows 之前與之後的 release，以及缺少、不符或未列出的 Windows 資產。

### 6. 發布 workflow — 已在分支完成

- `windows-2025` 上的 `build-windows`（要求 x64）與 macOS 建置並行：相同的 preflight、版本寫入、frozen 安裝、明確的 Electron 安裝、`pnpm check`、`pnpm dist:win`、`candidate-windows`、`actions/attest-build-provenance` 與自己的產物，沒有任何簽章 secret。
- `publish` 需要兩個建置，重新驗證兩個候選版後發布一個 release。`verify-published` 在 macOS 上執行；`windows-2025` 上的 `verify-published-windows` 匿名下載、以 `Get-FileHash` 比對 SHA256SUMS、執行 `gh attestation verify` 與 `published-windows`。`record` 需要兩者；`deploy-website` 不變。
- workflow 改名為「Release」，交付 group 由 `recordstuff-macos-delivery` 改為 `recordstuff-delivery`。新名稱在分支進入 main 時生效：要在沒有排隊中的 release run 時合併，因為在舊 group 下排隊的 run 不會與新 group 的 run 互相排序。

此 workflow 尚未在 tag 上執行過；步驟 8 會實際跑它。

### 7. 網站與使用者說明 — 已在分支完成

下載頁有 Windows 段落，大小、SHA-256 與連結取自 manifest 的 `windows` 區塊；Help 涵蓋 Windows 安裝、SmartScreen「其他資訊 → 仍要執行」步驟、手動更新、解除安裝與資料保留位置；支援頁的平台範圍已更新。`resources/INSTALL.md`、兩份 README 與 release notes 範本都有 Windows 說明，文件有兩種語言的就兩種語言都有。所有說法都限於 CI 證據。

### 8. 預發布演練，接著第一個正式版 — 剩餘

- 步驟 2 與 5–7 進入 main、兩個 check job 都通過後，且只在維護者明確要求時，先做打 tag 前的一般 macOS 驗收，再打 `vX.Y.Z-rc.1`（1.1.1 之後的版本）。確認兩個建置、`publish`、兩個驗證 job 與 `record`；預發布不得更動正式 manifest、README 或 package.json。在 Windows 實機上從公開 URL 安裝已豁免；`verify-published-windows` 是唯一的 Windows 下載檢查。
- 接著，在維護者明確要求時打正式版 tag。之後在 Mac 上確認已安裝的 macOS 1.1.1 App 對新的 feed 與 release 仍正確回報更新狀態，且下載頁顯示兩個平台。Windows App 回報「已是最新」只有單元測試支持。完成發布紀錄：Windows 的證據只有 CI，步驟 3 的每個案例都未經實機測試。

### 9. 可選：Windows 驗收 runner — 豁免

豁免：沒有 Windows 機器可以執行它。[發布作業](../docs/zh-TW/system-design/releases.md#操作)寫明打 tag 前沒有人工 Windows smoke。

## 範圍外

Windows on Arm 與 Intel Mac 建置、Microsoft Store、MSIX、winget、任一平台的自動更新、Windows 程式碼簽章、免警告安裝、沒有機器期間的 Windows 實機驗證、Linux，以及任何對 macOS 簽章身分或 DMG 契約的修改。

## 驗證與完成條件

對每個步驟的 diff 套用[測試規則](../docs/zh-TW/testing.md)。步驟 1 與本計畫是文件：連結、錨點、指令名稱、翻譯與 `git diff --check`。步驟 2 與步驟 5 屬於建置設定與發布工具：兩個 runner 上的 `pnpm check`、發布工具測試、runner 上的 `pnpm dist:win` 與 `windows-smoke`，以及 Mac 上 `pnpm dist:mac` 不變。步驟 4 的其餘部分是 App 原始碼：`pnpm check`，加上 macOS 對變更的可見行為的複驗。步驟 6 是發布 workflow：其測試與步驟 8 的預發布執行。步驟 7 是網站：`pnpm site:check`。程式或文件任務從來不代表允許推送到 main 或推送 tag；兩者都需要維護者明確要求。CI 能證明安裝檔可以建置、以每位使用者模式安裝、符合其紀錄與 attestation、發布已驗證的 bytes 並解除安裝；它不能證明擷取、系統音訊、通知或系統匣外觀，本計畫目前也沒有任何步驟在 Windows 上確立這些。

完成需要全部滿足：

- 設計決策的列記錄維護者的選擇與日期，[概覽](../docs/zh-TW/system-design/overview.md)、[發布](../docs/zh-TW/system-design/releases.md)、[工具](../docs/zh-TW/system-design/tooling.md)、[交付](../docs/zh-TW/system-design/delivery.md)與[簽章](../docs/zh-TW/system-design/signing.md)中只限 macOS 的敘述，以兩種語言描述新的範圍（已隨本次修訂完成）。
- 一個正式版帶有兩個平台，`verify-published` 與 `verify-published-windows` 都通過，且已安裝的 macOS App 的更新檢查行為與以前相同。
- Windows 發布紀錄寫明 Windows 證據只有 CI，並把步驟 3 的每個案例列為未經實機測試；N17 的系統匣矩陣明確延續。
- 步驟 4 的其餘部分已完成，或維護者決定把它保留為有記錄的已知限制。

把結果記錄在驗證歷史，長期規則寫入系統設計，然後依[完成計畫](README.zh-TW.md#完成計畫)處理。
