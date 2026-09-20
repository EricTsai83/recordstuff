# GitHub 發布自動化

[English](../../system-design/releases.md) | [繁體中文](releases.md)

更新：2026-09-19。推送版本 tag 是唯一的發布動作，而且 tag 就是版本：CI 在一次執行中把它寫入建置、簽署、驗證、公開、重驗公開下載，並把事實回寫到 main。含 pipeline 內人工驗收閘門的 draft／promote 流程用於 [0.1.1](../verification/releases/0.1.1.md)，並在準備 0.1.2 的同一天退役；人工檢查改在打 tag 之前進行。[0.1.2](../verification/releases/0.1.2.md) 是此流程的第一個版本：從推送 tag 到公開不到三分鐘。

## 發布契約

[release.yml](../../../.github/workflows/release.yml) 只在推送 `v*` tag 時建置與發布。沒有分支或 PR 觸發，所以一般 commit 到 main 不會建置或發布任何東西。以既有 tag 手動 dispatch 只會執行發布後驗證 job，不會建置或發布；其選用的 `deploy-website` 輸入會另外從 main 重建並重新部署網站，這是純網站內容修改不發版就能上線的方式。使用 `macos-15`，執行時要求 arm64；Node 24.21.0、pnpm 10.33.4 與 frozen lockfile。Actions 固定完整 commit SHA，更新時需重新檢查上游版本。

單次 workflow 的順序：tag／來源檢查 → 程式檢查（`pnpm check`）→ 匯入固定身分 → `pnpm dist:mac` → 掛載驗證 → 候選 artifact → 獨立 publish job 不用私鑰重驗後建立公開 release → `verify-published` job 以匿名身分從公開 release 網址下載三個 assets、核對 SHA256SUMS、重跑掛載／簽章／metadata 閘門並比對 GitHub 自己算的 asset digest（`release.mts published`）→ `record` job（僅穩定 tag）把發布事實寫回 main：package.json 版本、兩語言 README 的標記下載區塊、雙語驗證紀錄骨架，以 `github-actions[bot]` 身分 commit；此 job 在穩定 tag 時同時以 `website/scripts/manifest.mts generate` 從公開 release 重新產生網站的 `website/release-manifest.json` 並一起提交（prerelease tag 仍有 record commit，但永不進入網站）→ `deploy-website` job（僅穩定 tag）checkout 該 main、安裝、測試並建置 `website/`（建置前先對公開 release 重新驗證 manifest），再以釘版的 Vercel CLI（`pull`、`build`、`deploy --prebuilt --prod`）部署到維護者的 Vercel 專案。未設定 `VERCEL_TOKEN`、`VERCEL_ORG_ID` 或 `VERCEL_PROJECT_ID` 時略過並印出提示；只有 `contents: read`，絕不碰 release；網站失敗時 release 維持公開、前一版網站維持上線。build job 僅有 contents:read；publish 與 record job 有 contents:write；驗證 job 不需要 secrets 或寫入權限。Secrets 只提供給 build 的簽署 step。release environment 只允許 `v*` tag，由 repository 的可信任維護者控制。全發布 workflow 共用 concurrency group，執行中不取消。

會停止發布的閘門，依序為：tag 指向的 commit 不是 `origin/main` 的祖先；tag 格式錯誤或比 package.json 最後記錄的版本舊；工作樹不乾淨；該 tag 已有 release（含 draft）；程式檢查失敗；缺 secrets 或匯入的憑證指紋不是 `01B373511530BBF287CA35E54C10A5F017AAD637`；bundle 簽章、identifier、hardened runtime 或 designated requirement 失敗；DMG 根目錄不是恰為 `Applications` 與 `RecordStuff.app` 加允許的隱藏 Finder 版面檔；App 版本或架構不符；重驗時候選 metadata 或 SHA256SUMS 不同；tag 不再指向已驗證的 commit。沒有未簽署或部分驗證的後備路徑。

版本語意：tag 是版本的唯一來源。build job 在 `pnpm dist:mac` 前把 tag 的版本寫入工作樹的 package.json（`release.mts version`），所以 App、DMG 與 metadata 都帶著它；repo 裡的 package.json 只記錄最後公開的穩定版本，由 record job 更新。`vX.Y.Z` 公開為最新版本。`vX.Y.Z-suffix`（例如 `v0.2.0-rc.1`）公開時標為 pre-release，永不標為 latest，也不更新 package.json 與 README。兩者使用相同的建置與閘門。

憑證指紋固定。每次建置把加密 PKCS#12 匯入暫時 keychain，設定 codesign 金鑰存取與該憑證的 Code Signing 信任。trap 與 always cleanup 移除憑證檔、keychain 與信任。此設計支援可拋棄的 GitHub-hosted runner，持久 runner 需另行調整。

自 0.1.2 起，DMG 只包含 App 與 Applications 連結，背景是程式產生的拖曳箭頭；不附任何格式的說明文件。安裝、手動更新與移除指引放在[官網 Help](https://record.ericts.com/help)、發行說明及固定到 commit 的[安裝指南](../../../resources/INSTALL.zh-TW.md)。未來英文發行說明應同時連到官網 Help 與固定到 commit 的指南。

## 操作

驗證是開發活動，在 tag 存在之前完成。發布只是對已推送的 main 下兩個指令：

1. 執行 `pnpm start:app`（建置、簽署、驗證並打開 CI 將打包的同一個 App bundle），接著執行 `pnpm acceptance`：它用全域快捷鍵開始與停止一段錄影、驗證檔案的完整性層級，並把報告寫入 `docs/verification/measurements/`（本機、已 gitignore）。可選擇再讓 [computer-use 驗收 skill](../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) 讀取該報告並在 QuickTime 播放。`pnpm acceptance` 無法執行時（快捷鍵被拒、終端機沒有輔助使用權限、沒有 Chrome）改用人工後備：短錄影並播放。兩者都算完整的功能檢查；DMG 對 App 行為不增加任何資訊，CI 每次 tag 都會驗證 DMG 結構。只有在打包設定變更時（electron-builder 檔案、圖示、背景、DMG 版面）才另外執行 `pnpm dist:mac`，從 `dist/` 開啟 DMG，確認 Finder 視窗只有 App、箭頭與 Applications。
2. 在已推送的 commit 上打下一個未用過的版本 tag 並推送。repo 裡事先不需要寫版本號。

```bash
git tag v0.1.3
git push origin v0.1.3
gh run watch --exit-status "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

約四分鐘後 `gh release view v0.1.3` 顯示公開 release 與三個 assets，main 上多出 record job 的 `docs(release): record published v0.1.3` commit，含 package.json 0.1.3、兩語言 README 下載區塊，以及 `docs/verification/releases/0.1.3.md` 與其翻譯。pull main 後，依步驟 1 實際做過的事填寫紀錄的「打 tag 前的本機驗收」與「未記錄」段落（驗收 skill 會把摘要寫在那裡，人工後備則手動填寫）；產生的骨架絕不宣稱未執行的檢查。`verify-published` job 就是下載檢查：它抓取匿名使用者會拿到的檔案，在 GitHub 的網路上重跑所有產物閘門，本機不需要再下載。若它失敗，release 仍為公開，由維護者決定發修正版或保留；此 job 絕不撤回發布。之後要重驗既有版本，以其 tag dispatch workflow：

```bash
gh workflow run release.yml --ref main -f tag=v0.1.2
```

回滾就是發新版本：絕不覆寫、刪除或重打已公開的 release。若 workflow 在公開前失敗，修正原始碼、升版本、重新打 tag；失敗 run 的 tag 可留可刪，但一旦該版本存在任何 release 物件（即使不完整），版本號不得再用於發布。若 run 在建立 release 物件後才失敗，該版本視為已消耗，人工處理不完整的 release。不要以移除檢查解決發布問題。

## 工具邊界與失敗

`node scripts/release.mts preflight|candidate|verify|publish vX.Y.Z [directory]` 共用本機與 CI 驗證。`preflight` 要求乾淨工作樹、tag 不比 package.json 最後記錄的版本舊，以及未用過的 release。`version` 把 tag 的版本寫入工作樹的 package.json 供建置。`record` 讀取公開 release，寫入 package.json、README 的標記區塊（`<!-- release-download:start/end -->`）與缺少的驗證紀錄；絕不覆寫既有紀錄。`candidate` 在最終 DMG bytes 上產生 `SHA256SUMS`、`release.json`，記錄版本、source commit、repository、平台、檔名、大小、SHA-256、憑證指紋、app.asar 雜湊、Node 與 pnpm。`verify` 以這些檔案重驗候選目錄。`published` 對從公開網址下載的檔案做同樣檢查，版本取自 tag、source commit 取自 tag 指向的 commit（因此在 main checkout 上可用目前工具驗任何舊版本），並額外要求 GitHub release 非 draft、恰有這三個 assets，且名稱、大小與 GitHub 計算的 SHA-256 digest 相符。`publish` 重驗、確認 tag 指向已驗證 commit、寫出英文說明，並以 `gh release create --verify-tag`（`--latest` 或 `--prerelease`）建立公開 release。

`start-app.mjs --verify-app APP_PATH` 只使用 `RECORDSTUFF_SIGN_IDENTITY` 公開 SHA-1，重用原本的深度簽章、憑證、identifier、runtime 與 designated requirement 驗證，不需要私鑰、不建置、不啟動 App。`assertDmgContents` 要求根目錄恰為 `Applications` 與 `RecordStuff.app`，隱藏項目最多只能是一般檔案 `.DS_Store`、`.VolumeIcon.icns` 與 `.background.png`／`.background.tiff`；任何其他項目、任何隱藏資料夾或符號連結，或以 `.` 開頭藏起來的指南，都會讓發布失敗。

CI 無法證明螢幕或系統音訊擷取：runner 沒有 TCC 授權。這是錄影必須在打 tag 前於本機檢查的原因。CI 證明的是：已提交的原始碼可建置、以固定身分簽署、打包成預期版面，且公開的 bytes 就是驗證過的 bytes。

Apple 公證、App 自動更新、Windows／Intel 交付與免警告安裝仍在範圍外。T3 Code 比較見[簽署設計](signing.md)。

frozen 安裝後，CI 明確執行 Electron 44 的 install.js，因為套件沒有 postinstall。cleanup-release-keychain.py 把每個 OS 清理操作限制在 15 秒內，失敗時警告並移除暫存檔；可拋棄 runner 的銷毀處理其餘 OS 狀態。

本機執行 `verify` 或 `publish` 時，工作樹必須 checkout 到 release.json 的 source commit；main 上後續文件提交不會改變候選產物。
