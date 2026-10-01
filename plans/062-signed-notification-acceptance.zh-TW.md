# 062 — 完整簽章的通知驗收 fixture

[English](062-signed-notification-acceptance.md) | [繁體中文](062-signed-notification-acceptance.zh-TW.md)

狀態：提案。相依：無。此計畫修復已確認的驗收前置條件與結果判定缺陷，獨立於 061 及 058–060 Playwright 遷移，優先處理。

## 問題與證據

在 revision `1108b031a317a1a2e12e1567c7edc34d1529cddf`，`scripts/acceptance-quit-dialog.mts` 建置合成資料 fixture 後，直接啟動 node_modules 的 Electron executable。這條路徑沒有像 `pnpm start:app` 一樣提供完整簽章的 App bundle，因此生命週期檢查可能通過，macOS 卻拒絕通知。

2026-10-01 的 A/B/A 對照使用相同 Electron.app 副本路徑、bundle identifier `com.github.Electron` 與 fixture。原始 linker/ad-hoc 簽章收到 `UNErrorDomain 1`；使用既有 RecordStuff Dev 身分完整簽章後，中英文通知都被接受；還原原始副本後再次被拒絕。macOS 日誌由 `requestAuthorization/addRequest not allowed` 變為 bundle identifier 比對成功與橫幅顯示。四輪生命週期皆正常退出。這證明完整簽章條件的效果，未再細分憑證、Info.plist 與資源封裝各自的必要性。

本機證據位於被 gitignore 的 `docs/verification/measurements/2026-10-01-notification-signing-comparison/`；即使沒有那些檔案，本摘要仍可使用。沒有變更通知設定、系統信任、TCC 或 private entitlement。因原生觀察工具無法存取 NotificationCenter，橫幅實際可讀性仍 blocked；shown 事件或系統顯示日誌不是視覺證據。參考 [Electron Notification 契約](https://www.electronjs.org/docs/latest/api/notification)。

## 範圍與產物契約

修復隔離的延後退出通知 runner 及其操作說明。保留合成 bytes、隔離 userData、正式 feedback／Recorder／FileWriter／退出協調器及程序 ownership 管理。一般 Settings fixture 不因使用 Electron 就必須簽章。產品擷取、存檔通知投遞、Electron 升級、CI workflow 與 Playwright 遷移不在範圍。

一般原生 App 驗收使用待驗收版本的 `pnpm start:app` 產物與既有簽章身分。可以驗收開發分支與尚未提交的修復；報告須記錄 commit、dirty 狀態／內容身分、依賴、fixture hash、bundle 路徑／identifier 及所選公開憑證 fingerprint。合併後／發布驗收依既有發布規則使用指定 main commit 或 release candidate。分支名稱不能單獨證明產物新鮮度或簽章有效。

此合成 fixture 在每輪獨立目錄準備私有 Electron.app 副本，啟動前簽章並驗證。不得修改 node_modules、一般 dist 產物、已安裝 App 或使用者偏好。沿用對照已證實有效的 bundle identifier 與啟動契約；變更 identifier 須另驗權限與通知歸屬。使用既有 RecordStuff Dev 身分或 `RECORDSTUFF_SIGN_IDENTITY` 選擇，沿用憑證有效期／歧義檢查。測試準備不得建立／匯入憑證、修改信任或加入 private entitlement。

從 `scripts/start-app.mjs` 重用最小合適的簽章／驗證支援；若需抽取共用邏輯，保留一般打包的行為與測試。驗證必須拒絕僅 ad-hoc 的簽章，以 `codesign --verify --deep --strict` 檢查 bundle 完整性，並確認外層 bundle 與相關巢狀程式使用所選身分。簽章指令 exit 0 不足以證明可用。避免另外建立未簽章 fallback 或新打包 workflow。

## 結果與收尾

| 證據 | 必要判定 |
| --- | --- |
| 簽章身分缺少、無法使用或等待使用者權限 | blocked（exit 2），附原因；不啟動 fixture |
| 選到有效身分後，簽章／驗證失敗 | fail（exit 1）；不啟動 fixture |
| 生命週期／timer／bytes 或程序收尾失敗 | fail（exit 1），不受通知或桌面狀態掩蓋 |
| notification failed | 投遞不可 pass；明確 OS 授權拒絕為 blocked，其他通知錯誤為 fail；保留原始錯誤與分類原因 |
| 收到 notification show 事件 | 投遞事件證據通過；橫幅可見性／可讀性另列 |
| 有界觀察時間內沒有 show 或 failed 事件 | 投遞 incomplete，exit 1；不得默認成功 |
| 必要視覺證據無法取得 | 視覺 blocked／not run，附原因；不得宣稱完整原生驗收通過 |

JSON 與 Markdown 分開記錄生命週期、通知事件／投遞、視覺觀察及收尾。自動 runner 僅在未鎖定桌面上通過必要生命週期、投遞事件與收尾檢查後可 exit 0；須標示為自動證據，視覺觀察仍明列待驗。Agent 的綜合原生判定納入必要視覺結果，因此自動 exit 0 後仍可能 blocked。show 事件不能證明畫面只有一則橫幅或文字可讀。任何非預期 fail 優先於 blocked。

證據收集失敗時仍保留結果。提出通知請求不能代替投遞。準備／啟動／通知等待皆有界，涵蓋複製／簽章／驗證期間取消。程序結束後只清理本輪 owned 程序及暫存產物，保留診斷證據。工具／權限缺少須記錄，不繞過。沿用桌面交接、鎖定保護及 caffeinate 規則。

## 實作

- [ ] 核對目前 runner／fixture 與簽章呼叫端；選擇最小共用身分／簽章支援，保留一般打包行為。
- [ ] 加入每輪 Electron bundle 準備、完整簽章、身分／完整性 preflight 與來源報告。沿用 scrubbed environment 與程序管理，只啟動已驗證副本的 executable。
- [ ] 保存結構化通知事件與有界投遞結果；生命週期 PASS 不可掩蓋投遞失敗，視覺證據獨立。
- [ ] 以針對性測試覆蓋缺少／歧義／過期身分、簽章失敗、拒絕 ad-hoc、完整性／身分不符、通知 failed／missing／shown、鎖定桌面與失敗優先序。確認 preflight 失敗不啟動，以及準備失敗、逾時與中斷的收尾。
- [ ] 依序執行實作後的中英文指令，確認投遞被接受、合成 bytes／timer 行為不變及收尾完整。可行時依專案 Astra computer-use skill 觀察橫幅，明確保留視覺 blocker。
- [ ] 更新雙語測試、工具與驗收說明，以及 `.agents/skills/astra-acceptance-with-computer-use/SKILL.md`。寫明簽章產物規則、分支／來源區別與三層證據；將根因摘要與最終結果寫入耐久驗證文件，不改寫歷史 blocked 結果。

## 驗證與完成

依實作 diff 套用[共用測試規則](../docs/zh-TW/testing.md)：相關工具測試與 TypeScript 的 `pnpm typecheck`；執行雙語 fixture 及變更的失敗／中斷／收尾案例。若修改一般 build 共用的簽章支援，執行相關檢查、`pnpm check`，並在桌面交接後以新 `pnpm start:app` 產物驗證簽章，最後退出並確認程序結束。未受影響的 A/B/A 根因診斷可重用，不預設再跑。只改 fixture 準備／報告且產品 runtime 不變時，不需錄影 smoke、capture matrix、音訊、CPU 或 Settings regression；增加 runtime 修改須重新分類。

完成條件：標準指令自動提供完整且已驗證的簽章；無效前置條件不能啟動 fixture；通知失敗不能產生自動 PASS；生命週期、投遞、視覺及收尾證據分明；依序中英文回合滿足自動契約。若視覺工具仍不可用，記錄明確的剩餘視覺缺口，不宣稱完整原生驗收。簽章前置條件缺少時，實作的原生驗證為 blocked，不能當作完成。

交付：修復 runner 與最小支援、回歸測試、一致說明、來源／結果報告及耐久根因／驗證紀錄。移除此計畫與翻譯前遵守[計畫完成規則](README.zh-TW.md#完成計畫)。僅建立本文不代表修復已實作或驗證。
