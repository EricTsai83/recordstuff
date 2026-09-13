# 貢獻與翻譯

[English](../../CONTRIBUTING.md) | [繁體中文](CONTRIBUTING.md)

repo 的正式語言是英文，包含 README、system design、計畫、開發指示、程式註解、診斷輸出及新的 issue／PR 描述。繁體中文透過獨立翻譯支援；英文版有優先解釋權。

## 文件對應

| 英文正式版 | 繁體中文 |
| --- | --- |
| README.md | README.zh-TW.md |
| CONTRIBUTING.md | docs/zh-TW/CONTRIBUTING.md |
| docs/system-design/*.md | docs/zh-TW/system-design/*.md |
| docs/verification/README.md | docs/zh-TW/verification/README.md |
| plans/*.md | docs/zh-TW/plans/*.md |
| resources/INSTALL.md | resources/INSTALL.zh-TW.md |

每份面向讀者的文件頂端提供切換語言連結。行為、範圍、指令與路徑改動時同步兩版，連結要從各自目錄正確解析。程式識別字、路徑、指令、hash 不翻譯。

歷史原始量測保留原語言與數據，由雙語驗證摘要解釋；catalog、翻譯測試及刻意測 CJK 清晰度的素材也可包含中文。不可為了去除中文而改寫歷史測量結果。

## App 翻譯

英文文案是 src/shared/i18n.ts 中具型別的 key，ZH_TW 提供相同 placeholder 的繁體中文翻譯。避免拼接難以翻譯的片語；與 OS 語言無關，App 一律預設英文。

保存成功才切換語言。選單、tooltip、對話框、通知與使用者復原說明需翻譯；診斷與新的量測輸出維持英文。原生 OS 提示依系統語言。技術錯誤細節留在 log，不混進中文錯誤摘要。

新文案需補兩種語言並檢查 placeholder 一致；新設定需驗舊檔預設、保存、失敗不改值與必要的並行更新。

## 檢查與計畫維護

App 改動後執行 pnpm check，交付前執行 git diff --check；搬文件要驗連結与翻譯對應。媒體行為改動需適當錄製量測，不能把未驗平台寫成通過。

永久設計與證據放 docs；plans 只留未完成工作。完成後將結果移入正式文件、刪除已完成計畫及翻譯、更新索引。未收到要求，不 commit、push 或發布。
