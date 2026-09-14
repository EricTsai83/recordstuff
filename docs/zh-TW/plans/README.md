# 剩餘工作

[English](../../../plans/README.md) | [繁體中文](README.md)

更新：2026-09-15。已完成計畫已由 [system design](../system-design/README.md) 與 [驗證紀錄](../verification/README.md) 取代。Windows 驗收及 Apple 認證發行依使用者決定取消；舊 roadmap 不再作為排程，產品邊界與演進條件保留於設計決策。

| 順序 | 計畫 | 狀態 | 交付目標 |
| --- | --- | --- | --- |
| 1 | [010 macOS 下載版](010-downloadable-macos-release.md) | 待執行，優先 | 本機建置驗證第一版 arm64 自簽包，發布 DMG／checksum／說明至 GitHub Releases，驗實際下載安裝 |
| 010 之後 | [011 GitHub 發布自動化](011-github-release-automation.md) | 後續選項 | 可重複產生候選包並明確提升發布，保留固定簽署身分與驗證 |
| 010 之後 | [012 官網與下載入口](012-download-website.md) | 後續選項 | 雙語產品頁連到已驗 GitHub 下載 |

## 排序理由

眼前目標是讓別人能下載、安裝並使用。010 原本就負責完整交付，現在明定公開的 `EricTsai83/recordstuff` 為發布目的地，不再拆出重複的「第一次發布」計畫。本機打包加 GitHub Release 就能完成第一版，不必等 CI 或官網。

010 完成後，重複發布需要省工時選 011，需要產品介紹入口時選 012。兩者彼此獨立，沒有固定先後，也不是第一次發布的要求。App 自動更新、擴充平台與 Apple 認證仍不在範圍內。本次只有規劃，尚未發布 Release 或部署網站。

repo 文件與 App 英文／繁體中文功能已實作於工作目錄；下一份安裝包仍需重建驗證，舊 DMG 不是新的雙語版本。

完成計畫後更新 README、設計、驗證紀錄與翻譯，再刪除計畫及對應翻譯。執行歷史由 Git 保留，不繼續把已完成 checklist 當產品規格。
