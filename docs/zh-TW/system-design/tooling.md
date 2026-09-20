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
| pnpm acceptance:notification | 對 /Applications 裡的 App（可用 `--install` 在本次換成 dist 的建置）：錄影、透過輔助使用按下「已儲存」橫幅、判定 Finder 是否在最前面且顯示該檔，每個 Finder 狀態連點多次，預設英文；報告寫到 docs/verification/measurements |

main、preload、renderer 分別建置，打包只納入 out、package metadata 與指定 resources。測試、量測與文件不屬 runtime；App 不呼叫 FFmpeg。

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

[共用設定](../../../electron-builder.yml) 定義安裝介面：540×380 的 Finder 視窗、程式產生的箭頭背景、128 點圖示，以及恰好兩個項目——App 在 x=130、`/Applications` 連結在 x=410，中心皆在 y=190。[local 設定](../../../electron-builder.local.yml) 繼承它並停用公證／timestamp／DMG 簽章與更新 metadata；不得再加 `dmg.contents`，因為 `extends` 會串接陣列，而發布閘門拒絕 `Applications`、`RecordStuff.app` 與隱藏 Finder 版面檔以外的任何根目錄項目。刻意不附任何格式的說明檔，安裝、更新與移除指引放在線上。檔名為 RecordStuff-版本-架構-selfsigned.dmg，arm64 與 x64 非 universal；目前只有 arm64 驗過。pnpm dist:mac 產生與 CI 在 tag 推送時建置並公開相同的 DMG（取代舊的 dist:mac:local 別名與分開的 dist/dev、dist/local 資料夾）；共用設定停用公證。dist:win 尚未驗證，不代表已支援發行。

收件者可能需要單一 App 的「仍要打開」，受管理 Mac 也可能不允許；依 [安裝指南](../../../resources/INSTALL.zh-TW.md) 與 [Apple](https://support.apple.com/102445) 正常操作，不修改全域安全設定。同一份指南也說明手動更新（結束、下載、在相同 Applications 路徑取代；身分與設定保留）與移除（結束、把 App 移到垃圾桶；錄影、`~/Library/Application Support/recordstuff` 與 `~/Library/Logs/recordstuff` 除非使用者自行刪除否則保留）。沒有解除安裝器、背景服務或自動權限重置。

## 量測工具

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm verify -- /absolute/path/any-desktop-recording.mp4 --screen 1920x1080   # 只驗完整性
pnpm acceptance -- --seconds 10        # 對執行中的 App 做無人值守快捷鍵驗收
pnpm acceptance:notification -- --install          # 點「已儲存」通知 → Finder 置前；約 1 分鐘；本次把建置好的 App 換進 /Applications
pnpm acceptance:notification -- --install --full   # 三種 Finder 狀態、英文；估計約 3 分鐘
pnpm matrix -- quick
pnpm matrix -- all
pnpm matrix -- long
```

verify 支援多檔、log、來源尺寸、同步標記、Markdown／JSON 與指定 JSON 輸出。結果預設存至 docs/verification/measurements（已 gitignore，原始執行只留本機，解讀後的結論才寫進驗證紀錄）；讀 active log 與最新 .1 archive，以免 session 因輪替無法配對。

### 測試素材

`scripts/test-material.html` 是所有量測共用的唯一固定頁面：捲動小字（銳利度）、紅藍細線與彩色文字（色度邊緣）、每幀移動的方塊（幀率時序）、右上角每秒閃白 100 ms 的方框，以及同一音訊時鐘上的柔和 660 Hz 音（120 ms、約 −10 dBFS、左右交替）。閃光與音是同步標記：`verify --sync` 以 ffmpeg blackdetect 看方框、silencedetect（−35 dB、0.4 秒）看音訊找出它們，所以頁面其餘時間必須靜音，機器上也不能有別的聲音在播。音訊稀疏，這類錄影的 AAC 碼率只回報不判定（`--test-material`）。手動開啟時要點一下才開始（瀏覽器自動播放政策）；`pnpm matrix` 與 `pnpm acceptance` 用全新 profile 的 Chrome app 模式全螢幕在主螢幕開啟、允許自動播放並帶 `?auto=1`，不需點擊。驗收報告會記錄頁面的 SHA-256，結果可對應素材版本。版本沿革：2026-09-19 以前是 1 kHz、60 ms、音量 0.5 的嗶聲；2026-09-20 改為上述較柔和的 660 Hz 音，首次執行在 20 秒內偵測到 20 次閃光與 19 個音、音畫偏移 79 ms，落在歷史 45–80 ms 延遲範圍內，先前的同步結果仍可比較。目前 SHA-256：`e631b973a793cde1d5326a9cc58da0d88a522ca3c3041b1c9a2d0f3561c41459`。

matrix 只支援 macOS 開發環境。預設以 Chrome app 模式全螢幕在主螢幕開素材頁，可用 --no-open-material 自行開；固定音量與來源螢幕。以 RECORDSTUFF_AUTORECORD 驅動未打包 App，打包版忽略。seconds 範圍 (0,3600]，quality override 合併固定預設，不讀使用者品質作為基準。

| 矩陣 | 內容 |
| --- | --- |
| quick | 三段 30 秒：1440p 標準／高品質、原尺寸標準 |
| levels | 三段 30 秒 1080p：精省／標準／高品質 |
| fps | 原尺寸標準 30／60 fps，各 30 秒 |
| long | 180 秒 1080p 標準 30 fps 漂移回歸 |
| all | 縮短至 15 秒的案例加 long，含間隔約七分鐘 |

10 分鐘基準已做過，long 改 3 分鐘是使用者決定，不更改舊結果。

Autorecord 存檔後立即退出，因此 macOS 待送的儲存通知會被退出流程取消；橫幅不屬於 autorecord 完成條件。

### 通知驗收

Plan 017 時序診斷新增 `tracksStoppedAt`（renderer 停止 tracks 後的 wall-clock 毫秒）、主程序 `host stopped`、`file finalized`，以及 `saved scheduled`、`saved cancelled`、`saved request failed`。JS 時間戳不代表 OS 已就緒；需與既有 request／show／click 日誌、AX 觀察及可取得的窄範圍 macOS 紀錄對照。App 不要求系統日誌存取。macOS 的儲存通知延遲 500 ms，runner 仍只在存檔後搜尋 5 秒。Plan 017 要求**連續兩輪完整驗收各 15 案例全部通過**，只達 runner 一般覆蓋門檻不算完成。

每個案例另外保存 `<language>-<finder>-<click>-diagnostics.json`：帶時間的搜尋嘗試、有限長度的 Accessibility 結構文字／錯誤，以及 App 通知生命週期事件。未通過案例會再取一份只觀察、不點擊的快照（最多 5 秒，因此失敗案例可能較久）。App 分別記錄請求顯示、shown、clicked、closed、failed；shown 事件本身不代表腳本找到可見橫幅。這些本地檔案可能包含通知文字，不會提交。

`pnpm acceptance:notification` 檢查明確點擊儲存通知後，是否選到檔案且 Finder 置前。每個案例錄影 2 秒、最多搜尋該次通知 5 秒、取樣前景 App 3 秒，再讀取 Finder 選取與輔助使用反白列。找不到橫幅記為未執行，不再額外錄影重試。每組至少需要兩次通過且沒有失敗；未執行次數仍會列出。

預設為英文、Finder 關閉、五次點擊，約一分鐘；`--full` 涵蓋三種 Finder 狀態 × 五次點擊，維持英文，共 15 個案例；依先前單次耗時推估約三分鐘，實際時間受輔助使用操作影響。它只擴充 Finder 覆蓋，不改語言。通知翻譯由單元測試覆蓋；原生繁中驗證可指定 `--languages zh-TW`，明確需要雙語時使用 `--full --languages en,zh-TW`（30 個案例）。每個案例印出開始、進度與耗時。較短的 smoke check 可用 `--clicks 2`，低於二會拒絕。其他選項：`--finder closed,behind,minimized`、`--languages en,zh-TW`、`--seconds`、`--front <app>`、`--keep-recordings`、`--out`。

先前在安裝版重現了本地 dist 執行未出現的焦點競態：通知 callback 後 macOS 才啟動 RecordStuff。因此測試 `/Applications/RecordStuff.app`；`--install` 暫時將已簽章的 `dist/mac-arm64/RecordStuff.app` 複製進去，再還原已驗證的原 App。成功還原後刪除備份，失敗則保留並回報路徑。原始報告保存在 `docs/verification/measurements`。

使用專用桌面執行：開始前關閉 Finder 視窗，執行中不要操作桌面，並授予終端機輔助使用及對 Finder、TextEdit 的自動化權限。既有 Finder 視窗會讓前置檢查停止，不會被關閉。每個案例開啟一份暫存 TextEdit 檔案，只關閉該檔案，不碰其他文件。Finder 視窗在建立或確認 reveal 後以 ID 追蹤；無法辨識的視窗（例如取得 ID 前就被中斷的 reveal）保留並回報需手動清理。關閉測試文件後，TextEdit 若沒有其他文件就正常退出；若有其他文件則保留。這避免引入通用視窗快照／還原系統。 通知判定檢查整個登入工作階段的前景 App 與 Finder 選取，不檢查視窗位於哪一個螢幕。測試視窗在副螢幕仍可符合判定；RecordStuff 仍錄製主螢幕，所以錄影中未必會出現那些視窗。指定螢幕或 Space 的視窗位置不在驗收範圍。

Ctrl-C 或 SIGTERM 會取消命令與等待。命令上限為 10 秒（程序查詢 5 秒，App 複製 60 秒）；快捷鍵送出與 Finder 建立視窗會先完成其最多 5 秒的命令，再處理取消。清理有獨立的 120 秒期限，給本段錄影最多 30 秒完成停止／存檔，停止只送一次，不會用前段紀錄判定本段已停止。若無法確認錄影停止，保留執行中的 App 與備份，不結束或替換它。App 停止後才還原語言設定，若原先在執行則重開。未完成、取消或清理失敗都讓報告失敗。期限涵蓋非同步操作，不保證能處理無回應的檔案系統或 OS。

未涵蓋 tray 選單定位、其他 Spaces、橫幅消失後從通知中心清單點擊。強化後腳本於 2026-09-20 實測約 64 秒完成預設五次流程，SIGINT／SIGTERM 取消約 2 秒完成清理，見驗證紀錄。後續當時預設的雙語 `--full`（現在需指定 `--full --languages en,zh-TW`）於 371.74 秒完成，25 通過、1 次點擊未送達失敗、4 次未出現通知；清理及空白 TextEdit 退出成功。未解失敗見驗證紀錄。

## 驗收門檻

media-tools 呼叫 ffprobe／ffmpeg；verify.mts 純解析／計算／判定；verify-recording.mts 配對與寫結果；CLI／matrix 編排。長片分開取頭尾影格時間戳，不把未取樣中間區間算掉幀。素材頁提供持續動態畫面與同一 audio clock 上的閃光／短音。

檢查分兩層。**完整性**檢查適用於任何內容，也是發布驗收所需：它們問的是「檔案是否就是該次錄影產生的東西」。**效能**檢查只有在畫面持續變動時才有意義，因為螢幕擷取在畫面靜止時不會送出影格；只在 `--moving` 或 `--sync`（測試素材頁，`pnpm matrix` 使用）時判定，否則標 n/a 但仍顯示量測值。

| 層 | 指標 | 目前專案門檻 |
| --- | --- | --- |
| 完整性 | 尺寸 | 符合 capture report、上限與已知來源比例 |
| 完整性 | 時長 | 有指定 matrix 時長則用它，否則用 log 的 session 長度（`state → recording` 到 `state → stopping`），±2 秒 |
| 完整性 | 音訊／影像時長差 | 絕對值 <100 ms |
| 完整性 | 音訊−影像起始偏移（容器） | 嚴格介於 −45 與 +125 ms |
| 完整性 | 音訊 | 48 kHz、2 聲道；有量時各聲道 RMS >−60 dBFS |
| 完整性 | 視訊碼率 | 至少為要求目標的 70%；超過只是檔案較大，不算失敗 |
| 完整性 | 音訊碼率 | 至少為要求目標的 50%；AAC 隨內容變化。帶 `--test-material`（`--sync` 隱含、`pnpm acceptance` 會設定）時只回報不判定：素材頁的稀疏嗶聲遠低於任何要求值，連續音訊的碼率交給[音質診斷](audio-quality.md) |
| 完整性 | 解碼 | ffprobe 全影格無錯；播放器操作另驗 |
| 效能 | fps | 要求 ±2 fps |
| 效能 | 掉幀 | <2% |
| 效能 | 音訊−影像偏移（閃光／短音） | 嚴格介於 −45 與 +125 ms |
| 效能 | 結尾漂移 | 絕對值 <100 ms，需足夠同步標記 |
| 效能 | CPU | Electron 合計平均 ≤40%（僅 matrix） |

碼率採下限而非目標，因為 Chromium 編碼器在 60 fps 時會超出要求 1.5–2 倍但仍達到預期品質；只有碼率不足才代表問題。這些是 THRESHOLDS 常數，不是任意素材的品質保證。缺 ffmpeg 時可能只有格式檢查通過而無能量量測；需讀 notes／n/a。beep 素材碼率低，dual-mono 也會通過雙聲道能量檢查。任一 fail 整體 fail，有 pass 且無 fail 為 pass，全部無法判定則 n/a。

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
