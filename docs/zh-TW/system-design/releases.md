# GitHub 發布自動化

[English](../../system-design/releases.md) | [繁體中文](releases.md)

更新：2026-10-03。推送版本 tag 是唯一的發布動作，而且 tag 就是版本：CI 在一次執行中把它寫入建置、簽署、驗證、公開、重驗公開下載，並把事實回寫到 main。含 pipeline 內人工驗收閘門的 draft／promote 流程用於 [0.1.1](../verification/releases/0.1.1.md)，並在準備 0.1.2 的同一天退役；人工檢查改在打 tag 之前進行。[0.1.2](../verification/releases/0.1.2.md) 是此流程的第一個版本：從推送 tag 到公開不到三分鐘。

依維護者 2026-10-03 的決定（[設計決策](decisions.md)），1.1.1 之後的每個版本（`scripts/lib/release-manifest.mts` 的 `LAST_MACOS_ONLY_VERSION`），同一個 tag 也會建置並發布未簽章的 Windows x64 安裝檔，流程與 Mac 相同：建置、過閘門、發布、匿名下載後再過一次閘門。它的閘門在 GitHub 的 Windows runner 上執行，沒有用到 Windows 實機，因此發布不驗證 Windows 上的擷取、系統音訊、通知或系統匣。第一個雙平台版本是 2026-10-03 的 [1.2.0](../verification/releases/1.2.0.md)，之前先以 [1.2.0-rc.1](../verification/releases/1.2.0-rc.1.md) 演練。

網站與 App 的分工、部署負責者及更新 feed 流程，見[交付設計圖](delivery.md)。

正式版的 `record` 步驟與網站共用 `scripts/lib/release-manifest*.mts` 的驗證器，一次取得並交叉驗證 GitHub release、`release.json`、SHA256SUMS、1.1.1 之後版本的 `release-win32-x64.json` 與下載資產；網站 manifest 恰好只在這些版本帶 `windows` 區塊，`release.json` 資產與網站的 `/release.json` feed 則維持 darwin-arm64 格式，因為已安裝的 macOS App 會解析它們；同一份資料產生 `website/release-manifest.json`、中英文 README 下載區塊及缺少的驗證紀錄。README 與驗證紀錄都是輸出，不再反向解析 Markdown 作為資料來源。離線測試讀取已提交的 JSON manifest 驗證 README，不依賴 CI 建置時寫入的候選 `package.json` 版本；這只驗證提交資料的一致性，不宣稱已查詢 GitHub 的最新版本。預發布版本只產生歷史驗證紀錄，不修改正式版 manifest、README 或 package.json。

已提交的 `website/release-manifest.json` 是正式版下載指標，`record` 在取得 release 之前先驗證它。經驗證的正式版比它新時為 **promoted**：manifest 與兩份 README 區塊由同一份 snapshot 寫出。版本相同時，若發布身分與資產事實（source commit、發布時間、DMG 名稱、大小與 SHA-256、版本帶有 Windows 安裝檔時其名稱、大小、SHA-256 與網址，以及資產與 release 網址，與 `pnpm site:manifest verify` 比對的欄位相同）都與已提交的一致，即為 **unchanged**：已提交的 manifest 保持原本 bytes（含 `verifiedAt`），README 區塊由相同事實產生；任何差異都在寫檔前失敗並列出欄位。較舊版本為 **historical only**：只補上缺少的驗證紀錄，不動 manifest 與 README，因此較晚才 record 或重跑的舊 tag 不能讓下載指標倒退。package.json 不是指標的依據，因為它可能是無關的開發或候選版本；它維持自己的規則：前進到較新的已記錄正式版，永不倒退。已提交的 manifest 缺少、無法讀取或格式錯誤時，record 會停止並提示修復方式（從 main 還原，或以 `pnpm site:manifest generate vX.Y.Z` 為目前的正式版重新產生）；`record` 沒有基準時絕不自行選擇指標，也沒有隱含的 bootstrap。輸出會寫明結果與寫入的檔案；沒有改變任何內容的重試不寫任何檔案。historical-only 的正式版 record 仍會執行 `deploy-website`，重新部署未變的指標。

發布工具與網站只共用根目錄 `scripts/lib/release-manifest.mts`（資料模型與驗證）及 `release-manifest-client.mts`（公開發布資料讀取）；網站 CLI 保留自己的輸出路徑與命令。record 會先讀取、驗證所有輸入並在記憶體產生全部輸出，成功後才開始寫檔；這避免標記或輸入錯誤造成局部更新，但不是跨檔案的斷電交易。`scripts/release-record.test.ts` 透過暫存 checkout 執行真正 CLI，網路與 gh 邊界使用固定資料，涵蓋 promotion、較新版本之後才 record 的較舊正式版、同版重試與 source commit／digest／大小衝突、預發布版、package.json 超前與落後 manifest、基準缺少／非 JSON／格式錯誤／為預發布版、人工紀錄保留、候選版本、commit 不符及 README 標記錯誤；每種失敗都讓所有輸出維持不變。

Vercel 的 Root Directory 仍為 `website`，必須啟用 **Include source files outside of the Root Directory in the Build Step**，讓建置可讀取共用模組；部署 workflow 會檢查此設定，並在 `scripts/lib/release-manifest*.mts` 變更時觸發網站建置。

## 發布契約

[release.yml](../../../.github/workflows/release.yml) 只在推送 `v*` tag 時建置與發布。App 發布沒有分支或 PR 觸發。以既有 tag 手動 dispatch 只執行發布後驗證，不會建置 App、發布版本或部署網站。網站交付由獨立的 [website.yml](../../../.github/workflows/website.yml) 處理：main 的 push 若修改 `website/**`、共用的 release manifest 模組、共用的版本語法（`src/shared/version.ts`）或該 workflow，就自動部署網站；在 main 手動 dispatch 可重試網站部署，不需要版本 tag 或 App job。workflow 名稱為 Release。macOS 的 `build`、`publish` 與 `verify-published` job 使用 `macos-15`，build 執行時要求 arm64；`build-windows` 與 `verify-published-windows` 使用 `windows-2025`，build 要求 x64；`record` 使用 `ubuntu-24.04`。每個 job 都用 Node 24.21.0，建置使用 pnpm 10.33.4 與 frozen lockfile。Actions 固定完整 commit SHA，更新時需重新檢查上游版本。

單次 workflow 的順序：兩個建置並行。`build`（macOS）：tag／來源檢查 → 程式檢查（`pnpm check`）→ 匯入固定身分 → `pnpm dist:mac` → 掛載驗證 → 候選 artifact。`build-windows`：相同的 tag／來源檢查與版本寫入，並拒絕不帶 Windows 建置的版本 → `pnpm check` → `pnpm dist:win` → `release.mts candidate-windows`，在 runner 上安裝、檢查並解除安裝安裝檔，寫出 `release-win32-x64.json` → 安裝檔的 build-provenance attestation（`actions/attest-build-provenance`）→ 自己的候選 artifact。接著 → 需要兩個建置的獨立 publish job 不用私鑰重驗（Windows 安裝檔因為不能在 macOS 上執行，只核對 bytes、紀錄與 checksum 那一行），寫出每個二進位資產一行的 SHA256SUMS，建立一個公開 release → `verify-published` job 以匿名身分從公開 release 網址下載該版本的 assets（`release.mts assets`）、核對 SHA256SUMS、重跑掛載／簽章／metadata 閘門並比對 GitHub 自己算的 asset digest（`release.mts published`），同時 `windows-2025` 上的 `verify-published-windows` 下載相同 assets，以 `Get-FileHash` 比對安裝檔在 SHA256SUMS 的那一行，執行 `gh attestation verify`，並安裝、檢查、解除安裝公開的安裝檔，要求 `app.asar` 雜湊與建置時記錄的相同（`release.mts published-windows`；只有 macOS 的 tag 在此沒有東西可查）→ 需要兩個驗證 job 的 `record` job 把發布事實寫回 main：package.json 版本、兩語言 README 的標記下載區塊、雙語驗證紀錄骨架，以及僅限穩定 tag 的網站 `website/release-manifest.json`（由 `release.mts record` 從同一份驗證 snapshot 產生，manifest 與 README 區塊只會移到較新的正式版；prerelease tag 仍有 record commit，但永不進入網站），以 `github-actions[bot]` 身分 commit → `deploy-website` job（僅穩定 tag）呼叫可重用的 `website.yml` workflow，由它 checkout main、驗證專案存取，再以釘版 Vercel CLI（`deploy --archive=tgz --prod`）提交原始碼。Vercel 安裝 `website/` 依賴，執行 `pnpm test && pnpm check`，含 manifest 線上驗證與建置 feed／連結檢查，通過後才上線。未設定 `VERCEL_TOKEN`、`VERCEL_ORG_ID` 或 `VERCEL_PROJECT_ID` 時略過並印出提示；只有 `contents: read`，絕不碰 release；網站失敗時 release 維持公開、前一版網站維持上線。建置 job 僅有 contents:read，`build-windows` 另有 attestation 所需的 id-token 與 attestations 寫入權限；publish 與 record job 有 contents:write；驗證 job 不需要 secrets 或寫入權限。簽署 secrets 只提供給 macOS build 的簽署 step；Windows 建置沒有任何 secret，因為其安裝檔依決策不簽章。任一建置或任一候選版重驗失敗，整個 tag 都在發布前失敗：1.1.1 之後的版本要嘛兩個平台都發布，要嘛都不發布。release environment 只允許 `v*` tag，由 repository 的可信任維護者控制。tag 發布共用一個 concurrency group `recordstuff-delivery`（加入 Windows 前名為 `recordstuff-macos-delivery`），執行中不取消；手動重驗使用自己的 group。GitHub 每個 group 只保留一個排隊中的 run，再有新的排入就會取消它，所以在發布執行時一次只推一個 tag；因此被取消的 tag 不會有 release 也不會有紀錄，可用 `gh run rerun <run-id>` 重新啟動。網站所有入口共用另一個正式部署 concurrency group，亦不取消執行中的部署；取得鎖後才 checkout 最新 main，避免較舊的排隊觸發還原舊產物。release job 明確呼叫共用 workflow，因為以 `GITHUB_TOKEN` 推送的 manifest commit 不會觸發 push workflow。

會停止發布的閘門，依序為：tag 指向的 commit 不是 `origin/main` 的祖先；tag 格式錯誤或比 package.json 最後記錄的版本舊；工作樹不乾淨；該 tag 已有 release（含 draft）；程式檢查失敗；缺 secrets 或匯入的憑證指紋不是 `01B373511530BBF287CA35E54C10A5F017AAD637`；bundle 簽章、identifier、hardened runtime 或 designated requirement 失敗；DMG 根目錄不是恰為 `Applications` 與 `RecordStuff.app` 加允許的隱藏 Finder 版面檔；App 版本或架構不符；重驗時候選 metadata 或 SHA256SUMS 不同；tag 不再指向已驗證的 commit。1.1.1 之後的版本，Windows 建置在下列情況也會停止發布：runner 不是 x64；安裝檔或安裝後的 `RecordStuff.exe` 的 Authenticode 狀態不是 `NotSigned`；每位使用者的靜默安裝失敗，或登記了全機（HKLM）解除安裝項目；HKCU 下不是恰好一個 DisplayVersion 等於該版本的解除安裝項目；`RecordStuff.exe` 的 PE machine 不是 x64 或 ProductVersion 不同；缺少系統匣 ICO 或開始選單捷徑；靜默解除安裝失敗，或留下 App、捷徑或登記；重驗時安裝檔的大小或 SHA-256 與 `release-win32-x64.json` 不同。沒有不用固定身分的 macOS 後備、部分驗證的後備，也沒有單一平台的後備路徑。

版本語意：tag 是版本的唯一來源。build job 在 `pnpm dist:mac` 與 `pnpm dist:win` 前把 tag 的版本寫入工作樹的 package.json（`release.mts version`），所以 App、安裝檔與紀錄都帶著它；repo 裡的 package.json 記錄最新的已記錄正式版供 `preflight` 使用：record job 只讓它前進、永不倒退，下載指標則依已提交的 manifest。`vX.Y.Z` 公開為最新版本；若已有更新的正式版公開，則維持為歷史版本（`--latest=false`），讓 app 更新檢查的備援目標「最新版本」永不倒退。`vX.Y.Z-suffix`（例如 `v0.2.0-rc.1`）公開時標為 pre-release，永不標為 latest，也不更新 package.json 與 README。後綴中的數字部分依 semver 不得有前導零（`rc.01` 會被拒絕），所以不會有兩個 tag 排序成同一版本。兩者使用相同的建置與閘門。資產組合依版本而定：1.1.1 及更早維持三個資產的契約（DMG、`release.json`、SHA256SUMS），讓 main 仍能驗證那些 tag；之後的每個版本（含預發布）有五個：這三個加上 `RecordStuff-<version>-x64-unsigned-setup.exe` 與 `release-win32-x64.json`。

憑證指紋固定。每次建置把加密 PKCS#12 匯入暫時 keychain，設定 codesign 金鑰存取與該憑證的 Code Signing 信任。trap 與 always cleanup 移除憑證檔、keychain 與信任。此設計支援可拋棄的 GitHub-hosted runner，持久 runner 需另行調整。

自 0.1.2 起，DMG 只包含 App 與 Applications 連結，背景是程式產生的拖曳箭頭；不附任何格式的說明文件。安裝、手動更新與移除指引放在[官網 Help](https://record.ericts.com/help)、發行說明及固定到 commit 的[安裝指南](../../../resources/INSTALL.zh-TW.md)。未來英文發行說明應同時連到官網 Help 與固定到 commit 的指南。Windows 安裝檔是每位使用者的一鍵 NSIS 安裝檔；其說明（SmartScreen、執行新安裝檔來手動更新、從「設定 → 應用程式」解除安裝、資料保留位置）放在同一份指南、Help 與發行說明的 Windows 段落。

## 網站交付

在儲存庫 Actions secrets 設定 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`；Vercel 專案 Root Directory 維持 `website/`，Git 自動部署維持關閉，避免重複部署。缺少 secret 時略過部署並印出提示。網站 push 與穩定版 App 發布共用相同的 manifest 線上驗證、網站測試、Astro 診斷、建置 feed 比對及產物連結檢查，這些檢查在 Vercel 建置環境執行，通過後產物才上線。非網站變更不觸發獨立網站部署；預覽版 tag 不呼叫它。補好 secrets 或修正部署失敗後，可重試：

```bash
gh workflow run website.yml --ref main
```

此 workflow 不建置、簽署或發布 App。部署後仍需驗證公開 feed 與實際 App 傳輸，才算通過更新交付驗收。

## 操作

驗證是開發活動，在 tag 存在之前完成。發布只是對已推送的 main 下兩個指令：

1. 執行 `pnpm start:app`（建置、簽署、驗證並打開 CI 將打包的同一個 App bundle），接著執行 `pnpm acceptance`：它用全域快捷鍵開始與停止一段錄影、驗證檔案的完整性層級，並把報告寫入 `docs/verification/measurements/`（本機、已 gitignore）。可選擇再讓 agent 依[原生驗收 skill](../../../.agents/skills/native-acceptance/SKILL.md) 讀取該報告，並以 `pnpm acceptance:playback` 檢查播放。`pnpm acceptance` 無法執行時（快捷鍵被拒、終端機沒有輔助使用權限、沒有 Chrome）改用人工後備：短錄影並播放。兩者都算完整的功能檢查；DMG 對 App 行為不增加任何資訊，CI 每次 tag 都會驗證 DMG 結構。只有在打包設定變更時（electron-builder 檔案、圖示、背景、DMG 版面）才另外執行 `pnpm dist:mac`，從 `dist/` 開啟 DMG，確認 Finder 視窗只有 App、箭頭與 Applications。沒有 Windows 步驟：沒有 Windows 機器，所以打 tag 前沒有人工 Windows smoke。Windows 打包有變更時，合併前在該分支 dispatch [check.yml](../../../.github/workflows/check.yml)，其 `check-windows` job 會建置安裝檔並執行相同的安裝／解除安裝閘門。因此每個版本的紀錄都必須把 Windows 上的擷取、系統音訊、通知與系統匣列為未經實機驗證。
2. 在已推送的 commit 上打下一個未用過的版本 tag 並推送。repo 裡事先不需要寫版本號。

```bash
git tag v0.1.3
git push origin v0.1.3
gh run watch --exit-status "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

run 完成後，`gh release view v0.1.3` 顯示公開 release 與其 assets（1.1.1 及更早為三個，之後的版本為五個），main 上多出 record job 的 `docs(release): record published v0.1.3` commit，含 package.json 0.1.3、兩語言 README 下載區塊，以及 `docs/verification/releases/0.1.3.md` 與其翻譯。pull main 後，依步驟 1 實際做過的事填寫紀錄的「打 tag 前的本機驗收」與「未記錄」段落（驗收 skill 會把摘要寫在那裡，人工後備則手動填寫）；產生的骨架絕不宣稱未執行的檢查。`verify-published` 與 `verify-published-windows` job 就是下載檢查：它們抓取匿名使用者會拿到的檔案，在 GitHub 的網路上重跑所有產物閘門，本機不需要再下載。若它失敗，release 仍為公開，由維護者決定發修正版或保留；此 job 絕不撤回發布。之後要重驗既有版本，以其 tag dispatch workflow；兩個驗證 job 都會執行，各自依該版本的資產組合：

```bash
gh workflow run release.yml --ref main -f tag=v0.1.2
```

回滾就是發新版本：絕不覆寫、刪除或重打已公開的 release。若 workflow 在公開前失敗，修正原始碼、升版本、重新打 tag；失敗 run 的 tag 可留可刪，但一旦該版本存在任何 release 物件（即使不完整），版本號不得再用於發布。若 run 在建立 release 物件後才失敗，該版本視為已消耗，人工處理不完整的 release。不要以移除檢查解決發布問題。

## 工具邊界與失敗

`node scripts/release.mts preflight|version|candidate|candidate-windows|verify|publish|published|published-windows|record|assets vX.Y.Z [directory]`，或 `windows-smoke [directory]`，共用本機與 CI 驗證。`preflight` 要求乾淨工作樹、tag 不比 package.json 最後記錄的版本舊，以及未用過的 release。`version` 把 tag 的版本寫入工作樹的 package.json 供建置。`record` 讀取已提交的正式版 manifest 與公開 release，寫入缺少的驗證紀錄；正式版 tag 另外讓 package.json 前進，並只在上述 promoted、unchanged 或 historical-only 結果允許時寫入正式版網站 manifest 與 README 的標記區塊（`<!-- release-download:start/end -->`）；絕不覆寫既有紀錄。`candidate` 在最終 DMG bytes 上產生 `SHA256SUMS`、`release.json`，記錄版本、source commit、repository、平台、檔名、大小、SHA-256、憑證指紋、app.asar 雜湊、Node 與 pnpm。`verify` 以這些檔案重驗候選目錄。`published` 對從公開網址下載的檔案做同樣檢查，版本取自 tag、source commit 取自 tag 指向的 commit（因此在 main checkout 上可用目前工具驗任何舊版本），並額外要求 GitHub release 非 draft、恰有該版本的資產組合，且名稱、大小與 GitHub 計算的 SHA-256 digest 相符；1.1.1 之後的版本還會以 `release-win32-x64.json` 與 SHA256SUMS 核對 Windows 安裝檔。`assets` 印出一個 tag 的資產名稱，供 workflow 下載。Windows 模式需要 Windows x64 主機，在 CI 執行：`candidate-windows` 靜默安裝、檢查（上述閘門）並解除安裝，再寫出 `release-win32-x64.json`，記錄版本、source commit、repository、平台、檔名、大小、SHA-256、安裝後的 `app.asar` 雜湊、簽章狀態 `unsigned`、Node 與 pnpm；`published-windows` 以紀錄、SHA256SUMS 與 GitHub digest 核對下載的安裝檔，再重跑安裝閘門並要求相同的 `app.asar` 雜湊；`windows-smoke` 不需 tag，對 `pnpm dist:win` 剛建好的安裝檔執行安裝閘門，並拒絕已裝有 RecordStuff 的機器。同一版本的兩個 `app.asar` 雜湊分別記錄在兩份紀錄中，不強制相同。`publish` 重驗、確認 tag 指向已驗證 commit、寫出英文說明（1.1.1 之後的版本含 macOS、Windows 與 Verify 段落），並以 `gh release create --verify-tag`（`--latest`、比已公開正式版舊的正式版用 `--latest=false`，或 `--prerelease`）建立公開 release。

`start-app.mjs --verify-app APP_PATH` 只使用 `RECORDSTUFF_SIGN_IDENTITY` 公開 SHA-1，重用原本的深度簽章、憑證、identifier、runtime 與 designated requirement 驗證，不需要私鑰、不建置、不啟動 App。`assertDmgContents` 要求根目錄恰為 `Applications` 與 `RecordStuff.app`，隱藏項目最多只能是一般檔案 `.DS_Store`、`.VolumeIcon.icns` 與 `.background.png`／`.background.tiff`；任何其他項目、任何隱藏資料夾或符號連結，或以 `.` 開頭藏起來的指南，都會讓發布失敗。

CI 無法證明螢幕或系統音訊擷取：runner 沒有 TCC 授權。這是錄影必須在打 tag 前於本機檢查的原因，而且只在 macOS 上。CI 證明的是：已提交的原始碼可建置、以固定身分簽署、打包成預期版面，且公開的 bytes 就是驗證過的 bytes；對 Windows 而言，是未簽章的安裝檔能以每位使用者模式安裝、登記、符合其紀錄與 attestation，並能乾淨地解除安裝。Windows App 從未啟動，所以它執行時的任何行為都沒有證明。

Apple 公證、Windows 程式碼簽章、App 自動更新、Intel Mac 與 Windows on Arm 交付、Windows 實機驗證與免警告安裝仍在範圍外。T3 Code 比較見[簽署設計](signing.md)。

frozen 安裝後，CI 明確執行 Electron 44 的 install.js，因為套件沒有 postinstall。cleanup-release-keychain.py 把每個 OS 清理操作限制在 15 秒內，失敗時警告並移除暫存檔，但信任移除失敗時保留憑證，讓第二次清理重試；可拋棄 runner 的銷毀處理其餘 OS 狀態。

本機執行 `verify` 或 `publish` 時，工作樹必須 checkout 到 release.json 的 source commit；main 上後續文件提交不會改變候選產物。1.1.1 之後版本的本機 `publish` 還需要目錄裡有 CI 建置的 Windows 候選版與其紀錄。
