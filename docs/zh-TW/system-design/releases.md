# GitHub 發布自動化

[English](../../system-design/releases.md) | [繁體中文](releases.md)

更新：2026-09-15。CI、人工驗收及公開提升已通過；待最後瀏覽器下載 checksum，真實執行證據見 [0.1.1](../verification/releases/0.1.1.md)。人工安裝驗收已由使用者確認，已安裝 App 身分核對通過。

## 發布契約

[release.yml](../../../.github/workflows/release.yml) 使用 `macos-15`，執行時要求 arm64；Node 24.21.0、pnpm 10.33.4 與 frozen lockfile 沿用 010。Actions 固定完整 commit SHA，更新時需重新檢查上游版本。現在的 DMG 仍包含 App、Applications 連結與雙語安裝說明；013 尚未交付。

流程為「版本／來源檢查 → 程式檢查 → 匯入同一身分 → `pnpm dist:mac` → 掛載驗證 → 候選 artifact → 獨立 job 再驗 → draft」。build job 僅有 contents:read；draft／promote job 才有 contents:write。Secrets 只提供給 build 的簽署 step；不設 PR 觸發。release environment 只允許 main 與 v* tag；repository 的可信任維護者控制這些 refs。全發布 workflow 共用 concurrency group，執行中不取消，避免同時覆蓋版本。

自簽指紋固定 `01B373511530BBF287CA35E54C10A5F017AAD637`。每次匯入加密 `.p12` 到暫存 keychain，限制 codesign 私鑰存取，僅對該憑證配置 Code Signing 信任；缺少 secrets 或身分不符會停止，不產生未簽署替代品。trap 與 always cleanup 清理憑證、keychain 及信任；僅支援可銷毀的 GitHub-hosted runner，不直接套用持久 runner。

## 操作

先修改 package.json 到未用過的正式版本，完成檢查並提交／推送 main。手動建立候選版：

```bash
gh workflow run release.yml --ref main -f operation=candidate -f tag=v0.1.1
```

也可推送與 package.json 相符的 `vX.Y.Z` tag。任何既有 draft 或公開 Release 都視為已使用版本；不覆寫、不自動刪除。若僅留下 tag，只有它指向相同 source commit 才可建立 draft。CI artifact 成功後由 draft job 建立缺少的 tag；GitHub token 建立 tag 不會另觸發重複建置。

下載 draft 的全部三個 assets，確認 checksum，掛載並安裝 DMG，測試錄影、系統音訊播放、語言切換／重開保存、選單退出與重啟。保留原有通知 Finder 未置前的限制說明。

```bash
gh release download v0.1.1 --dir /tmp/recordstuff-candidate-0.1.1
cd /tmp/recordstuff-candidate-0.1.1
shasum -a 256 -c SHA256SUMS
```

只有上述人工驗收完成後，才在 Actions 選 promote，填入**實際安裝候選包的 SHA-256** 並勾選 manual_acceptance。或執行：

```bash
gh workflow run release.yml --ref main -f operation=promote -f tag=v0.1.1 -f sha256=ACTUAL_VERIFIED_SHA256 -f manual_acceptance=true
```

這是操作者對該份候選包的驗收聲明，CI 無法自行證明人工操作。promote checkout 候選 tag，下載既有 draft，重驗簽章、掛載內容、metadata、SHA256SUMS、tag source 與 GitHub asset digest，才把 draft 改成公開；不打包、不替換 assets。公開後仍需瀏覽器下載／hash 核對，不能把 API 下載當作瀏覽器安裝證據。

## 工具邊界與失敗處理

`node scripts/release.mts preflight|candidate|verify|draft|promote vX.Y.Z [directory]` 共用本機與 CI 驗證。`candidate` 在最終 DMG bytes 上產生 `SHA256SUMS`、`release.json`，記錄版本、source commit、repository、平台、檔名、大小、SHA-256、憑證指紋、app.asar hash、Node／pnpm。

`start-app.mjs --verify-app APP_PATH` 只使用 `RECORDSTUFF_SIGN_IDENTITY` 公開 SHA-1，重用原本的深度簽章、憑證、identifier、runtime 與 designated requirement 驗證，不需要私鑰、不建置、不啟動 App。verify／draft／promote 都檢查 DMG 檔案系統、App 版本及 arm64、安裝指南 bytes、Applications 連結與可見根目錄內容。

版本錯誤、重複版本、缺身分、簽章／checksum／metadata 不符都停止。上傳中途失敗可能留下不完整 draft；不會公開。先保留失敗證據並人工處理該 draft，再決定重試或採用新版本。不要以移除檢查解決發布問題。

本流程沒有 Apple 公證、App 自動更新、Windows／Intel 發行或無提示安裝。T3 Code 的參考與差異見 [簽署設計](signing.md)。

CI 在 frozen install 後明確執行 Electron 44 的 `install.js`，因套件沒有 postinstall。`cleanup-release-keychain.py` 對系統清理設定每項 15 秒上限；逾時會警告並清除暫存檔，殘餘系統狀態由 disposable runner 銷毀清除。

本機執行 verify／draft／promote 時，工作樹必須 checkout 到 release.json 的 source commit；CI 已自動 checkout 候選 tag。main 上後續文件提交不會改變已建候選產物。
