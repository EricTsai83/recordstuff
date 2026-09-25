---
name: astra-acceptance-with-computer-use
description: 由 Codex GPT-6 Astra（預設 medium reasoning）使用 computer use 驗收 RecordStuff 透過 pnpm start:app 建置啟動的 macOS 原生選單列 App，操作錄製、存檔、播放及相關 UI 回歸並留下證據。適用於要求實際操作 App、桌面驗收或功能 smoke test；不以單元測試、瀏覽器頁面或錄製腳本代替原生 UI 驗收。
---

# Astra Acceptance with Computer Use

以使用者操作路徑驗收目前原始碼建置的 App。以使用者的語言回報：依要求本次驗收的訊息判斷（語言混用時依主要敘述語言），整輪維持同一語言，使用者改用其他語言時跟著改；技術用語可保留英文；英文使用者改用 [testing](../../../docs/testing.md) 與 [acceptance](../../../docs/acceptance.md) 的英文版本與其報告範本。只有建立或修改本 skill 的請求，不代表要立即啟動錄影驗收。

先依[共用測試規則](../../../docs/zh-TW/testing.md)選定範圍；案例、預期結果及報告格式以[共用驗收指南](../../../docs/zh-TW/acceptance.md)為準。本 skill 補充 Astra 與原生工具的執行方式，不另定測試門檻。純文件修改不啟動 App；純設定 UI 驗收不因使用本 skill 就加入錄影。

## Codex GPT-6 Astra 執行

使用 **`gpt-6-astra`、medium reasoning** 執行 computer use。若目前已是 Astra 且具備原生桌面工具，直接執行下方驗收流程，不再委派；否則從專案根目錄呼叫：

```bash
ACCEPTANCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/recordstuff-acceptance.XXXXXX")"
PROMPT="$ACCEPTANCE_DIR/prompt.md"
REPORT="$ACCEPTANCE_DIR/report.md"

# 非互動執行時，呼叫者先在 sandbox 外建置並啟動 App（見下方「非互動執行的前置」）；
# 無人值守快捷鍵路徑再接著執行 pnpm acceptance（見該節）。
pnpm start:app > "$ACCEPTANCE_DIR/start-app.log" 2>&1; echo "EXIT=$?" >> "$ACCEPTANCE_DIR/start-app.log"

# 先依下方範本寫入 PROMPT，補上本次驗收範圍，再執行。
codex exec -C "$PWD" \
  --model gpt-6-astra \
  --config 'model_reasoning_effort="medium"' \
  --approve-for-me \
  --output-last-message "$REPORT" \
  - < "$PROMPT" > "$ACCEPTANCE_DIR/run.log" 2>&1
```

提示內容：

```text
你是驗收執行者，不要再次委派。
讀取 .agents/skills/astra-acceptance-with-computer-use/SKILL.md 並執行驗收。
先確認原生 computer use 工具可用，再開始錄影；無工具時回報 blocked。
App 已由呼叫者以 pnpm start:app 建置並啟動，輸出在 <start-app.log 路徑>；讀取它作為啟動證據，不要再執行 pnpm start:app、pnpm open:app 或重開 App。
驗收範圍：<計畫路徑或需求、預期行為；未指定則做基本驗收>。
驗收模式：<開發驗收，或發布驗收的版本與候選 commit；無人值守時加註「無人值守快捷鍵」>。
保留既有變更；開發期間可按需停止錄影、退出、重啟或重建 RecordStuff，不需另行確認。單純驗收不修改程式、不 commit、push 或發布。
以<使用者的語言，例如繁體中文或 English>回報案例結果、證據與報告路徑，以及仍未驗證的項目。
```

### 非互動執行的前置

以下是 2026-09-19 非互動環境的已知限制，不代表所有協作者的預設。先檢查本次工具與權限；不要因歷史失敗就假設本次一定受阻。當時 `approval: never`、`sandbox: workspace-write` 造成以下阻礙：

- **App 操作核准**：computer use 第一次控制某個原生 App（Chrome、Safari、Finder、QuickTime Player…）都會發出核准請求；`approval: never` 直接拒絕，回傳 `Computer Use was not approved to use <App>`，而 `pressKey` 需要先由 `getApp` 取得 App 物件，所以連快捷鍵也送不出去。指令因此加 `--approve-for-me`，讓核准請求走 Codex 的自動審查；但 2026-09-19 21:20 的執行顯示自動審查同樣拒絕 Chrome、Safari、Finder、QuickTime Player（見 `docs/verification/measurements/2026-09-19T2120-computer-use/`）。因此**首次必須在互動式 Codex（ChatGPT App 或 `codex` TUI）跑一次本 skill，由使用者逐一允許需要的 App**，之後才嘗試非互動執行；仍被拒就維持互動式執行。不要用 `--dangerously-bypass-approvals-and-sandbox` 換取通過。
- **`pnpm start:app` 的既有程序檢查**：`scripts/start-app.mjs` 用 `pgrep` 確認沒有 RecordStuff 在跑，workspace-write sandbox 禁止 `ps`／`pgrep`，腳本會以 `Could not check for a running RecordStuff.app.` 失敗。因此由呼叫者在 sandbox 外執行 `pnpm start:app`（先依「啟動正確的 App」處理既有副本），把輸出檔路徑寫進 prompt；Astra 讀該檔與本次 App log 作為啟動證據，不重建、不重開。發布驗收時呼叫者同樣要在乾淨 commit 上執行並記錄 HEAD SHA。
- 若目前已是互動式 Astra 且具備原生桌面工具，這一節不適用：直接依「啟動正確的 App」自己執行 `pnpm start:app`。
- App 控制權限透過目前工具支援的正式核准流程取得；不直接修改核准清單或重啟服務繞過核准。缺少權限時標示相關案例 blocked，繼續可獨立完成的檢查。

- 計畫只需列出驗收範圍與預期結果，指定 Astra 並引用本 skill；委派時將相關需求及操作限制帶入 prompt。
- 使用可持續追蹤的程序工作階段執行，每 60 秒內確認存活並更新進度；同一時間只由一個執行者操作桌面。
- Codex、模型或原生桌面工具不可用時，回報具體原因及 blocked，不默默替換模型。模型選擇不會自動提供 computer use 工具。
- 執行後讀取報告與證據再下結論；CLI 成功退出不代表驗收通過。

## 範圍與準備

- 使用使用者指定的 checkout 或目前工作目錄定位專案根目錄；找不到時詢問專案位置。確認 `package.json` 的名稱與 `start:app`，不要在不明目錄執行。
- 讀取適用的 `AGENTS.md`、`package.json`、`scripts/start-app.mjs` 及本次功能需求／diff。必要時參考 `README.zh-TW.md`、`src/main/tray-model.ts`、`src/shared/i18n.ts` 與 `docs/zh-TW/system-design/tooling.md`。目前原始碼決定產物路徑與行為，舊驗收紀錄只提供背景。
- 使用者指定功能時，依共用測試規則選取受影響案例；只有明確要求完整基本驗收且未限縮功能時才做完整原生基本案例。先簡述範圍，需要錄影才說明短錄影，不因一般可逆操作重複索取確認。
- 僅在本輪包含錄影時準備下述素材；環境與偏好記錄依共用指南。記錄時間、OS／架構、commit 與是否有未提交變更、原有語言／品質／輸出資料夾，以及本次新增錄影的位置。使用專案 `scripts/test-material.html` 作為固定素材：在主螢幕的瀏覽器開啟，透過 computer use 點擊「Click to start audio and enter fullscreen」，確認動態畫面已開始。它提供動態畫面與左右交替嗶聲；不要使用 `?auto=1` 或腳本代按開始。記錄素材版本、瀏覽器、輸出裝置及音量，避免其他聲音混入。若全螢幕遮住選單列，透過 UI 顯示選單列或退出全螢幕，保持素材播放。

## Computer use 操作規則

- 使用環境提供的原生 computer use 工具，依該工具文件初始化並取得桌面狀態；不依賴特定供應商或工具名稱。若沒有原生 computer use 工具，明確回報相關案例 blocked。
- RecordStuff 是選單列 App，沒有一般主視窗。從桌面／選單列快照定位圖示；必要時使用工具支援的桌面介面，不因視窗列表為空就判定啟動失敗。
- 僅使用工具文件實際提供的 API。依最新快照、可存取性節點或螢幕截圖定位，點擊後重新觀察狀態；不要猜固定座標，也不要沿用已失效的節點。
- 開始／停止錄影、開啟選單、變更設定、Finder 定位及播放器操作都透過 computer use 完成。不要用 AppleScript、System Events、IPC、renderer evaluate、Playwright 或測試 hook 代按 UI。
- Shell 可用於建置啟動、唯讀檢查程序／產物身分、讀取本次 log、檢查錄影檔與保存報告。`pnpm matrix`、`pnpm audio:quality` 或直接呼叫錄製邏輯不能算作 computer use 驗收。
- 若工具無法存取原生桌面或缺少必要權限，記錄具體阻礙，完成仍可做的獨立檢查；依賴該介面的案例標示 blocked，不用其他自動化冒充完成。

- 每個 UI 狀態等待最多 30 秒，包含存檔完成、Finder 置前及播放器開啟；逾時記 fail，附當下截圖與已等待時間。截圖不可取得時明確註記原因。不要透過重啟等待計時無限重試；缺工具／權限則按 blocked 處理。建置與媒體分析另依程序進度監看，不套用此 UI 時限。

## 啟動正確的 App

1. 開發期間可按需停止錄影、退出、重啟或重建 RecordStuff，不需先確認是否有人使用或詢問停止授權。用 computer use 操作目標 RecordStuff／此專案 Electron；正常停止錄影並等候存檔，再從選單退出。不要用全域 `killall`。
   退出後以唯讀程序檢查確認停止；若 computer-use 工具會在取得 App 狀態時自動啟動 App，不要再呼叫該狀態讀取來驗證退出，否則會重新啟動舊產物並阻擋重建。
2. 在專案根目錄執行 **`pnpm start:app`**，保留退出碼及建置／簽章／開啟結果。依該腳本目前輸出確認實際 `.app` 路徑；不可拿 `/Applications` 的舊副本或 `pnpm dev` 替代。
3. 指令會建置、自簽、驗證並開啟 App。缺依賴或憑證時報告具體錯誤；不要略過簽章驗證、擅自建立憑證或更改 Keychain 信任。一次失敗後只在有明確原因及修正時重試。
4. 以程序執行路徑等唯讀證據核對啟動的副本，再用 computer use 確認選單列狀態與選單。指令成功不等於 UI 已驗收。
5. 本次重建完成後，如需測試設定持久化，可正常結束後用 `pnpm open:app` 重開同一產物；不得用它取代首次重建。

## 開啟 RecordStuff 設定：System Events ＋ Computer Use

使用者已採用混合驗收流程時，以 `pnpm acceptance:settings-shortcut` 送出 ⌘⌥,，由 Computer Use 操作真正面板。這是無人值守的「System Events 送鍵＋Computer Use 操作」，不是全程 Computer Use。純 `Target.pressKey()` 在本機多次沒有觸發全域 callback；保留失敗紀錄，不要求維護者先點開設定。

1. 沿用本次由 `pnpm start:app` 建置啟動的 bundle，先透過 Computer Use 將另一個 App 置前。設定若已開啟，先記錄狀態，再透過 UI 關閉。
2. 執行 `pnpm acceptance:settings-shortcut`。它核對本 checkout 的 arm64 bundle 程序及最新 App log，只有設定快捷鍵仍註冊時才用 System Events 送一次按鍵；擷取暫停、衝突、舊版本或失敗時拒絕送鍵。送鍵命令最多 10 秒，callback 最多等 30 秒。
3. 命令成功只證明 App 收到快捷鍵。接著用原生 Computer Use 取得 RecordStuff，觀察可見面板與焦點、鍵盤導覽、重複開啟、最小化還原、關閉重開。每次需重新開啟時可再執行相同指令。UI 受阻仍記 blocked，不以腳本成功代替。
4. 依本次範圍繼續雙語、快捷鍵擷取與錄製中鎖定等案例。註冊衝突與失敗的 deterministic 測試不能當成 OS 實測。
5. 每次執行會留下 `docs/verification/measurements/<timestamp>-settings-entry-<suffix>/report.md` 與本次 log；原生操作另記錄步驟、結果和限制。還原偏好並關閉本次新增面板。這個指令不建置、不啟動錄影、不修改偏好或權限。

System Events 缺少權限時如實回報，不自動更改權限或繞過核准。此例外只允許已授權的全域送鍵；其他 UI 仍用 Computer Use，不使用 IPC 或測試專用開窗入口。

## 無人值守快捷鍵驗收（沒有可見視窗時）

RecordStuff 沒有視窗，本環境的 computer use 對純 Tray 的 Electron 程序會回 `-10005 timeoutReached`（見 `docs/verification/measurements/2026-09-19T1753-computer-use-window-probe/`），而本機 Codex computer use 的 `Target.pressKey()` 實測未觸發全域快捷鍵，與只投遞給目標 App 的行為一致（`docs/verification/measurements/2026-09-19T213348-computer-use/` 對照 `2026-09-19T2101-hotkey-osascript/`）。因此這條路徑的核心由專案腳本 **`pnpm acceptance`** 完成，不需要 computer use 點擊，也不依賴 Chrome 核准：

```bash
pnpm start:app      # 建置、自簽、驗證、開啟；App 進入 idle 且 permission granted
pnpm acceptance     # 全螢幕開素材 → System Events 送快捷鍵 → 錄 10 秒 → 再送 → 等 saved → 完整性層級 verify → 報告
```

`scripts/acceptance-hotkey.mts` 從 App log 讀取這個程序實際註冊的組合鍵（`hotkey: registered …`），以 `pnpm matrix` 相同方式在主螢幕以全新 profile 的 Chrome app 模式全螢幕開啟素材（`--autoplay-policy=no-user-gesture-required`、`?auto=1`），並在錄完後以閃光／嗶聲偵測守門：閃光不足代表素材沒被錄到，嗶聲不足代表有背景音訊或輸出靜音，任一觸發即 fail，用 System Events 送出真正的系統層按鍵，等待 `pressed`／`state → recording`／`saved`（各 30 秒上限），對新檔執行 verify 的完整性層級，並把 `report.md`、`verify.json`、本次 App log 寫到 `docs/verification/measurements/<timestamp>-hotkey-acceptance/`。verify 以 test-material 模式執行：素材稀疏嗶聲的「Audio bitrate」只回報不判定（見 tooling）；任一判定為 fail 的指標使腳本以非 0 退出。前置：macOS、執行它的終端機有輔助使用權限（System Events）、Chrome 已安裝、App 已啟動且 idle。這裡的 app 模式自動開始是「不用點擊」的正確做法：放行條件由啟動瀏覧器的一方提供，素材頁本身不會在無手勢時假裝有聲。

Astra 在這條路徑的工作：

1. 呼叫者先在 sandbox 外依序執行 `pnpm start:app` 與 `pnpm acceptance`（sandbox 禁止 `ps`／`pgrep`，見「非互動執行的前置」），把兩者的輸出檔路徑與報告目錄寫進 prompt。Astra 不重跑這兩個指令、不重建、不重開 App。
2. 讀取腳本報告、`verify.json` 與本次 App log；核對送鍵到 `pressed` 的延遲、`state` 順序、`saved` 路徑與完整性層級結果；引用原始報告與 `verify.json`，摘要整體判定、fail／n/a 和證據限制，不逐項重抄指標，也不重跑同一檔案的相同分析；不把腳本的 pass 當成未執行的 UI 或播放案例通過。
3. 可選的原生 UI 案例：`open -a "QuickTime Player" <path>` 只負責開啟播放器，之後用 computer use 按播放、確認進度前進並截一張播放中畫面存入報告目錄，再依下方「播放器收尾」清理本次視窗。QuickTime 需在 Computer Use 核准清單內；不在則記 blocked。
4. 本次範圍需要但工具無法操作的 Tray 案例（例如顯示最後錄影、錄製中選單狀態）記 blocked；語言／快捷鍵設定僅在相關變更或使用者指定時加入。主觀聽感維持未驗。不要用 `osascript` 或其他自動化代按 Tray UI；全域快捷鍵由腳本送出是唯一例外，因為它不是 UI 元件，且 App 收到的是與使用者按鍵相同的系統事件。
5. 報告依「證據、收尾與報告」寫入 `docs/verification/measurements/<timestamp>-computer-use/report.md`，明確標示「無人值守快捷鍵路徑（pnpm acceptance 送鍵）」，並連結腳本的報告目錄。用於發布時，待 record job 的 commit 落到 main 並 pull 後，把英文結論摘要填進 `docs/verification/releases/<version>.md` 的「Local acceptance before tagging — fill in」段落（錄影長度、verify 結果、播放結果、blocked 清單），並同步既存的繁中對應檔；沒有做的檢查寫進「Not recorded」。

沒有 Codex 或 computer use 時，`pnpm start:app` 加 `pnpm acceptance` 本身就是可接受的無人值守錄影檢查；只是播放器畫面與 Tray 案例沒有人觀察，報告要如此標示。

## Agent 自動截圖與判讀：延期退出提示

使用者要求自動化原生提示驗收時，由 Astra 完成可觀察的操作與判讀，不把截圖後的可讀性檢查例行交還使用者。這是 **agent + 原生 computer use + 隔離 runner** 的流程；單獨 `pnpm acceptance:quit-dialog` 不會呼叫模型，也不會自行產生視覺通過結論。先讀取目前原生工具文件；不假設具備全桌面截圖、被動前景查詢或 PNG 存檔 API。

1. 確認沒有前一輪測試程序，指定單一桌面執行者。依序執行 `pnpm acceptance:quit-dialog -- --language zh-TW` 與 `pnpm acceptance:quit-dialog -- --language en`，一次只執行一輪。這是使用合成資料、正式提示／Recorder／FileWriter／退出協調器的隔離 fixture，不載入正常 App，不錄影、不修改正式偏好。
2. 在提示出現前，若工具有不會改變焦點的桌面觀察能力，記錄另一個 App 在前景的證據。提示出現後先被動擷取桌面與前景狀態，再取得目標或按鍵；切勿先把測試 App 置前，再宣稱自動置前通過。若只能取得 App 視窗裁切圖，照常完成版面檢查，自動置前另列未驗證；既有明確人工確認可以作為該次人工證據，不能改寫成自動化結果。
3. 透過原生工具擷取真實提示截圖與 accessibility 狀態。Astra 親自判讀：語言符合本輪、訊息完整且未截斷、按鈕可見且可操作、所觀察範圍內沒有重複提示。Accessibility 的完整文字不能單獨證明畫面沒有截斷；App 裁切圖不能證明沒有其他被遮住的視窗。
4. 在 runner 的 30 秒操作範圍內，透過原生工具關閉提示。讀取本輪 `report.json`、`result.json` 與 log，確認提示關閉後磁碟工作仍被保留、解除延遲後精確 bytes 正確、程序正常退出。超時／取消／強制清理仍是失敗；不把程序存在或 dialog requested log 當成可見證據。
5. 在同一報告目錄新增 agent 視覺紀錄，包含語言、操作時間、截圖／AX 來源、逐項 pass/fail/blocked/not run、判讀理由、是否曾主動改變焦點，以及 runner 結果。工具支援保存原始 PNG 時存入該目錄；只能回傳對話圖像時，明確引用該次工具觀察並標示沒有本機 PNG，不虛構路徑。保留 runner 原本的 `nativeObservation: not recorded`，以附加紀錄提供具名觀察來源，不默默把它改成腳本的斷言。
6. 缺少工具、權限或可辨識畫面時，記 blocked 並完成仍可做的生命週期檢查。只有無法由目前工具判定的具體項目才請使用者協助。所有必要項目與清理都有證據才可說該輪全自動驗收通過；不能保證無桌面或缺權限的 CI 也能執行。

報告與最後回覆固定以使用者的語言附上提醒：**「測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。」** 保留既有流程，不因此新增每輪確認或鍵鼠監控。若已知受干擾，將受影響的原生觀察標為 blocked（人為干擾／無法判定），保留原始截圖、log 與 runner 結果，不直接判為產品通過或失敗；如需有效結論，再於無干擾時重測該項。沒有觀察到干擾不等於已證明沒有干擾。

## 共用案例與追加範圍

依[共用驗收案例](../../../docs/zh-TW/acceptance.md)執行本輪選定的操作、預期觀察及媒體檢查；依[測試選擇表](../../../docs/zh-TW/testing.md)決定追加或不適用的項目。共用同一短錄影與有效分析，不重複相同檔案的相同驗證；快捷鍵送達不能代替 Tray 點擊。

原生案例仍須遵守本 skill 的工具操作規則。無法觀察的狀態標示限制，缺權限／工具列 blocked；不把必要但未測的案例改稱不適用。保存失敗步驟，授權修復後只重跑受影響案例。

## 發布驗收

- 若本次用於發布，先讀 `docs/system-design/releases.md`，確認目標版本及候選 commit。建置前要求 `git status --porcelain` 為空（含未追蹤檔），記錄完整 HEAD SHA 與 `package.json` 版本；有未提交變更時只能算開發驗收，不能當發布驗收，不自行 commit 或清除變更。
- 必須從該乾淨 commit 執行 `pnpm start:app`。預定 `v<version>` tag 的目標必須等於此 SHA；若 tag 已存在，核對其解析後的 commit。建置後改程式、版本或改用另一 commit，必須重新建置驗收，不沿用原結果。
- 除完整測量報告，將英文結論摘要寫入 `docs/verification/releases/<version>.md`；有既存繁中對應檔時同步更新。包括版本、已驗 SHA、產物路徑、案例結論、限制及詳細報告相對連結；保留原紀錄，不提前宣稱已發布。
- 本次產生的報告是驗收後的證據，與建置前就存在的髒工作樹分開記錄。若將報告提交成另一 commit，不可把新 commit 直接當作已驗收目標；可另存證據於後續文件 commit、讓 tag 仍指向原已驗 SHA。發布前再次核對目標 SHA 與工作樹符合發布工具要求，否則標示發布條件未滿足。此 skill 不自動 commit、打 tag、push 或發布。

## 播放器收尾

- 開啟測試影片前，記錄 QuickTime 是否已執行、既有文件與檔案選擇器；收尾只處理本次測試新增的 UI，保留使用者原有文件與未儲存內容。
- 關閉測試影片後，重新取得原生 UI 狀態。QuickTime 在最後一個影片關閉後可能自動顯示「打開」／Open 檔案選擇器；必須按「取消」或 Escape，不能把關閉影片當作完成收尾。
- 操作後再次觀察，確認測試影片與本次新增的檔案選擇器均已消失。若第一次點擊只取得焦點，依新狀態再取消。沒有視窗時回傳 `noWindowsAvailable` 可作為沒有殘留視窗的證據；`timeoutReached` 本身不能作此判定。
- 若 QuickTime 原先未執行，且確認沒有使用者文件，可正常退出；原先已執行時不必退出。不要用 killall、關閉所有視窗或強制退出清理。無法清乾淨時，在報告列出具體遺留視窗與原因。

## 證據、收尾與報告

- 保留啟動、REC、存檔／Finder、播放器及失敗狀態等關鍵快照；使用工具實際支援的保存方式。無法落地的快照只能引用工具觀察，不虛構截圖路徑。
- 按需以 `pnpm probe -- /absolute/path/file.mp4`、`ffprobe` 或完整解碼輔助檢查格式／時長／解碼錯誤。採用專案工具前讀其用法；只有已知測試素材才套用品質或同步門檻。工具缺失應揭露，不因此宣稱 UI 失敗。
- 只截取本次時間範圍的相關 log，避免把舊錯誤當本次失敗。短錄通過不能推論長時間穩定、音質、同步、首次授權或發布版安裝通過。
- 每輪完整驗收無論成功、失敗或中斷，都要停止自己建立的錄影並等待存檔、結束素材播放、從 UI 還原改過的設定，清理本次新增視窗，最後從選單正常退出 RecordStuff。即使測試前已開啟，驗收後也預設保持關閉；不要為恢復原本的開啟狀態而重啟。
- 退出後以程序檢查確認本次 RecordStuff 與其 helper 已消失，記錄程序與 UI 證據。App 沒有視窗不代表已退出；若仍有程序、錄影未確認存妥或無法操作退出，列出 cleanup fail／blocked 與遺留原因，不能宣稱完整驗收通過，也不能直接重建或強制殺掉 App。
- 同一輪的連續錄影、持久化等案例依測試目的重啟；`acceptance:settings-shortcut` 只是中途開啟面板，待原生驗收完成才退出。`pnpm acceptance` 現在會自行退出 App，後續播放驗收只需開啟保存的影片。
- 保留測試影片與報告，不刪除使用者既有資料、不重設 TCC；報告明列 App 最終程序狀態、清理結果與未還原項目。
- 除非指定其他位置，在專案 `docs/verification/measurements/<timestamp>-computer-use/` 寫入 `report.md` 及可保存的證據，不覆寫歷史紀錄。該目錄已 gitignore，報告只留本機；本文其他段落引用的 2026-09-19 目錄是維護者機器上的紀錄，其他機器上可能不存在，結論已摘要在 `docs/verification/README.md`。報告使用[共用範本](../../../docs/zh-TW/acceptance.md#報告範本)，包含驗收範圍、環境與產物路徑、案例結果表、影片／截圖／log 連結、失敗重現及限制。
- 最終以使用者的語言提供整體結論、通過／失敗／受阻／未執行數量與報告連結。有受阻或未測項時限定通過範圍；不能把建置成功或自動化檢查通過寫成全面驗收通過。
