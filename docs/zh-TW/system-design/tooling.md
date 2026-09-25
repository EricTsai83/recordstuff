# 建置、打包與驗收工具

[English](../../system-design/tooling.md) | [繁體中文](tooling.md)

## 開發流程

專案使用 pnpm，package.json 的 Node 要求為 ≥22.12；TypeScript 量測腳本使用 Node 24 直接執行。FFmpeg／ffprobe 只供開發量測，不隨 App 安裝。

| 指令 | 用途 |
| --- | --- |
| pnpm install | 安裝依賴 |
| pnpm dev | 熱重載；授權對象可能歸於啟動的終端機／編輯器 |
| pnpm start | build 後透過 macOS open 開啟 Electron.app，供音訊測試 |
| pnpm start:app | 建置、自簽、驗證、開啟 RecordStuff.app |
| pnpm open:app | 驗證並開啟既有開發包，不重建 |
| pnpm check | typecheck、完整 Vitest、build |
| pnpm icons | PNG／ICO、DMG 背景圖（1x／2x）；macOS 額外產 native ICNS |
| pnpm log | 追蹤 macOS log |
| pnpm dist:mac | 自簽 App 驗證後，在 dist/ 旁邊產生 DMG |
| pnpm acceptance | 對執行中的 App：全螢幕開素材、以 System Events 送全域快捷鍵開始／停止錄影、驗完整性層級（test-material 模式）、把報告寫到 docs/verification/measurements（已 gitignore，只留本機） |
| pnpm acceptance:settings | 對已建置的產物：在真實 Electron 視窗載入 `out/preload/settings.js` 與 `out/renderer/settings.html`，判定出貨 CSP、sandbox preload 邊界與真實 IPC 往返；報告與截圖寫到 docs/verification/measurements。需要先 `pnpm build`，不需要 tray 或已安裝的 App |
| `pnpm acceptance:regression` | 一個指令執行 check（含建置）、設定 fixture 與快捷鍵整合；包含重複開啟／關閉／Tray 路徑重開。隔離偏好與程序，各 runner 保留報告；任一步失敗立即停止。不會啟動或關閉使用者的 RecordStuff，也不錄影。 |
| pnpm acceptance:notification | 對 /Applications 裡的 App（可用 `--install` 在本次換成 dist 的建置）：錄影、透過輔助使用按下「已儲存」橫幅、判定 Finder 是否在最前面且顯示該檔，每個 Finder 狀態連點多次，預設英文；報告寫到 docs/verification/measurements |

main、preload、renderer 分別建置，打包只納入 out、package metadata 與指定 resources。測試、量測與文件不屬 runtime；App 不呼叫 FFmpeg。

`scripts/fixtures/` 的原始碼統一使用 TypeScript，納入 `pnpm typecheck`。獨立入口由 [build-fixture.mts](../../../scripts/lib/build-fixture.mts) 使用 Vite 的 TypeScript 轉換按需編譯：settings-panel、recording-lifecycle、history-quit、quit-dialog 與 release-record-network 輸出 ESM（`.mjs`）；shortcut-failure 因為要在載入正式 App 前攔截 CommonJS 載入，所以輸出 CommonJS（`.cjs`）。產物保留在各次驗收報告目錄或測試暫存目錄，不是需要維護的原始碼，也不隨 App 發布。update-acceptance fixture 繼續隨臨時 App 原始碼副本一起建置。現有驗收指令不需額外手動建置 fixture；編譯只移除型別，型別檢查由 `pnpm typecheck` 負責。傳給 `executeJavaScript` 的 renderer 字串仍是執行時程式碼，不會得到 TypeScript 的 DOM 型別檢查。

## 資源與產生的輸出

- `build/` 是納入版本控制的打包資源：`icon.png`、macOS 原生 `icon.icns`，以及 DMG 背景 `background.png` 與 Retina 配對 `background@2x.png`（540×380 點）。打包設定以此作為 `buildResources`，明確指定 macOS 使用 ICNS，並用 `tiffutil` 把背景配對合成多解析度 TIFF。請保留；修改圖案後以 `pnpm icons` 重新產生。所有圖像都由程式產生，repo 沒有手繪二進位檔。
- `resources/` 包含執行時使用的選單列圖示、macOS entitlements，以及雙語安裝／更新／移除指南（`INSTALL.md`、`INSTALL.zh-TW.md`）。指南是由 GitHub release 與 README 連結的文件；打包 filter 只複製 PNG／ICO，因此指南不會進入 App 或 DMG。
- `out/` 由 `pnpm build` 產生；`dist/` 是 `pnpm start:app`（App bundle 在 `dist/mac-arm64/`）與 `pnpm dist:mac`（同一個 bundle 加 DMG）共用的唯一輸出目錄。兩者都由 Git 忽略，可以重新產生。清理 `dist/` 前應保留仍需要的安裝檔；`pnpm open:app` 需要已有的 App bundle。本機建的 DMG 用來檢查打包；發布的 DMG 一律由 CI 從 tag 建置。
- `node_modules/` 放已安裝的開發依賴，可透過 `pnpm install` 還原。

品質選項與錯誤碼各自只維護一份常數清單，TypeScript 型別由清單推導，選單也共用品質清單。型別檢查會拒絕未使用的區域變數與參數。設定檔 v1 遷移仍保留，以延續既有的輸出資料夾偏好。

`pnpm signing:create` 保留既有符合名稱的憑證，或依明確輸出位置與密碼建立加密身分檔，見 [身分設定](signing.md)。不匯入私鑰或設定信任。

## 簽章與打包

身分設計、憑證建立／備份、故障排除與待實作 CI 配置，見 [macOS 簽署身分與自簽設計](signing.md)。

[start-app.mjs](../../../scripts/start-app.mjs) 預設精確挑選 RecordStuff Dev，可用 RECORDSTUFF_SIGN_IDENTITY 的完整名稱或 SHA-1 指定。缺少、重名、過期、非自簽、成品身分不同均停止。憑證用 SHA-1 辨識，下載檔完整性用 SHA-256。

重建前檢查 RecordStuff／本專案 Electron 是否仍執行。子程序環境移除 Apple／CSC 發行變數，停用身分自動搜尋，強制簽章、公證 false、publish never。不重置權限、不匯入私鑰、不發布。

驗證深度 codesign、巢狀 app／framework 公開憑證、identifier、runtime 與最外層 designated requirement；不追 symlink。先驗過 App 才封 DMG。

[共用設定](../../../electron-builder.yml) 定義安裝介面：540×380 的 Finder 視窗、程式產生的箭頭背景、128 點圖示，以及恰好兩個項目——App 在 x=130、`/Applications` 連結在 x=410，中心皆在 y=190。[local 設定](../../../electron-builder.local.yml) 繼承它並停用公證／timestamp／DMG 簽章與更新 metadata；不得再加 `dmg.contents`，因為 `extends` 會串接陣列，而發布閘門拒絕 `Applications`、`RecordStuff.app` 與隱藏 Finder 版面檔以外的任何根目錄項目。刻意不附任何格式的說明檔，安裝、更新與移除指引放在線上。檔名為 RecordStuff-版本-架構-selfsigned.dmg，arm64 與 x64 非 universal；目前只有 arm64 驗過。pnpm dist:mac 產生與 CI 在 tag 推送時建置並公開相同的 DMG（取代舊的 dist:mac:local 別名與分開的 dist/dev、dist/local 資料夾）；共用設定停用公證。目前沒有 `dist:win` script 或 Windows 打包目標。

收件者可能需要單一 App 的「仍要打開」，受管理 Mac 也可能不允許；依 [安裝指南](../../../resources/INSTALL.zh-TW.md) 與 [Apple](https://support.apple.com/102445) 正常操作，不修改全域安全設定。同一份指南也說明手動更新（結束、下載、在相同 Applications 路徑取代；身分與設定保留）與移除（結束、把 App 移到垃圾桶；錄影、`~/Library/Application Support/recordstuff` 與 `~/Library/Logs/recordstuff` 除非使用者自行刪除否則保留）。沒有解除安裝器、背景服務或自動權限重置。

## 量測工具

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm verify -- /absolute/path/any-desktop-recording.mp4 --screen 1920x1080   # 只驗完整性
pnpm acceptance -- --seconds 10        # 對執行中的 App 做無人值守快捷鍵驗收
pnpm acceptance:settings                           # 設定頁面與 preload 在真實 Electron 視窗；包含截圖矩陣
pnpm acceptance:notification -- --install --clicks 2  # 通知日常 smoke：兩次點擊
pnpm acceptance:notification -- --install          # 點「已儲存」通知 → Finder 置前；約 1 分鐘；本次把建置好的 App 換進 /Applications
pnpm acceptance:notification -- --install --full   # 三種 Finder 狀態、英文；估計約 3 分鐘
pnpm matrix -- quick
pnpm matrix -- all
pnpm matrix -- long
```

verify 支援多檔、log、來源尺寸、同步標記、Markdown／JSON 與指定 JSON 輸出。聲道能量是必要證據，帶 `--sync` 時閃光／短音標記也是；有檢查 fail、必要證據 incomplete 或檔案無法讀取時 exit 1，缺少必要工具（blocked）時 exit 2，其餘 exit 0（見[判定](#驗收門檻)）。結果預設存至 docs/verification/measurements（已 gitignore，原始執行只留本機，解讀後的結論才寫進驗證紀錄）；會讀所有保留的檔案（active log 與 `.1`～`.3`，由舊到新），並依身分配對錄影與 session（plan 029）：使用 [session record](desktop.md#log-與診斷) 的 run 與 session id，以檔案完整路徑查找；只有 log 中恰好一個 session 指名同名檔案時才退回用檔名（複製出去的檔案）。同一筆 record 記兩次仍是一個結果；同一 session 出現不同結果則是 conflict。沒有留下檔案的失敗不宣告任何路徑，因為同一秒的重試可能重用它的暫存檔名。session record 之前版本的啟動使用保守的舊版關聯：只有沒有其他可能擁有者時才接受（`file finalized` 行、唯一仍在錄製的 session，或文字相符且唯一未解決的失敗），因此兩個未解決的失敗絕不依印出順序分配。其餘情況報告會標出 metadata 為 ambiguous、conflict 或 unknown，不判定任何需要要求設定的檢查；媒體量測不依賴 metadata。`pnpm acceptance` 與 `pnpm matrix` 在 metadata 沒有配到自己 session 時判該案例失敗。2026-09-25 以 244 個保留 log 重播，舊的依順序讀法配到的 628 個檔案全部得到相同關聯；保留 log 中沒有舊讀法會出錯的「收尾順序顛倒」交錯。

### 測試素材

`scripts/test-material.html` 是所有量測共用的唯一固定頁面：捲動小字（銳利度）、紅藍細線與彩色文字（色度邊緣）、每幀移動的方塊（幀率時序）、右上角每秒閃白 100 ms 的方框，以及同一音訊時鐘上的柔和 660 Hz 音（120 ms、約 −10 dBFS、左右交替）。閃光與音是同步標記：`verify --sync` 以 ffmpeg blackdetect 看方框、silencedetect（−35 dB、0.4 秒）看音訊找出它們，所以頁面其餘時間必須靜音，機器上也不能有別的聲音在播。音訊稀疏，這類錄影的 AAC 碼率只回報不判定（`--test-material`）。手動開啟時要點一下才開始（瀏覽器自動播放政策）；`pnpm matrix` 與 `pnpm acceptance` 用全新 profile 的 Chrome app 模式全螢幕在主螢幕開啟、允許自動播放並帶 `?auto=1`，不需點擊。驗收報告會記錄頁面的 SHA-256，結果可對應素材版本。版本沿革：2026-09-19 以前是 1 kHz、60 ms、音量 0.5 的嗶聲；2026-09-20 改為上述較柔和的 660 Hz 音，首次執行在 20 秒內偵測到 20 次閃光與 19 個音、音畫偏移 79 ms，落在歷史 45–80 ms 延遲範圍內，先前的同步結果仍可比較。目前 SHA-256：`e631b973a793cde1d5326a9cc58da0d88a522ca3c3041b1c9a2d0f3561c41459`。

matrix 只支援 macOS 開發環境。預設以 Chrome app 模式全螢幕在主螢幕開素材頁，可用 --no-open-material 自行開；固定音量與來源螢幕。以 RECORDSTUFF_AUTORECORD 驅動未打包 App，打包版忽略。seconds 範圍 (0,3600]，quality override 合併固定預設，不讀使用者品質作為基準。每個案例都要求聲道能量與同步標記（plan 030）：matrix 在建置或錄影前先檢查 ffmpeg 與 ffprobe，缺少就 exit 2（blocked）。只有沒有任何檢查 fail、blocked 或 incomplete 的案例才算通過；未通過的案例會在執行結尾與量測檔中列出每個未達成的檢查及原因，整輪 exit 1。

| 矩陣 | 內容 |
| --- | --- |
| quick | 三段 30 秒：1440p 標準／高品質、原尺寸標準 |
| levels | 三段 30 秒 1080p：精省／標準／高品質 |
| fps | 原尺寸標準 30／60 fps，各 30 秒 |
| long | 180 秒 1080p 標準 30 fps 漂移回歸 |
| all | 縮短至 15 秒的案例加 long，含間隔約七分鐘 |

10 分鐘基準已做過，long 改 3 分鐘是使用者決定，不更改舊結果。

Autorecord 存檔後立即退出，因此 macOS 待送的儲存通知會被退出流程取消；橫幅不屬於 autorecord 完成條件。

### 選擇驗收範圍

依[共用測試規則](../testing.md)選擇必要及可排除的檢查。原生／錄影使用[共用案例與報告](../acceptance.md)。本頁維護指令操作及門檻，不另定一套測試選擇規則。

Updates 使用插樁副本，matrix 使用 autorecord，兩者都不能代替正常建置 App 的驗收。通知驗收保留安裝路徑與不同 Finder 狀態的覆蓋。同一未變更檔案與相同驗證範圍可共用媒體證據；不同產物或 UI 操作不可互相替代。素材參數與有時限的 log 等待共用 `scripts/lib/acceptance.mts` 與 `scripts/lib/acceptance-runtime.mts`；各 runner 保留自己的 App 生命週期與判定。Log 位置是 `scripts/lib/log-reader.mts` 的 rotation-aware cursor（plan 029），等待與收尾共用：cursor 由檔案身分（device、inode、birth time）加 byte offset 組成，從它往後讀時會跟著該檔案到目前所在的 archive，再讀所有較新的檔案，每行只讀一次。它容忍輪替改名後、下一次追加前的空檔，保留尚未換行的最後一行，而且 retention 已刪除或截斷已抹去 cursor 所在歷史時，會明確回報 evidence gap，不會等到逾時。cursor 另外記下 offset 之前的 64 bytes；只會追加的 log 不會改動它們，所以檔案在兩次讀取之間被截斷又長回超過 offset，也會回報 gap，不會靜默跳過。被 single-instance lock 拒絕的第二次啟動所寫的 `start:` 行不算程序啟動，因此不會遮住執行中 App 的狀態，也不會切開它的 log。快捷鍵 runner 要求 App 的 run id，把等待綁定到本次 capture record 指名的 session，並從該 session 的終止 record 取得檔案。快捷鍵與通知 runner 共用中斷錄影的收尾，等待存檔，成功送出停止命令後不再次切換快捷鍵；runner 的證據 log 會在遺失歷史的位置標示 gap。

### 通知驗收

驗收現在分別要求：與實際觀察到的通知文字相符的 `clicked` 事件（缺少文字時才用本次儲存的預期語言／檔名），以及完整路徑相符的成功 reveal 要求。兩者各自判定，不再只因缺少 reveal 紀錄就宣稱 callback 未送達。沒有 click 日誌的舊版無法通過此較嚴格的 runner；歷史報告保留原判定。

通知時序診斷包含 `tracksStoppedAt`（renderer 停止 tracks 後的 wall-clock 毫秒）、主程序 `host stopped`、`file finalized`，以及 `saved scheduled`、`saved cancelled`、`saved request failed`。JS 時間戳不代表 OS 已就緒；需與既有 request／show／click 日誌、AX 觀察及可取得的窄範圍 macOS 紀錄對照。App 不要求系統日誌存取。macOS 的儲存通知延遲 500 ms，runner 仍只在存檔後搜尋 5 秒。歷史 Plan 017 結案門檻與結果保留於[驗證歷史](../verification/history-2026-09.md#儲存通知時序2026-09-20)，不作為每次修改的預設門檻。

每個案例另外保存 `<language>-<finder>-<click>-diagnostics.json`：帶時間的搜尋嘗試、有限長度的 Accessibility 結構文字／錯誤，以及 App 通知生命週期事件。未通過案例會再取一份只觀察、不點擊的快照（最多 5 秒，因此失敗案例可能較久）。App 分別記錄請求顯示、shown、clicked、closed、failed；shown 事件本身不代表腳本找到可見橫幅。這些本地檔案可能包含通知文字，不會提交。

`pnpm acceptance:notification` 檢查明確點擊儲存通知後，是否選到檔案且 Finder 置前。每個案例錄影 2 秒、最多搜尋該次通知 5 秒、取樣前景 App 3 秒，再讀取 Finder 選取與輔助使用反白列。找不到橫幅記為未執行，不再額外錄影重試。每組至少需要兩次通過且沒有失敗；未執行次數仍會列出。

預設為英文、Finder 關閉、五次點擊，約一分鐘；`--full` 涵蓋三種 Finder 狀態 × 五次點擊，維持英文，共 15 個案例；依先前單次耗時推估約三分鐘，實際時間受輔助使用操作影響。它只擴充 Finder 覆蓋，不改語言。通知翻譯由單元測試覆蓋；原生繁中驗證可指定 `--languages zh-TW`，明確需要雙語時使用 `--full --languages en,zh-TW`（30 個案例）。每個案例印出開始、進度與耗時。較短的 smoke check 可用 `--clicks 2`，低於二會拒絕。其他選項：`--finder closed,behind,minimized`、`--languages en,zh-TW`、`--seconds`、`--front <app>`、`--keep-recordings`、`--out`。

先前在安裝版重現了本地 dist 執行未出現的焦點競態：通知 callback 後 macOS 才啟動 RecordStuff。因此測試 `/Applications/RecordStuff.app`；`--install` 暫時將已簽章的 `dist/mac-arm64/RecordStuff.app` 複製進去，再還原已驗證的原 App。成功還原後刪除備份，失敗則保留並回報路徑。原始報告保存在 `docs/verification/measurements`。

使用專用桌面執行：開始前關閉 Finder 視窗，執行中不要操作桌面，並授予終端機輔助使用及對 Finder、TextEdit 的自動化權限。既有 Finder 視窗會讓前置檢查停止，不會被關閉。每個案例開啟一份暫存 TextEdit 檔案，只關閉該檔案，不碰其他文件。Finder 視窗在建立或確認 reveal 後以 ID 追蹤；無法辨識的視窗（例如取得 ID 前就被中斷的 reveal）保留並回報需手動清理。關閉測試文件後，TextEdit 若沒有其他文件就正常退出；若有其他文件則保留。這避免引入通用視窗快照／還原系統。 通知判定檢查整個登入工作階段的前景 App 與 Finder 選取，不檢查視窗位於哪一個螢幕。測試視窗在副螢幕仍可符合判定；RecordStuff 仍錄製主螢幕，所以錄影中未必會出現那些視窗。指定螢幕或 Space 的視窗位置不在驗收範圍。

Ctrl-C 或 SIGTERM 會取消命令與等待。命令上限為 10 秒（程序查詢 5 秒，App 複製 60 秒）；快捷鍵送出與 Finder 建立視窗會先完成其最多 5 秒的命令，再處理取消。清理有獨立的 120 秒期限，給本段錄影最多 30 秒完成停止／存檔，停止只送一次，不會用前段紀錄判定本段已停止。若無法確認錄影停止，保留執行中的 App 與備份，不結束或替換它。App 停止後才還原語言設定；即使原先在執行，收尾後也保持關閉。未完成、取消或清理失敗都讓報告失敗。期限涵蓋非同步操作，不保證能處理無回應的檔案系統或 OS。

未涵蓋 Tray 選單定位、其他 Spaces、橫幅消失後從通知中心清單點擊。歷史耗時、失敗及後續完成證據保留於[通知歷史](../verification/history-2026-09.md#通知點擊後-finder-置前--2026-09-20)，不要把舊失敗狀態當成本次結果。

## 驗收門檻

media-tools 呼叫 ffprobe／ffmpeg；verify.mts 純解析／計算／判定；verify-recording.mts 配對與寫結果；CLI／matrix 編排。長片分開取頭尾影格時間戳，不把未取樣中間區間算掉幀。素材頁提供持續動態畫面與同一 audio clock 上的閃光／短音。

檢查分兩層。**完整性**檢查適用於任何內容，也是發布驗收所需：它們問的是「檔案是否就是該次錄影產生的東西」。**效能**檢查只有在畫面持續變動時才有意義，因為螢幕擷取在畫面靜止時不會送出影格；只在 `--moving` 或 `--sync`（測試素材頁，`pnpm matrix` 使用）時判定，否則標 n/a 但仍顯示量測值。

| 層 | 指標 | 目前專案門檻 |
| --- | --- | --- |
| 完整性 | 尺寸 | 符合 capture report、上限與已知來源比例 |
| 完整性 | 時長 | 有指定 matrix 時長則用它，否則用 log 的 session 長度（`state → recording` 到 `state → stopping`），±2 秒 |
| 完整性 | 音訊／影像時長差 | 絕對值 <100 ms |
| 完整性 | 音訊−影像起始偏移（容器） | 嚴格介於 −45 與 +125 ms |
| 完整性 | 音訊格式 | 48 kHz、2 聲道（串流 metadata） |
| 完整性 | 聲道能量 | 由 ffmpeg astats 量到兩個聲道，各自 RMS >−60 dBFS。靜音、缺少或數值無效的聲道判 fail；astats 以非 0 結束，或回報的聲道少於串流聲道數，也判 fail |
| 完整性 | 視訊碼率 | 至少為要求目標的 70%；超過只是檔案較大，不算失敗 |
| 完整性 | 音訊碼率 | 至少為要求目標的 50%；AAC 隨內容變化。帶 `--test-material`（`--sync` 隱含、`pnpm acceptance` 會設定）時只回報不判定：素材頁的稀疏嗶聲遠低於任何要求值，連續音訊的碼率交給[音質診斷](audio-quality.md) |
| 完整性 | 解碼 | ffprobe 全影格無錯；播放器操作另驗 |
| 效能 | fps | 要求 ±2 fps |
| 效能 | 掉幀 | <2% |
| 效能 | 音訊−影像偏移（閃光／短音） | 嚴格介於 −45 與 +125 ms，至少 3 組配對的閃光／短音 |
| 效能 | 結尾漂移 | 絕對值 <100 ms。至少 120 秒（要求或實測）的錄影，前 60 秒與後 60 秒各需至少 3 組配對；較短的錄影沒有漂移可判定 |
| 效能 | CPU | Electron 合計平均 ≤40%（僅 matrix） |

碼率採下限而非目標，因為 Chromium 編碼器在 60 fps 時會超出要求 1.5–2 倍但仍達到預期品質；只有碼率不足才代表問題。這些是 THRESHOLDS 常數，不是任意素材的品質保證。beep 素材碼率低，dual-mono 也會通過雙聲道能量檢查，但不能證明立體聲分離。

每個檢查的判定為 pass、fail、blocked、incomplete 或 n/a（plan 030），由呼叫端說明需要哪些證據：matrix 要求聲道能量與同步標記，`pnpm verify` 要求能量、帶 `--sync` 時也要求標記，`pnpm acceptance` 要求能量，更新驗收兩者都要求。必要證據因工具缺少而無法量測時為 **blocked**。必要標記有量但數量不足，或長錄影缺少任一端的窗口時為 **incomplete**，並附原因：沒有閃光（素材不在被錄的螢幕上）、沒有短音（系統音訊靜音或被其他聲音蓋過）或配對太少。覆蓋規則沿用既有常數 `MIN_SYNC_PAIRS`（3）與 60 秒端點窗口；單一配對或只提出同步要求都不算證據。工具以非 0 結束或輸出不完整時該檢查 **fail**，不使用其部分輸出。報告沒有要求的證據維持 **n/a** 並附原因，絕不算 pass。格式檢查獨立量測，所以能量 blocked 時 48 kHz 立體聲仍可能 pass。整體判定依序為：任一 fail 為 fail，否則有 blocked 為 blocked，否則有 incomplete 為 incomplete，否則有 pass 為 pass，其餘 n/a；程序 exit 1 代表 fail 或 incomplete，2 代表 blocked，其餘 0。JSON measurement 以 `measured` 加值，或 `not-requested`、`unavailable`、`error` 加原因記錄每一項證據。這次變更前寫下的報告仍是舊的合併音訊檢查與三種判定，保留為歷史紀錄。

新 log 與量測輸出以英文為主；歷史 raw 記錄保留當時語言與判定，由雙語摘要解釋，不改數字或舊 fail。

## 音質迴歸測試

[音質測試：我們測什麼，為什麼要測](audio-quality.md)完整說明第 2 版素材、數學、門檻理由、迴歸案例與限制。

```bash
pnpm audio:quality -- record /tmp/audio-run-001
pnpm audio:quality -- record /tmp/audio-repeat-001 --repeat 3
pnpm audio:quality -- fixture /tmp/audio-reference-v2.wav
pnpm audio:quality -- verify /absolute/path/recording-of-v2.mp4
```

`record` 建置並驅動真正的開發版程式錄製 16 秒，擷取開始後以 macOS `afplay` 播放 12.1 秒測試音。先結束此專案的開發版程式；需要螢幕／系統音訊權限，以及 FFmpeg／ffprobe。保持輸出裝置與音量固定，暫停其他聲音；工具不更改設定。它會錄製主螢幕，並播放可聽見的聲音。`--repeat` 接受 1–10 次，預設 1 次；需要桌面環境，不能在無桌面的 CI 執行。

使用父目錄已存在的新目錄。每次保存 `reference.wav`、`capture.log`、`report.json`；多次量測分別存入 `run-1`、`run-2` 等子目錄。MP4 留在程式設定的輸出目錄，報告內有路徑。根目錄保存 `summary.json` 與前後環境快照，包括版本、原始碼／素材雜湊，以及能讀取的裝置資訊與音量。摘要提供最小值／中位數／最大值與缺少值數量，不隱藏任何失敗；前後裝置／音量快照改變時標為 invalid。整個 batch 與環境檢查完成前，部分摘要維持 `incomplete`；錯誤另寫入 `error.json`。

`fixture` 產生新 WAV，不覆寫既有檔案。`verify` 輸出 JSON；重新導向 stdout 時，直接用 Node 可避免 pnpm 標頭。只接受第 2 版測試素材的錄音，不適用一般音樂／語音或第 1 版錄音。只解碼前 60 秒，格式檢查不做重新取樣或混成立體聲。自有擷取子程序 60 秒逾時，解碼與外部工具呼叫也有時間界限。

結束碼 0 代表通過，1 代表量測未達門檻，2 代表量測無效或執行／輸入錯誤。PCM／標記不明確時，不輸出缺乏依據的頻率判定。新機制包含頻率擬合、同時 pilot、結尾標記、各成分重疊斷音視窗，以及局部削波／間隔檢查。設計章節解釋所有門檻與保護區；它們都不是經產品全面校準的品質保證。

`pnpm test` 執行正常／劣化 PCM 與多次摘要測試。安裝 FFmpeg／ffprobe 時，也驗證實際 AAC、低通、單聲道／44.1 kHz 與 CLI 契約；缺少工具時明確跳過整合案例。這些對照驗證偵測器，真正的 `record` 才驗證本機程式／OS 路徑。素材或分析器版本變更時，保留[歷史證據](../verification/README.md)原貌。

v0.1.0 已在本機完成瀏覽器下載／安裝驗證，Gatekeeper 需要單一 App 的「仍要打開」放行。詳見[本版證據](../verification/releases/0.1.0.md)。自簽不會消除此首次啟動阻擋；若重新考慮範圍，Developer ID 簽署及 Apple 公證是另一條發行路徑。

乾淨環境安裝依賴後，執行 `node node_modules/electron/install.js` 安裝 Electron 44 runtime（套件沒有 postinstall）。CI 發布流程已包含此步驟，見 [發布自動化](releases.md)。

## 官方網站

來源：[website/](../../../website/)，獨立的 pnpm 套件（Astro 7、TypeScript 6，因為 `astro check` 尚不能使用 TypeScript 7 的原生編譯器）。它不屬於 Electron 建置，也不在根目錄 `pnpm check` 之內。版面與 CSS 結構改作自 T3 Code 官網（MIT，見 [website/THIRD_PARTY.md](../../../website/THIRD_PARTY.md)）；視覺方向（石墨中性色、白字、紅色只用於錄影點、Geist）是 RecordStuff 自己的；主題檔仍沿用早先橘色方向的名稱 `ember.css`。Geist、JetBrains Mono 與 Kalam（手繪標註）透過 Fontsource 自行託管，執行時不向第三方發出請求。正式網址為 `https://record.ericts.com`；預覽可用 `SITE_URL` 覆寫。Hosting 是維護者在 Vercel 平台自行設定的專案（根目錄 `website/`，[website/vercel.json](../../../website/vercel.json) 關閉 Git 自動部署）。

| 指令（repo 根目錄） | 用途 |
| --- | --- |
| `pnpm site:dev` | Astro 開發伺服器 `http://localhost:4173/`；因未執行驗證，頁尾會顯示「manifest not re-verified」警語。Astro 7 會讓它常駐背景：以 `pnpm --dir website exec astro dev stop` 停止 |
| `pnpm site:manifest generate vX.Y.Z` | 抓取公開 release（GitHub API、release.json、SHA256SUMS）交叉核對後寫入 `website/release-manifest.json`；拒絕草稿、prerelease、多出或缺少的 asset，以及三個來源間任何不一致 |
| `pnpm site:manifest verify [--online\|--offline]` | 重新抓取並逐欄比對已存 manifest，並對 DMG 連結做 HEAD 檢查；`--offline` 只做結構檢查 |
| `pnpm site:build` | 先 `manifest verify --online`，再以 `SITE_MANIFEST_VERIFIED=1` 執行 `astro build`；輸出到 `website/dist/` |
| `pnpm site:check` | 網站單元測試、`astro check`、重新執行線上驗證與建置，再檢查該次產物的連結（站內路徑、fragment id、外部 URL）；不需預先存在 `dist/` |
| `pnpm site:screenshots` | 以 puppeteer-core 驅動已安裝的 Chrome，對每頁產生桌機（1440 px）、手機（390 px）與窄螢幕（320 px）整頁截圖到 `website/compare/`（已 gitignore）；同時把首頁場景停在錄影中的那一幀重新輸出 `website/src/assets/og.png`（1200×630 社群預覽圖；場景變動時需一併提交） |

Release 資訊只從已提交的 manifest 渲染：沒有瀏覽器端 GitHub API 呼叫、沒有執行時依賴。每個下載控制項都指向已驗證的 DMG 連結，旁邊提供 Releases 頁作為可見 fallback，因此過期的 manifest 會讓建置失敗，而不是渲染錯誤的按鈕。只有 `pnpm site:build` 可以設定 `SITE_MANIFEST_VERIFIED`；`astro dev` 與 `build:offline` 一律顯示頁尾警語。首頁視覺是內嵌 SVG（`website/src/components/DesktopScene.astro`）：露營地的 Mac 桌面，選單列以十九秒 CSS 循環（開頭靜止三秒、緩慢的鏡頭推拉、停止前的指示標註、延遲約半秒才彈出的通知、最後停留）演出產品故事——游標靠近時整個桌面向選單列圖示推近、游標點擊 RecordStuff 環形圖示、環變成實心圓點並在旁邊顯示「REC」（與 App 完全一致：tray-model.ts 切換 template 圖示並設定標題；不閃爍）、鏡頭拉回、手繪風標註（Kalam 手寫字型、雙筆觸草稿箭頭、無外框）顯示「Click again to stop recording」、游標點擊後約半秒，真實格式的「Saved <時間戳>.mp4」通知才彈出（與 App 的 `SAVED_NOTIFICATION_DELAY_MS` 一致）。地景為低多邊形（`src/components/scenes/FacetLandscape.astro`），上方是共用的選單列；星空由 `src/lib/stars.ts` 以固定種子產生。不需任何圖片請求，只動 transform／opacity；捲出畫面時 hero 會暫停它，`prefers-reduced-motion` 下靜態顯示最後一幀。依維護者決定沒有可見的暫停控制，因此對未開啟 reduced-motion 的使用者而言，WCAG 2.2.2（超過五秒的動態內容需可暫停／停止／隱藏）未達成。選單列文字與檔名格式與 App 一致。

[網站部署](../../../.github/workflows/website.yml) 在 main 的 push 修改 `website/**` 或 workflow 本身時自動執行，穩定版本記錄完成後也會呼叫，並支援在 main 手動重試。所有入口共用正式部署鎖，取得鎖後才 checkout 最新 main。三個儲存庫 Vercel secrets 的設定見[網站交付](releases.md#網站交付)。

CI 從 repository 根目錄執行 Vercel CLI，平台專案的 Root Directory 設為 `website/`。以 `vercel deploy --archive=tgz --prod --yes` 提交原始碼，不執行 `pull`、本機 Vercel 建置或 `--prebuilt`。Vercel 依設定執行 `pnpm test && pnpm check`：測試、Astro 診斷、manifest 線上驗證、正式建置、建置 feed 比對與 `dist/` 連結檢查。本機 `site:check` 使用相同的套件檢查。GitHub runner 的環境變數不會自動傳入遠端建置；除非另在 Vercel 設定，manifest 驗證使用公開 GitHub 端點。

部署設定使用靜態 JSON，讓 CLI 在尚未安裝網站依賴時即可讀取，不必解析 Astro 的 TypeScript 基底設定。

專案限定 token 透過既設的 `VERCEL_ORG_ID`／`VERCEL_PROJECT_ID` 指定目標，不加顯式 `--scope`：CLI 59.23.2 否則會在部署前要求使用者／團隊查詢權限。


### 更新功能驗收

在 RecordStuff 已結束時執行 `pnpm acceptance:updates`。需要 macOS arm64、Node 24、既有本機簽章身分、Chrome、ffmpeg／ffprobe，以及 System Events 輔助使用權限。會在主螢幕進行兩段短錄影；擷取期間停止其他音訊並避免操作桌面。腳本不會結束既有 RecordStuff、不取代安裝版、不斷網，也不寫入真正的使用者設定。

Runner 將原始碼與建置資源複製至專用報告目錄，只修改該副本，再執行 `pnpm start:app`。沿用正式更新 action handler、AppTray context、SettingsStore、Recorder、隱藏擷取主機與 shutdown 流程。只在測試副本中替換固定 HTTP 回應與時鐘，隔離設定／log／錄影，並攔截 `shell.openExternal` 核對 URL。正常建置沒有測試命令通道；若正式程式接線改變，anchor 檢查會停止，避免測到過期的替代流程。

預設案例涵蓋檢查中／重疊、相同／新版、GitHub 備援、失敗後恢復、語言／偏好跨程序重開、已到期但關閉啟動檢查、24 小時間隔（含失敗嘗試）、錄製中延後請求、存檔後才顯示結果，以及請求中結束。`--full` 另測舊版、無效／預覽／不相容 feed 與實際逾時取消；這些邊界已有單元測試，不必每次 smoke 都重跑。報告會記錄模式與所選 feed 情境。真實擷取沿用 System Events 全域快捷鍵、Chrome 固定素材、媒體完整性檢查與閃光／嗶聲門檻。兩種模式都保留兩段各約十秒的錄影，分別測延後請求與延後顯示結果。權限／工具缺失或素材受背景聲音污染，都不算通過。

`--logic-only` 明確略過真實擷取。`--require-native-ui` 把原生 UI 未驗證列為必要缺口（exit 2）；預設將它列在必要範圍之外。Handler／model 斷言**不代表**點過原生 Tray、確認瀏覽器畫面、聆聽播放、首次授權或公開版升級。現有 computer-use 無視窗 Tray 限制仍保留；不把呼叫 action handler 宣稱為滑鼠點擊。

報告位於 `docs/verification/measurements/<timestamp>-updates-*/`；`--out <新目錄>` 可指定路徑，既有目錄會被拒絕。`report.json`／`report.md` 列出每個必要案例，包含先前失敗後未執行的項目；保留請求／回應、事件、建置／簽章輸出、來源／產物雜湊與錄影驗證。Exit 0 表示所述範圍全部必要案例通過、1 表示失敗、2 表示受阻／不完整。SIGINT／SIGTERM 會要求收尾：測試 App 透過正式 shutdown 停止並保存錄影，只關閉專用素材瀏覽器 profile；無法安全退出的測試程序保留並回報清理失敗，不使用全域 kill。App 退出後才移除來源工作目錄，錄影與證據保留。

此隔離 fixture 也攔截存檔通知並記錄事件，避免第一段的通知遮擋第二段測試素材；通知顯示不在這項驗收範圍。影音分析會判定影格時序與閃光／提示音偏移，至少須有 5 組配對標記；短片不判定長時間同步漂移。聲道能量與標記是必要證據，所以 blocked 或 incomplete 的檢查與 fail 一樣會讓案例失敗。已存在的 `--out` 目錄會保留原內容，以明確訊息及退出碼 2 拒絕，不寫入報告。

## 設定快捷鍵驗收

在 `pnpm start:app` 之後採用 **System Events ＋ Computer Use** 混合流程：

```bash
pnpm acceptance:settings-shortcut
```

設定關閉、另一個 App 在前景時，這個 macOS arm64 腳本會核對本機 bundle 程序、最新 log session 與目前設定鍵註冊，再透過 System Events 送出 ⌘⌥,。擷取暫停、衝突或註冊失敗時拒絕送鍵。成功退出只代表收到本次設定 callback（最多等 30 秒），不代表視窗可見或聚焦。每次報告與 log 都寫入 `docs/verification/measurements/` 下的獨立目錄。

接著以原生 Computer Use 觀察真正面板、鍵盤導覽、重複執行指令、最小化還原、關閉重開，依[驗收 skill](../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)記錄 UI 結果。權限拒絕只回報，不自動修改。這是無人值守混合驗收，不是純 Computer Use 送鍵；沒有使用 IPC 或測試專用開窗入口。OS 衝突與錄製持續需各自驗證。

`pnpm acceptance:shortcut` 另執行第三個隔離的設定階段，使用正式 main／preload／頁面，透過受控註冊 adapter 驗證既存平台等價衝突、恢復、雙語拒絕、擷取暫停與 renderer 崩潰清理。測試會最小化真正的 Electron 視窗，再經註冊 callback 還原，斷言視窗數量與焦點。這屬於整合證據，與原生 Computer Use、真正 OS 衝突測試分開記錄；三個程序及暫存偏好皆會清理。

## 驗收收尾

完整 App 驗收每輪無論成功、失敗或中斷，都須保存測試錄影、還原設定、清理測試視窗、退出受測 App 並確認程序已消失。清理失敗算驗收失敗；保留證據，不重設權限。開發期間已授權按需停止錄影、退出、重啟或重建 RecordStuff，不需另行確認。退出只重設程序狀態，不會清除偏好。

桌面 runner（`acceptance`、`acceptance:settings`、`acceptance:shortcut` 與執行它們的 regression、`acceptance:settings-shortcut`、`acceptance:quit-dialog`、`acceptance:notification`、含擷取的 `acceptance:updates`、`matrix` 及 `audio:quality -- record`）共用 [desktop-session.mts](../../../scripts/lib/desktop-session.mts)：`caffeinate -u` 喚醒閒置關閉的螢幕；以 `ioreg` 的 `CGSSessionScreenIsLocked` 在啟動任何東西或送出按鍵前拒絕鎖定中的 session；`caffeinate -d -i -w <runner pid>` 讓螢幕保持開啟到 runner 結束；回合中（每 2 秒及結束時）偵測到鎖定，結果改為 BLOCKED、exit code 2，並在報告寫入 `Desktop:` 一行。隔離的 lifecycle fixture 不需要螢幕，不持有 assertion。

`pnpm acceptance` 會讓受測 App 保持關閉，並在 `report.md` 記錄包含收尾的最終結果；若程序已更換或無法確認待命，拒絕退出。通知驗收還原安裝產物與設定後保持 App 關閉。設定驗收管理自己的程序群組，包含中斷與逾時清理，結果寫入 `cleanup.json`。隔離 runner 只清理自己的程序；單元檢查不關閉無關 App。設定快捷鍵入口仍保留面板供原生操作，由完整 Computer Use 驗收負責退出。下一輪錄影驗收前需重新啟動；程式改動後用 `pnpm start:app` 重建。

快捷鍵 runner 在送出開始按鍵前及失敗時寫入 `input-diagnostics.json`：包含實際 AppleScript、App PID、送鍵程序、System Events UI 狀態、前景 App，以及 IORegistry 回報的 Secure Input 擁有者。沒有回報擁有者不代表已證明 Secure Input 關閉。診斷查詢唯讀、有時限，不會授予權限。失敗時也保留 `events.log` 與本次 `app-session.log`。osascript 成功不等於按鍵送達，必須收到 App callback 才算；逾時後不要盲目重送切換快捷鍵，以免停止延遲開始的錄影。送鍵失敗時，先對同一個 bundle 與輸入環境比較實體按鍵和產生的腳本，再判斷是否為 App 故障。


### 可重複的設定回歸

```bash
pnpm acceptance:regression
```

先執行 TypeScript、Vitest 與 build，再依序執行設定 fixture 和快捷鍵整合，避免重複建置。Console 會列出各自的 `docs/verification/measurements/` 報告；非零退出碼代表失敗，`&&` 確保失敗後不繼續下一階段。隔離整合另外連跑兩輪「設定快捷鍵 callback → 真正 Electron 按鍵 ⌘W（其他平台 Ctrl+W）→ Tray 設定 handler 重開」，斷言只有一個視窗、可見且聚焦、App 與註冊仍存在、偏好沒有改寫且未開始錄影或產生影片。

這是正式 main／preload／renderer 的整合回歸；快捷鍵註冊及 Tray 邊界受控，不能聲稱測過 OS 全域送鍵或實際 Tray 點擊。原生入口仍用 `pnpm acceptance:settings-shortcut` 加 computer use／人工觀察；真實錄影仍用 `pnpm start:app` 與 `pnpm acceptance`，後者會正常結束測試 App。實體拔插螢幕、VoiceOver 聽感及使用者理解仍需人工。已通過的案例若程式、環境或測試條件沒有相關變更，不要求使用者反覆重測。

## 錄製生命週期驗收

`pnpm acceptance:lifecycle` 建置隔離 Electron fixture，使用 production Recorder、FileWriter 與 `installQuitCoordinator`。它延遲真正的最終複製、handle close 或 partial 結果的 stat／發布，重複要求退出，確認程序跨過兩次期限仍存活，再釋放工作並檢查正式／保留檔的精確 bytes 與正常退出。100 ms 期限用來加速相同退出判定流程，不量測原生擷取或 UI 對話框。第四個 `history` 案例在可控制的儲存邊界上執行 production RecordingResults 與未保存提醒退出流程：歷史寫入卡住時取樣主程序事件迴圈延遲與隱藏 renderer 往返，合併重複退出，寫入進行中保持 App 開啟，選擇「留在 App」後恢復錄影，最終複製被延遲時暫不顯示 metadata 提示，完成後才選擇明確的「只放棄提醒」退出並檢查媒體精確 bytes。提示回答由腳本提供，不顯示原生對話框。不修改使用者偏好、不替換已安裝 App，也不載入一般 main 入口。結果與程序清理證據位於 `docs/verification/measurements/<timestamp>-lifecycle/`。依測試政策另行執行新 bundle 擷取／播放與原生退出案例。

### 引導式延期退出提示驗收

執行 `pnpm acceptance:quit-dialog -- --language zh-TW`，再以 `--language en` 重做。它啟動獨立 Electron 測試程序，使用隔離 userData 與合成 bytes；不錄影、不改正式偏好、不塞滿磁碟，也不替換已安裝 App。共用正式 `createQuitFeedback`、Recorder、FileWriter 與退出協調器。先給五秒準備，再透過受控的複製延遲與縮短為 100 ms 的退出期限觸發真正的原生提示。請在五秒內切換到另一個 App，觀察提示是否置前、只有一個且文字完整易讀，30 秒內按提示按鈕關閉。關閉後 fixture 確認複製仍在等待，再解除延遲、驗證精確 bytes 並重新正常退出。產生的 `.mp4` 只有合成 bytes，不是可播放的錄影。

`--help` 不啟動程序；錯誤參數在啟動前失敗。Ctrl+C 只取消隔離程序群組，重複取消訊號不會跳過外層清理。此 runner 取消／逾時時立即 SIGKILL 自己建立的可丟棄合成程序群組；其他 runner 保留預設的 SIGTERM 正常收尾。外層 40 秒期限限制無人操作的執行；中斷、逾時或強制清理都算失敗，不算通過。此 macOS／Electron 上，即使加入 JavaScript 訊號 handler，SIGTERM 取消仍未阻止正式退出提示在強制清理前出現。合成 fixture 專用的 SIGKILL 避免這種誤導，固定記為強制清理與失敗；不作用於正式 RecordStuff。Log 與 `report.json`／`report.md` 保留在 `docs/verification/measurements/<timestamp>-quit-dialog-<language>/`。報告刻意將原生觀察留為 **not recorded**，需另記觀察者、置前／文字結果與截圖。共用提示去重及生命週期測試不代表原生視窗層級已驗證。這是帶 Electron 圖示／系統按鈕語言的開發 fixture 證據，不是正式簽章產物身分或真實錄影證據。

由 agent 自動做視覺驗收時，依[原生驗收技能](../../../.agents/skills/astra-acceptance-with-computer-use/SKILL.md)：agent 擷取真正提示，以截圖搭配 accessibility 狀態自行判讀、關閉提示，再核對生命週期與清理證據。工具支援時保存 PNG，否則明確引用工具圖像。此自動化需要具桌面能力的 agent；單獨指令不會呼叫模型。自動置前需要被動的前後桌面證據，先選取目標或只看 App 裁切圖不能證明；維護者確認仍標為人工證據。

**報告提醒：** 測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。保留既有流程，不增加每輪核准或鍵鼠監控。若已知受干擾，受影響的原生觀察標為 blocked／無法判定，保留原始截圖、log 與 runner 結果，不直接判為產品通過或失敗；需要有效結論時，再於無干擾環境重測該項。報告與最後回覆均附上此提醒。
