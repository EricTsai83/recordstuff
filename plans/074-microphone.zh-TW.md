# 074 — 錄下麥克風與系統聲音

[English](074-microphone.md) | [繁體中文](074-microphone.zh-TW.md)

狀態：已規劃，尚未開始。建立：2026-10-14。優先順序：076 之後。硬性相依：076；本計畫使用原生引擎的麥克風輸入與混音器，所以原先在這裡寫的 Chromium 混音（錄影 renderer 中的 `AudioContext`）改由步驟 4 的引擎設計取代。依[計畫索引](README.zh-TW.md)按順序執行。

## 目標與邊界

讓錄影除了現在的系統聲音之外，也能同時收進使用者的麥克風，錄有旁白的螢幕錄影就不必再開第二個工具。成功的標準是：麥克風開啟時，存下的 MP4 只有一條 AAC 音軌，系統聲音與麥克風都聽得到，而且與畫面同步；麥克風關閉時，錄影路徑、檔案與[音訊保真度](../docs/zh-TW/system-design/audio-quality.md)結果都和現在完全一樣；麥克風只在「準備」到「停止」之間開啟；缺少權限或裝置時，會在任何倒數之前說明，和現在缺少系統音軌時一樣。

不在範圍內：分開的麥克風與系統音軌或旁掛檔案、各軌音量或編輯器、攝影機、設定頁以外的即時音量表、步驟 1 處理方式決定之外的降噪閘或聲音效果，以及 Windows 實機回合（和所有 Windows 變更一樣只由 CI 檢查）。

## 需要做開關嗎？（評估）

需要，而且預設關閉。理由由強到弱：

1. **隱私與信任。** 沒經過使用者刻意選擇就錄下聲音，是錄影工具最糟的失誤。預設關閉代表既有使用者更新後不會突然開始錄房間裡的聲音；macOS 的麥克風權限提示也只會在使用者要用這個功能時、在當下的脈絡中出現，而不是在下一次錄影時跳出來。
2. **不是每次錄影都需要。** 錄影片、遊戲，或本身已含使用者聲音的通話（會議 App 播放的是混音），會多錄一份帶回音的人聲或環境噪音。
3. **喇叭會漏音。** 用喇叭時麥克風會把系統聲音延遲地再錄一次；回音消除只有在拿到這些輸出作為參考時才有用，這由步驟 1 的處理方式決定來權衡。戴耳機可以避免；有開關才能讓用喇叭的人保持乾淨的錄音。
4. **預設路徑不變。** 開關關閉時不會開啟、混音或處理任何新東西，所以已記錄的音質證據不需重新量測就仍然有效。

開關不需要是：每次錄影都詢問（會讓一鍵錄影多一步），或混音比例的選項。是否也放在選單列選單、以及是否提供裝置選擇，由步驟 1 決定。

## Cap 是怎麼做的

以 Cap 版本 `3d19c5cfa5e636107e78adde6d55be78404d4f23`（2026-10-14）對所檢視範圍做的靜態比較，只讀程式碼、沒有執行；本計畫釘選這個版本，而不是索引中較舊的版本（見[來源](README.zh-TW.md#來源與證據邊界)）。這不是 Cap 能正確處理這些情況的證據。

| 主題 | Cap | 位置 |
| --- | --- | --- |
| 控制 | 沒有獨立開關：麥克風選單中有「No Microphone」選項，選它就是關閉。系統聲音有自己的開／關開關。兩者預設都關閉、重新啟動後保留，錄影中鎖定 | `apps/desktop/src/routes/(window-chrome)/new-main/MicrophoneSelect.tsx`、`SystemAudio.tsx`、`apps/desktop/src/utils/queries.ts` |
| 音量表 | 選單與錄影中視窗以 dB 顯示輸入音量 | `MicrophoneSelect.tsx`、`in-progress-recording.tsx` |
| 擷取（macOS） | 麥克風用 cpal（CoreAudio）；系統聲音用 ScreenCaptureKit，需 macOS 13 以上 | `crates/recording/src/feeds/microphone.rs`、`crates/recording/src/sources/screen_capture/macos.rs` |
| 儲存 | Studio 模式：每段分開存麥克風與系統聲音檔，在編輯器中以各軌音量混音，匯出時再混。Instant 模式：錄影時即時混成一軌（ffmpeg `amix`） | `crates/recording/src/studio_recording.rs`、`instant_recording.rs`、`sources/audio_mixer.rs`、`crates/project/src/configuration.rs` |
| 同步 | 音訊時間戳以累計樣本數推進共用的主時鐘；混音器以靜音補空隙；系統聲音只在有聲音播放時才送封包，所以以錄影開始時間為錨點 | `crates/timestamp/src/master_clock.rs`、`audio_mixer.rs` |
| 權限 | 以 AVFoundation 查詢與請求；點麥克風選單時詢問；未授權時拒絕準備，訊息為「Click the microphone control to allow access」（尚未詢問）或「Allow Cap in System Settings > Privacy & Security > Microphone」（已拒絕），並附該設定頁的連結 | `apps/desktop/src-tauri/src/permissions.rs` |
| 裝置中斷 | 繼續錄影並以靜音補上，同時發通知（「Microphone disconnected — Recording continues…」）；裝置回來時重新連線 | `apps/desktop/src-tauri/src/lib.rs`、`microphone.rs` |

RecordStuff 採用的：預設關閉並保存設定；錄影中鎖定；使用者打開時才請求權限，被拒絕時提供設定頁連結；裝置中斷時以靜音繼續並告知使用者。不採用的：分軌與編輯器（RecordStuff 沒有編輯器，所以「混成一軌」，也就是 Cap 的 Instant 模式，是自然的形式）；從 076 起 RecordStuff 也有原生引擎，時鐘採用 Cap 的做法：以樣本數計算時間戳、空隙補靜音；音量表與重新連線，若有需要再另做。Cap「以選單兼作開關」的做法列在步驟 1 作為替代方案。

## 現況

以下是 076 之前的狀態；076 會以原生引擎取代下方的錄影 renderer，步驟 4 是以該引擎為準寫的。

- 擷取主機（`src/renderer/capture/capture-host.ts`）只呼叫一次 `getDisplayMedia`；main 的 display-media handler（`src/main/index.ts`）回應所選螢幕與 `audio: "loopback"`。音訊條件關閉回音消除、降噪與 AGC，並保留 `restrictOwnAudio`，理由見[音訊品質 §15](../docs/zh-TW/system-design/audio-quality.md#15-系統擷取修正2026-09-14)。
- 一個 `MediaRecorder` 把串流編碼成 fragmented MP4（H.264 + AAC 256 kbps）。Chromium 的 `MediaRecorder` 只編碼串流中的第一條音軌，所以不能直接多加一條音軌，必須先在編碼器之前混成一軌。
- 程式中沒有呼叫 `getUserMedia`，也沒有 session 權限 handler，所以 Electron 會允許 renderer 的媒體請求，把系統提示交給 macOS。`electron-builder.yml` 宣告了 `NSScreenCaptureUsageDescription` 與 `NSAudioCaptureUsageDescription`，但沒有 `NSMicrophoneUsageDescription`；`resources/entitlements.mac.plist` 也缺少 hardened runtime 存取麥克風所需的 `com.apple.security.device.audio-input`。
- [概覽](../docs/zh-TW/system-design/overview.md)、README、README.zh-TW 與官網說明頁（`website/src/components/HelpContent.astro`）都寫明沒有麥克風。[WebRTC](../docs/zh-TW/system-design/webrtc.md) 已指出麥克風旁白需要獨立的音訊政策，且系統音軌不應沿用語音處理。

## 步驟

### 1. 決定控制方式與失敗處理（決定點）

- [ ] 開關放在哪裡。建議：Settings → Recording 中的「Microphone」開關，錄影中和其他錄影設定一樣鎖定；另在選單列選單加一個可勾選的「Record microphone」項目，因為這是每次錄影可能不同的選擇，而選單列正是開始錄影的地方。替代方案：只放在 Settings；或像 Cap 一樣，用一個第一項為「No microphone」的選單，把這一題與下一題合併。
- [ ] 用哪支麥克風。本計畫建議：系統預設輸入（引擎會跟隨系統預設），卡片上顯示目前使用的裝置名稱；裝置選擇等有需要再做。替代方案：第一項為「System default」的選單，保存裝置 id 與名稱，保存的裝置不存在時退回預設並提示。引擎會列出裝置與穩定的 id。
- [ ] 開關開啟、但麥克風被拒絕或不存在時的開始策略。建議：以新的 `microphone_unavailable` 代碼拒絕開始，附恢復指引，並在任何倒數之前發生，和 `no_audio_track` 一樣；使用者預期有旁白的錄影若默默錄成沒有人聲，這段錄影就白費了，Cap 在沒有權限時也拒絕準備。替代方案：只錄系統聲音並顯示警告。
- [ ] 錄影中途失去麥克風（拔除裝置、撤銷權限）。建議與 Cap 相同：繼續錄影，因為混音軌仍有系統聲音、檔案仍有效；寫入 log、通知一次（「麥克風已中斷，錄影繼續但不含麥克風」），並在存檔結果標示警告。本計畫不做重新連線。替代方案：比照畫面中斷的路徑停止並存檔。
- [ ] 麥克風處理。改用 076 的原生引擎後就沒有 Chromium 的處理。建議：使用未處理的麥克風，與未處理的系統聲音以單位增益相加、不加壓縮器；不使用平台的語音處理（macOS 的 voice processing I/O、Windows 的通訊管線），因為在 macOS 上它可能壓低其他 App 的輸出，改變錄下的系統聲音。喇叭回音則建議戴耳機。替代方案：若步驟 6 證明不影響系統聲音，只對麥克風套用平台的語音處理。

維護者回答前，本計畫暫停在這一步。

### 2. 權限與打包

- [ ] 在 `mac.extendInfo` 加入 `NSMicrophoneUsageDescription`，在 `resources/entitlements.mac.plist` 加入 `com.apple.security.device.audio-input`；用 `codesign -d --entitlements` 在 `pnpm start:app` 的 bundle 上確認。
- [ ] 打開開關時由 main 呼叫 `systemPreferences.askForMediaAccess("microphone")`（macOS），讓提示緊跟著使用者的操作；即使被拒絕也保存設定，卡片隨後顯示被拒絕，並提供開啟「系統設定 → 隱私權與安全性 → 麥克風」的動作（`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`）。卡片狀態取自 `getMediaAccessStatus("microphone")`，和螢幕權限一樣在視窗取得焦點時重新檢查。
- [ ] Windows：沒有提示 API；開啟裝置被拒絕時對應到同一個代碼，附 Windows 指引（設定 → 隱私權與安全性 → 麥克風）。

### 3. 設定與通訊協定

- [ ] `src/main/settings/settings.ts`：`microphone: boolean`，預設 false，用既有的 `field` 模式解析（無效值退回關閉並寫 log）。若步驟 1 選了裝置選單，另加 `microphoneDevice?: { id: string; label: string }`。
- [ ] `src/shared/protocol.ts`：`start` 訊息帶 `microphone: { enabled: boolean; deviceId?: string }`；`HOST_ERROR_CODES` 加入 `microphone_unavailable`；`tests/capture-protocol.test.ts` 涵蓋兩者。
- [ ] `src/main/recording/recording-result.ts`：兩個平台的 `microphone_unavailable` 訊息與指引；只有原因是被拒絕時才歸入權限失敗。
- [ ] session 的 `prepared` log 行結尾加上 `mic on`／`mic off`，和倒數音效一樣；`CaptureReport` 記錄麥克風音軌的名稱與設定。

### 4. 透過原生引擎錄麥克風

- [ ] 麥克風關閉時，引擎不開啟任何輸入，音訊路徑與 076 完全相同。
- [ ] 開啟時，`start` 訊息帶著麥克風的選擇；引擎在準備階段開啟裝置（076 的麥克風輸入），被拒絕、沒有裝置或開啟失敗時，在 `prepared` 之前以 `microphone_unavailable` 拒絕，並釋放已開啟的一切。
- [ ] 引擎把麥克風混進同一條 AAC 音軌：48 kHz、立體聲，單聲道麥克風平均送到左右兩聲道，時間戳以 session 時鐘上的樣本數計算，空隙補靜音。
- [ ] 生命週期：在 076 引擎結束擷取的每條路徑上關閉裝置，所以取消倒數絕不會讓麥克風保持開啟（macOS 的橘色指示燈必須消失）。麥克風中途失去依步驟 1 的中途策略處理。
- [ ] 測試：Rust 測試混音器（音量、升混、空隙、長時間對齊）；host 測試關閉路徑、`prepared` 之前的拒絕、開啟中取消，以及錄影中失去麥克風。

### 5. 設定介面與選單列

- [ ] `src/main/settings/settings-model.ts`：在 Recording 區段倒數音效之後新增 `microphoneGroup`，用 `switchChoices`，附步驟 2 的權限狀態與動作；ⓘ 說明戴耳機可避免把喇叭聲音錄兩次。新字串加進 `src/shared/i18n.ts` 的 `ZH_TW`。
- [ ] 若步驟 1 選了選單列項目：在閒置選單（`src/main/menus/`）加可勾選項目，錄影期間停用。
- [ ] Recording 分頁的頁面測試（開關、錄影中鎖定、被拒絕的狀態、zh-TW），以及 `settings-model.test.ts` 的 darwin 與 win32。只驗證行為與無障礙，不驗證設計數值。

### 6. 量測

- [ ] 混音後系統部分的保真度：在麥克風開啟但靜音（或使用無聲的虛擬輸入）時執行相關的 `pnpm audio:quality` 診斷，與麥克風關閉的基準比較。混音器不得重新取樣、合併立體聲或改變音量；任何差異都要記錄，不能默默接受。
- [ ] 音量壓低（ducking）：量測麥克風開與關時系統部分的音量；任何下降都是與步驟 1 處理方式決定相牴觸的發現。
- [ ] 同步：錄一段麥克風聽得到、畫面上也看得到的拍手或點擊，對照人聲與畫面，記錄量到的偏移。
- [ ] CPU：麥克風開啟時執行 `pnpm measure:cpu`，對照 [CPU 預算](../docs/zh-TW/system-design/tooling.md#cpu-預算)；麥克風會在引擎中多一條輸入串流與混音器。

### 7. 文件

- [ ] [錄影](../docs/zh-TW/system-design/recording.md)：開始流程中的麥克風步驟、混音圖、生命週期與新錯誤；[音訊品質](../docs/zh-TW/system-design/audio-quality.md)與 [WebRTC](../docs/zh-TW/system-design/webrtc.md)：麥克風處理政策與步驟 6 的結果；[桌面](../docs/zh-TW/system-design/desktop.md)：麥克風權限。英文版同步更新。
- [ ] 從概覽、README、README.zh-TW 與官網說明頁移除「沒有麥克風」的說明。
- [ ] 學習文章：撰寫[索引清單](README.zh-TW.md#074076-的學習文章)中，所依據的計畫已隨本計畫全部結案的文章；依主題劃分，而不是依計畫劃分。

## 完成與驗證邊界

完成條件：步驟 1 的決定已記錄；開關、權限處理、混音與失敗路徑依決定運作；步驟 6 的量測連同其限制已記錄；測試與文件已更新。

檢查依[測試政策](../docs/zh-TW/testing.md#依行為選擇測試)。本計畫改動擷取主機與通訊協定、權限與打包，所以適用錄影那一列：`pnpm check`，加上在新的 `pnpm start:app` bundle 上分別以麥克風關閉與開啟各跑一次錄影冒煙回合（開始、停止、存檔、媒體驗證、播放時兩個來源都聽得到），以及確認取消倒數後麥克風指示燈消失的案例。保真度那一列加上步驟 6 的 `pnpm audio:quality`；CPU 那一列加上 `pnpm measure:cpu`；Recording 分頁的 scope（`pnpm test:scope -- recording-settings`）涵蓋設定介面，若加了選單列項目則加 `pnpm acceptance:tray`。權限提示與拒絕需要在 `tccutil reset Microphone com.ericts.record` 之後跑原生回合，依[桌面交接](../docs/zh-TW/testing.md#測試前確認桌面交接)與[原生驗收 skill](../.agents/skills/native-acceptance/SKILL.md)進行。錄影中拔除裝置需要可拔除的麥克風（例如藍牙耳機）；若沒有，回報為未測試。Windows 只由 CI 檢查，所以 Windows 的麥克風路徑仍未驗證。

撰寫本計畫只需要：連結與錨點、既有與提議中的指令、中英文一致，以及 `git diff --check`；不需要測試、建置或啟動 App。

結案時，把設計寫進系統設計文件，結果連同翻譯寫進驗證紀錄，更新兩份索引，並依專案的完成規則移除計畫檔案。除非使用者要求，否則不 commit、push 或發布。
