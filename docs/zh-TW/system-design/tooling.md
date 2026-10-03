# 建置、打包與驗收工具

[English](../../system-design/tooling.md) | [繁體中文](tooling.md)

## 開發流程

專案使用 pnpm，package.json 的 Node 要求為 ≥22.12；TypeScript 量測腳本使用 Node 24 直接執行。FFmpeg／ffprobe 只供開發量測，不隨 App 安裝。

| 指令 | 用途 |
| --- | --- |
| pnpm install | 安裝依賴 |
| pnpm dev | 熱重載；授權對象可能歸於啟動的終端機／編輯器 |
| pnpm start | build 後透過 macOS open 開啟 Electron.app，供音訊測試 |
| pnpm start:app | 建置、自簽、驗證、開啟 RecordStuff.app；印出各階段耗時，並記錄 bundle 的 runtime 輸入 |
| pnpm open:app | 記錄的 runtime 輸入仍相符時，驗證並開啟既有開發包，不重建 |
| pnpm check | typecheck、完整 Vitest、build |
| pnpm icons | PNG／ICO（系統匣圖示與 Windows App 圖示 `build/icon.ico`）、DMG 背景圖（1x／2x）；macOS 額外產 native ICNS |
| pnpm log | 追蹤 macOS log |
| pnpm dist:mac | 自簽 App 驗證後，在 dist/ 旁邊產生 DMG |
| `pnpm dist:win` | `electron-vite build` 後在 dist/ 產生未簽章、每位使用者安裝的 Windows x64 NSIS 安裝檔（`electron-builder --win nsis --x64 --publish never`）；不簽章。只有 CI 的 Windows runner 執行過（[細節](#windows-打包與-ci)） |
| `pnpm diagnose:cadence` | 經由隔離的 capture host fixture 錄製測試素材，比對 track 送達的影格時間戳與計數和檔案 pts，找出幀率不足發生在哪一層（[說明](#影格節奏診斷)）；僅限 macOS，不做通過／失敗判定 |
| pnpm acceptance | 對執行中的 App，使用其實際設定（含倒數）：全螢幕開素材、以 System Events 送全域快捷鍵開始／停止錄影、分別回報準備時間、每格倒數、`record → started` 與第一片、裁出最初影格的數字區域、驗完整性層級（test-material 模式），再以第二次按鍵取消另一次嘗試；把報告寫到 docs/verification/measurements（已 gitignore，只留本機） |
| `pnpm acceptance:playback` | 以 QuickTime Player 的 AppleScript 字典播放一個已存檔的錄影，判定長度、尺寸、即時播放、跳轉、畫面隨跳轉改變及播放到結尾；報告寫在 docs/verification/measurements，截圖只在未通過時保留（[說明](#播放檢查)） |
| pnpm acceptance:settings | 對已建置的產物：在真實 Electron 視窗載入 `out/preload/settings.js` 與 `out/renderer/settings.html`，判定出貨 CSP、sandbox preload 邊界與真實 IPC 往返；報告與截圖寫到 docs/verification/measurements。需要先 `pnpm build`，不需要 tray 或已安裝的 App |
| `pnpm acceptance:regression` | 一個指令執行 check（含建置）、設定 fixture 與快捷鍵整合；包含重複開啟／關閉／Tray 路徑重開。隔離偏好與程序，各 runner 保留報告；任一步失敗立即停止。不會啟動或關閉使用者的 RecordStuff，也不錄影。 |
| `pnpm acceptance:recipe` | 逐階段執行驗證配方，相同輸入只建置一次，並寫出計時報告（[詳見](#驗證配方與計時)） |
| `pnpm acceptance:tray` | 對執行中的 bundle：以 CoreGraphics 點擊與按鍵、輔助使用的 press 操作真正的狀態列項目與選單；雙語比對 idle、倒數與錄影選單和正式 model，並涵蓋開始與停止、顯示上一段錄影、三種取消、鍵盤導覽與結束；保存選單截圖供視覺檢視（[說明](#tray-驗收)） |
| pnpm acceptance:notification | 對 /Applications 裡的 App（可用 `--install` 在本次換成 dist 的建置）：錄影、透過輔助使用按下「已儲存」橫幅、判定 Finder 是否在最前面且顯示該檔，每個 Finder 狀態連點多次，預設英文；報告寫到 docs/verification/measurements |

main、preload、renderer 分別建置，打包只納入 out、package metadata 與指定 resources。測試、量測與文件不屬 runtime；App 不呼叫 FFmpeg。

`scripts/fixtures/` 的原始碼統一使用 TypeScript，納入 `pnpm typecheck`。獨立入口由 [build-fixture.mts](../../../scripts/lib/build-fixture.mts) 使用 Vite 的 TypeScript 轉換按需編譯：settings-panel、recording-lifecycle、history-quit、quit-dialog、frame-cadence 與 release-record-network 輸出 ESM（`.mjs`）；shortcut-failure 因為要在載入正式 App 前攔截 CommonJS 載入，所以輸出 CommonJS（`.cjs`）。frame-cadence-renderer 是唯一在 renderer 端執行的 fixture：輸出一般 script（IIFE），讓 `file://` 頁面在 capture host 的 CSP 下載入；它由 `tsconfig.web.json` 以 DOM 型別檢查，`tsconfig.node.json` 則排除它。產物保留在各次驗收報告目錄或測試暫存目錄，不是需要維護的原始碼，也不隨 App 發布。update-acceptance fixture 繼續隨臨時 App 原始碼副本一起建置。現有驗收指令不需額外手動建置 fixture；編譯只移除型別，型別檢查由 `pnpm typecheck` 負責。傳給 `executeJavaScript` 的 renderer 字串仍是執行時程式碼，不會得到 TypeScript 的 DOM 型別檢查。

## 資源與產生的輸出

- `build/` 是納入版本控制的打包資源：`icon.png`、macOS 原生 `icon.icns`、Windows 的 `icon.ico`（16–256 px，供執行檔、安裝檔與捷徑使用），以及 DMG 背景 `background.png` 與 Retina 配對 `background@2x.png`（540×380 點）。打包設定以此作為 `buildResources`，明確指定 macOS 使用 ICNS，並用 `tiffutil` 把背景配對合成多解析度 TIFF。請保留；修改圖案後以 `pnpm icons` 重新產生。所有圖像都由程式產生，repo 沒有手繪二進位檔。
- `resources/` 包含執行時使用的選單列圖示、macOS entitlements，以及雙語安裝／更新／移除指南（`INSTALL.md`、`INSTALL.zh-TW.md`）。指南是由 GitHub release 與 README 連結的文件；打包 filter 只複製 PNG／ICO，因此指南不會進入 App 或 DMG。
- `out/` 由 `pnpm build` 產生；`dist/` 是 `pnpm start:app`（App bundle 在 `dist/mac-arm64/`）、`pnpm dist:mac`（同一個 bundle 加 DMG）與 `pnpm dist:win`（`RecordStuff-<version>-x64-unsigned-setup.exe`）共用的唯一輸出目錄。兩者都由 Git 忽略，可以重新產生。清理 `dist/` 前應保留仍需要的安裝檔；`pnpm open:app` 需要以目前 runtime 輸入建置的既有 App bundle。本機建的 DMG 用來檢查打包；發布的 DMG 與 Windows 安裝檔一律由 CI 從 tag 建置。
- `node_modules/` 放已安裝的開發依賴，可透過 `pnpm install` 還原。

品質選項與錯誤碼各自只維護一份常數清單，TypeScript 型別由清單推導，選單也共用品質清單。型別檢查會拒絕未使用的區域變數與參數。設定檔 v1 遷移仍保留，以延續既有的輸出資料夾偏好。

`pnpm signing:create` 保留既有符合名稱的憑證，或依明確輸出位置與密碼建立加密身分檔，見 [身分設定](signing.md)。不匯入私鑰或設定信任。

## 簽章與打包

身分設計、憑證建立／備份、故障排除與待實作 CI 配置，見 [macOS 簽署身分與自簽設計](signing.md)。

[start-app.mjs](../../../scripts/start-app.mjs) 預設精確挑選 RecordStuff Dev，可用 RECORDSTUFF_SIGN_IDENTITY 的完整名稱或 SHA-1 指定。缺少、重名、過期、非自簽、成品身分不同均停止。憑證用 SHA-1 辨識，下載檔完整性用 SHA-256。

重建前檢查 RecordStuff／本專案 Electron 是否仍執行。子程序環境移除 Apple／CSC 發行變數，停用身分自動搜尋，強制簽章、公證 false、publish never。不重置權限、不匯入私鑰、不發布。

驗證深度 codesign、巢狀 app／framework 公開憑證、identifier、runtime 與最外層 designated requirement；不追 symlink。先驗過 App 才封 DMG。

[共用設定](../../../electron-builder.yml) 定義安裝介面：540×380 的 Finder 視窗、程式產生的箭頭背景、128 點圖示，以及恰好兩個項目——App 在 x=130、`/Applications` 連結在 x=410，中心皆在 y=190。[local 設定](../../../electron-builder.local.yml) 繼承它並停用公證／timestamp／DMG 簽章與更新 metadata；不得再加 `dmg.contents`，因為 `extends` 會串接陣列，而發布閘門拒絕 `Applications`、`RecordStuff.app` 與隱藏 Finder 版面檔以外的任何根目錄項目。刻意不附任何格式的說明檔，安裝、更新與移除指引放在線上。檔名為 RecordStuff-版本-架構-selfsigned.dmg，arm64 與 x64 非 universal；目前只有 arm64 驗過。pnpm dist:mac 產生與 CI 在 tag 推送時建置並公開相同的 DMG（取代舊的 dist:mac:local 別名與分開的 dist/dev、dist/local 資料夾）；共用設定停用公證。

收件者可能需要單一 App 的「仍要打開」，受管理 Mac 也可能不允許；依 [安裝指南](../../../resources/INSTALL.zh-TW.md) 與 [Apple](https://support.apple.com/102445) 正常操作，不修改全域安全設定。同一份指南也說明手動更新（結束、下載、在相同 Applications 路徑取代；身分與設定保留）與移除（結束、把 App 移到垃圾桶；錄影、`~/Library/Application Support/recordstuff` 與 `~/Library/Logs/recordstuff` 除非使用者自行刪除否則保留）。macOS 沒有解除安裝器、背景服務或自動權限重置。

### Windows 打包與 CI

依維護者 2026-10-03 的決定（[設計決策](decisions.md)），共用設定也有 `win` 與 `nsis` 區段：使用 `build/icon.ico` 的 x64 NSIS 目標、產物名稱 `RecordStuff-<version>-<arch>-unsigned-setup.exe`、每位使用者的一鍵安裝檔（`oneClick: true`、`perMachine: false`、不需管理員權限），其開始選單捷徑帶有 appId `com.ericts.record` 作為 Windows toast 所需的 AppUserModelID；`deleteAppDataOnUninstall: false`，所以「設定 → 應用程式」中的解除安裝程式保留錄影、設定與 log；`differentialPackage: false`，因為沒有更新器就不需要 blockmap。`files` 與 `extraResources` 維持共用，所以 Windows 安裝內容帶有相同的 `app.asar` 輸入與系統匣 ICO。`pnpm dist:win` 是單純的 electron-builder 呼叫，不走 macOS 簽章路徑；`start-app.mjs` 仍拒絕 macOS arm64／x64 以外的主機，並指向它。沒有任何維護者機器執行 Windows，因此這些只在 GitHub 的 runner 上建置與檢查過，從未在 Windows 實機上執行。

[check.yml](../../../.github/workflows/check.yml) 在每次推送到 main，以及每個改動不只是文件或網站的 pull request 時執行 `pnpm check`，分成兩個 job：`macos-15` 上的 `check` 與 `windows-2025` 上的 `check-windows`，與發布建置使用相同的 runner image。`check-windows` 另外執行 `pnpm dist:win`，接著執行 `node scripts/release.mts windows-smoke dist`，也就是與發布相同的靜默安裝、檢查與解除安裝閘門（[發布契約](releases.md#發布契約)），並把安裝檔上傳為保留 7 天的 `windows-installer` artifact；它是建置產物，不是發布。`workflow_dispatch` 可在任何分支執行這兩個 job，讓工作分支在進入 main 前就能在 Windows 上檢查。[.gitattributes](../../../.gitattributes) 設定 `* text=auto eol=lf`，讓 Windows checkout 保留 README 與 fixture 的 byte 比對所預期的 LF 換行；預期值因平台而異的測試（路徑分隔符、`chmod` fixture、只有 POSIX 才有的工具）改為依平台判斷，而不是在兩個平台都略過。

## 量測工具

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm verify -- /absolute/path/any-desktop-recording.mp4 --screen 1920x1080   # 只驗完整性
pnpm acceptance -- --seconds 10        # 對執行中的 App 做無人值守快捷鍵驗收
pnpm acceptance -- --skip-cancel --countdown-sound   # 同上，本回合開啟倒數音效（plan 046）
pnpm acceptance:playback -- /absolute/path/recording.mp4   # 以 QuickTime Player 做播放案例；約 20 秒
pnpm acceptance:settings                           # 設定頁面與 preload 在真實 Electron 視窗；包含截圖矩陣
pnpm acceptance:notification -- --install --clicks 2  # 通知日常 smoke：兩次點擊
pnpm acceptance:notification -- --install          # 點「已儲存」通知 → Finder 置前；約 1 分鐘；本次把建置好的 App 換進 /Applications
pnpm acceptance:notification -- --install --full   # 三種 Finder 狀態、英文；估計約 3 分鐘
pnpm matrix -- quick
pnpm matrix -- all
pnpm matrix -- long
pnpm matrix -- fps,long                                  # 一個回合跑多個矩陣：只建置一次、只開一次素材
pnpm matrix -- fps,quick --repeat 2                      # 重複的案例交錯執行；摘要依案例分組
pnpm diagnose:cadence                                    # 30 與 60 fps 的影格節奏，各錄兩次
pnpm diagnose:cadence -- --request 30:30.6,60:62.4       # 比較候選的幀率要求
pnpm measure:finalization -- --dir /Volumes/test/rs --seconds 15 --repeat 10   # 錄到隔離資料夾，量停止到可再開始的時間與各階段
pnpm bench:publication -- --dir /Volumes/test/rs --sizes 64m,2g                 # 依檔案大小量發布成本，不錄影
pnpm measure:cpu                                         # 在已結束的打包 App 上量 CPU 預算：待機、一段 30 fps 錄影、錄影後待機、設定開著；約 15 分鐘
pnpm measure:cpu -- --fps 60 --repeat 3                  # baseline 回合：兩種幀率各錄三次；約 25 分鐘
```

verify 支援多檔、log、來源尺寸、同步標記、Markdown／JSON 與指定 JSON 輸出。聲道能量是必要證據，帶 `--sync` 時閃光／短音標記也是；有檢查 fail、必要證據 incomplete 或檔案無法讀取時 exit 1，缺少必要工具（blocked）時 exit 2，其餘 exit 0（見[判定](#驗收門檻)）。結果預設存至 docs/verification/measurements（已 gitignore，原始執行只留本機，解讀後的結論才寫進驗證紀錄）；會讀所有保留的檔案（active log 與 `.1`～`.3`，由舊到新），並依身分配對錄影與 session（plan 029）：使用 [session record](desktop.md#log-與診斷) 的 run 與 session id，以檔案完整路徑查找；只有 log 中恰好一個 session 指名同名檔案時才退回用檔名（複製出去的檔案）。同一筆 record 記兩次仍是一個結果；同一 session 出現不同結果則是 conflict。沒有留下檔案的失敗不宣告任何路徑，因為同一秒的重試可能重用它的暫存檔名。session record 之前版本的啟動使用保守的舊版關聯：只有沒有其他可能擁有者時才接受（`file finalized` 行、唯一仍在錄製的 session，或文字相符且唯一未解決的失敗），因此兩個未解決的失敗絕不依印出順序分配。其餘情況報告會標出 metadata 為 ambiguous、conflict 或 unknown，不判定任何需要要求設定的檢查；媒體量測不依賴 metadata。`pnpm acceptance` 與 `pnpm matrix` 在 metadata 沒有配到自己 session 時判該案例失敗。2026-09-25 以 244 個保留 log 重播，舊的依順序讀法配到的 628 個檔案全部得到相同關聯；保留 log 中沒有舊讀法會出錯的「收尾順序顛倒」交錯。

### 測試素材

`scripts/test-material.html` 是所有量測共用的唯一固定頁面：捲動小字（銳利度）、紅藍細線與彩色文字（色度邊緣）、每幀移動的方塊（幀率時序）、右上角每秒閃白 100 ms 的方框，以及同一音訊時鐘上的柔和 660 Hz 音（120 ms、約 −26 dBFS、左右交替）。閃光與音是同步標記：`verify --sync` 以 ffmpeg blackdetect 看方框、silencedetect（−35 dB、0.4 秒）看音訊找出它們，所以頁面其餘時間必須靜音，機器上也不能有別的聲音在播。音訊稀疏，這類錄影的 AAC 碼率只回報不判定（`--test-material`）。手動開啟時要點一下才開始（瀏覽器自動播放政策）；`pnpm matrix` 與 `pnpm acceptance` 用全新 profile 的 Chrome app 模式全螢幕在主螢幕開啟、允許自動播放並帶 `?auto=1`，不需點擊。驗收報告會記錄頁面的 SHA-256，結果可對應素材版本。版本沿革：2026-09-19 以前是 1 kHz、60 ms、音量 0.5 的嗶聲；2026-09-20 改為上述較柔和的 660 Hz 音，首次執行在 20 秒內偵測到 20 次閃光與 19 個音、音畫偏移 79 ms，落在歷史 45–80 ms 延遲範圍內，先前的同步結果仍可比較。2026-09-29 音量由 0.3（約 −10 dBFS）調降為 0.15（SHA-256 `4064e63e…`；10 秒內 10 次閃光配對 10 個音，偏移 65 ms，聲道 RMS 由 −27.3 變為 −33.2 dBFS），2026-09-30 再調降為 0.05，約 −26 dBFS，仍比 silencedetect 門檻高 9 dB，讓在旁邊的人不被打擾。擷取取得的是頁面的數位電平，在系統輸出音量之前，所以音量設定不會縮小這個餘裕。首次驗收在 10 秒內配對到 10 次閃光與 10 個音，偏移 61 ms，聲道 RMS −42.8 dBFS。同一檔案只把音訊離線衰減後，到 −6 dB 仍配對全部 10 組（63、65 ms）；−9 dB 漏掉兩個音、偏移讀成 101 ms，`verify` 卻仍判定通過；−12 dB 則失敗。這個音量保有 6 dB 的乾淨餘裕，也是仍保有這個餘裕的最小音量，請勿再調低。音在 attack 開始約 3.6 ms 後越過偵測門檻（0.3 時為 0.6 ms），閃光與音的偏移因此多出幾毫秒，遠小於一個影格：偏移與 drift 仍可比較，但先前版本的音訊電平（聲道 RMS）較高，不能作為這一版的基準。目前 SHA-256：`e98bf1fc63d2e7f0662a6d3dca62f21bdf3afa9debff6b4e64455b46a20a70bb`。

matrix 只支援 macOS 開發環境。預設以 Chrome app 模式全螢幕在主螢幕開素材頁，可用 --no-open-material 自行開；固定音量與來源螢幕。以 RECORDSTUFF_AUTORECORD 驅動未打包 App，打包版忽略；錄影期間以[共用 CPU 取樣程式](#cpu-預算)取樣 App 的程序樹。seconds 範圍 (0,3600]，quality override 合併固定預設，不讀使用者品質作為基準；另可選填 `countdown`（0、3、5 或 10），以及只在該次執行於記憶體中取代已保存資料夾的絕對路徑 `outputDir`。未指定倒數時 autorecord 一律倒數 0 秒，matrix 與音質量測因此維持原本的時序，從不使用已保存的倒數設定。每個案例都要求聲道能量與同步標記（plan 030）：matrix 在建置或錄影前先檢查 ffmpeg、ffprobe 與 Command Line Tools 的 clang，缺少就 exit 2（blocked）。只有沒有任何檢查 fail、blocked 或 incomplete 的案例才算通過；未通過的案例會在執行結尾與量測檔中列出每個未達成的檢查及原因，整輪 exit 1。

一次呼叫就是一個桌面回合（plan 042）：只建置一次 `out/`、只開一次素材，依序執行列出的矩陣。名稱以逗號分隔（多個參數會合併），同一名稱列兩次就跑兩次，所以 `fps,fps,long` 會錄 fps 兩次、long 一次。`--repeat N`（1–10）重複整份清單，因此同一案例的重複會和其他案例交錯，不會總是最先跑或在機器最熱時跑；`--dry-run` 印出執行順序。名稱未知或空白、選項未知，或 `--repeat` 不在 1–10，會印出用法並 exit 2。案例接連執行：前一個檔案驗證完就啟動下一個，驗證的時間就是兩次錄影之間的休息。每個案例都會印出並寫入一行計時（啟動到開始錄影、錄影、停止到存檔、退出，以及每個驗證工具），量測檔另有 Timing 表，列出本回合的 preflight、建置、素材與總耗時。跑超過一次的案例標題為「run k of n」，Repeats 表列出每一次的判定，以及平均幀率、影格間隔中位數、掉格、CPU 平均與第 95 百分位、編碼器 CPU、閃光／短音偏移、漂移與影片位元率的最小值、中位數與最大值；每一次都通過，該案例才算通過。因 ffmpeg 或 ffprobe 消失而提前停止、沒有執行到的案例，算作 blocked 的一次。exit code 規則不變，只有清理後仍有程序殘留時整輪 exit 1。收到 SIGINT 或 SIGTERM 時，會停止建置的整個 process group，對執行中案例的 App 送 SIGTERM（App 的正常退出流程會先停止並儲存進行中的錄影；啟動後 5 秒內會先等 App 出現；30 秒後仍在執行的會被強制結束），等素材啟動完成後關閉素材瀏覽器，結束桌面回合，確認程序都已結束，再以 130 或 143 結束，不寫量測結果；並指出被中斷案例已存的檔案（未經驗證）。只會停止本 checkout 的 Electron.app 與素材私有 profile 的程序，不會動到已安裝的 RecordStuff。ffprobe 或 ffmpeg 執行中收到的 SIGTERM 會在該工具結束後、下一個案例開始或寫入任何量測之前生效（數秒內）；Ctrl-C 則會連同工具本身一起停止。

案例的額外耗時主要來自驗證，其中又以兩次 ffprobe（完整解碼計算影格數與讀取影格時間戳）為大宗：在 M1 Pro 參考機上，30 秒 30 fps 的檔案 5.4 秒中佔 4.6 秒，60 fps 13.9 秒中佔 12.4 秒，long 27.0 秒中佔 22.9 秒。三次 ffmpeg（astats、blackdetect、silencedetect）合計不到 1 秒（long 為 4 秒），因此維持分開執行。

| 矩陣 | 內容 |
| --- | --- |
| quick | 三段 15 秒：1440p 標準／高品質、原尺寸標準 |
| levels | 三段 30 秒 1080p：精省／標準／高品質 |
| fps | 原尺寸標準 30／60 fps，各 15 秒 |
| long | 180 秒 1080p 標準 30 fps 漂移回歸 |
| all | levels、60 fps 與 quick 的案例各 15 秒，加 long |

10 分鐘基準已做過，long 改 3 分鐘是使用者決定，不更改舊結果；quick 與 fps 自 plan 042 起為 15 秒，仍有約 14 組閃光／短音配對，遠高於最少 3 組。在參考機上，每個回合約有 8 秒的 preflight、建置與素材，每個案例再加上錄影本身、約 2.5 秒的啟動與退出，以及驗證（15 秒 30 fps 案例約 3 秒、60 fps 約 7 秒、long 約 27 秒）：單跑 fps 約 1 分鐘、quick 約 1.2 分鐘、long 3.6 分鐘、all 約 6 分鐘（依 plan 042 的分段計時估算）。

Autorecord 存檔後立即退出，因此 macOS 待送的儲存通知會被退出流程取消；橫幅不屬於 autorecord 完成條件。

### 影格節奏診斷

`pnpm diagnose:cadence`（plan 041）用來找出幀率不足發生在哪一層；它不做判定，也不隨 App 發布。每次執行都會錄製測試素材（和 matrix 一樣用 Chrome kiosk 開啟，除非加 `--no-open-material`），錄製經由隔離的 [frame-cadence fixture](../../../scripts/fixtures/frame-cadence.ts)：正式的 main 端 capture host、建置好的 capture-host preload 與真正的 renderer host，display-media 要求也照 App 的方式回應（主螢幕加 loopback）。它以 `open -a` 開啟開發用 Electron.app，沿用該 App 的螢幕錄製授權；執行前先結束 RecordStuff 與開發用 App。[renderer 包裝](../../../scripts/fixtures/frame-cadence-renderer.ts)只負責觀察：在 MediaRecorder 之前為 video track 送達的每個影格記下時間戳（`MediaStreamTrackProcessor`），每秒取樣 `track.stats` 與 `getSettings().frameRate`，並標記 recorder 的開始與停止。runner 比對錄影期間的這些時間戳、送達／丟棄計數（從 recorder 開始後的第一個取樣起算，排除啟動瞬間）與檔案 pts，取樣 Electron CPU，再依分布指出偏差所在的層：`source-floor`（影格送到 track 時已晚，沒有丟棄）、`track-limiter`（track 丟棄超過 1%）、`recorder-timestamps`（在 track 準時、檔案裡變晚）或 `on-time`；中位數以週期的 1% 為界。若 tap 看到的影格少於檔案影格的 99%，結果為 `undetermined`，因為卡住的觀察端看起來會像變慢的來源。它不計算重複影格；對保留的檔案執行 `ffmpeg -vf mpdecimate` 即可看到。間隔百分位採用 [stats.mts](../../../scripts/lib/stats.mts) 共用的 nearest-rank，中位數為中點中位數，因此 p95 與 `measure:cpu`、`measure:finalization` 的意義相同。2026-09-29（plan 053）之前寫出的報告以線性內插計算 p05 與 p95；其中位數不變，但 p05/p95 無法與之後的報告直接比較。

選項：`--rates 30,60`、`--runs 2`（兩種幀率交替執行）、`--seconds 30`、`--load N`（每次錄影期間維持 N 個忙碌程序）、`--request 30:X,60:Y`（在 `getDisplayMedia` 與 `applyConstraints` 中把這些幀率的 frame-rate constraint 換成 `{ ideal, max }`）、`--ideal-only`（只給 `{ ideal }`）、`--label`。不加 `--request` 時量測產品本身的要求。證據寫到 `docs/verification/measurements/<timestamp>-frame-cadence/`（`summary.md`、`summary.json`，以及每次的 `recording.mp4`、`result.json`、`fixture.log`）。每次都產生證據與分類時 exit 0，有一次沒有或清理後仍有程序殘留時 exit 1，缺 ffprobe 或桌面鎖定時 exit 2。收到 SIGINT 或 SIGTERM 時，會停止本輪自己啟動的 fixture、忙碌程序與素材瀏覽器，確認它們已結束，再以 130 或 143 結束，不寫 summary。同步、聲道能量、位元率與掉格仍由 `pnpm matrix` 判定。

### 收尾量測

`pnpm measure:finalization`（plan 037）量測停止錄影後要讓下一段錄影等多久，以及時間花在哪裡；它不做判定，也不隨 App 發布。每次呼叫是一個桌面回合：建置一次、開啟測試素材（Chrome kiosk，除非加 `--no-open-material`），再透過開發版 App 與 `RECORDSTUFF_AUTORECORD` 錄製 `--repeat` 段（預設 5）、每段 `--seconds` 秒（預設 15），使用 `--quality`（預設 standard）與 `--fps`（預設 60）的原始解析度，寫到 `--dir`；這個絕對路徑作為 autorecord 的 `outputDir`，因此不會寫入 settings.json。執行前先結束 RecordStuff 與開發版 App。停止到可再開始的時間是 App log 從 `state → stopping` 到 `state → idle`，也就是切換鍵再次開始新錄影的時刻；各階段取自 recorder 的 `finalize timing` 行（host 交付、佇列寫入、flush、close、發布與其方式、清理，以及中斷 sentinel 的完成 checkpoint），另加從 `file finalized` 到 idle 的 UI 收斂。checkpoint（`checkpoint N ms`，plan 053）會讀取該次錄影的 sentinel，並在 userData 以 fsync 原子重寫，因此 userData 磁碟區變慢時會顯示在這裡；最後一次 sentinel 寫入失敗的錄影會略過它並記為 `checkpoint ? ms`，而此欄位出現之前的 log 行仍可解析，只是沒有這一項。每段檔案都需要有影像流與音訊流、無解碼錯誤，且除非因低空間提前停止，長度需在要求值 ±2 秒內。`--verify quick`（預設）以 ffprobe 完整解碼第一段已儲存的檔案，其餘只讀取串流與長度，並只解碼最前與最後一秒；`--verify full` 則每段都完整解碼。區間解碼使用 ffprobe，因為 `ffmpeg -f null` 會把靜止畫面重複的時間戳記報成錯誤，即使每個影格都能解碼。之後刪除檔案，除非加 `--keep`，因此回合不會在磁碟區累積錄影。慢速、小容量或非原生檔案系統請指向隔離資料夾或磁碟映像；不要塞滿系統磁碟。證據寫到 `docs/verification/measurements/<timestamp>-finalization-<label>/`（`summary.md` 含各階段的 nearest-rank 分布，以及 `summary.json`）。每段都儲存並驗證通過時 exit 0；任一段未通過、超過時限（報告會註明 App 之後是收到 SIGTERM 正常退出，還是必須強制結束），或收尾留下程序時 exit 1；缺少 ffprobe、App 已在執行或桌面鎖定時 exit 2；SIGINT 或 SIGTERM 會先等仍在進行的啟動最多 5 秒，再正常結束本回合的 App 並關閉素材，不寫摘要，exit 130 或 143。

### 發布量測

`pnpm bench:publication`（plan 037 之後）回答同一個磁碟區上，儲存時的發布成本如何隨檔案大小變化；不需要錄影、桌面、螢幕權限或 `out/`。它把[量測程式](../../../scripts/fixtures/publication-bench.ts)與正式的 FileWriter 打包，在 Electron 自己的 Node（`ELECTRON_RUN_AS_NODE`）下執行，所以發布用的是 App 的 libuv。對每個 `--sizes`（預設 `64m,2g`）與每一輪 `--repeat`（預設 3），它以 4 MiB 的區塊把檔案寫入 `--dir`，呼叫 `finish`（磁碟區允許時連結，否則複製），並回報發布、flush、close 與清理時間、發布方式與連結的錯誤碼，以及寫入速度；除非加 `--keep`，檔案隨即刪除。寫入速度遠快於錄影，`finish` 時大部分資料還沒 flush，所以 flush 階段比真實錄影後更大：判讀時看發布，flush 以 `pnpm measure:finalization` 為準。磁碟區剩餘空間少於最大尺寸的兩倍加 1 GiB 時拒絕執行，因為複製期間會同時存在兩份；加 `--keep` 時，所有保留的檔案也計入。證據寫到 `docs/verification/measurements/<timestamp>-publication-<label>/`（`summary.md`、`summary.json`）。每個檔案都發布成功時 exit 0；任一失敗 exit 1；參數錯誤或空間不足 exit 2；SIGINT 或 SIGTERM 會停止量測並移除它自己的檔案，exit 130 或 143。

### CPU 預算

`pnpm measure:cpu`（plan 049）在打包後的 App 上確認 RecordStuff 在選單列待命時 CPU 很少、錄影時在正常範圍；`pnpm matrix` 以同一個取樣程式判定錄影 CPU。CPU 以單一核心的百分比表示，與「活動監視器」相同（M1 Pro 參考機有十個核心，整台機器是 1000%）。喚醒次數是每秒的 idle 加 interrupt 喚醒，即「活動監視器」的「閒置喚醒次數」。待機時允許執行哪些東西，見[設計總覽](design-overview.md#在選單列待命)。

**取樣程式。**[cpu-sampler.c](../../../scripts/lib/cpu-sampler.c) 參考 Cap 的逐程序取樣程式，以 Command Line Tools 的 `clang` 編譯到該次執行的資料夾；沒有 Command Line Tools 時量測是 blocked（exit 2），不會略過。它依固定時程每秒列出所有程序，保留 App 的主程序與其所有子孫程序（每次取樣都重新解析），以及所有名為 VTEncoderXPCService 的程序，並印出各程序 `proc_pid_rusage` 的計數：以奈秒計的 CPU 時間、idle 與 interrupt 喚醒、能耗與常駐記憶體。不使用 `ps`：它的 CPU 時間以百分之一秒為單位，對待機的一秒太粗（0.2% 只有 2 ms），而它的 `%cpu` 是會衰減的平均，會壓平尖峰，也會把啟動時的負載帶到之後的取樣。[cpu-sampler.mts](../../../scripts/lib/cpu-sampler.mts) 把計數轉成每秒數字，回報每個程序與合計的平均、第 95 百分位（nearest rank）與最大值。一段範圍只計入完全落在範圍內的每秒區間，所以範圍開始前用掉的 CPU 不會混進來；App 的程序組合有變化的那一秒會被捨棄並列出，預期會有程序開始或結束的地方除外。判定的區間不到範圍的 80%，或取樣程式在被停止前就結束時，該範圍判定失敗：缺少的取樣絕不會被當成 0% CPU 而通過。系統的硬體編碼器 VTEncoderXPCService 另外回報，不算進 App；它是系統共用的服務（參考機待機時就有四個），所以判讀它的 CPU，而不是它是否存在。能耗是 macOS 自己對每個程序的估計，只回報不判定。

**情境。**先用 `pnpm start:app` 建置並結束 App，再執行 `pnpm measure:cpu`。有任何 RecordStuff 或這個 checkout 的開發版 Electron.app 在執行時它會拒絕開始。它在 App 結束的狀態下，把倒數設為關閉、錄影螢幕設為主螢幕（素材會開在那裡）、品質設為標準、原始解析度、30 fps 寫入 settings.json，啟動 `dist/mac-arm64/RecordStuff.app`，並等到 `ready;`、權限已授予、`recording history: loaded`，以及啟動時更新檢查的結果或 `updates: launch check skipped` 那一行出現，確保啟動工作都結束後才開始判定：

- **A. 啟動後待機**，設定視窗關閉：暖機 60 秒後量 `--minutes`（預設 5）分鐘。
- **R. 錄影**：以錄影快捷鍵開始並停止一段 60 秒的錄影，畫面上是持續移動的測試素材（主螢幕上的 Chrome kiosk），只判定第 5 到 55 秒，並追蹤 VTEncoderXPCService。`--repeat N`（奇數，1–9，讓中位數就是其中一次的實際結果）錄 N 次、判定中位數那一次。`--fps 60` 之後會結束 App、寫入 60 fps 再重新啟動，錄第二組。
- **B. 錄影後待機**：從最後一次儲存後 30 秒起量 `--minutes` 分鐘，套用待機門檻。
- **C. 設定視窗開著、在其他 App 後面**：用設定快捷鍵開啟，並以 App 的 `settings shortcut: … pressed` 那一行、執行中的設定 renderer 與輔助使用樹中的設定視窗確認已開啟（沒有錄影的一次啟動仍留著預熱的 renderer），再把 Finder 帶到最前面，穩定 10 秒後量 3 分鐘，之後關閉。

**程序角色。**每個待機情境也會依 Chromium 角色檢查 App 的程序；角色取自程序命令列的 `--type` 與 `--utility-sub-type`，因為三個 helper 的名稱都一樣。待機契約是 cpu-sampler.mts 的 `IDLE_ROLES`：主程序、GPU 與網路服務各一個，除此之外只能有[設計總覽](design-overview.md#在選單列待命)說明過的程序。也就是啟動後（A）最多一個預熱 renderer，第一個視窗會拿走它；錄影後（B）最多一個 Chromium 音訊服務，由第一次擷取系統聲音啟動，一直存在到 App 結束；設定視窗開著時（C）剛好一個 renderer，也就是設定頁，所以沒有真的開啟的設定視窗會判定失敗，而不是量到關閉時的待機。設定視窗關閉時，錄影後不能留下任何 renderer，所以即使預熱 renderer 已經不在，殘留的 capture host 或倒數覆蓋層仍會判定失敗；其他任何角色也一樣會失敗。每次儲存後 5 秒會記下一次角色，同一次啟動中的每一次記錄，以及 B 結束時的角色，都必須和第一次相同：錄影只啟動一次的東西是預期的，每錄一次就多一份的才是洩漏。這和 [fuite](https://github.com/nolanlawson/fuite) 這類洩漏偵測工具的做法一樣，看每次重複的成長，而不是和冷啟動比較。報告也會列出每次記錄時 App 的記憶體，只回報不判定。

`--skip-recording` 省略 R 與 B，`--skip-settings` 省略 C，`--out` 指定報告資料夾。報告是 `docs/verification/measurements/<time>-cpu/`（git 忽略）下的 `report.md` 與 `report.json`，包含每個情境對照預算的檢查、判定與捨棄的區間、合計與逐程序的 CPU、喚醒、能耗與記憶體、儲存的檔案，以及機器、macOS、Electron、螢幕、電源與產物時間。結束時 runner 會正常結束 App（中斷時，若已要求啟動 App，會先等最多 10 秒讓它出現），確認它已退出，關閉素材瀏覽器並確認它也已結束，在沒有任何 RecordStuff 程序後，把 `countdown`、`display` 與 `quality` 設回執行前的值，並保留 App 在這段時間存下的其他設定；原始檔案另存在報告旁的 `settings-before.json`。錄影檔留在輸出資料夾。和其他桌面 runner 一樣，它會宣告使用者活動，並在整個執行期間持有螢幕與閒置睡眠的 assertion。每項判定都通過時 exit 0；任一失敗、執行出錯或收尾不完整時 exit 1；blocked（沒有 Command Line Tools、沒有輔助使用權限、螢幕鎖定）時 exit 2；收到 SIGINT 或 SIGTERM 時，會先收尾進行中的錄影（只有在這段錄影正在倒數或錄影、且尚未送出停止時才送出快捷鍵，因此絕不會開始新的錄影），再關閉素材、結束 App 並還原設定，再寫出標記為 INTERRUPTED 的部分報告，exit 130 或 143。

**預算。**plan 049 的初始目標，已由參考機 M1 Pro 的 [2026-09-28 baseline](../verification/history-2026-09.md#plan-049-cpu-baseline-結案--2026-09-28) 確認；數值放在 cpu-sampler.mts 的 `CPU_BUDGET`。

| 狀態 | 門檻 | 理由 |
| --- | --- | --- |
| 待機、設定視窗關閉（A，以及錄影後的 B） | 平均 ≤0.2%、每秒取樣的第 95 百分位 ≤1%、合計每秒喚醒 ≤5 次 | 沒有事要做：唯一的週期性工作是每 5 秒一次的權限輪詢。Apple 的[能耗指南](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)要求 App 回應事件而不是輪詢 |
| 錄影後（B） | 儲存後 30 秒起符合待機門檻、符合待機契約的角色且沒有 renderer，而且每次錄影後的角色都相同；VTEncoderXPCService 低於 0.1% 只是警告，因為它是共用服務 | 殘留的計時器、renderer 或編碼器會在這裡出現；和剛啟動時比較則抓不到，因為第一次錄影會拿走預熱 renderer，並只啟動一次音訊服務 |
| 設定視窗開著、在其他 App 後面（C） | 平均 ≤0.5% | 一個沒有動畫在跑的閒置 renderer |
| 錄影 30 fps（R 與矩陣） | 平均 ≤30%；baseline 確認之前，沿用原本 40% 的上限 | 擷取與 H.264 編碼在硬體上執行；App 自己負擔的是 Chromium 媒體管線、AAC、IPC 與檔案寫入 |
| 錄影 60 fps | 平均 ≤40% | 影格加倍，但固定成本不會加倍 |
| 錄影時的硬體編碼器 | 只回報不判定 | 若它不存在而 App 自己的 CPU 很高，可能退回軟體編碼；在 Cap 的量測中，軟體編碼每個影格的成本是硬體路徑的數十倍 |
| 對照 baseline | 錄影比本機同一案例的 baseline 高出 25% 以上時發出警告，即使仍在門檻內 | 寬鬆的上限可能藏住退步；CPU 在不同回合間會漂移，所以只警告不判失敗 |

baseline 存在 [cpu-baselines.json](../../../scripts/lib/cpu-baselines.json)，以 `sysctl hw.model` 為鍵：每個錄影數字是三次重複平均值的中位數，由 baseline 回合的報告手動填入，並同時寫入驗證紀錄。沒有記錄的機器只對照門檻。換機器或升級 Electron 時，要先取新的 baseline 才能比較結果。baseline 沒通過目標時是要調查的發現；沒有書面證據與維護者同意，不能因此放寬目標。

**矩陣。**`pnpm matrix` 的每個案例以同一個取樣程式追蹤開發用 Electron.app 的主程序與其子孫程序（啟動後一秒內開始），判定範圍是該案例錄影的第 3 秒到要求停止為止；沒有這些 log 行的案例，改用啟動後第 3 秒到退出，這段期間預期 capture host 會啟動與結束。取樣程式沒找到 App、提前結束，或取樣不到判定範圍 80% 的案例，會以 CPU 證據不完整判定失敗。CPU 檢查會列出平均、第 95 百分位、峰值與 VTEncoderXPCService，超過該幀率的門檻時判定失敗，並註記比 baseline 退步（也會印在主控台）以及編碼器不存在的情況。plan 049 之前記錄的 17%、21% 與 23% 來自 `ps` 在整個案例上會衰減的平均，無法與現在的數字比較。

### 選擇驗收範圍

依[共用測試規則](../testing.md)選擇必要及可排除的檢查。原生／錄影使用[共用案例與報告](../acceptance.md)。本頁維護指令操作及門檻，不另定一套測試選擇規則。

Updates 使用插樁副本，matrix 使用 autorecord，兩者都不能代替正常建置 App 的驗收。通知驗收保留安裝路徑與不同 Finder 狀態的覆蓋。同一未變更檔案與相同驗證範圍可共用媒體證據；不同產物或 UI 操作不可互相替代。素材參數與有時限的 log 等待共用 `scripts/lib/acceptance.mts` 與 `scripts/lib/acceptance-runtime.mts`；各 runner 保留自己的 App 生命週期與判定。Log 位置是 `scripts/lib/log-reader.mts` 的 rotation-aware cursor（plan 029），等待與收尾共用：cursor 由檔案身分（device、inode、birth time）加 byte offset 組成，從它往後讀時會跟著該檔案到目前所在的 archive，再讀所有較新的檔案，每行只讀一次。它容忍輪替改名後、下一次追加前的空檔，保留尚未換行的最後一行，而且 retention 已刪除或截斷已抹去 cursor 所在歷史時，會明確回報 evidence gap，不會等到逾時。cursor 另外記下 offset 之前的 64 bytes；只會追加的 log 不會改動它們，所以檔案在兩次讀取之間被截斷又長回超過 offset，也會回報 gap，不會靜默跳過。被 single-instance lock 拒絕的第二次啟動所寫的 `start:` 行不算程序啟動，因此不會遮住執行中 App 的狀態，也不會切開它的 log。快捷鍵 runner 要求 App 的 run id，把等待綁定到本次 capture record 指名的 session，並從該 session 的終止 record 取得檔案。會實際錄影的 runner 都不把倒數算進延遲門檻（plan 040）：`pnpm acceptance` 使用實際設定，並從 App log 分別回報各階段（按鍵 → `prepared`、從第一格起每個 `state → countdown (n)`、overlay 的 dismissal、`record` 相對起點的時間、`record → started`、`started → first chunk`）；通知 runner 連同語言把 `countdown: 0` 寫入設定，結束後還原使用者原值；更新 fixture 在隔離的 userData 設為 0；autorecord 使用 0。被取消的倒數以其 `cancelled:` 行作為中斷錄影的收尾依據；收尾時若仍在倒數，只按一次鍵取消。

有倒數時，`pnpm acceptance` 把 log 記錄的 overlay 位置（視窗與螢幕範圍，單位 pt）換算為影格像素，將該區域在最初 15 格，以及依時間戳選出的 2 秒後 15 格的裁圖存到 `digit-crops/`。在測試素材上，這個區域位於每秒閃白一次的黑色標記框內，所以每張早期裁圖都與相同閃光相位的後期裁圖比較：任一張偏亮（閃光期間白色數字看不出來）就略過；只要有一格的平均亮度差超過 3 個等級，或沒有任何一格可判定，該回合即失敗。沒開素材時只保存裁圖、不判定。取消案例接著按下快捷鍵、等待 `state → countdown`、再按一次，要求取消原因為 `toggle`、暫存檔與最終檔都不存在、沒有失敗、通知、`record` 或 recording 行，並回到 idle；`--skip-cancel` 可略過，倒數關閉時則不適用。報告依 `prepared` 行的 `sound on`／`sound off` 說明本次倒數是否有音效（plan 046）。有音效時，runner 把錄影最初 500 ms 與 2 秒起的 500 ms 音訊混為單聲道，以 Goertzel 量測 50 ms Hann 視窗（每 25 ms 一格）在提示音的兩個音高 523 與 784.5 Hz 上最大的一格。素材的 660 Hz 音在兩個視窗都會以約 −58 dBFS 洩漏到這些頻段，而提示音在滿音量時約為 −28 dBFS；因此最初視窗比後段高出 6 dB 以上且高於 −70 dBFS，或最初 500 ms 出現沒有對應閃光的 beep 起點時，該回合即失敗。擷取可能在素材 beep 播放中開始：檔案會先是一段靜音，接著 beep 直接以全音量出現；這個陡峭的起點會讓兩個提示音音高都出現約 −41 dBFS 的能量，而 2 秒後同一個 beep 有 10 ms 的 attack，不會如此。因此 runner 會尋找這種被截斷的起點：最初視窗中第一個達到峰值一半的 sample，其前 25 ms 到 1 ms 之間不超過峰值的十分之一（容許一個 AAC frame 的 pre-echo），再更早則沒有任何高於 −70 dBFS 的內容。找到時，兩個視窗都靜音到該點，並從該點以 20 ms 淡入後再量測：重複的 beep 在兩邊得到相同的平緩起點，使後段視窗在提示音音高上維持約 −67 dBFS，因此檔案從提示音尾巴中開始時，提示音仍會突出，不會被起點的能量蓋住。自己有 attack 的聲音、一開始就有聲音的檔案，以及沒有任何內容高於 −70 dBFS 的視窗，都照錄製內容比較，因此不會丟棄任何可能達到下限的聲音。報告會列出這個起點（plan 054）。它看不到的是：擷取同時也在 beep 中開始時，一個在擷取前約 60 ms 以上就開始、−28 dBFS 的提示音殘留的微弱尾巴。`--countdown-sound` 在本回合開啟儲存的開關：已經開啟（缺少欄位視為開啟）時不做任何變更；關閉時，runner 會先檢查所有可能拒絕本回合的條件（輸出資料夾、已鎖定的桌面），再結束 idle 的 App、只設定這個欄位、重新開啟同一個 bundle。只有在確認沒有任何 RecordStuff 程序後才把欄位改回：在最後結束 App 之後；若重新開啟後的準備失敗，則在結束它開啟的 App 之後。因為仍在執行的 App 下次存檔時會把本回合的值寫回去；無法確認 App 已結束時，該次執行判為失敗並說明欄位未還原（[stored-override.mts](../../../scripts/lib/stored-override.mts)）。儲存的倒數為關閉時會拒絕執行。通知 runner 與更新 fixture 把倒數設為 0，autorecord 永遠不發聲，受控 build 以預設值啟動，因此沒有其他 runner 會錄到它。`pnpm acceptance` 送出停止鍵前，會查看本 session 自 capture 紀錄起是否已有 `saved` 或 `failed` 紀錄；已結束的 session 會被回報並使該次執行失敗，不送出按鍵，因為 idle 的 App 會把它當成新的開始（plan 054）。快捷鍵與通知 runner 共用中斷錄影的收尾，等待存檔，成功送出停止命令後不再次切換快捷鍵；runner 的證據 log 會在遺失歷史的位置標示 gap。

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

### 播放檢查

`pnpm acceptance:playback -- <檔案>` 不需要人或 Computer Use 操作播放器，就能涵蓋已存檔案的[播放案例](../acceptance.md#錄影-smoke-與原生案例)。它以 `open -a "QuickTime Player"` 開啟檔案，再透過 AppleScript 操作播放器：QuickTime 的長度與 ffprobe 相差不超過 0.5 秒、尺寸相同；從頭播放時，2 秒實際時間至少播放 75%；跳到 25%、再跳一次 25%、再跳到 75%，落點誤差在 0.25 秒內；前景視窗在兩個位置之間的畫面平均變化至少 1 個灰階，且超過同一位置兩次畫面差異的四倍；從結尾前 1.5 秒播放會在結尾停止。音軌、QuickTime 靜音與系統輸出音量只回報、不判定。`report.md` 與 `result.json` 寫到 docs/verification/measurements 下的新目錄；每一步的截圖用於畫面檢查，只在未通過時保留在該目錄。Exit code 為 0 通過、1 失敗（含收尾不完整）、2 blocked：不是 macOS、沒有 ffmpeg／ffprobe、session 鎖定，或 QuickTime Player 已在執行；最後一種會被拒絕，確保它只關閉自己開啟的東西。它關閉自己的文件、退出播放器並確認程序結束。第一次執行用的是 2026-10-01 的 10.27 秒 smoke 錄影，兩個位置之間的平均變化為 29.42，同一位置兩次為 1.18（期間控制列淡出）。

截圖需要終端機有「螢幕錄製」權限；沒有時截圖裡不會有 QuickTime 視窗，畫面檢查會失敗並附上提示。不涵蓋：點擊播放器本身的控制項、其他播放器，以及聲音聽起來是否正確，這需要人來聽。

## 驗收門檻

若要從零理解錄影管線、測試素材、每個指標的意義，以及為什麼某些設定量起來比較好，請看學習文章[錄影到底錄得好不好：螢幕錄影工具的品質量測入門](../../learning/measuring-screen-recording-quality.html)。本節仍是現行指令與門檻的依據。

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
| 效能 | fps | 要求 ±2 fps。旁邊同時列出影格間隔中位數與標稱週期（只回報），用來區分每格都慢的節奏偏差與掉格 |
| 效能 | 掉幀 | <2% |
| 效能 | 音訊−影像偏移（閃光／短音） | 嚴格介於 −45 與 +125 ms，至少 3 組配對的閃光／短音。距離檔案頭尾超過 1 秒的閃光或短音若沒有配對就判定失敗（素材頁本身啟動時、第一個短音前最多兩次閃光除外）：剩下的配對仍能算出中位數，但在偵測門檻附近漏掉短音時曾讀成 101 ms，正確值約 65 ms |
| 效能 | 結尾漂移 | 絕對值 <100 ms。至少 120 秒（要求或實測）的錄影，前 60 秒與後 60 秒各需至少 3 組配對；較短的錄影沒有漂移可判定 |
| 效能 | CPU | App 程序樹在錄影第 3 秒之後的平均：30 fps ≤30%、60 fps ≤40%；並回報第 95 百分位、峰值與 VTEncoderXPCService；比本機 baseline 高出 25% 以上時發出警告（僅 matrix；見 [CPU 預算](#cpu-預算)） |

碼率採下限而非目標，因為 Chromium 編碼器在 60 fps 時會超出要求 1.5–2 倍但仍達到預期品質；只有碼率不足才代表問題。這些是 THRESHOLDS 常數，不是任意素材的品質保證。beep 素材碼率低，dual-mono 也會通過雙聲道能量檢查，但不能證明立體聲分離。

每個檢查的判定為 pass、fail、blocked、incomplete 或 n/a（plan 030），由呼叫端說明需要哪些證據：matrix 要求聲道能量與同步標記，`pnpm verify` 要求能量、帶 `--sync` 時也要求標記，`pnpm acceptance` 要求能量，更新驗收兩者都要求。必要證據因工具缺少而無法量測時為 **blocked**。必要標記有量但數量不足，或長錄影缺少任一端的窗口時為 **incomplete**，並附原因：沒有閃光（素材不在被錄的螢幕上）、沒有短音（系統音訊靜音或被其他聲音蓋過）或配對太少。覆蓋規則沿用既有常數 `MIN_SYNC_PAIRS`（3）與 60 秒端點窗口；單一配對或只提出同步要求都不算證據。工具以非 0 結束或輸出不完整時該檢查 **fail**，不使用其部分輸出。報告沒有要求的證據維持 **n/a** 並附原因，絕不算 pass。格式檢查獨立量測，所以能量 blocked 時 48 kHz 立體聲仍可能 pass。整體判定依序為：任一 fail 為 fail，否則有 blocked 為 blocked，否則有 incomplete 為 incomplete，否則有 pass 為 pass，其餘 n/a；程序 exit 1 代表 fail 或 incomplete，2 代表 blocked，其餘 0。JSON measurement 以 `measured` 加值，或 `not-requested`、`unavailable`、`error` 加原因記錄每一項證據。聲道 RMS 的有限 dBFS 值使用數字，非有限值則使用字串 `"-Infinity"`（數位靜音）、`"Infinity"` 或 `"NaN"`（無效量測），讓 JSON 寫入再讀回後仍保留原意。舊資料中的 `null` 音量值屬無效量測，不能作為有聲音的證據。這次變更前寫下的報告仍是舊的合併音訊檢查與三種判定，保留為歷史紀錄。

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

乾淨環境安裝依賴後，執行 `node node_modules/electron/install.js` 安裝 Electron 44 runtime（套件沒有 postinstall）。CI 的 Windows job 與發布建置都包含此步驟，見 [發布自動化](releases.md)。

## 官方網站

來源：[website/](../../../website/)，獨立的 pnpm 套件（Astro 7、TypeScript 6，因為 `astro check` 尚不能使用 TypeScript 7 的原生編譯器）。它不屬於 Electron 建置，也不在根目錄 `pnpm check` 之內。版面與 CSS 結構改作自 T3 Code 官網（MIT，見 [website/THIRD_PARTY.md](../../../website/THIRD_PARTY.md)）；視覺方向（石墨中性色、白字、紅色只用於錄影點、Geist）是 RecordStuff 自己的；主題檔仍沿用早先橘色方向的名稱 `ember.css`。Geist、JetBrains Mono 與 Kalam（手繪標註）透過 Fontsource 自行託管，執行時不向第三方發出請求。正式網址為 `https://record.ericts.com`；預覽可用 `SITE_URL` 覆寫。Hosting 是維護者在 Vercel 平台自行設定的專案（根目錄 `website/`，[website/vercel.json](../../../website/vercel.json) 關閉 Git 自動部署）。

| 指令（repo 根目錄） | 用途 |
| --- | --- |
| `pnpm site:dev` | Astro 開發伺服器 `http://localhost:4173/`；因未執行驗證，頁尾會顯示「manifest not re-verified」警語。Astro 7 會讓它常駐背景：以 `pnpm --dir website exec astro dev stop` 停止 |
| `pnpm site:manifest generate vX.Y.Z` | 抓取公開 release（GitHub API、release.json、SHA256SUMS，1.1.1 之後另有 release-win32-x64.json）交叉核對後寫入 `website/release-manifest.json`；拒絕草稿、prerelease、多出或缺少的 asset，以及三個來源間任何不一致 |
| `pnpm site:manifest verify [--online\|--offline]` | 重新抓取並逐欄比對已存 manifest，並對 DMG 連結與存在時的 Windows 安裝檔連結做 HEAD 檢查；`--offline` 只做結構檢查 |
| `pnpm site:build` | 先 `manifest verify --online`，再以 `SITE_MANIFEST_VERIFIED=1` 執行 `astro build`；輸出到 `website/dist/` |
| `pnpm site:check` | 網站單元測試、`astro check`、重新執行線上驗證與建置，再檢查該次產物的連結（站內路徑、fragment id、外部 URL）；不需預先存在 `dist/` |
| `pnpm site:screenshots` | 以 puppeteer-core 驅動已安裝的 Chrome，對每頁產生桌機（1440 px）、手機（390 px）與窄螢幕（320 px）整頁截圖到 `website/compare/`（已 gitignore）；同時把首頁場景停在錄影中的那一幀重新輸出 `website/src/assets/og.png`（1200×630 社群預覽圖；場景變動時需一併提交） |

Release 資訊只從已提交的 manifest 渲染：沒有瀏覽器端 GitHub API 呼叫、沒有執行時依賴。每個下載控制項都指向已驗證的 DMG 連結，旁邊提供 Releases 頁作為可見 fallback，因此過期的 manifest 會讓建置失敗，而不是渲染錯誤的按鈕。只有 `pnpm site:build` 可以設定 `SITE_MANIFEST_VERIFIED`；`astro dev` 與 `build:offline` 一律顯示頁尾警語。首頁視覺是內嵌 SVG（`website/src/components/DesktopScene.astro`）：露營地的 Mac 桌面，選單列以十九秒 CSS 循環（開頭靜止三秒、緩慢的鏡頭推拉、停止前的指示標註、延遲約半秒才彈出的通知、最後停留）演出產品故事——游標靠近時整個桌面向選單列圖示推近、游標點擊 RecordStuff 環形圖示、環變成實心圓點並在旁邊顯示「REC」（與 App 完全一致：tray-model.ts 切換 template 圖示並設定標題；不閃爍）、鏡頭拉回、手繪風標註（Kalam 手寫字型、雙筆觸草稿箭頭、無外框）顯示「Click again to stop recording」、游標點擊後約半秒，真實格式的「Saved <時間戳>.mp4」通知才彈出（與 App 的 `SAVED_NOTIFICATION_DELAY_MS` 一致）。地景為低多邊形（`src/components/scenes/FacetLandscape.astro`），上方是共用的選單列；星空由 `src/lib/stars.ts` 以固定種子產生。不需任何圖片請求，只動 transform／opacity；捲出畫面時 hero 會暫停它，`prefers-reduced-motion` 下靜態顯示最後一幀。依維護者決定沒有可見的暫停控制，因此對未開啟 reduced-motion 的使用者而言，WCAG 2.2.2（超過五秒的動態內容需可暫停／停止／隱藏）未達成。選單列文字與檔名格式與 App 一致。

[網站部署](../../../.github/workflows/website.yml) 在 main 的 push 修改 `website/**`、共用的 release manifest 模組 `scripts/lib/release-manifest*.mts` 與它和連結檢查共用的重試（`scripts/lib/fetch-retry.mts`）、它們引用的版本語法（`src/shared/version.ts`）或 workflow 本身時自動執行，穩定版本記錄完成後也會呼叫，並支援在 main 手動重試。所有入口共用正式部署鎖，取得鎖後才 checkout 最新 main。三個儲存庫 Vercel secrets 的設定見[網站交付](releases.md#網站交付)。

CI 從 repository 根目錄執行 Vercel CLI，平台專案的 Root Directory 設為 `website/`。以 `vercel deploy --archive=tgz --prod --yes` 提交原始碼，不執行 `pull`、本機 Vercel 建置或 `--prebuilt`。Vercel 依設定執行 `pnpm test && pnpm check`：測試、Astro 診斷、manifest 線上驗證、正式建置、建置 feed 比對與 `dist/` 連結檢查。本機 `site:check` 使用相同的套件檢查。manifest 請求與外部連結檢查遇到網路錯誤、429、5xx 或 GitHub rate-limit 403 時最多試三次，依 `retry-after` 或 `x-ratelimit-reset` 等待（每次最多 10 秒），連結檢查同時最多探測四個網址，因此一次暫時性的回應不會讓部署失敗。GitHub runner 的環境變數不會自動傳入遠端建置；除非另在 Vercel 設定，manifest 驗證使用公開 GitHub 端點。

部署設定使用靜態 JSON，讓 CLI 在尚未安裝網站依賴時即可讀取，不必解析 Astro 的 TypeScript 基底設定。

專案限定 token 透過既設的 `VERCEL_ORG_ID`／`VERCEL_PROJECT_ID` 指定目標，不加顯式 `--scope`：CLI 59.23.2 否則會在部署前要求使用者／團隊查詢權限。


### 更新功能驗收

在 RecordStuff 已結束時執行 `pnpm acceptance:updates`。需要 macOS arm64、Node 24、既有本機簽章身分、Chrome、ffmpeg／ffprobe，以及 System Events 輔助使用權限。任何鍵盤輸入法都可以：隔離 fixture 使用預設 ⌘⇧1，自 plan 043 起依實體鍵位註冊。在那之前，注音（Bopomofo）會把它移到數字鍵盤，第一段錄影因此逾時。新簽章的 fixture 也可能觸發 macOS「要求略過系統私密視窗選擇器」的提示。沒有回應時，兩段錄影期間它都停在素材中央，fixture 結束後關閉。Runner 本身不會回應它；該回合的執行者可以依維護者授權的[例外](../acceptance.md#依影響追加案例)按「允許」。會在主螢幕進行兩段短錄影；擷取期間停止其他音訊並避免操作桌面。腳本不會結束既有 RecordStuff、不取代安裝版、不斷網，也不寫入真正的使用者設定。

Runner 將原始碼與建置資源複製至專用報告目錄，只修改該副本，再執行 `pnpm start:app`。沿用正式更新 action handler、AppTray context、SettingsStore、Recorder、隱藏擷取主機與 shutdown 流程。只在測試副本中替換固定 HTTP 回應與時鐘，隔離設定／log／錄影，並攔截 `shell.openExternal` 核對 URL。正常建置沒有測試命令通道；若正式程式接線改變，anchor 檢查會停止，避免測到過期的替代流程。

預設案例涵蓋檢查中／重疊、相同／新版、GitHub 備援、失敗後恢復、語言／偏好跨程序重開、已到期但關閉啟動檢查、24 小時間隔（含失敗嘗試）、錄製中延後請求、存檔後才顯示結果，以及請求中結束。`--full` 另測舊版、無效／預覽／不相容 feed 與實際逾時取消；這些邊界已有單元測試，不必每次 smoke 都重跑。報告會記錄模式與所選 feed 情境。真實擷取沿用 System Events 全域快捷鍵、Chrome 固定素材、媒體完整性檢查與閃光／嗶聲門檻。兩種模式都保留兩段各約十秒的錄影，分別測延後請求與延後顯示結果。權限／工具缺失或素材受背景聲音污染，都不算通過。

錄製狀態 snapshot 由同一份契約判定：[update-acceptance.mts](../../../scripts/lib/update-acceptance.mts) 的 `assertLockContract`。只有 recording 顯示 REC 與一個可用的 Stop；starting 與儲存中都顯示 `…`，也都不提供 Stop。Starting、錄製與儲存中會鎖定螢幕、畫質、解析度上限、影格率、快捷鍵、通知、啟動檢查與更新 action 群組，以及 tray 的變更輸出資料夾；語言、外觀與 About 連結維持可用，逐一檢查每個選項。錄製器回到 idle 或 needsPermission 後所有群組解鎖；因自身原因停用的選項（例如檢查已在進行）不屬於此契約。Tray 永遠不含更新 action。預期行為取自 `BUSY_SETTINGS_POLICY`，不是複製模型目前的旗標：設定群組不在表中，或表中群組已不再提供，都會失敗，直到明確分類。真實執行對錄製中 snapshot 及其前後的 idle snapshot 套用此契約；starting、儲存中與權限狀態由單元測試以真正的 `settingsView`／`trayModel` snapshot 涵蓋，因為 runner 無法停在這些短暫狀態。

`--logic-only` 明確略過真實擷取。`--require-native-ui` 把原生 UI 未驗證列為必要缺口（exit 2）；預設將它列在必要範圍之外。Handler／model 斷言**不代表**點過原生 Tray、確認瀏覽器畫面、聆聽播放、首次授權或公開版升級。現有 computer-use 無視窗 Tray 限制仍保留；不把呼叫 action handler 宣稱為滑鼠點擊。

報告位於 `docs/verification/measurements/<timestamp>-updates-*/`；`--out <新目錄>` 可指定路徑，既有目錄會被拒絕。`report.json`／`report.md` 列出每個必要案例，包含先前失敗後未執行的項目；保留請求／回應、事件、建置／簽章輸出、來源／產物雜湊與錄影驗證。Exit 0 表示所述範圍全部必要案例通過、1 表示失敗、2 表示受阻／不完整。SIGINT／SIGTERM 會要求收尾：測試 App 透過正式 shutdown 停止並保存錄影，只關閉專用素材瀏覽器 profile；無法安全退出的測試程序保留並回報清理失敗，不使用全域 kill。App 退出後才移除來源工作目錄，錄影與證據保留。

此隔離 fixture 也攔截存檔通知並記錄事件，避免第一段的通知遮擋第二段測試素材；通知顯示不在這項驗收範圍。影音分析會判定影格時序與閃光／提示音偏移，至少須有 5 組配對標記；短片不判定長時間同步漂移。聲道能量與標記是必要證據，所以 blocked 或 incomplete 的檢查與 fail 一樣會讓案例失敗。已存在的 `--out` 目錄會保留原內容，以明確訊息及退出碼 2 拒絕，不寫入報告。

## 腳本化原生驗收

依維護者 2026-10-02 的決定（[驗收案例](../acceptance.md#依影響追加案例)），已提交的 runner 可以操作 RecordStuff 自己的 Tray 選單、設定視窗與選單項目，因此這些原生案例不必再等人或 Computer Use；後者無法存取純 tray 的程序。何時用 runner、何時用觀察，依[選擇規則](../testing.md#腳本-runner-或-computer-use)；這些證據一律是腳本輸入，永遠不算視覺判斷。

[native-ax.mts](../../../scripts/lib/native-ax.mts) 是一個 JavaScript for Automation helper，透過 ObjC bridge 呼叫輔助使用 C API 並送出 CoreGraphics 事件。它讀一次選單約 0.1 秒；同樣的讀取透過 System Events 要 29 秒。每次讀取都以 pid 指定目標。AXError -25211（終端機沒有輔助使用權限）記為 **blocked**；runner 從不修改隱私權清單。

[tray-driver.mts](../../../scripts/lib/tray-driver.mts) 從 App 的 `AXExtrasMenuBar` 找到狀態列項目，以 CoreGraphics 右鍵開啟選單；項目唯一的動作 `AXPress` 等於左鍵，會開始錄影。macOS 26 的狀態列項目畫在「控制中心」的視窗裡，每個螢幕一份。即使前景 App 的選單把那一份擠出較窄的選單列，AX 仍只回報那一份的 frame：2026-10-02 在 1080 pt 寬的直式螢幕上，`REC` 項目從選單列消失，AX 仍回報它在那裡，點擊沒有落在任何東西上。因此 driver 只在該位置有在畫面上的控制中心視窗時才點 AX 回報的 frame，否則改點主選單列上以 bundle identifier（`com.ericts.record`）命名、且在畫面上的視窗；兩者都沒有就判為失敗。右鍵若 3 秒內沒有打開任何東西，會在確認沒有選單開著之後重點，最多三次；因為錄影中曾有一次點擊落空，而之後的點擊都能打開選單。報告列出每次點擊與點擊位置的找法。選單項目以對項目的 `AXPress` 或方向鍵加 Return 選取，以 Escape 關閉。分隔線是沒有標題的停用項目；快捷鍵是 `AXMenuItemCmdChar` 加修飾鍵位元（1 Shift、2 Option、4 Control、8 不含 Command）。每個 UI 狀態上限 30 秒，每次等待都會回應取消。

點擊會移動真正的游標。改把事件直接送給程序（以 `CGEventPostToPid` 送給 RecordStuff 或控制中心，帶不帶視窗編號、先不先送移動事件）時游標不動，但在 macOS 26.6.2 上選單一次都沒有打開（2026-10-02）：控制中心依游標位置判定點擊。因此每一輪都需要桌面交接；期間若有人操作，仍可能關掉選單或改變選取，目前沒有偵測。

### Tray 驗收

```bash
pnpm acceptance:tray                      # 先儲存的語言，再另一種
pnpm acceptance:tray -- --languages zh-TW # 單一語言；另有 --seconds、--bundle、--log、--settings
pnpm acceptance:tray -- --long-start <run> # 對執行中的受控 build 跑 plan 065 的長時間 start 案例
```

在 `pnpm start:app` 或 `pnpm open:app` 之後、App 待命時執行；它只判讀執行中 pid 自己的 log session，最多等 30 秒。Tray 每次彈出選單都會記錄 `tray: menu opened in <state>: <json>`，也就是交給 Electron 的選單。runner 在 idle、倒數與錄影三種狀態，把原生選單逐項和這一行比對，涵蓋 Electron 到 NSMenu 的邊界，並檢查案例規則：開頭、結尾沒有分隔線，也沒有相鄰的分隔線；「開始錄製」只在 idle，「停止」只在錄影中，「取消錄影」只在倒數（或在下方的長時間 start 模式中，於 starting 期間）；錄影中儲存位置項目為灰色；最後是「顯示 log」與「結束 RecordStuff」。它也從選單開始、停止，用通知 runner 的 Finder 置前與選取判定檢查「顯示上一段錄影」，以第二次點擊與「取消錄影」取消倒數（回到 idle、保留「顯示上一段錄影」、沒有新檔案、失敗紀錄或通知），在倒數中結束，並以方向鍵加 Return 開啟「設定…」。第二種語言是在 App 結束時寫進 settings.json 再重新啟動；App 結束後再寫回原值。它保存每個選單的截圖，保留自己錄下的目前畫面短片（沒有測試素材，所以不做媒體檢查），最後選「結束 RecordStuff」。

`--long-start <run>`（plan 065）改以 `pnpm acceptance:controlled -- launch` 為 `<run>` 啟動的 App 為對象，該 run 的 bundle、log、設定與輸出資料夾成為預設值；遇到其他 bundle，或 pid 與該 run 的 `ready.json` 回報不同時會拒絕執行。它透過 run 的命令通道啟用 `prepare=hold`，讓每次 start 都停在 starting、capture host 的 `prepared` 回覆被暫停，然後：在同一個 System Events 腳本中相隔 0.2 秒按兩次錄影快捷鍵，預期第二次在寬限時間內被記為忽略，1.3 秒後的第三次則記錄 `cancelled (toggle) while preparing capture`；左鍵點擊狀態列項目，把 starting 選單和它的 `tray: menu opened in starting` 那一行比對（「取消錄影」必須標出快捷鍵），1.3 秒後再左鍵點擊以取消；最後在 start 被暫停時選「結束 RecordStuff」，必須記錄 `cancelled (quit) while preparing capture` 並在 10 秒內結束。每次取消後放行暫停的回覆，Recorder 必須把它當作過期 session 停止，並檢查輸出資料夾沒有新項目、沒有要求通知，失敗歷史也沒有增加。它不錄影，只使用該 run 儲存的語言；它是 runner 的一個模式而不是另一支 runner，因為它需要的正是這支 runner 的狀態列 driver、選單比對、收尾與報告。收尾會先用「取消錄影」取消仍被暫停的 start，避免放行的回覆送出 `record`（倒數設為「關」時會因此開始錄影），再關閉 `prepare`、放行暫停的回覆，最後才結束其他狀態。它的證據屬於受控狀態證據：暫停發生在 main，而不是真實的擷取請求。

結束碼為 0 通過、1 失敗（任一案例失敗或收尾不完整）、2 受阻（鎖定或沒有輔助使用權限），中斷且收尾沒有留下任何東西時為 130／143；無法到達該狀態的案例是 **not run**，絕不算通過。收尾只作用於 preflight 已接受的 App：在那之前就被拒絕的回合（鎖定、另一個 bundle、沒有輔助使用權限）不碰任何東西。它會關閉選單，用狀態列項目結束倒數或錄影（無法點擊時改用已註冊的錄影快捷鍵），只在設定視窗有焦點時關閉本輪的設定，關閉「顯示上一段錄影」開啟的 Finder 視窗（即使該操作被中斷，也會依資料夾找到），結束 App，之後再還原語言，不依賴已中止的 signal。只有 RecordStuff 在前景且設定有焦點時才送 ⌘W。2026-10-02 分別在 zh-TW 與 en 的錄影中中斷，runner 都存好錄影、結束 App、語言維持繁體中文，結束碼 130。

留在 runner 外的項目與理由：needsPermission 選單需要撤銷螢幕錄影權限，那是 runner 不得做的 TCC 修改（由單元測試與 035 的維護者回合涵蓋）；在狀態改變後才選的「開始錄製」，runner 會在 idle 選單開啟時把錄影快捷鍵排進佇列，但每次 macOS 都先處理選單的「開始錄製」，所以回報 not run（`Recorder.startIfIdle` 有單元測試，035 也觀察過 `ignored` 那一行）。只有 App 的歷史中有未讀失敗時才觀察得到未讀失敗群組；或使用以 `v1` 植入資料的[受控 build](#受控驗收-build)，並把 `--bundle`、`--log` 與 `--settings` 指向它的執行目錄。淺色與深色選單列、對齊與可讀性，由 Computer Use 觀察或維護者根據截圖判斷。

## 設定快捷鍵驗收

在 `pnpm start:app` 之後使用 System Events 流程：

```bash
pnpm acceptance:settings-shortcut                # 只檢查 callback
pnpm acceptance:settings-shortcut -- --observe   # 另外以輔助使用檢查視窗
pnpm acceptance:settings-shortcut -- --observe --quit   # 最後按 ⌘Q，並確認產物的所有程序都結束
```

設定關閉、另一個 App 在前景時，這個 macOS arm64 腳本會核對本機 bundle 程序、最新 log session 與目前設定鍵註冊，再透過 System Events 送出 ⌘⌥,。擷取暫停、衝突或註冊失敗時拒絕送鍵。成功退出只代表收到本次設定 callback（最多等 30 秒），不代表視窗可見或聚焦。每次報告與 log 都寫入 `docs/verification/measurements/` 下的獨立目錄。

`--observe`（plan 063）在設定已開啟時拒絕執行；它先讓 Finder 置前、送出按鍵，再透過輔助使用斷言：設定視窗是 main 且有焦點、RecordStuff 在前景；Tab 會移動焦點所在的控制項（先設定 `AXManualAccessibility`，這是輔助軟體使用的開關，讓 Chromium 公開網頁焦點）；應用程式選單沒有綁定 ⌘R（重新載入）或 ⌘⌥I（開發者工具），並保留 ⌘C、⌘A、⌘M 與 ⌘Q（設定沒有可貼上的欄位，因此不要求 ⌘V），依選單的快捷鍵判斷，因為開發者工具可能停靠在視窗內而不新增視窗；⌘R 與 ⌘⌥I 送出後 2 秒內焦點不變，重新載入會重設焦點；⌘A 再 ⌘C 會把面板文字（含兩個分頁名稱）放進剪貼簿（複製錯誤細節是面板唯一的文字用途；先完整保存使用者剪貼簿的每個項目與類型，無論本輪如何結束都會還原；剪貼簿含有目前讀不到的資料（例如 Finder 檔案 promise）時不動它，此項記為 BLOCKED；還原失敗時保留暫存檔並使本輪失敗）；⌘M 會最小化；第二次送鍵會把它還原到前景；⌘W 會關閉；第三次送鍵會重新開啟。callback 與輔助使用檢查分開列為腳本證據，面板保持開啟；加 `--quit` 時改以在設定中按 ⌘Q 結束本輪，並斷言產物的所有程序在 30 秒內結束；在 ⌘Q 之前失敗或被中斷的回合不會盲目送出 ⌘Q，而是回報 `Cleanup incomplete` 與仍在執行的 pid。排版與外觀仍由 `pnpm acceptance:settings` 的截圖或觀察判斷。權限拒絕只回報，不自動修改；沒有使用 IPC 或測試專用開窗入口。OS 衝突與錄製持續需各自驗證。

`pnpm acceptance:shortcut` 另執行第三個隔離的設定階段，使用正式 main／preload／頁面，透過受控註冊 adapter 驗證既存平台等價衝突、恢復、雙語拒絕、擷取暫停與 renderer 崩潰清理。測試會最小化真正的 Electron 視窗，再經註冊 callback 還原，斷言視窗數量與焦點。這屬於整合證據，與原生 Computer Use、真正 OS 衝突測試分開記錄；三個程序及暫存偏好皆會清理。

## 鍵盤配置快捷鍵檢查

```bash
pnpm acceptance:shortcut-layout
```

Plan 043 停用 Chromium 的 `LayoutAwareGlobalHotkeys`，讓全域快捷鍵依實體鍵位註冊（[錄影快捷鍵](desktop.md#錄影快捷鍵)）。若升級 Electron 時這個功能被改名或移除，註冊會在無提示下回到依配置查找，注音下的數字快捷鍵就會移到數字鍵盤。這項檢查不需手動切換輸入法就能抓到這種回歸。執行前關閉 RecordStuff，並在 macOS 上執行。終端機需要 System Events 的輔助使用權限，且至少已啟用一個數字列不輸入數字的鍵盤輸入法，例如注音。與 `acceptance:shortcut` 相同，指令會先建置；直接執行 runner 而 `out/` 不存在時，會以 blocked 停止。它不錄影、不需要擷取權限，含建置約需 10 秒。

- **其他 RecordStuff 程序。** 有程序在執行時，runner 以 blocked 拒絕執行：包括正式 App，以及用這個 checkout 啟動的 Electron 開發或 fixture 程序。它們會佔用相同的快捷鍵。
- **選擇輸入法。** runner 讀取目前的輸入法與鍵盤配置，接著依序嘗試已啟用、可選取的鍵盤輸入法，目前的輸入法排第一。它停在第一個「數字列不輸入任何數字、數字鍵盤 7 仍輸入 7」的配置：依配置查找的數字快捷鍵，正是在這種配置下被移到數字鍵盤。`-- --source <id>` 只嘗試指定的輸入法；未啟用時，在任何變更之前就回報 blocked。runner 從不新增或啟用輸入法，也不改鍵盤設定。
- **啟用輸入法。** 輸入法只有在文字欄位啟用它時，才會套用自己的配置。從背景程序選取時，它會沿用先前的配置，檢查也會在 bug 存在時照樣通過。因此對輸入法，runner 會開一個自己的小視窗並聚焦其中的文字欄位，最多等 8 秒讓配置回報變更，再關閉視窗。這會短暫搶走焦點。配置未在時限內改變時回報 blocked。
- **受測 App。** Electron fixture 依 [shortcut-failure](../../../scripts/fixtures/shortcut-failure.ts) 的 boundary 模式載入建置好的 `out/main/index.js`：userData 與 log 都是隔離的，儲存的錄影快捷鍵為 `CommandOrControl+Control+Alt+Shift+7`。註冊會到達真正的 `globalShortcut`，但按鍵只被記錄，不會呼叫正式的 toggle，所以不會錄影，也不會出現權限提示。
- **按鍵。** System Events 送出三個 key code。設定快捷鍵 ⌘⌥,（key code 43）是送達對照組，必須觸發。數字列 7（key code 26）必須觸發。數字鍵盤 7（key code 89）在 1.5 秒內不得觸發。沒有被任何程式註冊的組合鍵會送到最前面的 App。
- **還原。** 不論成功、失敗、逾時、SIGINT 或 SIGTERM，都會還原原本的輸入法並確認；無法確認的還原算清理失敗。選取輸入法等同從輸入法選單選擇，因此 macOS 的最近使用清單可能改變。輸入法會保留它套用的配置直到下次使用；這屬於輸入法本身的狀態，不會還原。

`-- --drill-layout-aware` 是預設流程之外的負向對照。fixture 會在 app ready 之前移除正式程式設定的 `disable-features`，讓 Chromium 依配置查找的功能恢復成 plan 043 之前的狀態。這時數字列的按鍵必須失敗、數字鍵盤會觸發；這次執行以 exit 1 結束，並照樣還原輸入法。報告會註明 drill 是否偵測到依配置查找。

報告寫入 `docs/verification/measurements/<timestamp>-shortcut-layout/`，drill 則加上 `-drill` 後綴。`report.md` 與 `report.json` 列出原本、嘗試過、檢查時使用與還原後的輸入法，以及各自的配置與數字列字元；也列出快捷鍵與註冊結果、每個按鍵的結果與清理情形。`electron.log` 與 `check/app.log` 保留程序輸出。

Exit code：

- 0：通過。
- 1：失敗，包括被中斷的執行與任何清理失敗。
- 2：blocked。原因包括：不是 macOS、缺少 `out/`、有其他 RecordStuff 程序、螢幕已鎖定、沒有 System Events 權限、沒有符合條件的已啟用輸入法、註冊被拒，或檢查期間輸入法被改變。

合成的 key code 無法證明實體按鍵；043 由維護者回報的實體按鍵仍是硬體證據。

## 驗收收尾

完整 App 驗收每輪無論成功、失敗或中斷，都須保存測試錄影、還原設定、清理測試視窗、退出受測 App 並確認程序已消失。清理失敗算驗收失敗；保留證據，不重設權限。開發期間已授權按需停止錄影、退出、重啟或重建 RecordStuff，不需另行確認。退出只重設程序狀態，不會清除偏好。

桌面 runner（`acceptance`、`acceptance:settings`、`acceptance:shortcut` 與執行它們的 regression、`acceptance:shortcut-layout`、`acceptance:settings-shortcut`、`acceptance:tray`、`acceptance:quit-dialog`、`acceptance:notification`、含擷取的 `acceptance:updates`、`acceptance:playback`、`matrix`、`measure:cpu` 及 `audio:quality -- record`）共用 [desktop-session.mts](../../../scripts/lib/desktop-session.mts)：`caffeinate -u` 喚醒閒置關閉的螢幕；以 `ioreg` 的 `CGSSessionScreenIsLocked` 在啟動任何東西或送出按鍵前拒絕鎖定中的 session；`caffeinate -d -i -w <runner pid>` 讓螢幕保持開啟到 runner 結束；回合中（每 2 秒及結束時）偵測到鎖定，結果改為 BLOCKED、exit code 2，並在報告寫入 `Desktop:` 一行。隔離的 lifecycle fixture 不需要螢幕，不持有 assertion。

設定驗收另外把被其他 App 取消啟用的視窗視為 blocked（plan 057）。視窗未啟用時頁面不畫 focus line，而在 macOS 上 `BrowserWindow.focus()` 無法從其他 App 取回啟用狀態；因此在每個需要啟用視窗的案例前（focus line 與 focus border 矩陣、會因 blur 取消的快捷鍵錄製、頁面只在文件有焦點時才於失敗紀錄操作或失敗連結的 Retry 後歸還的焦點，以及它們一起拍的截圖），fixture 會讀取 `BrowserWindow.isFocused()`、`isVisible()` 與頁面的 `data-window`，視窗未啟用時照 `SettingsWindow` 的方式要求啟用（先 `app.focus({ steal: true })`，再 `window.focus()`），並在判定案例時再讀一次。每段互動各自檢查，一段互動中的 blur 不會決定下一段；任一時點視窗未啟用或中間發生 blur 的案例，會在 console、`report.md` 與 `results.json` 標為 `NOT RUN`，附上原因與 `lsappinfo` 讀到的最前面 App；在啟用視窗上執行的案例保留原本的通過或失敗。`capturePage()` 丟出錯誤時，fixture 仍會寫出目前已記錄的案例，並另寫 `failure.json`，記下失敗的截圖與當下視窗狀態。若 fixture 已顯示過視窗，而讓這一輪停下的只有 not-run 案例或在未啟用／隱藏視窗上的截圖失敗，則以 exit 2（blocked）結束；只要有已判定的失敗、其他原因的中止，或 fixture exit code、程序收尾與結果不一致，就以 exit 1 結束。分類邏輯位於 [settings-activation.mts](../../../scripts/lib/settings-activation.mts) 及其單元測試。

各 runner 共用程序比對與啟動環境（plan 052）。[processes.mts](../../../scripts/lib/processes.mts) 產生所有 `pgrep`/`pkill` pattern：RecordStuff bundle 用 `recordStuffPattern`，checkout 的開發用 Electron.app 用 `electronPattern`，兩者都會跳脫路徑並加上錨點，因此位於 `~/Code (2026)/` 之下的 checkout 只會比對到自己，不會比對到相鄰路徑或在參數中提到它的程序；`pgrepPids` 在無法啟動 `pgrep`，或 status 不是 0 與 1（1 表示沒有）時丟出錯誤。程序群組探測只把 `ESRCH` 視為已不存在；`EPERM` 表示群組仍存在，送出訊號失敗會回報收尾錯誤。因此 `pgrep` 失敗會擋下這一輪，而不是被當成「沒有東西在執行」：preflight 階段會在啟動任何東西前停止；收尾階段則以 exit 1 結束（中斷後會印出 `CLEANUP FAILED`），因為此時無法證明本回合的程序已經結束。所有會啟動 Electron 或 App 的 runner 都從 [runner-env.mts](../../../scripts/lib/runner-env.mts) 的 `scrubbedEnv()` 開始，它會移除 `ELECTRON_RUN_AS_NODE`、`ELECTRON_RENDERER_URL`、`RECORDSTUFF_AUTORECORD` 與 `NODE_OPTIONS`（VS Code 的 JavaScript Debug Terminal 會設定最後這個），runner 只再加上自己負責的值，例如 autorecord 要求、fault point 或 `PATH`；若有 runner 自行刪除這些 key 或複製 `process.env`，單元測試會失敗。`matrix`、`measure:finalization` 與 `diagnose:cadence` 以非同步方式在建置自己的程序群組中建置，因此建置期間的 Ctrl-C 或 SIGTERM 只會送到 runner，由它的處理程序停止整個群組，收尾後 exit 130 或 143。`matrix`、`measure:finalization` 與 `diagnose:cadence` 和 `acceptance`、`measure:cpu`、`acceptance:updates` 一樣，以本回合用 `mkdtemp` 建立的私有 Chrome profile 開啟素材；收尾會等該瀏覽器結束後刪除 profile，無法刪除時列為收尾未完成。

`pnpm acceptance` 會讓受測 App 保持關閉，並在 `report.md` 記錄包含收尾的最終結果；若程序已更換或無法確認待命，拒絕退出。通知驗收還原安裝產物與設定後保持 App 關閉。設定驗收管理自己的程序群組，包含中斷與逾時清理，結果寫入 `cleanup.json`。隔離 runner 只清理自己的程序；單元檢查不關閉無關 App。設定快捷鍵入口仍保留面板供原生檢查，除非以 `--quit` 按 ⌘Q 結束；否則由完整回合負責退出。Tray 驗收和 `pnpm acceptance` 一樣讓 App 保持關閉。下一輪錄影驗收前需重新啟動；程式改動後用 `pnpm start:app` 重建。

快捷鍵 runner 在送出開始按鍵前及失敗時寫入 `input-diagnostics.json`：包含實際 AppleScript、App PID、送鍵程序、System Events UI 狀態、前景 App，以及 IORegistry 回報的 Secure Input 擁有者。沒有回報擁有者不代表已證明 Secure Input 關閉。診斷查詢唯讀、有時限，不會授予權限。失敗時也保留 `events.log` 與本次 `app-session.log`。osascript 成功不等於按鍵送達，必須收到 App callback 才算；逾時後不要盲目重送切換快捷鍵，以免停止延遲開始的錄影。送鍵失敗時，先對同一個 bundle 與輸入環境比較實體按鍵和產生的腳本，再判斷是否為 App 故障。


### 可重複的設定回歸

```bash
pnpm acceptance:regression
```

先執行 TypeScript、Vitest 與 build，再依序執行設定 fixture 和快捷鍵整合，避免重複建置。Console 會列出各自的 `docs/verification/measurements/` 報告；非零退出碼代表失敗，`&&` 確保失敗後不繼續下一階段。隔離整合另外連跑兩輪「設定快捷鍵 callback → 真正 Electron 按鍵 ⌘W（其他平台 Ctrl+W）→ Tray 設定 handler 重開」，斷言只有一個視窗、可見且聚焦、App 與註冊仍存在、偏好沒有改寫且未開始錄影或產生影片。

這是正式 main／preload／renderer 的整合回歸；快捷鍵註冊及 Tray 邊界受控，不能聲稱測過 OS 全域送鍵或實際 Tray 點擊。原生入口改用 `pnpm acceptance:settings-shortcut -- --observe`，實際 Tray 點擊用 `pnpm acceptance:tray`；真實錄影仍用 `pnpm start:app` 與 `pnpm acceptance`，後者會正常結束測試 App。實體拔插螢幕、VoiceOver 聽感及使用者理解仍需人工。已通過的案例若程式、環境或測試條件沒有相關變更，不要求使用者反覆重測。

### 驗證配方與計時

```bash
pnpm acceptance:recipe -- --list
pnpm acceptance:recipe -- shortcut-registration
```

配方是某一類修改所需組合檢查的 leaf 指令（[測試規則](../testing.md#選定一次並對每個版本驗證一次)），依序執行，相同輸入只建置一次。`check` 即 `pnpm check`；`settings` 即 `pnpm acceptance:regression`；`shortcut-registration` 再加上鍵盤配置 runner，但不跑 `pnpm acceptance:shortcut-layout` 開頭那次額外的 `pnpm build`；`recording` 執行 typecheck、測試、`pnpm start:app`（其中的 `electron-vite build` 就是 check 的建置）與 `pnpm acceptance`。`pnpm acceptance` 可以緊接在 `start:app` 之後執行，因為它最多等 30 秒，直到 log 最新的 session 依 run id 確認屬於執行中的 pid 且已 idle；plan 061 之前它可能拿前一個 App 的 session 來判斷。播放仍是對已存錄影另外執行 `pnpm acceptance:playback -- <file>`。`-- --dry-run` 只印出配方的指令而不執行。單元測試確保每個配方的 runner 與它取代的 package scripts 相同。

每個階段在自己的程序群組執行並連接主控台；未通過時就停止配方，與 `&&` 相同，之後的階段記為未執行。桌面 runner 的 exit code 2 代表 blocked；typecheck、測試或建置的 2 則是失敗。SIGINT 或 SIGTERM 會對執行中的階段送 SIGTERM，最多等 60 秒讓它自行收尾，之後才結束整個群組，因此 runner 仍會結束 App 並還原它改過的設定；配方接著以 130 或 143 結束；收尾不完整時以 1 結束。超過一小時的階段會被停止並判為失敗；程序群組在階段結束後仍存在，或必須用 SIGKILL 才清得掉時，即使 exit 0 也判為失敗。`recording` 負責 `pnpm start:app` 開啟的 bundle：如果在 `pnpm acceptance` 退出 App 之前就結束（失敗、runner blocked 或中斷），它會要求該 bundle 正常退出（錄影中會先存檔），最多等 30 秒讓該 bundle 的所有程序（含 helper）結束；它不會強制結束 App，無法確認程序已結束時整輪判為失敗。配方開始前就已在執行的 App 不歸它退出。除此之外，配方本身不做任何桌面操作，各 runner 的交接、鎖定與收尾規則維持不變。

報告寫在 `docs/verification/measurements/<timestamp>-recipe-<name>/`（`--out <new directory>` 可指定新目錄，已存在的目錄會被拒絕）。`report.json` 與 `report.md` 記錄 wall time、各階段以 monotonic clock 量得的起始偏移與耗時、結果、exit code 與清理狀態，以及階段之外的時間（identity 雜湊與 App 清理；寫報告的時間不計）。知道自身邊界的子程序會把邊界附加到 `RECORDSTUFF_TIMING_FILE` 指定的檔案；`pnpm start:app` 以此回報 preflight（程序檢查與簽章身分）、build、package、verify，以及 open 或 DMG，這些時間顯示在所屬階段內，不會重複計入總計。報告也記錄 revision、包含未追蹤檔的未提交變更摘要、runtime 輸入摘要、執行前後的 `out/` 與 `app.asar` 摘要，以及 Node、pnpm、Electron 與 OS 版本。執行期間原始碼、測試或設定有變時，原本會通過的一輪判為 **invalid** 並以 1 結束，因為它的證據不屬於任何單一 revision。Agent 協作空檔與桌面交接等待發生在程序之外，報告記為 unknown，不記為 0。

**沿用 bundle。** 建置與簽章驗證成功後，`pnpm start:app` 在 bundle 旁寫入 `dist/mac-arm64/RecordStuff.app.inputs.json`，位置在簽章與 DMG 之外。檔案內含每項 runtime 輸入的摘要——不含 `*.test.ts` 的 `src/`、`build/`、不含 Markdown 的 `resources/`、`package.json`、lockfile、electron-builder／electron-vite 與 App 的 TypeScript 設定，以及已安裝的 Electron、electron-builder、electron-vite 與 Vite 版本——和 `app.asar` 的摘要。Symlink 會被追蹤，所以摘要涵蓋它指向的內容。原始碼會從 `scripts/` import 的驗收 workspace 副本（`acceptance:updates` 與 `acceptance:controlled` 的插樁方式）也會納入 `scripts/`。輸入在建置前讀取；驗證結束時若已改變，就不寫入紀錄。重新建置會先刪除舊紀錄，因此建置失敗時不會留下紀錄。`pnpm open:app` 會在驗證簽章前拒絕沒有紀錄、紀錄無法讀取、`app.asar` 已變或輸入已變的 bundle，並列出最多五個變更的檔案；請用 `pnpm start:app` 重新建置。因此只改測試、腳本、文件、計畫或網站時，已驗證的 bundle 仍可沿用；任何原始碼或設定變更都會要求重新建置。

## 錄製生命週期驗收

`pnpm acceptance:lifecycle` 建置隔離 Electron fixture，使用 production Recorder、FileWriter 與 `installQuitCoordinator`。它延遲真正的最終發布（硬連結；檔案系統拒絕連結時為複製）、handle close 或 partial 結果的 stat／發布，重複要求退出，確認程序跨過兩次期限仍存活，再釋放工作並檢查正式／保留檔的精確 bytes 與正常退出。100 ms 期限用來加速相同退出判定流程，不量測原生擷取或 UI 對話框。第四個 `history` 案例在可控制的儲存邊界上執行 production RecordingResults 與未保存提醒退出流程：歷史寫入卡住時取樣主程序事件迴圈延遲與隱藏 renderer 往返，合併重複退出，寫入進行中保持 App 開啟，選擇「留在 App」後恢復錄影，最終發布被延遲時暫不顯示 metadata 提示，完成後才選擇明確的「只放棄提醒」退出並檢查媒體精確 bytes。提示回答由腳本提供，不顯示原生對話框。不修改使用者偏好、不替換已安裝 App，也不載入一般 main 入口。結果與程序清理證據位於 `docs/verification/measurements/<timestamp>-lifecycle/`。依測試政策另行執行新 bundle 擷取／播放與原生退出案例。

### 引導式延期退出通知驗收

執行 `pnpm acceptance:quit-dialog -- --language zh-TW`，再以 `--language en` 重做。它從下述簽章副本啟動獨立 Electron 測試程序，使用隔離 userData 與合成 bytes；不錄影、不改正式偏好、不塞滿磁碟，也不替換已安裝 App。共用正式 `createQuitFeedback`、Recorder、FileWriter 與退出協調器；fixture 不建立 tray，改以一般 Electron `Notification` 代替 tray 的通知。受控的發佈延遲與縮短為 100 ms 的退出期限，會在啟動約三秒後讓退出延後，並出現延後退出通知（plan 055；指令沿用它取代的對話框名稱）。觀察橫幅與完整文字；不需要回應。fixture 會在請求時記下 `Notification.isSupported()`，以區分被拒的橫幅與不支援通知的系統。接下來 8 秒以 1 秒 timer 量測 main 延遲多少，任一 tick 晚 500 ms 以上即失敗；之後 fixture 確認發佈仍在等待，再解除延遲、驗證精確 bytes 並重新正常退出。產生的 `.mp4` 只有合成 bytes，不是可播放的錄影。

fixture 只從完整簽章的 Electron.app 啟動（plan 062）：macOS 拒絕 `node_modules` 中只有 linker／ad-hoc 簽章的 Electron 發出通知（`UNErrorDomain` error 1）；2026-10-01 的 A/B/A 比對中，同一份副本加上完整的 RecordStuff Dev 簽章後，兩種語言的通知都送達。每一輪都在獨立受監督的程序群組中，以 60 秒上限執行 `node scripts/start-app.mjs --fixture-app <temporary>/Electron.app <report>/signature.json`：以 `ditto` 把本 checkout 的 Electron.app 複製到唯一的暫存目錄，用 `pnpm start:app` 選取的 identity（RecordStuff Dev 或 `RECORDSTUFF_SIGN_IDENTITY`，同樣檢查有效期、自簽與重複）以 `codesign --force --deep --timestamp=none` 簽署副本，再以同一個 `verifyBundle` 驗證：`codesign --verify --deep --strict`、外層 App 與每個巢狀 app／framework 都是選定憑證、沒有 ad-hoc 簽章、identifier 為 `com.github.Electron`，以及 designated requirement `identifier "com.github.Electron" and certificate leaf = H"<sha1>"`。副本保留比對時使用其通知權限的 Electron identifier，沒有 hardened runtime 或 entitlement。identity 缺少、重複、過期或無法存取、keychain 需要有人操作（`errSecInternalComponent` 等），或查詢 keychain 時逾時，都是 **blocked**（exit 2）；其他簽章或驗證失敗，以及中斷，都是 **fail**（exit 1）。兩者都不啟動 fixture。不會修改 `node_modules`、`dist/`、已安裝 App、偏好、憑證或信任設定。setup 的 `TMPDIR` 也在同一個暫存目錄內，所以驗證被中止時不會在別處留下憑證 scratch。副本在其程序群組都結束後移除；無法確認時保留副本，清理記為失敗。被中止程序寫壞的證據視同缺少；runner 本身出錯時，仍在相同條件下移除副本，並寫出失敗的 `report.json`。

報告分開記錄六層：簽章 fixture App（含來源資訊：commit、dirty 狀態與 `workingTreeIdentity` 內容、Electron 版本、lockfile 與 fixture hash、bundle 路徑與 identifier、憑證名稱、SHA-1 與到期日、designated requirement 及 setup 各階段時間）、生命週期（一次延後與一則通知、timer、精確 bytes、正常結束）、通知送達事件、透過輔助使用讀到的橫幅文字、視覺橫幅與清理。fixture 在事件發生時就把 `requested`、`shown` 與 `failed` 附加到 `notification.jsonl`，所以生命週期之後失敗也能判讀送達。只有在請求後 8 秒內收到 `shown` 事件才算送達通過；明確的授權拒絕（`UNErrorDomain` error 1、“not allowed”）是 blocked，其他錯誤或時窗內沒有事件都是失敗，失敗優先於 shown。fixture 執行期間，runner 每 300 ms 讀一次通知中心的輔助使用樹（plan 063）：橫幅群組（`AXNotificationCenterBanner`）帶有 `title` 與 `body` 文字，即使橫幅畫面上截斷，body 仍是完整文字。只計算啟動前沒有列出的 RecordStuff 橫幅；必須恰好出現一則，且 body 要等於本輪語言的正式延後訊息（`DEFERRAL_MESSAGE.media`，單元測試把它的文字綁定到 runner），另一種語言的文字判為語言錯誤。沒有 shown 通知時此層 not run，沒有輔助使用權限時為 blocked。2026-10-02 兩種語言都通過，其中一輪期間的截圖也顯示同一則完整、未截斷的橫幅。runner 從不判讀視覺層：它固定為 **not run**，理由是須由觀察者另行記錄橫幅是否可見、可讀、未截斷。任一層失敗，整輪即失敗（exit 1），並優先於 blocked 結果（包括鎖定）；否則任一層 blocked、無法執行或期間鎖定，整輪為 blocked（exit 2）。exit 0 是簽章 App、生命週期、送達事件、橫幅文字與清理的自動化證據；完整原生驗收仍需要視覺觀察。

`--help` 不啟動程序；錯誤參數在啟動前失敗。Ctrl+C 只取消隔離程序群組，簽章期間與啟動後都一樣；重複取消訊號不會跳過外層清理。此 runner 取消／逾時時立即 SIGKILL 自己建立的可丟棄合成程序群組；其他 runner 保留預設的 SIGTERM 正常收尾。外層 40 秒期限限制無人操作的執行；中斷、逾時或強制清理都算失敗，不算通過。此 macOS／Electron 上，即使加入 JavaScript 訊號 handler，SIGTERM 取消仍未阻止正式退出提示在強制清理前出現。合成 fixture 專用的 SIGKILL 避免這種誤導，固定記為強制清理與失敗；不作用於正式 RecordStuff。Log（`setup.log`、`electron.log`）、`signature.json`、`notification.jsonl` 與 `report.json`／`report.md` 保留在 `docs/verification/measurements/<timestamp>-quit-dialog-<language>/`。報告刻意將原生觀察留為 **not recorded**，需另記觀察者、橫幅／文字結果與截圖。`shown` 事件不代表橫幅確實可見。這是來自簽章 Electron 副本、帶 Electron 圖示的開發 fixture 證據，不是 RecordStuff bundle 身分或真實錄影證據。

由 agent 自動做視覺驗收時，依[原生驗收技能](../../../.agents/skills/native-acceptance/SKILL.md)：agent 擷取真正提示，以截圖搭配 accessibility 狀態自行判讀、關閉提示，再核對生命週期與清理證據。工具支援時保存 PNG，否則明確引用工具圖像。此自動化需要具桌面能力的 agent；單獨指令不會呼叫模型。自動置前需要被動的前後桌面證據，先選取目標或只看 App 裁切圖不能證明；維護者確認仍標為人工證據。

**報告提醒：** 測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。保留既有流程，不增加每輪核准或鍵鼠監控。若已知受干擾，受影響的原生觀察標為 blocked／無法判定，保留原始截圖、log 與 runner 結果，不直接判為產品通過或失敗；需要有效結論時，再於無干擾環境重測該項。報告與最後回覆均附上此提醒。

## 受控驗收 build

Plan 035 的原生驗收需要一些真實故障無法隨時產生的失敗狀態：平常只持續幾毫秒的 pending 結果、關檔失敗後的 unknown、緩慢或失敗的歷史儲存，以及預先放好的歷史資料。`pnpm acceptance:controlled` 為此建置一份清楚標示、已簽章的 App 副本。它和更新 fixture 一樣，把原始碼複製到 `docs/verification/measurements/<timestamp>-controlled/` 下的新 run 目錄，只透過 anchor 檢查在該副本插樁（[controlled-acceptance.mts](../../../scripts/lib/controlled-acceptance.mts)），再執行副本裡的 `pnpm start:app`。Bundle identifier 與簽章身分維持開發版的設定，因此沿用同一份螢幕錄製與通知權限。Tray、設定、Recorder、FileWriter、失敗歷史、通知與退出流程都是正式程式碼，一般建置沒有命令通道。副本只有三處不同：

- **隔離資料。** userData、log 與預設輸出資料夾都在 run 目錄內，從不讀寫維護者的設定、失敗歷史或 `~/Movies/RecordStuff`。此 build 以預設偏好啟動（English、通知開啟、倒數 3 秒且有提示音、⌘⇧1）。
- **標示。** 每個 tray tooltip 開頭都是 `[Controlled acceptance build]`，log 中有一行 `controlled:` 記錄 run 目錄。這個 build 的證據屬於受控狀態證據：證明原生呈現與互動，不代表真實磁碟或擷取故障。
- **故障注入點**（[controlled-faults.ts](../../../scripts/fixtures/controlled-faults.ts)），啟用前全部關閉：
  - `cleanup=hold` 在每個失敗的最終結果寫入歷史前先暫停，使 pending 結果（處理中、「知道了」停用、無法顯示檔案）持續顯示、退出被延後、該 session 若有中斷 sentinel 也會保留，直到 `release cleanup`。背後的檔案處理其實已經完成。
  - `write=eio|enospc` 讓下一次寫入「已有資料的錄影檔」失敗一次，走正式 FileWriter：output_write_failed 或 disk_full，並保留 partial。
  - `close=fail` 讓下一次關閉錄影檔在檔案描述符真正關閉後失敗一次。Writer 無法確認檔案已保存，結果為 unknown；若在正常停止前啟用，停止本身就會以這種方式失敗。
  - `history-save=hold|fail` 會暫停儲存直到 `release history-save`，或以 I/O 錯誤拒絕儲存；故障關閉前，每次自動重試都會再次遇到。
  - `prepare=hold`（plan 065）在 main 暫停 capture host 的每個 `prepared` 回覆，直到 `release prepare`：host 持有串流並等待 `record`，Recorder 停在 starting，所以 start 可以持續到檢查需要的時間。嘗試取消後才放行的回覆會以過期 session 的身分到達 Recorder，並再被停止一次。
  - `launch` 或 `reopen` 加上 `--hold-history-load` 時，暫停該次啟動的歷史載入直到 `release history-load`；命令通道從啟動起就能回應。
  - `throw` 在下一個 tick 從 timer 丟出一個合成的未捕捉例外，不在任何 promise 內，因此會像真正的程式錯誤一樣到達正式的未捕捉例外 handler（plan 056）。在錄影期間送出，可看出寫入、stall guard 與停止是否持續，以及錯誤對話框何時出現；`events.jsonl` 那一行會記下排程時的狀態與 `mediaPending`。它不是故障模式，不會留在啟用狀態。

```bash
pnpm acceptance:controlled -- launch [--seed none|v1|retention] [--hold-history-load]   # 新 run：建置、簽章、開啟
pnpm acceptance:controlled -- fault cleanup=hold write=enospc     # 另有 close=fail、history-save=hold|fail、prepare=hold、<name>=off
pnpm acceptance:controlled -- release cleanup                     # 或 history-save、history-load、prepare
pnpm acceptance:controlled -- status                              # 狀態、故障、暫停中的工作與每筆失敗歷史
pnpm acceptance:controlled -- throw                               # 下一個 tick 丟出一個合成的未捕捉例外
pnpm acceptance:controlled -- quit                                # 正式退出：會保存錄影，可能詢問提醒
pnpm acceptance:controlled -- reopen [--hold-history-load]        # 同一個 bundle 與資料
pnpm acceptance:controlled -- clean                               # 退出後移除 workspace，保留證據
pnpm acceptance:controlled -- selftest
```

`quit` 不會解除已啟用的故障與暫停中的工作，因此可用來驗證被延後或被詢問的退出；要單純退出，先關閉故障並放行暫停的工作。`launch` 或 `reopen` 被中斷或失敗時，會最多等 15 秒看 `open` 是否已啟動 bundle：已回報 ready 的 App 會正常退出，始終沒有回報 ready 的程序會列出來請使用者從選單退出。除了 `launch` 與 `selftest`，其他指令預設作用於最新一次引導 run，可用 `--dir <run>` 指定。`--seed v1` 寫入一筆未讀的舊版 `recording-result.json`，其合成 partial 檔存在，用於遷移驗收。`--seed retention` 在兩筆未讀之間寫入二十筆已看過的紀錄，確認舊的未讀紀錄後即可驗證「保留最近看過的 20 筆」上限。Seed 檔案只含合成 bytes，不是可播放的錄影。`launch` 與 `reopen` 在任何 RecordStuff 執行中時拒絕執行，因為隔離的 userData 不共用單一實例鎖。Exit 0 表示成功、1 表示失敗、2 表示受阻或參數錯誤。啟用與放行事件會寫入 `events.jsonl` 與該 run 的 App log。

所有原生操作都由維護者執行；runner 只負責建置、放入 seed、啟用、放行、回報與退出。這支 runner 內唯一的例外是 `selftest`，它驗證的是工具而不是產品；[`pnpm acceptance:tray -- --long-start`](#tray-驗收) 則依 2026-10-02 對已提交 runner 的授權，操作已啟動受控 build 的真正狀態列項目與快捷鍵。它在獨立 run 中關閉通知與錄影快捷鍵，把隔離輸出資料夾設為不可寫，讓因此產生的開始失敗暫停清理，同時拒絕其儲存。接著檢查 pending 與未保存狀態，放行、重試、暫停「知道了」的儲存，退出，以暫停歷史載入的方式重開，再次退出；過程直接呼叫錄製器的 toggle 與正式 action handler。它不錄影，所以寫入與關檔故障只由使用真實 FileWriter 與 Recorder 的單元測試涵蓋。自測失敗或被中斷時，會先關閉所有故障並放行所有暫停的工作再退出。`report.md` 列出每個步驟，App 退出後會移除 workspace。

### 稽核工具界限與證據

媒體子程序預設 900,000 ms 逾時並以 SIGKILL 結束；RECORDSTUFF_MEDIA_TIMEOUT_MS 可用正整數覆寫。版本探測必須以零退出。測量 Markdown 與 JSON 使用 .md.pending journal 原子替換；下一次追加前會先重播中斷的配對。這是單一序列寫入者的崩潰恢復，不是多寫入者或同時讀取的交易保證。

穩定版 tag 共用 updater 的數字語法，拒絕前導零。資產 HEAD 跟隨重新導向並要求最終回應成功。網站連結以所在頁面解析相對路徑、query 與編碼 fragment。Reveal 樣式在 observer 安裝後才啟用，因此 JavaScript bundle 缺失仍會顯示內容。
