---
name: astra-acceptance-with-computer-use
description: 由 Codex GPT-6 Astra（預設 medium reasoning）使用 computer use 驗收 RecordStuff 透過 pnpm start:app 建置啟動的 macOS 原生選單列 App，操作錄製、存檔、播放及相關 UI 回歸並留下證據。適用於要求實際操作 App、桌面驗收或功能 smoke test；不以單元測試、瀏覽器頁面或錄製腳本代替原生 UI 驗收。
---

# Astra Acceptance with Computer Use

以使用者操作路徑驗收目前原始碼建置的 App。預設用繁體中文回報。只有建立或修改本 skill 的請求，不代表要立即啟動錄影驗收。

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
保留既有變更及使用者錄影，不修改程式、不 commit、push 或發布。
以繁體中文回報案例結果、證據與報告路徑，以及仍未驗證的項目。
```

### 非互動執行的前置

`codex exec` 預設 `approval: never`、`sandbox: workspace-write`。2026-09-19 的四次非互動執行證明這兩個預設會讓驗收在動手前就受阻：

- **App 操作核准**：computer use 第一次控制某個原生 App（Chrome、Safari、Finder、QuickTime Player…）都會發出核准請求；`approval: never` 直接拒絕，回傳 `Computer Use was not approved to use <App>`，而 `pressKey` 需要先由 `getApp` 取得 App 物件，所以連快捷鍵也送不出去。指令因此加 `--approve-for-me`，讓核准請求走 Codex 的自動審查；但 2026-09-19 21:20 的執行顯示自動審查同樣拒絕 Chrome、Safari、Finder、QuickTime Player（見 `docs/verification/measurements/2026-09-19T2120-computer-use/`）。因此**首次必須在互動式 Codex（ChatGPT App 或 `codex` TUI）跑一次本 skill，由使用者逐一允許需要的 App**，之後才嘗試非互動執行；仍被拒就維持互動式執行。不要用 `--dangerously-bypass-approvals-and-sandbox` 換取通過。
- **`pnpm start:app` 的既有程序檢查**：`scripts/start-app.mjs` 用 `pgrep` 確認沒有 RecordStuff 在跑，workspace-write sandbox 禁止 `ps`／`pgrep`，腳本會以 `Could not check for a running RecordStuff.app.` 失敗。因此由呼叫者在 sandbox 外執行 `pnpm start:app`（先依「啟動正確的 App」處理既有副本），把輸出檔路徑寫進 prompt；Astra 讀該檔與本次 App log 作為啟動證據，不重建、不重開。發布驗收時呼叫者同樣要在乾淨 commit 上執行並記錄 HEAD SHA。
- 若目前已是互動式 Astra 且具備原生桌面工具，這一節不適用：直接依「啟動正確的 App」自己執行 `pnpm start:app`。
- **核准清單可預先寫入**：使用者在互動式 Codex 按「永久允許」後，服務會把 bundle ID 寫進 `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`（格式 `{"approvedBundleIdentifiers": ["com.google.Chrome", …]}`）。驗收需要的 `com.apple.Safari`、`com.apple.finder`、`com.apple.QuickTimePlayerX` 可直接補進陣列後重啟 Computer Use 服務。把 RecordStuff 的 ID 加進去沒有用：無視窗 App 的 AX 介面仍回 `-10005 timeoutReached`，Tray 案例照樣 blocked。

- 計畫只需列出驗收範圍與預期結果，指定 Astra 並引用本 skill；委派時將相關需求及操作限制帶入 prompt。
- 使用可持續追蹤的程序工作階段執行，每 60 秒內確認存活並更新進度；同一時間只由一個執行者操作桌面。
- Codex、模型或原生桌面工具不可用時，回報具體原因及 blocked，不默默替換模型。模型選擇不會自動提供 computer use 工具。
- 執行後讀取報告與證據再下結論；CLI 成功退出不代表驗收通過。

## 範圍與準備

- 使用使用者指定的 checkout 或目前工作目錄定位專案根目錄；找不到時詢問專案位置。確認 `package.json` 的名稱與 `start:app`，不要在不明目錄執行。
- 讀取適用的 `AGENTS.md`、`package.json`、`scripts/start-app.mjs` 及本次功能需求／diff。必要時參考 `README.zh-TW.md`、`src/main/tray-model.ts`、`src/shared/i18n.ts` 與 `docs/zh-TW/system-design/tooling.md`。目前原始碼決定產物路徑與行為，舊驗收紀錄只提供背景。
- 使用者指定功能時，以該功能及相鄰錄製流程為範圍；未指定時採下方基本驗收。先簡述範圍與會進行的短錄影，不因一般可逆操作重複索取確認。
- 記錄時間、OS／架構、commit 與是否有未提交變更、原有語言／品質／輸出資料夾，以及本次新增錄影的位置。使用專案 `scripts/test-material.html` 作為固定素材：在主螢幕的瀏覽器開啟，透過 computer use 點擊「Click to start audio and enter fullscreen」，確認動態畫面已開始。它提供動態畫面與左右交替嗶聲；不要使用 `?auto=1` 或腳本代按開始。記錄素材版本、瀏覽器、輸出裝置及音量，避免其他聲音混入。若全螢幕遮住選單列，透過 UI 顯示選單列或退出全螢幕，保持素材播放。

## Computer use 操作規則

- 使用環境提供的原生 computer use 工具，依該工具文件初始化並取得桌面狀態；不依賴特定供應商或工具名稱。若沒有原生 computer use 工具，明確回報相關案例 blocked。
- RecordStuff 是選單列 App，沒有一般主視窗。從桌面／選單列快照定位圖示；必要時使用工具支援的桌面介面，不因視窗列表為空就判定啟動失敗。
- 僅使用工具文件實際提供的 API。依最新快照、可存取性節點或螢幕截圖定位，點擊後重新觀察狀態；不要猜固定座標，也不要沿用已失效的節點。
- 開始／停止錄影、開啟選單、變更設定、Finder 定位及播放器操作都透過 computer use 完成。不要用 AppleScript、System Events、IPC、renderer evaluate、Playwright 或測試 hook 代按 UI。
- Shell 可用於建置啟動、唯讀檢查程序／產物身分、讀取本次 log、檢查錄影檔與保存報告。`pnpm matrix`、`pnpm audio:quality` 或直接呼叫錄製邏輯不能算作 computer use 驗收。
- 若工具無法存取原生桌面或缺少必要權限，記錄具體阻礙，完成仍可做的獨立檢查；依賴該介面的案例標示 blocked，不用其他自動化冒充完成。

- 每個 UI 狀態等待最多 30 秒，包含存檔完成、Finder 置前及播放器開啟；逾時記 fail，附當下截圖與已等待時間。截圖不可取得時明確註記原因。不要透過重啟等待計時無限重試；缺工具／權限則按 blocked 處理。建置與媒體分析另依程序進度監看，不套用此 UI 時限。

## 啟動正確的 App

1. 用 computer use 查看既有 RecordStuff／此專案 Electron 狀態。若是使用者原有且仍在錄影，先詢問是否可停止，不中斷其工作。閒置副本可由選單正常結束；本次自己啟動的錄影則正常停止並等候存檔。不要用全域 `killall`。
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

## 基本驗收

基本驗收共用一次短錄影完成錄製、存檔、定位、播放與媒體檢查。若本次已有同一產物、同一錄影檔的有效腳本報告，沿用其媒體證據，只補做尚未覆蓋的 UI／播放操作；快捷鍵結果不能代替 Tray 點擊。

每個案例記錄「操作、預期、實際、狀態、證據」。狀態使用 pass／fail／blocked／not run；觀察不到的瞬間過渡狀態不要猜測。

| 案例 | 操作與可觀察結果 |
| --- | --- |
| 啟動與選單 | 右鍵開啟選單，確認 Ready／待命或實際權限狀態，主要選項可見，沒有重複副本造成誤操作。 |
| 開始錄製 | 左鍵圖示，確認進入 REC／Recording。錄製約 10–15 秒，持續播放 `scripts/test-material.html` 的動態畫面與左右交替嗶聲。 |
| 錄製中狀態 | 開啟選單，確認停止操作可用、品質與輸出位置等鎖定項目符合目前需求／tray model。 |
| 停止與存檔 | 再次左鍵停止，確認最終回到待命，記錄新 MP4 路徑與通知。若可觀察到 Saving，保存證據；未捕捉到不等於失敗。 |
| 定位檔案 | 經通知或 `Show last recording`／「顯示最後一個錄影」開啟 Finder（依 `src/shared/i18n.ts` 當前語言字串定位）。分別記錄是否選中正確檔案及 Finder 是否置前；某一路徑失敗時保留結果，再測另一條路徑。 |
| 實際播放 | 從 Finder 開啟新錄影，使用播放器播放與拖曳，確認畫面內容及播放進度正常。工具若不能聽取音訊，僅將主觀聽感標示未驗；客觀聲音檢查依下一案例判定，不以音軌存在推論有聲。 |
| 客觀聲音檢查 | 對本次 MP4 執行 `pnpm verify -- /absolute/path/file.mp4 --json /absolute/path/report-dir/verify.json`（先建立報告目錄），保存輸出、退出碼及 JSON。核對 `Sample rate/channels`：48 kHz、2 聲道、每聲道 RMS 均 > −60 dBFS，記錄實際數值；符合時可判定錄到非靜音訊號。這不證明聽感、聲道分離、音質或同步。缺失／n/a 不算通過，缺工具記 blocked；其他指標的 fail 也要保留，不能因音訊通過就宣稱整份 verify 通過。 |

需要權限時，先觀察實際提示與 App 引導，再依已有授權操作；若需使用者完成 OS 授權，明確指出卡在哪一步。一般驗收不重設 TCC、不撤銷既有權限，也不宣稱已驗首次授權。

## 依變更增加案例

只加入與需求相關的案例，避免每次驗收都跑完整矩陣：

- 語言／設定持久化／啟動流程：透過選單切換 English／繁體中文，確認文字與勾選狀態；正常重開同一產物確認保存，再還原原語言。

- 品質／解析度／幀率：從 UI 選取受影響選項，短錄後對照產物與設定；記錄實際顯示器及設定，不強行把歷史效能數字當通過門檻。
- 輸出資料夾：用原生選擇器選擇專用測試資料夾，驗證檔案落點並還原；不直接修改設定檔來代替操作。
- 錄製中語言切換：確認顯示更新且錄製持續，完成存檔播放。
- 權限拒絕／復原、故障注入、強制退出、長時間錄製、安裝／更新：只有需求包含時才做。涉及撤銷權限或中斷既有錄影時確認具體操作範圍；沒有跑過就列 not run。
- 發現缺陷時保存重現步驟與證據。單純驗收不自行擴張為改程式；若已獲授權修復，修復後重建並重新操作受影響案例，保留修復前後結果。

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
- 退出後以程序檢查確認本次 RecordStuff 與其 helper 已消失，記錄程序與 UI 證據。App 沒有視窗不代表已退出；若仍有程序、錄影未確認存妥或無法操作退出，列出 cleanup fail／blocked 與遺留原因，不能宣稱完整驗收通過，也不能直接重建或強制殺掉 App。使用者原有錄影仍須先取得停止授權。
- 同一輪的連續錄影、持久化等案例依測試目的重啟；`acceptance:settings-shortcut` 只是中途開啟面板，待原生驗收完成才退出。`pnpm acceptance` 現在會自行退出 App，後續播放驗收只需開啟保存的影片。
- 保留測試影片與報告，不刪除使用者既有資料、不重設 TCC；報告明列 App 最終程序狀態、清理結果與未還原項目。
- 除非指定其他位置，在專案 `docs/verification/measurements/<timestamp>-computer-use/` 寫入 `report.md` 及可保存的證據，不覆寫歷史紀錄。該目錄已 gitignore，報告只留本機；本文其他段落引用的 2026-09-19 目錄是維護者機器上的紀錄，其他機器上可能不存在，結論已摘要在 `docs/verification/README.md`。報告包含驗收範圍、環境與產物路徑、案例結果表、影片／截圖／log 連結、失敗重現及限制。
- 最終用繁體中文提供整體結論、通過／失敗／受阻／未執行數量與報告連結。有受阻或未測項時限定通過範圍；不能把建置成功或自動化檢查通過寫成全面驗收通過。
