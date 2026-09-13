# 009 選配的 Apple 認證發行

狀態：擱置（2026-09-13；使用者目前只需本機自簽與少量分享，不加入付費 Apple Developer Program）
前置：006；兩平台公開版本另需 005
對應：001 §15 的選配發行升級

## 範圍

將 006 原本的 Developer ID Application、Apple 公證與免人工例外的 Gatekeeper 驗收保留在這裡。不是 006 或自簽試用版的前置，只有使用者決定採用 Apple 認證發行時才開始。

## 屆時執行

1. 確認付費 Apple Developer Program 與 Account Holder 身分，取得 Developer ID Application 憑證、配對私鑰及公證認證；不將機密寫入 repo。
2. 以獨立發行流程打包 DMG、驗證 hardened runtime／entitlements、Developer ID 簽章、公證與 stapled ticket。既有 `pnpm dist:mac` 是配置起點，不是已通過的發行流程；補齊缺少憑證／公證失敗就停止的要求。
3. 驗證本機自簽 → Developer ID 的授權身分切換；在新帳號與另一台 Mac 重跑首次權限、音訊、通知、安裝與錄製，不沿用 006 的自簽結果宣稱通過。
4. 驗證帶正常下載 quarantine 的產物不需人工安全例外即可啟動，記錄 `codesign`、`spctl` 與公證結果；同步 README、001 與 plans 索引。

## 完成標準

實際發行產物簽章／公證／Gatekeeper 與新機錄製驗收全部通過；僅建立憑證或建出 DMG 不算完成。若屆時也發 Windows 版，須另外完成 005 與相應 Windows 發行驗收。
