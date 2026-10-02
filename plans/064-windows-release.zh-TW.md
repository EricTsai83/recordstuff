# 064 — Windows 建置、驗證與發布

[English](064-windows-release.md) | [繁體中文](064-windows-release.zh-TW.md)

狀態：提案；佇列第三個，[062](062-signed-notification-acceptance.zh-TW.md) 與 [063](063-scripted-native-acceptance.zh-TW.md) 都結案後才開始。相依：步驟 1 是維護者決定門檻，之後每一步都需要它；步驟 3 需要步驟 2 的安裝檔；步驟 4–7 需要步驟 3 的可行性結論；步驟 8 需要步驟 4–7。步驟 2 以 062 修改後的樣子修改 `scripts/start-app.mjs`；步驟 3 以 063 的證據類型標示證據；步驟 4 的 macOS 複驗在 063 已建好時使用其 `pnpm acceptance:tray`，否則依 063 的選擇規則改用 Computer Use 或人工觀察；步驟 9 重用 063 的證據標籤。與已延後的 058–060 互相獨立。

## 問題與證據

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

一個 `vX.Y.Z` tag 發布一個 GitHub release，同時帶有既有的 macOS DMG 與 Windows x64 安裝檔，否則什麼都不發布。每個平台都經過與目前相同的關卡：建置、驗證、發布、以匿名方式重新下載後再驗證一次。已安裝的 macOS App 讀到的 feed 與資產完全不變。網站提供每個已驗證的平台，並誠實說明 Windows 首次執行的警告。發布紀錄寫明哪些 Windows 行為在實機上驗證過，哪些沒有。

## 步驟

每個步驟都可以獨立完成，完成後文件保持一致。

### 1. 維護者決定門檻

請維護者決定下列各項，並把每個答案與日期記錄在[設計決策](../docs/zh-TW/system-design/decisions.md)與其英文版，取代「macOS 為唯一已驗平台與唯一打包目標」那一列。每項的建議選項列在最前面。

- **驗證硬體。** 哪一台 Windows 機器算數：實體 x64 Windows 11 PC（建議），或參考 Mac 上的 Windows 11 on Arm VM；後者的 x64 模擬與虛擬音訊裝置並不等價。VM 的結果要如此標示，不能單獨讓步驟 3 的擷取案例結案。完全沒有 Windows 機器時就在這裡停止：既有決策維持，本計畫延後。
- **架構。** 第一個版本只做 x64（建議）；arm64 Windows 之後另外驗證再加入。
- **安裝方式與「不做解除安裝器」的決策。** 每位使用者安裝的 NSIS 安裝檔（`oneClick`、`perMachine: false`、不需要管理員權限）會建立 toast 通知所需的開始選單捷徑，並在「設定 → 應用程式」登記 Windows 慣用的解除安裝項目（建議）。可攜 ZIP 維持「不做解除安裝器」的規則，但除非 App 自己建立捷徑，否則會失去通知。若選 NSIS，要記錄解除安裝絕不刪除使用者資料（`deleteAppDataOnUninstall: false`），讓既有的資料規則仍然成立，且 macOS 的規則不變。
- **簽章。** 選項：不簽章，以 SHA256SUMS、`release.json` 與 GitHub build-provenance attestation 確保完整性（第一個版本建議）；放在硬體或雲端金鑰上的 OV 程式碼簽章憑證，需要付費，而且在累積信譽前仍會出現 SmartScreen；Azure Artifact Signing，截至 2026 年只對美國與加拿大的個人核發公開信任憑證。macOS 那種自簽憑證在 Windows 上沒有幫助：使用者得手動信任它。不論選哪一種，資產名稱都要標明，就像 DMG 的 `-selfsigned`；免警告安裝仍在範圍外。
- **發布綁定。** Windows 失敗時，整個 tag 在發布前就失敗（建議，符合「tag 就是版本」），而不是只發布 macOS。
- **最低 Windows 版本。** Electron 44 支援的下限，再縮小到步驟 3 實際驗證過的範圍，以 `osSupported` 限制 Darwin 22 的方式強制執行。

如果維護者拒絕 Windows 交付，記錄決定並結案本計畫。

### 2. Windows 建置與 CI 中的 Windows 檢查

- 依步驟 1 的決定在 `electron-builder.yml` 加入 `win` 與 `nsis` 區段、明確的 Windows 產物名稱，以及由 `pnpm icons` 產生的 `build/icon.ico`（16–256 px），並像系統匣 ICO 一樣加上 byte 測試。`files` 與 `extraResources` 保持共用，讓 `app.asar` 內容與平台無關。
- 新增 `pnpm dist:win`，即不走 `start-app.mjs` macOS 簽章路徑的單純 `electron-builder --win --x64`；`start-app.mjs` 在非 macOS 主機上繼續拒絕執行，並指向它。保留 061 的分段計時與 `pnpm open:app` 檢查的 runtime 輸入建置紀錄，以及 062 抽出的簽章支援，在 macOS 上的行為不變。
- 新增 `.gitattributes`（`* text=auto eol=lf`），並以考慮平台的預期值或加保護的 fixture 修正上列 Windows 測試失敗，絕不以在兩個平台都略過行為測試的方式處理。
- 在 `check.yml` 新增 `windows-latest` job：先跑 `pnpm check`，再跑 `pnpm dist:win`，並以短保留期上傳安裝檔。這是建置產物，不是發布；它的用途是提供給步驟 3。

驗證：兩個 runner 上的 `pnpm check`、Mac 上 `pnpm dist:mac` 不變、下載安裝檔產物並列出其內容。

### 3. Windows 實機可行性回合

在步驟 1 選定的機器上，依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)安裝步驟 2 的產物，逐項記錄 pass、fail 或 blocked，VM 結果分開記錄：

- 不需管理員權限即可安裝、SmartScreen 實際顯示的文字、開始選單捷徑與其 AppUserModelID、首次啟動的「system tray」提示。
- 系統匣：五種 ICO 狀態在亮色與暗色工作列、100/125/150/200 % 縮放下的樣子；左鍵開始與停止、右鍵開啟選單、tooltip 文字。這會以同一個矩陣結案 035 的 N17。
- 以預設快捷鍵與從系統匣錄影：播放有聲音的測試影片，MP4 能在 Windows 播放器開啟並有畫面與系統音訊；音效開啟時，RecordStuff 自己的倒數音不會被錄進去（`restrictOwnAudio`）；檔名與 `Videos\RecordStuff` 資料夾。把檔案複製到 Mac，以 `pnpm verify -- <file>` 檢查完整性、格式與音訊能量。
- 儲存後的 toast 出現，點擊後開啟 Explorer 並選取該檔案；設定能開啟、修改快捷鍵與輸出資料夾，並在重新啟動後保留；第二次啟動會讓執行中的實例取得焦點；錄影中睡眠會存檔；結束後沒有殘留程序。
- 從「設定 → 應用程式」解除安裝後，設定、歷史與錄影都還在；重新安裝後會讀到它們。

門檻：若擷取、音訊或 MP4 編碼失敗，記錄證據並停止。擷取路徑的修改是另一個計畫；無法錄影的 Windows 建置不進行步驟 4–8。

### 4. 為 Windows 調整 App

- 睡眠、缺少系統音訊、不支援的 OS，以及「menu bar」／「system tray」的平台專屬文案，兩種語言都要；依平台保留快捷鍵（macOS 截圖／Spotlight 組合鍵只在 macOS 保留；Win 鍵組合之類的 Windows 組合鍵已會被拒絕）。
- 依步驟 1 設定 Windows 最低版本，沿用既有的 `unsupported_os_version` 路徑並提供 Windows 說明。
- Windows 的更新檢查：一個 Windows feed 與一個尋找 Windows 資產的 GitHub 備援，同時 `feedVersion` 與 `githubVersion` 必須照舊只接受 macOS App 目前讀取的內容。測試涵蓋舊的 macOS release 物件、兩個平台的新多資產 release，以及 Windows App 讀到只有 macOS 的 release（沒有更新，也不是值得回報為故障的錯誤）。
- 步驟 3 發現的其他問題。每項修正都有聚焦測試；可見的變更在兩個平台都複驗。在 macOS 上，063 已提供 `pnpm acceptance:tray` 時，以它檢查兩種語言中變更的系統匣文案；否則依 063 的選擇規則。

### 5. 多平台發布工具

- **相容性優先。** `release.json` 資產與網站的 `/release.json` 維持目前 darwin-arm64 的格式與 bytes 語意。Windows 有自己的紀錄 `release-win32-x64.json` 與 feed `/release-win32-x64.json`。SHA256SUMS 每個二進位資產一行，讓 `shasum -a 256 -c` 照樣能檢查，Windows 使用者也能拿 `Get-FileHash` 的輸出與對應那一行比對。
- **依版本決定資產組合。** 第一個 Windows 版本之前的 release 維持三個資產的契約，讓 `published` 仍能從 main 重新驗證任何舊 tag；從該版本起，資產組合為 DMG、Windows 安裝檔、SHA256SUMS 與兩份紀錄。
- **Windows 候選版關卡**，在 Windows runner 上執行：以每位使用者模式靜默安裝到暫存目錄、`RecordStuff.exe` 的 PE machine type 為 x64、檔案與產品版本等於 tag、記錄 `resources/app.asar` 雜湊、系統匣 ICO 存在、簽章狀態符合預期（沒有簽章，或為固定的憑證），然後靜默解除安裝並確認沒有殘留的安裝檔案。記錄兩個平台的 `app.asar` 雜湊是否相同；只有在重複建置證明結果固定時才強制要求相同。
- **紀錄與文字。** manifest schema 增加 Windows 項目；升級、未變更與僅限歷史的規則逐平台比對；README 下載區塊、release notes、驗證紀錄骨架與 GitHub release 標題涵蓋兩個平台。擴充 `scripts/release-record.test.ts` 與發布測試，涵蓋 Windows 之前與之後的 release、缺少 Windows 資產、摘要不符與只有 Windows 失敗的情況。

### 6. 發布 workflow

- 新增在 `windows-latest`（x64）執行、與 macOS 建置並行的 `build-windows` job，執行相同的 preflight、版本標記、`pnpm install --frozen-lockfile`、明確的 Electron 安裝、`pnpm check`、`pnpm dist:win` 與步驟 5 的候選版關卡，然後上傳自己的產物。若步驟 1 選擇簽章，比照 macOS job 準備金鑰：environment `release`、secrets 只在該步驟使用、遮蔽值並一律清理。
- `publish` 需要兩個建置，重新驗證兩個候選版後發布一個 release。`verify-published` 在兩種 runner 上對公開 URL 執行。若步驟 1 選擇 attestation，在每個建置加入 `actions/attest-build-provenance`，並在 `verify-published` 加入 `gh attestation verify`。
- 把 workflow 與其 concurrency group 改名以涵蓋兩個平台；只有在沒有排隊中的 release 時才更改 group 名稱。`record` 與 `deploy-website` 維持單一 job。

### 7. 網站與使用者說明

- 下載頁每個已驗證平台各有一段，列出大小、SHA-256 與連結；Windows feed 端點；Windows 的安裝、SmartScreen「其他資訊 → 仍要執行」步驟、手動更新、解除安裝與資料保留位置說明；更新支援頁的平台範圍。所有說法限於步驟 3 與步驟 8 驗證過的內容。
- `resources/INSTALL.md`、兩份 README 與 release notes 範本以兩種語言加入 Windows 說明。執行 `pnpm site:check`。

### 8. 預發布演練，接著第一個正式版

- 在 main 上打 `vX.Y.Z-rc.1`：預發布路徑會發布兩個平台，但不更動正式 manifest、README 或 package.json。確認 workflow、兩個 `verify-published` 執行，以及在步驟 1 的機器上從公開 URL 安裝，並對下載的安裝檔重做步驟 3 的 smoke。
- 接著打正式版 tag。之後確認已安裝的 macOS 1.1.1 App 對新的 feed 與 release 仍正確回報更新狀態，Windows App 回報「已是最新」。以 Windows 證據及其未測案例完成發布紀錄。

### 9. 可選：Windows 驗收 runner

只在維護者希望步驟 8 之後能重複進行 Windows 回合時才做：一個 PowerShell 或 Node runner，以全域快捷鍵開始與停止錄影並檢查 log 與檔案，並以 063 的證據類型標示。沒有它時，每次發布前的 Windows 驗收就是在候選版上手動做步驟 3 的 smoke，[發布作業](../docs/zh-TW/system-design/releases.md)必須把這一步列進去。

## 範圍外

Windows on Arm 與 Intel Mac 建置（各自需要另外驗證）、Microsoft Store、MSIX、winget、任一平台的自動更新、免警告安裝、Linux，以及任何對 macOS 簽章身分或 DMG 契約的修改。

## 驗證與完成條件

對每個步驟的 diff 套用[測試規則](../docs/zh-TW/testing.md)。步驟 1 與本計畫是文件：連結、錨點、指令名稱、翻譯與 `git diff --check`。步驟 2 與步驟 5 屬於建置設定與發布工具：兩個平台的 `pnpm check`、受影響的打包指令與發布工具測試。步驟 4 是 App 原始碼：`pnpm check`，加上 Windows 與 macOS 對變更的可見行為的複驗。步驟 6 是發布 workflow：其測試與一次預發布執行；程式或文件任務從來不代表允許推送 tag，所以步驟 8 的 tag 需要維護者明確要求。CI 能證明安裝檔可以建置、安裝、符合其紀錄並發布已驗證的 bytes；它不能證明擷取、系統音訊、通知或系統匣外觀，這些只有在實機上的步驟 3 與步驟 8 才能確立。

完成需要全部滿足：

- 設計決策那一列記錄維護者的選擇與日期，[概覽](../docs/zh-TW/system-design/overview.md)、[發布](../docs/zh-TW/system-design/releases.md)、[工具](../docs/zh-TW/system-design/tooling.md)、[交付](../docs/zh-TW/system-design/delivery.md)與[簽章](../docs/zh-TW/system-design/signing.md)中只限 macOS 的敘述，以兩種語言描述新的範圍。
- 一個正式版帶有兩個平台，兩者都通過 `verify-published`，且已安裝的 macOS App 的更新檢查行為與以前相同。
- Windows 發布紀錄把步驟 3 的每個案例列為已在實機通過、只在 VM 通過或未測試，且 N17 的系統匣矩陣已結案或明確延續。

把結果記錄在驗證歷史，長期規則寫入系統設計，然後依[完成計畫](README.zh-TW.md#完成計畫)處理。
