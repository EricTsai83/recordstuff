---
name: native-acceptance
description: 驗收 RecordStuff 透過 pnpm start:app 建置啟動的 macOS 原生選單列 App。執行者不限：任何能在本機執行指令並看得到截圖的 agent（例如 Claude）先選定並執行專案 runner（Tray、設定入口、快捷鍵錄影、通知、播放），再判讀 runner 與自己保存的截圖及報告；只有沒有 runner、需要即時 computer use 的操作才使用 computer use 或委派 Codex GPT-6 Astra。腳本、agent 觀察與人工證據分開標示。適用於要求實際操作 App、桌面驗收或功能 smoke test；不以單元測試、瀏覽器頁面或直接呼叫錄影邏輯的腳本（matrix、autorecord）代替原生 UI 驗收。
---

# Native Acceptance

以使用者操作路徑驗收目前原始碼建置的 App。以使用者的語言回報：依要求本次驗收的訊息判斷（語言混用時依主要敘述語言），整輪維持同一語言，使用者改用其他語言時跟著改；技術用語可保留英文；英文使用者改用 [testing](../../../docs/testing.md) 與 [acceptance](../../../docs/acceptance.md) 的英文版本與其報告範本。只有建立或修改本 skill 的請求，不代表要立即啟動錄影驗收。

背景 UI 套件（`pnpm test:ui`，由 `pnpm acceptance:regression` 執行）不使用桌面，不屬於本 skill，也不需要桌面交接；它的通過不是原生證據（adapter 呼叫只代表正式程式提出的要求）。先依[共用測試規則](../../../docs/zh-TW/testing.md)選定範圍；案例、預期結果及報告格式以[共用驗收指南](../../../docs/zh-TW/acceptance.md)為準。本 skill 補充執行者與原生工具的執行方式，不另定測試門檻。每項原生操作依[腳本 runner 或 Computer Use](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use) 選擇：有已提交 runner 涵蓋的操作執行 runner，computer use 負責觀察與沒有 runner 的操作；各操作對應的 runner 見[驗收對照](../../../docs/zh-TW/acceptance.md#腳本-runner-或-computer-use)。純文件修改不啟動 App；純設定 UI 驗收不因使用本 skill 就加入錄影。

## 執行者

- **不限定執行者。** 能在本機執行指令、看得到截圖的 agent（例如 Claude）直接執行本 skill：自己執行 `pnpm start:app` 或 `pnpm open:app` 與本次範圍的 runner，讀取報告與 log，並以 `screencapture -x` 保存截圖後親自判讀（選單、視窗或橫幅用 `-R x,y,w,h` 對準其 frame；只拍主螢幕的 `-x` 拍不到副螢幕上的選單）。plan 063 的驗收就是由 Claude 這樣完成的。
- 截圖判讀屬於「Computer Use 觀察」這類證據（[測試指南](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use)：agent 檢視截圖或即時桌面並判讀）；報告寫明觀察者與方式，例如「Claude 以 screencapture 截圖判讀」或「Astra computer use」。
- 只有本次範圍需要**即時** computer use 操作（沒有 runner 的操作：在設定面板內變更設定、手動錄影時點擊素材、點擊播放器控制項、VoiceOver、下方的權限提示例外），而目前的 agent 沒有原生 computer use 工具時，才委派 Codex GPT-6 Astra（見下方「委派 Codex GPT-6 Astra」）。無法委派時，只有那些案例記 blocked，其餘 runner 照常執行。
- 任何執行者在第一個會使用桌面的指令（包括 `pnpm start:app`、`pnpm open:app` 與每個 runner）之前都要完成[桌面交接](../../../docs/zh-TW/testing.md#測試前確認桌面交接)，收到回覆後才開始；控制權交還使用者後，下一輪重新交接。runner 的狀態列點擊會移動真正的游標，回合中有人操作可能關掉選單或改變選取，目前不會被偵測。
- 同一時間只由一個執行者操作桌面；長時間步驟每 60 秒內確認存活並更新進度；讀取報告與證據後再下結論，CLI 成功退出不代表驗收通過。委派用的 Codex、模型或 computer use 工具不可用時，回報具體原因及 blocked，不默默替換。

## 委派 Codex GPT-6 Astra

需要即時 computer use 而目前 agent 沒有該工具時，使用 **`gpt-6-astra`、medium reasoning**。若目前已是 Astra 且具備原生桌面工具，直接依本 skill 執行，不再委派；否則從專案根目錄呼叫：

```bash
ACCEPTANCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/recordstuff-acceptance.XXXXXX")"
PROMPT="$ACCEPTANCE_DIR/prompt.md"
REPORT="$ACCEPTANCE_DIR/report.md"

# 非互動執行時，呼叫者先在 sandbox 外建置並啟動 App（見下方「非互動執行的前置」）；
# 再依本次範圍執行 runner：pnpm acceptance:tray、pnpm acceptance:settings-shortcut -- --observe、
# pnpm acceptance、pnpm acceptance:playback 等（見「操作方式」與各節），把輸出路徑寫進 prompt。
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
讀取 .agents/skills/native-acceptance/SKILL.md 並執行驗收。
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

- 計畫只需列出驗收範圍與預期結果並引用本 skill；委派時將相關需求及操作限制帶入 prompt，並以可持續追蹤的程序工作階段執行。模型選擇不會自動提供 computer use 工具。

## 範圍與準備

- 使用使用者指定的 checkout 或目前工作目錄定位專案根目錄；找不到時詢問專案位置。確認 `package.json` 的名稱與 `start:app`，不要在不明目錄執行。
- 讀取適用的 `AGENTS.md`、`package.json`、`scripts/start-app.mjs` 及本次功能需求／diff。必要時參考 `README.zh-TW.md`、`src/main/menus/tray-model.ts`、`src/shared/i18n.ts` 與 `docs/zh-TW/system-design/tooling.md`。目前原始碼決定產物路徑與行為，舊驗收紀錄只提供背景。
- 使用者指定功能時，依共用測試規則選取受影響案例；只有明確要求完整基本驗收且未限縮功能時才做完整原生基本案例。先簡述範圍，需要錄影才說明短錄影，不因一般可逆操作重複索取確認。
- 僅在本輪包含錄影時準備下述素材；環境與偏好記錄依共用指南。記錄時間、OS／架構、commit 與是否有未提交變更、原有語言／品質／輸出資料夾，以及本次新增錄影的位置。使用專案 `scripts/test-material.html` 作為固定素材：在主螢幕的瀏覽器開啟，透過 computer use 點擊「Click to start audio and enter fullscreen」，確認動態畫面已開始。它提供動態畫面與左右交替嗶聲；不要使用 `?auto=1` 或腳本代按開始。記錄素材版本、瀏覽器、輸出裝置及音量，避免其他聲音混入。若全螢幕遮住選單列，透過 UI 顯示選單列或退出全螢幕，保持素材播放。

## 接管前等待使用者回覆

遵守[共用測試規則的桌面交接](../../../docs/zh-TW/testing.md#測試前確認桌面交接)。在任何會將 App 置前的工具呼叫、滑鼠／鍵盤操作、桌面 runner 或錄影前，先說明本輪案例並送出明確提示，例如：

> 接下來會操作 RecordStuff 的選單列，可能移動滑鼠與切換焦點。請先暫停鍵盤與滑鼠操作，準備好後回覆「好了」，我才會開始。

送出提示後停止輸出、結束本輪回覆，等待使用者的明確回覆；不得用 sleep 十秒、持續報進度或未收到反對當作確認。收到「好了」後才執行已說明的連續回合，回覆涵蓋該回合的收尾，不必每次點擊都再問。若中途交還控制權或使用者要求暫停，再次接管前重新交接。記錄回覆及範圍，完成清理後告知使用者可恢復操作。純文件／程式工作不觸發此步驟；建置啟動 App 的命令及無人值守送鍵 runner 若會使用共用桌面，同樣須先完成交接。

## 操作方式：先選 runner，computer use 負責觀察

依[腳本 runner 或 Computer Use](../../../docs/zh-TW/testing.md#腳本-runner-或-computer-use) 與[驗收對照](../../../docs/zh-TW/acceptance.md#腳本-runner-或-computer-use)選定每項操作。維護者 2026-10-02 核准以已提交的 runner 操作 RecordStuff 自己的 Tray 選單、設定視窗與選單項目（[限制](../../../docs/zh-TW/acceptance.md#依影響追加案例)），因此：

- **由 runner 操作**：Tray 選單的結構、開始／停止、三種取消、以鍵盤選「開啟 RecordStuff」與結束用 `pnpm acceptance:tray`（見下方「Tray」）；以快捷鍵開設定與視窗狀態用 `pnpm acceptance:settings-shortcut -- --observe`；背景套件無法回答的設定視窗框與啟用、真正的註冊被拒與真實視窗狀態、在螢幕上的全螢幕與焦點交還，用 `pnpm acceptance:recipe -- native-ui`（`out/` 產物，一次建置；RecordStuff 執行中時播放器 runner 會拒絕執行）；快捷鍵錄影用 `pnpm acceptance`；存檔通知 → Finder 用 `pnpm acceptance:notification`；播放用 `pnpm acceptance:playback`；延後退出通知用 `pnpm acceptance:quit-dialog`。runner 需要 `pgrep` 與桌面：執行者能在 sandbox 外執行時就自己執行；委派到 sandbox 內的 Astra 時，由呼叫者執行後把報告路徑寫進 prompt。
- **由執行者觀察**：判讀 runner 與自己保存的截圖（選單外觀、淺色／深色選單列、對齊與可讀性、倒數數字、通知橫幅是否可見與截斷、設定排版）。
- **由 computer use 操作**（目前 agent 沒有工具時委派 Astra）：沒有 runner 的操作，包括在設定面板內變更設定、手動錄影時點擊素材的開始控制項、案例要求時點擊播放器自身的控制項、VoiceOver，與下方唯一的權限提示例外。
- 除了執行已提交的 runner，不要自行用 AppleScript、System Events、CoreGraphics 事件、IPC、renderer evaluate、Playwright 或測試 hook 代按 UI。runner 的狀態列點擊會移動真正的游標，所以它的回合同樣需要桌面交接。
- runner 的通過是腳本輸入證據，不能當作視覺或主觀判斷；runner 結果與畫面所見不符時，記為 runner 失敗，不是產品通過。

以下是 computer use 本身的規則：

- 使用環境提供的原生 computer use 工具，依該工具文件初始化並取得桌面狀態；不依賴特定供應商或工具名稱。若沒有原生 computer use 工具，明確回報相關案例 blocked。
- RecordStuff 是選單列 App，沒有一般主視窗。從桌面／選單列快照定位圖示；必要時使用工具支援的桌面介面，不因視窗列表為空就判定啟動失敗。
- 僅使用工具文件實際提供的 API。依最新快照、可存取性節點或螢幕截圖定位，點擊後重新觀察狀態；不要猜固定座標，也不要沿用已失效的節點。
- Shell 可用於建置啟動、唯讀檢查程序／產物身分、讀取本次 log、檢查錄影檔與保存報告。`pnpm matrix`、`pnpm audio:quality` 或直接呼叫錄影邏輯不能算作 computer use 驗收。
- 若工具無法存取原生桌面或缺少必要權限，記錄具體阻礙，完成仍可做的獨立檢查；依賴該介面的案例標示 blocked，不用其他自動化冒充完成。
- 唯一的權限例外（維護者 2026-09-26 授權，見[共用驗收指南](../../../docs/zh-TW/acceptance.md#依影響追加案例)）：受測的 RecordStuff build 開始擷取時，若 macOS 跳出「要求略過系統私密視窗選擇器並直接取用你的畫面和音訊」的提示，可透過 computer use 按「允許」，並記錄 macOS 是否接受。若被忽略，就讓提示保持開啟並回報。其他權限提示、「系統設定」的隱私權清單與 TCC 一律不碰。

- 每個 UI 狀態等待最多 30 秒，包含存檔完成、Finder 置前及播放器開啟；逾時記 fail，附當下截圖與已等待時間。截圖不可取得時明確註記原因。不要透過重啟等待計時無限重試；缺工具／權限則按 blocked 處理。建置與媒體分析另依程序進度監看，不套用此 UI 時限。

## 啟動正確的 App

1. 開發期間可按需停止錄影、退出、重啟或重建 RecordStuff，不需先確認是否有人使用或詢問停止授權。正常停止錄影並等候存檔，再從選單退出（`pnpm acceptance:tray` 結束時會選「結束 RecordStuff」；沒有 runner 時用 computer use）。不要用全域 `killall`。
   退出後以唯讀程序檢查確認停止；若 computer-use 工具會在取得 App 狀態時自動啟動 App，不要再呼叫該狀態讀取來驗證退出，否則會重新啟動舊產物並阻擋重建。
2. 在專案根目錄執行 **`pnpm start:app`**，保留退出碼及建置／簽章／開啟結果。依該腳本目前輸出確認實際 `.app` 路徑；不可拿 `/Applications` 的舊副本或 `pnpm dev` 替代。
3. 指令會建置、自簽、驗證並開啟 App。缺依賴或憑證時報告具體錯誤；不要略過簽章驗證、擅自建立憑證或更改 Keychain 信任。一次失敗後只在有明確原因及修正時重試。
4. 以程序執行路徑等唯讀證據核對啟動的副本，再用 `pnpm acceptance:tray` 確認選單列狀態與選單，並判讀其截圖。指令成功不等於 UI 已驗收。
5. 本次重建完成後，如需測試設定持久化，可正常結束後用 `pnpm open:app` 重開同一產物；不得用它取代首次重建。之後只改了測試、腳本或文件時，下一輪也可用它重開；runtime 輸入變了它會拒絕開啟，此時改用 `pnpm start:app`，不要繞過。

## 開啟 RecordStuff 設定：System Events ＋ 輔助使用

以 `pnpm acceptance:settings-shortcut -- --observe` 送出 ⌥⌘, 並以輔助使用檢查真正的設定視窗。純 `Target.pressKey()` 在本機多次沒有觸發全域 callback；保留失敗紀錄，不要求維護者先點開設定。

1. 沿用本次由 `pnpm start:app` 建置啟動的 bundle。設定若已開啟，`--observe` 會拒絕執行：先記錄狀態，再透過 UI 關閉。
2. 執行 `pnpm acceptance:settings-shortcut -- --observe`。它核對本 checkout 的 arm64 bundle 程序及最新 App log，只有設定快捷鍵仍註冊時才送鍵；先讓 Finder 置前，再斷言設定視窗是 main 且有焦點、RecordStuff 在前景、Tab 移動焦點、應用程式選單沒有綁定 ⌘R／⌥⌘I 且保留 ⌘C、⌘A、⌘M、⌘Q、⌘R 與 ⌥⌘I 不改變焦點、⌘A 再 ⌘C 能複製面板文字（剪貼簿會先保存後還原）、⌘M 最小化、第二次送鍵還原、⌘W 關閉、第三次送鍵重開。callback 與每項輔助使用檢查分開記錄，面板保持開啟。
3. 這些都是腳本證據。排版與外觀依背景套件的圖與基準（`pnpm test:ui`，在 `test-results/ui/`），或以 computer use 觀察面板；本次範圍需要在面板內變更設定時，也用 computer use 操作。UI 受阻仍記 blocked。
4. 依本次範圍繼續雙語、快捷鍵擷取與錄影中鎖定等案例。註冊衝突與失敗的 deterministic 測試不能當成 OS 實測。
5. 每次執行會留下 `docs/verification/measurements/<timestamp>-settings-entry-<suffix>/report.md` 與本次 log。還原偏好並關閉本次新增面板。這個指令不建置、不啟動錄影、不修改偏好或權限。

System Events 或輔助使用缺少權限時如實回報為 blocked，不自動更改權限或繞過核准；不使用 IPC 或測試專用開窗入口。

## Tray：`pnpm acceptance:tray` ＋ 截圖判讀

Computer use 無法存取純 tray 的程序（`-10005 timeoutReached`），Tray 案例改由 runner 操作（[Tray 驗收](../../../docs/zh-TW/system-design/tooling.md#tray-驗收)）：

1. 呼叫者在 `pnpm start:app`（或之後的 `pnpm open:app`）後、App 待命時執行 `pnpm acceptance:tray`；預設先儲存的語言再另一種，`--languages` 可限縮。它會以目前畫面錄下幾段短片並保留，最後結束 App。
2. 讀取 `report.md`、`result.json` 與 `app.log`：每個案例的狀態、與正式 model 的比對差異、Finder 判定與收尾。not run 的案例（例如 macOS 先處理選單 Start 時的 stale-start）照實回報，不算通過。
3. 以 computer use 判讀報告目錄中的選單截圖：群組、分隔線、靠右的快捷鍵、淺色／深色選單列的可讀性。這是 computer use 觀察，與 runner 的腳本證據分開列出。
4. needsPermission 選單需撤銷權限，維持由維護者處理；不要為了它修改 TCC。

## 無人值守快捷鍵驗收（沒有可見視窗時）

RecordStuff 沒有視窗，本環境的 computer use 對純 Tray 的 Electron 程序會回 `-10005 timeoutReached`（見 `docs/verification/measurements/2026-09-19T1753-computer-use-window-probe/`），而本機 Codex computer use 的 `Target.pressKey()` 實測未觸發全域快捷鍵，與只投遞給目標 App 的行為一致（`docs/verification/measurements/2026-09-19T213348-computer-use/` 對照 `2026-09-19T2101-hotkey-osascript/`）。因此這條路徑的核心由專案腳本 **`pnpm acceptance`** 完成，不需要 computer use 點擊，也不依賴 Chrome 核准：

```bash
pnpm start:app      # 建置、自簽、驗證、開啟；App 進入 idle 且 permission granted
pnpm acceptance     # 全螢幕開素材 → System Events 送快捷鍵 → 錄 10 秒 → 再送 → 等 saved → 完整性層級 verify → 報告
```

`scripts/acceptance-hotkey.mts` 從 App log 讀取這個程序實際註冊的組合鍵（`hotkey: registered …`），以 `pnpm matrix` 相同方式在主螢幕以全新 profile 的 Chrome app 模式全螢幕開啟素材（`--autoplay-policy=no-user-gesture-required`、`?auto=1`），並在錄完後以閃光／嗶聲偵測守門：閃光不足代表素材沒被錄到，嗶聲不足代表有背景音訊或輸出靜音，任一觸發即 fail，用 System Events 送出真正的系統層按鍵，等待 `pressed`／`state → recording`／`saved`（各 30 秒上限），對新檔執行 verify 的完整性層級，並把 `report.md`、`verify.json`、本次 App log 寫到 `docs/verification/measurements/<timestamp>-hotkey-acceptance/`。verify 以 test-material 模式執行：素材稀疏嗶聲的「Audio bitrate」只回報不判定（見 tooling）；任一判定為 fail 的指標使腳本以非 0 退出。前置：macOS、執行它的終端機有輔助使用權限（System Events）、Chrome 已安裝、App 已啟動且 idle。這裡的 app 模式自動開始是「不用點擊」的正確做法：放行條件由啟動瀏覧器的一方提供，素材頁本身不會在無手勢時假裝有聲。

執行者在這條路徑的工作：

1. 依序執行 `pnpm start:app` 與 `pnpm acceptance`，本次範圍需要播放時再對存下的檔案執行 `pnpm acceptance:playback -- <path>`。委派到 sandbox 內的 Astra 時（sandbox 禁止 `ps`／`pgrep`，見「非互動執行的前置」），改由呼叫者在 sandbox 外執行並把各指令的輸出檔路徑與報告目錄寫進 prompt，Astra 不重跑這些指令、不重建、不重開 App。
2. 讀取腳本報告、`verify.json` 與本次 App log；核對送鍵到 `pressed` 的延遲、`state` 順序、`saved` 路徑與完整性層級結果；引用原始報告與 `verify.json`，摘要整體判定、fail／n/a 和證據限制，不逐項重抄指標，也不重跑同一檔案的相同分析；不把腳本的 pass 當成未執行的 UI 或播放案例通過。
3. 播放案例由 `pnpm acceptance:playback -- <path>` 以腳本輸入完成：它判定時長與尺寸、即時播放、seek、seek 後畫面改變與播放到結尾，並自行關閉文件、退出播放器（見[播放檢查](../../../docs/zh-TW/system-design/tooling.md#播放檢查)）。讀取並引用它的 `report.md`／`result.json`；QuickTime Player 已在執行時它回 blocked（exit 2），不要為了讓它執行而關閉使用者的文件或強制退出。只有案例要求點擊播放器自身的控制項時，才以 `open -a "QuickTime Player" <path>` 開啟，用 computer use 按控制項、確認進度前進並截一張畫面存入報告目錄，再依下方「播放器收尾」清理本次視窗；QuickTime 需在 Computer Use 核准清單內，不在則記 blocked。聽感需要聆聽者，維持未驗或由維護者判斷。
4. 本次範圍需要的 Tray 案例（例如錄影中的選單狀態、點擊圖示開啟選單）由 `pnpm acceptance:tray` 完成，見上方「Tray」；語言／快捷鍵設定僅在相關變更或使用者指定時加入。主觀聽感維持未驗。除了已提交的 runner，不要用 `osascript` 或其他自動化代按 Tray UI。
5. 報告依「證據、收尾與報告」寫入 `docs/verification/measurements/<timestamp>-computer-use/report.md`，明確標示「無人值守快捷鍵路徑（pnpm acceptance 送鍵）」，並連結腳本的報告目錄。用於發布時，待 record job 的 commit 落到 main 並 pull 後，把英文結論摘要填進 `docs/verification/releases/<version>.md` 的「Local acceptance before tagging — fill in」段落（錄影長度、verify 結果、播放結果、blocked 清單），並同步既存的繁中對應檔；沒有做的檢查寫進「Not recorded」。

沒有 Codex 或 computer use 時，`pnpm start:app` 後依序執行 `pnpm acceptance`、`pnpm acceptance:playback`、`pnpm acceptance:tray` 與 `pnpm acceptance:settings-shortcut -- --observe`，本身就是可接受的無人值守錄影、播放、Tray 與設定入口檢查；只是播放器控制項點擊與所有畫面的視覺判讀沒有人觀察，報告要如此標示。

## Agent 自動截圖與判讀：延期退出通知

使用者要求自動化原生提示驗收時，由執行者完成可觀察的操作與判讀，不把截圖後的可讀性檢查例行交還使用者。這是 **agent 截圖判讀 + 隔離 runner** 的流程；單獨 `pnpm acceptance:quit-dialog` 不會呼叫模型，也不會自行產生視覺通過結論。能執行 shell 的執行者以 `screencapture -x -R` 對準右上角的通知區保存 PNG；只有 computer use 工具時，先讀取其文件，不假設具備全桌面截圖、被動前景查詢或 PNG 存檔 API。

1. 確認沒有前一輪測試程序，指定單一桌面執行者。依序執行 `pnpm acceptance:quit-dialog -- --language zh-TW` 與 `pnpm acceptance:quit-dialog -- --language en`，一次只執行一輪。這是使用合成資料、正式提示／Recorder／FileWriter／退出協調器的隔離 fixture，不載入正常 App，不錄影、不修改正式偏好。runner 每輪先把 Electron.app 複製到暫存目錄，以 RecordStuff Dev（或 `RECORDSTUFF_SIGN_IDENTITY`）完整簽章並驗證後才啟動（plan 062）；exit 2 且簽章層 blocked 表示簽章前置不足（identity、keychain 權限），exit 1 表示簽章或驗證失敗，兩者都沒有通知可看，不進行視覺判讀，記錄原因即可。
2. 延後退出自 plan 055 起改為通知，不需要回應也不搶焦點。啟動約三秒後通知出現；在橫幅消失前被動擷取桌面截圖，不要點擊橫幅或把測試 App 置前。
3. runner 已透過輔助使用確認本輪恰有一則橫幅、文字為本輪語言（橫幅文字層，plan 063）。執行者親自判讀截圖：橫幅可見、可讀，是否截斷；截斷時，另從通知中心展開確認完整文字。`notification shown` log 與輔助使用文字都不能單獨證明橫幅可見。
4. 讀取本輪 `report.md`／`report.json`、`result.json`、`notification.jsonl` 與 log。報告分開列出簽章 fixture App、生命週期、通知送達事件、橫幅文字、視覺觀察與清理六層：確認通知期間 timer 延遲低於門檻、磁碟工作仍被保留、解除延遲後精確 bytes 正確、程序正常退出，送達層為 `shown`（授權拒絕是 blocked，其他錯誤或沒有事件是失敗），橫幅文字層通過，且暫存副本已移除。超時／取消／強制清理仍是失敗。runner exit 0 只是自動化證據，視覺層固定 pending；綜合原生判定加上本 skill 的視覺結果，視覺被阻擋時仍是 blocked。
5. 在同一報告目錄新增 agent 視覺紀錄，包含語言、操作時間、截圖／AX 來源、逐項 pass/fail/blocked/not run、判讀理由、是否曾主動改變焦點，以及 runner 結果。工具支援保存原始 PNG 時存入該目錄；只能回傳對話圖像時，明確引用該次工具觀察並標示沒有本機 PNG，不虛構路徑。保留 runner 原本的 `nativeObservation: not recorded`，以附加紀錄提供具名觀察來源，不默默把它改成腳本的斷言。
6. 缺少工具、權限或可辨識畫面時，記 blocked 並完成仍可做的生命週期檢查。只有無法由目前工具判定的具體項目才請使用者協助。所有必要項目與清理都有證據才可說該輪全自動驗收通過；不能保證無桌面或缺權限的 CI 也能執行。

報告與最後回覆固定以使用者的語言附上提醒：**「測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。」** 接管前的準備就緒回覆依上述桌面交接流程；此提醒不代表已自動偵測干擾，也不新增鍵鼠監控。若已知受干擾，將受影響的原生觀察標為 blocked（人為干擾／無法判定），保留原始截圖、log 與 runner 結果，不直接判為產品通過或失敗；如需有效結論，再於無干擾時重測該項。沒有觀察到干擾不等於已證明沒有干擾。

## 共用案例與追加範圍

依[共用驗收案例](../../../docs/zh-TW/acceptance.md)執行本輪選定的操作、預期觀察及媒體檢查；依[測試選擇表](../../../docs/zh-TW/testing.md)決定追加或不適用的項目。共用同一短錄影與有效分析，不重複相同檔案的相同驗證；快捷鍵送達不能代替 Tray 點擊。

原生案例仍須遵守本 skill 的工具操作規則。無法觀察的狀態標示限制，缺權限／工具列 blocked；不把必要但未測的案例改稱不適用。保存失敗步驟，授權修復後只重跑受影響案例。

## 發布驗收

- 若本次用於發布，先讀 `docs/system-design/releases.md`，確認目標版本及候選 commit。建置前要求 `git status --porcelain` 為空（含未追蹤檔），記錄完整 HEAD SHA 與 `package.json` 版本；有未提交變更時只能算開發驗收，不能當發布驗收，不自行 commit 或清除變更。
- 必須從該乾淨 commit 執行 `pnpm start:app`。預定 `v<version>` tag 的目標必須等於此 SHA；若 tag 已存在，核對其解析後的 commit。建置後改程式、版本或改用另一 commit，必須重新建置驗收，不沿用原結果。
- 除完整測量報告，將英文結論摘要寫入 `docs/verification/releases/<version>.md`；有既存繁中對應檔時同步更新。包括版本、已驗 SHA、產物路徑、案例結論、限制及詳細報告相對連結；保留原紀錄，不提前宣稱已發布。
- 本次產生的報告是驗收後的證據，與建置前就存在的髒工作樹分開記錄。若將報告提交成另一 commit，不可把新 commit 直接當作已驗收目標；可另存證據於後續文件 commit、讓 tag 仍指向原已驗 SHA。發布前再次核對目標 SHA 與工作樹符合發布工具要求，否則標示發布條件未滿足。此 skill 不自動 commit、打 tag、push 或發布。

## 播放器收尾

本節只適用於以 computer use 點擊播放器控制項的手動路徑。`pnpm acceptance:playback` 只在 QuickTime Player 原本未執行時開始，自行關閉它開啟的文件、退出播放器並確認程序結束；它的收尾結果以 runner 報告為準，未清乾淨即為 fail。

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
- 同一輪的連續錄影、持久化等案例依測試目的重啟；`acceptance:settings-shortcut` 只是中途開啟面板，待原生驗收完成才退出。`pnpm acceptance` 現在會自行退出 App，後續播放驗收只需對保存的影片執行 `pnpm acceptance:playback`。
- 保留測試影片與報告，不刪除使用者既有資料、不重設 TCC；報告明列 App 最終程序狀態、清理結果與未還原項目。
- 除非指定其他位置，在專案 `docs/verification/measurements/<timestamp>-computer-use/` 寫入 `report.md` 及可保存的證據，不覆寫歷史紀錄。該目錄已 gitignore，報告只留本機；本文其他段落引用的 2026-09-19 目錄是維護者機器上的紀錄，其他機器上可能不存在，結論已摘要在 `docs/verification/README.md`。報告使用[共用範本](../../../docs/zh-TW/acceptance.md#報告範本)，包含驗收範圍、環境與產物路徑、案例結果表、影片／截圖／log 連結、失敗重現及限制。
- 最終以使用者的語言提供整體結論、通過／失敗／受阻／未執行數量與報告連結。有受阻或未測項時限定通過範圍；不能把建置成功或自動化檢查通過寫成全面驗收通過。

### Computer Use 工具收尾

App 收尾與工具收尾都完成後才交還桌面；成功、失敗與中斷都適用。開始使用工具時記錄本輪建立的 session、頁籤與可確認歸屬的 worker PID（程序身分、父程序與建立時間），保留原有資源。不能只憑工作目錄相同就認定程序屬於本輪。

1. 在工具仍可用時完成上面的 App／播放器收尾及最後證據，關閉本輪建立的測試頁籤。再透過工具文件提供的 session close／disconnect 或宿主的結束工作階段機制釋放本輪資源；有 REPL reset 工具時清除本輪執行環境。`cua_repl.js_reset` 只保證清除 JavaScript bindings，不保證關閉 App、頁籤、浮層或所有服務；不能單憑 reset 成功宣稱收尾完成。工具文件沒有關閉 API 時，不猜造 `cua.close()` 等方法。
2. 最後停止本輪自行啟動的 caffeinate，等待自己啟動的子程序退出並回收；不要為取得最後快照再次初始化 Computer Use。以唯讀 shell 檢查作為最後證據。
3. macOS 執行 `pnpm acceptance:cleanup-audit -- --owned-pid <本輪工具或 worker PID> --output <本輪報告目錄>/tool-cleanup.json`；每個已確認歸屬的 PID 各加一次 `--owned-pid`。沒有建立工具程序時可省略 PID，但報告必須說明只檢查已知 `Software Cursor` 浮層，沒有證明所有 worker 都已退出。這個指令不操作桌面、不啟動工具、不終止程序，也不覆寫既有報告。
4. Exit 0 只表示列出的檢查範圍清空；1 是可見浮層或指定程序仍存在（含 zombie），2 是檢查受阻。任何本輪殘留都記 cleanup fail／blocked，列出 PID、父程序與浮層，不能宣稱完整驗收通過。若浮層屬於其他工作階段，保留它並明列歸屬及排除理由；不能把該次 audit 的 exit 1 改寫為 pass。

共享的 Computer Use／cmux 服務存活不等於殘留；不要全域 kill、終止其他專案工具或退出 ChatGPT／T3 宿主。只能用正式 lifecycle 管理本輪 session，或正常退出已確認專屬本輪的輔助 App。若工具 transport 已關閉而浮層仍在，記錄受阻並提出具體恢復方式。Zombie 已停止執行，必須由父程序回收；不要重複 kill 或偷偷重啟使用者的宿主 App。這類供應商限制仍是收尾缺口，不能保證腳本自行修復。
